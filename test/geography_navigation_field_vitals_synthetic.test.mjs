import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyProbeSlot,
  assertResidentNearYouHonesty,
  assertSyntheticAggregateRetainsPending,
  buildBackFilledSlotProvenance,
  buildSlotLedgerEntry,
  canonicalizeForDigest,
  classifySyntheticCell,
  classifySyntheticProbeState,
  digestArtifactBytes,
  digestSlotLedgerValues,
  emptySyntheticAggregate,
  findForbiddenCrossGroupKeys,
  foldPendingSyntheticAggregate,
  loadPendingSyntheticAggregate,
  normalizeSyntheticAggregate,
  readSyntheticAggregate,
  retainedSlotsDropped,
  sha256Digest,
  slotRetainedObservation,
  slotValuesWithoutProvenance,
  syntheticGroupDelivery,
  verifyBackFilledSlotAgainstArtifact,
  withSlotProvenance,
} from "../tools/lib/geography_navigation_field_vitals_synthetic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGGREGATE_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-synthetic-aggregate.json",
);
const RESIDENT_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-observation.json",
);
const FIXTURE_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/fixtures/near-you-synthetic-probe-slot-36943164756.json",
);
const PAGES_PATH = join(ROOT, "data/performance/near-you-synthetic-probe.json");
const PROBE = join(ROOT, "tools/run_near_you_synthetic_probe.py");
const WORKFLOW = join(ROOT, ".github/workflows/near-you-synthetic-probe.yml");
const BUILD_COMMAND = "tools/build_geography_navigation_field_vitals_synthetic.mjs";
const PROBE_COMMAND = "tools/run_near_you_synthetic_probe.py";

test("probe plan covers desktop and mobile and requires interaction for INP", () => {
  const pages = JSON.parse(readFileSync(PAGES_PATH, "utf8"));
  assert.equal(pages.traffic_class, "synthetic");
  assert.deepEqual(
    pages.device_profiles.map((profile) => profile.device_class).sort(),
    ["desktop", "mobile"],
  );
  assert.equal(pages.visit_policy.interaction.required, true);
  assert.ok(pages.visit_policy.interaction.preferred_selectors.includes("#near-geo-search-input"));
  assert.ok(pages.visit_policy.flush_wait_ms >= 6000, "flush wait must outlast idle beacon delivery");
  assert.ok(pages.visit_policy.settle_ms >= 12000, "settle must follow load under the fixed 4G throttle");

  const probeSource = readFileSync(PROBE, "utf8");
  assert.match(probeSource, /wait_for_load_state\("load"/);
  assert.match(probeSource, /flush_rum_beacons/);
  assert.match(probeSource, /pagehide/);
  assert.match(probeSource, /empty_collection/);

  const plan = spawnSync("python3", [PROBE, "--plan", "--pages", PAGES_PATH], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  const body = JSON.parse(plan.stdout);
  assert.equal(body.traffic_class, "synthetic");
  assert.equal(body.marker.value, "synthetic");
  assert.equal(body.marker.carried_on_page_url, false);
  const classes = body.visits.map((visit) => visit.device_class).sort();
  assert.deepEqual(classes, ["desktop", "mobile"]);
  assert.ok(body.visits.every((visit) => visit.interaction_required === true));
});

test("retained aggregate records scheduled run 36943164756 as an empty slot with a reason", () => {
  const document = JSON.parse(readFileSync(AGGREGATE_PATH, "utf8"));
  assert.equal(document.probe_state, "ran_empty");
  assert.equal(document.delivery.at, null);
  assert.equal(document.delivery.source, "unset");
  const entry = document.slots.find((row) => row.slot_id === "github-actions:36943164756:1");
  assert.ok(entry, "retrospective slot for run 36943164756 must be present");
  assert.equal(entry.run_id, "36943164756");
  assert.equal(entry.trigger, "schedule");
  assert.equal(entry.outcome.retained, false);
  assert.equal(entry.outcome.stages.reached, true);
  assert.equal(entry.outcome.stages.collected, false);
  assert.equal(entry.outcome.stages.wrote, true);
  assert.equal(entry.outcome.reason, "reached_but_no_beacons");
  assert.equal(entry.observations_emitted, 0);
});

test("back-filled slot names its workflow artifact and carries digests recomputed from that artifact", () => {
  const document = JSON.parse(readFileSync(AGGREGATE_PATH, "utf8"));
  const entry = document.slots.find((row) => row.slot_id === "github-actions:36943164756:1");
  assert.ok(entry, "back-filled slot must be present");
  const provenance = entry.provenance;
  assert.ok(provenance, "back-filled entry must carry provenance");
  assert.equal(provenance.writing, "back_filled");
  assert.equal(provenance.verifiable, true);
  assert.equal(provenance.unverifiable_reason, null);
  assert.equal(provenance.artifact.kind, "github_actions_workflow_artifact");
  assert.equal(provenance.artifact.repository, "cityscroll/cityscroll-app");
  assert.equal(provenance.artifact.run_id, "36943164756");
  assert.equal(provenance.artifact.run_attempt, "1");
  assert.equal(provenance.artifact.artifact_id, "11200568291");
  assert.equal(provenance.artifact.artifact_name, "near-you-synthetic-probe-slot");
  assert.equal(provenance.artifact.member_path, "slot.json");
  assert.match(provenance.artifact_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(provenance.values_sha256, /^sha256:[0-9a-f]{64}$/);

  // Positive control: the committed fixture is the exact artifact member; recomputing
  // both digests from it reproduces the retained provenance exactly.
  const artifactBytes = readFileSync(FIXTURE_PATH);
  const artifactJson = JSON.parse(artifactBytes.toString("utf8"));
  assert.equal(digestArtifactBytes(artifactBytes), provenance.artifact_sha256);
  const expectedValues = buildSlotLedgerEntry(artifactJson);
  assert.equal(digestSlotLedgerValues(expectedValues), provenance.values_sha256);
  const verified = verifyBackFilledSlotAgainstArtifact(entry, artifactBytes, artifactJson);
  assert.equal(verified.ok, true, verified.reason);
});

test("natively written slots omit the back-filled marker; core shape matches apart from provenance", () => {
  const aggregate = emptySyntheticAggregate();
  const nativeSlot = {
    run_key: "github-actions:native-test:1",
    github_run_id: "native-test",
    github_run_attempt: "1",
    trigger: "workflow_dispatch",
    observed_at: "2026-10-02T00:00:00.000Z",
    pages_listed: 2,
    pages_visited: 2,
    observations_emitted: 0,
    retained_observation_count: 0,
    marked_beacons: 0,
    unmarked_beacons: 0,
    status: "healthy",
    failures: [],
  };
  const withNative = applyProbeSlot(aggregate, nativeSlot);
  const nativeEntry = withNative.slots[0];
  assert.equal(Object.hasOwn(nativeEntry, "provenance"), false);

  const artifactBytes = readFileSync(FIXTURE_PATH);
  const artifactJson = JSON.parse(artifactBytes.toString("utf8"));
  const provenance = buildBackFilledSlotProvenance({
    artifactId: "11200568291",
    artifactName: "near-you-synthetic-probe-slot",
    runId: "36943164756",
    runAttempt: "1",
    artifactSha256: digestArtifactBytes(artifactBytes),
    valuesSha256: digestSlotLedgerValues(buildSlotLedgerEntry(artifactJson)),
    retrievedAt: "2026-10-02T04:30:00Z",
    expiresAt: "2026-12-30T23:53:16Z",
  });
  const withBackFill = applyProbeSlot(emptySyntheticAggregate(), artifactJson, { provenance });
  const backFilledEntry = withBackFill.slots[0];
  assert.equal(backFilledEntry.provenance.writing, "back_filled");

  // Byte-identical core shape: same keys once provenance is stripped.
  assert.deepEqual(
    Object.keys(slotValuesWithoutProvenance(backFilledEntry)).sort(),
    Object.keys(nativeEntry).sort(),
  );
  assert.deepEqual(
    Object.keys(nativeEntry).sort(),
    Object.keys(buildSlotLedgerEntry(nativeSlot)).sort(),
  );
});

test("mutating a back-filled value without updating the digest is detectable", () => {
  const artifactBytes = readFileSync(FIXTURE_PATH);
  const artifactJson = JSON.parse(artifactBytes.toString("utf8"));
  const baseEntry = buildSlotLedgerEntry(artifactJson);
  const provenance = buildBackFilledSlotProvenance({
    artifactId: "11200568291",
    artifactName: "near-you-synthetic-probe-slot",
    runId: "36943164756",
    runAttempt: "1",
    artifactSha256: digestArtifactBytes(artifactBytes),
    valuesSha256: digestSlotLedgerValues(baseEntry),
    retrievedAt: "2026-10-02T04:30:00Z",
    expiresAt: "2026-12-30T23:53:16Z",
  });
  const honest = withSlotProvenance(baseEntry, provenance);
  assert.equal(verifyBackFilledSlotAgainstArtifact(honest, artifactBytes, artifactJson).ok, true);

  const mutated = {
    ...honest,
    observations_emitted: 99,
    provenance: { ...honest.provenance },
  };
  const result = verifyBackFilledSlotAgainstArtifact(mutated, artifactBytes, artifactJson);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "entry_values_mutated");

  // Positive control: updating the digest alongside the value still fails against the artifact.
  const forged = {
    ...mutated,
    provenance: {
      ...mutated.provenance,
      values_sha256: digestSlotLedgerValues(slotValuesWithoutProvenance(mutated)),
    },
  };
  const forgedResult = verifyBackFilledSlotAgainstArtifact(forged, artifactBytes, artifactJson);
  assert.equal(forgedResult.ok, false);
  assert.equal(forgedResult.reason, "values_digest_mismatch");
});

test("expired-artifact back-fill records unverifiable instead of a self-digest", () => {
  const unverifiable = buildBackFilledSlotProvenance({
    artifactId: "11200568291",
    artifactName: "near-you-synthetic-probe-slot",
    runId: "36943164756",
    runAttempt: "1",
    verifiable: false,
    unverifiableReason: "workflow_artifact_expired",
    expiresAt: "2026-01-01T00:00:00Z",
    retrievedAt: null,
  });
  assert.equal(unverifiable.writing, "back_filled");
  assert.equal(unverifiable.verifiable, false);
  assert.equal(unverifiable.unverifiable_reason, "workflow_artifact_expired");
  assert.equal(unverifiable.artifact_sha256, null);
  assert.equal(unverifiable.values_sha256, null);

  const entry = withSlotProvenance(buildSlotLedgerEntry(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))), unverifiable);
  // A self-digest of the full entry must never be accepted as proof.
  const selfDigest = sha256Digest(canonicalizeForDigest(entry));
  assert.notEqual(unverifiable.values_sha256, selfDigest);
  const result = verifyBackFilledSlotAgainstArtifact(entry, readFileSync(FIXTURE_PATH));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "recorded_unverifiable");
});

test("delivery records first_probe_slot with null merge_commit, pull_request, and trigger (present, not absent)", () => {
  const delivery = syntheticGroupDelivery();
  assert.equal(delivery.kind, "first_probe_slot");
  assert.equal(Object.hasOwn(delivery, "merge_commit"), true);
  assert.equal(Object.hasOwn(delivery, "pull_request"), true);
  assert.equal(Object.hasOwn(delivery, "trigger"), true);
  assert.equal(delivery.merge_commit, null);
  assert.equal(delivery.pull_request, null);
  assert.equal(delivery.trigger, null);
  assert.equal(delivery.at, null);
});

test("the scheduled workflow references the probe and the --from-slot build step", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.ok(workflow.includes(PROBE_COMMAND), "workflow must invoke the Near You synthetic probe");
  assert.ok(workflow.includes(BUILD_COMMAND), "workflow must invoke the synthetic aggregate builder");
  assert.match(workflow, /--from-slot/, "workflow must apply slots through the existing builder");
  assert.match(workflow, /--pending-aggregate/, "workflow must fold any still-open automation-branch aggregate");
  assert.match(workflow, /pending-aggregate\.json/, "workflow must capture the unmerged aggregate tip");
  assert.match(workflow, /GITHUB_EVENT_NAME/, "trigger must be captured at run time");
  assert.match(workflow, /slot\.trigger/, "captured trigger must be written onto the slot");
  assert.match(workflow, /peter-evans\/create-pull-request/);
  assert.match(workflow, /automation\/near-you-synthetic-probe/);

  // Positive controls: the Notice probe is a different surface; this job must
  // not re-init the aggregate and wipe retained slots.
  assert.equal(workflow.includes("tools/run_notice_synthetic_probe.py"), false);
  assert.ok(!workflow.includes("--init"), "workflow must not re-init the aggregate");
});

test("below-floor cell withholds percentile; zero observations are no_data", () => {
  const below = classifySyntheticCell({
    metric_id: "lcp_ms",
    device_class: "desktop",
    sampled_count: 4,
  });
  assert.equal(below.status, "insufficient_sample");
  assert.equal(below.sampled_count, 4);
  assert.equal(below.quantile_value, null);
  assert.equal(below.percentile_withheld, true);

  const empty = classifySyntheticCell({
    metric_id: "inp_ms",
    device_class: "mobile",
    sampled_count: 0,
  });
  assert.equal(empty.status, "no_data");
  assert.equal(empty.sampled_count, 0);
  assert.notEqual(empty.status, below.status);
});

test("retained aggregate has no combined/overall/total cross-group keys", () => {
  const document = JSON.parse(readFileSync(AGGREGATE_PATH, "utf8"));
  const forbidden = findForbiddenCrossGroupKeys(document);
  assert.deepEqual(forbidden, []);
  assert.equal(document.combined_with_other_groups, false);
  assert.equal(document.measurement_group, "synthetic");
  assert.ok(!("overall" in document));
  assert.ok(!("total" in document));
  assert.ok(!("combined" in document));
});

test("three probe states are separable from the file alone: never_run, ran_empty, ran_retained", () => {
  const neverRun = emptySyntheticAggregate();
  assert.equal(neverRun.probe_state, "never_run");
  assert.equal(classifySyntheticProbeState(neverRun), "never_run");
  assert.equal(neverRun.slots.length, 0);
  assert.equal(neverRun.delivery.at, null);

  const emptySlot = {
    run_key: "slot-empty-a",
    observed_at: "2026-10-01T12:00:00.000Z",
    trigger: "schedule",
    pages_visited: 2,
    pages_listed: 2,
    observations_emitted: 0,
    retained_observation_count: 0,
    marked_beacons: 0,
    unmarked_beacons: 0,
    visits: [
      { path: "/near-you", device_class: "desktop", http_status: 200 },
      { path: "/near-you", device_class: "mobile", http_status: 200 },
    ],
    failures: [],
  };
  let ranEmpty = applyProbeSlot(emptySyntheticAggregate(), emptySlot);
  assert.equal(ranEmpty.probe_state, "ran_empty");
  assert.equal(classifySyntheticProbeState(ranEmpty), "ran_empty");
  assert.equal(ranEmpty.delivery.at, null);
  assert.equal(ranEmpty.slots.length, 1);
  assert.equal(ranEmpty.slots[0].outcome.retained, false);
  assert.equal(ranEmpty.slots[0].outcome.stages.reached, true);
  assert.equal(ranEmpty.slots[0].outcome.stages.collected, false);
  assert.equal(ranEmpty.slots[0].outcome.stages.wrote, true);
  assert.equal(ranEmpty.slots[0].outcome.reason, "reached_but_no_beacons");
  assert.ok(ranEmpty.updated_at);
  // A second empty slot appends; updated_at is never the only field that changes.
  const beforeKeys = JSON.stringify(Object.keys(ranEmpty).sort());
  ranEmpty = applyProbeSlot(ranEmpty, {
    ...emptySlot,
    run_key: "slot-empty-b",
    observed_at: "2026-10-01T12:30:00.000Z",
  });
  assert.equal(ranEmpty.slots.length, 2);
  assert.equal(ranEmpty.probe_state, "ran_empty");
  assert.equal(beforeKeys, JSON.stringify(Object.keys(ranEmpty).sort()));

  const retainingSlot = {
    run_key: "slot-retain-1",
    observed_at: "2026-10-01T13:00:00.000Z",
    trigger: "schedule",
    pages_visited: 2,
    pages_listed: 2,
    observations_emitted: 6,
    retained_observation_count: 6,
    marked_beacons: 2,
    cells: [
      { metric_id: "lcp_ms", device_class: "desktop", sampled_count: 1 },
      { metric_id: "lcp_ms", device_class: "mobile", sampled_count: 1 },
      { metric_id: "inp_ms", device_class: "desktop", sampled_count: 1 },
      { metric_id: "inp_ms", device_class: "mobile", sampled_count: 1 },
      { metric_id: "cls_score", device_class: "desktop", sampled_count: 1 },
      { metric_id: "cls_score", device_class: "mobile", sampled_count: 1 },
    ],
  };
  const ranRetained = applyProbeSlot(emptySyntheticAggregate(), retainingSlot);
  assert.equal(ranRetained.probe_state, "ran_retained");
  assert.equal(classifySyntheticProbeState(ranRetained), "ran_retained");
  assert.equal(ranRetained.delivery.at, "2026-10-01T13:00:00.000Z");
  assert.equal(ranRetained.slots[0].outcome.retained, true);
  assert.equal(ranRetained.slots[0].outcome.reason, "retained_observations");
  assert.notEqual(neverRun.probe_state, ranEmpty.probe_state);
  assert.notEqual(ranEmpty.probe_state, ranRetained.probe_state);
  assert.notEqual(neverRun.probe_state, ranRetained.probe_state);
});

test("mutation control: empty slot does not set delivery; first retaining slot does", () => {
  let aggregate = emptySyntheticAggregate();
  assert.equal(aggregate.delivery.at, null);
  assert.equal(aggregate.probe_state, "never_run");

  const emptySlot = {
    run_key: "slot-empty",
    observed_at: "2026-10-01T12:00:00.000Z",
    trigger: "schedule",
    pages_visited: 2,
    observations_emitted: 0,
    retained_observation_count: 0,
    marked_beacons: 0,
  };
  assert.equal(slotRetainedObservation(emptySlot), false);
  aggregate = applyProbeSlot(aggregate, emptySlot);
  assert.equal(aggregate.delivery.at, null);
  assert.equal(aggregate.delivery.merge_commit, null);
  assert.equal(aggregate.delivery.pull_request, null);
  assert.equal(aggregate.probe_state, "ran_empty");
  assert.equal(aggregate.slots.length, 1);
  assert.equal(aggregate.slots[0].slot_id, "slot-empty");
  assert.equal(aggregate.slots[0].outcome.retained, false);

  const retainingSlot = {
    run_key: "slot-retain-1",
    observed_at: "2026-10-01T13:00:00.000Z",
    trigger: "schedule",
    observations_emitted: 6,
    retained_observation_count: 6,
    cells: [
      { metric_id: "lcp_ms", device_class: "desktop", sampled_count: 1 },
      { metric_id: "lcp_ms", device_class: "mobile", sampled_count: 1 },
      { metric_id: "inp_ms", device_class: "desktop", sampled_count: 1 },
      { metric_id: "inp_ms", device_class: "mobile", sampled_count: 1 },
      { metric_id: "cls_score", device_class: "desktop", sampled_count: 1 },
      { metric_id: "cls_score", device_class: "mobile", sampled_count: 1 },
    ],
  };
  assert.equal(slotRetainedObservation(retainingSlot), true);
  aggregate = applyProbeSlot(aggregate, retainingSlot);
  assert.equal(aggregate.delivery.at, "2026-10-01T13:00:00.000Z");
  assert.equal(aggregate.delivery.slot_id, "slot-retain-1");
  assert.equal(aggregate.delivery.trigger, "schedule");
  assert.equal(aggregate.delivery.merge_commit, null);
  assert.equal(aggregate.delivery.pull_request, null);
  assert.equal(aggregate.delivery.kind, "first_probe_slot");
  assert.equal(aggregate.probe_state, "ran_retained");
  assert.equal(aggregate.slots.length, 2);
  assert.equal(
    aggregate.cells.find((cell) => cell.metric_id === "lcp_ms" && cell.device_class === "desktop")
      .sampled_count,
    1,
  );

  // A later retaining slot must not move the first-slot anchor or its trigger.
  aggregate = applyProbeSlot(aggregate, {
    ...retainingSlot,
    run_key: "slot-retain-2",
    observed_at: "2026-10-01T14:00:00.000Z",
    trigger: "workflow_dispatch",
  });
  assert.equal(aggregate.delivery.at, "2026-10-01T13:00:00.000Z");
  assert.equal(aggregate.delivery.slot_id, "slot-retain-1");
  assert.equal(aggregate.delivery.trigger, "schedule");
  assert.equal(aggregate.slots.length, 3);
});

test("legacy aggregates without slots normalize instead of failing the reader path", () => {
  const legacy = emptySyntheticAggregate();
  delete legacy.slots;
  delete legacy.probe_state;
  legacy.updated_at = "2026-10-01T23:54:23Z";
  const normalized = normalizeSyntheticAggregate(legacy);
  assert.deepEqual(normalized.slots, []);
  assert.equal(normalized.probe_state, "never_run");
  assert.equal(readSyntheticAggregate(normalized).ok, true);
});

test("reader refuses missing required per-cell field and names it; absent vs unread", () => {
  assert.equal(readSyntheticAggregate(null).state, "absent");
  assert.equal(readSyntheticAggregate("not-json-object").state, "unread");

  const document = emptySyntheticAggregate();
  delete document.cells[0].sampled_count;
  const refused = readSyntheticAggregate(document);
  assert.equal(refused.ok, false);
  assert.equal(refused.missing_field, "cells[0].sampled_count");

  const ok = readSyntheticAggregate(emptySyntheticAggregate());
  assert.equal(ok.ok, true);
});

test("retained synthetic aggregate validates; delivery nulls are explicit", () => {
  const document = JSON.parse(readFileSync(AGGREGATE_PATH, "utf8"));
  const read = readSyntheticAggregate(document);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(Object.hasOwn(document.delivery, "merge_commit"), true);
  assert.equal(Object.hasOwn(document.delivery, "pull_request"), true);
  assert.equal(Object.hasOwn(document.delivery, "trigger"), true);
  assert.equal(document.delivery.merge_commit, null);
  assert.equal(document.delivery.pull_request, null);
  assert.equal(document.delivery.trigger, null);
  assert.equal(document.cells.length, 6);
});

test("resident near-you honesty survives (acceptance 7)", () => {
  const resident = JSON.parse(readFileSync(RESIDENT_PATH, "utf8"));
  assert.equal(assertResidentNearYouHonesty(resident), true);
});

test("overlapping runs fold the open automation-branch aggregate and refuse a silent slot drop", () => {
  const retainingCells = [
    { metric_id: "lcp_ms", device_class: "desktop", sampled_count: 2 },
    { metric_id: "lcp_ms", device_class: "mobile", sampled_count: 2 },
    { metric_id: "inp_ms", device_class: "desktop", sampled_count: 2 },
    { metric_id: "inp_ms", device_class: "mobile", sampled_count: 2 },
    { metric_id: "cls_score", device_class: "desktop", sampled_count: 2 },
    { metric_id: "cls_score", device_class: "mobile", sampled_count: 2 },
  ];
  const firstSlot = {
    run_key: "github-actions:111:1",
    observed_at: "2026-10-01T02:17:00.000Z",
    trigger: "schedule",
    observations_emitted: 6,
    retained_observation_count: 6,
    cells: retainingCells,
  };
  const secondSlot = {
    run_key: "github-actions:222:1",
    observed_at: "2026-10-01T08:17:00.000Z",
    trigger: "schedule",
    observations_emitted: 6,
    retained_observation_count: 6,
    cells: retainingCells.map((cell) => ({ ...cell, sampled_count: 3 })),
  };

  // First scheduled run retains on the automation branch; main is still empty.
  const pending = applyProbeSlot(emptySyntheticAggregate(), firstSlot);
  assert.equal(pending.delivery.slot_id, "github-actions:111:1");
  const pendingText = `${JSON.stringify(pending, null, 2)}\n`;
  const loaded = loadPendingSyntheticAggregate(pendingText);
  assert.equal(loaded.delivery.slot_id, "github-actions:111:1");

  // Without folding the pending tip, a later run that rebuilds from main alone
  // would publish only the second slot — the lost-update this guard closes.
  const naive = applyProbeSlot(emptySyntheticAggregate(), secondSlot);
  assert.equal(naive.delivery.slot_id, "github-actions:222:1");
  assert.deepEqual(
    retainedSlotsDropped(pending, naive).map((entry) => entry.slot_id),
    ["github-actions:111:1"],
  );
  assert.throws(
    () => assertSyntheticAggregateRetainsPending(pending, naive),
    /would drop retained slot\(s\): github-actions:111:1 \(schedule, 2026-10-01T02:17:00\.000Z\)/,
  );

  // Folding the open-branch aggregate before applying the new slot keeps the
  // first retaining delivery and lets the later slot update cells.
  const folded = foldPendingSyntheticAggregate(emptySyntheticAggregate(), pending);
  assert.equal(folded.delivery.slot_id, "github-actions:111:1");
  const carried = applyProbeSlot(folded, secondSlot);
  assertSyntheticAggregateRetainsPending(pending, carried);
  assert.deepEqual(retainedSlotsDropped(pending, carried), []);
  assert.equal(carried.delivery.slot_id, "github-actions:111:1");
  assert.equal(carried.delivery.at, "2026-10-01T02:17:00.000Z");
  assert.equal(carried.delivery.trigger, "schedule");
  assert.equal(
    carried.cells.find((cell) => cell.metric_id === "lcp_ms" && cell.device_class === "desktop")
      .sampled_count,
    3,
  );
});
