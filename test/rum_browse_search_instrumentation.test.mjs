import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRumSemanticMilestones } from "../site/rum_semantic_milestones.mjs";
import {
  CONTRACTS_RUM_IDS,
  createContractsRumInstrumentation,
} from "../site/contracts_rum.mjs";

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function harness(...times) {
  const records = [];
  const afterPaint = [];
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: clock(...times),
    record(value) { records.push(structuredClone(value)); },
  });
  const contracts = createContractsRumInstrumentation({
    rum,
    afterNextPaint(callback) { afterPaint.push(callback); },
  });
  return {
    records,
    contracts,
    paint() { afterPaint.shift()?.(); },
  };
}

function compact(records) {
  return records.map((record) => ({
    milestone: record.milestone,
    metric_id: record.metric_id,
    result_state: record.result_state,
    value: record.value,
    surface_id: record.surface_id,
    component_id: record.component_id,
  }));
}

test("Contracts initial rows report surface and result-list readiness", () => {
  const { contracts, records } = harness(120, 125);
  contracts.resultsRendered(null, "content");
  assert.deepEqual(compact(records), [
    {
      milestone: "surface-ready",
      metric_id: "content_ready_ms",
      result_state: "content",
      value: 120,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: "none",
    },
    {
      milestone: "component-ready",
      metric_id: "component_ready_ms",
      result_state: "content",
      value: 125,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: CONTRACTS_RUM_IDS.results,
    },
  ]);
});

test("Contracts keyword interaction keeps input, feedback, and settled landmarks distinct", () => {
  const { contracts, records, paint } = harness(100, 130, 180, 185, 190);
  const action = contracts.beginInteraction();
  assert.equal(contracts.claimInteraction(), action);
  assert.equal(contracts.claimInteraction(), null, "one search invocation owns the action");

  paint();
  contracts.resultsRendered(action, "content");

  assert.deepEqual(compact(records).slice(0, 4), [
    {
      milestone: "interaction-start",
      metric_id: null,
      result_state: null,
      value: null,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: CONTRACTS_RUM_IDS.filter,
    },
    {
      milestone: "visual-feedback",
      metric_id: "interaction_feedback_ms",
      result_state: null,
      value: 30,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: CONTRACTS_RUM_IDS.filter,
    },
    {
      milestone: "surface-ready",
      metric_id: "content_ready_ms",
      result_state: "content",
      value: 180,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: "none",
    },
    {
      milestone: "component-ready",
      metric_id: "component_ready_ms",
      result_state: "content",
      value: 185,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: CONTRACTS_RUM_IDS.results,
    },
  ]);
  assert.deepEqual(compact(records).slice(4), [
    {
      milestone: "settled",
      metric_id: "interaction_settled_ms",
      result_state: "content",
      value: 90,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: CONTRACTS_RUM_IDS.filter,
    },
    {
      milestone: "feedback-to-settled",
      metric_id: "feedback_to_settled_ms",
      result_state: "content",
      value: 60,
      surface_id: CONTRACTS_RUM_IDS.surface,
      component_id: CONTRACTS_RUM_IDS.filter,
    },
  ]);
});

test("empty and unavailable results are honest bounded terminal states", () => {
  for (const resultState of ["empty", "unavailable"]) {
    const { contracts, records, paint } = harness(10, 20, 30, 31, 32);
    const action = contracts.beginInteraction();
    contracts.claimInteraction();
    paint();
    contracts.resultsRendered(action, resultState);
    const settled = records.find((record) => record.milestone === "settled");
    assert.equal(settled.result_state, resultState);
  }
});

test("settlement never fabricates feedback and a superseded action is cancelled", () => {
  const missing = harness(10, 20, 21);
  const missingAction = missing.contracts.beginInteraction();
  missing.contracts.claimInteraction();
  missing.contracts.resultsRendered(missingAction, "empty");
  assert.deepEqual(missing.records.map((record) => record.milestone), [
    "interaction-start",
    "surface-ready",
    "component-ready",
  ]);

  const cancelled = harness(10, 11, 12);
  cancelled.contracts.beginInteraction();
  cancelled.contracts.beginInteraction();
  assert.deepEqual(cancelled.records.map((record) => record.milestone), [
    "interaction-start",
    "cancel",
    "interaction-start",
  ]);
  assert.equal(cancelled.records[1].result_state, "cancelled");
  assert.ok(cancelled.records.every((record) => record.metric_id === null));
});

test("out-of-order feedback remains unmeasured", () => {
  const { contracts, records, paint } = harness(100, 90);
  contracts.beginInteraction();
  paint();
  assert.deepEqual(records.map((record) => record.milestone), ["interaction-start"]);
});

test("Contracts instrumentation emits no query, selector, target, or record identifiers", () => {
  const { contracts, records, paint } = harness(10, 20, 30, 31, 32);
  const action = contracts.beginInteraction();
  contracts.claimInteraction();
  paint();
  contracts.resultsRendered(action, "empty");
  const encoded = JSON.stringify(records);
  assert.doesNotMatch(encoded, /housing|query|selector|target|request_id|procurement_id|visitor|session/i);
  assert.ok(records.every((record) => record.schema === "cityscroll.performance.semantic_milestone.v1"));
});

test("RUM registry and all projections mark the Contracts slice instrumented", () => {
  const paths = [
    "../architecture/performance-observability.v1.json",
    "../site/data/performance-classification-manifest.v1.json",
    "../worker/src/data/performance-validation-allowlist.v1.json",
    "../worker/src/data/performance-operator-labels.v1.json",
  ];
  const [registry, browser, worker, operator] = paths.map((path) => JSON.parse(readFileSync(
    new URL(path, import.meta.url),
    "utf8",
  )));
  const instrumentedSurfaces = registry.surfaces
    .filter((entry) => entry.lifecycle_state === "instrumented")
    .map((entry) => entry.surface_id);
  const instrumentedComponents = registry.components
    .filter((entry) => entry.lifecycle_state === "instrumented")
    .map((entry) => entry.component_id);

  assert.ok(instrumentedSurfaces.includes(CONTRACTS_RUM_IDS.surface));
  assert.ok(instrumentedComponents.includes(CONTRACTS_RUM_IDS.filter));
  assert.ok(instrumentedComponents.includes(CONTRACTS_RUM_IDS.results));
  assert.equal(browser.collector.production_enabled, true);
  assert.equal(browser.surfaces.find((entry) => entry.surface_id === CONTRACTS_RUM_IDS.surface).lifecycle_state, "instrumented");
  assert.equal(worker.surfaces[CONTRACTS_RUM_IDS.surface].lifecycle_state, "instrumented");
  assert.equal(operator.surfaces.find((entry) => entry.surface_id === CONTRACTS_RUM_IDS.surface).lifecycle_state, "instrumented");
});
