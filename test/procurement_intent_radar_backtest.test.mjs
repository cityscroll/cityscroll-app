import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKTEST_SCHEMA,
  buildBacktestArtifact,
} from "../tools/backtest_procurement_intent_radar.mjs";

test("PIR-4 backtest reports all required aggregates and withholds promotion", () => {
  const artifact = buildBacktestArtifact();
  assert.equal(artifact.schema, BACKTEST_SCHEMA);
  assert.equal(artifact.corpus.full_corpus, false);
  assert.equal(artifact.assertions.length, 5);
  assert.equal(artifact.metrics.extraction.precision, 1);
  assert.equal(artifact.metrics.extraction.recall, 1);
  assert.equal(artifact.metrics.realization_link.precision, 1);
  assert.equal(artifact.metrics.realization_link.recall, 1);
  assert.equal(artifact.metrics.occurrence.brier_score, 0.25);
  assert.equal(artifact.metrics.lead_time_days.median, 149);
  assert.equal(artifact.metrics.timing.window_hit_rate, 0.3333);
  assert.deepEqual(artifact.metrics.timing.error_categories, { published_after_stated_window: 2 });
  assert.equal(artifact.temporal_integrity.leakage_failures.length, 0);
  assert.equal(artifact.promotion.status, "withheld");
  assert.equal(artifact.promotion.product_promotion_allowed, false);
  assert.equal(artifact.promotion.gates.recurrent_corpus.passed, false);
});

test("per-assertion output preserves two negative controls and exact one-to-many realization", () => {
  const artifact = buildBacktestArtifact();
  const compass = artifact.assertions.find((row) => row.id === "compass-dycd-2025-05-19");
  const hra = artifact.assertions.find((row) => row.id === "hra-dv-beds-2024-10-09");
  const acs = artifact.assertions.find((row) => row.id === "acs-atd-2022-03-09");
  const negative = artifact.assertions.filter((row) => row.kind === "negative");
  assert.equal(compass.match.automatic_edges.length, 2);
  assert.equal(compass.outcomes.occurrence, "hit");
  assert.equal(compass.outcomes.timing, "hit");
  assert.equal(compass.outcomes.lead_days, 135);
  assert.deepEqual([hra.outcomes.occurrence, hra.outcomes.timing, hra.outcomes.lead_days], ["hit", "miss", 149]);
  assert.deepEqual([acs.outcomes.occurrence, acs.outcomes.timing, acs.outcomes.lead_days], ["hit", "miss", 219]);
  assert.equal(negative.length, 2);
  assert.ok(negative.every((row) => row.extracted_intent === null));
  assert.ok(negative.every((row) => row.controls.extractor_rejected_baseline === true));
});

test("historical prediction protocol excludes publisher fields and uses per-assertion cutoffs", () => {
  const artifact = buildBacktestArtifact();
  assert.deepEqual(artifact.protocol.excluded_from_prediction_inputs, [
    "future EPIN/PIN",
    "solicitation title",
    "vendor",
    "later coverage",
    "future naming features",
  ]);
  for (const row of artifact.assertions.filter((item) => item.extracted_intent)) {
    assert.equal(row.leakage.historical_input_only, true);
    assert.equal(row.leakage.findings.length, 0, row.id);
    assert.equal(row.match.link_precision_inputs_are_retrospective_only, true);
    assert.equal(row.scorecard.resolved_backtest_predictions, 2);
  }
});
