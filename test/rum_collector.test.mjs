import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createLocalRumDebugSink,
  startBrowserRumCollector,
} from "../site/rum_collector.mjs";
import { scheduleTestOnlyRumCollector } from "../site/rum_bootstrap.mjs";
import {
  buildRumCollectorOverheadEvidence,
  loadRumCollectorOverheadEvidence,
} from "../tools/measure_rum_collector_overhead.mjs";

const MANIFEST = JSON.parse(readFileSync(
  new URL("../site/data/performance-classification-manifest.v1.json", import.meta.url),
  "utf8",
));

function fakeVitals() {
  const callbacks = new Map();
  return {
    callbacks,
    api: Object.fromEntries(["TTFB", "FCP", "LCP", "CLS", "INP"].map((name) => [
      `on${name}`,
      (callback) => callbacks.set(name, callback),
    ])),
  };
}

function runtimeFor(widthClass = "mobile") {
  return {
    location: { pathname: "/" },
    matchMedia(query) {
      if (widthClass === "mobile") return { matches: query.includes("599px") };
      if (widthClass === "tablet") return { matches: query.includes("1023px") };
      return { matches: false };
    },
    performance: {
      getEntriesByType(type) {
        return type === "navigation" ? [{ type: "navigate" }] : [];
      },
    },
  };
}

function observations(sink) {
  return sink.snapshot().filter((record) => record.record_type === "observation");
}

test("generated browser manifest owns field metric and bounded collector dimensions", () => {
  assert.deepEqual(MANIFEST.collector.field_metric_ids, [
    "cls_score",
    "fcp_ms",
    "inp_ms",
    "lcp_ms",
    "ttfb_ms",
  ]);
  assert.deepEqual(MANIFEST.collector.device_classes, ["desktop", "mobile", "tablet", "unknown"]);
  assert.deepEqual(MANIFEST.collector.navigation_types, [
    "back-forward",
    "back-forward-cache",
    "navigate",
    "prerender",
    "reload",
    "restore",
    "unknown",
  ]);
  assert.ok(MANIFEST.metrics.every((metric) => (
    Object.keys(metric).sort().join(",") === "metric_id,metric_version,unit"
  )));
});

test("self-hosted standard web-vitals bundle exports all five lifecycle collectors", async () => {
  const standardVitals = await import("../site/vendor/web-vitals-6.0.1.mjs");
  for (const name of ["onTTFB", "onFCP", "onLCP", "onCLS", "onINP"]) {
    assert.equal(typeof standardVitals[name], "function", name);
  }
});

test("disabled seam imports nothing and schedules no work in every runtime class", async () => {
  for (const runtimeClass of ["local", "preview", "production"]) {
    let imports = 0;
    const result = await scheduleTestOnlyRumCollector({
      testOnly: false,
      runtimeClass,
      importCollector: async () => { imports += 1; throw new Error("must not import"); },
      importWebVitals: async () => { imports += 1; throw new Error("must not import"); },
    });
    assert.equal(result.state, "disabled", runtimeClass);
    assert.equal(imports, 0, runtimeClass);
  }
});

test("test-only bootstrap waits for load and idle before importing collector code", async () => {
  const loadListeners = [];
  const idleTasks = [];
  const imports = [];
  const document = { readyState: "loading" };
  const runtime = {
    document,
    addEventListener(type, callback) {
      if (type === "load") loadListeners.push(callback);
    },
    requestIdleCallback(callback) { idleTasks.push(callback); },
  };
  const scheduled = scheduleTestOnlyRumCollector({
    testOnly: true,
    runtime,
    manifest: MANIFEST,
    sink: createLocalRumDebugSink(),
    importCollector: async () => {
      imports.push("collector");
      return { startBrowserRumCollector: async () => ({ state: "collecting" }) };
    },
    importWebVitals: async () => {
      imports.push("web-vitals");
      return fakeVitals().api;
    },
  });

  await Promise.resolve();
  assert.deepEqual(imports, []);
  assert.equal(loadListeners.length, 1);
  loadListeners[0]();
  await Promise.resolve();
  assert.deepEqual(imports, []);
  assert.equal(idleTasks.length, 1);
  idleTasks[0]({ didTimeout: false, timeRemaining: () => 20 });
  assert.equal((await scheduled).state, "collecting");
  assert.deepEqual(imports, ["collector", "web-vitals"]);
});

test("manifest classification records unknown routes without folding them into home", async () => {
  const sink = createLocalRumDebugSink();
  let registrations = 0;
  const webVitals = Object.fromEntries(["TTFB", "FCP", "LCP", "CLS", "INP"].map((name) => [
    `on${name}`,
    () => { registrations += 1; },
  ]));
  const result = await startBrowserRumCollector({
    testOnly: true,
    manifest: MANIFEST,
    pathname: "/future-civic-surface/",
    runtime: runtimeFor(),
    sink,
    webVitals,
  });

  assert.equal(result.state, "unclassified");
  assert.equal(registrations, 0);
  assert.deepEqual(sink.snapshot(), [{
    record_type: "classification",
    schema: "cityscroll.performance.debug_classification.v1",
    classification_state: "unclassified",
    surface_id: null,
    route_family: null,
    delivery_class: null,
    manifest_version: MANIFEST.manifest_version,
    collector_version: MANIFEST.collector.collector_version,
  }]);
});

test("five field vitals emit once only when their lifecycle callbacks finalize", async () => {
  const sink = createLocalRumDebugSink();
  const vitals = fakeVitals();
  const result = await startBrowserRumCollector({
    testOnly: true,
    manifest: MANIFEST,
    pathname: "/",
    runtime: runtimeFor("mobile"),
    sink,
    webVitals: vitals.api,
  });
  assert.equal(result.state, "collecting");
  assert.equal(observations(sink).length, 0, "registration alone is not a measurement");

  const fixtures = {
    TTFB: 123.5,
    FCP: 250,
    LCP: 800,
    CLS: 0,
    INP: 45,
  };
  for (const [name, value] of Object.entries(fixtures)) {
    const metric = {
      name,
      id: `private-page-id-${name}`,
      value,
      navigationType: name === "INP" ? "back-forward" : "navigate",
      entries: [{ name: "must-not-leak" }],
      navigationURL: "https://cityscroll.org/?must-not-leak",
      attribution: { interactionTarget: "#must-not-leak" },
    };
    vitals.callbacks.get(name)(metric);
    vitals.callbacks.get(name)({ ...metric, value: value + 1 });
  }

  const emitted = observations(sink);
  assert.equal(emitted.length, 5);
  assert.deepEqual(emitted.map((entry) => entry.metric_id).sort(), MANIFEST.collector.field_metric_ids);
  assert.equal(emitted.find((entry) => entry.metric_id === "cls_score").value, 0, "reported zero is retained");
  assert.equal(emitted.find((entry) => entry.metric_id === "inp_ms").navigation_type, "back-forward");
  assert.ok(emitted.filter((entry) => entry.metric_id !== "inp_ms").every((entry) => entry.navigation_type === "navigate"));
  assert.ok(emitted.every((entry) => entry.device_class === "mobile"));
  assert.ok(emitted.every((entry) => entry.surface_id === "home"));

  const serialized = JSON.stringify(emitted);
  for (const forbidden of [
    "private-page-id",
    "must-not-leak",
    "navigationURL",
    "entries",
    "attribution",
    "visitor_id",
    "session_id",
    "url",
    "target",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("unsupported, background, and no-interaction metrics stay absent rather than becoming zero", async () => {
  const sink = createLocalRumDebugSink();
  const callbacks = new Map();
  const webVitals = {
    onTTFB(callback) { callbacks.set("TTFB", callback); },
    onFCP(callback) { callbacks.set("FCP", callback); },
    onLCP() { throw new Error("PerformanceObserver unavailable"); },
    // onCLS is absent and onINP never calls back (no interaction).
    onINP(callback) { callbacks.set("INP", callback); },
  };
  await startBrowserRumCollector({
    testOnly: true,
    manifest: MANIFEST,
    pathname: "/",
    runtime: runtimeFor("desktop"),
    sink,
    webVitals,
  });
  callbacks.get("TTFB")({ name: "TTFB", id: "one", value: 100, navigationType: "reload" });
  callbacks.get("FCP")({ name: "FCP", id: "two", value: 200, navigationType: "reload" });

  assert.deepEqual(observations(sink).map((entry) => [entry.metric_id, entry.value]), [
    ["ttfb_ms", 100],
    ["fcp_ms", 200],
  ]);
  assert.ok(observations(sink).every((entry) => entry.navigation_type === "reload"));
  assert.ok(observations(sink).every((entry) => entry.device_class === "desktop"));
});

test("missing manifests, invalid values, and sink failures are fail-soft", async () => {
  const vitals = fakeVitals();
  await assert.doesNotReject(startBrowserRumCollector({
    testOnly: true,
    manifest: null,
    pathname: "/",
    runtime: runtimeFor(),
    sink: { record() { throw new Error("debug sink unavailable"); } },
    webVitals: vitals.api,
  }));
  assert.equal(vitals.callbacks.size, 0);

  const failingVitals = fakeVitals();
  await startBrowserRumCollector({
    testOnly: true,
    manifest: MANIFEST,
    pathname: "/",
    runtime: runtimeFor(),
    sink: { record() { return Promise.reject(new Error("local sink rejected")); } },
    webVitals: failingVitals.api,
  });
  assert.doesNotThrow(() => failingVitals.callbacks.get("TTFB")({
    name: "TTFB",
    id: "sink-failure",
    value: 100,
  }));
  await Promise.resolve();

  const sink = createLocalRumDebugSink();
  const active = fakeVitals();
  await startBrowserRumCollector({
    testOnly: true,
    manifest: MANIFEST,
    pathname: "/",
    runtime: runtimeFor(),
    sink,
    webVitals: active.api,
  });
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
    active.callbacks.get("LCP")({ name: "LCP", id: String(value), value });
  }
  assert.equal(observations(sink).length, 0);
});

test("local debug sink snapshots are copies and never expose a network transport", () => {
  const sink = createLocalRumDebugSink();
  sink.record({ record_type: "classification", surface_id: null });
  const first = sink.snapshot();
  first[0].surface_id = "mutated";
  assert.equal(sink.snapshot()[0].surface_id, null);
  assert.equal("send" in sink, false);
  assert.equal("flush" in sink, false);
  assert.equal("endpoint" in sink, false);
});

test("committed overhead receipt matches source bytes and records deferred production loading", () => {
  const measured = buildRumCollectorOverheadEvidence();
  const committed = loadRumCollectorOverheadEvidence();
  assert.deepEqual(committed, measured);
  assert.equal(measured.production_default.collector_requested, true);
  assert.equal(measured.production_default.network_write_implementation, true);
  assert.equal(measured.scheduling.after_load, true);
  assert.equal(measured.scheduling.idle_task, true);
  assert.ok(measured.assets.total_brotli_bytes > 0);
  assert.ok(measured.assets.total_raw_bytes >= measured.assets.total_brotli_bytes);
});
