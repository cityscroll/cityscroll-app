import { verifyQuote } from "./quote_verify.mjs";
import { sanitizeField, sanitizeText } from "./sanitize.mjs";

export const MANDATES_SCHEMA_VERSION = "cityscroll-mandates-v1";
export const DELIVERABLE_TYPES = Object.freeze([
  "report",
  "rulemaking",
  "program",
  "data publication",
  "other",
]);
export const DEADLINE_KINDS = Object.freeze([
  "none",
  "fixed_date",
  "days_after_effective",
  "days_after_enactment",
  "on_effective_date",
]);
export const RECURRENCES = Object.freeze([
  "one-time",
  "annual",
  "biennial",
  "quarterly",
  "monthly",
  "ongoing",
]);

function validDate(value) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 36500 ? number : null;
}

export function computeDeadline(deadline = {}, { enactmentDate = null, effectiveDate = null } = {}) {
  const kind = DEADLINE_KINDS.includes(deadline?.kind) ? deadline.kind : "none";
  const fixedDate = validDate(deadline?.fixed_date || deadline?.fixedDate);
  const offsetDays = integerOrNull(deadline?.offset_days ?? deadline?.offsetDays);
  const base = kind === "days_after_enactment" ? validDate(enactmentDate)
    : kind === "days_after_effective" || kind === "on_effective_date" ? validDate(effectiveDate || enactmentDate)
      : null;
  const computedDate = kind === "fixed_date" ? fixedDate
    : kind === "on_effective_date" ? base
      : base && offsetDays !== null ? addDays(base, offsetDays) : null;
  const enactment = validDate(enactmentDate);
  return {
    kind,
    fixed_date: kind === "fixed_date" ? fixedDate : null,
    offset_days: kind.includes("days_after") ? offsetDays : null,
    text: sanitizeField("deadline_text", deadline?.text || null) || null,
    computed_date: computedDate && (!enactment || computedDate >= enactment) ? computedDate : null,
  };
}

function normalizeType(value) {
  const type = sanitizeText(value, 80).toLowerCase();
  return DELIVERABLE_TYPES.includes(type) ? type : "other";
}

const RECURRING_SIGNAL = /\b(?:annually(?:\s+thereafter)?|annual\s+reports?|each\s+year|every\s+year|yearly|thereafter|quarterly|every\s+(?:three|3)\s+months?|monthly|every\s+month|biennial|every\s+(?:two|2)\s+years?|every\s+(?:five|5)\s+years?)\b/iu;
const OFFSET_AFTER_EFFECTIVE = /\b(?:no\s+later\s+than|within|not\s+later\s+than|no\s+more\s+than)?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:calendar\s+)?(?:days?|months?|years?)\s+(?:after|from)\s+(?:the\s+)?(?:effective|enactment|passage|adoption)\s+date\b/iu;

function recurrenceToken(value) {
  const recurrence = sanitizeText(value || "one-time", 80).toLowerCase();
  if (recurrence === "every 1 year" || recurrence === "every 1 years") return "annual";
  if (recurrence === "every 2 years") return "biennial";
  if (RECURRENCES.includes(recurrence) || /^every \d+ years?$/.test(recurrence)) return recurrence;
  return "one-time";
}

function explicitRecurrence(evidence, deliverableType) {
  const text = sanitizeText(evidence, 12000);
  if (!text) return null;
  if (/\b(?:quarterly|every\s+(?:three|3)\s+months?)\b/iu.test(text)) return "quarterly";
  if (/\b(?:monthly|every\s+month)\b/iu.test(text)) return "monthly";
  if (/\b(?:biennial|every\s+(?:two|2)\s+years?)\b/iu.test(text)) return "biennial";
  if (/\b(?:every\s+(?:five|5)\s+years?|quinquennial)\b/iu.test(text)) return "every 5 years";
  if (deliverableType !== "report") return null;
  // “Annual” describes the cadence of a report; it does not turn a one-time
  // rulemaking duty into an annual duty merely because the rule concerns
  // annual limits or filings.
  if (RECURRING_SIGNAL.test(text)) return "annual";
  if (/\b(?:annually|each\s+year|every\s+year|yearly|thereafter)\b/iu.test(text)) return "annual";
  return null;
}

/**
 * Resolve recurrence from the model token plus the verified statutory passage.
 * A bare offset from an effective/enactment date is a one-time deadline, not
 * evidence of an annual cycle. The quote is the relevant slice of the full
 * Legistar law text, so unrelated annual language elsewhere in the law cannot
 * promote the mandate.
 */
export function normalizeRecurrence(value, {
  deadlineText = "",
  dutyText = "",
  verbatimQuote = "",
  quoteVerified = false,
  deliverableType = "",
} = {}) {
  const token = recurrenceToken(value);
  const deadline = sanitizeText(deadlineText, 2000);
  const duty = sanitizeText(dutyText, 2000);
  const quote = quoteVerified ? sanitizeText(verbatimQuote, 12000) : "";
  const evidence = [quote, deadline, duty].filter(Boolean).join(" ");
  const explicit = explicitRecurrence(evidence, sanitizeText(deliverableType, 80).toLowerCase());

  if (OFFSET_AFTER_EFFECTIVE.test(deadline) && !explicit) return "one-time";
  if (explicit && (token === "one-time" || (token === "annual" && explicit !== "annual"))) return explicit;
  return token;
}

export function normalizeMandate(raw = {}, {
  matterId,
  sequence,
  lawText = "",
  enactmentDate = null,
  effectiveDate = null,
} = {}) {
  const quote = sanitizeField("verbatim_quote", raw.verbatim_quote ?? raw.quote ?? "");
  const verification = verifyQuote(quote, lawText);
  const deadline = computeDeadline(raw.deadline || {
    kind: raw.deadline_kind,
    fixed_date: raw.deadline_date,
    offset_days: raw.deadline_offset_days,
    text: raw.deadline_text,
  }, { enactmentDate, effectiveDate });
  const id = `${sanitizeText(matterId, 120)}-${String(sequence).padStart(3, "0")}`;
  return {
    mandate_id: id,
    matter_id: sanitizeText(matterId, 120),
    agency: sanitizeField("agency", raw.agency ?? raw.actor_resolved ?? raw.actor ?? "unspecified") || "unspecified",
    agency_raw: sanitizeField("agency_raw", raw.agency_raw ?? raw.actor_raw ?? "") || null,
    duty_text: sanitizeField("duty_text", raw.duty_text ?? raw.action_summary ?? ""),
    deliverable_type: normalizeType(raw.deliverable_type),
    deadline,
    recurrence: normalizeRecurrence(raw.recurrence, {
      deadlineText: deadline.text,
      dutyText: raw.duty_text ?? raw.action_summary,
      verbatimQuote: quote,
      quoteVerified: verification.verified,
      deliverableType: raw.deliverable_type,
    }),
    citation: sanitizeField("citation", raw.citation),
    verbatim_quote: quote,
    quote_verified: verification.verified,
    quote_verification_reason: verification.reason,
    status: verification.verified ? "verified" : "candidate",
    affected_groups: Array.isArray(raw.affected_groups)
      ? raw.affected_groups.slice(0, 20).map((value) => sanitizeField("affected_group", value)).filter(Boolean)
      : [],
  };
}

export function buildMandateEnvelope(law, mandates, { fetchedAt = null } = {}) {
  return {
    schema_version: MANDATES_SCHEMA_VERSION,
    matter_id: sanitizeText(law?.matter_id, 120),
    // Publisher-issued law anchors only. Invalid or non-ISO values remain null;
    // file numbers and publication order are never date evidence.
    enactment_date: validDate(law?.enactment_date),
    effective_date: validDate(law?.effective_date),
    source: {
      url: sanitizeText(law?.provenance?.source_url || law?.source_url, 1000) || null,
      fetched_at: fetchedAt || law?.provenance?.fetched_at || null,
      sha256: sanitizeText(law?.provenance?.sha256, 128) || null,
    },
    mandates,
  };
}
