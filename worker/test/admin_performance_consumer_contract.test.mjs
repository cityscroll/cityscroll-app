import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ADMIN_PERFORMANCE_SCHEMA,
  ADMIN_PERFORMANCE_STATES,
  parseAdminPerformanceRequest,
} from "../src/admin_performance.mjs";
import {
  OPS_CONTRACT_VERSION,
  buildOpsContract,
} from "../src/lib/ops_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const MANIFEST_PATH = "data/rum-09-desk-contract-fixtures/desk-consumer-contract.v1.json";
const manifest = readJson(MANIFEST_PATH);
const response = readJson(manifest.reference_response.path);
const stateMatrix = readJson(manifest.edge_states.path);
const committedOpsContract = readJson(manifest.ops_contract_path);

function parsedQuery(query) {
  return parseAdminPerformanceRequest(new Request(`https://worker.invalid/admin/performance${query}`));
}

function assertMissingPercentilesNeverBecomeZero(value, label = "response") {
  if (!value || typeof value !== "object") return;
  if (value.status && !["available", "flowing"].includes(value.status)) {
    assert.equal(Object.hasOwn(value, "percentiles"), false, `${label} has percentiles for ${value.status}`);
    for (const field of ["p50", "p75", "p95"]) {
      assert.equal(Object.hasOwn(value, field), false, `${label}.${field} must be absent, not zero`);
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    assertMissingPercentilesNeverBecomeZero(nested, `${label}.${key}`);
  }
}

test("Desk manifest pins repository-owned response fixtures and the acceptance test", () => {
  assert.equal(manifest.schema, "cityscroll.admin.performance.desk_consumer_contract.v1");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.response_schema, ADMIN_PERFORMANCE_SCHEMA);
  for (const path of [
    MANIFEST_PATH,
    manifest.reference_response.path,
    manifest.edge_states.path,
    manifest.ops_contract_path,
    manifest.acceptance_test,
  ]) {
    assert.equal(existsSync(join(ROOT, path)), true, `missing advertised contract path: ${path}`);
  }
  assert.equal(response.schema, ADMIN_PERFORMANCE_SCHEMA);
  assert.equal(stateMatrix.response_schema, ADMIN_PERFORMANCE_SCHEMA);
});

test("ops-contract discovery pins the same fixture bundle without changing the response schema", () => {
  const generated = buildOpsContract({ generated_at: committedOpsContract.generated_at });
  assert.deepEqual(generated, committedOpsContract);
  assert.equal(OPS_CONTRACT_VERSION, "1.9.2");
  assert.equal(generated.performance.version, "1.0.0");
  assert.equal(generated.performance.consumer_handoff.manifest, MANIFEST_PATH);
  assert.equal(generated.performance.consumer_handoff.reference_response, manifest.reference_response.path);
  assert.equal(generated.performance.consumer_handoff.edge_states, manifest.edge_states.path);
  assert.equal(generated.performance.consumer_handoff.acceptance_test, manifest.acceptance_test);
  assert.deepEqual(
    generated.performance.consumer_handoff.views,
    Object.keys(manifest.views),
  );
});

test("the reference response supports overview and surface-detail projections", () => {
  assert.deepEqual(parsedQuery(manifest.views.overview.query), {
    window: "7d",
    filters: {},
    group_by: ["metric_id", "surface_id", "component_id"],
  });
  assert.deepEqual(parsedQuery(manifest.views.surface_detail.query), {
    window: "7d",
    filters: { surface_id: "home" },
    group_by: ["metric_id", "component_id"],
  });

  assert.ok(response.catalog.metrics.length > 0);
  assert.ok(response.catalog.surfaces.some(({ surface_id }) => surface_id === "home"));
  assert.ok(response.series.some((row) => row.current.status === "available"));
  assert.ok(response.series.some((row) => row.current.status === "insufficient_sample"));
  assert.ok(response.series.some((row) => row.comparison.status === "available"));
  assert.ok(response.series.some((row) => row.trend.some(({ status }) => status === "no_data")));
});

test("phase decomposition is catalog-driven and missing phases are not invented", () => {
  const metricIds = new Set(response.catalog.metrics.map(({ metric_id }) => metric_id));
  for (const metricId of manifest.views.phase_decomposition.metric_ids) {
    assert.equal(metricIds.has(metricId), true, `phase metric is not registered: ${metricId}`);
  }
  assert.match(manifest.views.phase_decomposition.missing_phase_rule, /Omit/);
  assert.match(manifest.views.phase_decomposition.missing_phase_rule, /never synthesize zero/);
  assertMissingPercentilesNeverBecomeZero(response);
});

test("architecture coverage and telemetry health come from the response, not copied Desk registries", () => {
  assert.match(response.catalog.registry_hash, /^[a-f0-9]{64}$/);
  for (const entry of [...response.catalog.surfaces, ...response.catalog.components]) {
    assert.equal(typeof entry.architecture_container_ref, "string", `${entry.surface_id || entry.component_id} has no architecture owner`);
  }
  assert.equal(response.coverage.registered.surface_count, response.catalog.surfaces.length);
  assert.equal(response.coverage.registered.component_count, response.catalog.components.length);
  assert.equal(response.coverage.unclassified_observations.status, "unclassified");
  assert.equal(typeof response.freshness.status, "string");
  assert.equal(typeof response.data_health.status, "string");
  assert.equal(typeof response.sampling.method, "string");
  assert.equal(typeof response.retention.retention_days, "number");
  assert.equal(manifest.trust_boundary.copied_registry_in_consumer, false);
  assert.equal(manifest.trust_boundary.analytics_engine_credentials_in_consumer, false);
  assert.equal(manifest.trust_boundary.public_site_ui_in_this_repository, false);
});

test("consumer edge states stay explicit and every missing value is absent, never zero", () => {
  const expectedStates = new Set([
    "available",
    "partial",
    "insufficient_sample",
    "no_data",
    "uninstrumented",
    "unclassified",
    "unavailable",
  ]);
  assert.deepEqual(new Set(ADMIN_PERFORMANCE_STATES), expectedStates);
  const matrixStates = new Set(stateMatrix.cases.flatMap((entry) => [
    entry.expected_status,
    entry.expected_coverage_status,
  ]).filter(Boolean));
  assert.deepEqual(matrixStates, expectedStates);
  assert.equal(manifest.honest_states.low_sample, "insufficient_sample");
  assert.match(manifest.honest_states.missing_never_zero, /absent/);
  assert.match(manifest.honest_states.missing_never_zero, /never an absence sentinel/);

  for (const fixtureCase of stateMatrix.cases.filter(({ percentiles_present }) => percentiles_present === false)) {
    assert.equal(fixtureCase.p50, undefined, fixtureCase.name);
    assert.equal(fixtureCase.p75, undefined, fixtureCase.name);
    assert.equal(fixtureCase.p95, undefined, fixtureCase.name);
    if (fixtureCase.expected_status !== "partial") {
      assert.equal(fixtureCase.missing_value_rule, "omit_percentiles_never_zero", fixtureCase.name);
    }
  }
});
