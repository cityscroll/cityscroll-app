import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildBaseline,
  buildCandidates,
  buildDriftOverlay,
  PERFORMANCE_DRIFT_SCHEMA,
} from "../tools/lib/performance_drift.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function snapshotFor({ p75 = 2000, p95 = 4000, sampled = 40 } = {}) {
  return {
    schema: "cityscroll.performance.query_result.v1",
    status: "available",
    sample_floor: 30,
    query: { window: "7d", filters: {}, group_by: ["metric_id", "surface_id"] },
    retention: {
      current: {
        status: "complete",
        requested_start: "2026-08-18T00:00:00.000Z",
        requested_end: "2026-08-25T00:00:00.000Z",
      },
    },
    series: [{
      dimensions: { metric_id: "content_ready_ms", surface_id: "home" },
      current: {
        status: "available",
        sampled_count: sampled,
        estimated_count: sampled,
        percentiles: { p50: 1500, p75, p95 },
      },
      latest_observation_at: "2026-08-24T23:59:00.000Z",
    }],
    sampling: { method: "fixture" },
    data_health: { status: "available" },
  };
}

test("full SLO catches a p95-only breach and emits a proposed candidate without enforcement", () => {
  const overlay = buildDriftOverlay(snapshotFor({ p75: 2200, p95: 6000 }), {
    now: new Date("2026-08-25T00:00:00.000Z"),
    sourceRun: "test-run",
  });
  const home = overlay.surfaces.find((surface) => surface.surface_id === "home");
  const metric = home.metrics.content_ready_ms;
  assert.equal(overlay.schema, PERFORMANCE_DRIFT_SCHEMA);
  assert.equal(metric.data_status, "flowing");
  assert.equal(metric.slo_state, "needs-work");
  assert.deepEqual(metric.slo_reasons, ["p95-over-good"]);
  assert.ok(buildCandidates(overlay).some((candidate) => candidate.id.endsWith("-slo-breach")));
  assert.equal(overlay.enforcement.ci_gate, false);
  assert.equal(overlay.enforcement.auto_merge, false);
  assert.equal(overlay.enforcement.ownership_changes, false);
  assert.equal(overlay.coverage.schema, "cityscroll.performance.coverage_contract.v1");
  assert.equal(overlay.coverage.read_status, "not_read");
  assert.equal(overlay.coverage.readiness.cells.length, 23);
  assert.equal(overlay.coverage.devices.cells.length, 48);
  assert.equal(overlay.coverage.phases.cells.length, 36);
  assert.equal(overlay.coverage.readiness.cells.find((cell) => cell.surface_id === "near-you" && cell.metric_id === "content_ready_ms").state, "no_data");
});

test("sample floor and missing rows remain explicit and never become zero", () => {
  const overlay = buildDriftOverlay({
    ...snapshotFor({ sampled: 29 }),
    series: [{
      dimensions: { metric_id: "content_ready_ms", surface_id: "home" },
      current: { status: "insufficient_sample", sampled_count: 29 },
      latest_observation_at: null,
    }],
  }, { now: new Date("2026-08-25T00:00:00.000Z") });
  const home = overlay.surfaces.find((surface) => surface.surface_id === "home");
  assert.equal(home.metrics.content_ready_ms.data_status, "insufficient_sample");
  assert.equal(Object.hasOwn(home.metrics.content_ready_ms, "p75_ms"), false);
  assert.equal(Object.hasOwn(home.metrics.content_ready_ms, "p95_ms"), false);
  assert.equal(home.metrics.component_ready_ms.data_status, "no_data");
  assert.equal(overlay.surfaces.find((surface) => surface.surface_id === "now").data_status, "uninstrumented");
});

test("a partial window cannot surface a percentile even when retained rows clear the floor", () => {
  const snapshot = snapshotFor({ sampled: 40 });
  snapshot.retention.current.status = "partial";
  const overlay = buildDriftOverlay(snapshot, { now: new Date("2026-08-25T00:00:00.000Z") });
  const metric = overlay.surfaces.find((surface) => surface.surface_id === "home").metrics.content_ready_ms;
  assert.equal(metric.data_status, "insufficient_sample");
  assert.equal(metric.slo_state, "needs-data");
  assert.equal(Object.hasOwn(metric, "p75_ms"), false);
  assert.equal(buildCandidates(overlay).length, 0);
});

test("stored baseline produces a stable regression candidate", () => {
  const first = buildDriftOverlay(snapshotFor({ p75: 2000, p95: 4000 }), {
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  const baseline = buildBaseline(first);
  const second = buildDriftOverlay(snapshotFor({ p75: 2500, p95: 5000 }), {
    baseline,
    now: new Date("2026-08-25T00:00:00.000Z"),
    sourceRun: "test-run-2",
  });
  const metric = second.surfaces.find((surface) => surface.surface_id === "home").metrics.content_ready_ms;
  assert.equal(metric.drift.status, "compared");
  assert.ok(metric.drift.triggers.includes("p75-20-percent"));
  assert.ok(metric.drift.triggers.includes("p95-20-percent"));
  const candidates = buildCandidates(second);
  assert.ok(candidates.some((candidate) => candidate.id.includes("regression-p75-20-percent")));
  assert.ok(candidates.every((candidate) => candidate.status === "proposed"));
});

test("an unavailable read creates honest overlay evidence and no enforcement failure", () => {
  const overlay = buildDriftOverlay({ status: "unavailable", unavailable_reason: "sql-503" }, {
    now: new Date("2026-08-25T00:00:00.000Z"),
  });
  const home = overlay.surfaces.find((surface) => surface.surface_id === "home");
  assert.equal(home.metrics.content_ready_ms.data_status, "unavailable");
  assert.equal(buildCandidates(overlay).length, 0);
  assert.equal(overlay.enforcement.ci_gate, false);
});

test("lab evidence is separate and cannot emit field candidates", () => {
  const lab = snapshotFor({ p75: 6000, p95: 12000 });
  lab.query.filters.traffic_class = "lab";
  const overlay = buildDriftOverlay(snapshotFor({ p75: 2000, p95: 4000 }), {
    labSnapshot: lab,
    now: new Date("2026-08-25T00:00:00.000Z"),
    sourceRun: "generate-read-test",
    generation: { mode: "generate", traffic_class: "lab", verdict: "GENERATED" },
  });
  assert.equal(overlay.field.traffic_class, "production");
  assert.equal(overlay.surfaces.find((surface) => surface.surface_id === "home")
    .metrics.content_ready_ms.traffic_class, "production");
  assert.equal(overlay.lab.traffic_class, "lab");
  assert.equal(overlay.lab.measurement_origin, "controlled");
  assert.equal(overlay.lab.surfaces.find((surface) => surface.surface_id === "home")
    .metrics.content_ready_ms.slo_state, "fail");
  assert.equal(buildCandidates(overlay).length, 0);
});

test("the live CLI stays successful on an unavailable read and the workflow is once daily", () => {
  const out = mkdtempSync(join(tmpdir(), "cityscroll-performance-drift-"));
  const env = { ...process.env };
  for (const key of ["ANALYTICS_ACCOUNT_ID", "ANALYTICS_READ_TOKEN"]) delete env[key];
  const result = spawnSync(process.execPath, [
    "tools/read_rum_drift.mjs",
    "--out",
    out,
    "--now",
    "2026-08-25T00:00:00.000Z",
  ], { cwd: join(TEST_DIR, ".."), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const overlay = JSON.parse(readFileSync(join(out, "rum-status.json"), "utf8"));
  assert.equal(overlay.query_status, "unavailable");
  assert.equal(overlay.enforcement.ci_gate, false);

  const workflow = readFileSync(join(TEST_DIR, "../.github/workflows/performance-drift-daily.yml"), "utf8");
  assert.match(workflow, /cron: "31 9 \* \* \*"/);
  assert.doesNotMatch(workflow, /cron: "\d+  \* \* \* \*"/);
  assert.doesNotMatch(workflow, /exit 1/);
  assert.match(workflow, /Generate controlled RUM observations[\s\S]*CROL_RUM_E2E_GENERATE: "1"[\s\S]*python3 test\/functional\/rum_performance_e2e\.py[\s\S]*Read field and lab RUM/);
  assert.match(workflow, /--generation artifacts\/performance-drift\/rum-generation\/chain\.json/);
});
