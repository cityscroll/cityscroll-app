#!/usr/bin/env node

/**
 * PIR-4 corpus backtest.
 *
 * Each retained source is evaluated as if the assertion were emitted on the
 * meeting date. The retrospective realization matcher is only used after that
 * cutoff to score links and outcomes. Prediction resolution is delegated to
 * the shared prediction_calibration evaluator, with the source meeting as the
 * opening event and a later procurement publication as the terminal event.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containsRfpBaseline, EXTRACTION_VERSION } from "../warehouse/lib/procurement_intent_extractor.mjs";
import { buildProspectiveProcess } from "../ontology/procurement_intent.mjs";
import {
  matchHistoricalIntent,
  REALIZATION_MATCHER_VERSION,
} from "../warehouse/lib/procurement_intent_realization_matcher.mjs";
import { buildPrediction } from "../worker/src/lib/prediction_contract.mjs";
import {
  evaluatePredictionBacktest,
  PREDICTION_CALIBRATION_VERSION,
} from "../worker/src/lib/prediction_calibration.mjs";
import { evaluateForecasts } from "../worker/src/lib/forecast_calibration.mjs";
import {
  CORPUS_FROM,
  CORPUS_THROUGH,
  EXCLUSION_RULES,
  INCLUSION_RULES,
  LABELED_FIXTURE_ARTIFACT,
  RETAINED_MEETINGS_ARTIFACT,
  assertCutoffForecast,
  buildCorpusCoverage,
  hashFile,
  leakageCheck,
  loadCorpusCoverageFromRepo,
  reconstructAtCutoff,
} from "../warehouse/lib/procurement_intent_corpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BACKTEST_SCHEMA = "cityscroll.procurement_intent_radar.corpus_backtest.v1";
export const BACKTEST_VERSION = "pir-corpus-backtest.v1";
export const DEFAULT_INPUT = join(ROOT, "test/fixtures/procurement_intent_radar/gold_fixtures.v0.json");
export const DEFAULT_OUTPUT = join(ROOT, "warehouse/fixtures/procurement-intent-radar/corpus_backtest.v1.json");
export const DEFAULT_REPORT = join(ROOT, "docs/evidence/procurement-intent-radar/corpus-backtest.md");
export const DEFAULT_COVERAGE = join(ROOT, "warehouse/fixtures/procurement-intent-radar/corpus_coverage.v1.json");
const TERMINAL_EVENT_KIND = "procurement.notice_published";
const OPEN_EVENT_KIND = "meetings.council_event";
const PROBABILITY = 0.5;
const PROMOTION_PRECISION_FLOOR = 0.9;
const PROMOTION_LINK_PRECISION_FLOOR = 0.95;
const PROMOTION_LEAD_FLOOR = 30;
const DAY_MS = 86_400_000;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function dateValue(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

function nextDay(day) {
  return new Date(dateValue(day) + DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return Math.round((dateValue(end) - dateValue(start)) / DAY_MS);
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round(value, places = 4) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(places));
}

function agencyLabel(ref) {
  return {
    "agency:id:dycd": "DYCD",
    "agency:id:dss": "HRA / DSS",
    "agency:id:acs": "Administration for Children's Services",
  }[ref] || ref || "unknown";
}

function realizationRows(fixture, assertion) {
  const realizedAt = fixture.expected_outcome?.realization?.realized_at;
  return (fixture.expected_outcome?.realization?.realized_procurements || []).map((row) => ({
    source_system: row.source_system,
    source_system_id: row.epin,
    epin: row.epin,
    published_at: realizedAt,
    agency: agencyLabel(assertion.responsible_agency_ref),
    title: row.title,
    procurement_method: /\bRFx?\b/iu.test(row.title || "") ? "RFx" : assertion.procurement_type,
    citation_url: row.citation_url,
  }));
}

function historicalPredictions(process, observedAt) {
  const generatedAt = `${nextDay(observedAt)}T00:00:00.000Z`;
  return ["occurrence", "timing"].map((claim) => {
    const sourcePrediction = process.predictions[claim];
    if (!sourcePrediction) return null;
    return buildPrediction({
      ...sourcePrediction,
      // The ontology keeps occurrence and timing as separate claims. The
      // shared evaluator requires one model identity per backtest, so this
      // adapter evaluates both claims under one PIR model family.
      model_name: "prospective_procurement",
      probability: PROBABILITY,
      basis: {
        ...sourcePrediction.basis,
        train_from: CORPUS_FROM,
        train_to: observedAt,
      },
      generated_at: generatedAt,
      status: "open",
      resolved_by_event_id: null,
      prediction_id: undefined,
    });
  }).filter(Boolean);
}

function predictionBacktest(process, predictions, resolutionEvents) {
  const observedAt = process.stated_intent.observed_at;
  const splitDate = nextDay(observedAt);
  const events = [
    {
      event_id: process.source_record.source_event_id,
      subject_ref: process.process_ref,
      event_kind: OPEN_EVENT_KIND,
      valid_at: observedAt,
    },
    ...resolutionEvents.map((event) => ({ ...event, valid_at: event.published_at })),
  ];
  return evaluatePredictionBacktest({
    domain: "procurement",
    split_date: splitDate,
    grace_days: 0,
    open_event_kinds: [OPEN_EVENT_KIND],
    terminal_event_kinds: [TERMINAL_EVENT_KIND],
    predictions,
    events,
  });
}

function expectedRefs(rows) {
  return rows.map((row) => `procurement:${row.source_system}:${row.epin}`).sort();
}

function timingError(assertion, realizedAt) {
  const window = assertion.expected_window;
  const p50 = window.earliest && window.latest
    ? dateValue(window.earliest) + Math.floor((dateValue(window.latest) - dateValue(window.earliest)) / 2)
    : null;
  const offset = p50 == null ? null : Math.round((dateValue(realizedAt) - p50) / DAY_MS);
  const inWindow = (!window.earliest || realizedAt >= window.earliest)
    && (!window.latest || realizedAt <= window.latest);
  return {
    status: inWindow ? "hit" : "miss",
    signed_days_from_midpoint: offset,
    absolute_days_from_midpoint: offset == null ? null : Math.abs(offset),
    category: inWindow ? null : realizedAt > window.latest ? "published_after_stated_window" : "published_before_stated_window",
  };
}

function aggregateCalibration(forecasts) {
  const metrics = evaluateForecasts(forecasts);
  return {
    value_type: "measured",
    denominator: metrics.denominator,
    scored: metrics.scored,
    abstained: metrics.abstained,
    precision: metrics.precision,
    recall: metrics.recall,
    brier_score: metrics.brier_score,
    calibration: metrics.calibration,
    maximum_calibration_gap: metrics.maximum_calibration_gap,
    shared_forecast_evaluator: "worker/src/lib/forecast_calibration.mjs",
  };
}

function buildCase(fixture) {
  const reconstructed = reconstructAtCutoff(fixture.source);
  const extracted = reconstructed.extracted;
  const assertion = extracted.assertion;
  const realizations = assertion ? realizationRows(fixture, assertion) : [];
  const leakage = leakageCheck({ fixture, extracted, realizations });
  const baselineWouldCandidate = containsRfpBaseline(fixture.source.source_span_text);
  if (!assertion) {
    return {
      id: fixture.id,
      kind: fixture.kind,
      source: {
        source_record_id: fixture.source.source_record_id,
        source_event_id: fixture.source.source_event_id,
        observed_at: fixture.source.observed_at,
        source_type: fixture.source.source_type,
        citation_url: fixture.source.citations?.[0]?.url || null,
      },
      extracted_intent: null,
      expected_intent: fixture.expected_future_action_assertion,
      extraction: { status: extracted.status, candidate: false, confidence: null },
      candidate_solicitations: [],
      chosen_realization: null,
      match: { status: "not_scored", confidence: "not_applicable", candidates: [], automatic_edges: [] },
      outcomes: { occurrence: "not_applicable", timing: "not_applicable", lead_days: null, timing_error: null, resolution_status: "not_applicable" },
      leakage,
      controls: { contains_rfp_baseline: baselineWouldCandidate, extractor_rejected_baseline: !extracted.candidate.candidate },
    };
  }

  const process = buildProspectiveProcess({ source: fixture.source, assertion });
  const match = matchHistoricalIntent(process, realizations);
  const predictions = historicalPredictions(process, fixture.source.observed_at);
  const scorecard = predictionBacktest(process, predictions, match.resolution_events);
  const first = match.realized_by[0] || null;
  const realizedAt = first ? match.candidates.find((candidate) => candidate.realization_ref === first.to)?.published_at : null;
  const timing = realizedAt ? timingError(assertion, realizedAt) : null;
  return {
    id: fixture.id,
    kind: fixture.kind,
    source: {
      source_record_id: fixture.source.source_record_id,
      source_event_id: fixture.source.source_event_id,
      observed_at: fixture.source.observed_at,
      source_type: fixture.source.source_type,
      citation_url: fixture.source.citations?.[0]?.url || null,
    },
    extracted_intent: {
      assertion_id: assertion.assertion_id,
      agency: assertion.responsible_agency_ref,
      object_text: assertion.object_text,
      procurement_type: assertion.procurement_type,
      expected_window: assertion.expected_window,
      modality: assertion.modality,
      extraction_confidence: assertion.extraction_confidence,
    },
    expected_intent: fixture.expected_future_action_assertion,
    extraction: { status: extracted.status, candidate: true, confidence: assertion.extraction_confidence },
    candidate_solicitations: match.candidates.map((candidate) => ({
      realization_ref: candidate.realization_ref,
      published_at: candidate.published_at,
      title: candidate.realization.title,
      source_system: candidate.realization.source_system,
      citation_url: candidate.realization.citation_url,
      decision: candidate.features.decision,
      match_confidence: candidate.features.match_confidence,
      score: candidate.features.score,
      evidence: candidate.features.evidence,
    })),
    chosen_realization: first ? {
      realization_ref: first.to,
      published_at: realizedAt,
      selection: "earliest accepted exact event",
    } : null,
    match: {
      status: match.outcome.status,
      confidence: match.outcome.match_confidence,
      candidates: match.candidates.length,
      automatic_edges: match.realized_by.map((edge) => edge.to).sort(),
      expected_edges: expectedRefs(realizations),
      link_precision_inputs_are_retrospective_only: true,
    },
    outcomes: {
      occurrence: match.outcome.occurrence,
      timing: match.outcome.timing,
      lead_days: match.outcome.lead_days,
      timing_error: timing,
      resolution_status: scorecard.resolution_counts.open ? "open" : match.outcome.status,
    },
    scorecard,
    leakage,
    controls: { contains_rfp_baseline: baselineWouldCandidate, extractor_rejected_baseline: false },
  };
}

function linkMetrics(rows) {
  const expected = rows.flatMap((row) => row.match.expected_edges || []);
  const actual = rows.flatMap((row) => row.match.automatic_edges || []);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const truePositive = actual.filter((ref) => expectedSet.has(ref)).length;
  const falsePositive = actual.filter((ref) => !expectedSet.has(ref)).length;
  const falseNegative = expected.filter((ref) => !actualSet.has(ref)).length;
  return {
    value_type: "measured",
    reviewed_pairs: expected.length,
    automatic_links: actual.length,
    true_positive: truePositive,
    false_positive: falsePositive,
    false_negative: falseNegative,
    precision: actual.length ? round(truePositive / actual.length) : null,
    recall: expected.length ? round(truePositive / expected.length) : null,
    reviewed_precision: actual.length ? round(truePositive / actual.length) : null,
  };
}

function buildArtifact(input = readJson(DEFAULT_INPUT), { coverage } = {}) {
  if (!Array.isArray(input.cases)) throw new TypeError("fixture pack must contain cases");
  const rows = input.cases.map(buildCase);
  const positive = rows.filter((row) => row.kind === "positive");
  const extractedPositive = positive.filter((row) => row.extraction.candidate);
  const extractedNegative = rows.filter((row) => row.kind === "negative" && row.extraction.candidate);
  const extraction = {
    value_type: "measured",
    reviewed_sources: rows.length,
    gold_assertions: positive.length,
    extracted_candidates: rows.filter((row) => row.extraction.candidate).length,
    true_positive: extractedPositive.length,
    false_positive: extractedNegative.length,
    false_negative: positive.length - extractedPositive.length,
    precision: extractedPositive.length + extractedNegative.length
      ? round(extractedPositive.length / (extractedPositive.length + extractedNegative.length)) : null,
    recall: positive.length ? round(extractedPositive.length / positive.length) : null,
    abstained: rows.filter((row) => !row.extraction.candidate).length,
  };
  const forecasts = positive.flatMap((row) => {
    // Rebuild rows from the same source/terminal clocks for the shared Brier
    // and calibration primitive; the per-assertion scorecard remains the
    // authoritative exact-event resolver result.
    const realized = row.outcomes.occurrence === "hit";
    const forecast = {
      id: `pir-occurrence:${row.id}`,
      cutoff: row.source.observed_at,
      feature_observed_at: row.source.observed_at,
      probability: PROBABILITY,
      coverage_ratio: 1,
      missing_required_fields: [],
      outcome: realized ? 1 : 0,
      outcome_observed_at: row.chosen_realization?.published_at || nextDay(row.source.observed_at),
      lead_days: row.outcomes.lead_days,
    };
    assertCutoffForecast(forecast);
    return [forecast];
  });
  const leads = positive.map((row) => row.outcomes.lead_days).filter(Number.isFinite);
  const timingRows = positive.filter((row) => row.outcomes.timing !== "not_scored");
  const timingHits = timingRows.filter((row) => row.outcomes.timing === "hit").length;
  const leakageFailures = rows.flatMap((row) => row.leakage.findings.map((finding) => ({ assertion_id: row.id, ...finding })));
  const links = linkMetrics(positive);
  const occurrenceCalibration = aggregateCalibration(forecasts);
  const corpusCoverage = coverage || buildCorpusCoverage({ labeledPack: input });
  const recurrence = {
    value_type: "measured",
    resolved_assertions: positive.filter((row) => row.outcomes.occurrence === "hit").length,
    sufficient_for_recurrent_corpus_claim: Boolean(corpusCoverage.sufficient_for_recurrent_corpus_claim)
      && positive.filter((row) => row.outcomes.occurrence === "hit").length >= 20,
    note: corpusCoverage.limitation,
  };
  const gates = {
    extraction_precision: {
      observed: extraction.precision,
      threshold: PROMOTION_PRECISION_FLOOR,
      passed: extraction.precision >= PROMOTION_PRECISION_FLOOR,
    },
    automatic_realization_link_precision: {
      observed: links.reviewed_precision,
      threshold: PROMOTION_LINK_PRECISION_FLOOR,
      passed: links.reviewed_precision >= PROMOTION_LINK_PRECISION_FLOOR,
    },
    median_positive_lead_days: {
      observed: quantile(leads, 0.5),
      threshold: PROMOTION_LEAD_FLOOR,
      passed: quantile(leads, 0.5) >= PROMOTION_LEAD_FLOOR,
    },
    temporal_integrity: {
      observed_failures: leakageFailures.length,
      threshold: 0,
      passed: leakageFailures.length === 0,
    },
    recurrent_corpus: { ...recurrence, passed: recurrence.sufficient_for_recurrent_corpus_claim },
  };
  return {
    schema: BACKTEST_SCHEMA,
    backtest_version: BACKTEST_VERSION,
    as_of: corpusCoverage.as_of || "2026-08-30",
    corpus: {
      source_artifact: LABELED_FIXTURE_ARTIFACT,
      source_policy: "Council-attributable dated source spans only; official-source citations retained in fixtures",
      from: CORPUS_FROM,
      through: CORPUS_THROUGH,
      status: "bounded_gold_fixture_pack",
      full_corpus: false,
      measured_source_count: rows.length,
      measured_positive_assertions: positive.length,
      measured_negative_controls: rows.length - positive.length,
      retained_app_corpus_council_text_rows: corpusCoverage.retained_app_corpus?.text_bearing_council_rows ?? 0,
      labeled_fixture_year_coverage: corpusCoverage.labeled_fixture?.year_coverage || null,
      retained_corpus_year_coverage: corpusCoverage.retained_app_corpus?.year_coverage || null,
      inclusion_rules: INCLUSION_RULES,
      exclusion_rules: EXCLUSION_RULES,
      coverage_note: corpusCoverage.limitation,
      coverage_receipt: "warehouse/fixtures/procurement-intent-radar/corpus_coverage.v1.json",
    },
    protocol: {
      kind: "per_assertion_temporal_cutoff",
      reconstruction_cutoff: "meeting observed_at after sealing hindsight fields; predictions generated on the next UTC day to satisfy the shared strict pre-split training rule",
      training_from: CORPUS_FROM,
      future_information_allowed: false,
      prediction_inputs: ["source span", "source metadata", "source event clock"],
      excluded_from_prediction_inputs: ["future EPIN/PIN", "solicitation title", "vendor", "later coverage", "future naming features"],
      resolution: "shared evaluatePredictionBacktest exact subject_ref + event_kind join",
      link_resolution: "retrospective matcher; publisher fields are scoring observations, not prediction features",
      evaluator_versions: {
        extractor: EXTRACTION_VERSION,
        realization_matcher: REALIZATION_MATCHER_VERSION,
        prediction_calibration: PREDICTION_CALIBRATION_VERSION,
        forecast_calibration: "worker/src/lib/forecast_calibration.mjs",
      },
    },
    assertions: rows,
    metrics: {
      extraction: { ...extraction, cutoff: "per-assertion observed_at", denominator: extraction.reviewed_sources },
      realization_link: { ...links, cutoff: "retrospective after meeting-date reconstruction", denominator: links.reviewed_pairs },
      abstention: {
        value_type: "measured",
        cutoff: "per-assertion observed_at",
        denominator: rows.length,
        extraction_count: extraction.abstained,
        extraction_rate: round(extraction.abstained / rows.length),
        timing_not_scored_count: positive.filter((row) => row.outcomes.timing === "not_scored").length,
        review_or_unmatched_count: positive.filter((row) => ["review", "unmatched"].includes(row.match.status)).length,
      },
      occurrence: { ...occurrenceCalibration, cutoff: "per-assertion observed_at", denominator: occurrenceCalibration.denominator },
      timing: {
        value_type: "measured",
        cutoff: "agency-stated expected_window vs first accepted realization",
        denominator: timingRows.length,
        assertions_scored: timingRows.length,
        window_hits: timingHits,
        window_misses: timingRows.length - timingHits,
        window_hit_rate: timingRows.length ? round(timingHits / timingRows.length) : null,
        error_categories: Object.fromEntries([...new Set(timingRows.map((row) => row.outcomes.timing_error?.category).filter(Boolean))]
          .map((category) => [category, timingRows.filter((row) => row.outcomes.timing_error?.category === category).length])),
      },
      lead_time_days: {
        value_type: "measured",
        cutoff: "observed_at to first accepted realization published_at",
        denominator: leads.length,
        count: leads.length,
        mean: leads.length ? round(leads.reduce((sum, value) => sum + value, 0) / leads.length, 1) : null,
        p25: quantile(leads, 0.25),
        median: quantile(leads, 0.5),
        p75: quantile(leads, 0.75),
        minimum: leads.length ? Math.min(...leads) : null,
        maximum: leads.length ? Math.max(...leads) : null,
      },
      false_positive_categories: {
        extraction: extractedNegative.length ? [{ category: "unsupported_candidate", count: extractedNegative.length, assertion_ids: extractedNegative.map((row) => row.id) }] : [],
        realization_link: links.false_positive ? [{ category: "incorrect_automatic_link", count: links.false_positive }] : [],
        occurrence: [],
      },
      false_negative_categories: {
        extraction: extraction.false_negative ? [{ category: "missed_manually_reviewed_assertion", count: extraction.false_negative }] : [],
        realization_link: links.false_negative ? [{ category: "unlinked_reviewed_realization", count: links.false_negative }] : [],
        occurrence: positive.filter((row) => row.outcomes.occurrence === "unmatched").length ? [{ category: "unresolved_occurrence", count: positive.filter((row) => row.outcomes.occurrence === "unmatched").length }] : [],
        timing: timingRows.filter((row) => row.outcomes.timing === "miss").length ? [{ category: "published_after_or_before_stated_window", count: timingRows.filter((row) => row.outcomes.timing === "miss").length }] : [],
      },
      unresolved_or_expired: rows.map((row) => ({ id: row.id, status: row.outcomes.resolution_status })),
    },
    temporal_integrity: {
      value_type: "measured",
      leakage_failures: leakageFailures,
      tolerated_failures: 0,
      passed: leakageFailures.length === 0,
    },
    coverage: corpusCoverage,
    promotion: {
      status: "withheld",
      product_promotion_allowed: false,
      gates,
      reason: leakageFailures.length
        ? "Temporal leakage failures are disqualifying; product promotion is not authorized."
        : "Precision and temporal checks on the bounded fixture pack do not establish recurrence for the full 2022–2025 corpus; this result cannot authorize product promotion.",
    },
  };
}

function reportMarkdown(artifact) {
  const { corpus, metrics, promotion } = artifact;
  const pct = (value) => value == null ? "unknown" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# Procurement Intent Radar corpus backtest",
    "",
    `As of ${artifact.as_of}. This is a measured result on the committed gold fixture pack, not an estimate of all Council material from ${corpus.from} through ${corpus.through}.`,
    "",
    `The labeled fixture contains ${corpus.measured_source_count} dated source spans: ${corpus.measured_positive_assertions} manually reviewed future-procurement assertions and ${corpus.measured_negative_controls} negative controls. The retained app corpus currently has ${corpus.retained_app_corpus_council_text_rows} PIR-eligible Council text rows in ${corpus.from}–${corpus.through}, so this backtest does not claim full-corpus coverage.`,
    "",
    "Inclusion: Council-attributable dated testimony, transcript, or briefing-paper spans with official-source citations. Exclusion: Community Board meetings, City Record notices without those passages, future-dated retained meetings, and any post-cutoff EPIN, title, vendor, coverage, or naming feature.",
    "",
    `Evaluator versions: extractor ${artifact.protocol.evaluator_versions.extractor}; matcher ${artifact.protocol.evaluator_versions.realization_matcher}; prediction calibration ${artifact.protocol.evaluator_versions.prediction_calibration}.`,
    "",
    "## Promotion decision",
    "",
    `**Withheld.** Product promotion is not authorized: the fixture pack has only ${metrics.lead_time_days.count} resolved assertions and cannot establish recurrence. The measured precision and temporal checks are reported below but do not override this coverage boundary.`,
    "",
    "| Gate | Measured | Threshold | Result |",
    "| --- | ---: | ---: | --- |",
    `| Extraction precision | ${pct(promotion.gates.extraction_precision.observed)} | ≥90.0% | ${promotion.gates.extraction_precision.passed ? "pass" : "fail"} |`,
    `| Automatic realization-link precision | ${pct(promotion.gates.automatic_realization_link_precision.observed)} | ≥95.0% | ${promotion.gates.automatic_realization_link_precision.passed ? "pass" : "fail"} |`,
    `| Median positive lead | ${promotion.gates.median_positive_lead_days.observed ?? "unknown"} days | ≥30 days | ${promotion.gates.median_positive_lead_days.passed ? "pass" : "fail"} |`,
    `| Temporal leakage failures | ${promotion.gates.temporal_integrity.observed_failures} | 0 | ${promotion.gates.temporal_integrity.passed ? "pass" : "fail"} |`,
    `| Recurrent corpus | ${promotion.gates.recurrent_corpus.resolved_assertions} resolved assertions | sufficient recurrence | ${promotion.gates.recurrent_corpus.passed ? "pass" : "withheld"} |`,
    "",
    "## Aggregate metrics",
    "",
    `- Extraction: ${metrics.extraction.true_positive} true positives, ${metrics.extraction.false_positive} false positives, ${metrics.extraction.false_negative} false negatives; precision ${pct(metrics.extraction.precision)}, recall ${pct(metrics.extraction.recall)}; abstained ${metrics.extraction.abstained}/${metrics.extraction.reviewed_sources}.`,
    `- Realization links: ${metrics.realization_link.true_positive} true-positive automatic links, ${metrics.realization_link.false_positive} false positives, ${metrics.realization_link.false_negative} false negatives; precision ${pct(metrics.realization_link.precision)}, recall ${pct(metrics.realization_link.recall)}.`,
    `- Occurrence calibration: Brier ${metrics.occurrence.brier_score}; maximum calibration gap ${metrics.occurrence.maximum_calibration_gap}; scored ${metrics.occurrence.scored}, abstained ${metrics.occurrence.abstained}.`,
    `- Lead time: mean ${metrics.lead_time_days.mean} days; p25 ${metrics.lead_time_days.p25}; median ${metrics.lead_time_days.median}; p75 ${metrics.lead_time_days.p75}.`,
    `- Timing window: ${metrics.timing.window_hits}/${metrics.timing.assertions_scored} hits (${pct(metrics.timing.window_hit_rate)}); misses are categorized as ${Object.entries(metrics.timing.error_categories).map(([key, value]) => `${key} (${value})`).join(", ") || "none"}.`,
    "",
    "## Cutoff and leakage discipline",
    "",
    "Each candidate is extracted from only its dated source span and metadata. The shared prediction evaluator receives a source opening event before the per-assertion split and resolves only later exact `procurement.notice_published` events. Retrospective publisher identifiers, titles, and clocks are used to score reconciliation, not to reconstruct the historical prediction.",
    "",
    `Leakage failures: ${artifact.temporal_integrity.leakage_failures.length}. Any nonzero value is disqualifying.`,
    "",
    "## Per-assertion results",
    "",
    "| Assertion | Date | Agency | Intent | Realization | Occurrence | Timing | Lead | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | --- |",
    ...artifact.assertions.map((row) => `| ${row.id} | ${row.source.observed_at} | ${row.extracted_intent?.agency || "—"} | ${row.extracted_intent?.object_text || "rejected control"} | ${row.chosen_realization?.realization_ref || "—"} | ${row.outcomes.occurrence} | ${row.outcomes.timing} | ${row.outcomes.lead_days ?? "—"} | ${row.outcomes.resolution_status} |`),
    "",
    "The negative controls remain source evidence without a future-action assertion. The past-tense RFP control contains the string `RFP`, while the three-trigger extractor rejects it; this is why a substring baseline is not used for promotion.",
  ];
  return `${lines.join("\n")}\n`;
}

export function loadDefaultCoverage() {
  return loadCorpusCoverageFromRepo(ROOT, {
    labeledPath: DEFAULT_INPUT,
    meetingsPath: join(ROOT, RETAINED_MEETINGS_ARTIFACT),
    asOf: "2026-08-30",
  });
}

export function buildBacktestArtifact(input, options = {}) {
  const pack = input ?? readJson(DEFAULT_INPUT);
  if (options.coverage) return buildArtifact(pack, { coverage: options.coverage });
  const meetingsPath = join(ROOT, RETAINED_MEETINGS_ARTIFACT);
  const coverage = buildCorpusCoverage({
    labeledPack: pack,
    retainedMeetings: existsSync(meetingsPath) ? readJson(meetingsPath) : { rows: [] },
    retainedMeetingsSha256: existsSync(meetingsPath) ? hashFile(meetingsPath) : null,
    labeledPackSha256: options.labeledPackSha256 ?? null,
    asOf: "2026-08-30",
  });
  return buildArtifact(pack, { coverage });
}

export function writeBacktest({
  input = DEFAULT_INPUT,
  output = DEFAULT_OUTPUT,
  report = DEFAULT_REPORT,
  coverageOutput = DEFAULT_COVERAGE,
} = {}) {
  const coverage = loadCorpusCoverageFromRepo(ROOT, {
    labeledPath: resolve(input),
    meetingsPath: join(ROOT, RETAINED_MEETINGS_ARTIFACT),
    asOf: "2026-08-30",
  });
  const artifact = buildArtifact(readJson(resolve(input)), { coverage });
  writeJson(resolve(output), artifact);
  writeJson(resolve(coverageOutput), coverage);
  mkdirSync(dirname(resolve(report)), { recursive: true });
  writeFileSync(resolve(report), reportMarkdown(artifact), "utf8");
  return artifact;
}

export function checkBacktest({
  input = DEFAULT_INPUT,
  output = DEFAULT_OUTPUT,
  report = DEFAULT_REPORT,
  coverageOutput = DEFAULT_COVERAGE,
} = {}) {
  const coverage = loadCorpusCoverageFromRepo(ROOT, {
    labeledPath: resolve(input),
    meetingsPath: join(ROOT, RETAINED_MEETINGS_ARTIFACT),
    asOf: "2026-08-30",
  });
  const artifact = buildArtifact(readJson(resolve(input)), { coverage });
  if (artifact.temporal_integrity.leakage_failures.length !== 0) {
    throw new Error("corpus backtest has temporal leakage failures; leakage is a hard failure");
  }
  if (!existsSync(resolve(output)) || readFileSync(resolve(output), "utf8") !== `${JSON.stringify(artifact, null, 2)}\n`) {
    throw new Error("corpus backtest JSON is stale; rebuild without --check");
  }
  if (!existsSync(resolve(report)) || readFileSync(resolve(report), "utf8") !== reportMarkdown(artifact)) {
    throw new Error("corpus backtest report is stale; rebuild without --check");
  }
  if (!existsSync(resolve(coverageOutput)) || readFileSync(resolve(coverageOutput), "utf8") !== `${JSON.stringify(coverage, null, 2)}\n`) {
    throw new Error("corpus coverage receipt is stale; rebuild without --check");
  }
  return artifact;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("backtest_procurement_intent_radar.mjs")) {
  const check = process.argv.includes("--check");
  const artifact = check
    ? checkBacktest()
    : writeBacktest();
  console.log(`${check ? "checked" : "wrote"} PIR-4 corpus backtest sources=${artifact.corpus.measured_source_count} leakage_failures=${artifact.temporal_integrity.leakage_failures.length} promotion=${artifact.promotion.status}`);
}
