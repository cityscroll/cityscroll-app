import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BACKTEST_SCHEMA,
  buildBacktestArtifact,
  checkBacktest,
} from "../tools/backtest_procurement_intent_radar.mjs";
import {
  assertCutoffForecast,
  leakageCheck,
  reconstructAtCutoff,
  sealHistoricalSource,
} from "../warehouse/lib/procurement_intent_corpus.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";

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
  assert.equal(artifact.protocol.evaluator_versions.prediction_calibration, "prediction_calibration_v1");
  for (const row of artifact.assertions.filter((item) => item.extracted_intent)) {
    assert.equal(row.leakage.historical_input_only, true);
    assert.equal(row.leakage.findings.length, 0, row.id);
    assert.equal(row.match.link_precision_inputs_are_retrospective_only, true);
    assert.equal(row.scorecard.resolved_backtest_predictions, 2);
  }
});

test("2022-2025 coverage receipt keeps the gold pack as a fixture control, not a recurrent estimate", () => {
  const artifact = buildBacktestArtifact();
  assert.equal(artifact.coverage.sufficient_for_recurrent_corpus_claim, false);
  assert.equal(artifact.coverage.retained_app_corpus.text_bearing_council_rows, 0);
  assert.equal(artifact.coverage.retained_app_corpus.event_dates_in_corpus_window, 0);
  assert.deepEqual(artifact.coverage.labeled_fixture.year_coverage, { 2022: 1, 2023: 1, 2024: 1, 2025: 2 });
  assert.equal(artifact.metrics.extraction.denominator, 5);
  assert.equal(artifact.metrics.realization_link.denominator, 4);
  assert.equal(artifact.metrics.occurrence.denominator, 3);
  assert.equal(artifact.metrics.timing.denominator, 3);
  assert.equal(artifact.metrics.lead_time_days.denominator, 3);
  assert.equal(artifact.metrics.abstention.denominator, 5);
});

test("cutoff reconstruction seals future publisher fields before extraction", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url), "utf8"));
  const source = {
    ...fixtures.cases[0].source,
    epin: "26026P0003",
    vendor_name: "Future Vendor LLC",
    later_title: "COMPASS Programs in Public Schools",
    coverage: "later news coverage",
  };
  const sealed = sealHistoricalSource(source);
  assert.equal(Object.hasOwn(sealed, "epin"), false);
  assert.equal(Object.hasOwn(sealed, "vendor_name"), false);
  assert.equal(Object.hasOwn(sealed, "later_title"), false);
  const reconstructed = reconstructAtCutoff(source);
  assert.equal(JSON.stringify(reconstructed.extracted).includes("26026P0003"), false);
  assert.equal(JSON.stringify(reconstructed.extracted).includes("Future Vendor LLC"), false);
});

test("deliberate future-feature injection is a hard leakage failure", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url), "utf8"));
  const fixture = fixtures.cases[0];
  const extracted = reconstructAtCutoff(fixture.source).extracted;
  extracted.assertion.epin = "26026P0003";
  extracted.assertion.vendor_name = "Future Vendor LLC";
  const leakage = leakageCheck({
    fixture,
    extracted,
    realizations: [{
      epin: "26026P0003",
      title: "COMPASS Programs in Public Schools",
      vendor: "Future Vendor LLC",
      published_at: "2025-10-01",
    }],
  });
  assert.equal(leakage.passed, false);
  assert.ok(leakage.findings.some((finding) => finding.field === "epin" || finding.path === "assertion.epin"));
  assert.throws(
    () => assertCutoffForecast({
      id: "pir-leakage-injection",
      cutoff: "2025-05-19",
      feature_observed_at: "2025-10-01",
    }),
    /temporal leakage/,
  );
});

test("committed JSON, report, and coverage receipt stay in lockstep", () => {
  const artifact = checkBacktest();
  assert.equal(artifact.temporal_integrity.leakage_failures.length, 0);
  assert.equal(artifact.promotion.product_promotion_allowed, false);
});

test("architecture-evidence projections reconcile the PIR-4 card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["warehouse/fixtures/procurement-intent-radar/corpus_backtest.v1.json"]
      .represented_card_ids.includes("cityscroll-engineering/procurement-intent-corpus-backtest"),
    true,
  );
});
