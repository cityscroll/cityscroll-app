// Retained Notice post-delivery read-back aggregate.
//
// The register needs a committed file keyed by measurement group. These cases
// pin the shape: a well-formed aggregate validates, a missing group refuses by
// name, a below-floor sample refuses by name, and samples that predate the
// delivery refuse by name. A non-vacuity control runs in both directions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  NOTICE_READBACK_AGGREGATE_SCHEMA,
  NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON,
  NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP,
  NOTICE_READBACK_CACHE_OUTCOMES,
  NOTICE_READBACK_DELIVERIES,
  NOTICE_READBACK_RETAINED_PATH,
  NOTICE_READBACK_REQUIRED_GROUPS,
  NOTICE_READBACK_SAMPLE_FLOOR,
  buildNoticeReadbackAggregate,
  buildReadRecordCacheOutcomeDistribution,
  buildUnreadRecordCacheOutcomeDistribution,
  cloneNoticeReadbackAggregate,
  emptyRecordCacheOutcomeCounts,
  validateNoticeReadbackAggregate,
  withoutMeasurementGroup,
  withoutRecordCacheOutcomeDistribution,
} from "../tools/lib/notice_readback_aggregate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RETAINED = join(ROOT, NOTICE_READBACK_RETAINED_PATH);

function readBackDocument({
  group = "resident",
  trafficClass = "production",
  start = "2026-09-23T12:00:00.000Z",
  end = "2026-09-30T12:00:00.000Z",
  sampledCount = 96,
  percentiles = { p50: 100, p75: 200, p95: 400 },
  firstObservationAt = "2026-09-23T13:00:00.000Z",
  latestObservationAt = "2026-09-30T10:00:00.000Z",
  beginsAtOrAfterAnchor = true,
  windowComplete = true,
} = {}) {
  return {
    schema: "cityscroll.rum_measurement_group_read_back.v1",
    measurement_group: group,
    label: group,
    traffic_class: trafficClass,
    query_status: "available",
    sample_floor: NOTICE_READBACK_SAMPLE_FLOOR,
    window: {
      requested_start: start,
      requested_end: end,
      status: windowComplete ? "complete" : "incomplete",
      complete: windowComplete,
      begins_at_or_after_anchor: beginsAtOrAfterAnchor,
    },
    groups: [{
      measurement_group: group,
      sampled_count: sampledCount,
      estimated_count: sampledCount,
      sufficiency: sampledCount >= NOTICE_READBACK_SAMPLE_FLOOR ? "sufficient" : "insufficient_sample",
      p50_ms: percentiles.p50,
      p75_ms: percentiles.p75,
      p95_ms: percentiles.p95,
      first_observation_at: firstObservationAt,
      latest_observation_at: latestObservationAt,
    }],
  };
}

function wellFormedReads() {
  return [
    {
      group: "cold_module_path",
      metric_id: "component_ready_ms",
      surface_id: "notice",
      component_id: "notice-context",
      document: readBackDocument({ sampledCount: 121, percentiles: { p50: 1175.5, p75: 2004.4, p95: 6908.1 } }),
    },
    {
      group: "cold_module_path",
      metric_id: "content_ready_ms",
      surface_id: "notice",
      component_id: "none",
      document: readBackDocument({ sampledCount: 121, percentiles: { p50: 993.9, p75: 1431.1, p95: 3971.9 } }),
    },
    {
      group: "first_byte",
      metric_id: "ttfb_ms",
      surface_id: "notice",
      component_id: "none",
      document: readBackDocument({ sampledCount: 140, percentiles: { p50: 20.2, p75: 395.8, p95: 2844.2 } }),
    },
    {
      group: "first_byte",
      metric_id: "ttfb_ms",
      surface_id: "home",
      component_id: "none",
      document: readBackDocument({ sampledCount: 110, percentiles: { p50: 71.8, p75: 106, p95: 630.4 } }),
    },
    {
      group: "synthetic",
      metric_id: "content_ready_ms",
      surface_id: "notice",
      component_id: "none",
      document: readBackDocument({
        group: "synthetic",
        trafficClass: "synthetic",
        sampledCount: 216,
        percentiles: { p50: 6127.8, p75: 6523.4, p95: 7542.3 },
      }),
    },
    {
      group: "synthetic",
      metric_id: "component_ready_ms",
      surface_id: "notice",
      component_id: "notice-context",
      document: readBackDocument({
        group: "synthetic",
        trafficClass: "synthetic",
        sampledCount: 210,
        percentiles: { p50: 6707.6, p75: 7108.1, p95: 8018.4 },
      }),
    },
  ];
}

function wellFormedCacheDistribution({
  state = "unread",
  outcomes = null,
} = {}) {
  const window = {
    requested_start: "2026-09-23T12:00:00.000Z",
    requested_end: "2026-09-30T12:00:00.000Z",
    complete: true,
    begins_at_or_after_delivery: true,
  };
  const delivery = {
    kind: NOTICE_READBACK_DELIVERIES.first_byte.kind,
    at: NOTICE_READBACK_DELIVERIES.first_byte.merged_at,
    merge_commit: NOTICE_READBACK_DELIVERIES.first_byte.merge_commit,
    pull_request: NOTICE_READBACK_DELIVERIES.first_byte.pull_request,
    note: NOTICE_READBACK_DELIVERIES.first_byte.note,
  };
  if (state === "read") {
    return buildReadRecordCacheOutcomeDistribution({
      outcomes: outcomes ?? emptyRecordCacheOutcomeCounts(),
      window,
      delivery,
      queriedAt: "2026-09-30T12:37:18.000Z",
    });
  }
  return buildUnreadRecordCacheOutcomeDistribution({
    reason: NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON,
    detail: "fixture unread distribution for validator coverage",
    window,
    delivery,
    queriedAt: "2026-09-30T12:37:18.000Z",
  });
}

function wellFormedAggregate({
  recordCacheOutcomeDistribution = wellFormedCacheDistribution({ state: "unread" }),
} = {}) {
  return buildNoticeReadbackAggregate({
    reads: wellFormedReads(),
    productionRevision: "c9381ab637d8970e8653a0e7616d76f5faa45653",
    queriedAt: "2026-09-30T12:37:18.000Z",
    recordCacheOutcomeDistribution,
  });
}

test("a well-formed aggregate validates and names every required group", () => {
  const aggregate = wellFormedAggregate();
  assert.equal(aggregate.schema, NOTICE_READBACK_AGGREGATE_SCHEMA);
  assert.deepEqual(aggregate.required_groups, [...NOTICE_READBACK_REQUIRED_GROUPS]);
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, true, JSON.stringify(validation.refusals));
  assert.equal(validation.refusals.length, 0);
  for (const name of NOTICE_READBACK_REQUIRED_GROUPS) {
    const group = aggregate.measurement_groups[name];
    assert.equal(group.clears_sample_floor, true);
    assert.equal(group.window.post_dates_delivery, true);
    assert.equal(group.delivery.at, NOTICE_READBACK_DELIVERIES[name].merged_at);
    for (const metric of group.metrics) {
      assert.ok(metric.sampled_count >= NOTICE_READBACK_SAMPLE_FLOOR);
      assert.equal(metric.sufficiency, "sufficient");
      assert.notEqual(metric.p95_ms, null);
    }
  }
});

test("refusal: below_sample_floor names the thin metric", () => {
  const aggregate = wellFormedAggregate();
  aggregate.measurement_groups.first_byte.metrics[0].sampled_count = 12;
  aggregate.measurement_groups.first_byte.metrics[0].sufficiency = "insufficient_sample";
  aggregate.measurement_groups.first_byte.metrics[0].p50_ms = null;
  aggregate.measurement_groups.first_byte.metrics[0].p75_ms = null;
  aggregate.measurement_groups.first_byte.metrics[0].p95_ms = null;
  aggregate.measurement_groups.first_byte.clears_sample_floor = false;
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, false);
  const hit = validation.refusals.find((row) => row.reason === "below_sample_floor");
  assert.ok(hit, JSON.stringify(validation.refusals));
  assert.equal(hit.measurement_group, "first_byte");
  assert.equal(hit.metric_id, "ttfb_ms");
  assert.equal(hit.surface_id, "notice");
  assert.equal(hit.sampled_count, 12);
  assert.equal(hit.sample_floor, NOTICE_READBACK_SAMPLE_FLOOR);
});

test("refusal: missing_measurement_group names the absent group", () => {
  const aggregate = withoutMeasurementGroup(wellFormedAggregate(), "synthetic");
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, false);
  const hit = validation.refusals.find((row) => row.reason === "missing_measurement_group");
  assert.ok(hit, JSON.stringify(validation.refusals));
  assert.equal(hit.measurement_group, "synthetic");
});

test("refusal: samples_predate_delivery names the early window", () => {
  const aggregate = wellFormedAggregate();
  const earlyStart = "2026-09-01T00:00:00.000Z";
  aggregate.measurement_groups.cold_module_path.window.requested_start = earlyStart;
  aggregate.measurement_groups.cold_module_path.window.begins_at_or_after_delivery = false;
  aggregate.measurement_groups.cold_module_path.window.post_dates_delivery = false;
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, false);
  const hit = validation.refusals.find((row) => row.reason === "samples_predate_delivery");
  assert.ok(hit, JSON.stringify(validation.refusals));
  assert.equal(hit.measurement_group, "cold_module_path");
  assert.equal(hit.window_start, earlyStart);
});

test("non-vacuity: the landed shape passes and a group-removed copy fails", () => {
  const aggregate = wellFormedAggregate();
  assert.equal(validateNoticeReadbackAggregate(aggregate).ok, true);
  const thinned = withoutMeasurementGroup(cloneNoticeReadbackAggregate(aggregate), "first_byte");
  const validation = validateNoticeReadbackAggregate(thinned);
  assert.equal(validation.ok, false);
  assert.ok(validation.refusals.some((row) => (
    row.reason === "missing_measurement_group" && row.measurement_group === "first_byte"
  )));
});

test("the committed retained aggregate validates when present", () => {
  let document;
  try {
    document = JSON.parse(readFileSync(RETAINED, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      assert.fail(`retained aggregate missing at ${NOTICE_READBACK_RETAINED_PATH}`);
    }
    throw error;
  }
  const validation = validateNoticeReadbackAggregate(document);
  assert.equal(validation.ok, true, JSON.stringify(validation.refusals, null, 2));
  for (const name of NOTICE_READBACK_REQUIRED_GROUPS) {
    const group = document.measurement_groups[name];
    assert.equal(group.clears_sample_floor, true, name);
    assert.ok(
      group.metrics.every((metric) => metric.sampled_count >= NOTICE_READBACK_SAMPLE_FLOOR),
      name,
    );
  }
  const cache = document.record_cache_outcome_distribution;
  assert.ok(cache, "record_cache_outcome_distribution must be present");
  assert.ok(cache.state === "read" || cache.state === "unread", cache.state);
  assert.equal(
    cache.window.keyed_to_measurement_group,
    NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP,
  );
});

test("positive control: read-and-empty cache distribution satisfies the clause", () => {
  const aggregate = wellFormedAggregate({
    recordCacheOutcomeDistribution: wellFormedCacheDistribution({
      state: "read",
      outcomes: emptyRecordCacheOutcomeCounts(),
    }),
  });
  const cache = aggregate.record_cache_outcome_distribution;
  assert.equal(cache.state, "read");
  assert.equal(cache.sampled_count, 0);
  for (const name of NOTICE_READBACK_CACHE_OUTCOMES) {
    assert.equal(cache.outcomes[name], 0, name);
  }
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, true, JSON.stringify(validation.refusals));
});

test("positive control: unread cache distribution with a reason validates", () => {
  const aggregate = wellFormedAggregate({
    recordCacheOutcomeDistribution: wellFormedCacheDistribution({ state: "unread" }),
  });
  const cache = aggregate.record_cache_outcome_distribution;
  assert.equal(cache.state, "unread");
  assert.equal(cache.reason, NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON);
  assert.equal(cache.outcomes, undefined);
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, true, JSON.stringify(validation.refusals));
});

test("refusal: missing_record_cache_outcome_distribution names the absent field", () => {
  const aggregate = withoutRecordCacheOutcomeDistribution(wellFormedAggregate());
  assert.equal(
    Object.prototype.hasOwnProperty.call(aggregate, "record_cache_outcome_distribution"),
    false,
  );
  const validation = validateNoticeReadbackAggregate(aggregate);
  assert.equal(validation.ok, false);
  const hit = validation.refusals.find((row) => (
    row.reason === "missing_record_cache_outcome_distribution"
  ));
  assert.ok(hit, JSON.stringify(validation.refusals));
});

test("non-vacuity: missing cache field fails while read-and-empty passes", () => {
  const emptyRead = wellFormedAggregate({
    recordCacheOutcomeDistribution: wellFormedCacheDistribution({
      state: "read",
      outcomes: emptyRecordCacheOutcomeCounts(),
    }),
  });
  assert.equal(validateNoticeReadbackAggregate(emptyRead).ok, true);
  const missing = withoutRecordCacheOutcomeDistribution(cloneNoticeReadbackAggregate(emptyRead));
  const validation = validateNoticeReadbackAggregate(missing);
  assert.equal(validation.ok, false);
  assert.ok(validation.refusals.some((row) => (
    row.reason === "missing_record_cache_outcome_distribution"
  )));
});
