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

test("queried window days uses query_end - query_start", () => {
  const days = queriedWindowDays({
    query_start: "2026-09-23T18:41:06.000Z",
    query_end: "2026-09-30T18:41:06.000Z",
  });
  assert.equal(days, 7);
});

test("case 1: near-you lcp desktop n=2 uses queried-window rate and projects 2027-01-06", () => {
  const projection = projectEarliestFloorDate(NEAR_YOU_LCP_DESKTOP);
  assert.equal(projection.basis, "linear_extrapolation_from_observed_window");
  assert.equal(projection.observed_rate_per_day, 0.286);
  assert.equal(projection.samples_needed, 28);
  assert.equal(projection.earliest_date, "2027-01-06");
  assert.equal(projection.rate_clamp_per_day, null);
  // Span-derived rate stays available but is not the projection input.
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
  assert.ok(projection.earliest_date == null || projection.earliest_date > "2026-09-30");
  // Must not emit a date on or before queried_at.
  assert.equal(projection.earliest_date, null);
});

test("case 3: projection beyond retention horizon emits null date with named basis", () => {
  const projection = projectEarliestFloorDate({
    ...NEAR_YOU_LCP_DESKTOP,
    // Strict dataset retention: 2/7 * 90 < 28 remaining samples.
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
  const fullDays = full.samples_needed / (full.observed_rate_per_day);
  const halvedDays = halved.samples_needed / (halved.observed_rate_per_day);
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

test("retained observation uses queried-window rates; withheld percentiles stay null below floor", () => {
  const observation = JSON.parse(readFileSync(OBSERVATION_PATH, "utf8"));
  const nearYouLcpDesktop = observation.observations.find(
    (row) =>
      row.surface_id === "near-you" &&
      row.metric_id === "lcp_ms" &&
      row.device_class === "desktop",
  );
  assert.ok(nearYouLcpDesktop);
  assert.equal(nearYouLcpDesktop.sampled_count, 2);
  assert.equal(nearYouLcpDesktop.quantile_value, null);
  assert.equal(nearYouLcpDesktop.pass, null);
  assert.equal(nearYouLcpDesktop.earliest_floor_date.observed_rate_per_day, 0.286);
  assert.equal(nearYouLcpDesktop.earliest_floor_date.earliest_date, "2027-01-06");
  assert.equal(nearYouLcpDesktop.earliest_floor_date.basis, "linear_extrapolation_from_observed_window");

  const noData = observation.observations.find(
    (row) =>
      row.surface_id === "near-you" &&
      row.metric_id === "inp_ms" &&
      row.device_class === "desktop",
  );
  assert.equal(noData.status, "no_data");
  assert.equal(noData.earliest_floor_date.basis, "no_positive_sample_rate");
  assert.equal(noData.earliest_floor_date.earliest_date, null);

  const homeDesktopLcp = observation.observations.find(
    (row) =>
      row.surface_id === "home" &&
      row.metric_id === "lcp_ms" &&
      row.device_class === "desktop",
  );
  assert.equal(homeDesktopLcp.status, "available");
  assert.equal(typeof homeDesktopLcp.quantile_value, "number");
  assert.equal(homeDesktopLcp.earliest_floor_date, null);

  // Recompute is stable on the retained document.
  const recomputed = recomputeObservationEarliestFloorDates(observation);
  const again = recomputed.observations.find(
    (row) =>
      row.surface_id === "near-you" &&
      row.metric_id === "lcp_ms" &&
      row.device_class === "desktop",
  );
  assert.equal(again.earliest_floor_date.earliest_date, "2027-01-06");
});
