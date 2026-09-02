import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NOTICE_PRIMARY_COMPONENT_ID,
  NOTICE_PRIMARY_DEFERRED_OWNERS,
  NOTICE_PRIMARY_ESTIMATED_REDUCTION_MS,
  NOTICE_PRIMARY_METRIC_ID,
  NOTICE_PRIMARY_OWNERS,
  NOTICE_PRIMARY_SAMPLE_FLOOR,
  NOTICE_PRIMARY_SURFACE_ID,
  buildNoticePrimaryReadinessEvidence,
  compareNoticePrimaryReadiness,
  isNoticePrimaryDeferredOwner,
  projectNoticePrimaryReadiness,
  summarizeNoticePrimaryGroup,
  validateNoticePrimaryReadinessEvidence,
} from "../site/notice_primary_readiness.mjs";
import { createRumSemanticMilestones } from "../site/rum_semantic_milestones.mjs";
import { createBufferedSemanticMilestones } from "../site/rum_production.mjs";
import {
  noticePrimaryOutcomeFromEdge,
  noticePrimaryOwnerNow,
  noticePrimaryReady,
  noticePrimaryTimingMark,
} from "../site/rum_static_record_instrumentation.mjs";
import { build as buildEvidence } from "../tools/build_notice_primary_readiness_evidence.mjs";

const routingSource = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
const committed = JSON.parse(readFileSync(
  new URL("../docs/evidence/notice-primary-readiness/read-back.json", import.meta.url),
  "utf8",
));

function recorder() {
  const records = [];
  return { records, record: (value) => records.push(value) };
}

function primaryRow(overrides = {}) {
  return {
    metric_id: NOTICE_PRIMARY_METRIC_ID,
    surface_id: NOTICE_PRIMARY_SURFACE_ID,
    component_id: NOTICE_PRIMARY_COMPONENT_ID,
    result_state: "content",
    value: 100,
    device_class: "mobile",
    navigation_type: "navigate",
    delivery_class: "pages_edge",
    traffic_class: "lab",
    ...overrides,
  };
}

function sufficientRows(count, { value = 100, ...rest } = {}) {
  return Array.from({ length: count }, (_unused, index) => primaryRow({
    value: value + index,
    trace_key: `row-${rest.traffic_class || "lab"}-${value}-${index}`,
    ...rest,
  }));
}

// --- A1: the primary boundary does not wait on optional owners -------------

test("primary readiness records while every deferred owner is still pending", async () => {
  const sink = recorder();
  let clock = 96;
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => clock,
    record: sink.record,
  });

  // Deferred owners modelled as the route models them: started at the boundary,
  // settling only much later. None of them may gate the milestone.
  let settledCount = 0;
  const owners = NOTICE_PRIMARY_DEFERRED_OWNERS.map(() => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise: promise.then(() => { settledCount += 1; }), release };
  });
  const pending = Promise.allSettled(owners.map((owner) => owner.promise));

  assert.equal(noticePrimaryReady(rum, { resultState: "content" }, clock).state, "recorded");
  assert.equal(sink.records.length, 1, "the boundary reported without any deferred owner");
  assert.equal(settledCount, 0, "no deferred owner settled before the boundary");

  const [record] = sink.records;
  assert.equal(record.metric_id, NOTICE_PRIMARY_METRIC_ID);
  assert.equal(record.surface_id, NOTICE_PRIMARY_SURFACE_ID);
  assert.equal(record.component_id, NOTICE_PRIMARY_COMPONENT_ID);
  assert.equal(record.value, 96);
  assert.equal(record.result_state, "content");

  // Every deferred owner now completes, far later than the boundary.
  clock = 9000;
  for (const owner of owners) owner.release();
  await pending;
  assert.equal(settledCount, NOTICE_PRIMARY_DEFERRED_OWNERS.length);
  assert.equal(sink.records.length, 1, "deferred completion adds no readiness record");
  assert.equal(sink.records[0].value, 96, "deferred completion does not move content_ready_ms");
});

test("a deferred owner that settles later cannot redefine the primary timestamp", () => {
  const sink = recorder();
  let clock = 96;
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => clock,
    record: sink.record,
  });

  assert.equal(noticePrimaryReady(rum, { resultState: "content" }, 96).state, "recorded");
  // The client read finishes far later and re-reports; readiness is already owned.
  clock = 9000;
  assert.equal(noticePrimaryReady(rum, { resultState: "content" }, 9000).state, "duplicate");
  assert.equal(sink.records.length, 1);
  assert.equal(sink.records[0].value, 96, "late completion must not move content_ready_ms");
});

test("the owner clock survives a late collector install", () => {
  const runtime = { performance: { now: () => 7000 } };
  const buffer = createBufferedSemanticMilestones(runtime);
  // The owner read its own clock at the boundary, long before the reporter installs.
  assert.equal(noticePrimaryReady(buffer, { resultState: "content" }, 96).state, "buffered");

  const sink = recorder();
  const installed = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => 7000,
    record: sink.record,
  });
  assert.equal(buffer.drain(installed), 1);
  assert.equal(
    sink.records[0].value,
    96,
    "buffered replay must keep the owner-call timing, not the install time",
  );
});

// --- A2: honest terminal states --------------------------------------------

test("an edge failure is never rendered as a successful primary body", () => {
  assert.equal(noticePrimaryOutcomeFromEdge("notice"), "content");
  assert.equal(noticePrimaryOutcomeFromEdge("notice-unavailable"), "unavailable");
  for (const value of ["loading", "", null, undefined, "notice-error", "true"]) {
    assert.equal(
      noticePrimaryOutcomeFromEdge(value),
      null,
      "only a declared edge outcome is a readiness boundary",
    );
  }

  const sink = recorder();
  const rum = createRumSemanticMilestones({
    enabled: true,
    navigationStart: 0,
    now: () => 88,
    record: sink.record,
  });
  assert.equal(noticePrimaryReady(rum, { resultState: "unavailable" }, 88).state, "recorded");
  // A later optimistic "content" claim cannot overwrite an honest unavailable terminal.
  assert.equal(noticePrimaryReady(rum, { resultState: "content" }, 120).state, "duplicate");
  assert.deepEqual(sink.records.map((row) => row.result_state), ["unavailable"]);
});

test("the route binds the boundary to the seam and starts deferred owners after it", () => {
  const showNotice = routingSource.slice(routingSource.indexOf("async function showNotice"));
  const primary = showNotice.indexOf("noticePrimaryReady(runtimeRumSemanticMilestones()");
  const modules = showNotice.indexOf("globalThis.ensureMoneyHistory");
  const read = showNotice.indexOf('import("../notice-read.mjs")');
  assert.ok(primary >= 0);
  assert.ok(modules > primary, "optional route modules start after the primary boundary");
  assert.ok(read > primary, "the client notice read starts after the primary boundary");

  // Nothing may be awaited between route entry and the primary boundary.
  const preamble = showNotice.slice(0, primary);
  assert.doesNotMatch(preamble, /\bawait\b/, "the primary boundary must not sit behind an await");

  // The boundary reports the owner's own clock.
  assert.match(showNotice, /const edgePrimaryAt=noticePrimaryOwnerNow\(\)/);
  assert.match(showNotice, /noticePrimaryReady\(runtimeRumSemanticMilestones\(\),\{resultState:edgePrimaryState\},edgePrimaryAt\)/);
  assert.equal(
    showNotice.includes("await optionalRouteModules"),
    false,
    "deferred route modules cannot gate the Notice surface",
  );
});

test("Notice primary marks are bounded browser diagnostics, not RUM dimensions", () => {
  const marks = [];
  const original = globalThis.performance;
  globalThis.performance = { mark: (name) => marks.push(name) };
  try {
    assert.deepEqual(noticePrimaryTimingMark("edge-primary-ready"), { state: "recorded" });
    assert.deepEqual(noticePrimaryTimingMark("notice/20260701003"), { state: "invalid" });
    assert.equal(noticePrimaryOwnerNow({ performance: { now: () => 12 } }), 12);
    assert.equal(noticePrimaryOwnerNow({ performance: { now: () => -1 } }), null);
  } finally {
    globalThis.performance = original;
  }
  assert.deepEqual(marks, ["cityscroll.notice-primary.edge-primary-ready"]);
});

// --- A3: grouped read-back cannot pass an estimate off as a measurement -----

test("an undersized or incomplete window publishes no percentiles and no delta", () => {
  const group = summarizeNoticePrimaryGroup(sufficientRows(5), {
    label: "after",
    windowComplete: true,
  });
  assert.equal(group.sampled_count, 5);
  assert.equal(group.sufficiency, "insufficient_sample");
  assert.equal(group.p50_ms, null);
  assert.equal(group.p75_ms, null);
  assert.equal(group.p95_ms, null);

  const complete = summarizeNoticePrimaryGroup(sufficientRows(NOTICE_PRIMARY_SAMPLE_FLOOR), {
    label: "before",
    windowComplete: false,
  });
  assert.equal(complete.sufficiency, "insufficient_sample", "an incomplete window is never sufficient");
  assert.equal(complete.p75_ms, null);
});

test("a delta is published only from two sufficient, same-population groups", () => {
  const before = summarizeNoticePrimaryGroup(
    sufficientRows(NOTICE_PRIMARY_SAMPLE_FLOOR, { value: 4000 }),
    { label: "before", windowComplete: true },
  );
  const after = summarizeNoticePrimaryGroup(
    sufficientRows(NOTICE_PRIMARY_SAMPLE_FLOOR, { value: 100 }),
    { label: "after", windowComplete: true },
  );
  const measured = compareNoticePrimaryReadiness(before, after);
  assert.equal(measured.state, "measured");
  assert.equal(measured.population_matched, true);
  assert.equal(measured.measurement_class, "lab");
  assert.equal(measured.delta_p75_ms, 3900);

  // A different device population is not a comparison.
  const otherPopulation = summarizeNoticePrimaryGroup(
    sufficientRows(NOTICE_PRIMARY_SAMPLE_FLOOR, { value: 100, device_class: "desktop" }),
    { label: "after", windowComplete: true },
  );
  const mismatched = compareNoticePrimaryReadiness(before, otherPopulation);
  assert.equal(mismatched.state, "population_mismatch");
  assert.equal(mismatched.delta_p75_ms, null);
  assert.ok(mismatched.reason);

  // Lab and field are both evidence, but they are not each other.
  const field = summarizeNoticePrimaryGroup(
    sufficientRows(NOTICE_PRIMARY_SAMPLE_FLOOR, { value: 100, traffic_class: "production" }),
    { label: "after", windowComplete: true },
  );
  assert.equal(field.measurement_class, "field");
  assert.equal(compareNoticePrimaryReadiness(before, field).measurement_class, "mixed");
});

test("the register estimate can never be substituted for a measured receipt", () => {
  assert.equal(NOTICE_PRIMARY_ESTIMATED_REDUCTION_MS.measured, false);
  const evidence = projectNoticePrimaryReadiness({
    beforeObservations: sufficientRows(2, { value: 4000 }),
    afterObservations: sufficientRows(2, { value: 100 }),
  });
  assert.equal(evidence.comparison.state, "insufficient_sample");
  assert.equal(evidence.estimate.measured, false);
  assert.equal(validateNoticePrimaryReadinessEvidence(evidence).ok, true);

  // Filling the unmeasured delta with the estimated range is rejected.
  for (const value of [
    NOTICE_PRIMARY_ESTIMATED_REDUCTION_MS.low_ms,
    NOTICE_PRIMARY_ESTIMATED_REDUCTION_MS.high_ms,
  ]) {
    const forged = structuredClone(evidence);
    forged.comparison.delta_p75_ms = value;
    const result = validateNoticePrimaryReadinessEvidence(forged);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /estimated range cannot stand in/.test(error)));
  }

  // Presenting the estimate as measured is rejected.
  const claimed = structuredClone(evidence);
  claimed.estimate.measured = true;
  assert.equal(validateNoticePrimaryReadinessEvidence(claimed).ok, false);

  // The historical field baseline is never a result.
  const baselined = structuredClone(evidence);
  baselined.field_baseline = { source: "field-rum-readiness-2026-08-26", not_a_result: false };
  assert.equal(validateNoticePrimaryReadinessEvidence(baselined).ok, false);
});

test("a deferred owner cannot report itself as blocking primary readiness", () => {
  assert.deepEqual([...NOTICE_PRIMARY_DEFERRED_OWNERS], [
    "money-history",
    "rules",
    "notice-read",
    "attachment-metadata",
    "notice-context",
    "property-action-matter",
  ]);
  for (const owner of NOTICE_PRIMARY_DEFERRED_OWNERS) {
    assert.equal(isNoticePrimaryDeferredOwner(owner), true);
    const evidence = projectNoticePrimaryReadiness({
      ownerCallTiming: [{ trace: "cold", owner, called_at_ms: 1, blocking: true }],
    });
    const result = validateNoticePrimaryReadinessEvidence(evidence);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes(owner)));
  }
  for (const owner of NOTICE_PRIMARY_OWNERS) {
    assert.equal(isNoticePrimaryDeferredOwner(owner), false);
  }
});

test("an owner that never settled is recorded as absent, not as zero", () => {
  const evidence = projectNoticePrimaryReadiness({
    ownerCallTiming: [
      { trace: "cold", owner: "edge-primary-body", called_at_ms: 0, settled_at_ms: 96, blocking: true },
      { trace: "cold", owner: "money-history", called_at_ms: 97, settled_at_ms: null, blocking: false },
    ],
  });
  const [primary, deferred] = evidence.owner_call_timing;
  assert.equal(primary.settled_at_ms, 96);
  assert.equal(deferred.settled_at_ms, null, "never settled must not read as settled at 0 ms");
});

// --- committed evidence -----------------------------------------------------

test("the committed read-back matches its builder and stays honest", () => {
  assert.deepEqual(buildEvidence(), committed);
  assert.equal(committed.identity.new_rum_identity, false);
  assert.equal(committed.identity.metric_id, NOTICE_PRIMARY_METRIC_ID);
  assert.equal(committed.identity.surface_id, NOTICE_PRIMARY_SURFACE_ID);
  assert.equal(committed.identity.component_id, NOTICE_PRIMARY_COMPONENT_ID);
  assert.equal(committed.estimate.measured, false);
  assert.equal(committed.field_baseline.not_a_result, true);
  assert.equal(committed.field_baseline.predates_owner_boundary, true);
  // The field baseline is the measured 2026-08-26 Notice page distribution.
  assert.equal(committed.field_baseline.p50_ms, 2073.8);
  assert.equal(committed.field_baseline.p75_ms, 3798.1);
  assert.equal(committed.field_baseline.p95_ms, 8615.2);
  assert.equal(committed.field_baseline.sampled_count, 64);
  assert.equal(validateNoticePrimaryReadinessEvidence(committed).ok, true);
  assert.equal(
    committed.comparison.state,
    "insufficient_sample",
    "no field before/after window has been collected yet",
  );
  assert.equal(committed.comparison.delta_p75_ms, null);
  assert.doesNotThrow(() => buildNoticePrimaryReadinessEvidence({}));
});
