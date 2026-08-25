import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scheduleProductionRumCollector, scheduleTestOnlyRumCollector } from "../site/rum_bootstrap.mjs";
import { createLocalRumDebugSink, startBrowserRumCollector } from "../site/rum_collector.mjs";
import {
  createBufferedSemanticMilestones,
  createProductionObservationSink,
  isRumProductionHost,
  isRumProductionOrigin,
  projectProductionObservation,
  rumCollectionEnabled,
} from "../site/rum_production.mjs";
import { runtimeRumSemanticMilestones } from "../site/rum_static_record_instrumentation.mjs";

const MANIFEST = JSON.parse(readFileSync(
  new URL("../site/data/performance-classification-manifest.v1.json", import.meta.url),
  "utf8",
));
const WRANGLER = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
const RELEASE_ID = "a".repeat(40);

function fieldVitals() {
  const callbacks = new Map();
  return {
    callbacks,
    api: Object.fromEntries(["TTFB", "FCP", "LCP", "CLS", "INP"].map((name) => [
      `on${name}`,
      (callback) => callbacks.set(name, callback),
    ])),
  };
}

test("production switches are on for production and off for beta, preview, and local hosts", () => {
  assert.equal(MANIFEST.collector.production_enabled, true);
  assert.match(WRANGLER, /^RUM_INGEST_ENABLED = "true"$/m);
  assert.match(WRANGLER, /^\[env\.beta\.vars\][\s\S]*?^RUM_INGEST_ENABLED = "false"$/m);
  assert.equal(rumCollectionEnabled(MANIFEST, {
    ingestEnabled: "true",
    analyticsEnvironment: "production",
  }), true);
  assert.equal(rumCollectionEnabled(MANIFEST, {
    ingestEnabled: "false",
    analyticsEnvironment: "production",
  }), false);
  assert.equal(rumCollectionEnabled({ collector: { production_enabled: false } }, {
    ingestEnabled: "true",
    analyticsEnvironment: "production",
  }), false);
  assert.equal(isRumProductionHost("cityscroll.org"), true);
  assert.equal(isRumProductionHost("www.cityscroll.org"), true);
  assert.equal(isRumProductionHost("cityscroll.pages.dev"), true);
  assert.equal(isRumProductionHost("localhost"), false);
  assert.equal(isRumProductionHost("127.0.0.1"), false);
  assert.equal(isRumProductionHost("preview.cityscroll.pages.dev"), false);
  assert.equal(isRumProductionHost("beta.cityscroll.org"), false);
  assert.equal(isRumProductionOrigin("https://cityscroll.org"), true);
  assert.equal(isRumProductionOrigin("http://localhost:8000"), false);
  assert.equal(isRumProductionOrigin("https://pr-14.cityscroll.pages.dev"), false);
});

test("partial production batches flush after an idle interval instead of waiting for unload", async () => {
  const delivered = [];
  let timerCallback;
  const sink = createProductionObservationSink({
    manifest: MANIFEST,
    classification: { surface_id: "home", delivery_class: "static" },
    releaseId: RELEASE_ID,
    deviceClass: "desktop",
    deliver(batch) { delivered.push(batch); },
    schedule(callback) {
      timerCallback = callback;
      return { unref() {} };
    },
    cancelSchedule() {},
  });

  assert.equal(sink.record({
    metric_id: "ttfb_ms",
    value: 123,
    surface_id: "home",
    component_id: "none",
    navigation_type: "navigate",
    result_state: "content",
    delivery_class: "static",
  }).state, "queued");
  assert.equal(sink.size(), 1);
  assert.equal(delivered.length, 0);
  assert.equal(typeof timerCallback, "function");

  timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].observations[0].metric_id, "ttfb_ms");
  assert.equal(sink.size(), 0);
});

test("either kill switch stops new production writes and leaves no residual queue", async () => {
  const delivered = [];
  const sink = createProductionObservationSink({
    manifest: MANIFEST,
    classification: { surface_id: "home", delivery_class: "static" },
    releaseId: RELEASE_ID,
    deviceClass: "mobile",
    deliver(batch) { delivered.push(batch); },
  });

  const disabledManifest = {
    ...MANIFEST,
    collector: { ...MANIFEST.collector, production_enabled: false },
  };
  assert.equal(await startBrowserRumCollector({
    production: true,
    manifest: disabledManifest,
    pathname: "/",
    sink,
    webVitals: fieldVitals().api,
  }).then((result) => result.state), "disabled");
  assert.equal(sink.size(), 0);
  assert.deepEqual(delivered, []);

  const ingestOff = rumCollectionEnabled(MANIFEST, {
    ingestEnabled: "false",
    analyticsEnvironment: "production",
  });
  assert.equal(ingestOff, false);
});

test("canonical production hosts project field vitals into the intake observation shape", async () => {
  const sink = createLocalRumDebugSink();
  const vitals = fieldVitals();
  const result = await startBrowserRumCollector({
    production: true,
    manifest: MANIFEST,
    pathname: "/",
    runtime: {
      location: { pathname: "/", hostname: "cityscroll.org" },
      matchMedia: () => ({ matches: true }),
      performance: { getEntriesByType: () => [{ type: "navigate" }] },
    },
    sink,
    webVitals: vitals.api,
  });
  assert.equal(result.state, "collecting");
  vitals.callbacks.get("TTFB")({ name: "TTFB", id: "private-page-id", value: 123.5, navigationType: "navigate" });
  const observation = projectProductionObservation(sink.snapshot().find((row) => row.record_type === "observation"), {
    manifest: MANIFEST,
    classification: result.classification,
    releaseId: RELEASE_ID,
    deviceClass: "mobile",
  });
  assert.deepEqual(observation, {
    schema: "cityscroll.performance_observation.v1",
    state: "measured",
    metric_id: "ttfb_ms",
    metric_version: "1.0.0",
    unit: "ms",
    value: 123.5,
    surface_id: "home",
    component_id: "none",
    device_class: "mobile",
    navigation_type: "navigate",
    delivery_class: "static",
    result_state: "content",
    collector_version: "rum-browser-v1",
    manifest_version: MANIFEST.manifest_version,
    release_id: RELEASE_ID,
  });
  const serialized = JSON.stringify(observation);
  for (const forbidden of ["private-page-id", "visitor", "session_id", "url", "pathname", "search"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("production bootstrap excludes local and preview hosts before importing collector code", async () => {
  for (const hostname of ["localhost", "preview.cityscroll.pages.dev", "beta.cityscroll.org"]) {
    let imports = 0;
    const scheduled = scheduleProductionRumCollector({
      runtime: {
        location: { hostname, pathname: "/" },
        document: { readyState: "complete" },
      },
      importCollector: async () => { imports += 1; throw new Error("must not import"); },
      importWebVitals: async () => { imports += 1; throw new Error("must not import"); },
      importDelivery: async () => { imports += 1; throw new Error("must not import"); },
      importProduction: async () => ({
        isRumProductionHost,
        loadRumReleaseId: async () => RELEASE_ID,
        createProductionObservationSink,
        developerExclusionToken: () => "",
      }),
    });
    assert.equal((await scheduled).state, "non_production");
    assert.equal(imports, 0, hostname);
  }
});

test("test-only seam stays inert without the explicit test capability", async () => {
  const result = await scheduleTestOnlyRumCollector({ testOnly: false });
  assert.equal(result.state, "disabled");
});

test("early semantic readiness buffers until the production reporter is installed", () => {
  const runtime = {};
  const rum = runtimeRumSemanticMilestones(runtime);
  assert.equal(rum.surfaceReady({ surfaceId: "home", resultState: "content" }).state, "buffered");
  const replayed = [];
  assert.equal(createBufferedSemanticMilestones(runtime).drain({
    surfaceReady(args) { replayed.push(args); },
  }), 1);
  assert.deepEqual(replayed, [{ surfaceId: "home", resultState: "content" }]);
});
