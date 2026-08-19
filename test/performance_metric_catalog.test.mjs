import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PERFORMANCE_CATALOG_SCHEMA_PATH,
  loadPerformanceMetricCatalog,
  validatePerformanceMetricCatalog,
  validatePerformanceObservation,
} from "../tools/performance_metric_catalog.mjs";

const catalog = loadPerformanceMetricCatalog();
const byId = new Map(catalog.metrics.map((metric) => [metric.id, metric]));

test("versioned performance catalog validates against its closed machine contract", () => {
  assert.equal(validatePerformanceMetricCatalog(catalog), catalog);
  const schema = JSON.parse(readFileSync(PERFORMANCE_CATALOG_SCHEMA_PATH, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://cityscroll.org/schemas/performance-observability.v1.schema.json");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.$defs.observation.oneOf);
});

test("catalog carries every field, semantic, and decomposed phase metric with stable versions and units", () => {
  const expected = new Set([
    "ttfb_ms",
    "fcp_ms",
    "lcp_ms",
    "cls_score",
    "inp_ms",
    "content_ready_ms",
    "component_ready_ms",
    "interaction_feedback_ms",
    "interaction_settled_ms",
    "feedback_to_settled_ms",
    "response_to_first_render_ms",
    "first_render_to_main_ms",
    "main_to_useful_ms",
  ]);
  assert.deepEqual(new Set(byId.keys()), expected);
  for (const metric of byId.values()) {
    assert.match(metric.version, /^\d+\.\d+\.\d+$/);
    assert.ok(["ms", "score"].includes(metric.unit));
    assert.notEqual(metric.raw, metric.derived);
    assert.equal(metric.numeric_domain.measured_zero_valid, true);
  }
  assert.equal(byId.get("cls_score").unit, "score");
  assert.ok([...byId.values()].filter((metric) => metric.raw).length > 0);
  assert.ok([...byId.values()].filter((metric) => metric.derived).length > 0);
});

test("measured zero is valid while every non-measurement state forbids a numeric value", () => {
  const base = { metric_id: "ttfb_ms", metric_version: "1.0.0", unit: "ms" };
  assert.doesNotThrow(() => validatePerformanceObservation({ ...base, state: "measured", value: 0 }, catalog));
  assert.doesNotThrow(() => validatePerformanceObservation({ ...base, state: "missing" }, catalog));
  for (const state of ["missing", "unsupported", "background"]) {
    assert.throws(
      () => validatePerformanceObservation({ ...base, state, value: 0 }, catalog),
      /keys must be exactly/,
    );
  }
  const inp = { metric_id: "inp_ms", metric_version: "1.0.0", unit: "ms" };
  assert.doesNotThrow(() => validatePerformanceObservation({ ...inp, state: "no_interaction" }, catalog));
  assert.throws(
    () => validatePerformanceObservation({ ...inp, state: "no_interaction", value: 0 }, catalog),
    /keys must be exactly/,
  );
  assert.throws(() => validatePerformanceObservation({ ...base, state: "measured" }, catalog));
  assert.throws(() => validatePerformanceObservation({ ...base, state: "measured", value: -1 }, catalog));
  assert.throws(() => validatePerformanceObservation({ ...base, state: "measured", value: Number.NaN }, catalog));
});

test("synthetic mappings name only semantically compatible harness metrics and retain scoped caveats", () => {
  assert.deepEqual(byId.get("ttfb_ms").synthetic_mapping.names.map(({ name }) => name), ["ttfbMs"]);
  assert.deepEqual(byId.get("fcp_ms").synthetic_mapping.names.map(({ name }) => name), ["fcpMs"]);
  assert.deepEqual(byId.get("lcp_ms").synthetic_mapping.names.map(({ name }) => name), ["lcpMs"]);
  assert.match(byId.get("lcp_ms").synthetic_mapping.names[0].compatibility_condition, /zero default is absence/);
  assert.deepEqual(byId.get("cls_score").synthetic_mapping.names.map(({ name }) => name), ["cls"]);
  assert.deepEqual(byId.get("inp_ms").synthetic_mapping.names, []);
  assert.deepEqual(byId.get("inp_ms").synthetic_mapping.incompatible_names, ["eventDurationMs"]);
  assert.deepEqual(byId.get("interaction_feedback_ms").synthetic_mapping.names, []);
  assert.deepEqual(byId.get("interaction_feedback_ms").synthetic_mapping.incompatible_names, ["visualResponseMs"]);
  assert.deepEqual(byId.get("component_ready_ms").synthetic_mapping.names[0].fixture_scope, ["land.outcomes-first-paint:present"]);
  assert.deepEqual(byId.get("interaction_settled_ms").synthetic_mapping.names[0].fixture_scope, ["contracts.keyword-housing"]);
});

test("phase decomposition is browser-side, ordered, all-landmarks-only, and never clamps negatives", () => {
  const expected = new Map([
    ["delivery", ["ttfb_ms", "navigation_start", "response_start"]],
    ["response_to_first_render", ["response_to_first_render_ms", "response_start", "first_contentful_paint"]],
    ["first_render_to_main", ["first_render_to_main_ms", "first_contentful_paint", "largest_contentful_paint"]],
    ["main_to_useful", ["main_to_useful_ms", "largest_contentful_paint", "semantic_content_ready"]],
    ["action_to_feedback", ["interaction_feedback_ms", "interaction_start", "visible_feedback"]],
    ["feedback_to_settled", ["feedback_to_settled_ms", "visible_feedback", "interaction_settled"]],
    ["action_to_settled", ["interaction_settled_ms", "interaction_start", "interaction_settled"]],
  ]);
  assert.equal(catalog.phase_decompositions.length, expected.size);
  for (const phase of catalog.phase_decompositions) {
    assert.deepEqual(
      [phase.metric_id, phase.start_landmark, phase.end_landmark],
      expected.get(phase.phase_id),
    );
    assert.equal(phase.derive_in, "browser");
    assert.equal(phase.operation, "end_minus_start");
    assert.deepEqual(phase.preconditions, [
      "all_landmarks_present",
      "all_landmarks_finite",
      "landmarks_ordered",
    ]);
    assert.equal(phase.invalid_result, "omit");
    assert.equal(phase.negative_result, "omit_never_clamp");
  }
});

test("catalog contains no performance enforcement policy", () => {
  const forbiddenKey = /(?:^|_)(?:threshold|budget|ceiling|slo|objective)(?:_|$)/i;
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, forbiddenKey);
      visit(child);
    }
  }
  visit(catalog);
});

test("validator rejects catalog drift that weakens identity, derivation, or policy boundaries", () => {
  const duplicate = structuredClone(catalog);
  duplicate.metrics.push(structuredClone(duplicate.metrics[0]));
  assert.throws(() => validatePerformanceMetricCatalog(duplicate), /duplicate metric id/);

  const unknownInput = structuredClone(catalog);
  byMetric(unknownInput, "feedback_to_settled_ms").derived_from.push("unknown_metric_ms");
  assert.throws(() => validatePerformanceMetricCatalog(unknownInput), /references unknown metric/);

  const clamped = structuredClone(catalog);
  clamped.phase_decompositions[0].negative_result = "clamp_to_zero";
  assert.throws(() => validatePerformanceMetricCatalog(clamped), /without clamping/);

  const policy = structuredClone(catalog);
  policy.metrics[0].latency_threshold_ms = 100;
  assert.throws(() => validatePerformanceMetricCatalog(policy), /keys must be exactly|enforcement-policy key/);
});

function byMetric(document, id) {
  return document.metrics.find((metric) => metric.id === id);
}
