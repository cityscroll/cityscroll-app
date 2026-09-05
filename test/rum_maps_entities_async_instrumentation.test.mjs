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
  agencyIdentityReady,
  agencyRelationshipResultState,
  agencyRelationshipsOutcomeFromView,
  agencyRelationshipsReady,
  landOutcomeResultState,
  landOutcomesOutcomeFromSnapshot,
  landOutcomesReady,
  nearYouFrameReady,
  nearYouMapOutcomeFromView,
  nearYouMapReady,
  reportAgencyConstellationReadiness,
  reportLandOutcomeReadiness,
  reportNearYouMapReadiness,
} from "../site/rum_maps_entities_async_instrumentation.mjs";
import { currentRumSemanticMilestones } from "../site/rum_semantic_runtime.mjs";
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

test("registry and every generated projection mark the map, entity, and async slices instrumented", () => {
  const surfaces = ["near-you", "agency"];
  const components = [
    "near-you-map",
    "near-you-map-data",
    "agency-identity",
    "agency-relationships",
    "land-outcomes",
  ];
  for (const id of surfaces) {
    assert.equal(registry.surfaces.find((entry) => entry.surface_id === id)?.lifecycle_state, "instrumented", id);
    assert.equal(manifest.surfaces.find((entry) => entry.surface_id === id)?.lifecycle_state, "instrumented", id);
  }
  for (const id of components) {
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
  assert.equal(worker.surfaces["near-you"].lifecycle_state, "instrumented");
  assert.equal(worker.surfaces.agency.lifecycle_state, "instrumented");
  assert.equal(worker.components["near-you-map"].lifecycle_state, "instrumented");
  assert.equal(worker.components["near-you-map-data"].lifecycle_state, "instrumented");
  assert.equal(worker.components["agency-identity"].lifecycle_state, "instrumented");
  assert.equal(worker.components["agency-relationships"].lifecycle_state, "instrumented");
  assert.equal(worker.components["land-outcomes"].lifecycle_state, "instrumented");
  assert.equal(operator.surfaces.find((entry) => entry.surface_id === "near-you").lifecycle_state, "instrumented");
  assert.equal(operator.surfaces.find((entry) => entry.surface_id === "agency").lifecycle_state, "instrumented");
  assert.equal(manifest.collector.production_enabled, true);
});

test("Near You reports a usable shell separately from relevant map data or honest absence", () => {
  assert.equal(nearYouMapOutcomeFromView({ mapped: true, resultCount: 4 }), "content");
  assert.equal(nearYouMapOutcomeFromView({ mapped: true, resultCount: 0 }), "empty");
  assert.equal(nearYouMapOutcomeFromView({ mapped: false, resultCount: 0 }), "unavailable");

  const sink = createLocalRumDebugSink();
  const rum = reporter(sink, 180);
  assert.equal(nearYouFrameReady(rum, {
    hasRoot: true,
    hasMapSvg: true,
    hasPlaceControls: true,
  }).state, "recorded");
  assert.equal(nearYouMapReady(rum, { resultState: "content" }).state, "recorded");
  assert.deepEqual(sink.snapshot().map((entry) => [
    entry.metric_id,
    entry.surface_id,
    entry.component_id,
    entry.result_state,
  ]), [
    ["content_ready_ms", "near-you", "none", "content"],
    ["component_ready_ms", "near-you", "near-you-map", "content"],
    ["component_ready_ms", "near-you", "near-you-map-data", "content"],
  ]);

  for (const missing of ["hasRoot", "hasMapSvg", "hasPlaceControls"]) {
    const incomplete = createLocalRumDebugSink();
    assert.equal(nearYouFrameReady(reporter(incomplete), {
      hasRoot: true,
      hasMapSvg: true,
      hasPlaceControls: true,
      [missing]: false,
    }).state, "not_ready");
    assert.deepEqual(incomplete.snapshot(), []);
  }
});

test("Near You reports a usable frame before relevant map data", () => {
  const sink = recorder(12, 24, 35);
  const result = reportNearYouMapReadiness(sink.rum, {
    frameReady: true,
    dataState: "content",
    borough: "must-not-emit",
    record_id: "must-not-emit",
  });
  assert.deepEqual(result, {
    frame: { state: "recorded" },
    data: { state: "recorded" },
  });
  assert.deepEqual(sink.records.map((row) => [row.component_id, row.result_state, row.value]), [
    ["none", "content", 12],
    ["near-you-map", "content", 24],
    ["near-you-map-data", "content", 35],
  ]);

  for (const state of ["empty", "unavailable", "error"]) {
    const terminal = recorder(5, 10, 15);
    reportNearYouMapReadiness(terminal.rum, { frameReady: true, dataState: state });
    assert.equal(terminal.records[2].result_state, state);
  }
});

test("agency identity and graph report content or honest no-relationships without identifiers", () => {
  assert.equal(agencyRelationshipsOutcomeFromView({
    kind: "agency-constellation",
    summary: { matched_categories: 2 },
    categories: [{ status: "matched", count: 2 }],
  }), "content");
  assert.equal(agencyRelationshipsOutcomeFromView({
    kind: "agency-constellation",
    summary: { matched_categories: 0 },
    categories: [{ status: "empty", count: 0 }, { status: "empty", count: 0 }],
  }), "empty");
  assert.equal(agencyRelationshipsOutcomeFromView({
    kind: "agency-constellation",
    summary: { matched_categories: 0 },
    categories: [{ status: "unknown" }],
  }), "unavailable");

  for (const resultState of ["content", "empty", "unavailable", "error"]) {
    const sink = createLocalRumDebugSink();
    const rum = reporter(sink, 220);
    assert.equal(agencyIdentityReady(rum, {
      kind: "agency-constellation",
      hasIdentityHeading: true,
    }).state, "recorded");
    assert.equal(agencyRelationshipsReady(rum, { resultState }).state, "recorded");
    assert.deepEqual(sink.snapshot().map((entry) => [
      entry.metric_id,
      entry.surface_id,
      entry.component_id,
      entry.result_state,
    ]), [
      ["content_ready_ms", "agency", "none", "content"],
      ["component_ready_ms", "agency", "agency-identity", "content"],
      ["component_ready_ms", "agency", "agency-relationships", resultState],
    ]);
  }
});

test("agency identity and graph readiness distinguish relationships from honest none", () => {
  assert.equal(agencyRelationshipResultState([{ status: "matched", count: 2 }]), "content");
  assert.equal(agencyRelationshipResultState([{ status: "empty", count: 0 }]), "empty");
  assert.equal(agencyRelationshipResultState([{ status: "unavailable", count: 0 }]), "unavailable");
  assert.equal(agencyRelationshipResultState([{ status: "unknown", count: null }]), "unavailable");
  assert.equal(agencyRelationshipResultState([{ status: "not_yet_ingested", count: null }]), "unavailable");
  assert.equal(agencyRelationshipResultState([{ status: "error", count: 0 }]), "error");

  const sink = recorder(20, 30, 40);
  reportAgencyConstellationReadiness(sink.rum, {
    identityState: "content",
    relationshipState: "empty",
    entity_id: "must-not-emit",
    relationship_target: "must-not-emit",
  });
  assert.deepEqual(sink.records.map((row) => [row.component_id, row.result_state]), [
    ["none", "content"],
    ["agency-identity", "content"],
    ["agency-relationships", "empty"],
  ]);
});

test("agency surface readiness does not wait for the relationships result", () => {
  const sink = recorder(20, 30);
  const result = reportAgencyConstellationReadiness(sink.rum, {
    identityState: "content",
  });
  assert.equal(result.identity.state, "recorded");
  assert.equal(result.relationships.state, "not_ready");
  assert.deepEqual(sink.records.map((row) => [row.metric_id, row.component_id, row.result_state]), [
    ["content_ready_ms", "none", "content"],
    ["component_ready_ms", "agency-identity", "content"],
  ]);
});

test("async land outcomes cover present, absent, unavailable, and error without reader absence copy", () => {
  assert.equal(SEMANTIC_READINESS_MARKERS.land_outcome_first_paint.component_id, "land-outcomes");
  assert.equal(SEMANTIC_READINESS_MARKERS.land_outcome_first_paint.reader_absence, "empty-html");
  assert.equal(landOutcomesOutcomeFromSnapshot({ snapshot_state: "present" }), "content");
  assert.equal(landOutcomesOutcomeFromSnapshot({ snapshot_state: "absent" }), "empty");
  assert.equal(landOutcomesOutcomeFromSnapshot({ snapshot_state: "unavailable" }), "unavailable");
  assert.equal(landOutcomesOutcomeFromSnapshot(null, { fetchFailed: true }), "error");
  assert.equal(landOutcomesOutcomeFromSnapshot(null, { responseOk: false }), "unavailable");

  for (const [resultState, expected] of [
    ["present", "content"],
    ["absent", "empty"],
    ["unavailable", "unavailable"],
    ["error", "error"],
  ]) {
    const sink = createLocalRumDebugSink();
    assert.equal(landOutcomesReady(reporter(sink, 260), { resultState }).state, "recorded");
    assert.deepEqual(sink.snapshot().map((entry) => [
      entry.metric_id,
      entry.surface_id,
      entry.component_id,
      entry.result_state,
    ]), [["component_ready_ms", "browse-zoning", "land-outcomes", expected]]);
  }

  const land = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
  assert.match(land, /function landOutcomeAbsentHTML\(record\)\{\s*return "";\s*\}/);
  assert.doesNotMatch(land, /data-zap-outcomes-state="absent"/);
});

test("Land outcome readiness closes present, absent, unavailable, and error paths", () => {
  const cases = [
    [{ record: { snapshot_state: "present", project_id: "must-not-emit" } }, "content"],
    [{ record: { snapshot_state: "absent", project_id: "must-not-emit" } }, "empty"],
    [{ requestState: "unavailable" }, "unavailable"],
    [{ requestState: "error", error: "must-not-emit" }, "error"],
  ];
  for (const [state, expected] of cases) {
    assert.equal(landOutcomeResultState(state), expected);
    const sink = recorder(50);
    assert.equal(reportLandOutcomeReadiness(sink.rum, state).state, "recorded");
    assert.deepEqual(
      [sink.records[0].component_id, sink.records[0].result_state],
      ["land-outcomes", expected],
    );
  }
});

test("instrumentation emits only the RUM-05 bounded milestone envelope", () => {
  const sink = recorder(10, 20, 30, 40, 50, 60, 70, 80);
  reportNearYouMapReadiness(sink.rum, { frameReady: true, dataState: "content" });
  reportAgencyConstellationReadiness(sink.rum, {
    identityState: "content",
    relationshipState: "empty",
  });
  reportLandOutcomeReadiness(sink.rum, { requestState: "error" });

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
    "owner_timestamp_ms",
  ];
  assert.ok(sink.records.every((row) => (
    Object.keys(row).sort().join(",") === allowedKeys.sort().join(",")
  )));
  const emitted = JSON.stringify(sink.records);
  for (const forbidden of [
    "must-not-emit",
    "project_id",
    "entity_id",
    "record_id",
    "relationship_target",
    "selector",
    "pathname",
    "url",
    "error_text",
  ]) assert.equal(emitted.includes(forbidden), false, forbidden);
});

test("field observations contain no geography, entity, relationship, or record identifiers", async () => {
  const sink = createLocalRumDebugSink();
  const collector = await startBrowserRumCollector({
    testOnly: true,
    manifest,
    pathname: "/near-you/borough/queens/land/",
    runtime: runtime("/near-you/borough/queens/land/"),
    sink,
  });
  assert.equal(collector.classification.surface_id, "near-you");
  nearYouFrameReady(reporter(sink), {
    hasRoot: true,
    hasMapSvg: true,
    hasPlaceControls: true,
  });
  nearYouMapReady(reporter(sink), { resultState: "empty" });
  agencyIdentityReady(reporter(sink), {
    kind: "agency-constellation",
    hasIdentityHeading: true,
  });
  agencyRelationshipsReady(reporter(sink), { resultState: "empty" });
  landOutcomesReady(reporter(sink), { resultState: "absent" });

  const serialized = JSON.stringify(sink.snapshot());
  for (const forbidden of [
    "queens",
    "borough",
    "parks-and-recreation",
    "subject_ref",
    "2022M0258",
    "project_id",
    "selector",
    "pathname",
    "/near-you/",
    "/agencies/",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("registry additions propagate byte-deterministically with collection off", () => {
  const loaded = loadPerformanceRegistry(REGISTRY_PATH);
  const projections = buildPerformanceObservability(loaded, { root: ROOT });
  const componentIds = [
    "near-you-map",
    "near-you-map-data",
    "agency-identity",
    "agency-relationships",
    "land-outcomes",
  ];
  for (const componentId of componentIds) {
    const source = loaded.components.find((entry) => entry.component_id === componentId);
    assert.equal(source?.lifecycle_state, "instrumented", componentId);
    assert.equal(
      projections.browser.components.find((entry) => entry.component_id === componentId)?.lifecycle_state,
      "instrumented",
      componentId,
    );
    assert.equal(projections.worker.components[componentId]?.lifecycle_state, "instrumented", componentId);
    assert.equal(
      projections.operator.components.find((entry) => entry.component_id === componentId)?.lifecycle_state,
      "instrumented",
      componentId,
    );
  }
  assert.equal(projections.browser.surfaces.find((entry) => entry.surface_id === "near-you")?.lifecycle_state, "instrumented");
  assert.equal(projections.browser.surfaces.find((entry) => entry.surface_id === "agency")?.lifecycle_state, "instrumented");
  assert.equal(projections.browser.collector.production_enabled, true);
  assert.equal(currentRumSemanticMilestones().state, "disabled");
  assert.equal(projections.browser.registry_hash, projections.worker.registry_hash);
  assert.equal(projections.worker.registry_hash, projections.operator.registry_hash);
  for (const [path, expected] of projectionOutputs(projections, { root: ROOT })) {
    assert.equal(readFileSync(path, "utf8"), renderProjection(JSON.parse(expected)), path);
  }
});

test("production owners call the semantic seam while collection stays off", () => {
  const map = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
  const nearYou = readFileSync(new URL("../site/near_you_view.mjs", import.meta.url), "utf8");
  const agency = readFileSync(new URL("../site/civic_time_ledger_runtime.mjs", import.meta.url), "utf8");
  const land = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
  assert.match(nearYou, /data-near-you-root/);
  assert.match(map, /nearYouFrameReady/);
  assert.match(map, /nearYouMapReady/);
  assert.match(map, /nearYouMapStateFromRoot/);
  assert.match(agency, /agencyIdentityReady/);
  assert.match(agency, /agencyRelationshipsReady/);
  assert.match(land, /landOutcomesReady/);
  assert.doesNotMatch(map, /reportNearYouMapReadiness\(/);
  assert.doesNotMatch(land, /reportLandOutcomeReadiness\(/);
  assert.equal(manifest.collector.production_enabled, true);
});
