import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  containsRfpBaseline,
  detectTriggers,
  extractSource,
  extractSources,
  generateCandidate,
  isEligibleHistoricalCouncilSource,
} from "../warehouse/lib/procurement_intent_extractor.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url), "utf8"));

test("Stage 1 requires future, procurement-action, and procurement-object triggers", () => {
  const positive = fixtures.cases.find((item) => item.id === "compass-dycd-2025-05-19").source;
  const negative = fixtures.cases.find((item) => item.id === "negative-past-tense-rfp-2023-04-24").source;
  const triggers = detectTriggers(positive.source_span_text);
  assert.ok(triggers.future.length > 0);
  assert.ok(triggers.action.length > 0);
  assert.ok(triggers.object.length > 0);
  assert.equal(generateCandidate(positive).candidate, true);
  assert.equal(generateCandidate(negative).candidate, false);
});

test("all three positive gold cases produce source-preserving structured assertions", () => {
  const positives = fixtures.cases.filter((item) => item.kind === "positive");
  const rows = extractSources(positives.map((item) => item.source));
  assert.equal(rows.length, 3);
  for (const [index, row] of rows.entries()) {
    const expected = positives[index].expected_future_action_assertion;
    assert.equal(row.status, "candidate");
    assert.deepEqual(row.assertion, { ...expected, extraction_method: "deterministic_rules_v1", extraction_version: "pir-phase1.0" });
    assert.equal(row.candidate.evidence_span.text, expected.source_span);
    assert.equal(row.source.source_span_text, expected.source_span);
  }
});

test("negative controls retain evidence but create no future-action assertion", () => {
  const negatives = fixtures.cases.filter((item) => item.kind === "negative");
  const rows = extractSources(negatives.map((item) => item.source));
  assert.deepEqual(rows.map((row) => row.assertion), [null, null]);
  assert.deepEqual(rows[0].candidate.rejection_reasons, negatives[0].rejection_reasons);
  assert.deepEqual(rows[1].candidate.rejection_reasons, negatives[1].rejection_reasons);
  assert.ok(rows.every((row) => row.source.source_span_text.length > 0));
});

test("contains-RFP baseline admits the past-tense negative while the three-trigger extractor rejects it", () => {
  const negative = fixtures.cases.find((item) => item.id === "negative-past-tense-rfp-2023-04-24").source;
  assert.equal(containsRfpBaseline(negative.source_span_text), true);
  assert.equal(generateCandidate(negative).candidate, false);
});

test("assertion extraction reads only the supplied source record", () => {
  for (const item of fixtures.cases) {
    const row = extractSource(item.source);
    const upstream = JSON.stringify({ source: row.source, candidate: row.candidate, assertion: row.assertion });
    for (const realization of item.expected_outcome.realization.realized_procurements) assert.equal(upstream.includes(realization.epin), false);
    if (item.expected_outcome.realization.realized_at) assert.equal(upstream.includes(item.expected_outcome.realization.realized_at), false);
  }
});

test("historical eligibility is bounded to Council-attributable source types and 2022-2025 dates", () => {
  const source = fixtures.cases[0].source;
  assert.equal(isEligibleHistoricalCouncilSource(source), true);
  assert.equal(isEligibleHistoricalCouncilSource({ ...source, observed_at: "2026-01-01" }), false);
  assert.equal(isEligibleHistoricalCouncilSource({ ...source, source_type: "city_record_notice" }), false);
  assert.equal(isEligibleHistoricalCouncilSource({ ...source, source_span_text: "" }), false);
});
