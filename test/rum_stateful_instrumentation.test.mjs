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
import { currentRumSemanticMilestones } from "../site/rum_semantic_runtime.mjs";
import {
  createFollowingRumInstrumentation,
  followingPersonalOutcomeFromHost,
  followingPersonalResultState,
  followingPersonalRetrievalStart,
  followingShellReady,
  followingWatchListReady,
  reportFollowingReadiness,
} from "../site/rum_stateful_instrumentation.mjs";
import {
  buildPerformanceObservability,
  loadPerformanceRegistry,
  projectionOutputs,
  renderProjection,
} from "../tools/build_performance_observability.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const REGISTRY_PATH = new URL("../architecture/performance-observability.v1.json", import.meta.url).pathname;

function recorder(...times) {
  const records = [];
  let index = 0;
  return {
    records,
    rum: createRumSemanticMilestones({
      enabled: true,
      navigationStart: 0,
      now: () => times[Math.min(index++, times.length - 1)],
      record(value) { records.push(structuredClone(value)); },
    }),
  };
}

function reporter(sink, at = 100) {
  return createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => at,
    record: sink.record,
  });
}

function runtime(pathname) {
  return {
    location: { pathname },
    matchMedia: () => ({ matches: false }),
    performance: { getEntriesByType: () => [{ type: "navigate" }] },
  };
}

function host(sessionRecognized, watchKeys = []) {
  return {
    querySelector(selector) {
      if (selector === "[data-session-recognized]") {
        return { getAttribute() { return sessionRecognized; } };
      }
      if (selector === "[data-session-recognized='true']") {
        return sessionRecognized === "true" ? { getAttribute() { return "true"; } } : null;
      }
      if (selector === "[data-session-recognized='false']") {
        return sessionRecognized === "false" ? { getAttribute() { return "false"; } } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-watch-key]" ? watchKeys : [];
    },
  };
}

test("registry and every generated projection mark the Following shell and watch list instrumented", () => {
  assert.equal(registry.surfaces.find((entry) => entry.surface_id === "following")?.lifecycle_state, "instrumented");
  assert.equal(manifest.surfaces.find((entry) => entry.surface_id === "following")?.lifecycle_state, "instrumented");
  assert.equal(
    registry.components.find((entry) => entry.component_id === "following-watch-list")?.lifecycle_state,
    "instrumented",
  );
  assert.equal(
    manifest.components.find((entry) => entry.component_id === "following-watch-list")?.lifecycle_state,
    "instrumented",
  );
  assert.equal(
    registry.components.find((entry) => entry.component_id === "following-watch-change")?.lifecycle_state,
    "planned",
  );
  assert.equal(
    registry.surfaces.find((entry) => entry.surface_id === "following-pack")?.lifecycle_state,
    "planned",
  );

  const worker = JSON.parse(readFileSync(new URL(
    "../worker/src/data/performance-validation-allowlist.v1.json",
    import.meta.url,
  )));
  const operator = JSON.parse(readFileSync(new URL(
    "../worker/src/data/performance-operator-labels.v1.json",
    import.meta.url,
  )));
  assert.equal(worker.surfaces.following.lifecycle_state, "instrumented");
  assert.equal(worker.components["following-watch-list"].lifecycle_state, "instrumented");
  assert.equal(operator.surfaces.find((entry) => entry.surface_id === "following").lifecycle_state, "instrumented");
  assert.equal(manifest.collector.production_enabled, true);
});

test("Following reports distinct shell and settled-state durations for populated, empty, unavailable, and error", () => {
  assert.equal(followingPersonalResultState({
    sessionRecognized: true,
    watchCount: 3,
  }), "content");
  assert.equal(followingPersonalResultState({
    sessionRecognized: true,
    watchCount: 0,
  }), "empty");
  assert.equal(followingPersonalResultState({
    sessionRecognized: false,
    watchCount: 0,
  }), "empty");
  assert.equal(followingPersonalResultState({ responseOk: false }), "unavailable");
  assert.equal(followingPersonalResultState({ fetchFailed: true }), "error");
  assert.equal(followingPersonalOutcomeFromHost(host("true", ["a", "b"])), "content");
  assert.equal(followingPersonalOutcomeFromHost(host("true", [])), "empty");
  assert.equal(followingPersonalOutcomeFromHost(host("false", [])), "empty");

  const sink = recorder(12, 24);
  const result = reportFollowingReadiness(sink.rum, {
    shellReady: true,
    retrievalStarted: true,
    personalState: "content",
    account_id: "must-not-emit",
    watch_key: "must-not-emit",
    session: "must-not-emit",
  });
  assert.deepEqual(result, {
    shell: { state: "recorded" },
    retrieval: { state: "started" },
    personal: { state: "recorded" },
  });
  assert.deepEqual(sink.records.map((row) => [row.metric_id, row.component_id, row.result_state, row.value]), [
    ["content_ready_ms", "none", "content", 12],
    ["component_ready_ms", "following-watch-list", "content", 24],
  ]);

  for (const [product, expected] of [
    ["populated", "content"],
    ["empty", "empty"],
    ["unauthenticated", "empty"],
    ["unavailable", "unavailable"],
    ["error", "error"],
  ]) {
    const terminal = recorder(5, 15);
    reportFollowingReadiness(terminal.rum, { shellReady: true, personalState: product });
    assert.equal(terminal.records[1].result_state, expected, product);
    assert.notEqual(terminal.records[0].value, terminal.records[1].value, product);
  }
});

test("Following shell stays unready until create flow and personal host exist", () => {
  assert.equal(SEMANTIC_READINESS_MARKERS.following_shell.surface_id, "following");
  assert.equal(SEMANTIC_READINESS_MARKERS.following_watch_list.component_id, "following-watch-list");
  assert.equal(SEMANTIC_READINESS_MARKERS.following_watch_list.result_states.unauthenticated, "empty");

  for (const missing of ["hasRoot", "hasCreatePanel", "hasPersonalHost"]) {
    const incomplete = createLocalRumDebugSink();
    assert.equal(followingShellReady(reporter(incomplete), {
      hasRoot: true,
      hasCreatePanel: true,
      hasPersonalHost: true,
      [missing]: false,
    }).state, "not_ready");
    assert.deepEqual(incomplete.snapshot(), []);
  }
});

test("unauthenticated and empty are explicit terminals, not missing telemetry", () => {
  for (const resultState of ["unauthenticated", "empty"]) {
    const sink = createLocalRumDebugSink();
    assert.equal(followingWatchListReady(reporter(sink), { resultState }).state, "recorded");
    assert.deepEqual(sink.snapshot().map((entry) => [
      entry.metric_id,
      entry.surface_id,
      entry.component_id,
      entry.result_state,
    ]), [["component_ready_ms", "following", "following-watch-list", "empty"]]);
  }
});

test("retrieval start is per-page ephemeral and emits no catalog row or correlation token", () => {
  const first = recorder(10, 20);
  const pageA = createFollowingRumInstrumentation({ rum: first.rum });
  assert.equal(pageA.retrievalStart().state, "started");
  assert.equal(pageA.retrievalStart().state, "duplicate");
  assert.deepEqual(first.records, []);

  const second = recorder(30, 40);
  const pageB = createFollowingRumInstrumentation({ rum: second.rum });
  assert.equal(pageB.retrievalStart().state, "started");
  assert.deepEqual(second.records, []);

  const disabled = createFollowingRumInstrumentation({
    rum: createRumSemanticMilestones(),
  });
  assert.equal(disabled.retrievalStart().state, "disabled");
  assert.equal(disabled.shellReady({
    hasRoot: true,
    hasCreatePanel: true,
    hasPersonalHost: true,
  }).state, "disabled");
  assert.equal(disabled.watchListReady({ resultState: "content" }).state, "disabled");
});

test("instrumentation emits only the RUM-05 bounded milestone envelope", () => {
  const sink = recorder(10, 20);
  reportFollowingReadiness(sink.rum, {
    shellReady: true,
    retrievalStarted: true,
    personalState: "empty",
    email: "must-not-emit",
    subscription_id: "must-not-emit",
    location: "must-not-emit",
    device_id: "must-not-emit",
  });

  const allowedKeys = [
    "component_id",
    "metric_id",
    "milestone",
    "record_type",
    "result_state",
    "schema",
    "surface_id",
    "unit",
    "value",
  ];
  assert.ok(sink.records.every((row) => (
    Object.keys(row).sort().join(",") === allowedKeys.sort().join(",")
  )));
  const emitted = JSON.stringify(sink.records);
  for (const forbidden of [
    "must-not-emit",
    "account_id",
    "watch_key",
    "session",
    "subscription_id",
    "email",
    "device_id",
    "location",
    "selector",
    "pathname",
    "url",
    "journey",
    "sampling_token",
  ]) assert.equal(emitted.includes(forbidden), false, forbidden);
});

test("field observations contain no account, watch, session, or cross-page identifiers", async () => {
  const sink = createLocalRumDebugSink();
  const collector = await startBrowserRumCollector({
    testOnly: true,
    manifest,
    pathname: "/following",
    runtime: runtime("/following"),
    sink,
  });
  assert.equal(collector.classification.surface_id, "following");
  followingShellReady(reporter(sink), {
    hasRoot: true,
    hasCreatePanel: true,
    hasPersonalHost: true,
  });
  followingWatchListReady(reporter(sink), { resultState: "unauthenticated" });

  const serialized = JSON.stringify(sink.snapshot());
  for (const forbidden of [
    "watch_key",
    "account",
    "session",
    "email",
    "prefs",
    "selector",
    "pathname",
    "/following/",
    "visitor",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("registry additions propagate byte-deterministically with collection off", () => {
  const loaded = loadPerformanceRegistry(REGISTRY_PATH);
  const projections = buildPerformanceObservability(loaded, { root: ROOT });
  assert.equal(loaded.surfaces.find((entry) => entry.surface_id === "following")?.lifecycle_state, "instrumented");
  assert.equal(
    loaded.components.find((entry) => entry.component_id === "following-watch-list")?.lifecycle_state,
    "instrumented",
  );
  assert.equal(
    projections.browser.surfaces.find((entry) => entry.surface_id === "following")?.lifecycle_state,
    "instrumented",
  );
  assert.equal(projections.worker.surfaces.following.lifecycle_state, "instrumented");
  assert.equal(
    projections.worker.components["following-watch-list"].lifecycle_state,
    "instrumented",
  );
  assert.equal(
    projections.operator.surfaces.find((entry) => entry.surface_id === "following").lifecycle_state,
    "instrumented",
  );
  assert.equal(projections.browser.collector.production_enabled, true);
  assert.equal(currentRumSemanticMilestones().state, "disabled");
  assert.equal(projections.browser.registry_hash, projections.worker.registry_hash);
  assert.equal(projections.worker.registry_hash, projections.operator.registry_hash);
  for (const [path, expected] of projectionOutputs(projections, { root: ROOT })) {
    assert.equal(readFileSync(path, "utf8"), renderProjection(JSON.parse(expected)), path);
  }
});

test("production owners call the semantic seam while collection stays off", () => {
  const following = readFileSync(new URL("../site/app/following.mjs", import.meta.url), "utf8");
  const instrumentation = readFileSync(new URL("../site/rum_stateful_instrumentation.mjs", import.meta.url), "utf8");
  assert.match(following, /createFollowingRumInstrumentation/);
  assert.match(following, /shellReady/);
  assert.match(following, /retrievalStart/);
  assert.match(following, /watchListReady/);
  assert.match(following, /followingPersonalOutcomeFromHost/);
  assert.match(following, /credentials:\s*"include"/);
  assert.doesNotMatch(following, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(instrumentation, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(following, /reportFollowingReadiness\(/);
  assert.equal(manifest.collector.production_enabled, true);
});

test("disabled collector leaves Following fetch and public markup unchanged", () => {
  const following = readFileSync(new URL("../site/app/following.mjs", import.meta.url), "utf8");
  const view = readFileSync(new URL("../site/following_view.mjs", import.meta.url), "utf8");
  assert.match(following, /fetch\(root\.dataset\.personalUrl/);
  assert.match(following, /if \(!response\.ok\) \{\s*followingRum\.watchListReady\(\{ resultState: "unavailable" \}\);\s*return;/);
  assert.match(view, /data-following-root/);
  assert.match(view, /data-personal-watch-list/);
  assert.doesNotMatch(view, /rum_|CROLRum|createFollowingRum/);
  assert.equal(followingPersonalRetrievalStart(createRumSemanticMilestones()).state, "disabled");
});
