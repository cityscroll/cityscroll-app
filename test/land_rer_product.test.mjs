// LDP-27: the bounded filing-evidence product built on top of LDP-23
// (obligation), LDP-24 (document manifest), LDP-25 (RER extraction), and
// LDP-26 (filing sequence). These tests exercise the product-building
// functions directly against fixtures shaped exactly like those cards'
// own real output -- never a paraphrase of their enums or copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FILING_APPLICABILITY_STATES,
  FILING_FULFILLMENT_STATES,
  FILING_QUALITY_STATES,
  FORBIDDEN_FILING_OBSERVATION_SYNONYMS,
  assertNoForbiddenFilingObservationSynonym,
  buildLandUseFilingDocument,
  buildLandUseFilingObligation,
  buildRacialEquityReportEnvelope,
  racialEquityReportGoverningAuthority,
} from "../ontology/land_use_filing.mjs";
import { buildExtractedField, buildCommunityProfileSection, buildDisplacementRiskSection, buildFairHousingNarrativeSection } from "../ontology/racial_equity_report_fields.mjs";
import { materializeLandFilingSequence, FILING_SEQUENCE_EVENT_KINDS, FILING_SEQUENCE_CONFLICT_STATES } from "../warehouse/lib/land_filing_sequence.mjs";
import {
  FILING_EVIDENCE_SEARCH_FILTERS,
  LAND_FILING_EVIDENCE_REPORT_DETAIL_SCHEMA,
  LAND_FILING_EVIDENCE_SUMMARY_SCHEMA,
  buildLandFilingEvidenceReportDetail,
  buildLandFilingEvidenceSummary,
  landFilingApplicabilityExplanationKey,
  landFilingFulfillmentExplanationKey,
  withLandFilingEvidenceReport,
} from "../site/land_filing_evidence.mjs";
import {
  FILING_APPLICABILITY_EXPLANATION_KEYS,
  FILING_FULFILLMENT_EXPLANATION_KEYS,
  LAND_FILING_EVIDENCE_OPTIONS,
  landRowMatchesFilingEvidenceFilter,
  normalizeLandFilingEvidenceFilter,
} from "../site/land_filing_evidence_facet.mjs";
import {
  landFilingEvidenceSummaryHTML,
  landFilingHistoryHTML,
} from "../site/land_filing_evidence_view.mjs";
import { landFilingReportDetailHTML } from "../site/app/land_filing_report_runtime.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";

const i18nSource = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const EN_COPY = new Map();
for (const match of i18nSource.matchAll(/^\s+(land_filing_[a-z0-9_]+):\s*"((?:\\.|[^"\\])*)"/gm)) {
  EN_COPY.set(match[1], match[2].replace(/\\"/g, '"'));
}
function t(key, vars) {
  let text = EN_COPY.get(key) ?? key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(vars, name) ? String(vars[name] ?? "") : all);
  return text;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

const NOW = "2026-06-01T00:00:00.000Z";
const HASH_A = "a".repeat(64);

function buildObligation(overrides = {}) {
  return buildLandUseFilingObligation({
    obligation_id: "land_use_filing_obligation:2025M0252:racial_equity_report",
    project_ref: "project:2025M0252",
    obligation_type: "racial_equity_report",
    governing_authority: [racialEquityReportGoverningAuthority()],
    applicability: {
      state: "required",
      criteria: [],
      publisher_assertion: { source_field: "dcp-applicability", source_value: "Yes", observed_at: NOW },
    },
    fulfillment: { state: "not_observed", document_refs: [] },
    procedural_effect: { certification_blocker: false, missing_report_notification_required: "unknown" },
    observed_at: NOW,
    available_to_public_at: NOW,
    materialized_at: NOW,
    source_id: "nyc-zap-open-data",
    source_record_id: "2025M0252",
    source_vintage: NOW,
    normalization_version: "ldp23.v1",
    ...overrides,
  });
}

function buildDocument(overrides = {}) {
  return buildLandUseFilingDocument({
    project_ref: "project:2025M0252",
    document_type: "racial_equity_report",
    publisher_document_id: "doc-1",
    original_name: "Racial Equity Report.pdf",
    first_observed_at: NOW,
    available_to_public_at: NOW,
    retrieval_status: "fetched",
    bytes_sha256: HASH_A,
    byte_length: 1000,
    classification: { method: "explicit_publisher_type_or_group", evidence: ["publisher group: RER"], confidence: "high" },
    canonical_public_url: "https://zap.planning.nyc.gov/projects/2025M0252/documents/doc-1.pdf",
    ...overrides,
  });
}

function field(fieldName, extra = {}) {
  return buildExtractedField({
    field_name: fieldName,
    value: extra.value ?? "example",
    raw_value: extra.raw_value ?? "example",
    evidence: extra.evidence ?? { page_number: 4 },
    method: "deterministic_text",
    extractor_version: "ldp25_rer_extractor.v1",
    confidence: "high",
    ...extra,
  });
}

function buildEnvelope(document, overrides = {}) {
  return buildRacialEquityReportEnvelope({
    document_ref: document.document_id,
    project_ref: "project:2025M0252",
    report_preparation_date: "2025-03-01",
    source_bytes_sha256: HASH_A,
    extraction_version: "ldp25_rer_extractor.v1",
    extraction_quality: "high",
    application_scope: { project_name: field("project_name") },
    proposed_development_scope: { residential_units_proposed: field("residential_units_proposed", { value: 120, unit: "units" }) },
    residential: {},
    non_residential: {},
    construction_employment: {},
    community_profile: buildCommunityProfileSection({
      geography: "Community District 7",
      vintage: "2020 ACS",
      methodology_state: "measured",
      indicators: { population: field("population", { value: 45000, unit: "residents" }) },
    }),
    displacement_risk: buildDisplacementRiskSection({
      interpretation: "contextual_not_project_prediction",
      geography: "Community District 7",
      vintage: "2020 ACS",
      methodology_state: "measured",
      index_value: { value: 0.4, raw_value: "0.4", evidence: { page_number: 9 }, method: "deterministic_text", extractor_version: "ldp25_rer_extractor.v1", confidence: "medium" },
    }),
    fair_housing_narrative: buildFairHousingNarrativeSection({
      source: "applicant_narrative",
      text: "The applicant states the project advances fair housing goals.",
      evidence: { page_number: 12 },
    }),
    field_evidence: { field_count: 3, abstained_count: 0, abstention_ratio: 0, by_method: { deterministic_text: 3 }, by_confidence: { high: 2, medium: 1 }, overall_quality: "high" },
    ...overrides,
  });
}

/* ===== A8: only the three factual filters, never a judgemental one ===== */

test("A8 the filing-evidence search filter offers only the three factual states", () => {
  assert.deepEqual(
    [...FILING_EVIDENCE_SEARCH_FILTERS].sort(),
    ["document_observed", "publisher_identifies_not_timely_filed", "required"].sort(),
  );
  for (const value of FILING_EVIDENCE_SEARCH_FILTERS) {
    assert.ok(
      FILING_APPLICABILITY_STATES.includes(value) || FILING_FULFILLMENT_STATES.includes(value),
      `${value} must be a real applicability or fulfillment state`,
    );
  }
  const forbidden = /\b(noncompliant|equitable|inequitable|high-?risk|certification-?ready|likely-?to-?be-?certified)\b/i;
  for (const value of FILING_EVIDENCE_SEARCH_FILTERS) assert.doesNotMatch(value, forbidden);
  for (const word of FORBIDDEN_FILING_OBSERVATION_SYNONYMS) {
    assert.ok(!FILING_EVIDENCE_SEARCH_FILTERS.includes(word), `filter list must not include forbidden synonym "${word}"`);
  }
  // The browser-facing options list (site/land_filing_evidence_facet.mjs) must offer
  // exactly "any" plus these three -- never a fourth, judgemental value.
  const optionIds = LAND_FILING_EVIDENCE_OPTIONS.map((o) => o.id).filter((id) => id !== "any");
  assert.deepEqual([...optionIds].sort(), [...FILING_EVIDENCE_SEARCH_FILTERS].sort());
});

test("A8 filterLandSnapshot narrows rows by the filing-evidence filter and leaves nullable rows out of specific filters", () => {
  const rows = [
    { project_id: "1", project_status: "Active", filing_evidence: { applicability: { state: "required" }, fulfillment: { state: "not_observed" } } },
    { project_id: "2", project_status: "Active", filing_evidence: { applicability: { state: "not_required" }, fulfillment: { state: "document_observed" } } },
    { project_id: "3", project_status: "Active" }, // no filing_evidence at all (A9: an older/out-of-scope record)
  ];
  assert.deepEqual(filterLandSnapshot(rows, { status: "active", filingEvidence: "required" }).map((r) => r.project_id), ["1"]);
  assert.deepEqual(filterLandSnapshot(rows, { status: "active", filingEvidence: "document_observed" }).map((r) => r.project_id), ["2"]);
  assert.equal(filterLandSnapshot(rows, { status: "active", filingEvidence: "any" }).length, 3);
  assert.equal(normalizeLandFilingEvidenceFilter("not-a-real-value"), "any");
  assert.equal(landRowMatchesFilingEvidenceFilter(rows[2], "required"), false);
  assert.equal(landRowMatchesFilingEvidenceFilter(rows[2], "any"), true);
});

/* ===== A4: filing evidence never fuses with environmental review, authority, or the Commission outcome ===== */

test("A4 the filing-evidence summary carries only filing-evidence keys", () => {
  const obligation = buildObligation();
  const summary = buildLandFilingEvidenceSummary({ obligation, materializedAt: NOW });
  assert.equal(summary.schema, LAND_FILING_EVIDENCE_SUMMARY_SCHEMA);
  const keys = Object.keys(summary);
  for (const forbiddenKey of ["authority_summary", "environmental_review", "ceqr", "seqra", "commission_outcome", "outcome"]) {
    assert.ok(!keys.includes(forbiddenKey), `summary must not carry a ${forbiddenKey} key`);
  }
  assert.deepEqual(
    keys.sort(),
    ["applicability", "filing_history_digest", "fulfillment", "materialized_at", "obligation_id", "procedural_effect", "project_ref", "report", "schema"].sort(),
  );
  // Never smuggled into a CEQR/SEQRA identity either (mirrors the ontology's own guard).
  assert.doesNotMatch(JSON.stringify(summary), /"ceqr_ref"|"seqra_ref"/);
});

test("A4 the structured report detail carries no environmental/authority/outcome fields", () => {
  const document = buildDocument();
  const envelope = buildEnvelope(document);
  const detail = buildLandFilingEvidenceReportDetail({ document, rerEnvelope: envelope });
  assert.equal(detail.schema, LAND_FILING_EVIDENCE_REPORT_DETAIL_SCHEMA);
  const json = JSON.stringify(detail);
  for (const forbidden of ["ceqr_ref", "seqra_ref", "authority_summary", "commission_outcome"]) {
    assert.doesNotMatch(json, new RegExp(`"${forbidden}"`));
  }
});

/* ===== A1: project -> obligation -> typed report -> a cited field and page -> the original source ===== */

test("A1 the positive specimen supports navigation from obligation to a cited field and page to the original source", () => {
  const obligation = buildObligation({
    fulfillment: { state: "document_observed", document_refs: [buildDocument().document_id] },
  });
  const document = buildDocument();
  const envelope = buildEnvelope(document);
  let summary = buildLandFilingEvidenceSummary({ obligation, documents: [document], materializedAt: NOW });
  summary = withLandFilingEvidenceReport(summary, { obligation, documents: [document], rerEnvelope: envelope });
  assert.equal(summary.report.document_ref, document.document_id);
  assert.equal(summary.report.original_document.canonical_public_url, document.canonical_public_url);
  assert.equal(summary.report.extraction_quality, "high");

  const detail = buildLandFilingEvidenceReportDetail({ document, rerEnvelope: envelope });
  const cited = detail.application_scope.project_name;
  assert.equal(cited.evidence.page_number, 4);
  assert.equal(cited.raw_value, "example");
  assert.equal(detail.original_document.canonical_public_url, document.canonical_public_url);

  // The rendered HTML actually carries the citation and the source link through to the DOM.
  const html = landFilingReportDetailHTML(detail, { t, escape: esc });
  assert.match(html, /land_filing_page_citation|page 4|4/);
  assert.match(html, new RegExp(document.canonical_public_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

/* ===== A2 / G1: an active-required, unobserved project never says "not filed", "blocked", or "failed" ===== */

test("A2 an active required project with no observed document states the observed condition exactly, never a forbidden synonym", () => {
  const obligation = buildObligation(); // required + not_observed
  const summary = buildLandFilingEvidenceSummary({ obligation, materializedAt: NOW });
  assert.equal(summary.applicability.state, "required");
  assert.equal(summary.fulfillment.state, "not_observed");
  assert.equal(summary.report, null);

  const html = landFilingEvidenceSummaryHTML(summary, { t, escape: esc });
  assert.match(html, /data-fulfillment-state="not_observed"/);
  assert.doesNotMatch(html.toLowerCase(), /not filed|blocked|failed/);
  assertNoForbiddenFilingObservationSynonym(html, "rendered filing-evidence HTML");

  const fulfillmentCopy = t(landFilingFulfillmentExplanationKey("not_observed"));
  assert.doesNotMatch(fulfillmentCopy.toLowerCase(), /not filed|blocked|failed/);
  assertNoForbiddenFilingObservationSynonym(fulfillmentCopy, "not_observed copy");
});

/* ===== A3: a not-required project and a pre-effective project render different explanations ===== */

test("A3 not_required and not_yet_effective applicability states render distinct explanations", () => {
  const notRequiredKey = landFilingApplicabilityExplanationKey("not_required");
  const notYetEffectiveKey = landFilingApplicabilityExplanationKey("not_yet_effective");
  assert.notEqual(notRequiredKey, notYetEffectiveKey);
  assert.notEqual(t(notRequiredKey), t(notYetEffectiveKey));

  // Every applicability state gets its own key -- none doubles up with another.
  const keys = FILING_APPLICABILITY_STATES.map((state) => FILING_APPLICABILITY_EXPLANATION_KEYS[state]);
  assert.equal(new Set(keys).size, keys.length, "every applicability state must have a distinct explanation key");
  assert.ok(keys.every(Boolean), "every applicability state must have an explanation key");
});

test("A3 every fulfillment state has its own, distinct explanation key with no forbidden synonym in its copy", () => {
  const keys = FILING_FULFILLMENT_STATES.map((state) => FILING_FULFILLMENT_EXPLANATION_KEYS[state]);
  assert.equal(new Set(keys).size, keys.length);
  for (const state of FILING_FULFILLMENT_STATES) {
    const copy = t(landFilingFulfillmentExplanationKey(state));
    assertNoForbiddenFilingObservationSynonym(copy, `${state} copy`);
  }
});

/* ===== A9: nullable/older records and generic documents keep rendering ===== */

test("A9 a project with no obligation record renders no filing-evidence section at all", () => {
  const summary = buildLandFilingEvidenceSummary({ obligation: null });
  assert.equal(summary, null);
  assert.equal(landFilingEvidenceSummaryHTML(null, { t, escape: esc }), "");
  assert.equal(landFilingHistoryHTML(null, { t, escape: esc }), "");
});

test("A9 a summary with no matched document still renders (report stays null, no crash)", () => {
  const obligation = buildObligation();
  const summary = buildLandFilingEvidenceSummary({ obligation, documents: [], materializedAt: NOW });
  assert.equal(summary.report, null);
  const html = landFilingEvidenceSummaryHTML(summary, { t, escape: esc });
  assert.match(html, /data-land-filing-evidence="1"/);
  assert.doesNotMatch(html, /data-land-filing-original-document/);
});

/* ===== Negative rule: the displacement index is context, never a project prediction ===== */

test("negative rule: the displacement-index note is rendered wherever a displacement_risk section exists, and never elsewhere", () => {
  const document = buildDocument();
  const withRisk = buildEnvelope(document);
  const detailWithRisk = buildLandFilingEvidenceReportDetail({ document, rerEnvelope: withRisk });
  const htmlWithRisk = landFilingReportDetailHTML(detailWithRisk, { t, escape: esc });
  assert.match(htmlWithRisk, /land_filing_dri_note|does not predict/);
  assert.match(t("land_filing_displacement_index_note"), /neighbourhood context/i);
  assert.match(t("land_filing_displacement_index_note"), /does not predict/i);

  const withoutRisk = buildEnvelope(document, { displacement_risk: null });
  const detailWithoutRisk = buildLandFilingEvidenceReportDetail({ document, rerEnvelope: withoutRisk });
  const htmlWithoutRisk = landFilingReportDetailHTML(detailWithoutRisk, { t, escape: esc });
  assert.doesNotMatch(htmlWithoutRisk, /land-filing-dri-note/);
});

/* ===== Filing history stays a neutral, bounded digest of LDP-26's own sequence ===== */

test("filing history renders LDP-26's own event kinds and clocks, unmodified, and shows a truncation notice when bounded", () => {
  const obligation = buildObligation({ fulfillment: { state: "document_observed", document_refs: [buildDocument().document_id] } });
  const document = buildDocument();
  const sequence = materializeLandFilingSequence({
    projectId: "2025M0252",
    obligations: [obligation],
    documents: [document],
    materializedAt: NOW,
  });
  assert.ok(sequence.events.length > 0);
  for (const event of sequence.events) assert.ok(FILING_SEQUENCE_EVENT_KINDS.includes(event.event_kind));
  const summary = buildLandFilingEvidenceSummary({ obligation, documents: [document], sequence, materializedAt: NOW });
  assert.ok(summary.filing_history_digest);
  const html = landFilingHistoryHTML(summary.filing_history_digest, { t, escape: esc });
  assert.match(html, /data-land-filing-history="1"/);
  for (const event of summary.filing_history_digest.events) {
    assert.match(html, new RegExp(`data-land-filing-event="${event.event_kind}"`));
    for (const state of FILING_SEQUENCE_CONFLICT_STATES) void state; // documents the vocabulary this test is pinned to
  }
});

/* ===== Extraction-quality passthrough uses the ontology's own enum, verbatim ===== */

test("extraction quality on the report summary is copied verbatim from the RER envelope's own enum", () => {
  const obligation = buildObligation({ fulfillment: { state: "document_observed", document_refs: [buildDocument().document_id] } });
  const document = buildDocument();
  const envelope = buildEnvelope(document, { extraction_quality: "low" });
  let summary = buildLandFilingEvidenceSummary({ obligation, documents: [document], materializedAt: NOW });
  summary = withLandFilingEvidenceReport(summary, { obligation, documents: [document], rerEnvelope: envelope });
  assert.equal(summary.report.extraction_quality, "low");
  assert.ok(FILING_QUALITY_STATES.includes(summary.report.extraction_quality));
});

/* ===== Self-check: this module's own exports never smuggle in a forbidden word ===== */

test("self-check: none of the applicability/fulfillment observation copy uses a forbidden filing-observation synonym", () => {
  // Scoped to the copy that actually states a filing-observation condition
  // (G1/A2's concern) -- not every "land_filing_*" key, since some
  // legitimately name a distinct, real process ("environmental review") that
  // this card exists to keep separate from a filing observation, per A4.
  const scopedKeys = [
    ...Object.values(FILING_APPLICABILITY_EXPLANATION_KEYS),
    ...Object.values(FILING_FULFILLMENT_EXPLANATION_KEYS),
  ];
  for (const key of scopedKeys) {
    const value = EN_COPY.get(key);
    assert.ok(value, `missing English copy for ${key}`);
    assertNoForbiddenFilingObservationSynonym(value, key);
  }
});
