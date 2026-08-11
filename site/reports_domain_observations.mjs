/**
 * Report / study / plan City Record observation candidates for mandate
 * process-conformance filing receipts.
 *
 * Pure classifiers + stamp builders only. Live SODA fetch lives in
 * tools/build_reports_domain_observations.mjs. Never invents a filing.
 */

import { compactEvidenceTokens } from "./rule_evidence_stamps.mjs";

export const REPORTS_DOMAIN_SCHEMA = "cityscroll.reports_domain_observations.v1";
export const REPORTS_DOMAIN_METHOD = "city_record_report_signal_v1";
export const REPORTS_DOMAIN_SCHEMA_VERSION = 1;

/** Title / type patterns that read as a published report or study filing. */
const REPORT_TITLE = /\b(?:annual|quarterly|final|binding|advisory)\s+reports?\b|\breports?\b|\bstud(?:y|ies)\b|\bsurveys?\b|\bevaluations?\b|\bstrateg(?:y|ies)\b/i;
const REPORT_NOISE = /\bcrystal\s+reports?\b|\balerts?\s*(?:&|and)\s*reports?\b|\breporting\s+system\b|\bmaintenance\b|\blicen[cs]e\b|\bsoftware\b|\brenewal\b|\bsubscription\b|\bconcept\s+(?:report|paper)\b|\bnotice\s+of\s+concept\b/i;
const PROCUREMENT_SECTION = /\bprocurement\b|\bcontract award\b|\bpublic comment on contract\b/i;
const ANNUAL_REPORT_TITLE = /\b(?:fy\s*\d{2,4}\s+)?(?:cchr\s+)?annual\s+report\b|\bannual\s+report\b.*\bfy\s*\d{2,4}\b|\bfy\d{2,4}\s+.*annual\s+report\b/i;

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:nbsp|#160);/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

/**
 * True when a City Record row is a report-shaped publication signal, not a
 * procurement for a study or a software “Crystal Reports” product line.
 */
export function isReportPublicationRow(row = {}) {
  const title = clean(row.short_title || row.title || row.label, 500);
  const type = clean(row.type_of_notice_description || row.notice_type || row.type, 120);
  const section = clean(row.section_name || row.section, 80);
  if (!title) return false;
  if (REPORT_NOISE.test(title) || REPORT_NOISE.test(type)) return false;
  // Procurement solicitations / awards that merely name a study are not filings.
  if (PROCUREMENT_SECTION.test(section) || PROCUREMENT_SECTION.test(type)) return false;
  if (ANNUAL_REPORT_TITLE.test(title)) return true;
  if (REPORT_TITLE.test(title)) return true;
  if (/\breport\b|\bstudy\b/i.test(type) && /special materials/i.test(section)) return true;
  return false;
}

/** Structural annual-report publication shape (City Record Special Materials). */
export function isAnnualReportPublicationTitle(value) {
  return ANNUAL_REPORT_TITLE.test(clean(value, 500));
}

/**
 * Duty texts that require publishing an annual report in the City Record —
 * the structural join key for CCHR-style series.
 */
export function mandateRequiresCityRecordAnnualReport(dutyText) {
  const text = clean(dutyText, 2000).toLowerCase();
  if (!text) return false;
  const annual = /\bannual\s+report\b/.test(text);
  const cityRecord = /\bcity\s+record\b/.test(text);
  return annual && cityRecord;
}

/**
 * Compact one report observation without retaining source HTML/prose on the
 * committed public snapshot beyond bounded topic tokens.
 */
export function stampReportObservationRow(row = {}) {
  if (!isReportPublicationRow(row)) return null;
  const requestId = clean(row.request_id || row.id, 40);
  const title = clean(row.short_title || row.title || row.label, 320);
  if (!requestId || !title) return null;
  const body = clean(
    row.additional_description_1
      || row.additional_description_2
      || row.body
      || row.body_text
      || row.description
      || "",
    4000,
  );
  const whenRaw = clean(row.start_date || row.when || row.date, 40);
  const whenMatch = whenRaw.match(/^(\d{4}-\d{2}-\d{2})/);
  const topicSource = `${title} ${body}`.trim();
  return {
    request_id: requestId,
    agency_name: clean(row.agency_name || row.agency, 200) || null,
    short_title: title,
    start_date: whenMatch ? `${whenMatch[1]}T00:00:00.000` : (whenRaw || null),
    type_of_notice_description: clean(row.type_of_notice_description || row.notice_type, 120) || null,
    section_name: clean(row.section_name || row.section, 80) || null,
    source_system: clean(row.source_system, 40) || "city_record",
    signal_kind: "report_or_study",
    report_evidence: {
      schema: "cityscroll.report_evidence_stamp.v1",
      topic_keys: compactEvidenceTokens(topicSource, { limit: 32 }),
      annual_report: isAnnualReportPublicationTitle(title),
    },
  };
}

export function buildReportsDomainDocument(rows = [], {
  retrievedAt = null,
  windowDays = null,
  source = null,
} = {}) {
  const stamped = [];
  const seen = new Set();
  for (const row of rows) {
    const out = stampReportObservationRow(row);
    if (!out || seen.has(out.request_id)) continue;
    seen.add(out.request_id);
    stamped.push(out);
  }
  stamped.sort((left, right) => String(right.start_date || "").localeCompare(String(left.start_date || "")));
  const agencies = new Set(stamped.map((row) => row.agency_name).filter(Boolean));
  return {
    schema: REPORTS_DOMAIN_SCHEMA,
    schema_version: REPORTS_DOMAIN_SCHEMA_VERSION,
    method: REPORTS_DOMAIN_METHOD,
    domain: "reports",
    title: "Report / study / plan City Record observations for mandate filing receipts",
    description:
      "Bounded City Record publication signals (Special Materials annual reports, concept reports, studies) used as observation candidates for report mandates. Procurement solicitations and software product lines are excluded. Source prose is reduced to topic tokens.",
    retrieved_at: retrievedAt || new Date().toISOString(),
    window_days: windowDays,
    source: source || {
      system: "city_record",
      dataset: "dg92-zbpx",
    },
    row_count: stamped.length,
    agency_count: agencies.size,
    rows: stamped,
  };
}
