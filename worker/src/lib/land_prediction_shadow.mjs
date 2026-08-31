// Bounded, operator-only comparison of the incumbent land-use result and V2.
// The incumbent is returned independently of every shadow failure.

import { sha256Hex } from "./civic_time.mjs";
import { predictLandPrediction } from "./land_prediction_predictor.mjs";
import { validateLandPredictionSnapshot } from "./land_prediction_snapshot.mjs";

export const LAND_PREDICTION_SHADOW_SCHEMA = "cityscroll.land_prediction_shadow_comparison.v1";
export const LAND_PREDICTION_PROMOTION_GATE_SCHEMA = "cityscroll.land_prediction_promotion_gate.v1";
export const LARGE_DISAGREEMENT_THRESHOLD = 0.2;

const digest = (value) => sha256Hex(JSON.stringify(value));
const errorState = (error) => ({ status: "unavailable", reason: `${error?.name || "Error"}:${error?.message || "unknown"}` });

function snapshotIdentity(snapshot) {
  const value = validateLandPredictionSnapshot(snapshot);
  return {
    schema: "cityscroll.land_prediction_snapshot_identity.v1",
    project_id: value.application_id,
    prediction_as_of: value.prediction_as_of,
    evidence_fingerprint: digest({
      application_id: value.application_id,
      prediction_as_of: value.prediction_as_of,
      features: value.features,
      historical_actors: value.historical_actors,
    }),
  };
}

function assertOutputIdentity(output, identity, label) {
  const project = String(output.application_id || output.project_id || output.subject_ref || "").replace(/^project:/, "");
  const cutoff = output.prediction_as_of || output.prediction_timestamp;
  if (project !== identity.project_id || cutoff !== identity.prediction_as_of) {
    throw new TypeError(`${label} snapshot identity mismatch`);
  }
  if (output.snapshot_evidence_fingerprint && output.snapshot_evidence_fingerprint !== identity.evidence_fingerprint) {
    throw new TypeError(`${label} evidence envelope mismatch`);
  }
}

function summarizeFeatures(prediction) {
  return (prediction?.feature_state?.features || []).map((feature) => ({
    key: feature.key,
    value: feature.value,
    state: feature.state,
    missing: feature.state === "unknown",
    evidence_ids: [...(feature.evidence_ids || [])].sort(),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

export function evaluateLandPredictionPromotionGate(c7, options = {}) {
  const expected = {
    schema: "cityscroll.land_prediction_backtest.proof.v1",
    version: "lup2-c7-gold.v1",
    predictor_model_version: options.model_version || "2.0.0",
    minimum_test_n: options.minimum_test_n || 16,
  };
  const checks = {
    receipt_schema: c7?.schema === expected.schema,
    receipt_version: c7?.version === expected.version,
    model_pack: c7?.model_pack?.predictor_model_version === expected.predictor_model_version
      || c7?.predictor_model_version === expected.predictor_model_version
      || c7?.dataset?.predictor_model_version === expected.predictor_model_version,
    held_out_coverage: Number(c7?.split?.test_n) >= expected.minimum_test_n,
    timing_available: Number.isFinite(c7?.kill_criterion?.median_lead_days),
    kill_criterion_passed: c7?.kill_criterion?.met === false,
    c7_allows_product_promotion: c7?.promotion?.product_promotion_allowed === true,
    explicit_review_approval: options.decision === "approved" && Boolean(options.reviewer),
  };
  const passed = Object.values(checks).every(Boolean);
  return {
    schema: LAND_PREDICTION_PROMOTION_GATE_SCHEMA,
    expected,
    evidence: c7 ? { schema: c7.schema, version: c7.version, sha256: c7.sha256 || null } : null,
    checks,
    decision: { state: passed ? "approved" : "withheld", reviewer: options.reviewer || null },
    resulting_status: passed ? "approved_for_separate_rollout" : "shadow_only_until_backtest_gate",
    incumbent_authoritative: !passed,
    reason: passed ? "all held-out and review criteria passed" : "missing, incompatible, failed, or unapproved C7 evidence",
  };
}

export async function runLandPredictionShadow({ snapshot, model, incumbent_predictor, shadow_store = null, observed_at = null }) {
  const identity = snapshotIdentity(snapshot);
  if (typeof incumbent_predictor !== "function") throw new TypeError("incumbent_predictor is required");
  const incumbent = await incumbent_predictor(snapshot, identity);
  assertOutputIdentity(incumbent, identity, "incumbent");

  let comparison;
  try {
    const v2 = predictLandPrediction(model, snapshot, { prediction_timestamp: identity.prediction_as_of });
    assertOutputIdentity(v2, identity, "v2");
    const baselineProbability = Number.isFinite(incumbent.probability) ? incumbent.probability : null;
    const absolute = baselineProbability == null ? null : Math.abs(v2.probability - baselineProbability);
    comparison = {
      schema: LAND_PREDICTION_SHADOW_SCHEMA,
      comparison_id: `land-shadow:${digest(identity).slice(0, 24)}`,
      snapshot: identity,
      observed_at: observed_at || null,
      retention: { audience: "operator_review", public_authority: false, personal_data_retained: false },
      incumbent: { status: "available", model_name: incumbent.model_name, model_version: incumbent.model_version, probability: baselineProbability, result: incumbent },
      v2: { status: "available", model_name: v2.model_name, model_version: v2.model_version, probability: v2.probability, promotion_status: v2.promotion_status },
      feature_states: summarizeFeatures(v2),
      missingness: summarizeFeatures(v2).filter((row) => row.missing).map((row) => row.key),
      disagreement: {
        absolute_difference: absolute,
        relative_difference: absolute == null || baselineProbability === 0 ? null : absolute / baselineProbability,
        magnitude: absolute == null ? "not_comparable" : absolute >= LARGE_DISAGREEMENT_THRESHOLD ? "large" : "small",
        reason: absolute == null ? "incumbent_contract_has_no_project_probability" : "same_snapshot_probability_difference",
      },
      fallback: { used: false, reason: null },
    };
  } catch (error) {
    comparison = {
      schema: LAND_PREDICTION_SHADOW_SCHEMA,
      comparison_id: `land-shadow:${digest(identity).slice(0, 24)}`,
      snapshot: identity,
      observed_at: observed_at || null,
      incumbent: { status: "available", model_name: incumbent.model_name, model_version: incumbent.model_version, probability: incumbent.probability ?? null },
      v2: errorState(error),
      feature_states: [], missingness: [], disagreement: { absolute_difference: null, relative_difference: null, magnitude: "not_comparable", reason: "v2_unavailable" },
      fallback: { used: true, reason: errorState(error).reason },
    };
  }
  let storage = { status: "not_configured" };
  if (shadow_store?.put) {
    try {
      await shadow_store.put(comparison.comparison_id, JSON.stringify(comparison));
      storage = { status: "written" };
    } catch (error) { storage = errorState(error); }
  }
  return { authoritative: incumbent, shadow: comparison, shadow_storage: storage };
}
