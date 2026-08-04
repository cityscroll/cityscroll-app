/**
 * Source-grounded actions from Property Disposition notices.
 *
 * Each action requires a literal action phrase. The extractor records the exact
 * cleaned source span, any stated method, and a typed/structured date when one is
 * available. Missing methods and dates stay null; this module never fills them in.
 */

import { cleanNoticeText } from "./text_clean.mjs";
import { classifyPropertyPattern } from "./property_notice_patterns.mjs";

export const PROPERTY_READER_ACTIONS_SCHEMA_VERSION = 1;
export const PROPERTY_ACTION_KINDS = Object.freeze([
  "bid",
  "inspect",
  "attend",
  "comment",
  "object",
  "inquire_claim",
  "request_accommodation",
  "review_documents",
  "review_result",
]);

export const PROPERTY_ACTION_ORDER = Object.freeze([
  "bid", "inspect", "attend", "comment", "object", "inquire_claim",
  "request_accommodation", "review_documents", "review_result",
]);

const ACTION_RAIL_META = Object.freeze({
  bid: ["disposition_phase_action_bid", "Bid or submit a proposal", "bid_checklist"],
  inspect: ["property_action_open_notice", "Inspect the site or sale item", "document"],
  attend: ["disposition_phase_action_attend", "Attend and be heard", "attend"],
  comment: ["property_action_open_notice", "Submit a comment", "comment"],
  object: ["property_action_open_notice", "Submit an objection", "contact"],
  inquire_claim: ["property_action_open_notice", "Ask about or claim property", "contact"],
  request_accommodation: ["property_action_open_notice", "Request an accommodation", "contact"],
  review_documents: ["property_action_open_notice", "Review published records", "document"],
  review_result: ["disposition_phase_action_conveyance", "Review the result", "document"],
});

const BODY_FIELDS = Object.freeze([
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
]);

const ALLOWED_BY_PATTERN = Object.freeze({
  pending_destruction: new Set(["inquire_claim"]),
  unclaimed_property: new Set(["inquire_claim"]),
  forest_timber_sale: new Set(["bid", "inspect", "inquire_claim"]),
  lease_or_real_property_rfp: new Set(["bid", "inspect", "attend", "request_accommodation", "review_documents", "inquire_claim"]),
  surplus_auction: new Set(["bid", "inspect", "inquire_claim"]),
  direct_property_sale: new Set(["bid", "attend", "review_documents", "inquire_claim"]),
  medallion_auction: new Set(["bid", "review_result", "inquire_claim"]),
  udaap: new Set(["attend", "comment", "object", "request_accommodation", "review_documents"]),
  acquisition_or_easement: new Set(["attend", "comment", "object", "request_accommodation", "review_documents"]),
  disposition: new Set(["attend", "comment", "object", "request_accommodation", "review_documents"]),
  other: new Set(PROPERTY_ACTION_KINDS),
});

const ACTION_PATTERNS = Object.freeze({
  bid: /\b(?:(?:submit|place|begin|make|receive|accept|offer|send|mail|deliver)\w*[^.]{0,120}\b(?:bids?|proposals?)\b|(?:bids?|proposals?)[^.]{0,120}(?:must|shall|may|will|can)[^.]{0,80}(?:submit|receive|accept|place|deliver|mail|send)\w*|to begin bidding)\b/i,
  inspect: /\b(?:show dates?|public showings?|inspection[^.]{0,100}(?:date|time|available)|prospective bidders are (?:required|encouraged) to attend)[^.]{0,180}/i,
  attend: /\b(?:wishing to be heard|opportunity to be heard|may (?:appear|attend)[^.]{0,80}(?:and )?be heard|invited to attend[^.]{0,100}(?:hearing|sale)|attend[^.]{0,80}(?:public )?hearing)\b/i,
  request_accommodation: /\b(?:individuals? requesting[^.]{0,220}(?:interpreter|accommodation)|request(?:ing)?[^.]{0,120}(?:sign language interpreter|reasonable accommodation)|(?:sign language interpreter|reasonable accommodation)[^.]{0,160}(?:request|contact))[^.]{0,220}/i,
  review_documents: /\b(?:available for public examination|(?:the public |public )?(?:can|may) (?:inspect|review)[^.]{0,100}(?:appraisal|agreement|terms|documents?))[^.]{0,180}/i,
  review_result: /\b(?:winning bidders?|auction results?|apparent highest bidders?)[^.]{0,180}/i,
  inquire_claim: /\b(?:inquiries relating[^.]{0,220}|owners are wanted[^.]{0,180}|claim(?:ing)? ownership[^.]{0,160}|(?:for (?:further )?(?:information|questions)|questions regarding)[^.]{0,180}(?:contact|call|email|write)|contact the (?:civil enforcement unit|property clerk)[^.]{0,180})/i,
  // Object/comment require the act and its submission method in the same source span.
  object: /\b(?:(?:file|mail|send|submit|serve|interpose)[^.]{0,90}(?:an? )?objection|objections?[^.]{0,90}(?:must|may|should)[^.]{0,60}(?:filed|mailed|sent|submitted|served))[^.]{0,180}/i,
  comment: /\b(?:(?:mail|email|send|submit)[^.]{0,90}(?:written )?comments?|comments?[^.]{0,90}(?:may|must|should)[^.]{0,60}(?:submitted|sent|mailed|emailed))[^.]{0,180}/i,
});

const EVENT_KINDS = Object.freeze({
  bid: new Set(["bid_deadline", "proposal_deadline", "auction_window", "auction", "sale", "auction_end", "auction_window_end"]),
  inspect: new Set(["inspection", "inspection_showing", "showing"]),
  attend: new Set(["hearing", "hearing_start", "event_date"]),
  comment: new Set(["comment_deadline", "testimony_deadline"]),
  object: new Set(["objection_deadline"]),
  request_accommodation: new Set(["accommodation_deadline", "accommodation_request_deadline"]),
  review_result: new Set(["result_date", "award_date", "result_award"]),
});

function sourceFields(row) {
  return ["short_title", ...BODY_FIELDS]
    .map((field) => ({ field, text: cleanNoticeText(row?.[field]) }))
    .filter((entry) => entry.text);
}

function boundedSpan(text, match) {
  const hitStart = match.index || 0;
  const hitEnd = hitStart + match[0].length;
  let start = 0;
  for (const boundary of text.matchAll(/[.!?](?=\s|$)/g)) {
    if ((boundary.index || 0) >= hitStart) break;
    start = (boundary.index || 0) + 1;
  }
  const tail = text.slice(hitEnd);
  const next = /[.!?](?=\s|$)/.exec(tail);
  let end = next ? hitEnd + (next.index || 0) + 1 : text.length;
  if (hitStart - start > 180) start = Math.max(0, hitStart - 80);
  if (end - hitEnd > 240) end = Math.min(text.length, hitEnd + 160);
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trimmedLength = raw.trimEnd().length;
  return { start: start + leading, end: start + trimmedLength, text: raw.trim() };
}

function firstEvidence(row, pattern) {
  if (!pattern) return null;
  for (const entry of sourceFields(row)) {
    const match = pattern.exec(entry.text);
    if (!match) continue;
    const span = boundedSpan(entry.text, match);
    return {
      field: entry.field,
      start: span.start,
      end: span.end,
      text: span.text,
      matched_text: match[0].trim(),
    };
  }
  return null;
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statedMethods(row, evidence, kind) {
  const methods = [];
  const text = evidence?.text || "";
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const value = match[0].replace(/[.,;:]+$/, "");
    methods.push({ kind: "url", value, source: evidence });
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    methods.push({ kind: "email", value: match[0], source: evidence });
  }
  for (const match of text.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g)) {
    methods.push({ kind: "phone", value: match[0], source: evidence });
  }
  if (/\b(?:mail|mailed|mailing)\b/i.test(text)) methods.push({ kind: "mail", value: evidence.text, source: evidence });
  if (/\b(?:in person|at its offices?|at the following (?:office|location))\b/i.test(text)) {
    methods.push({ kind: "in_person", value: evidence.text, source: evidence });
  }
  if (/\b(?:online|website|webpage|electronically)\b/i.test(text)) {
    methods.push({ kind: "online", value: evidence.text, source: evidence });
  }

  // Structured City Record contact fields are source data. They supplement, but do not
  // replace, the literal action phrase that was required above.
  if (row?.email) methods.push({ kind: "email", value: cleanNoticeText(row.email), source: { field: "email", text: cleanNoticeText(row.email) } });
  if (row?.contact_phone) methods.push({ kind: "phone", value: cleanNoticeText(row.contact_phone), source: { field: "contact_phone", text: cleanNoticeText(row.contact_phone) } });
  if (row?.contact_name) methods.push({ kind: "contact", value: cleanNoticeText(row.contact_name), source: { field: "contact_name", text: cleanNoticeText(row.contact_name) } });

  if (kind === "attend") {
    const venue = [row?.building_name, row?.street_address_1, row?.street_address_2, row?.city, row?.state, row?.zip_code] // source: City Record Online dg92-zbpx
      .map(cleanNoticeText).filter(Boolean).join(", ");
    if (venue) methods.push({ kind: "venue", value: venue, source: { field: "structured_venue", text: venue } });
  }
  return uniqueBy(methods, (method) => `${method.kind}:${String(method.value).toLowerCase()}`).slice(0, 8);
}

function candidateEvents(row, options) {
  const supplied = options?.events
    || row?.property_timed_events
    || row?.property_events
    || row?.timed_events
    || row?.commercial?.timed_events
    || [];
  if (Array.isArray(supplied)) return supplied;
  if (Array.isArray(supplied.events)) return supplied.events;
  return [];
}

function eventDate(event) {
  return event?.deadline || event?.end || event?.start || event?.at || event?.date || event?.value || null;
}

function eventKind(event) {
  return String(event?.kind || event?.type || "").toLowerCase();
}

function evidenceFromEvent(event) {
  const evidence = event?.evidence || event?.source_span || null;
  if (!evidence) return null;
  if (typeof evidence === "string") return { field: event?.source_field || null, text: evidence };
  return {
    field: evidence.field || event?.source_field || null,
    start: evidence.start ?? null,
    end: evidence.end ?? null,
    text: evidence.text || evidence.span || null,
  };
}

function byWhenFor(kind, row, options, evidence) {
  const accepted = EVENT_KINDS[kind] || new Set();
  const event = candidateEvents(row, options).find((item) => accepted.has(eventKind(item)));
  if (event) {
    const value = eventDate(event);
    return value ? {
      kind: eventKind(event),
      value,
      label: evidenceFromEvent(event)?.text || String(value),
      source: evidenceFromEvent(event),
    } : null;
  }
  if (kind === "attend" && row?.event_date) {
    return { kind: "hearing", value: row.event_date, label: String(row.event_date), source: { field: "event_date", text: String(row.event_date) } };
  }
  if (kind === "request_accommodation" && row?.event_date) {
    // The hearing date is context, not the accommodation deadline. Preserve the
    // source phrase as the by-when label without assigning the hearing date to it.
    const phrase = evidence?.text?.match(/no later than[^.]{0,100}|at least[^.]{0,100}(?:before|prior)[^.]{0,60}/i)?.[0];
    return phrase ? { kind: "accommodation_deadline_text", value: null, label: phrase.trim(), source: evidence } : null;
  }
  const deadlinePhrase = evidence?.text?.match(/(?:no later than|due|by|before|until|through|within)[^.]{0,120}/i)?.[0];
  return deadlinePhrase
    ? { kind: `${kind}_deadline_text`, value: null, label: deadlinePhrase.trim(), source: evidence }
    : null;
}

function isoDay(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function actionStatus(kind, row, byWhen, today) {
  if (kind === "review_result") return "historical";
  const endDay = isoDay(byWhen?.value);
  if (endDay) return endDay < today ? "historical" : "current";
  if (kind === "request_accommodation") {
    // Without the typed-event extractor's derived accommodation deadline, the hearing date still
    // tells us whether the relative request instruction is live or historical.
    const hearingDay = isoDay(row?.event_date);
    if (hearingDay) return hearingDay < today ? "historical" : "undated";
  }
  if (kind === "inquire_claim" || kind === "review_documents") return "undated";
  const text = sourceFields(row).map((entry) => entry.text).join(" ");
  if (kind === "bid" && /\b(?:currently|every week|ongoing)\b/i.test(text)) return "undated";
  const published = isoDay(row?.start_date);
  if (published && published < today) return "historical";
  return "undated";
}

function makeAction(kind, pattern, row, options) {
  const evidence = firstEvidence(row, ACTION_PATTERNS[kind]);
  if (!evidence) return null;
  const byWhen = byWhenFor(kind, row, options, evidence);
  const today = isoDay(options?.today) || new Date().toISOString().slice(0, 10);
  return {
    schema_version: PROPERTY_READER_ACTIONS_SCHEMA_VERSION,
    kind,
    label: ACTION_RAIL_META[kind][1],
    band_id: kind,
    pattern,
    status: actionStatus(kind, row, byWhen, today),
    how: evidence,
    methods: statedMethods(row, evidence, kind),
    by_when: byWhen,
  };
}

function safeHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Extract the actions a reader can take from literal source text.
 *
 * @param {object} row City Record Property Disposition row
 * @param {{today?: string, events?: object[]|{events: object[]}}} options
 */
export function extractPropertyReaderActions(row = {}, options = {}) {
  const pattern = classifyPropertyPattern(row);
  const allowed = ALLOWED_BY_PATTERN[pattern] || ALLOWED_BY_PATTERN.other;
  const actions = PROPERTY_ACTION_ORDER
    .filter((kind) => allowed.has(kind))
    .map((kind) => makeAction(kind, pattern, row, options))
    .filter(Boolean)
    .map((action, index) => ({ ...action, id: `${pattern}-${action.kind}-${index + 1}` }));
  const actionable = actions.filter((action) => action.status !== "historical");
  const primary = (actionable.length ? actionable : actions)[0] || null;
  const meta = primary ? ACTION_RAIL_META[primary.kind] : null;
  const destination = primary
    ? (primary.methods || []).filter((method) => method.kind === "url").map((method) => safeHttps(method.value)).find(Boolean) || null
    : null;
  return {
    schema_version: PROPERTY_READER_ACTIONS_SCHEMA_VERSION,
    pattern,
    actions,
    actionable,
    historical: actions.filter((action) => action.status === "historical"),
    rail: primary ? {
      system: "property_reader_actions",
      mode: actionable.length ? "current" : "historical",
      pattern,
      actions: actions.slice(0, 10),
      build_actions: propertyReaderActionRail,
      render_steps: propertyReaderActionStepsHTML,
      heading_key: "rules_action_band_rail_label",
      has_fields: true,
      label_key: actionable.length ? meta[0] : "read_official_notice",
      label: actionable.length ? meta[1] : "Read the official notice",
      primary_type: actionable.length ? meta[2] : "document",
      primary_kind: primary.kind,
      deadline: primary.by_when?.value || null,
      destination,
      action: actionable.length ? {
        type: meta[2],
        label_key: meta[0],
        label: meta[1],
        delivery: destination ? "official_handoff" : "local",
        destination,
        destination_label: destination ? new URL(destination).hostname : null,
        deadline: primary.by_when?.value || null,
        confirmation_required: ["comment", "official_application"].includes(meta[2]),
      } : null,
    } : null,
  };
}

/** Compile through the registry's existing validation, handoff, calendar, and attend-pack helpers. */
export function propertyReaderActionRail(rail, matter, api) {
  const guide = { ...rail };
  if (guide.primary_kind === "attend" && guide.mode !== "historical") {
    guide.attendance = api.hearingHandoff({ ...matter, deadline: guide.deadline || matter.deadline });
  }
  const actions = guide.mode === "historical"
    ? [api.official("document", guide.label_key, guide.label, matter.official_notice_url, null, { guide })]
    : [api.validateAction({ ...guide.action, guide })];
  if (guide.mode !== "historical" && guide.primary_kind === "attend" && guide.deadline) {
    actions.push(api.local("calendar", "add_deadline_calendar", "Add deadline to calendar", null, guide.deadline));
  }
  actions.push(api.watch);
  return actions;
}

/** Property-only action-band markup, loaded with the detail extractor (not home boot). */
export function propertyReaderActionStepsHTML(actions, helpers = {}) {
  const t = helpers.t || ((key) => key);
  const esc = helpers.escape || ((value) => String(value || ""));
  const fdt = helpers.formatDate || ((value) => String(value || ""));
  const extAttrs = helpers.extAttrs || "";
  const extSr = helpers.extSr || (() => "");
  const methodHTML = (method) => {
    const value = esc(method?.value || "");
    if (!value) return "";
    if (method.kind === "email") return `<a href="mailto:${value}">${value}</a>`;
    if (method.kind === "url" && /^https:\/\//i.test(method.value || "")) {
      return `<a href="${value}" ${extAttrs}>${value}${extSr()}</a>`;
    }
    return `<span lang="en" dir="ltr">${value}</span>`;
  };
  const steps = [];
  for (const item of actions || []) {
    if (!item?.kind || !item.how) continue;
    const historical = item.status === "historical";
    const by = item.by_when?.value
      ? fdt(item.by_when.value)
      : item.by_when?.label ? esc(item.by_when.label) : t("task_bid_unknown");
    const methods = (item.methods || []).map(methodHTML).filter(Boolean);
    steps.push(`<div class="rules-action-band property-action-band" data-band="${esc(item.band_id || item.kind)}" data-status="${historical ? "historical" : "current"}">
        <span lang="en" dir="ltr">${esc(item.label)}</span>
        ${historical ? `<span class="band-count">${t("next_action_event_passed")}</span>` : ""}
      </div>
      <dl class="bid-guide-facts property-action-facts">
        <dt>${t("glance_what")}</dt><dd lang="en" dir="ltr">${esc(item.how.text)}</dd>
        <dt>${t("apply_method_lbl")}</dt><dd>${methods.length ? methods.join(" · ") : '<span lang="en" dir="ltr">No separate contact or submission channel is stated in this notice.</span>'}</dd>
        <dt>${t("task_lead_deadline")}</dt><dd>${by}</dd>
      </dl>`);
  }
  return steps.length ? steps : [t("next_action_unavailable_handoff")];
}
