import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import registry from "../architecture/performance-observability.v1.json" with { type: "json" };
import manifest from "../site/data/performance-classification-manifest.v1.json" with { type: "json" };
import {
  createLocalRumDebugSink,
  startBrowserRumCollector,
} from "../site/rum_collector.mjs";
import {
  SEMANTIC_READINESS_MARKERS,
  createRumSemanticMilestones,
} from "../site/rum_semantic_milestones.mjs";
import {
  homeEntryReady,
  noticeContextReady,
  noticeContextTimingMark,
  noticeContextTimingMeasure,
  noticePrimaryOutcomeFromEdge,
  noticePrimaryReady,
} from "../site/rum_static_record_instrumentation.mjs";

function reporter(sink, at = 100) {
  return createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => at,
    record: sink.record,
  });
}

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

function runtime(pathname) {
  return {
    location: { pathname },
    matchMedia: () => ({ matches: false }),
    performance: { getEntriesByType: () => [{ type: "navigate" }] },
  };
}

test("canonical registry and every generated projection mark only the first static/record slice instrumented", () => {
  for (const id of ["home", "notice"]) {
    assert.equal(registry.surfaces.find((entry) => entry.surface_id === id)?.lifecycle_state, "instrumented", id);
    assert.equal(manifest.surfaces.find((entry) => entry.surface_id === id)?.lifecycle_state, "instrumented", id);
  }
  for (const id of ["home-topic-entry", "notice-context"]) {
    assert.equal(registry.components.find((entry) => entry.component_id === id)?.lifecycle_state, "instrumented", id);
    assert.equal(manifest.components.find((entry) => entry.component_id === id)?.lifecycle_state, "instrumented", id);
  }

  const worker = JSON.parse(readFileSync(new URL(
    "../worker/src/data/performance-validation-allowlist.v1.json",
    import.meta.url,
  )));
  const operator = JSON.parse(readFileSync(new URL(
    "../worker/src/data/performance-operator-labels.v1.json",
    import.meta.url,
  )));
  assert.equal(worker.surfaces.home.lifecycle_state, "instrumented");
  assert.equal(worker.surfaces.notice.lifecycle_state, "instrumented");
  assert.equal(worker.components["home-topic-entry"].lifecycle_state, "instrumented");
  assert.equal(worker.components["notice-context"].lifecycle_state, "instrumented");
  assert.equal(operator.surfaces.find((entry) => entry.surface_id === "home").lifecycle_state, "instrumented");
  assert.equal(operator.surfaces.find((entry) => entry.surface_id === "notice").lifecycle_state, "instrumented");
  assert.equal(manifest.collector.production_enabled, true);
});

test("Home reports four finalized field vitals plus semantic content readiness at its existing boundary", async () => {
  const sink = createLocalRumDebugSink();
  const vitals = fieldVitals();
  const collector = await startBrowserRumCollector({
    testOnly: true,
    manifest,
    pathname: "/",
    runtime: runtime("/"),
    sink,
    webVitals: vitals.api,
  });
  assert.equal(collector.classification.surface_id, "home");

  for (const [name, value] of [["TTFB", 40], ["FCP", 90], ["LCP", 140], ["CLS", 0.02]]) {
    vitals.callbacks.get(name)({ name, value, id: `private-${name}` });
  }
  const result = homeEntryReady(reporter(sink, 175), {
    primaryContext: "home",
    homeReady: "true",
    primaryCtaVisible: true,
    topicInputVisible: true,
  });
  assert.equal(result.surface.state, "recorded");
  assert.equal(result.component.state, "recorded");

  const records = sink.snapshot();
  assert.deepEqual(records.filter((entry) => entry.record_type === "observation").map((entry) => entry.metric_id), [
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "cls_score",
  ]);
  assert.deepEqual(records.filter((entry) => entry.record_type === "semantic_milestone").map((entry) => [
    entry.metric_id,
    entry.surface_id,
    entry.component_id,
    entry.result_state,
  ]), [
    ["content_ready_ms", "home", "none", "content"],
    ["component_ready_ms", "home", "home-topic-entry", "content"],
  ]);
});

test("Home never treats marker presence without both meaningful controls as ready", () => {
  for (const missing of ["primaryCtaVisible", "topicInputVisible"]) {
    const sink = createLocalRumDebugSink();
    const state = {
      primaryContext: "home",
      homeReady: "true",
      primaryCtaVisible: true,
      topicInputVisible: true,
      [missing]: false,
    };
    assert.equal(homeEntryReady(reporter(sink), state).state, "not_ready");
    assert.deepEqual(sink.snapshot(), []);
  }
});

test("notice primary body and async context report every bounded semantic terminal state", () => {
  assert.equal(SEMANTIC_READINESS_MARKERS.notice_primary.ready_attribute, "data-edge-rendered");
  assert.equal(SEMANTIC_READINESS_MARKERS.notice_context.component_id, "notice-context");
  assert.equal(noticePrimaryOutcomeFromEdge("notice"), "content");
  assert.equal(noticePrimaryOutcomeFromEdge("notice-unavailable"), "unavailable");
  assert.equal(noticePrimaryOutcomeFromEdge("loading"), null, "spinner disappearance is not readiness");

  for (const resultState of ["content", "empty", "unavailable", "error"]) {
    const sink = createLocalRumDebugSink();
    const rum = reporter(sink, 250);
    assert.equal(noticePrimaryReady(rum, { resultState }).state, "recorded");
    assert.equal(noticeContextReady(rum, { resultState }).state, "recorded");
    assert.deepEqual(sink.snapshot().map((entry) => [
      entry.metric_id,
      entry.surface_id,
      entry.component_id,
      entry.result_state,
    ]), [
      ["content_ready_ms", "notice", "none", resultState],
      ["component_ready_ms", "notice", "notice-context", resultState],
    ]);
  }
});

test("notice field classification and semantic records contain no route or record identifiers", async () => {
  const sink = createLocalRumDebugSink();
  const vitals = fieldVitals();
  const collector = await startBrowserRumCollector({
    testOnly: true,
    manifest,
    pathname: "/notices/private-record-value",
    runtime: runtime("/notices/private-record-value"),
    sink,
    webVitals: vitals.api,
  });
  assert.equal(collector.classification.surface_id, "notice");
  noticePrimaryReady(reporter(sink), { resultState: "content" });
  noticeContextReady(reporter(sink), { resultState: "empty" });

  const serialized = JSON.stringify(sink.snapshot());
  for (const forbidden of ["private-record-value", "/notices/", "pathname", "selector", "url", "request_id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("production owners call the semantic seam used by the production reporter", () => {
  const home = readFileSync(new URL("../site/home_entry.mjs", import.meta.url), "utf8");
  const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
  const context = readFileSync(new URL("../site/app/notice-context.mjs", import.meta.url), "utf8");
  assert.match(home, /homeEntryReady/);
  assert.match(routing, /noticePrimaryReady/);
  assert.match(context, /noticeContextReady/);
  assert.equal(manifest.collector.production_enabled, true);
});

test("Notice timing marks are bounded browser diagnostics, not RUM dimensions", () => {
  const marks = [];
  const original = globalThis.performance;
  globalThis.performance = { mark: (name) => marks.push(name) };
  try {
    assert.deepEqual(noticeContextTimingMark("notice-read-start"), { state: "recorded" });
    assert.deepEqual(noticeContextTimingMark("notice/20260701003"), { state: "invalid" });
  } finally {
    globalThis.performance = original;
  }
  assert.deepEqual(marks, ["cityscroll.notice-context.notice-read-start"]);
});

test("Notice branch measures reuse the same diagnostic prefix and stay off RUM dimensions", () => {
  const measures = [];
  const original = globalThis.performance;
  globalThis.performance = {
    measure: (name, start, end) => measures.push({ name, start, end }),
    getEntriesByName: () => [{ duration: 8 }],
  };
  try {
    assert.deepEqual(noticeContextTimingMeasure("tables"), {
      state: "recorded",
      branch: "tables",
      duration_ms: 8,
    });
    assert.deepEqual(noticeContextTimingMeasure("tables/secret"), { state: "invalid" });
  } finally {
    globalThis.performance = original;
  }
  assert.deepEqual(measures, [{
    name: "cityscroll.notice-context.tables",
    start: "cityscroll.notice-context.tables-start",
    end: "cityscroll.notice-context.tables-end",
  }]);
});

test("Notice primary readiness is ordered before optional route modules and client enrichment", () => {
  const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
  const showNotice = routing.slice(routing.indexOf("async function showNotice"));
  const primary = showNotice.indexOf("if(edgePrimaryState) noticePrimaryReady");
  const modules = showNotice.indexOf("globalThis.ensureMoneyHistory");
  const read = showNotice.indexOf('import("../notice-read.mjs")');
  assert.ok(primary >= 0);
  assert.ok(modules > primary, "optional route modules start after edge primary readiness");
  assert.ok(read > primary, "client notice enrichment starts after edge primary readiness");
  assert.match(showNotice, /const optionalRouteModules = Promise\.allSettled/);
  assert.equal(showNotice.includes("await optionalRouteModules"), false, "route modules cannot gate Notice context");
  assert.ok(showNotice.indexOf("fillContext(r, contextElement") < showNotice.indexOf("optionalRouteModules\n    .then"));
});
