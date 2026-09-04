// Opportunity-first procurement alert atom (procurement-pursuit-decision, Card 1).
//
// A normalized shape shared by procurement-object rows and City Record notice
// rows so a procurement email/preview subject and body can lead with the
// opportunity (agency, recognizable title, amount, deadline) instead of a
// saved-filter label or a bare match count.
//
// Card 2 of the same workstream owns cityscroll.procurement_opportunity_window.v1
// (the derived response-window object, site/procurement_opportunity_window.mjs).
// This module derives it from whatever boundary dates a row already carries
// (an explicit `opportunity_window` object always wins when a caller already
// computed one from the full object/observations record, e.g. the procurement
// detail page) rather than reimplementing the derivation.
//
// Reused, not reinvented:
//   - digestMatterKind / shortDate (./digest_item_awareness.mjs) for matter
//     classification and short-date rendering — no second date parser.
//   - AGENCY_GROUPS / resolveAgencyIdentity (./agency_identity.mjs) for the
//     agency abbreviation used in subjects (e.g. "DOT", "MTA C&D") — no second
//     agency identity table.
//   - deriveProcurementOpportunityWindow (./procurement_opportunity_window.mjs)
//     for the response-window / notice-to-due-window derivation — no second
//     date-boundary rule set.

import { digestMatterKind, shortDate, isRollingDeadline } from "./digest_item_awareness.mjs";
import { AGENCY_GROUPS, resolveAgencyIdentity } from "./agency_identity.mjs";
import { deriveProcurementOpportunityWindow } from "./procurement_opportunity_window.mjs";

/** Recognizable-title segment budget (chars) before the "X Line, Y Line" collapse or ellipsis kicks in. */
export const PROCUREMENT_ALERT_TITLE_BUDGET = 42;

/** Full subject-line budget (chars) — a common inbox-preview width across mail clients. */
export const PROCUREMENT_ALERT_SUBJECT_BUDGET = 78;

const ABBREV_SHAPE = /^[A-Z0-9][A-Z0-9&.'\s-]{1,9}$/;

function isoDay(value) {
  const s = String(value == null ? "" : value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/** Strip control/newline characters and collapse whitespace — email-header safety. */
export function escapeSubjectText(value) {
  const s = String(value == null ? "" : value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 32 ? " " : s[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

/** HTML-context escaping for rendering a subject inside a preview page. */
export function escapeSubjectHtml(value) {
  return String(value == null ? "" : value).replace(/[<>&"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;",
  }[c]));
}

function truncateWithBudget(text, budget) {
  const s = escapeSubjectText(text);
  if (s.length <= budget) return s;
  const cut = s.slice(0, Math.max(0, budget - 1));
  const lastSpace = cut.lastIndexOf(" ");
  const base = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${base}…`;
}

/**
 * Recognizable title within PROCUREMENT_ALERT_TITLE_BUDGET.
 *
 * Titles that list several "<name> Line" corridor segments joined by comma/and
 * (a common City Record / MTA convention, e.g. "CBTC for 6th Ave Line, 63rd St
 * Line and DeKalb Interlocking") collapse to the recognizable route names —
 * "6th Ave / 63rd St" — instead of being cut mid-word. Anything else that still
 * overflows the budget is truncated at a word boundary with an ellipsis.
 */
export function recognizableTitle(rawTitle, budget = PROCUREMENT_ALERT_TITLE_BUDGET) {
  const title = escapeSubjectText(rawTitle);
  if (!title) return "";
  if (title.length <= budget) return title;
  const lineList = /^(.+?)\s+Line\s*,\s*(.+?)\s+Line\b/i.exec(title);
  if (lineList) {
    const collapsed = `${lineList[1].trim()} / ${lineList[2].trim()}`;
    if (collapsed.length <= budget) return collapsed;
  }
  return truncateWithBudget(title, budget);
}

/**
 * Short agency form for a subject line ("DOT", "MTA C&D"), reusing the
 * published alias list in agency_identity.mjs's AGENCY_GROUPS. Falls back to
 * the full canonical (or raw) agency name when no alias is abbreviation-shaped
 * — never fabricates a short form.
 */
export function agencyAbbreviation(agencyName) {
  const raw = String(agencyName || "").trim();
  if (!raw) return null;
  const identity = resolveAgencyIdentity(raw);
  // Unmatched agency text falls back to the raw value, not agency_identity's
  // title-cased display fallback (e.g. an unrecognized "DOE" should stay "DOE",
  // never become "Doe") — no confident match means no confident rewrite.
  if (!identity?.matched) return raw;
  const aliases = AGENCY_GROUPS[identity.canonical_name] || [];
  const alias = aliases.find((a) => ABBREV_SHAPE.test(a));
  return alias || identity.canonical_name || raw;
}

function formatAmountForSubject(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : "";
}

/** Amount ever fabricated as $0 — treat 0 and negative/non-finite as unknown. */
function resolveAmount(row, opts) {
  if (opts?.amount && typeof opts.amount === "object") return opts.amount;
  const raw = row?.contract_amount;
  const n = Number(raw);
  if (raw != null && raw !== "" && Number.isFinite(n) && n > 0) {
    return { value: n, status: "observed" };
  }
  const status = row?.amount_status || opts?.amountStatus || "not_observed";
  return { value: null, status };
}

function resolveDeadline(row, opts) {
  if (opts?.deadline && typeof opts.deadline === "object") return opts.deadline;
  const day = isoDay(row?.due_date);
  // A rolling-year sentinel (>= ROLLING_YEAR, digest_item_awareness.mjs's
  // convention) means "no fixed deadline" — never a real closing date.
  if (day && !isRollingDeadline(day)) return { value: day, label: shortDate(day), status: "observed" };
  const status = row?.deadline_status || opts?.deadlineStatus || "not_observed";
  return { value: null, label: null, status };
}

/**
 * Response window (exact PASSPort release -> due) or notice-to-due window
 * (City Record publication -> due), derived from whatever boundary dates the
 * row itself carries. An explicit `opportunity_window` (row field or opts
 * override — e.g. already computed from the full object/observations record
 * by procurement_document.mjs) always wins over re-deriving from a flatter
 * row shape. City Record digest rows only ever carry a `start_date`
 * (publication), never an RFx `release_date`, so most alert atoms land on the
 * weaker notice-to-due window — exactly rule 4's "do not substitute City
 * Record publication for RFx release."
 */
function resolveOpportunityWindow(row, opts) {
  if (opts?.opportunity_window && typeof opts.opportunity_window === "object") return opts.opportunity_window;
  if (row?.opportunity_window && typeof row.opportunity_window === "object") return row.opportunity_window;
  const cityRecordRef = row?.city_record_source_observation_ref
    || (row?.request_id ? `city_record:${row.request_id}` : null);
  return deriveProcurementOpportunityWindow({
    passport_release_date: row?.release_date ?? null,
    passport_due_date: row?.due_date ?? null,
    passport_source_observation_ref: row?.passport_source_observation_ref ?? null,
    city_record_start_date: row?.start_date ?? null,
    city_record_due_date: row?.due_date ?? null,
    city_record_source_observation_ref: cityRecordRef,
  });
}

function defaultCityscrollUrl(row) {
  if (row?.procurement_id) return `https://cityscroll.org/procurements/${encodeURIComponent(row.procurement_id)}`;
  if (row?.request_id) return `https://cityscroll.org/notices/${encodeURIComponent(row.request_id)}`;
  return null;
}

function defaultOfficialUrl(row) {
  if (row?.official_notice_url) return String(row.official_notice_url);
  if (row?.request_id) return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id)}`;
  return null;
}

/**
 * Build the normalized procurement alert atom for one procurement-object row
 * or City Record notice row. Unknown amount/deadline are never fabricated as
 * zero or a made-up date — they carry an explicit status instead.
 *
 * `matter_kind` is an addition beyond the commission's literal 12-field JSON
 * shape (procurement_id .. official_url): it is required to apply the lead-
 * selection rules and the deadline-labeling rule below, and is itself reused
 * from digest_item_awareness.mjs rather than a new classifier.
 */
export function buildProcurementAlertAtom(row, opts = {}) {
  const r = row || {};
  return {
    procurement_id: r.procurement_id || null,
    request_id: r.request_id || null,
    title: r.short_title || r.title || r.project_name || null,
    agency: r.agency_name || null,
    amount: resolveAmount(r, opts),
    deadline: resolveDeadline(r, opts),
    match_reasons: Array.isArray(opts.match_reasons) ? opts.match_reasons.filter(Boolean) : [],
    method: r.selection_method_description || r.selection_method || null,
    mwbe: r.mwbe ?? null,
    opportunity_window: resolveOpportunityWindow(r, opts),
    important_dates: Array.isArray(r.important_dates) ? r.important_dates.slice() : [],
    cityscroll_url: opts.cityscroll_url || defaultCityscrollUrl(r),
    official_url: opts.official_url || defaultOfficialUrl(r),
    matter_kind: digestMatterKind(r, opts.kind || null),
  };
}

/**
 * Lead-selection rules (explicit, in order):
 *   1. actionable solicitation before contract/history (award, etc.);
 *   2. nearest known due date;
 *   3. known amount before unknown amount;
 *   4. stable procurement/request ID as final tie-break.
 * This is inbox ordering only, never a claim CityScroll learned relevance.
 */
export function selectLeadProcurementAtom(atoms = []) {
  const list = (Array.isArray(atoms) ? atoms : []).filter(Boolean);
  if (!list.length) return { lead: null, remainingCount: 0 };
  const solicitationRank = (a) => (a.matter_kind === "solicitation" ? 0 : 1);
  const dueRank = (a) => {
    if (a.deadline?.status !== "observed" || !a.deadline.value) return Number.POSITIVE_INFINITY;
    const t = Date.parse(`${a.deadline.value}T00:00:00Z`);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const amountRank = (a) => (a.amount?.status === "observed" ? 0 : 1);
  const stableId = (a) => String(a.procurement_id || a.request_id || "");
  const sorted = [...list].sort((a, b) => (
    solicitationRank(a) - solicitationRank(b)
    || dueRank(a) - dueRank(b)
    || amountRank(a) - amountRank(b)
    || stableId(a).localeCompare(stableId(b))
  ));
  return { lead: sorted[0], remainingCount: list.length - 1 };
}

/**
 * Subject segment for one atom: "{agency} · {recognizable title} · {amount if
 * known} · {closing date if known}". Amount is omitted (never "$0") when not
 * observed. A solicitation's deadline is always labeled — "closes {date}" when
 * observed, "deadline not published" when not — because a vendor deadline is
 * expected for a solicitation; non-solicitation atoms (e.g. an award) omit the
 * deadline segment entirely since it does not apply.
 */
export function procurementAlertSubjectSegment(atom) {
  if (!atom) return "";
  const parts = [];
  const agency = atom.agency ? agencyAbbreviation(atom.agency) : null;
  if (agency) parts.push(escapeSubjectText(agency));
  const title = atom.title ? recognizableTitle(atom.title) : "";
  if (title) parts.push(title);
  if (atom.amount?.status === "observed" && Number.isFinite(Number(atom.amount.value)) && Number(atom.amount.value) > 0) {
    parts.push(formatAmountForSubject(atom.amount.value));
  }
  if (atom.matter_kind === "solicitation") {
    parts.push(
      atom.deadline?.status === "observed" && atom.deadline.value
        ? `closes ${atom.deadline.label || shortDate(atom.deadline.value)}`
        : "deadline not published",
    );
  }
  return parts.join(" · ");
}

/**
 * Full subject: the lead item's segment, plus "(+N)" for the exact count of
 * remaining procurement matches when there is more than one. Truncation always
 * preserves the "(+N)" suffix (the multi-match honesty signal) rather than
 * dropping it under the character budget.
 */
export function procurementAlertSubject({ atoms = [], budget = PROCUREMENT_ALERT_SUBJECT_BUDGET } = {}) {
  const list = (Array.isArray(atoms) ? atoms : []).filter(Boolean);
  if (!list.length) return "";
  const { lead, remainingCount } = selectLeadProcurementAtom(list);
  const suffix = remainingCount > 0 ? ` (+${remainingCount})` : "";
  const leadBudget = Math.max(10, budget - suffix.length);
  const segment = truncateWithBudget(procurementAlertSubjectSegment(lead), leadBudget);
  return `${segment}${suffix}`;
}

/**
 * Documented eight-step body hierarchy (commission order):
 *   1. agency and recognizable title
 *   2. deadline and important dates
 *   3. why the item matched
 *   4. amount, method, and M/WBE facts
 *   5. response/notice window
 *   6. short context
 *   7. Review on CityScroll
 *   8. official notice or PASSPort action
 */
export const PROCUREMENT_ALERT_BODY_STEPS = Object.freeze([
  "identity",
  "timing",
  "match_reasons",
  "commercial_facts",
  "response_window",
  "context",
  "review_on_cityscroll",
  "official_action",
]);

/**
 * Ordered body sections for one atom, matching PROCUREMENT_ALERT_BODY_STEPS.
 * Structural only (data, not HTML) — a renderer applies markup/escaping.
 */
export function buildProcurementAlertBodySections(atom, { matchReasons = null, context = null } = {}) {
  if (!atom) return [];
  const reasons = Array.isArray(matchReasons) ? matchReasons : atom.match_reasons;
  return PROCUREMENT_ALERT_BODY_STEPS.map((key, index) => {
    const step = index + 1;
    switch (key) {
      case "identity":
        return { step, key, agency: atom.agency || null, title: atom.title || null };
      case "timing":
        return { step, key, deadline: atom.deadline, important_dates: atom.important_dates || [] };
      case "match_reasons":
        return { step, key, reasons: reasons || [] };
      case "commercial_facts":
        return { step, key, amount: atom.amount, method: atom.method, mwbe: atom.mwbe };
      case "response_window":
        return { step, key, opportunity_window: atom.opportunity_window };
      case "context":
        return { step, key, context: context || null };
      case "review_on_cityscroll":
        return { step, key, url: atom.cityscroll_url || null };
      case "official_action":
        return { step, key, url: atom.official_url || null };
      default:
        return { step, key };
    }
  });
}
