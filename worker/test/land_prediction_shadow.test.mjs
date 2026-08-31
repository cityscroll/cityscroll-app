import assert from "node:assert/strict";
import { test } from "node:test";
import { fitLandPredictionModel } from "../src/lib/land_prediction_predictor.mjs";
import { buildLandPredictionSnapshot } from "../src/lib/land_prediction_snapshot.mjs";
import { evaluateLandPredictionPromotionGate, runLandPredictionShadow } from "../src/lib/land_prediction_shadow.mjs";
import gold from "../../test/fixtures/land_prediction_shadow/gold.v1.json" with { type: "json" };

const cutoff = "2024-06-01T00:00:00.000Z";
const source = (id) => ({ url: `https://example.invalid/${id}`, record_id: id });
const feature = (key, value, id) => ({ key, value, evidence_type: "official_record", observed_at: "2024-05-01T00:00:00.000Z", effective_at: "2024-05-01T00:00:00.000Z", source: source(id), confidence: 1 });
const snapshot = (id, stance = null) => buildLandPredictionSnapshot({ application_id: id, prediction_as_of: cutoff, procedural_stage: "council", features: [feature("application_type", "zoning", `${id}-type`), ...(stance ? [feature("local_council_member_stance", stance, `${id}-stance`)] : [])] });
const model = fitLandPredictionModel([
  { id: "yes", snapshot: snapshot("yes", "support"), outcome: "approved", outcome_at: "2024-07-01T00:00:00Z" },
  { id: "no", snapshot: snapshot("no", "oppose"), outcome: "disapproved", outcome_at: "2024-07-01T00:00:00Z" },
]);
const incumbent = (probability = .5) => (snap) => ({ application_id: snap.application_id, prediction_as_of: snap.prediction_as_of, model_name: "current_land_use_heuristic", model_version: "1.0.0", probability, authoritative: true });

test("records small and large same-snapshot disagreements with feature evidence and unknowns", async () => {
  const small = await runLandPredictionShadow({ snapshot: snapshot("small", "support"), model, incumbent_predictor: incumbent(gold.cases.small_difference.incumbent_probability) });
  assert.equal(small.authoritative.authoritative, true);
  assert.equal(small.shadow.snapshot.project_id, "small");
  assert.equal(small.shadow.disagreement.magnitude, gold.cases.small_difference.expected_magnitude);
  const large = await runLandPredictionShadow({ snapshot: snapshot("large", "support"), model, incumbent_predictor: incumbent(gold.cases.large_difference.incumbent_probability) });
  assert.equal(large.shadow.disagreement.magnitude, gold.cases.large_difference.expected_magnitude);
  assert.ok(large.shadow.feature_states.some((row) => row.evidence_ids.includes("large-stance")));
  const missing = await runLandPredictionShadow({ snapshot: snapshot("missing"), model, incumbent_predictor: incumbent(.5) });
  assert.ok(missing.shadow.missingness.includes("local_council_member_stance"));
});

test("rejects identity mismatch before comparison", async () => {
  await assert.rejects(() => runLandPredictionShadow({ snapshot: snapshot("one"), model, incumbent_predictor: incumbent(.5)(snapshot("other")) }), /incumbent_predictor is required/);
  await assert.rejects(() => runLandPredictionShadow({ snapshot: snapshot("one"), model, incumbent_predictor: () => incumbent(.5)(snapshot("other")) }), /identity mismatch/);
});

test("V2 and shadow-storage failures never interrupt the incumbent", async () => {
  const brokenModel = { nope: true };
  const result = await runLandPredictionShadow({ snapshot: snapshot("safe"), model: brokenModel, incumbent_predictor: incumbent(gold.cases.storage_failure.incumbent_probability), shadow_store: { put: async () => { throw new Error("offline"); } } });
  assert.equal(result.authoritative.probability, gold.cases.storage_failure.expected_authoritative_probability);
  assert.equal(result.shadow.fallback.used, true);
  assert.equal(result.shadow_storage.status, "unavailable");
});

test("promotion is fail-closed for stale, failed, and subjectively reviewed evidence", () => {
  const base = { schema: "cityscroll.land_prediction_backtest.proof.v1", version: "lup2-c7-gold.v1", predictor_model_version: "2.0.0", split: { test_n: 16 }, kill_criterion: { met: false, median_lead_days: 100 }, promotion: { product_promotion_allowed: false } };
  assert.equal(evaluateLandPredictionPromotionGate(base, { reviewer: "reviewer", decision: "approved" }).resulting_status, "shadow_only_until_backtest_gate");
  assert.equal(evaluateLandPredictionPromotionGate({ ...base, version: "stale" }).checks.receipt_version, false);
  assert.equal(evaluateLandPredictionPromotionGate({ ...base, kill_criterion: { met: true, median_lead_days: 100 } }).checks.kill_criterion_passed, false);
});
