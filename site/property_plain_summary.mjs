/**
 * Receipt-backed plain-language summaries for City Record Property notices.
 *
 * A classifier result is not enough to render a template. Each notice must also
 * contain a reader-visible pattern anchor, and every generated fact must retain
 * one or more exact source receipts. Notices that fail either gate return their
 * original rendered text instead of a forced summary.
 */

import { cleanNoticeText } from "./text_clean.mjs";
import { classifyPropertyPattern } from "./property_notice_patterns.mjs";
import { extractPropertyReaderActions } from "./property_reader_actions.mjs";
import { extractPropertyTimedEvents } from "./property_timed_events.mjs";

export const PROPERTY_PLAIN_SUMMARY_SCHEMA = "cityscroll.property_plain_summary.v1";

const HIDDEN_BODY_FIELDS = Object.freeze([
  "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
]);

function readerVisibleRow(row) {
  return Object.fromEntries(Object.entries({ ...row, ...Object.fromEntries(HIDDEN_BODY_FIELDS.map((field) => [field, ""])) }));
}

function readerSources(row) {
  return ["short_title", "additional_description_1"]
    .map((field) => ({ field, text: cleanNoticeText(row?.[field]) }))
    .filter((source) => source.text);
}

function cleanReceipt(source, start, end) {
  return {
    field: source.field,
    start,
    end,
    text: source.text.slice(start, end),
    normalization: "clean_notice_text",
  };
}

function firstReceipt(row, pattern) {
  for (const source of readerSources(row)) {
    pattern.lastIndex = 0;
    const match = pattern.exec(source.text);
    if (match) return cleanReceipt(source, match.index, match.index + match[0].length);
  }
  return null;
}

function sourceForReceipt(row, receipt) {
  const raw = String(row?.[receipt?.field] || "");
  return receipt?.normalization === "clean_notice_text" ? cleanNoticeText(raw) : raw;
}

function validReceipt(row, receipt) {
  if (!receipt || !receipt.field || !Number.isInteger(receipt.start) || !Number.isInteger(receipt.end)) return false;
  if (receipt.start < 0 || receipt.end <= receipt.start || !receipt.text) return false;
  return sourceForReceipt(row, receipt).slice(receipt.start, receipt.end) === receipt.text;
}

function eventReceipt(row, event) {
  const span = event?.source_span || event?.evidence;
  const field = event?.source_field || span?.field;
  if (!field || !span?.text) return null;
  const receipt = {
    field,
    start: span.start,
    end: span.end,
    text: span.text,
  };
  return validReceipt(row, receipt) ? receipt : null;
}

function actionReceipt(row, action) {
  const source = action?.how;
  if (!source?.field || !source?.text) return null;
  const receipt = {
    field: source.field,
    start: source.start,
    end: source.end,
    text: source.text,
    normalization: "clean_notice_text",
  };
  return validReceipt(row, receipt) ? receipt : null;
}

function fact(kind, text, sources, basis = "source_template") {
  return { kind, text, basis, sources: sources.filter(Boolean) };
}

function fallback(row, pattern, reason) {
  return {
    schema: PROPERTY_PLAIN_SUMMARY_SCHEMA,
    pattern,
    templated: false,
    fallback_reason: reason,
    text: cleanNoticeText(row?.additional_description_1) || cleanNoticeText(row?.short_title),
    facts: [],
    definitions: [],
    events: [],
    reader_actions: null,
  };
}

function whatFact(row, pattern) {
  if (pattern === "pending_destruction") {
    const receipt = firstReceipt(row, /pending destruction[\s\S]{0,240}\bseized\b|products? (?:were |was )?seized[\s\S]{0,100}(?:destroyed|destruction)/i);
    return receipt ? fact("what", "The listed products were seized and may be destroyed.", [receipt]) : null;
  }
  if (pattern === "unclaimed_property") {
    const receipt = firstReceipt(row, /(?:list(?:ed)?|properties?)[\s\S]{0,180}property clerk[\s\S]{0,100}without claimants|property clerk[\s\S]{0,180}without claimants/i);
    return receipt ? fact("what", "The Property Clerk has listed items with no one claiming ownership.", [receipt]) : null;
  }
  if (pattern === "forest_timber_sale") {
    const forest = firstReceipt(row, /forest management project/i);
    if (forest) return fact("what", "This is a forest management project.", [forest]);
    const timberSale = firstReceipt(row, /sale of timber and firewood|(?:timber and firewood|firewood and timber) sale/i);
    return timberSale ? fact("what", "This is a sale of timber and firewood.", [timberSale]) : null;
  }
  if (pattern === "lease_or_real_property_rfp") {
    const leaseProposal = firstReceipt(row, /leasing opportunities|lease offers?/i);
    if (leaseProposal) return fact("what", "This notice asks for proposals about a property lease.", [leaseProposal]);
    const proposal = firstReceipt(row, /request for proposals|\bRFP\b/i);
    if (proposal) return fact("what", "This notice asks for proposals.", [proposal]);
    const auction = firstReceipt(row, /online public lease auction|lease auction/i);
    return auction ? fact("what", "This notice is about a public auction for a property lease.", [auction]) : null;
  }
  if (pattern === "surplus_auction") {
    const vehicle = firstReceipt(row, /auto auction|vehicles?|subway car/i);
    if (vehicle) return fact("what", "This is a vehicle auction.", [vehicle]);
    const equipment = firstReceipt(row, /(?:heavy machinery|equipment)[\s\S]{0,80}auctions?|auctions?[\s\S]{0,80}(?:heavy machinery|equipment)/i);
    if (equipment) return fact("what", "This notice is about an equipment auction.", [equipment]);
    const surplus = firstReceipt(row, /surplus assets?[\s\S]{0,100}(?:auction|selling)|(?:auction|selling)[\s\S]{0,100}surplus assets?/i);
    return surplus ? fact("what", "This notice is about a sale of surplus items.", [surplus]) : null;
  }
  if (pattern === "direct_property_sale") {
    const mortgage = firstReceipt(row, /sale\/assignment of mortgage|sale of city mort?gage and note/i);
    if (mortgage) return fact("what", "This notice is about the sale of a mortgage or note.", [mortgage]);
    const property = firstReceipt(row, /public sale of residential property|real estate public auction|real property[\s\S]{0,50}public auction/i);
    return property ? fact("what", "This notice is about a public sale of real property.", [property]) : null;
  }
  if (pattern === "medallion_auction") {
    const result = firstReceipt(row, /winning bidders?|auction results?|apparent highest bidders?/i);
    const medallion = firstReceipt(row, /medallion (?:auction|sale)|(?:auction|sale)[\s\S]{0,40}(?:taxicab )?medallions?/i);
    if (result && medallion) return fact("what", "A taxi medallion auction was held. This notice lists the winning bidders.", [medallion, result]);
    const auction = firstReceipt(row, /medallion (?:auction|sale)|auction[\s\S]{0,40}medallion/i);
    return auction ? fact("what", "This is an auction of taxi medallions.", [auction]) : null;
  }
  if (pattern === "udaap") {
    const receipt = firstReceipt(row, /\bUDAAP\b|Urban Development Action Area Project/i);
    return receipt ? fact("what", "This notice is about an Urban Development Action Area Project (UDAAP).", [receipt]) : null;
  }
  if (pattern === "acquisition_or_easement") {
    const condemnation = firstReceipt(row, /condemnation|eminent domain/i);
    if (condemnation) return fact("what", "This notice is about a government acquisition through eminent domain.", [condemnation]);
    const easement = firstReceipt(row, /\beasement\b/i);
    if (easement) return fact("what", "This notice is about a legal right to use part of a property.", [easement]);
    const acquisitionProperty = firstReceipt(row, /\bacquisition\b[\s\S]{0,100}\bpropert(?:y|ies)\b/i);
    if (acquisitionProperty) return fact("what", "This notice is about getting a property right.", [acquisitionProperty]);
    const acquisition = firstReceipt(row, /\bacquisition\b|\bacquire(?:s|d)?\b|\bvesting\b/i);
    const property = firstReceipt(row, /real property|property right|city-owned propert(?:y|ies)|\blease\b/i);
    return acquisition && property ? fact("what", "This notice is about getting a property right.", [acquisition, property]) : null;
  }
  if (pattern === "disposition") {
    const sectionPointer = firstReceipt(row, /all notices regarding housing preservation(?: and development)? dispositions? of city-owned propert(?:y|ies)[\s,]*(?:appear|appears) in the public hearing section/i);
    if (sectionPointer) return fact("what", "These notices are in the Public Hearing section.", [sectionPointer]);
    const hearing = firstReceipt(row, /(?:voluntary )?public hearing[\s\S]{0,60}(?:(?:will be|is|to be) held|scheduled to (?:take place|begin))/i);
    const property = firstReceipt(row, /property|lease|disposition area|proposed disposition/i);
    if (hearing && property) return fact("what", "This notice is about a public hearing on a property matter.", [hearing, property]);
    const transfer = firstReceipt(row, /convey(?:ance|ed|s|ing)|transfer of (?:the )?(?:property|stated property right)/i);
    return transfer ? fact("what", "This notice is about a transfer of the stated property right.", [transfer]) : null;
  }
  return null;
}

const MONTHS = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

function displayDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  let text = `${month} ${Number(match[3])}, ${match[1]}`;
  if (match[4]) {
    const hour = Number(match[4]);
    const minute = match[5] || "00";
    text += ` at ${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
  }
  return text;
}

function eventText(event) {
  const start = displayDate(event?.start);
  const end = displayDate(event?.end);
  const deadline = displayDate(event?.deadline);
  if (event.kind === "hearing" && start) return `The hearing is on ${start}.`;
  if (event.kind === "auction_window" && start && end) return `The auction runs from ${start} through ${end}.`;
  if (event.kind === "auction" && start) return `The auction is on ${start}.`;
  if (event.kind === "sale" && start) return `The sale is on ${start}.`;
  if (event.kind === "bid_deadline" && deadline) return `Bids are due by ${deadline}.`;
  if (event.kind === "inspection_showing" && start) return `A site visit is on ${start}.`;
  if (event.kind === "accommodation_deadline" && deadline) return `Ask for an interpreter by ${deadline}.`;
  if (event.kind === "objection_deadline" && deadline) return `Objections are due by ${deadline}.`;
  if (event.kind === "comment_deadline" && deadline) return `Comments are due by ${deadline}.`;
  if (event.kind === "result_award" && deadline) return `The notice gives ${deadline} for the result.`;
  return null;
}

function actionText(action, pattern) {
  if (action.kind === "bid") return /proposal/i.test(action.how?.text || "") ? "You can send a proposal." : "You can send a bid.";
  if (action.kind === "inspect") return /showing/i.test(action.how?.text || "")
    ? "You can go to a public showing."
    : "You can inspect the site or item.";
  if (action.kind === "attend") return "You can attend and speak at the hearing.";
  if (action.kind === "comment") return "You can send a comment.";
  if (action.kind === "object") return "You can send an objection.";
  if (action.kind === "inquire_claim" && pattern === "pending_destruction") return "You can ask about the listed products.";
  if (action.kind === "inquire_claim" && pattern === "unclaimed_property") return "You can ask the Property Clerk about the items.";
  if (action.kind === "inquire_claim") return "You can ask the contact in the notice for more details.";
  if (action.kind === "request_accommodation") {
    return /sign language interpreter/i.test(action.how?.text || "")
      ? "You can ask for a sign language interpreter."
      : "You can ask for an accommodation.";
  }
  if (action.kind === "review_documents") return "You can review the records listed in the notice.";
  if (action.kind === "review_result") return "You can review the auction results.";
  return null;
}

const TERM_DEFINITIONS = Object.freeze([
  [/\bpursuant to\b/i, "pursuant_to", '"Pursuant to" means "under."'],
  [/\bnotice is hereby given\b/i, "notice_hereby_given", 'The words "notice is hereby given" mean "this notice says."'],
  [/\bdisposition area\b/i, "disposition_area", '"Disposition Area" means the property in this notice.'],
  [/\bconvey(?:ance|ed|s|ing)\b/i, "conveyance", "A conveyance is a transfer of the stated property right."],
  [/as soon thereafter as the matter may be reached on the calendar/i, "calendar_delay", "The hearing may start late if earlier items run long."],
  [/available for public examination/i, "public_examination", "The public can review the records at the place and times in the notice."],
  [/\beasement\b/i, "easement", "An easement is a legal right to use part of a property."],
  [/\bcondemnation\b|eminent domain/i, "condemnation", "Condemnation is government acquisition through eminent domain."],
  [/\bupset price\b/i, "upset_price", "The upset price is the lowest price the seller will take at auction."],
  [/\bsealed bids?\b/i, "sealed_bid", "A sealed bid stays private until bids are opened."],
  [/\bforfeiture\b/i, "forfeiture", "Forfeiture means legal loss of the products under the law in the notice."],
  [/\bUnauthorized Products?\b/i, "unauthorized_products", '"Unauthorized Products" are the product groups the notice lists as untaxed, unlicensed, or barred from sale.'],
  [/\bclaimants?\b/i, "claimants", "Claimants are people who say they own the items."],
  [/\bboard feet\b/i, "board_feet", "Board feet is a unit for lumber volume."],
  [/\bcordwood\b|\bcords? of (?:hardwood |softwood )?(?:fire)?wood\b/i, "cordwood", "Cordwood is wood measured in cords."],
  [/\bshall\b/i, "shall", '"Shall" means "must."'],
]);

function termDefinitions(row) {
  return TERM_DEFINITIONS.map(([pattern, kind, text]) => {
    const receipt = firstReceipt(row, pattern);
    return receipt ? fact(kind, text, [receipt], "census_plain_equivalent") : null;
  }).filter(Boolean);
}

function suppliedEvents(options, row) {
  const supplied = options?.events || row?.property_timed_events || row?.commercial?.timed_events;
  if (Array.isArray(supplied)) return supplied;
  if (Array.isArray(supplied?.events)) return supplied.events;
  return extractPropertyTimedEvents(row);
}

function suppliedReaderActions(options, row, events) {
  const supplied = options?.readerActions || row?.property_reader_actions;
  if (supplied?.actions && Array.isArray(supplied.actions)) return supplied;
  if (Array.isArray(supplied)) return { actions: supplied };
  return extractPropertyReaderActions(row, { today: options?.today, events });
}

/** Build a plain summary from reader-visible source text and ships 2/3 structures. */
export function buildPropertyPlainSummary(row = {}, options = {}) {
  const visibleRow = readerVisibleRow(row);
  const pattern = classifyPropertyPattern(row);
  const lead = whatFact(visibleRow, pattern);
  if (!lead) return fallback(visibleRow, pattern, "no_reader_visible_pattern_anchor");

  const events = suppliedEvents(options, visibleRow).filter((event) => eventReceipt(visibleRow, event));
  const readerActions = suppliedReaderActions(options, visibleRow, events);
  const actions = (readerActions?.actions || []).filter((action) => actionReceipt(visibleRow, action));
  const facts = [lead];
  const eventKeys = new Set();
  for (const event of events) {
    const text = eventText(event);
    const receipt = eventReceipt(visibleRow, event);
    const key = `${event.kind}:${text}`;
    if (!text || !receipt || eventKeys.has(key)) continue;
    eventKeys.add(key);
    facts.push(fact(`event_${event.kind}`, text, [receipt], "typed_event"));
  }
  for (const action of actions) {
    const text = actionText(action, pattern);
    const receipt = actionReceipt(visibleRow, action);
    if (text && receipt) facts.push(fact(`action_${action.kind}`, text, [receipt], "reader_action"));
  }
  const definitions = termDefinitions(visibleRow);
  return {
    schema: PROPERTY_PLAIN_SUMMARY_SCHEMA,
    pattern,
    templated: true,
    fallback_reason: null,
    text: facts.map((item) => item.text).join(" "),
    facts,
    definitions,
    events,
    reader_actions: { ...readerActions, actions },
  };
}

/** Text scored by the census: authored summary plus any displayed term definitions. */
export function propertyPlainSummarySurface(summary) {
  if (!summary?.templated) return null;
  return [summary.text, ...(summary.definitions || []).map((item) => item.text)].filter(Boolean).join(" ");
}

function defaultEscape(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function uniqueReceipts(summary) {
  const seen = new Set();
  return [...(summary?.facts || []), ...(summary?.definitions || [])]
    .flatMap((item) => item.sources || [])
    .filter((receipt) => {
      const key = `${receipt.field}:${receipt.start}:${receipt.end}:${receipt.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Progressive-disclosure HTML: summary first, exact source wording on demand. */
export function propertyPlainSummaryHTML(summary, helpers = {}) {
  if (!summary?.templated) return "";
  const esc = helpers.escape || defaultEscape;
  const fieldLabel = (field) => field === "short_title"
    ? "Notice title"
    : field === "event_date" ? "City Record event date" : "Official notice text";
  const definitions = (summary.definitions || []).length
    ? `<div class="property-plain-definitions"><div class="stage-name">Terms in this notice</div><ul>${summary.definitions.map((item) => `<li lang="en" dir="ltr">${esc(item.text)}</li>`).join("")}</ul></div>`
    : "";
  const receipts = uniqueReceipts(summary);
  const source = receipts.length
    ? `<details class="inline-disclose property-plain-sources"><summary>See the source wording</summary><div class="inline-disclose-body"><ul>${receipts.map((receipt) => `<li><b>${fieldLabel(receipt.field)}</b>: <q lang="en" dir="ltr">${esc(receipt.text)}</q></li>`).join("")}</ul></div></details>`
    : "";
  return `<section class="property-plain-summary" data-property-plain-summary="1" data-pattern="${esc(summary.pattern)}" aria-label="What this notice means">
    <div class="chain-h">What this means</div>
    <p class="property-plain-text" lang="en" dir="ltr">${esc(summary.text)}</p>
    ${definitions}
    ${source}
  </section>`;
}
