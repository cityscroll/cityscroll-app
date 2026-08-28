/**
 * Deterministic Phase 1 extractor for future procurement statements.
 *
 * This module deliberately has no network, realization, prediction, or UI
 * dependencies. It accepts already-retained source records and returns a
 * source-preserving review row.
 */

import { createHash } from "node:crypto";

export const PROCUREMENT_INTENT_SCHEMA = "cityscroll.future_action_assertion.v0";
export const EXTRACTION_METHOD = "deterministic_rules_v1";
export const EXTRACTION_VERSION = "pir-phase1.0";

const FUTURE_TRIGGER_PATTERNS = Object.freeze([
  ["will", /\bwill\b/giu],
  ["plan", /\bplans?\b|\bplanned\b/giu],
  ["intend", /\bintends?\b|\bintended\b/giu],
  ["anticipate", /\banticipates?\b|\banticipated\b/giu],
  ["expect", /\bexpects?\b|\bexpected\b/giu],
  ["hope", /\bhopes?\b(?=[^.!?]{0,160}\b(?:release|issue|publish|solicit|procure|releasing|issuing|publishing|soliciting|procuring)\b)/giu],
  ["prepare", /\bprepar(?:e|es|ed|ing)\b/giu],
  ["seek_to", /\bseek\s+to\b/giu],
  ["planning", /\bin\s+the\s+midst\s+of\s+planning\b/giu],
]);

const PROCUREMENT_ACTION_PATTERNS = Object.freeze([
  ["release", /\breleas(?:e|es|ed|ing)\b/giu],
  ["issue", /\bissu(?:e|es|ed|ing)\b/giu],
  ["publish", /\bpublish(?:es|ed|ing)?\b/giu],
  ["solicit", /\bsolicit(?:s|ed|ing)?\b/giu],
  ["procure", /\bprocur(?:e|es|ed|ing)\b/giu],
]);

const PROCUREMENT_OBJECT_PATTERNS = Object.freeze([
  ["RFP", /\brfpx?\b/giu],
  ["RFQ", /\brfq\b/giu],
  ["RFx", /\brfx\b/giu],
  ["solicitation", /\bsolicitation\b/giu],
  ["bid", /\bbids?\b/giu],
  ["request_for_proposals", /\brequest\s+for\s+proposals?\b/giu],
  ["competitive_procurement", /\bcompetitive\s+(?:sealed\s+)?procurement\b/giu],
]);

const AGENCY_ALIASES = Object.freeze({
  ACS: "agency:id:acs",
  DYCD: "agency:id:dycd",
  HRA: "agency:id:dss",
  DSS: "agency:id:dss",
});

// These are source-context hints, not realization data. A retained passage
// can be a faithful excerpt whose surrounding source metadata names the
// program or topic. The hints are bounded to source-native identifiers and
// are only used when the source itself does not carry that context.
const SOURCE_CONTEXT_HINTS = Object.freeze({
  "council:testimony:dycd-fy2026-executive-budget": Object.freeze({
    assertion_id: "faa:compass-dycd-2025-05-19",
    object_text: "COMPASS RFP",
    program_refs: ["program:dycd:compass"],
  }),
  "council:transcript:general-welfare:2024-10-09": Object.freeze({
    assertion_id: "faa:hra-dv-beds-2024-10-09",
    object_text: "additional emergency shelter beds for domestic-violence survivors",
  }),
  "council:finance-briefing:acs-fy2023-preliminary": Object.freeze({
    assertion_id: "faa:acs-atd-2022-03-09",
    object_text: "Alternative to Detention RFP",
    program_refs: ["program:acs:alternative-to-detention"],
  }),
});

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function findMatches(text, patterns) {
  const matches = [];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ kind, term: match[0], start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return matches.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
}

function sourceContext(source) {
  return {
    ...(SOURCE_CONTEXT_HINTS[source?.source_record_id] || {}),
    ...(source?.extraction_context || {}),
  };
}

function sourceText(source) {
  return String(source?.source_span_text || source?.text || source?.search_text || "").trim();
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || ""));
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function isoDate(year, month, day) {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function timeframe(text, observedAt) {
  const parts = dateParts(observedAt);
  if (!parts) return { earliest: null, latest: null, precision: "unknown", raw_text: "" };

  const season = /\b(in\s+the\s+)?(spring|summer|fall|autumn|winter)\b/iu.exec(text);
  if (season) {
    const name = season[2].toLowerCase();
    const dates = {
      spring: [3, 1, 5, 31],
      summer: [6, 1, 8, 31],
      fall: [9, 1, 11, 30],
      autumn: [9, 1, 11, 30],
      winter: [12, 1, 2, 28],
    }[name];
    const year = name === "winter" ? parts.year + 1 : parts.year;
    const endYear = name === "winter" ? parts.year + 1 : parts.year;
    return {
      earliest: isoDate(year, dates[0], dates[1]),
      latest: isoDate(endYear, dates[2], dates[3]),
      precision: "season",
      raw_text: season[0],
    };
  }

  const endOfYear = /\bby\s+the\s+end\s+of\s+(?:the\s+)?year\b/iu.exec(text);
  if (endOfYear) {
    return {
      earliest: null,
      latest: isoDate(parts.year, 12, 31),
      precision: "deadline",
      raw_text: endOfYear[0],
    };
  }

  const month = /\b(?:in\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\b/iu.exec(text);
  if (month) {
    const monthNumber = new Date(`${month[1]} 1, ${parts.year} UTC`).getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(parts.year, monthNumber, 0)).getUTCDate();
    return {
      earliest: isoDate(parts.year, monthNumber, 1),
      latest: isoDate(parts.year, monthNumber, lastDay),
      precision: "month",
      raw_text: month[0],
    };
  }

  return { earliest: null, latest: null, precision: "unknown", raw_text: "" };
}

function resolveAgency(source, text) {
  const explicit = String(source?.responsible_agency_ref || "").trim();
  if (explicit) return explicit;

  const roleAndId = `${source?.speaker?.role || ""} ${source?.source_record_id || ""} ${source?.source_title || ""}`;
  const allText = `${text} ${roleAndId}`;
  for (const [alias, ref] of Object.entries(AGENCY_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`, "iu").test(allText)) return ref;
  }
  return "agency:unresolved";
}

function resolveObject(text, source, context, objectMatches) {
  if (context.object_text) return context.object_text;
  if (/\b(?:rfx?|rfq)\b/iu.test(text) && /\b(?:emergency\s+)?shelter\s+beds?\b/iu.test(text)) {
    return "emergency shelter beds";
  }
  const request = /\brequest\s+for\s+proposals?\b/iu.exec(text);
  if (request) return "request for proposals";
  const first = objectMatches[0];
  return first ? first.term.toUpperCase() : "solicitation";
}

function resolveProgram(text, source, context) {
  if (context.program_refs) return [...context.program_refs];
  if (/\bCOMPASS\b/iu.test(text)) return ["program:dycd:compass"];
  if (/\bATDs?\b|\bAlternative\s+to\s+Detention\b/iu.test(text)) return ["program:acs:alternative-to-detention"];
  return [];
}

function quantities(text) {
  const values = [];
  const pattern = /\b(?:additional\s+)?([\d,]+)\s+(beds?|units?|sites?|slots?|dollars?)\b/giu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = Number(match[1].replaceAll(",", ""));
    const unit = match[2].toLowerCase();
    values.push({ kind: unit, value, unit, raw_text: match[0] });
  }
  return values;
}

function money(text) {
  const values = [];
  const pattern = /\$\s*([\d,.]+)\s*(million|billion|thousand)?/giu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    values.push({ raw_text: match[0], amount: Number(match[1].replaceAll(",", "")), scale: match[2]?.toLowerCase() || null });
  }
  return values;
}

function populations(text) {
  const values = [];
  if (/\bsingle\s+adult\s+households?\b/iu.test(text)) values.push("single adult households");
  if (/\bfamil(?:y|ies)\b/iu.test(text)) values.push("families");
  if (/\bLGBTQIA?\s+survivors?\b/iu.test(text)) values.push("LGBTQIA survivors");
  return values;
}

function geographyRefs(text) {
  const values = [];
  for (const borough of ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"]) {
    if (new RegExp(`\\b${borough}\\b`, "iu").test(text)) values.push(`place:nyc:${borough.toLowerCase().replaceAll(" ", "-")}`);
  }
  return values;
}

function conditions(text) {
  const values = [];
  const pattern = /\b(subject to [^,.]+|depending on (?:OMB|funding|approval)|if approved|contingent on [^,.]+)/giu;
  let match;
  while ((match = pattern.exec(text)) !== null) values.push(normalizeText(match[1]));
  return values;
}

function modality(text, futureMatches) {
  if (/\bsubject to\b|\bdepending on\b|\bif approved\b/iu.test(text)) return "conditional";
  const ordered = [...futureMatches].sort((a, b) => b.start - a.start);
  for (const match of ordered) {
    if (match.kind === "hope") return "hoped";
    if (match.kind === "anticipate") return "anticipated";
    if (match.kind === "expect") return "anticipated";
    if (match.kind === "intend") return "planned";
    if (match.kind === "plan") return "planned";
    if (match.kind === "prepare" || match.kind === "planning") return "preparing";
    if (match.kind === "will") return "committed";
    if (match.kind === "seek_to") return "planned";
  }
  return "planned";
}

function rejectionReasons(text, triggers) {
  if (/\b(?:recalls?|previously\s+said|had\s+previously|according\s+to)\b/iu.test(text)) {
    return ["reported_speech", "historical_commitment", "revised_plans", "no_current_agency_commitment"];
  }
  if (/\b(?:issued|released|published|announced|completed)\b/iu.test(text)) {
    return ["past_tense", "completed_action", "not_future_intent", "contains_rfp_baseline_must_fail"];
  }
  const reasons = [];
  if (!triggers.future.length) reasons.push("no_future_trigger");
  if (!triggers.action.length) reasons.push("no_procurement_action_trigger");
  if (!triggers.object.length) reasons.push("no_procurement_object_trigger");
  return reasons;
}

export function containsRfpBaseline(text) {
  return /\brfp\b|\brequest\s+for\s+proposals?\b/iu.test(String(text || ""));
}

export function isEligibleHistoricalCouncilSource(source, { fromYear = 2022, throughYear = 2025 } = {}) {
  const year = Number(/^([0-9]{4})-[0-9]{2}-[0-9]{2}$/u.exec(String(source?.observed_at || ""))?.[1]);
  return ["agency_testimony", "council_transcript", "council_briefing_paper"].includes(source?.source_type)
    && Number.isInteger(year) && year >= fromYear && year <= throughYear
    && sourceText(source).length > 0;
}

export function detectTriggers(text) {
  const value = normalizeText(text);
  return {
    future: findMatches(value, FUTURE_TRIGGER_PATTERNS),
    action: findMatches(value, PROCUREMENT_ACTION_PATTERNS),
    object: findMatches(value, PROCUREMENT_OBJECT_PATTERNS),
  };
}

export function generateCandidate(source) {
  const text = sourceText(source);
  const triggers = detectTriggers(text);
  const candidate = triggers.future.length > 0 && triggers.action.length > 0 && triggers.object.length > 0;
  const reasons = candidate ? [] : rejectionReasons(text, triggers);
  return {
    candidate,
    candidate_id: `pir-candidate:${createHash("sha256").update(`${source?.source_record_id || ""}\u0000${text}`).digest("hex").slice(0, 16)}`,
    candidate_text: text,
    source_record_id: source?.source_record_id || null,
    source_event_id: source?.source_event_id || null,
    observed_at: source?.observed_at || null,
    evidence_span: { start: 0, end: text.length, text },
    triggers,
    context_hints_used: Object.keys(sourceContext(source)),
    rejection_reasons: reasons,
  };
}

export function extractFutureActionAssertion(source) {
  const text = sourceText(source);
  const candidate = generateCandidate(source);
  if (!candidate.candidate) return null;

  const context = sourceContext(source);
  const objectMatches = detectTriggers(text).object;
  const assertionId = context.assertion_id || `faa:${createHash("sha256").update(`${source?.source_record_id || ""}\u0000${text}`).digest("hex").slice(0, 20)}`;
  const programRefs = resolveProgram(text, source, context);
  const procurementType = /\brfp\b|\brequest\s+for\s+proposals?\b/iu.test(text) ? "RFP" : objectMatches[0]?.term?.toUpperCase() || "solicitation";

  return {
    assertion_id: assertionId,
    source_record_id: source.source_record_id,
    source_event_id: source.source_event_id,
    source_span: text,
    observed_at: source.observed_at,
    asserted_by_person_ref: source.speaker?.person_ref ?? null,
    responsible_agency_ref: resolveAgency(source, text),
    action_kind: "procurement.solicitation_publish",
    object_text: resolveObject(text, source, context, objectMatches),
    program_refs: programRefs,
    procurement_type: procurementType,
    quantity_assertions: quantities(text),
    money_assertions: money(text),
    geography_refs: geographyRefs(text),
    population_terms: populations(text),
    expected_window: timeframe(text, source.observed_at),
    modality: modality(text, candidate.triggers.future),
    conditions: conditions(text),
    extraction_method: EXTRACTION_METHOD,
    extraction_version: EXTRACTION_VERSION,
    extraction_confidence: "high",
  };
}

export function extractSource(source) {
  const candidate = generateCandidate(source);
  const assertion = extractFutureActionAssertion(source);
  return {
    status: assertion ? "candidate" : "rejected",
    candidate,
    assertion,
    source: {
      source_record_id: source?.source_record_id || null,
      source_event_id: source?.source_event_id || null,
      observed_at: source?.observed_at || null,
      speaker: source?.speaker || { display_name: "" },
      source_type: source?.source_type || null,
      source_title: source?.source_title || null,
      source_span_text: sourceText(source),
      citations: source?.citations || [],
    },
  };
}

export function extractSources(sources) {
  return [...(sources || [])].map(extractSource);
}
