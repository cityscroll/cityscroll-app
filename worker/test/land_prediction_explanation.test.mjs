import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  LAND_PREDICTION_EXPLANATION_COMPARISON_SCHEMA,
  LAND_PREDICTION_EXPLANATION_SCHEMA,
  buildLandPredictionExplanation,
  compareLandPredictionExplanations,
  projectLandPredictionExplanation,
} from "../src/lib/land_prediction_explanation.mjs";
import { buildLandProjectState } from "../../site/land_detail_coherence.mjs";

const fixture = JSON.parse(fs.readFileSync(
  new URL("../../test/fixtures/land_prediction_explanation/gold.v1.json", import.meta.url),
  "utf8",
));

test("known, unknown, unresolved, and mixed evidence remain discriminated", () => {
  const explanation = buildLandPredictionExplanation(fixture.before);
  assert.equal(explanation.schema, LAND_PREDICTION_EXPLANATION_SCHEMA);
  assert.equal(explanation.status, "available");
  assert.equal(explanation.known_reasons.length, 2);
  assert.equal(explanation.unknown_signals.length, 1);
  assert.equal(explanation.unknown_signals[0].feature_state, "unknown");
  assert.match(explanation.unknown_signals[0].explanation, /not evidence for or against/);
  const openable = explanation.known_reasons.find((reason) => reason.feature_key === "cpc_disposition");
  assert.equal(openable.evidence[0].status, "resolvable");
  assert.equal(openable.evidence[0].href, "/land/fixture-1/#cpc-1");
  assert.equal(openable.evidence[0].source_statement_status, "unavailable");
  const unresolved = explanation.known_reasons.find((reason) => reason.feature_key === "community_board_action");
  assert.equal(unresolved.evidence[0].status, "unavailable");
  assert.match(unresolved.evidence[0].availability_note, /not proof/);
  assert.equal(explanation.evidence_status, "partially_unavailable");
});

test("an explanation with no material reasons fails closed without erasing missingness semantics", () => {
  const explanation = buildLandPredictionExplanation(fixture.empty);
  assert.equal(explanation.status, "unavailable");
  assert.deepEqual(explanation.known_reasons, []);
  assert.match(explanation.unavailable_note, /does not mean there is no relevant evidence/);
});

test("snapshot comparison deterministically exposes changed, added, removed, and still-unknown states", () => {
  const before = { ...fixture.before, explanation: buildLandPredictionExplanation(fixture.before) };
  const after = { ...fixture.after, explanation: buildLandPredictionExplanation(fixture.after) };
  const comparison = compareLandPredictionExplanations(before, after);
  assert.equal(comparison.schema, LAND_PREDICTION_EXPLANATION_COMPARISON_SCHEMA);
  assert.equal(comparison.probability.delta, 0.07);
  assert.equal(comparison.reasons.changed[0].reason_id, "feature:cpc_disposition:value=approved");
  assert.equal(comparison.reasons.added[0].feature_key, "local_council_member_stance");
  assert.equal(comparison.reasons.removed[0].feature_key, "community_board_action");
  assert.equal(comparison.reasons.still_unknown[0].feature_key, "modifications_or_conditions");
  assert.equal(comparison.interpretation.causal_interpretation, "unavailable");
  assert.match(comparison.interpretation.note, /does not establish why/);
  assert.deepEqual(comparison, compareLandPredictionExplanations(before, after));
});

test("institutional contributors are described as associations, never control", () => {
  const explanation = buildLandPredictionExplanation(fixture.after);
  const member = explanation.known_reasons.find((reason) => reason.feature_key === "local_council_member_stance");
  assert.match(member.explanation, /predictive association/);
  assert.doesNotMatch(member.explanation, /\b(controls|causes|determines) (?:the )?outcome\b/i);
  assert.equal(explanation.interpretation.institutional_control, "unavailable_without_separate_source_backed_contract");
});

test("reader projection is shadow-only and missing explanation stays honestly unavailable", () => {
  const explanation = buildLandPredictionExplanation(fixture.after);
  const shadow = { ...fixture.after, promotion_status: "shadow_only_until_backtest_gate", explanation };
  assert.equal(projectLandPredictionExplanation(shadow), explanation);
  assert.equal(projectLandPredictionExplanation({ promotion_status: "incumbent" }).status, "unavailable");

  const project = buildLandProjectState({ prediction: shadow });
  assert.equal(project.prediction_explanation, explanation);
  const missing = buildLandProjectState({ prediction: { promotion_status: "shadow_only_until_backtest_gate" } });
  assert.equal(missing.prediction_explanation.status, "unavailable");
  assert.match(missing.prediction_explanation.unavailable_note, /incumbent prediction remains unchanged/);
});
