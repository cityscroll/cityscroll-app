import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRumSemanticMilestones } from "../site/rum_semantic_milestones.mjs";
import {
  agencyRelationshipResultState,
  landOutcomeResultState,
  reportAgencyConstellationReadiness,
  reportLandOutcomeReadiness,
  reportNearYouMapReadiness,
} from "../site/rum_maps_entities_async.mjs";
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

test("Near You reports a usable frame before relevant map data", () => {
  const sink = recorder(12, 35);
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
    ["near-you-map", "content", 12],
    ["near-you-map-data", "content", 35],
  ]);

  for (const state of ["empty", "unavailable", "error"]) {
    const terminal = recorder(5, 10);
    reportNearYouMapReadiness(terminal.rum, { frameReady: true, dataState: state });
    assert.equal(terminal.records[1].result_state, state);
  }
});

test("agency identity and graph readiness distinguish relationships from honest none", () => {
  assert.equal(agencyRelationshipResultState([{ status: "matched", count: 2 }]), "content");
  assert.equal(agencyRelationshipResultState([{ status: "empty", count: 0 }]), "empty");
  assert.equal(agencyRelationshipResultState([{ status: "unavailable", count: 0 }]), "unavailable");
  assert.equal(agencyRelationshipResultState([{ status: "unknown", count: null }]), "unavailable");
  assert.equal(agencyRelationshipResultState([{ status: "not_yet_ingested", count: null }]), "unavailable");
  assert.equal(agencyRelationshipResultState([{ status: "error", count: 0 }]), "error");

  const sink = recorder(20, 40);
  reportAgencyConstellationReadiness(sink.rum, {
    identityState: "content",
    relationshipState: "empty",
    entity_id: "must-not-emit",
    relationship_target: "must-not-emit",
  });
  assert.deepEqual(sink.records.map((row) => [row.component_id, row.result_state]), [
    ["agency-identity", "content"],
    ["agency-relationships", "empty"],
  ]);
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
  const sink = recorder(10, 20, 30, 40, 50);
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

test("registry additions propagate byte-deterministically with collection off", () => {
  const registry = loadPerformanceRegistry(REGISTRY_PATH);
  const projections = buildPerformanceObservability(registry, { root: ROOT });
  const componentIds = [
    "near-you-map",
    "near-you-map-data",
    "agency-identity",
    "agency-relationships",
    "land-outcomes",
  ];
  for (const componentId of componentIds) {
    const source = registry.components.find((entry) => entry.component_id === componentId);
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
  assert.equal(projections.browser.collector.production_enabled, false);
  assert.equal(currentRumSemanticMilestones().state, "disabled");
  assert.equal(projections.browser.registry_hash, projections.worker.registry_hash);
  assert.equal(projections.worker.registry_hash, projections.operator.registry_hash);
  for (const [path, expected] of projectionOutputs(projections, { root: ROOT })) {
    assert.equal(readFileSync(path, "utf8"), renderProjection(JSON.parse(expected)), path);
  }
});

test("product owners call the component-owned instrumentation seam", () => {
  for (const [path, call] of [
    ["site/app/map.mjs", "reportNearYouMapReadiness"],
    ["site/civic_time_ledger_runtime.mjs", "reportAgencyConstellationReadiness"],
    ["site/app/land.mjs", "reportLandOutcomeReadiness"],
  ]) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), new RegExp(`${call}\\(`), path);
  }
});
