import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeUsageEvent } from "../worker/src/lib/analytics.mjs";
import {
  buildComparativeSignalEvaluation,
  loadComparativeSignalEvaluationInputs,
  renderComparativeSignalEvaluationReport,
} from "../tools/evaluate_comparative_signals.mjs";

function evaluation() {
  return buildComparativeSignalEvaluation(loadComparativeSignalEvaluationInputs());
}

test("the evaluator measures every required dimension with explicit denominators", () => {
  const result = evaluation();

  assert.equal(result.schema, "cityscroll.comparative_signal_evaluation.v1");
  assert.deepEqual(result.scope.positive_pilots, [
    "source_bounded_award_rank",
    "within_contract_registered_amount_change",
  ]);
  assert.deepEqual(result.dimensions.precision, {
    definition: result.dimensions.precision.definition,
    numerator: 3,
    denominator: 3,
    rate: 1,
    review_coverage: { numerator: 3, denominator: 3, rate: 1 },
    cases: result.dimensions.precision.cases,
  });
  assert.deepEqual(result.dimensions.yield.aggregate, {
    numerator: 3,
    denominator: 1705,
    rate: 0.00176,
  });
  assert.equal(result.dimensions.diversity.metric_families.count, 2);
  assert.equal(result.dimensions.diversity.source_families.count, 2);
  assert.equal(result.dimensions.diversity.object_types.count, 2);
  assert.equal(result.dimensions.diversity.agencies.count, 3);
  assert.equal(result.dimensions.diversity.all_large_contract, false);
  assert.deepEqual(
    [result.dimensions.redundancy.numerator, result.dimensions.redundancy.denominator],
    [0, 3],
  );
  assert.deepEqual(
    [result.dimensions.stability.numerator, result.dimensions.stability.denominator],
    [2, 2],
  );
  assert.equal(result.gates.passed, true);
});

test("the MNAR negative control fails safety on publication, state drift, or backstage leakage", () => {
  const result = evaluation();
  assert.deepEqual(result.dimensions.mnar_safety, {
    definition: result.dimensions.mnar_safety.definition,
    numerator: 1,
    denominator: 1,
    rate: 1,
    expected_state: "held_mnar",
    observed_state: "held_mnar",
    unsupported_negative_claims_published: 0,
    held_reason_public_leaks: 0,
    negative_claim_public_leaks: 0,
  });

  const unsafe = loadComparativeSignalEvaluationInputs();
  for (const predicate of Object.keys(unsafe.negativeControl.observation.negative_inference_contract)) {
    unsafe.negativeControl.observation.negative_inference_contract[predicate] = true;
  }
  unsafe.negativeControl.observation.negative_inference = "allowed";
  const unsafeResult = buildComparativeSignalEvaluation(unsafe);
  assert.equal(unsafeResult.dimensions.mnar_safety.observed_state, "published");
  assert.equal(unsafeResult.dimensions.mnar_safety.rate, 0);
  assert.equal(unsafeResult.gates.mnar_safe, false);
  assert.equal(unsafeResult.gates.passed, false);
});

test("one aggregate shown event supplies the handoff denominator without identifying dimensions", () => {
  const result = evaluation();
  assert.deepEqual(result.dimensions.investigation_handoff, {
    definition: result.dimensions.investigation_handoff.definition,
    numerator_event: "investigation_share:add_signal",
    denominator_event: "comparative_signal_shown:visible",
    observation_window: { start: "2026-08-19", end: "2026-08-19" },
    numerator: 0,
    denominator: 0,
    rate: null,
    evidence_status: "unknown_no_exposure_denominator",
    source: result.dimensions.investigation_handoff.source,
  });
  assert.deepEqual(normalizeUsageEvent({
    event: "comparative_signal_shown",
    detail: "visible",
    surface: "worth-a-look",
    signal_id: "private-id-that-must-be-dropped",
    subject_ref: "private-ref-that-must-be-dropped",
  }), {
    event: "comparative_signal_shown",
    lens: "none",
    detail: "visible",
    geography: "none",
    surface: "worth-a-look",
    traffic_class: "production",
    taxonomy_version: "1.3.0",
  });
});

test("the recommendation cannot automatically make another metric family eligible", () => {
  const result = evaluation();
  assert.equal(result.recommendation.status, "revise");
  assert.deepEqual(result.recommendation.metric_families_to_expand, []);
  assert.equal(result.expansion_gate.eligible, false);
  assert.deepEqual(result.expansion_gate.metric_families_enabled, []);
  assert.equal(result.expansion_gate.human_decision, "pending");
  assert.equal(result.expansion_gate.new_bounded_card_required, true);

  const source = readFileSync(new URL("../site/comparative_signal_admission.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /vendor_concentration|lifecycle_absence/);
});

test("the committed machine artifact and written evaluation reproduce exactly", () => {
  const result = evaluation();
  const committed = JSON.parse(readFileSync(
    new URL("../docs/evidence/comparative-signal-evaluation.json", import.meta.url),
    "utf8",
  ));
  const report = readFileSync(
    new URL("../docs/evidence/comparative-signal-evaluation.md", import.meta.url),
    "utf8",
  );
  assert.deepEqual(result, committed);
  assert.equal(renderComparativeSignalEvaluationReport(result), report);
  assert.match(report, /Recommendation: revise; do not expand the metric set yet/);
  assert.match(report, /captain-recorded decision and its own bounded card/);
});

test("evaluation is deterministic and contains no model or live-source path", () => {
  const first = evaluation();
  const second = evaluation();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const source = readFileSync(new URL("../tools/evaluate_comparative_signals.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|openai|anthropic|language model/i);
});
