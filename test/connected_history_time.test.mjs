/**
 * Fixed-dossier temporal-state verification.
 *
 *   node --test test/connected_history_time.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CIVIC_TIME_LEDGER_CASE_FAMILIES,
} from "../site/civic_time_ledger.mjs";
import {
  CIVIC_TIME_COMPOSED_GRAPH_CASE_FAMILIES,
  projectCivicTimeComposedGraphAsOf,
} from "../site/civic_time_composed_graph.mjs";
import {
  CONNECTED_HISTORY_COMPARABLE_SCOPE_KEYS,
  CONNECTED_HISTORY_FACT_FAMILIES,
  CONNECTED_HISTORY_TIME_CASE_FAMILY,
  compareConnectedHistoryNumericFacts,
  compareConnectedHistoryStates,
  normalizeConnectedHistoryDate,
  normalizeConnectedHistoryObservation,
  orderConnectedHistoryEntries,
  projectConnectedHistoryStateAsOf,
} from "../site/connected_history_time.mjs";
import {
  CONNECTED_HISTORY_TIME_DOSSIER_FAMILIES,
  CONNECTED_HISTORY_TIME_OBSERVATIONS,
  CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS,
  CONNECTED_HISTORY_TIME_SOURCE_POLICY,
  buildConnectedHistoryTimeArtifact,
  buildConnectedHistoryTimeReceipt,
  checkConnectedHistorySourceJudgment,
  materializeConnectedHistoryTime,
  reportConnectedHistoryTimeKindPopulation,
  verifyConnectedHistoryTimeArtifact,
} from "../tools/lib/connected_history_time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(readFileSync(join(ROOT, "site/data/connected_history_time.json"), "utf8"));
const retainedRelations = JSON.parse(readFileSync(
  join(ROOT, "site/data/connected_history_relations.json"),
  "utf8",
));
const committedReceipt = JSON.parse(readFileSync(
  join(ROOT, "site/data/connected_history_sources/verification_receipts/connected_history_time_latest.json"),
  "utf8",
));

const byPair = (id) => {
  const pair = committed.query_pairs.find((row) => row.id === id);
  assert.ok(pair, id);
  assert.equal(pair.evidence_class, "module_oracle");
  return pair;
};

function sourceJudgment(recordId = "fixture:source") {
  return {
    judgment_basis: "synthetic_test_mutation",
    source_system: "test-fixture",
    source_record_id: recordId,
    source_span: { locator: "fixture", quote: "bounded synthetic mutation" },
  };
}

function syntheticObservation(overrides = {}) {
  return {
    case_family: CONNECTED_HISTORY_TIME_CASE_FAMILY,
    observation_id: "synthetic-v1",
    family_id: "synthetic-test-family",
    history_family: "component_phase_history",
    subject_ref: "test:subject:one",
    assertion_key: "status",
    comparison_key: "status",
    fact_kind: "component_status",
    event_class: "planned",
    change_kind: "civic_event",
    lifecycle_action: "proposed",
    event_time: { value: "2020-01-01", precision: "day" },
    observed_at: "2021-01-01T00:00:00.000Z",
    value: { status: "planned" },
    scope: {},
    source_judgment: sourceJudgment(),
    ...overrides,
  };
}

test("A1: shared ledger admits explicit connected-history families and rejects unknown families", () => {
  assert.ok(CIVIC_TIME_LEDGER_CASE_FAMILIES.includes("procurement_notice"));
  assert.ok(CIVIC_TIME_LEDGER_CASE_FAMILIES.includes(CONNECTED_HISTORY_TIME_CASE_FAMILY));
  assert.deepEqual([...CONNECTED_HISTORY_FACT_FAMILIES].sort(), [
    "component_phase_history",
    "corridor_measurement_history",
    "environmental_review_history",
    "land_application_history",
  ]);

  // Positive control: an admitted family normalizes.
  assert.equal(normalizeConnectedHistoryObservation(syntheticObservation()).history_family, "component_phase_history");
  // Converse control: the same record under an unregistered family fails closed.
  assert.throws(
    () => normalizeConnectedHistoryObservation(syntheticObservation({ history_family: "convenient_example" })),
    /unsupported connected history family/,
  );
});

test("A1: Franklin states retain proposal epochs, withdrawal, amendment, and distinct identities", () => {
  const pair = byPair("franklin-proposal-epochs");
  assert.deepEqual(
    pair.before.entries.map((row) => row.observation_id).sort(),
    ["franklin-earlier-proposal-2021", "franklin-earlier-withdrawal-2021"],
  );
  assert.deepEqual(
    pair.after.entries.map((row) => row.observation_id).sort(),
    [
      "franklin-earlier-proposal-2021",
      "franklin-earlier-withdrawal-2021",
      "franklin-later-amendment-2024",
      "franklin-later-proposal-2024",
    ],
  );
  const applications = pair.after.entries.flatMap((row) => row.value.application_ids || [row.value.application_id]).filter(Boolean);
  assert.ok(applications.includes("C200184ZMK"));
  assert.ok(applications.includes("C230356ZMK"));
  assert.ok(applications.includes("N230357(A)ZRK"));
  assert.ok(pair.after.entries.some((row) => row.lifecycle_action === "withdrawn"));
  assert.ok(pair.after.entries.some((row) => row.lifecycle_action === "amended"));
  assert.ok(pair.after.entries.every((row) => row.value.identity_merged !== true));
  assert.equal(pair.comparison.counts.knowledge_changes, 0);
  assert.ok(pair.comparison.counts.civic_changes >= 1);
});

test("A1: Kingsbridge proposal epochs keep the 2018 date as a forecast", () => {
  const pair = byPair("kingsbridge-proposal-epochs");
  const chronological = pair.after.entries.map((row) => row.event_time.start);
  assert.deepEqual(chronological, [...chronological].sort());
  const forecast = pair.after.entries.find((row) => row.observation_id === "kingsbridge-operation-forecast-2018");
  assert.deepEqual(forecast.value.expected_operation, { value: "2018", precision: "year" });
  assert.equal(forecast.event_class, "planned");
  assert.equal(forecast.lifecycle_action, "forecast");
  assert.equal(forecast.value.realized, false);
  assert.notEqual(forecast.event_class, "realized");
  assert.deepEqual(
    pair.after.entries.filter((row) => row.fact_kind === "proposal_epoch").map((row) => row.value.ceqr_id),
    ["08DME004X", "13DME013X", "25DME006X"],
  );
});

test("A1: Lighthouse partial completion cannot close its future phase or parent plan", () => {
  const pair = byPair("lighthouse-component-status");
  const opening = pair.after.entries.find((row) => row.observation_id === "lighthouse-first-phase-opening-2025");
  const future = pair.after.entries.find((row) => row.observation_id === "lighthouse-future-phase-2025");
  const plan = pair.after.entries.find((row) => row.observation_id === "lighthouse-plan-2014");
  assert.equal(opening.event_class, "realized");
  assert.equal(opening.value.closes_parent_project, false);
  assert.equal(future.event_class, "planned");
  assert.equal(future.value.opened, false);
  assert.equal(plan.event_class, "planned");
  assert.equal(pair.after.lifecycle_counts.realized, 1);
  assert.equal(pair.after.lifecycle_counts.planned, 2);
});

test("A1: Queens preliminary measurement period survives beside the later proposal", () => {
  const pair = byPair("thirty-first-avenue-periods");
  const measurement = pair.after.entries.find((row) => row.fact_kind === "measurement_period");
  const phaseTwo = pair.after.entries.find((row) => row.assertion_key === "phase-ii-proposal");
  assert.equal(measurement.preliminary, true);
  assert.equal(measurement.scope.measurement_period, "2024");
  assert.equal(measurement.scope.metric, "preliminary-before-after-observations");
  assert.equal(measurement.value.numeric_value_published, false);
  assert.equal(phaseTwo.event_class, "planned");
  assert.notEqual(measurement.subject_ref, phaseTwo.subject_ref);
});

test("A2: numeric deltas require matching footprint, metric, phase, population, and unit", () => {
  const commonScope = {
    footprint: "corridor-a",
    metric: "daily-volume",
    phase: "phase-i",
    population: "observed-users",
    unit: "trips",
    measurement_period: "before",
  };
  const left = { numeric_value: 10, scope: commonScope };
  const right = { numeric_value: 14, scope: { ...commonScope, measurement_period: "after" } };

  // Positive control: compatible scoped facts produce the only numeric delta.
  assert.deepEqual(compareConnectedHistoryNumericFacts(left, right), {
    comparable: true,
    delta: 4,
    blocked_by: [],
  });
  for (const key of CONNECTED_HISTORY_COMPARABLE_SCOPE_KEYS) {
    const incompatible = compareConnectedHistoryNumericFacts(left, {
      ...right,
      scope: { ...right.scope, [key]: `different-${key}` },
    });
    assert.equal(incompatible.comparable, false, key);
    assert.equal(incompatible.delta, null, key);
    assert.ok(incompatible.blocked_by.includes(`incompatible_scope:${key}`), key);
  }
  const missing = compareConnectedHistoryNumericFacts(left, { ...right, scope: { ...right.scope, population: null } });
  assert.ok(missing.blocked_by.includes("missing_scope:population"));
  assert.equal(compareConnectedHistoryNumericFacts(left, { ...right, numeric_value: null }).delta, null);
});

test("A2: corrections and newly acquired old evidence change belief, not civic event time", () => {
  const original = syntheticObservation({
    observation_id: "fact-v1",
    numeric_value: 10,
    scope: { footprint: "a", metric: "units", phase: "one", population: "all", unit: "count" },
  });
  const correction = syntheticObservation({
    observation_id: "fact-v2-correction",
    supersedes_observation_id: "fact-v1",
    change_kind: "correction",
    lifecycle_action: "amended",
    observed_at: "2022-01-01T00:00:00.000Z",
    numeric_value: 12,
    value: { status: "planned", corrected: true },
    scope: { footprint: "a", metric: "units", phase: "one", population: "all", unit: "count" },
  });
  const beforeCorrection = projectConnectedHistoryStateAsOf([original, correction], {
    familyId: "synthetic-test-family",
    civicTime: "2020-12-31",
    beliefTime: "2021-06-01T00:00:00.000Z",
  });
  const afterCorrection = projectConnectedHistoryStateAsOf([original, correction], {
    familyId: "synthetic-test-family",
    civicTime: "2020-12-31",
    beliefTime: "2022-06-01T00:00:00.000Z",
  });
  assert.equal(beforeCorrection.entries[0].observation_id, "fact-v1");
  assert.equal(afterCorrection.entries[0].observation_id, "fact-v2-correction");
  const corrected = compareConnectedHistoryStates(beforeCorrection, afterCorrection);
  assert.equal(corrected.changes[0].classification, "knowledge_change");
  assert.equal(corrected.changes[0].knowledge_change_kind, "correction");
  assert.equal(corrected.counts.civic_changes, 0);
  assert.equal(corrected.changes[0].numeric.delta, 2);

  const lateOldEvidence = syntheticObservation({
    observation_id: "old-fact-learned-late",
    assertion_key: "old-evidence",
    comparison_key: "old-evidence",
    event_time: { value: "2019", precision: "year" },
    observed_at: "2023-01-01T00:00:00.000Z",
    change_kind: "newly_acquired_old_evidence",
    value: { status: "documented-old-fact" },
  });
  const beforeLearning = projectConnectedHistoryStateAsOf([lateOldEvidence], {
    familyId: "synthetic-test-family",
    civicTime: "2020-12-31",
    beliefTime: "2022-12-31T23:59:59.999Z",
  });
  const afterLearning = projectConnectedHistoryStateAsOf([lateOldEvidence], {
    familyId: "synthetic-test-family",
    civicTime: "2020-12-31",
    beliefTime: "2023-12-31T23:59:59.999Z",
  });
  const learned = compareConnectedHistoryStates(beforeLearning, afterLearning);
  assert.equal(learned.changes[0].classification, "knowledge_change");
  assert.equal(learned.changes[0].knowledge_change_kind, "newly_acquired_old_evidence");
  assert.equal(learned.after.civic_time, "2020-12-31");
});

test("A2: equal comparison keys in different civic families never collide", () => {
  const first = syntheticObservation({
    observation_id: "family-a-status",
    family_id: "family-a",
  });
  const second = syntheticObservation({
    observation_id: "family-b-status",
    family_id: "family-b",
    subject_ref: "test:subject:two",
  });
  const before = projectConnectedHistoryStateAsOf([first, second], {
    civicTime: "2019-12-31",
    beliefTime: "2022-01-01T00:00:00.000Z",
  });
  const after = projectConnectedHistoryStateAsOf([first, second], {
    civicTime: "2020-12-31",
    beliefTime: "2022-01-01T00:00:00.000Z",
  });
  const comparison = compareConnectedHistoryStates(before, after);
  assert.equal(comparison.changes.length, 2);
  assert.deepEqual(comparison.changes.map((row) => row.family_id).sort(), ["family-a", "family-b"]);
});

test("A3: imprecise dates preserve precision and enter state only after their interval ends", () => {
  assert.deepEqual(normalizeConnectedHistoryDate({ value: "2018", precision: "year" }), {
    value: "2018", precision: "year", start: "2018-01-01", end: "2018-12-31",
  });
  assert.deepEqual(normalizeConnectedHistoryDate({ value: "2026-05", precision: "month" }), {
    value: "2026-05", precision: "month", start: "2026-05-01", end: "2026-05-31",
  });
  const yearly = syntheticObservation({ event_time: { value: "2020", precision: "year" } });
  const midyear = projectConnectedHistoryStateAsOf([yearly], {
    familyId: "synthetic-test-family", civicTime: "2020-06-30", beliefTime: "2021-06-01T00:00:00.000Z",
  });
  const yearEnd = projectConnectedHistoryStateAsOf([yearly], {
    familyId: "synthetic-test-family", civicTime: "2020-12-31", beliefTime: "2021-06-01T00:00:00.000Z",
  });
  assert.equal(midyear.entries.length, 0);
  assert.equal(midyear.receipt.counts.omitted_after_civic_time, 1);
  assert.equal(yearEnd.entries.length, 1);
  assert.equal(yearEnd.entries[0].event_time.precision, "year");
});

test("A3: ordering is observed at intermediate insertion state and survives converse input order", () => {
  for (const control of committed.ordering_controls) {
    assert.equal(control.evidence_class, "module_oracle");
    assert.equal(control.intermediate_state_observed, true);
    assert.ok(control.forward.intermediate_steps.length >= 2);
    assert.equal(control.forward.intermediate_steps[1].before.length, 1);
    assert.equal(control.forward.intermediate_steps[1].after.length, 2);
    assert.deepEqual(control.forward.output_observation_ids, control.converse.output_observation_ids);

    const rows = committed.observations.filter((row) => row.family_id === control.family_id);
    const forward = orderConnectedHistoryEntries(rows);
    const converse = orderConnectedHistoryEntries([...rows].reverse());
    assert.deepEqual(forward.receipt.output_observation_ids, converse.receipt.output_observation_ids);
  }

  // Positive failure control: a self-declared altered output is rejected by recomputation.
  const altered = structuredClone(committed);
  altered.ordering_controls[0].forward.output_observation_ids.reverse();
  const result = verifyConnectedHistoryTimeArtifact(altered);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith("stale_forward_order:")));
});

test("A2: existing procurement as-of projection remains unchanged and fail-closed", () => {
  assert.deepEqual(CIVIC_TIME_COMPOSED_GRAPH_CASE_FAMILIES, ["procurement_notice"]);
  const history = {
    case_family: "procurement_notice",
    root_ref: "notice:20260707026",
    identity_link_history: [],
    events: [{
      event_id: "due-v1",
      subject_ref: "notice:20260707026",
      event_kind: "procurement.solicitation_due",
      source_record_ref: "passport-rfx:81026B0003",
      source_revision: "v1",
      valid_at: "2026-08-18",
      observed_at: "2026-08-10T09:00:00.000Z",
      written_at: "2026-08-10T12:01:00.000Z",
    }],
  };
  const projected = projectCivicTimeComposedGraphAsOf(history, { beliefTime: "2026-08-11" });
  assert.equal(projected.case_family, "procurement_notice");
  assert.equal(projected.objects.find((row) => row.object_type === "procurement_obligation").valid_interval.at, "2026-08-18");
  assert.equal(projected.receipt.processing_time_used_for_membership, false);
  assert.throws(
    () => projectCivicTimeComposedGraphAsOf({ ...history, case_family: "connected_history_fact" }, { beliefTime: "2026-08-11" }),
    /supports procurement_notice only/,
  );
});

test("A3: retained before/after states pass source judgments and checker mutations fail", () => {
  const built = buildConnectedHistoryTimeArtifact();
  assert.deepEqual(committed, built);
  assert.equal(committedReceipt.selection_hash, committed.selection_hash);
  assert.equal(committedReceipt.verification.state, "passed");
  assert.equal(verifyConnectedHistoryTimeArtifact(committed).valid, true);

  for (const judgment of CONNECTED_HISTORY_TIME_QUERY_JUDGMENTS) {
    const pair = byPair(judgment.id);
    assert.deepEqual(checkConnectedHistorySourceJudgment(pair, judgment), []);
    const impossible = {
      ...judgment,
      expected_after: [...judgment.expected_after, "missing-positive-control"],
    };
    assert.ok(checkConnectedHistorySourceJudgment(pair, impossible).some((error) => error.startsWith("missing_after:")));
  }

  const stale = structuredClone(committed);
  stale.query_pairs[0].after.entries.pop();
  const checked = verifyConnectedHistoryTimeArtifact(stale);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.some((error) => error.startsWith("stale_after:")));
});

test("A4: artifact is limited to the six fixed dossier families and uses no substitute quota", () => {
  assert.deepEqual(
    committed.dossier_outcomes.map((row) => row.family_id),
    CONNECTED_HISTORY_TIME_DOSSIER_FAMILIES,
  );
  assert.equal(committed.counts.dossier_families, 6);
  assert.equal(committed.counts.families_with_temporal_facts, 4);
  assert.equal(committed.source_policy, CONNECTED_HISTORY_TIME_SOURCE_POLICY);
  assert.ok(committed.dossier_outcomes.every((row) => row.substitute_family_used === false));
  assert.deepEqual(
    committed.dossier_outcomes.filter((row) => row.temporal_observations === 0).map((row) => row.family_id),
    ["coyle", "sixth-avenue"],
  );
  assert.deepEqual(
    [...new Set(CONNECTED_HISTORY_TIME_OBSERVATIONS.map((row) => row.family_id))].sort(),
    ["franklin-avenue", "kingsbridge-armory", "lighthouse-point", "thirty-first-avenue"],
  );

  const retainedRefs = new Set(retainedRelations.relations.flatMap((row) => [
    row.source_record_id,
    row.from,
    row.to,
  ]));
  for (const observation of committed.observations) {
    assert.ok(
      retainedRefs.has(observation.source_judgment.source_record_id),
      `unretained source reference ${observation.source_judgment.source_record_id}`,
    );
  }
});

test("A4: verifier refuses altered selection hash, inflated counts, and rewritten source policy", () => {
  assert.equal(verifyConnectedHistoryTimeArtifact(committed).valid, true);

  const alteredHash = structuredClone(committed);
  alteredHash.selection_hash = "0".repeat(64);
  const hashResult = verifyConnectedHistoryTimeArtifact(alteredHash);
  assert.equal(hashResult.valid, false);
  assert.ok(hashResult.errors.includes("selection_hash"));

  const inflatedCounts = structuredClone(committed);
  inflatedCounts.counts = {
    ...inflatedCounts.counts,
    observations: inflatedCounts.counts.observations + 50,
  };
  // Keep the declared hash matched to the inflated payload so only the
  // recomputed observation census can refuse the tampering.
  const { selection_hash: _ignoredHash, ...inflatedWithoutHash } = inflatedCounts;
  inflatedCounts.selection_hash = payloadHash(inflatedWithoutHash);
  const countResult = verifyConnectedHistoryTimeArtifact(inflatedCounts);
  assert.equal(countResult.valid, false);
  assert.ok(countResult.errors.includes("counts"));

  const rewrittenPolicy = structuredClone(committed);
  rewrittenPolicy.source_policy = "anything-goes-substitute-examples";
  const { selection_hash: _policyHash, ...policyWithoutHash } = rewrittenPolicy;
  rewrittenPolicy.selection_hash = payloadHash(policyWithoutHash);
  const policyResult = verifyConnectedHistoryTimeArtifact(rewrittenPolicy);
  assert.equal(policyResult.valid, false);
  assert.ok(policyResult.errors.includes("source_policy"));
});

test("A4: receipt verification state is derived from the verifier result", () => {
  const { artifact, receipt } = materializeConnectedHistoryTime();
  const verification = verifyConnectedHistoryTimeArtifact(artifact);
  assert.equal(verification.valid, true);
  assert.equal(receipt.verification.state, "passed");
  assert.equal(
    buildConnectedHistoryTimeReceipt(artifact, verification).verification.state,
    verification.valid ? "passed" : "failed",
  );

  const failed = buildConnectedHistoryTimeReceipt(artifact, {
    valid: false,
    errors: ["selection_hash", "counts"],
  });
  assert.equal(failed.verification.state, "failed");
  assert.deepEqual(failed.verification.errors, ["selection_hash", "counts"]);
  assert.notEqual(failed.verification.state, "passed");
});

test("A4: artifact reports unrepresented fact kinds with population", () => {
  const built = buildConnectedHistoryTimeArtifact();
  const expected = reportConnectedHistoryTimeKindPopulation(built.observations);
  assert.deepEqual(built.change_kind_population, {
    civic_event: 13,
    correction: 0,
    newly_acquired_old_evidence: 0,
  });
  assert.equal(built.numeric_observation_population, 0);
  assert.deepEqual(built.unrepresented_fact_kinds, [
    { kind: "correction", population: 0 },
    { kind: "newly_acquired_old_evidence", population: 0 },
    { kind: "numeric", population: 0 },
  ]);
  assert.deepEqual(built.unrepresented_fact_kinds, expected.unrepresented_fact_kinds);
  assert.deepEqual(committed.unrepresented_fact_kinds, built.unrepresented_fact_kinds);
  assert.deepEqual(committed.change_kind_population, built.change_kind_population);
  assert.equal(committed.numeric_observation_population, 0);
  assert.deepEqual(committedReceipt.unrepresented_fact_kinds, built.unrepresented_fact_kinds);
});

function payloadHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
