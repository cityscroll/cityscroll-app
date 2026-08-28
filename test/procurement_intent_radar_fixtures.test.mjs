/**
 * Phase 0 executable gate for Procurement Intent Radar's versioned gold fixtures.
 *
 * verify: node --test test/procurement_intent_radar_fixtures.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const FIXTURE_URL = new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url);
const SCHEMA_URL = new URL("./fixtures/procurement_intent_radar/schema.v0.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
const schema = JSON.parse(readFileSync(SCHEMA_URL, "utf8"));

const ASSERTION_FIELDS = [
  "assertion_id",
  "source_record_id",
  "source_event_id",
  "source_span",
  "observed_at",
  "asserted_by_person_ref",
  "responsible_agency_ref",
  "action_kind",
  "object_text",
  "program_refs",
  "procurement_type",
  "quantity_assertions",
  "money_assertions",
  "geography_refs",
  "population_terms",
  "expected_window",
  "modality",
  "conditions",
  "extraction_method",
  "extraction_version",
  "extraction_confidence",
];
const MODALITIES = new Set(["committed", "planned", "anticipated", "preparing", "hoped", "conditional", "reported"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireKeys(value, keys, label) {
  assert.ok(isObject(value), `${label} must be an object`);
  for (const key of keys) assert.ok(Object.hasOwn(value, key), `${label} missing ${key}`);
}

function date(value, label) {
  assert.match(value, DATE_RE, `${label} must be an ISO date`);
  assert.equal(Number.isNaN(Date.parse(`${value}T00:00:00Z`)), false, `${label} must be a real date`);
}

function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function validateSource(source, label) {
  requireKeys(source, [
    "source_record_id", "source_event_id", "observed_at", "speaker", "source_type",
    "source_span_text", "citations",
  ], label);
  date(source.observed_at, `${label}.observed_at`);
  requireKeys(source.speaker, ["display_name"], `${label}.speaker`);
  assert.equal(typeof source.speaker.display_name, "string");
  assert.ok(source.speaker.display_name.length > 0);
  assert.ok(["agency_testimony", "council_transcript", "council_briefing_paper"].includes(source.source_type));
  assert.equal(typeof source.source_span_text, "string");
  assert.ok(source.source_span_text.length > 0);
  assert.ok(Array.isArray(source.citations));
  for (const citation of source.citations) {
    requireKeys(citation, ["label", "url", "authority"], `${label}.citation`);
    assert.match(citation.url, /^https:\/\//);
  }
}

function validateAssertion(assertion, source, label) {
  requireKeys(assertion, ASSERTION_FIELDS, label);
  for (const field of ["assertion_id", "source_record_id", "source_event_id", "source_span", "extraction_method", "extraction_version"]) {
    assert.equal(typeof assertion[field], "string", `${label}.${field} must be a string`);
    assert.ok(assertion[field].length > 0, `${label}.${field} must not be empty`);
  }
  assert.equal(assertion.source_record_id, source.source_record_id);
  assert.equal(assertion.source_event_id, source.source_event_id);
  assert.equal(assertion.source_span, source.source_span_text);
  assert.equal(assertion.observed_at, source.observed_at);
  date(assertion.observed_at, `${label}.observed_at`);
  assert.equal(assertion.action_kind, "procurement.solicitation_publish");
  assert.equal(assertion.procurement_type, "RFP");
  assert.ok(Array.isArray(assertion.program_refs));
  assert.ok(Array.isArray(assertion.quantity_assertions));
  assert.ok(Array.isArray(assertion.money_assertions));
  assert.ok(Array.isArray(assertion.geography_refs));
  assert.ok(Array.isArray(assertion.population_terms));
  assert.ok(Array.isArray(assertion.conditions));
  assert.ok(isObject(assertion.expected_window));
  requireKeys(assertion.expected_window, ["earliest", "latest", "precision", "raw_text"], `${label}.expected_window`);
  if (assertion.expected_window.earliest !== null) date(assertion.expected_window.earliest, `${label}.expected_window.earliest`);
  if (assertion.expected_window.latest !== null) date(assertion.expected_window.latest, `${label}.expected_window.latest`);
  assert.equal(typeof assertion.expected_window.raw_text, "string");
  assert.ok(MODALITIES.has(assertion.modality), `${label}.modality is outside the grammar`);
  assert.equal(assertion.extraction_confidence, "high");
}

function validateOutcome(outcome, assertion, source, label) {
  requireKeys(outcome, ["occurrence", "timing", "cardinality", "lead_days", "match_confidence", "realization"], label);
  requireKeys(outcome.cardinality, ["intent_count", "realized_count", "relation"], `${label}.cardinality`);
  requireKeys(outcome.realization, [
    "realized_at", "realized_procurements", "retained_data_present",
    "retained_data_checked_at", "retained_data_checked_artifacts",
  ], `${label}.realization`);
  date(outcome.realization.retained_data_checked_at, `${label}.realization.retained_data_checked_at`);
  assert.equal(typeof outcome.realization.retained_data_present, "boolean");
  assert.ok(Array.isArray(outcome.realization.realized_procurements));
  assert.ok(Array.isArray(outcome.realization.retained_data_checked_artifacts));

  if (!assertion) {
    assert.equal(outcome.occurrence, "not_applicable");
    assert.equal(outcome.timing, "not_applicable");
    assert.equal(outcome.cardinality.intent_count, 0);
    assert.equal(outcome.cardinality.realized_count, 0);
    assert.equal(outcome.cardinality.relation, "none");
    assert.equal(outcome.lead_days, null);
    assert.equal(outcome.realization.realized_at, null);
    assert.deepEqual(outcome.realization.realized_procurements, []);
    return;
  }

  date(outcome.realization.realized_at, `${label}.realization.realized_at`);
  assert.equal(outcome.cardinality.intent_count, 1);
  assert.equal(outcome.cardinality.realized_count, outcome.realization.realized_procurements.length);
  assert.ok(["one_to_one", "one_to_many"].includes(outcome.cardinality.relation));
  assert.ok(outcome.cardinality.realized_count > 0);
  assert.ok(["hit", "miss"].includes(outcome.occurrence));
  assert.ok(["hit", "miss"].includes(outcome.timing));
  assert.equal(outcome.occurrence, "hit");
  assert.equal(outcome.lead_days, daysBetween(source.observed_at, outcome.realization.realized_at));
  assert.equal(outcome.lead_days >= 0, true);
  const { earliest, latest } = assertion.expected_window;
  if (outcome.timing === "hit") {
    assert.ok(earliest && latest, `${label} timing hit requires a bounded expected window`);
    assert.ok(outcome.realization.realized_at >= earliest && outcome.realization.realized_at <= latest);
  } else if (earliest && latest) {
    assert.ok(outcome.realization.realized_at < earliest || outcome.realization.realized_at > latest);
  } else if (latest) {
    assert.ok(outcome.realization.realized_at > latest);
  }
  for (const row of outcome.realization.realized_procurements) {
    requireKeys(row, ["epin", "title", "source_system", "citation_url"], `${label}.realized_procurement`);
    assert.match(row.citation_url, /^https:\/\//);
    assert.match(row.epin, /^\d{5}[A-Z]\d{4}$/);
  }
}

test("Phase 0 fixture pack and future_action_assertion.v0 fields are schema-valid", () => {
  assert.equal(schema.$id, fixtures.schema);
  assert.equal(schema.$defs.assertion.properties.action_kind.const, "procurement.solicitation_publish");
  assert.deepEqual(Object.keys(schema.$defs.assertion.properties).sort(), [...ASSERTION_FIELDS].sort());
  assert.equal(fixtures.schema, "cityscroll.procurement_intent_radar.fixtures.v0");
  assert.match(fixtures.fixture_version, /^\d+\.\d+\.\d+$/);
  assert.equal(fixtures.cases.length, 5);
  for (const fixture of fixtures.cases) {
    requireKeys(fixture, ["id", "kind", "source", "expected_future_action_assertion", "expected_outcome", "match_evidence_anchors"], fixture.id);
    assert.ok(["positive", "negative"].includes(fixture.kind));
    validateSource(fixture.source, `${fixture.id}.source`);
    const assertion = fixture.expected_future_action_assertion;
    if (fixture.kind === "positive") assert.ok(assertion);
    if (assertion) validateAssertion(assertion, fixture.source, `${fixture.id}.assertion`);
    validateOutcome(fixture.expected_outcome, assertion, fixture.source, `${fixture.id}.outcome`);
  }
});

test("positive outcomes preserve occurrence/timing split, cardinality, and seeded lead days", () => {
  const expected = new Map([
    ["compass-dycd-2025-05-19", ["hit", "hit", "one_to_many", 2, 135]],
    ["hra-dv-beds-2024-10-09", ["hit", "miss", "one_to_one", 1, 149]],
    ["acs-atd-2022-03-09", ["hit", "miss", "one_to_one", 1, 219]],
  ]);
  for (const fixture of fixtures.cases.filter((row) => row.kind === "positive")) {
    const [occurrence, timing, relation, realizedCount, leadDays] = expected.get(fixture.id);
    const outcome = fixture.expected_outcome;
    assert.deepEqual([
      outcome.occurrence,
      outcome.timing,
      outcome.cardinality.relation,
      outcome.cardinality.realized_count,
      outcome.lead_days,
    ], [occurrence, timing, relation, realizedCount, leadDays], fixture.id);
  }
});

test("realization provenance is honest about the current retained-data snapshot", () => {
  for (const fixture of fixtures.cases) {
    const realization = fixture.expected_outcome.realization;
    assert.equal(realization.retained_data_present, false, `${fixture.id} must not claim an unretained row`);
    for (const artifact of realization.retained_data_checked_artifacts) {
      assert.equal(artifact.exact_identifier_found, false, `${fixture.id} has an unverified retained identifier`);
    }
  }
});

test("upstream fixture fields cannot contain post-assertion realization facts", () => {
  for (const fixture of fixtures.cases) {
    const upstream = JSON.stringify({ source: fixture.source, assertion: fixture.expected_future_action_assertion });
    const outcome = fixture.expected_outcome.realization;
    for (const row of outcome.realized_procurements) {
      assert.equal(upstream.includes(row.epin), false, `${fixture.id} leaks realized EPIN upstream`);
    }
    if (outcome.realized_at) assert.equal(upstream.includes(outcome.realized_at), false, `${fixture.id} leaks realized date upstream`);
  }
});

test("negative controls reject high-confidence assertions while retaining evidence", () => {
  const negativeA = fixtures.cases.find((fixture) => fixture.id === "negative-reported-recollection-2025-03-20");
  const negativeB = fixtures.cases.find((fixture) => fixture.id === "negative-past-tense-rfp-2023-04-24");
  assert.equal(negativeA.expected_future_action_assertion, null);
  assert.deepEqual(negativeA.rejection_reasons, ["reported_speech", "historical_commitment", "revised_plans", "no_current_agency_commitment"]);
  assert.equal(negativeB.expected_future_action_assertion, null);
  assert.ok(negativeB.source.source_span_text.includes("RFP"));
  assert.ok(negativeB.rejection_reasons.includes("past_tense"));
  assert.ok(negativeB.rejection_reasons.includes("contains_rfp_baseline_must_fail"));
});
