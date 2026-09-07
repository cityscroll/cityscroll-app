// Two measurement groups, kept apart by construction.
//
// The Notice surface retains about a third of a resident observation per day for
// its primary content-readiness group, so a 30-observation floor takes about
// ninety days to fill. A labelled synthetic group answers the engineering
// question sooner. These cases pin the part that makes that safe: the marker is
// set by the measuring client and never guessed, each group carries its own
// floor and its own anchor, every output says which group it is, and nothing
// pools the two into one distribution.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUM_MEASUREMENT_GROUPS,
  RUM_MEASUREMENT_GROUP_SCHEMA,
  compareMeasurementGroups,
  earliestRetainedObservation,
  measurementGroupForTrafficClass,
  measurementGroupNames,
  partitionRowsByMeasurementGroup,
  projectMeasurementGroupReadBack,
  resolveMeasurementGroup,
  validateMeasurementGroupReadBack,
} from "../tools/lib/rum_measurement_groups.mjs";
import {
  RUM_MARKED_TRAFFIC_CLASSES,
  RUM_RESIDENT_TRAFFIC_CLASS,
  RUM_TRAFFIC_CLASSES,
  resolveRumTrafficClass,
} from "../site/rum_production.mjs";
import { deliverRumBatch } from "../site/rum_delivery.mjs";
import {
  RUM_TRAFFIC_CLASSES as COLLECTOR_TRAFFIC_CLASSES,
  rumDataPoint,
} from "../worker/src/performance_events.mjs";

const ANCHOR = "2026-09-14T02:07:00.000Z";

function snapshot({
  start = "2026-09-14T02:07:00.000Z",
  end = "2026-09-21T02:07:00.000Z",
  status = "complete",
  trafficClass = "synthetic",
  sampledCount = 96,
  percentiles = { p50: 1800.44, p75: 2400.06, p95: 4100.5 },
  firstObservationAt = ANCHOR,
} = {}) {
  return {
    status: "available",
    query: { window: "7d", filters: { traffic_class: trafficClass }, group_by: ["metric_id", "surface_id"] },
    sample_floor: 30,
    retention: {
      current: {
        status,
        requested_start: start,
        requested_end: end,
        available_since: "2026-06-23T02:07:00.000Z",
      },
    },
    freshness: { queried_at: end },
    series: [{
      dimensions: { metric_id: "content_ready_ms", surface_id: "notice", component_id: "none" },
      current: {
        status: "available",
        sampled_count: sampledCount,
        estimated_count: sampledCount,
        percentiles,
      },
      first_observation_at: firstObservationAt,
      latest_observation_at: end,
    }],
  };
}

test("the marker is set by the measuring client and never inferred", () => {
  // No user agent, address, or other request property reaches this decision.
  assert.equal(resolveRumTrafficClass({}), RUM_RESIDENT_TRAFFIC_CLASS);
  assert.equal(resolveRumTrafficClass({ navigator: { userAgent: "HeadlessChrome" } }), RUM_RESIDENT_TRAFFIC_CLASS);
  assert.equal(resolveRumTrafficClass({ CROL_RUM_TRAFFIC_CLASS: "synthetic" }), "synthetic");
  assert.equal(resolveRumTrafficClass({ window: { CROL_RUM_TRAFFIC_CLASS: "lab" } }), "lab");
  // An unknown or misspelled value is resident traffic, not a new group.
  assert.equal(resolveRumTrafficClass({ CROL_RUM_TRAFFIC_CLASS: "syntetic" }), RUM_RESIDENT_TRAFFIC_CLASS);
  assert.equal(resolveRumTrafficClass({ CROL_RUM_TRAFFIC_CLASS: "production" }), RUM_RESIDENT_TRAFFIC_CLASS);
  // A page URL never carries the marker: the Notice route rewrites an
  // unrecognised hash and a query string changes the edge cache key.
  assert.equal(
    resolveRumTrafficClass({ location: { search: "?traffic_class=synthetic", hash: "#traffic_class=synthetic" } }),
    RUM_RESIDENT_TRAFFIC_CLASS,
  );
});

test("the marker survives the delivery leg as an explicit query flag", async () => {
  const requests = [];
  const runtime = {
    fetch(url, init) {
      requests.push({ url, init });
      return Promise.resolve({ ok: true });
    },
  };
  const batch = { schema: "cityscroll.rum.batch.v1", observations: [] };
  await deliverRumBatch(batch, { enabled: true, trafficClass: "synthetic", developerToken: "t", runtime });
  assert.equal(requests.at(-1).url, "https://api.cityscroll.org/performance-events?traffic_class=synthetic");

  await deliverRumBatch(batch, { enabled: true, trafficClass: "production", developerToken: "t", runtime });
  assert.equal(requests.at(-1).url, "https://api.cityscroll.org/performance-events");

  // An unknown class is never forwarded; the request falls back to the resident endpoint.
  await deliverRumBatch(batch, { enabled: true, trafficClass: "made-up", developerToken: "t", runtime });
  assert.equal(requests.at(-1).url, "https://api.cityscroll.org/performance-events");
});

test("the collector retains the marker on the observation it stores", () => {
  assert.deepEqual([...COLLECTOR_TRAFFIC_CLASSES], [...RUM_TRAFFIC_CLASSES]);
  assert.ok(RUM_TRAFFIC_CLASSES.includes("synthetic"));
  assert.deepEqual([...RUM_MARKED_TRAFFIC_CLASSES], ["lab", "synthetic"]);

  const observation = {
    schema: "cityscroll.performance_observation.v1",
    metricId: "content_ready_ms",
    surfaceId: "notice",
    componentId: "none",
    unit: "ms",
    deviceClass: "mobile",
    navigationType: "navigate",
    deliveryClass: "edge",
    resultState: "content",
    collectorVersion: "1",
    manifestVersion: "1",
    releaseId: "a".repeat(40),
    value: 1234,
    samplingIndex: "content_ready_ms|notice|none",
  };
  // blob10 is the retained traffic class the read-back partitions on.
  assert.equal(rumDataPoint(observation, "synthetic").blobs[9], "synthetic");
  assert.equal(rumDataPoint(observation).blobs[9], "production");
});

test("a group is resolved by name and by the traffic class it is retained under", () => {
  assert.deepEqual(measurementGroupNames().sort(), ["resident", "synthetic"]);
  assert.equal(resolveMeasurementGroup("synthetic").traffic_class, "synthetic");
  assert.equal(resolveMeasurementGroup("resident").traffic_class, "production");
  assert.equal(measurementGroupForTrafficClass("production"), "resident");
  assert.equal(measurementGroupForTrafficClass("synthetic"), "synthetic");
  // `lab` is a controlled generator, not one of the two groups this contract reads.
  assert.equal(measurementGroupForTrafficClass("lab"), null);
  assert.throws(() => resolveMeasurementGroup("everything"), /unknown measurement group/);
  // Both groups declare their own floor, and each says what it cannot claim.
  for (const group of Object.values(RUM_MEASUREMENT_GROUPS)) {
    assert.equal(group.sample_floor, 30);
    assert.ok(group.cannot_claim.length > 0);
  }
  assert.ok(RUM_MEASUREMENT_GROUPS.synthetic.cannot_claim.some((line) => /resident experience/.test(line)));
});

test("partitioning never folds an unrecognised marker into a group", () => {
  const partition = partitionRowsByMeasurementGroup([
    { traffic_class: "production", value: 1 },
    { traffic_class: "synthetic", value: 2 },
    { traffic_class: "lab", value: 3 },
    { traffic_class: "", value: 4 },
    null,
  ]);
  assert.deepEqual(partition.resident.map((row) => row.value), [1]);
  assert.deepEqual(partition.synthetic.map((row) => row.value), [2]);
  assert.equal(partition.unassigned.length, 3);
});

test("every row of a read-back carries its group label", () => {
  const document = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot() });
  assert.equal(document.schema, RUM_MEASUREMENT_GROUP_SCHEMA);
  assert.equal(document.measurement_group, "synthetic");
  assert.equal(document.label, "synthetic");
  assert.equal(document.traffic_class, "synthetic");
  assert.equal(document.combined_with_other_groups, false);
  assert.ok(/deployed surface/.test(document.measures));
  for (const row of document.groups) {
    assert.equal(row.measurement_group, "synthetic");
    assert.equal(row.label, "synthetic");
    assert.equal(row.traffic_class, "synthetic");
  }
  assert.deepEqual(validateMeasurementGroupReadBack(document), { ok: true, errors: [] });
});

test("a group publishes percentiles only above its own floor", () => {
  const sufficient = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot() });
  assert.equal(sufficient.groups[0].sufficiency, "sufficient");
  assert.deepEqual(
    [sufficient.groups[0].p50_ms, sufficient.groups[0].p75_ms, sufficient.groups[0].p95_ms],
    [1800.4, 2400.1, 4100.5],
  );

  const short = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot({ sampledCount: 29 }) });
  assert.equal(short.groups[0].sufficiency, "insufficient_sample");
  assert.equal(short.groups[0].p75_ms, null);
  assert.deepEqual(validateMeasurementGroupReadBack(short), { ok: true, errors: [] });

  // A group may set its own floor without touching the other group's.
  const raised = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot(), sampleFloor: 200 });
  assert.equal(raised.groups[0].sufficiency, "insufficient_sample");
  assert.equal(raised.sample_floor, 200);
  assert.equal(RUM_MEASUREMENT_GROUPS.resident.sample_floor, 30);
});

test("a group's window is anchored to that group and cannot borrow an earlier one", () => {
  const declared = projectMeasurementGroupReadBack({
    group: "synthetic",
    snapshot: snapshot({ start: "2026-09-15T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" }),
    anchor: ANCHOR,
  });
  assert.equal(declared.anchor.source, "declared");
  assert.equal(declared.anchor.kind, "first_probe_slot");
  assert.equal(declared.window.begins_at_or_after_anchor, true);
  assert.equal(declared.groups[0].sufficiency, "sufficient");

  // A window that opens before the first probe slot is not a synthetic window.
  const early = projectMeasurementGroupReadBack({
    group: "synthetic",
    snapshot: snapshot({ start: "2026-09-01T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" }),
    anchor: ANCHOR,
  });
  assert.equal(early.window.begins_at_or_after_anchor, false);
  assert.equal(early.groups[0].sufficiency, "window_precedes_anchor");
  assert.equal(early.groups[0].p75_ms, null);

  // Without a declared anchor the first retained observation is the anchor.
  const derived = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot() });
  assert.equal(derived.anchor.at, ANCHOR);
  assert.equal(derived.anchor.source, "first_retained_observation");

  // A group with nothing retained has no anchor and publishes nothing.
  const empty = projectMeasurementGroupReadBack({
    group: "synthetic",
    snapshot: snapshot({ firstObservationAt: null }),
  });
  assert.equal(empty.anchor.source, "unset");
  assert.equal(empty.groups[0].sufficiency, "anchor_unset");
  assert.equal(empty.groups[0].p95_ms, null);

  // The resident group anchors on its delivery merge, not the probe's first slot.
  const resident = projectMeasurementGroupReadBack({
    group: "resident",
    snapshot: snapshot({ trafficClass: "production" }),
  });
  assert.equal(resident.anchor.kind, "delivery_merge");
  assert.equal(resident.label, "resident");
});

test("an incomplete window withholds percentiles rather than rounding up", () => {
  const partial = projectMeasurementGroupReadBack({
    group: "synthetic",
    snapshot: snapshot({ status: "partial" }),
    anchor: ANCHOR,
  });
  assert.equal(partial.groups[0].sufficiency, "window_incomplete");
  assert.equal(partial.groups[0].p50_ms, null);
});

test("percentiles are never combined across the two groups", () => {
  const synthetic = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot() });
  const resident = projectMeasurementGroupReadBack({
    group: "resident",
    snapshot: snapshot({ trafficClass: "production" }),
  });
  const refused = compareMeasurementGroups(resident, synthetic);
  assert.equal(refused.state, "not_comparable");
  assert.match(refused.reason, /never combined across measurement groups/);
  assert.deepEqual(refused.groups, ["resident", "synthetic"]);

  assert.equal(compareMeasurementGroups(synthetic, synthetic).state, "comparable");
});

test("a read-back that lost its label or crossed its group fails validation", () => {
  const document = projectMeasurementGroupReadBack({ group: "synthetic", snapshot: snapshot() });
  assert.equal(validateMeasurementGroupReadBack({ ...document, label: "" }).ok, false);
  assert.equal(validateMeasurementGroupReadBack({ ...document, combined_with_other_groups: true }).ok, false);
  assert.equal(validateMeasurementGroupReadBack({ ...document, read_traffic_class: "production" }).ok, false);
  const leaked = {
    ...document,
    groups: [{ ...document.groups[0], sufficiency: "insufficient_sample" }],
  };
  assert.equal(validateMeasurementGroupReadBack(leaked).ok, false);
});

test("the earliest retained observation is read across every series", () => {
  assert.equal(earliestRetainedObservation(snapshot()), ANCHOR);
  assert.equal(earliestRetainedObservation({ series: [] }), null);
  assert.equal(earliestRetainedObservation(null), null);
});
