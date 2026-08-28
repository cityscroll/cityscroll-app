import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INSTITUTIONAL_SIGNAL_STATUSES,
  LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY,
  MEMBER_DEFERENCE_CANDIDATE,
  addLandPredictionInstitutionalSignal,
  buildLandPredictionInstitutionalSignalRegistry,
  updateLandPredictionInstitutionalSignalStatus,
  validateLandPredictionInstitutionalSignalRegistry,
} from "../src/lib/land_prediction_institutional_signal_registry.mjs";

function candidate(overrides = {}) {
  return {
    id: "example-signal",
    formal_actor_process: "A formal agency process",
    candidate_practical_actor: "A practical actor",
    claimed_mechanism: "The practical actor may shape the formal result.",
    relevant_stage: "formal_decision",
    possible_evidence_sources: ["source records", "held-out outcomes"],
    rival_explanation: ["The actor may only be an information sensor."],
    falsifier: ["No incremental held-out predictive value after controls."],
    status: "proposed",
    ...overrides,
  };
}

test("the seeded member-deference hypothesis is a research-only candidate", () => {
  assert.deepEqual(INSTITUTIONAL_SIGNAL_STATUSES, ["proposed", "testing", "promoted", "rejected"]);
  const registry = validateLandPredictionInstitutionalSignalRegistry(
    LAND_PREDICTION_INSTITUTIONAL_SIGNAL_REGISTRY,
  );
  assert.equal(registry.queue, "research");
  assert.equal(registry.production_admission, "not_admitted");
  assert.deepEqual(registry.candidates, [MEMBER_DEFERENCE_CANDIDATE]);
  assert.match(registry.candidates[0].rival_explanation[0], /H2.*information\/sensor/i);
  assert.equal(registry.candidates[0].falsifier.length >= 1, true);
});

test("new candidates require every actor, mechanism, stage, source, rival, and falsifier field", () => {
  const registry = buildLandPredictionInstitutionalSignalRegistry({ candidates: [candidate()] });
  const stored = registry.candidates[0];
  assert.equal(stored.formal_actor_process, "A formal agency process");
  assert.equal(stored.candidate_practical_actor, "A practical actor");
  assert.equal(stored.claimed_mechanism, "The practical actor may shape the formal result.");
  assert.deepEqual(stored.relevant_stage, ["formal_decision"]);
  assert.deepEqual(stored.possible_evidence_sources, ["source records", "held-out outcomes"]);
  assert.deepEqual(stored.rival_explanation, ["The actor may only be an information sensor."]);
  assert.deepEqual(stored.falsifier, ["No incremental held-out predictive value after controls."]);

  for (const field of ["formal_actor_process", "candidate_practical_actor", "claimed_mechanism", "relevant_stage", "possible_evidence_sources", "rival_explanation", "falsifier"]) {
    const invalid = candidate({ [field]: [] });
    assert.throws(
      () => buildLandPredictionInstitutionalSignalRegistry({ candidates: [invalid] }),
      new RegExp(`candidate\\.${field}`),
    );
  }
});

test("promotion is gated on historical useful predictive value", () => {
  assert.throws(
    () => buildLandPredictionInstitutionalSignalRegistry({
      candidates: [candidate({ status: "promoted" })],
    }),
    /promotion_evidence/,
  );
  assert.throws(
    () => updateLandPredictionInstitutionalSignalStatus(
      buildLandPredictionInstitutionalSignalRegistry({ candidates: [candidate()] }),
      "example-signal",
      "promoted",
      { evaluation_id: "eval-1", historical_evidence: true },
    ),
    /useful predictive value/,
  );

  const promoted = updateLandPredictionInstitutionalSignalStatus(
    buildLandPredictionInstitutionalSignalRegistry({ candidates: [candidate()] }),
    "example-signal",
    "promoted",
    {
      evaluation_id: "land-use-backtest-2024",
      historical_evidence: true,
      useful_predictive_value: true,
      train_test_design: "time-based split",
      held_out_application_count: 40,
      metric: { name: "brier", baseline: 0.31, candidate: 0.24, direction: "lower_is_better" },
      conclusion: "Brier score improved after formal-signal controls.",
    },
  );
  assert.equal(promoted.candidates[0].status, "promoted");
  assert.equal(promoted.candidates[0].promotion_evidence.held_out_application_count, 40);
});

test("rejected candidates remain recorded with a historical rationale", () => {
  const initial = buildLandPredictionInstitutionalSignalRegistry({ candidates: [candidate()] });
  assert.throws(
    () => updateLandPredictionInstitutionalSignalStatus(initial, "example-signal", "rejected"),
    /rejection_rationale/,
  );
  const rejected = updateLandPredictionInstitutionalSignalStatus(
    initial,
    "example-signal",
    "rejected",
    "Held-out tests found no incremental value after accounting for formal process.",
  );
  assert.equal(rejected.candidates.length, 1);
  assert.equal(rejected.candidates[0].status, "rejected");
  assert.match(rejected.candidates[0].rejection_rationale, /no incremental value/);
  assert.throws(
    () => updateLandPredictionInstitutionalSignalStatus(rejected, "example-signal", "testing"),
    /rejected candidate status is terminal/,
  );

  const withNewCandidate = addLandPredictionInstitutionalSignal(rejected, candidate({ id: "second-signal" }));
  assert.deepEqual(withNewCandidate.candidates.map((item) => [item.id, item.status]), [
    ["example-signal", "rejected"],
    ["second-signal", "proposed"],
  ]);
});

test("registry output is deterministic and cannot be relabeled as production", () => {
  const left = buildLandPredictionInstitutionalSignalRegistry({
    candidates: [candidate({ id: "z-signal" }), candidate({ id: "a-signal" })],
  });
  const right = buildLandPredictionInstitutionalSignalRegistry({
    candidates: [candidate({ id: "a-signal" }), candidate({ id: "z-signal" })],
  });
  assert.deepEqual(left, right);
  assert.throws(
    () => validateLandPredictionInstitutionalSignalRegistry({
      ...left,
      production_admission: "admitted",
    }),
    /outside production admission/,
  );
});
