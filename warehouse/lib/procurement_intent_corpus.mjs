/**
 * PIR-4 corpus coverage, cutoff sealing, and leakage evaluation.
 *
 * The five-case gold pack is a labeled fixture control. This module measures
 * whether a recurrent 2022–2025 Council-text corpus is actually retained and
 * seals historical reconstruction so later publisher fields cannot enter
 * candidate generation.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extractSource } from "./procurement_intent_extractor.mjs";
import { assertHistoricalIntent } from "./procurement_intent_realization_matcher.mjs";
import { assertNoTemporalLeakage } from "../../worker/src/lib/forecast_calibration.mjs";

export const CORPUS_COVERAGE_SCHEMA = "cityscroll.procurement_intent_radar.corpus_coverage.v1";
export const CORPUS_COVERAGE_VERSION = "pir-corpus-coverage.v1";
export const CORPUS_FROM = "2022-01-01";
export const CORPUS_THROUGH = "2025-12-31";
export const RETAINED_MEETINGS_ARTIFACT = "site/data/shared_meeting_read_model.json";
export const LABELED_FIXTURE_ARTIFACT = "test/fixtures/procurement_intent_radar/gold_fixtures.v0.json";

export const PIR_SOURCE_TYPES = Object.freeze([
  "agency_testimony",
  "council_transcript",
  "council_briefing_paper",
]);

export const INCLUSION_RULES = Object.freeze([
  "Council-attributable dated source spans only",
  "source_type is agency_testimony, council_transcript, or council_briefing_paper",
  "observed_at is a calendar day from 2022-01-01 through 2025-12-31",
  "official-source citations are retained with the source span",
]);

export const EXCLUSION_RULES = Object.freeze([
  "Community Board meetings",
  "City Record meeting notices without transcript, testimony, or briefing-paper passages",
  "future-dated retained meeting rows",
  "future EPIN/PIN, solicitation title, vendor, later coverage, and future naming features",
  "unofficial secondary coverage used as a historical feature",
]);

export const HINDSIGHT_FIELDS = Object.freeze([
  "epin",
  "pin",
  "vendor",
  "vendor_ref",
  "vendor_name",
  "published_at",
  "realized_at",
  "realized_by",
  "later_title",
  "coverage",
  "procurement_id",
  "solicitation_id",
  "solicitation_title",
]);

const HISTORICAL_SOURCE_FIELDS = Object.freeze([
  "source_record_id",
  "source_event_id",
  "observed_at",
  "observed_at_precision",
  "speaker",
  "source_type",
  "source_title",
  "source_span_text",
  "span_text_status",
  "citations",
  "extraction_context",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isoDay(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/u);
  return match ? match[1] : null;
}

function inCorpusWindow(day) {
  return Boolean(day && day >= CORPUS_FROM && day <= CORPUS_THROUGH);
}

function yearOf(day) {
  return day ? day.slice(0, 4) : null;
}

export function stripHindsightFields(value) {
  if (Array.isArray(value)) return value.map(stripHindsightFields);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (HINDSIGHT_FIELDS.includes(key)) continue;
    next[key] = stripHindsightFields(child);
  }
  return next;
}

export function sealHistoricalSource(source) {
  const sealed = {};
  for (const field of HISTORICAL_SOURCE_FIELDS) {
    if (Object.hasOwn(source || {}, field)) sealed[field] = clone(source[field]);
  }
  return stripHindsightFields(sealed);
}

export function scanHindsightFields(value, path = "") {
  const findings = [];
  if (!value || typeof value !== "object") return findings;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (HINDSIGHT_FIELDS.includes(key)) {
      findings.push({ type: "hindsight_field", path: childPath, field: key });
    }
    findings.push(...scanHindsightFields(child, childPath));
  }
  return findings;
}

export function reconstructAtCutoff(source) {
  const sealed = sealHistoricalSource(source);
  const extracted = extractSource(sealed);
  return {
    cutoff: sealed.observed_at || null,
    sealed,
    extracted,
  };
}

export function leakageCheck({ fixture, extracted, realizations = [] }) {
  const upstream = {
    source: extracted.source,
    candidate: extracted.candidate,
    assertion: extracted.assertion,
  };
  const findings = scanHindsightFields(upstream);
  const serialized = JSON.stringify(upstream);
  const historicalLabels = [
    fixture?.source?.source_span_text || "",
    extracted.assertion?.object_text || "",
  ];
  for (const row of realizations) {
    for (const [field, value] of Object.entries({
      epin: row.epin,
      title: row.title,
      vendor: row.vendor,
      published_at: row.published_at,
    })) {
      if (!value) continue;
      const text = String(value);
      const historicallyPresent = historicalLabels.some((label) => label.includes(text));
      if (!historicallyPresent && serialized.includes(text)) {
        findings.push({ type: "future_value_in_upstream", field, value: text });
      }
    }
  }
  if (extracted.assertion) {
    try {
      assertHistoricalIntent({ stated_intent: extracted.assertion });
    } catch (error) {
      findings.push({
        type: "hindsight_in_stated_intent",
        message: String(error?.message || error),
      });
    }
  }
  return {
    passed: findings.length === 0,
    checked: [
      "future EPIN/PIN",
      "solicitation title",
      "vendor",
      "later coverage fields",
      "future publication clock",
      "future naming features",
    ],
    findings,
    historical_input_only: true,
    negative_control: fixture?.kind === "negative",
    reconstruction_cutoff: extracted.source?.observed_at || fixture?.source?.observed_at || null,
  };
}

export function assertCutoffForecast(prediction) {
  return assertNoTemporalLeakage(prediction);
}

export function emptyYearBuckets() {
  return { 2022: 0, 2023: 0, 2024: 0, 2025: 0 };
}

export function labeledFixtureCoverage(pack) {
  const cases = Array.isArray(pack?.cases) ? pack.cases : [];
  const years = emptyYearBuckets();
  const vintages = cases.map((row) => {
    const observedAt = isoDay(row.source?.observed_at);
    const year = yearOf(observedAt);
    if (years[year] != null) years[year] += 1;
    return {
      id: row.id,
      kind: row.kind,
      observed_at: observedAt,
      source_type: row.source?.source_type || null,
      source_record_id: row.source?.source_record_id || null,
      citation_url: row.source?.citations?.[0]?.url || null,
      citation_authority: row.source?.citations?.[0]?.authority || null,
      in_corpus_window: inCorpusWindow(observedAt),
    };
  });
  return {
    artifact: LABELED_FIXTURE_ARTIFACT,
    schema: pack?.schema || null,
    fixture_version: pack?.fixture_version || null,
    case_count: cases.length,
    positive_assertions: cases.filter((row) => row.kind === "positive").length,
    negative_controls: cases.filter((row) => row.kind === "negative").length,
    year_coverage: years,
    vintages,
    role: "labeled_fixture_control",
    recurrent_corpus_claim: false,
  };
}

export function measureRetainedMeetingCorpus(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const years = emptyYearBuckets();
  let outsideWindow = 0;
  let pirEligible = 0;
  let cityCouncilAgency = 0;
  let textBearingEligible = 0;
  for (const row of rows) {
    const day = isoDay(row.event_date || row.observed_at);
    if (inCorpusWindow(day)) years[yearOf(day)] += 1;
    else outsideWindow += 1;
    if (row.agency === "City Council") cityCouncilAgency += 1;
    if (PIR_SOURCE_TYPES.includes(row.source_type) && inCorpusWindow(day)) {
      pirEligible += 1;
      const texts = [row.transcript, row.testimony, row.briefing_paper, row.source_span_text, row.text, row.body];
      if (texts.some((value) => typeof value === "string" && value.trim())) textBearingEligible += 1;
    }
  }
  return {
    artifact: RETAINED_MEETINGS_ARTIFACT,
    schema: payload?.schema || null,
    generated_at: payload?.generated_at || payload?.freshness?.generated_at || null,
    checked_at: payload?.freshness?.checked_at || null,
    row_count: rows.length,
    event_dates_in_corpus_window: Object.values(years).reduce((sum, value) => sum + value, 0),
    event_dates_outside_corpus_window: outsideWindow,
    year_coverage: years,
    city_council_agency_rows: cityCouncilAgency,
    pir_eligible_source_type_rows: pirEligible,
    text_bearing_council_rows: textBearingEligible,
    note: "The retained meeting read model is a current/upcoming meeting snapshot. It does not retain 2022–2025 Council transcripts, agency testimony, or Finance Division briefing papers.",
  };
}

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildCorpusCoverage({
  labeledPack,
  retainedMeetings,
  retainedMeetingsSha256 = null,
  labeledPackSha256 = null,
  asOf = "2026-08-30",
} = {}) {
  const labeled = labeledFixtureCoverage(labeledPack);
  const retained = measureRetainedMeetingCorpus(retainedMeetings);
  const sufficient = labeled.positive_assertions >= 20 && retained.text_bearing_council_rows > 0;
  return {
    schema: CORPUS_COVERAGE_SCHEMA,
    coverage_version: CORPUS_COVERAGE_VERSION,
    as_of: asOf,
    from: CORPUS_FROM,
    through: CORPUS_THROUGH,
    inclusion_rules: INCLUSION_RULES,
    exclusion_rules: EXCLUSION_RULES,
    labeled_fixture: {
      ...labeled,
      sha256: labeledPackSha256,
    },
    retained_app_corpus: {
      ...retained,
      sha256: retainedMeetingsSha256,
    },
    sufficient_for_recurrent_corpus_claim: sufficient,
    limitation: "Labeled gold cases are fixture controls spanning 2022–2025. They are not a recurrent estimate of all Council material. The retained app meeting corpus currently contributes zero PIR-eligible 2022–2025 source spans.",
  };
}

export function loadCorpusCoverageFromRepo(root, {
  labeledPath,
  meetingsPath,
  asOf = "2026-08-30",
} = {}) {
  const labeled = JSON.parse(readFileSync(labeledPath, "utf8"));
  const meetings = existsSync(meetingsPath)
    ? JSON.parse(readFileSync(meetingsPath, "utf8"))
    : { rows: [], generated_at: null };
  return buildCorpusCoverage({
    labeledPack: labeled,
    retainedMeetings: meetings,
    retainedMeetingsSha256: existsSync(meetingsPath) ? hashFile(meetingsPath) : null,
    labeledPackSha256: hashFile(labeledPath),
    asOf,
  });
}
