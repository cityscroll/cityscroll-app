/**
 * Pursuit snapshot for solicitation-stage procurement detail
 * (procurement-pursuit-decision, Card 3).
 *
 * A compact, provenance-tagged answer to the initial bid/no-bid question --
 * identity, decision facts, fit/context handoff, official action, and an
 * explicit "what CityScroll cannot verify" disclosure -- assembled from
 * records already surfaced elsewhere on procurement detail. This is a view-
 * model composition layer: it never ingests a new source, infers a missing
 * fact, or scores an opportunity.
 *
 * Reused, not reinvented:
 *   - solicitationResponseContextReady() (./solicitation_response_context.mjs)
 *     is the literal base gate (rule 2). The only extension is an explicit,
 *     caller-declared opt-in for a sparse canonical object built from a
 *     native RFx source (no City-Record-shaped response-fact field to check)
 *     -- this module never infers that shape from field absence.
 *   - buildProcurementAlertAtom() (./procurement_alert_atom.mjs, Card 1) for
 *     title/agency/amount/deadline/opportunity-window/match-reason
 *     resolution -- no second amount or deadline resolver.
 *   - procurementOpportunityWindow() / opportunityWindowDisplayLine()
 *     (./procurement_opportunity_window.mjs, Card 2) for the response/
 *     notice-to-due window and its rule-floor pairing.
 *   - resolveProcurementMethod() / buildSolicitationMwbeView()
 *     (./mwbe_goal_surface.mjs) for M/WBE markers and rule-derived floors.
 *   - procurementOfficialSourceItems() (./procurement_document.mjs) and the
 *     alert atom's official/CityScroll URLs for official destinations.
 *   - explainMatch() (./procurement_preference_set.mjs, card "PPD-05") for an
 *     optional, caller-supplied "matches your stated preferences" list. This
 *     module never computes that explanation itself; it only renders reasons
 *     it is handed, and only after reasonsCarryPreferenceProvenance() confirms
 *     every one carries that module's own "user-supplied" provenance token --
 *     never blended with this module's own published-fact status grammar.
 *
 * A caller supplies one normalized flat `row` (a City Record notice row as
 * money-history.mjs already consumes, or an equivalent row a canonical-
 * object caller such as procurement_document.mjs builds from its own
 * already-resolved facts/observations) plus `opts` overrides. This module
 * never reaches into raw source observations itself.
 */

import { solicitationResponseContextReady } from "./solicitation_response_context.mjs";
import { buildProcurementAlertAtom } from "./procurement_alert_atom.mjs";
import { buildSolicitationMwbeView } from "./mwbe_goal_surface.mjs";
import { opportunityWindowDisplayLine } from "./procurement_opportunity_window.mjs";
import { shortDate } from "./digest_item_awareness.mjs";
import { reasonsCarryPreferenceProvenance } from "./procurement_preference_set.mjs";

export const PROCUREMENT_PURSUIT_SNAPSHOT_SCHEMA = "cityscroll.procurement_pursuit_snapshot.v1";

/** The five-value product grammar every pursuit-relevant fact is tagged with. */
export const PURSUIT_FIELD_STATUS = Object.freeze({
  OBSERVED: "observed",
  DERIVED: "derived",
  USER_PROVIDED: "user_provided",
  NOT_OBSERVED: "not_observed",
  UNAVAILABLE: "unavailable",
});

/**
 * Fixed, closed disclosure list: CityScroll cannot verify these from public
 * records regardless of how complete a given solicitation's published facts
 * are. This is a constant honest disclaimer, not a per-fixture computed
 * list, so an unknown never reads as a failed requirement (rule 5).
 */
export const PURSUIT_UNVERIFIABLE_ROWS = Object.freeze([
  { key: "package_eligibility", label: "Full package eligibility requirements" },
  { key: "experience_requirements", label: "Experience requirements" },
  { key: "staffing_requirements", label: "Staffing or team requirements" },
  { key: "qa_content", label: "Q&A content" },
  { key: "amendment_documents", label: "Amendment documents" },
  { key: "issuing_team", label: "Internal issuing team" },
  { key: "existing_relationship", label: "An existing relationship with the agency" },
  { key: "team_feasibility", label: "Whether your team can staff this in time" },
]);

function text(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function fact(value, status) {
  return { value: value ?? null, status };
}

/**
 * Whether a pursuit snapshot is meaningful for this row (rules 1, 2, 7).
 * `nativeSolicitationStage` is an explicit, caller-declared signal: it is
 * never inferred here from a missing `type_of_notice_description`, because
 * that same absence is also what a malformed/incomplete row looks like.
 */
export function pursuitSnapshotReady(row = {}, { nativeSolicitationStage = false } = {}) {
  const r = row || {};
  if (solicitationResponseContextReady(r)) return true;
  if (!nativeSolicitationStage) return false;
  // A row that does carry a literal notice type must satisfy the base rule
  // on its own merits -- the extension only covers rows structurally unable
  // to carry that City-Record-shaped field at all.
  if (text(r.type_of_notice_description)) return false;
  return Boolean(text(r.short_title || r.title)) && Boolean(text(r.agency_name));
}

function amountFact(atom) {
  const observed = atom.amount?.status === "observed";
  return fact(observed ? atom.amount.value : null, observed ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED);
}

function deadlineFact(deadlinePart) {
  const observed = deadlinePart?.status === "observed" && deadlinePart.value;
  return {
    value: observed ? deadlinePart.value : null,
    label: observed ? (deadlinePart.label || null) : null,
    status: observed ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED,
  };
}

/**
 * Pick the one important-date entry whose title matches a labeled milestone
 * (pre-bid/pre-proposal conference, questions deadline) out of the same
 * `important_dates` bundle the alert atom already carries. Title text comes
 * from the shared opportunity-calendar occurrence classifier
 * (./opportunity_calendar.mjs) or a caller-supplied equivalent -- never a
 * second date-mining pass.
 */
function findImportantDate(importantDates, pattern) {
  const hit = (Array.isArray(importantDates) ? importantDates : [])
    .find((entry) => entry && pattern.test(String(entry.title || "")));
  if (!hit) return fact(null, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  const day = String(hit.date || hit.starts_at || "").slice(0, 10);
  if (!day) return fact(null, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  return { value: day, label: shortDate(day) || day, status: PURSUIT_FIELD_STATUS.OBSERVED };
}

/**
 * Optional "matches your stated preferences" list (card "PPD-05"). `opts.preference_match`
 * is the raw explainMatch() output ({ eligible, reasons }); only reasons that
 * are both satisfied and carry the exported preference-provenance token are
 * ever passed through, so a caller mistake can never present a preference as
 * a published fact. Absent or empty input renders nothing.
 */
function preferenceMatchSection(preferenceMatch) {
  const reasons = Array.isArray(preferenceMatch?.reasons) ? preferenceMatch.reasons : [];
  const satisfied = reasons.filter((entry) => entry?.satisfied === true);
  if (!satisfied.length || !reasonsCarryPreferenceProvenance(satisfied)) return [];
  return satisfied;
}

function contactFact(row) {
  const parts = [text(row?.contact_name), text(row?.contact_phone), text(row?.email)].filter(Boolean);
  if (!parts.length) return fact(null, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  return fact(parts.join(" · "), PURSUIT_FIELD_STATUS.OBSERVED);
}

function methodFact(row) {
  const label = text(row?.selection_method_description || row?.selection_method);
  return fact(label, label ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED);
}

/**
 * M/WBE decision fact: reuses buildSolicitationMwbeView() verbatim. A caller
 * that already computed a view (e.g. procurement_document.mjs, which already
 * builds one for the existing M/WBE chips) can pass it through directly via
 * `opts.mwbe_view` instead of paying for a second extraction pass.
 */
function mwbeFact(row, opts) {
  const view = opts?.mwbe_view !== undefined
    ? opts.mwbe_view
    : buildSolicitationMwbeView(row, opts?.procurement_method || null);
  if (!view) return fact(null, PURSUIT_FIELD_STATUS.NOT_OBSERVED);
  return fact(view, PURSUIT_FIELD_STATUS.DERIVED);
}

/**
 * Official-action destinations. `official_source_items` (when supplied) is
 * the exact array procurementOfficialSourceItems() already produces for a
 * canonical object; for a flat notice row this falls back to the alert
 * atom's own official_url resolution. A PASSPort RFx destination without an
 * explicit publicly-reachable package URL gets the same honest sign-in
 * handoff copy proposed for the workstream's package-access research lane
 * (7B) -- never a claim CityScroll has or can fetch the package itself.
 */
function officialActionSection(atom, opts) {
  const items = Array.isArray(opts?.official_source_items) ? opts.official_source_items : [];
  const officialNotice = items.find((item) => /city record/i.test(item.label || ""))
    || (atom.official_url ? { href: atom.official_url, label: "Official notice" } : null)
    || items[0]
    || null;
  const passportAction = items.find((item) => /passport/i.test(item.label || "")) || opts?.passport_action || null;
  const explicitPackageUrl = text(opts?.explicit_package_url);
  const signInRequired = Boolean(passportAction) && !explicitPackageUrl;
  const lastObserved = text(opts?.last_observed_at);
  return {
    official_notice: officialNotice,
    passport_action: passportAction,
    explicit_package_url: explicitPackageUrl,
    sign_in_required: signInRequired,
    sign_in_note: signInRequired
      ? `Package and Q&A require PASSPort sign-in.${lastObserved ? ` CityScroll last observed this matter on ${lastObserved}.` : ""}`
      : null,
  };
}

/**
 * Build the pursuit snapshot view model, or null when pursuit is not
 * meaningful for this row (rules 1, 2, 7). See module doc for the row/opts
 * contract; `opts` mirrors buildProcurementAlertAtom()'s override shape
 * (amount, deadline, opportunity_window, match_reasons, method, mwbe, kind)
 * plus pursuit-specific additions (epin, source_status_label, mwbe_view,
 * procurement_method, official_source_items, passport_action,
 * explicit_package_url, last_observed_at, important_dates, response_floor,
 * amount_benchmark, related_history_href, contextual_page_href,
 * preference_match, nativeSolicitationStage).
 */
export function buildPursuitSnapshot(row = {}, opts = {}) {
  const r = row || {};
  if (!pursuitSnapshotReady(r, opts)) return null;
  const atom = buildProcurementAlertAtom(r, opts);
  const importantDates = Array.isArray(opts.important_dates) ? opts.important_dates : (r.important_dates || []);
  const sourceStatus = text(opts.source_status_label || r.type_of_notice_description);
  const epin = text(opts.epin || r.epin || r.pin);

  return {
    schema: PROCUREMENT_PURSUIT_SNAPSHOT_SCHEMA,
    identity: {
      title: fact(atom.title, atom.title ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED),
      agency: fact(atom.agency, atom.agency ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED),
      epin: fact(epin, epin ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED),
      source_status: fact(sourceStatus, sourceStatus ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.NOT_OBSERVED),
    },
    decision_facts: {
      amount: amountFact(atom),
      method: methodFact(r),
      mwbe: mwbeFact(r, opts),
      opportunity_window: atom.opportunity_window,
      response_floor: opts.response_floor || null,
      pre_bid_conference: findImportantDate(importantDates, /pre-?bid|pre-?proposal/i),
      question_deadline: findImportantDate(importantDates, /question/i),
      due_date: deadlineFact(atom.deadline),
      contact: contactFact(r),
    },
    fit_context: {
      match_reasons: Array.isArray(atom.match_reasons) ? atom.match_reasons : [],
      preference_reasons: preferenceMatchSection(opts.preference_match),
      amount_benchmark: opts.amount_benchmark || null,
      related_history_href: text(opts.related_history_href),
      contextual_page_href: text(opts.contextual_page_href),
    },
    official_action: officialActionSection(atom, opts),
    cannot_verify: PURSUIT_UNVERIFIABLE_ROWS,
    urls: { cityscroll_url: atom.cityscroll_url, official_url: atom.official_url },
  };
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const STATUS_LABEL = Object.freeze({
  observed: "Published",
  derived: "Derived",
  user_provided: "Your input",
  not_observed: "Not observed",
  unavailable: "Unavailable",
});

function statusBadge(status) {
  const label = STATUS_LABEL[status] || STATUS_LABEL.not_observed;
  return `<span class="pursuit-status pursuit-status-${esc(status)}">${esc(label)}</span>`;
}

function factRow(label, valueHtml, status) {
  return `<div class="pursuit-fact"><dt>${esc(label)}</dt><dd>${valueHtml}${statusBadge(status)}</dd></div>`;
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : null;
}

function methodMwbeSummary(view) {
  if (!view) return null;
  const parts = [];
  if (view.section_6_129?.present) {
    parts.push(view.section_6_129.goal_percent != null
      ? `§6-129 participation goal (${view.section_6_129.goal_percent}%)`
      : "§6-129 participation goals");
  }
  if (view.ncsp?.present) parts.push("M/WBE Noncompetitive Small Purchase");
  if (view.accelerated?.present) parts.push("Accelerated procurement");
  return parts.length ? parts.join(", ") : null;
}

function officialLinkHtml(item) {
  if (!item?.href || !item?.label) return "";
  return `<a class="pursuit-official-link" href="${esc(item.href)}" target="_blank" rel="noopener noreferrer">${esc(item.label)}</a>`;
}

// Deliberately phrased as "No published X" rather than "X not published":
// this page's shared node-document render gate (gateNodePageRender,
// ./civic_document_chrome.mjs) rejects the literal substring "not published"
// as reader-facing cruft (it exists to stop CityScroll announcing its own
// pipeline gaps). Here the missing fact is a property of the source record,
// not of CityScroll's materialization, but the gate cannot tell the two
// apart, so this module's copy avoids the banned phrase everywhere it
// renders rather than special-casing one surface.
function noPublished(noun) {
  return `No published ${noun}`;
}
const NONE_PUBLISHED = "None published";

function identitySectionHtml(identity) {
  const rows = [
    factRow("Title", esc(identity.title.value || noPublished("title")), identity.title.status),
    factRow("Agency", esc(identity.agency.value || noPublished("agency")), identity.agency.status),
    factRow("EPIN / PIN", esc(identity.epin.value || NONE_PUBLISHED), identity.epin.status),
    factRow("Source status", esc(identity.source_status.value || NONE_PUBLISHED), identity.source_status.status),
  ].join("");
  return `<div class="pursuit-fact-group" data-pursuit-section="identity"><dl class="pursuit-facts">${rows}</dl></div>`;
}

function decisionFactsSectionHtml(facts) {
  const amountHtml = facts.amount.status === PURSUIT_FIELD_STATUS.OBSERVED
    ? esc(formatMoney(facts.amount.value) || noPublished("amount"))
    : esc(noPublished("amount"));
  const dueHtml = facts.due_date.status === PURSUIT_FIELD_STATUS.OBSERVED
    ? esc(facts.due_date.label || facts.due_date.value)
    : esc(noPublished("due date"));
  const preBidHtml = facts.pre_bid_conference.status === PURSUIT_FIELD_STATUS.OBSERVED
    ? esc(facts.pre_bid_conference.label || facts.pre_bid_conference.value)
    : esc(NONE_PUBLISHED);
  const questionsHtml = facts.question_deadline.status === PURSUIT_FIELD_STATUS.OBSERVED
    ? esc(facts.question_deadline.label || facts.question_deadline.value)
    : esc(NONE_PUBLISHED);
  const contactHtml = facts.contact.status === PURSUIT_FIELD_STATUS.OBSERVED
    ? esc(facts.contact.value)
    : esc(NONE_PUBLISHED);
  const methodHtml = facts.method.status === PURSUIT_FIELD_STATUS.OBSERVED
    ? esc(facts.method.value)
    : esc(noPublished("method"));
  const mwbeSummary = facts.mwbe.status === PURSUIT_FIELD_STATUS.DERIVED ? methodMwbeSummary(facts.mwbe.value) : null;
  const mwbeHtml = mwbeSummary ? esc(mwbeSummary) : esc(noPublished("M/WBE marker"));
  const mwbeStatus = mwbeSummary ? facts.mwbe.status : PURSUIT_FIELD_STATUS.NOT_OBSERVED;

  const windowLine = facts.opportunity_window?.available
    ? opportunityWindowDisplayLine(facts.opportunity_window, facts.response_floor)
    : (facts.opportunity_window?.label || "Window unavailable");
  const windowStatus = facts.opportunity_window?.available
    ? (facts.opportunity_window.kind === "response_window" ? PURSUIT_FIELD_STATUS.OBSERVED : PURSUIT_FIELD_STATUS.DERIVED)
    : PURSUIT_FIELD_STATUS.UNAVAILABLE;

  const rows = [
    factRow("Amount", amountHtml, facts.amount.status),
    factRow("Method", methodHtml, facts.method.status),
    factRow("M/WBE", mwbeHtml, mwbeStatus),
    factRow("Response / notice-to-due window", esc(windowLine), windowStatus),
    factRow("Pre-bid / pre-proposal conference", preBidHtml, facts.pre_bid_conference.status),
    factRow("Questions deadline", questionsHtml, facts.question_deadline.status),
    factRow("Due date", dueHtml, facts.due_date.status),
    factRow("Published contact", contactHtml, facts.contact.status),
  ].join("");
  return `<div class="pursuit-fact-group" data-pursuit-section="decision-facts"><dl class="pursuit-facts">${rows}</dl></div>`;
}

// Deliberately a separate <div>/<ul> from pursuit-match-reasons below, with
// its own subhead and a per-item badge -- a preference-derived reason must
// never render inside the same list as a published-fact match reason, and
// must never lose its "your own stated preference" framing (card "PPD-05").
function preferenceReasonsSectionHtml(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return "";
  const items = reasons.map((entry) => (
    `<li>${esc(entry.wording)}<span class="pursuit-preference-badge" data-provenance="${esc(entry.provenance)}">Your stated preference</span></li>`
  )).join("");
  return `<div class="pursuit-preference-reasons" data-pursuit-preference-reasons="1"><p class="pursuit-subhead">Matches your stated preferences</p><ul>${items}</ul></div>`;
}

function fitContextSectionHtml(fitContext) {
  const parts = [];
  if (fitContext.match_reasons.length) {
    parts.push(`<div class="pursuit-match-reasons"><p class="pursuit-subhead">Why this reached you</p><ul>${
      fitContext.match_reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")
    }</ul></div>`);
  }
  const preferenceHtml = preferenceReasonsSectionHtml(fitContext.preference_reasons);
  if (preferenceHtml) {
    parts.push(preferenceHtml);
  }
  if (fitContext.amount_benchmark?.label) {
    parts.push(`<p class="pursuit-benchmark">${esc(fitContext.amount_benchmark.label)}</p>`);
  }
  if (fitContext.related_history_href) {
    parts.push(`<p><a class="pursuit-context-link" href="${esc(fitContext.related_history_href)}">Related procurement history</a></p>`);
  }
  if (fitContext.contextual_page_href) {
    parts.push(`<p><a class="pursuit-context-link" href="${esc(fitContext.contextual_page_href)}">More CityScroll context</a></p>`);
  }
  if (!parts.length) return "";
  return `<div class="pursuit-fact-group" data-pursuit-section="fit-context">${parts.join("")}</div>`;
}

function officialActionSectionHtml(action) {
  // A minimal-identity object without a distinct City Record link resolves
  // official_notice and passport_action to the same PASSPort destination --
  // render that destination once rather than as a visually duplicate pair.
  const sameDestination = action.official_notice?.href && action.official_notice.href === action.passport_action?.href;
  const links = [officialLinkHtml(action.official_notice), sameDestination ? "" : officialLinkHtml(action.passport_action)]
    .filter(Boolean)
    .join("");
  const signIn = action.sign_in_note
    ? `<p class="pursuit-sign-in-note">${esc(action.sign_in_note)}</p>`
    : "";
  if (!links && !signIn) return "";
  return `<div class="pursuit-fact-group" data-pursuit-section="official-action">${links ? `<p class="pursuit-official-links">${links}</p>` : ""}${signIn}</div>`;
}

function cannotVerifySectionHtml(rows) {
  const items = rows.map((row) => `<li>${esc(row.label)}</li>`).join("");
  return `<div class="pursuit-fact-group" data-pursuit-section="cannot-verify">
    <p class="pursuit-subhead">What CityScroll cannot verify</p>
    <p class="pursuit-cannot-verify-note">CityScroll's sources do not carry these -- this is not a finding that they are missing from the actual solicitation package.</p>
    <ul class="pursuit-cannot-verify-list">${items}</ul>
  </div>`;
}

/**
 * Render the pursuit snapshot to a self-contained HTML section. Callers
 * embed this near the top of procurement detail, above the existing
 * lifecycle/contract-fact sections (rule 10). Returns "" when `snapshot` is
 * null so an unready caller can splice this in unconditionally.
 */
export function renderPursuitSnapshotHtml(snapshot, { headingId = "pursuit-snapshot-heading" } = {}) {
  if (!snapshot) return "";
  return `<section class="pursuit-snapshot" aria-labelledby="${esc(headingId)}" data-pursuit-snapshot="1">
    <h2 id="${esc(headingId)}">Pursuit snapshot</h2>
    ${identitySectionHtml(snapshot.identity)}
    ${decisionFactsSectionHtml(snapshot.decision_facts)}
    ${fitContextSectionHtml(snapshot.fit_context)}
    ${officialActionSectionHtml(snapshot.official_action)}
    ${cannotVerifySectionHtml(snapshot.cannot_verify)}
  </section>`;
}
