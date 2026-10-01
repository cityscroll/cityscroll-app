import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FIELD_VITALS_DATASET_RETENTION_DAYS,
  projectEarliestFloorDate,
  queriedWindowDays,
  recomputeObservationEarliestFloorDates,
} from "../tools/lib/geography_navigation_field_vitals.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATION_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-observation.json",
);

const NEAR_YOU_LCP_DESKTOP = {
  sampledCount: 2,
  sampleFloor: 30,
  queryStart: "2026-09-23T18:41:06.000Z",
  queryEnd: "2026-09-30T18:41:06.000Z",
  queriedAt: "2026-09-30T18:41:06.194Z",
  firstObservationAt: "2026-09-25T18:40:19.000Z",
  latestObservationAt: "2026-09-25T23:50:43.000Z",
};

function cell(observation, surfaceId, metricId, deviceClass) {
  return observation.observations.find(
    (row) =>
      row.surface_id === surfaceId &&
      row.metric_id === metricId &&
      row.device_class === deviceClass,
  );
}

test("queried window days uses query_end - query_start", () => {
  const days = queriedWindowDays({
    query_start: "2026-09-23T18:41:06.000Z",
    query_end: "2026-09-30T18:41:06.000Z",
  });
  assert.equal(days, 7);
});

test("case 1: near-you lcp desktop n=2 uses queried-window rate (uncapped calendar projection)", () => {
  // Library default calendar ceiling still demonstrates the window-basis date.
  const projection = projectEarliestFloorDate(NEAR_YOU_LCP_DESKTOP);
  assert.equal(projection.basis, "linear_extrapolation_from_observed_window");
  assert.equal(projection.observed_rate_per_day, 0.286);
  assert.equal(projection.samples_needed, 28);
  assert.equal(projection.earliest_date, "2027-01-06");
  assert.equal(projection.rate_clamp_per_day, null);
  assert.ok(projection.span_observed_rate_per_day > 1);
  assert.notEqual(projection.span_observed_rate_per_day, projection.observed_rate_per_day);
});

test("case 2: zero observation span emits null date with named basis", () => {
  const projection = projectEarliestFloorDate({
    sampledCount: 3,
    sampleFloor: 30,
    queryStart: "2026-09-23T18:41:07.000Z",
    queryEnd: "2026-09-30T18:41:07.000Z",
    queriedAt: "2026-09-30T18:41:06.194Z",
    firstObservationAt: "2026-09-26T19:24:39.000Z",
    latestObservationAt: "2026-09-26T19:24:39.000Z",
  });
  assert.equal(projection.earliest_date, null);
  assert.equal(projection.basis, "insufficient_rate_to_project");
  assert.ok(projection.observed_rate_per_day > 0);
});

test("case 3: projection beyond retention horizon emits null date with named basis", () => {
  const projection = projectEarliestFloorDate({
    ...NEAR_YOU_LCP_DESKTOP,
    retentionHorizonDays: FIELD_VITALS_DATASET_RETENTION_DAYS,
  });
  assert.equal(projection.earliest_date, null);
  assert.equal(projection.basis, "insufficient_rate_to_project");
  assert.equal(projection.observed_rate_per_day, 0.286);
  assert.equal(projection.retention_horizon_days, FIELD_VITALS_DATASET_RETENTION_DAYS);
});

test("mutation control: halving sampled_count at least doubles days-to-floor", () => {
  const full = projectEarliestFloorDate({
    sampledCount: 10,
    sampleFloor: 30,
    queryStart: "2026-09-23T18:41:06.000Z",
    queryEnd: "2026-09-30T18:41:06.000Z",
    queriedAt: "2026-09-30T18:41:06.194Z",
    firstObservationAt: "2026-09-24T00:00:00.000Z",
    latestObservationAt: "2026-09-29T00:00:00.000Z",
  });
  const halved = projectEarliestFloorDate({
    sampledCount: 5,
    sampleFloor: 30,
    queryStart: "2026-09-23T18:41:06.000Z",
    queryEnd: "2026-09-30T18:41:06.000Z",
    queriedAt: "2026-09-30T18:41:06.194Z",
    firstObservationAt: "2026-09-24T00:00:00.000Z",
    latestObservationAt: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(full.basis, "linear_extrapolation_from_observed_window");
  assert.equal(halved.basis, "linear_extrapolation_from_observed_window");
  const fullDays = full.samples_needed / full.observed_rate_per_day;
  const halvedDays = halved.samples_needed / halved.observed_rate_per_day;
  assert.ok(halvedDays >= fullDays * 2 - 1e-9, `${halvedDays} vs ${fullDays}`);
});

test("mutation control: doubling sampled_count at least halves days-to-floor", () => {
  const base = projectEarliestFloorDate({
    sampledCount: 5,
    sampleFloor: 30,
    queryStart: "2026-09-23T18:41:06.000Z",
    queryEnd: "2026-09-30T18:41:06.000Z",
    queriedAt: "2026-09-30T18:41:06.194Z",
    firstObservationAt: "2026-09-24T00:00:00.000Z",
    latestObservationAt: "2026-09-29T00:00:00.000Z",
  });
  const doubled = projectEarliestFloorDate({
    sampledCount: 10,
    sampleFloor: 30,
    queryStart: "2026-09-23T18:41:06.000Z",
    queryEnd: "2026-09-30T18:41:06.000Z",
    queriedAt: "2026-09-30T18:41:06.194Z",
    firstObservationAt: "2026-09-24T00:00:00.000Z",
    latestObservationAt: "2026-09-29T00:00:00.000Z",
  });
  const baseDays = base.samples_needed / base.observed_rate_per_day;
  const doubledDays = doubled.samples_needed / doubled.observed_rate_per_day;
  assert.ok(doubledDays <= baseDays / 2 + 1e-9, `${doubledDays} vs ${baseDays}`);
});

test("zero-sample cell records no_positive_sample_rate with null date", () => {
  const projection = projectEarliestFloorDate({
    sampledCount: 0,
    sampleFloor: 30,
    queryStart: "2026-09-23T18:41:06.000Z",
    queryEnd: "2026-09-30T18:41:06.000Z",
    queriedAt: "2026-09-30T18:41:06.194Z",
  });
  assert.equal(projection.earliest_date, null);
  assert.equal(projection.basis, "no_positive_sample_rate");
});

test("acceptance 1: retained near-you desktop LCP/CLS null with insufficient_rate_to_project", () => {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, "utf8"));
  for (const metricId of ["lcp_ms", "cls_score"]) {
    const row = cell(observation, "near-you", metricId, "desktop");
    assert.equal(row.sampled_count, 2);
    assert.equal(row.earliest_floor_date.observed_rate_per_day, 0.286);
    assert.equal(row.earliest_floor_date.earliest_date, null);
    assert.equal(row.earliest_floor_date.basis, "insufficient_rate_to_project");
    assert.equal(row.earliest_floor_date.retention_horizon_days, FIELD_VITALS_DATASET_RETENTION_DAYS);
  }
});

test("acceptance 2: in-horizon home cells keep their window-basis dates", () => {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, "utf8"));
  assert.equal(cell(observation, "home", "lcp_ms", "mobile").earliest_floor_date.earliest_date, "2026-10-12");
  assert.equal(cell(observation, "home", "inp_ms", "desktop").earliest_floor_date.earliest_date, "2026-10-12");
  assert.equal(cell(observation, "home", "inp_ms", "mobile").earliest_floor_date.earliest_date, "2026-12-02");
  assert.equal(cell(observation, "home", "cls_score", "mobile").earliest_floor_date.earliest_date, "2026-10-17");
});

test("acceptance 3: floor-met cells keep percentiles; zero-sample cells stay no_positive_sample_rate", () => {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, "utf8"));
  const homeLcp = cell(observation, "home", "lcp_ms", "desktop");
  assert.equal(homeLcp.status, "available");
  assert.equal(typeof homeLcp.quantile_value, "number");
  assert.equal(homeLcp.earliest_floor_date, null);

  const homeCls = cell(observation, "home", "cls_score", "desktop");
  assert.equal(homeCls.status, "available");
  assert.equal(typeof homeCls.quantile_value, "number");
  assert.equal(homeCls.earliest_floor_date, null);

  for (const [metricId, deviceClass] of [
    ["lcp_ms", "mobile"],
    ["inp_ms", "desktop"],
    ["inp_ms", "mobile"],
    ["cls_score", "mobile"],
  ]) {
    const row = cell(observation, "near-you", metricId, deviceClass);
    assert.equal(row.sampled_count, 0);
    assert.equal(row.earliest_floor_date.basis, "no_positive_sample_rate");
    assert.equal(row.earliest_floor_date.earliest_date, null);
  }
});

test("acceptance 4: raising rate into horizon creates a date; lowering removes it with named basis", () => {
  const inside = projectEarliestFloorDate({
    ...NEAR_YOU_LCP_DESKTOP,
    sampledCount: 10, // 10/7 * 90 > 20 remaining
    retentionHorizonDays: FIELD_VITALS_DATASET_RETENTION_DAYS,
  });
  assert.equal(inside.basis, "linear_extrapolation_from_observed_window");
  assert.ok(inside.earliest_date);

  const outside = projectEarliestFloorDate({
    ...NEAR_YOU_LCP_DESKTOP,
    sampledCount: 2,
    retentionHorizonDays: FIELD_VITALS_DATASET_RETENTION_DAYS,
  });
  assert.equal(outside.earliest_date, null);
  assert.equal(outside.basis, "insufficient_rate_to_project");
});

test("acceptance 5+6: recomputing every retained cell with module constant matches the file", () => {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, "utf8"));
  const recomputed = recomputeObservationEarliestFloorDates(observation, {
    retentionHorizonDays: FIELD_VITALS_DATASET_RETENTION_DAYS,
  });
  // Default recompute also uses the module dataset constant (no restated literal).
  const defaultRecompute = recomputeObservationEarliestFloorDates(observation);

  for (let i = 0; i < observation.observations.length; i += 1) {
    const retained = observation.observations[i].earliest_floor_date;
    const again = recomputed.observations[i].earliest_floor_date;
    const viaDefault = defaultRecompute.observations[i].earliest_floor_date;
    assert.deepEqual(again, retained, `row ${i} explicit constant`);
    assert.deepEqual(viaDefault, retained, `row ${i} default recompute`);
    if (retained && retained.retention_horizon_days != null) {
      assert.equal(retained.retention_horizon_days, FIELD_VITALS_DATASET_RETENTION_DAYS);
    }
  }
});
