/**
 * Work site named in an open City Record solicitation.
 *
 * A City Record notice has no place-of-performance field, so the only evidence of where the work
 * happens is the notice's own text. This module reads that text with the engine's existing place
 * primitives (`addressSpansIn`, `boroughsIn`, `plainText`), decides for each street address what
 * the sentence says the address is, and sends only the addresses the notice presents as the place
 * of the work through the existing typed-place resolver
 * (`site/procurement_contract_service_geography.mjs`).
 *
 * The honest claim is "the place named in this notice is in community district X", quoted from
 * the notice. A placed address keeps the typed role its sentence supports: work at the address
 * is `work_site` ("Work site"); goods purchased for delivery or installation, with no construction
 * of the place, are `delivery_site` ("Delivery site"); a property the notice offers for lease,
 * reuse or development is `facility_site` ("Property in this solicitation"). Addresses where bids
 * are delivered or opened, where documents are collected, where a pre-bid meeting or site tour is
 * held, or where an agency office sits are never published as one of those places. Nothing is
 * inferred from an agency name, a borough alone, or a vendor field.
 *
 * Pure: no network, no file reads, no clock. The geocoder and the boundary layers are injected.
 */

import { addressSpansIn } from "./location_derivation.mjs";
import { boroughsIn, normalizeAddress, plainText } from "./location_extract.mjs";
import {
  CONTRACT_PLACE_ROLES,
  PLACE_INPUT_KINDS,
  RESOLUTION_STATES,
  admitContractPlaceAssertion,
  resolveContractPlaceAssertion,
} from "./procurement_contract_service_geography.mjs";

export const OPEN_NOTICE_WORK_SITE_SOURCE = "city_record_notice_text";
export const OPEN_NOTICE_WORK_SITE_COVERAGE_SCHEMA = "cityscroll.open_notice_work_site_coverage.v1";
export const OPEN_NOTICE_WORK_SITE_RULE_VERSION = "work-site-v1";
export const OPEN_NOTICE_WORK_SITE_RULE = [
  "A street address in the notice text is a work site only when the notice presents it as the place of",
  "the work: it is in the notice title, it follows a LOCATION label that is not part of a pre-bid meeting",
  "block, or its sentence says the work, project or facility is located at it.",
  "Addresses where bids are delivered or opened, where documents are collected, where a pre-bid meeting",
  "or site tour is held, where an agency office sits, or whose role the sentence does not say are never",
  "work sites. A work-site address is geocoded in the City Planning Property Address Directory snapshot,",
  "placed on its tax-lot point, and joined to the community district whose boundary contains the point.",
  "No vendor field, agency name or bare borough is used. Nothing is guessed.",
  "Each placed address is labelled from the typed role that sentence supports:",
  "\"Work site\", \"Delivery site\", or \"Property in this solicitation\".",
  "When a LOCATION line names a facility the notice title already names, the quote is the street address as written.",
].join(" ");

export const WORK_SITE_REASONS = Object.freeze([
  "resolved",
  "no_place_named",
  "borough_only",
  "broad_scope",
  "only_bid_drop_address",
  "only_meeting_address",
  "address_role_unclear",
  "address_not_resolved",
  "ambiguous",
  "notice_text_missing",
  "text_unavailable",
]);

export const ADDRESS_CLASSES = Object.freeze([
  "work_site",
  "bid_drop",
  "meeting",
  "agency_office",
  "unclear",
]);

/** Fields of a City Record notice that carry free text, in reading order. */
export const NOTICE_TEXT_FIELDS = Object.freeze([
  "short_title",
  "additional_description_1",
  "additional_description_2",
  "additional_description_3",
  "other_info_1",
  "other_info_2",
  "other_info_3",
  "printout_1",
  "printout_2",
  "printout_3",
]);

const MAX_SITES_PER_NOTICE = 6;
const QUOTE_MAX = 280;
const STREET_TYPES = "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Place|Pl|Lane|Ln|Drive|Dr|Parkway|Pkwy|Broadway|Court|Ct|Terrace|Plaza";

const ABBREVIATIONS = new Set([
  "st", "ave", "rd", "blvd", "pl", "ln", "dr", "pkwy", "ct", "no", "nos", "inc", "co", "corp", "ltd",
  "jr", "sr", "mr", "ms", "mrs", "dr", "fl", "rm", "ste", "apt", "dept", "vs", "mt", "ft", "a.m", "p.m",
  "e.g", "i.e", "etc", "l.i.c", "n.y", "u.s", "bldg", "hwy", "expy", "sq",
]);

/* ------------------------------------------------------------------------------------------ */
/* Segmentation                                                                                */
/* ------------------------------------------------------------------------------------------ */

function sentencesOf(text) {
  const out = [];
  let start = 0;
  const re = /[.!?]\s+(?=[A-Z0-9(])/g;
  let match;
  while ((match = re.exec(text))) {
    const head = text.slice(start, match.index);
    if (/(?:^|\s)\d{1,2}$/.test(head)) continue; // a numbered heading ("2. LOCATION"), not a sentence end
    const word = head.match(/([A-Za-z.]+)$/)?.[1]?.toLowerCase().replace(/\.$/, "") || "";
    const last = word.split(".").pop();
    if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(last) || (word.length === 1 && /[a-z]/.test(word))) continue;
    out.push(text.slice(start, match.index + 1));
    start = match.index + match[0].length;
  }
  out.push(text.slice(start));
  return out;
}

/**
 * Split one notice field into reading-order segments: block tags first (a notice's paragraphs and
 * list items are its units), then sentences, then the numbered and capitalised section headings
 * City agencies paste into the text. Each segment is plain text.
 */
export function splitNoticeSegments(raw) {
  const html = String(raw ?? "");
  if (!html.trim()) return [];
  const blocks = html.split(/<\/?(?:p|li|ul|ol|div|h[1-6]|tr|br)\b[^>]*>/i);
  const segments = [];
  for (const block of blocks) {
    const text = plainText(block);
    if (!text) continue;
    for (const sentence of sentencesOf(text)) {
      const pieces = sentence.split(
        /\s(?=\d\s?\.\s+[A-Z]{3,})|(?<!MANDATORY)(?<!\d\.)\s(?=(?:MANDATORY\s+)?PRE-?BID\s+(?:MEETING|CONFERENCE)\b)|\s(?=BID\s+OPENING\s+PLACE\b)/,
      );
      for (const piece of pieces) {
        const clean = piece.trim();
        if (clean) segments.push(clean);
      }
    }
  }
  return segments;
}

/* ------------------------------------------------------------------------------------------ */
/* Address mentions                                                                            */
/* ------------------------------------------------------------------------------------------ */

const TAIL_RE = new RegExp(
  "^(?:,\\s*(?:[A-Z][A-Za-z.'’]*)(?:\\s+[A-Z][A-Za-z.'’]*){0,2}(?=\\s*,?\\s*(?:NY|N\\.Y\\.|New York)\\b))?"
  + "(?:,?\\s*(?:the\\s+)?(?:Bronx|Brooklyn|Queens|Manhattan|Staten\\s+Island)\\b)?"
  + "(?:,?\\s*(?:NY|N\\.Y\\.|New\\s+York)\\b\\.?)?"
  + "(?:,?\\s*\\d{5}(?:-\\d{4})?\\b)?"
  + "(?:\\s+in\\s+(?:the\\s+)?(?:Bronx|Brooklyn|Queens|Manhattan|Staten\\s+Island)\\b)?",
);

// When no capitalised street name precedes a street type, only these printed shapes are kept: the
// short Manhattan form ("511 West 171"), a bare Broadway number, and a short all-capitals title
// ("324 EAST 5TH STREET"). Anything longer is a title phrase, not an address.
const SHORT_MANHATTAN = /^\d{1,5}\s+(?:West|East|North|South|W\.?|E\.?)\s+\d{1,3}(?:st|nd|rd|th)?$/i;
const BARE_BROADWAY = /^\d{1,5}(?:-\d{1,5})?\s+Broadway$/i;
const ALL_CAPS_STREET = new RegExp(`^\\d[\\d-]*\\s+(?:[A-Z0-9][A-Z0-9.'’&-]*\\s+){1,3}(?:${STREET_TYPES.toUpperCase()})$`);
const NOT_A_STREET_NAME = /\b(?:RECONSTRUCTION|REPLACEMENT|INSTALLATION|REPAIRS?|UPGRADES?|SEWERS?|MAINS?|TRUNK|APPURTENANCES|CONSTRUCTION|RENOVATION|PROJECTS?|SERVICES?|WORK|BRIDGES?|CONTRACT)\b/;
function fallbackShapeAccepted(evidence) {
  if (SHORT_MANHATTAN.test(evidence) || BARE_BROADWAY.test(evidence)) return true;
  return ALL_CAPS_STREET.test(evidence) && !NOT_A_STREET_NAME.test(evidence);
}

// The engine's `addressSpansIn` finds a street address anywhere in prose, including a few shapes
// this reader must not geocode as written ("8 Bid opening Location - 1 Centre Street", a hyphenated
// Queens house number cut to its tail). Re-anchor each span on the last house number that is followed
// by a street name, keep a hyphenated number whole, and add the locality the sentence prints after it.
function anchoredAddress(segment, span) {
  const evidence = String(span.evidence || span.address || "");
  const at = segment.indexOf(evidence);
  if (at < 0) return null;
  const nearest = [...evidence.matchAll(
    new RegExp(`(?=(\\b[1-9]\\d{0,4}(?:-\\d{1,5})?\\s+(?:[A-Z0-9][A-Za-z0-9.'’/&-]*\\s+){1,5}?(?:${STREET_TYPES})\\b\\.?(?:\\s+(?:North|South|East|West)\\b)?))`, "g"),
  )];
  const picked = nearest.length ? nearest[nearest.length - 1] : null;
  if (!picked && !fallbackShapeAccepted(evidence)) return null;
  let start = at;
  let body = picked ? picked[1] : evidence;
  if (picked) start = at + picked.index;
  const hyphen = segment.slice(0, start).match(/(\d{1,5})-$/);
  if (hyphen && !/^\d{1,5}-/.test(body)) {
    start -= hyphen[0].length;
    body = `${hyphen[0]}${body}`;
  }
  if (!/^\d/.test(body) || /^\d+\s+(?:st|nd|rd|th)\b/i.test(body)) return null;
  let end = start + body.length;
  const direction = segment.slice(end).match(/^\s+(?:North|South|East|West)\b(?!\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd)\b)/);
  if (direction && !/\b(?:North|South|East|West)$/.test(body)) {
    body = `${body}${direction[0]}`;
    end += direction[0].length;
  }
  const tail = segment.slice(end).match(TAIL_RE)?.[0] || "";
  const written = normalizeAddress(`${body}${tail}`);
  return { start, end: end + tail.length, written, body: normalizeAddress(body) };
}

/** Street addresses in one segment, de-duplicated by position. */
export function addressMentionsIn(segment) {
  const seen = new Set();
  const out = [];
  for (const span of addressSpansIn(segment)) {
    const mention = anchoredAddress(segment, span);
    if (!mention) continue;
    const key = `${mention.start}:${mention.written.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mention);
  }
  // A shorter span inside a longer one ("156 South 9th" inside "156 South 9th Street") is the same address.
  return out
    .filter((mention) => !out.some((other) => other !== mention
      && other.start <= mention.start && other.end >= mention.end
      && (other.end - other.start) > (mention.end - mention.start)))
    .sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------------------------------ */
/* What does the sentence say the address is?                                                  */
/* ------------------------------------------------------------------------------------------ */

const VENDOR_CUE = /\b(?:vendor|bidder|contractor|proposer|offeror|supplier|firm|company)(?:'s|’s|s')?\s+(?:business\s+)?(?:address|office|place\s+of\s+business)\b/i;
const MEETING_CUE = /\b(?:pre[\s-]?(?:bid|proposal|solicitation)|conference|meetings?|site\s+(?:visits?|tours?|inspections?|walk)|walk[\s-]?through|walk\s+to\s+the\s+site|will\s+meet|meet\s+(?:at|in)|attend(?:ance|ees)?|hearing|information\s+session|briefing|open\s+house)\b/i;
const BID_DROP_CUE = /\b(?:drop[\s-]?off|submi(?:t|tted|ssions?|ssion)|hand[\s-]?deliver\w*|deliver(?:y|ed)?\s*(?:[/:]|to\b|of\s+(?:bids?|proposals?))|sealed\s+(?:bids?|proposals?)|bids?\s+(?:are|is|will\s+be|must\s+be|shall\s+be|should\s+be)\s+(?:due|received|opened|accepted|submitted|delivered|returned)|bids?\s+due|due\s+(?:at|to)|bid\s+(?:opening|room|results?)|public\s+(?:bid\s+)?opening|opened\s+(?:at|in)|received\s+(?:at|by)|returned?\s+(?:to|at)|mail(?:ed|ing)?|attn|attention|addressed\s+to|sent\s+to|pick[\s-]?up|picked\s+up|obtain(?:ed)?|purchase[d]?\s+(?:the\s+)?(?:bid\s+)?(?:documents?|specifications|plans)|plans?\s+(?:and|&)\s+specifications|bid\s+documents?|solicitation\s+documents?|hard\s+cop(?:y|ies)|chief\s+contracting\s+officer|vendor\s+relations|contracts?\s+office|proposals?\s+(?:are|must|shall))\b/i;
const OFFICE_AGENCY = /\b(?:Department|Division|Office|Bureau|Unit|Agency|Authority)\b/;
const OFFICE_AFTER = /^(?:\s*,\s*[A-Za-z .]{2,25})?\s*,?\s*(?:Room\s+[A-Z0-9][\w-]*|Rm\.?\s*[A-Z0-9][\w-]*|Suite\s+[A-Z0-9][\w-]*|Ste\.?\s+[A-Z0-9][\w-]*|\d{1,2}(?:st|nd|rd|th)\s*(?:Fl(?:oor|\.)?))\b/i;
const WORK_VERBS = /\b(?:seeking|perform|provide|furnish|complete|upgrade|install|renovat\w*|construct\w*|replace\w*|repair\w*|work|project|services?)\b/i;
const HEADQUARTERS_CUE = /\b(?:headquarters?|HQ|main\s+office|central\s+office|offices?)\b[^.;]{0,25}$/i;
const LOCATED_CUE = /\b(?:is|are|was|will\s+be)?\s*(?:[Ll]ocated|[Ss]ituated)\s+(?:(?:in|within)\s+[A-Za-z ,'’.-]{3,50}?\s+)?(?:at|on)\s*(?:the\s+)?(?:[A-Z][\w'’&.-]*[\s,:–-]+){0,6}$/;
const WORK_NOUNS = "work|project|construction|renovations?|replacements?|reconstruction|installation|repairs?|upgrades?|improvements?|demolition|rehabilitation|restoration|abatement|resurfacing|planting|modernization|accessibility|elevators?|roof(?:ing)?";
const WORK_CUE = new RegExp(`\\b(?:${WORK_NOUNS})\\b[^.;]{0,140}?\\b(?:at|on)\\s+(?:the\\s+)?(?:[A-Z][\\w'’&.()-]*[\\s,]+){0,6}$`);
const WORK_HEADLINE = new RegExp(`\\b(?:${WORK_NOUNS})(?:\\s+(?:and|&)\\s+\\w+)?\\s*[,:–-]\\s*(?:[A-Z][\\w'’&./-]*\\s+){0,4}$`, "i");
const LABEL_WORDS = "(?:(?:project|work|site)\\s+)?location(?:\\s+where\\s+(?:the\\s+)?(?:work|services?)\\s+(?:is|are)\\s+to\\s+be\\s+(?:performed|provided))?|place\\s+of\\s+(?:performance|work)|(?:job|project|work)\\s*site|address(?:es)?\\s+of\\s+the\\s+subject\\s+(?:buildings?|propert(?:y|ies)|sites?)(?:\\s+(?:is|are)(?:\\s+as\\s+follows)?)?";
const LOCATION_LABEL = new RegExp(`^(?:[-•o*]\\s*)?(?:\\d\\s?\\.\\s*)?(?:${LABEL_WORDS})\\s*:?\\s*(?:[-–]\\s*)?`, "i");
const LOCATION_HEADING_ONLY = new RegExp(`^(?:[-•o*]\\s*)?(?:\\d\\s?\\.\\s*)?(?:${LABEL_WORDS})\\s*:?\\s*$`, "i");
const TITLE_NOT_SITE = /\b(?:bid\s+(?:opening|results?)\s+(?:place|location)|submit\w*\s+(?:to|at))\b/i;
const SITE_LIST_JOIN = /^\s*(?:,|;|and|&)\s+(?:and\s+)?[A-Z][\w &/'’-]{0,40},?\s*$/;

/**
 * Classify one address mention from its own sentence, the text just before it, a short look at what
 * follows, and, when the address starts its sentence or follows a date or label, the segment before.
 * The first rule that fires wins, and the order is the safety order: anything that says meeting, drop
 * off, obtain or office excludes the address before any work cue is considered.
 *
 * @returns {{ class: string, evidence: string }}
 */
export function classifyAddressMention({ segment, mention, isTitle = false, previousSegments = [], previousMention = null }) {
  const lead = segment.slice(0, mention.start).trim();
  const own = segment.slice(Math.max(0, mention.start - 200), mention.start);
  const after = segment.slice(mention.end, mention.end + 110);
  const shortLead = lead.length < 25
    || /^(?:[-•o*]\s*)?(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\d{1,2}(?::\d\d)?\s*[ap]\.?m|Location\b|Address\b|Place\b|Date\b)/i.test(lead);
  const before = shortLead ? `${previousSegments.slice(-3).join(" ")} ${own}`.slice(-380) : own;

  if (VENDOR_CUE.test(own)) return { class: "unclear", evidence: "vendor_address_cue" };

  if (isTitle) {
    if (TITLE_NOT_SITE.test(segment) || BID_DROP_CUE.test(own.slice(-60))) {
      return { class: "bid_drop", evidence: "title_delivery_cue" };
    }
    return { class: "work_site", evidence: "title" };
  }

  const labelled = LOCATION_LABEL.test(lead) && mention.start < 120;
  const headingAbove = LOCATION_HEADING_ONLY.test(previousSegments[previousSegments.length - 1] || "");
  const lookback = previousSegments.slice(-3).join(" ");

  if (labelled || headingAbove) {
    if (MEETING_CUE.test(lookback) || MEETING_CUE.test(lead.replace(LOCATION_LABEL, ""))) {
      return { class: "meeting", evidence: "location_label_in_meeting_block" };
    }
    return { class: "work_site", evidence: "location_label" };
  }

  if (MEETING_CUE.test(before) || MEETING_CUE.test(after.slice(0, 80))) {
    if (!BID_DROP_CUE.test(before) || MEETING_CUE.test(before.slice(-120))) {
      return { class: "meeting", evidence: "meeting_cue" };
    }
  }
  const nearBefore = before.slice(-140);
  if (BID_DROP_CUE.test(nearBefore) || BID_DROP_CUE.test(after.slice(0, 60)) || /\bto\s+(?:drop|deliver|submit)\b/i.test(after)) {
    return { class: "bid_drop", evidence: "delivery_or_pickup_cue" };
  }
  const agencyAt = before.search(/\b(?:Department|Division|Office|Bureau|Unit|Agency|Authority)\b(?![\s\S]*\b(?:Department|Division|Office|Bureau|Unit|Agency|Authority)\b)/);
  const sinceAgency = agencyAt >= 0 ? before.slice(agencyAt) : "";
  if (
    (OFFICE_AGENCY.test(sinceAgency) && sinceAgency.length <= 110 && !WORK_VERBS.test(sinceAgency))
    || OFFICE_AFTER.test(after)
  ) {
    return { class: "agency_office", evidence: "office_cue" };
  }

  if (HEADQUARTERS_CUE.test(own) && !WORK_CUE.test(own)) {
    return { class: "agency_office", evidence: "headquarters_cue" };
  }
  if (LOCATED_CUE.test(own) || WORK_CUE.test(own) || WORK_HEADLINE.test(own)) {
    return { class: "work_site", evidence: LOCATED_CUE.test(own) ? "located_sentence" : "work_sentence" };
  }
  if (previousMention?.class === "work_site" && SITE_LIST_JOIN.test(segment.slice(previousMention.end, mention.start))) {
    return { class: "work_site", evidence: "work_site_list" };
  }
  return { class: "unclear", evidence: "no_role_cue" };
}

const BROAD_SCOPE_CUE = /\b(?:citywide(?!\s+(?:administ\w+|procurement|personnel))|city[\s-]?wide|throughout\s+(?:the\s+)?(?:new\s+york\s+)?city|all\s+five\s+boroughs|various\s+(?:nyc\s+|city\s+)?(?:locations|sites|addresses|properties|buildings|schools|development)|multiple\s+(?:locations|sites)|at\s+various\b)/i;

/* ------------------------------------------------------------------------------------------ */
/* Contact scrub for quoted sentences                                                          */
/* ------------------------------------------------------------------------------------------ */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

/** The quoted sentence, trimmed to word boundaries around the address and with contact details removed. */
export function quoteFor(segment, mention, headingAbove = null) {
  let text = headingAbove ? `${headingAbove} ${segment}` : segment;
  const offset = headingAbove ? headingAbove.length + 1 : 0;
  if (text.length > QUOTE_MAX) {
    const center = mention.start + offset;
    let from = Math.max(0, Math.min(center - 140, text.length - QUOTE_MAX));
    let to = Math.min(text.length, from + QUOTE_MAX);
    if (from > 0) from = text.indexOf(" ", from) + 1 || from;
    if (to < text.length) to = text.lastIndexOf(" ", to) > from ? text.lastIndexOf(" ", to) : to;
    text = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
  }
  return text.replace(EMAIL_RE, "[email removed]").replace(PHONE_RE, "[phone removed]").trim();
}

/**
 * The published quote. A LOCATION line that puts a facility name and a short abbreviation
 * immediately before the address repeats that name when the title already carries it, so the
 * quote is then the street address alone. The role is still read from the full sentence.
 */
export function publishedQuote(title, mention) {
  const quote = String(mention?.quote || "");
  const address = String(mention?.address || "");
  const at = address ? quote.indexOf(address) : -1;
  if (at < 0) return quote;
  const before = quote.slice(0, at).trim();
  const marked = before.match(/\(([A-Z]{2,6})\)\s*$/);
  if (!marked) return quote;
  const phrase = before.slice(0, marked.index).toLowerCase();
  const titleWords = new Set(String(title || "").toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
  const repeatsTitle = (phrase.match(/\b[a-z]{4,}\b/g) || []).some((word) => titleWords.has(word));
  return repeatsTitle ? address : quote;
}

/* ------------------------------------------------------------------------------------------ */
/* One notice                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Every address mention in a notice row with its class. No geocoding. */
export function scanNoticeAddresses(row = {}) {
  const mentions = [];
  const boroughsOutsideAddresses = new Set();
  let broadScope = false;
  for (const field of NOTICE_TEXT_FIELDS) {
    const segments = splitNoticeSegments(row[field]);
    segments.forEach((segment, index) => {
      if (BROAD_SCOPE_CUE.test(segment)) broadScope = true;
      const found = addressMentionsIn(segment).filter((mention) => streetNamed(mention.body));
      const previous = segments.slice(Math.max(0, index - 3), index);
      if (!found.length) {
        for (const borough of boroughsIn(segment)) boroughsOutsideAddresses.add(borough);
        return;
      }
      let previousMention = null;
      for (const mention of found) {
        const verdict = classifyAddressMention({
          segment,
          mention,
          isTitle: field === "short_title",
          previousSegments: previous,
          previousMention,
        });
        const headingAbove = verdict.evidence === "location_label" && LOCATION_HEADING_ONLY.test(previous[previous.length - 1] || "")
          ? previous[previous.length - 1]
          : null;
        mentions.push({
          field,
          address: mention.written,
          body: mention.body,
          class: verdict.class,
          evidence: verdict.evidence,
          quote: quoteFor(segment, mention, headingAbove),
        });
        previousMention = { class: verdict.class, end: mention.end };
      }
    });
  }
  return { mentions, boroughs: [...boroughsOutsideAddresses].sort(), broadScope };
}

// A house number followed by a street type alone ("9 St" from a search phrase) is not an address.
function streetNamed(body) {
  return /^\d[\d-]*\s+\S+/.test(body) && !/^\d[\d-]*\s+(?:Street|St|Avenue|Ave|Road|Rd|Place|Pl)\b\.?$/i.test(body);
}

const TYPE_ABBREVIATIONS = {
  st: "street", ave: "avenue", av: "avenue", rd: "road", blvd: "boulevard", pl: "place", ln: "lane",
  dr: "drive", pkwy: "parkway", ct: "court", e: "east", w: "west", n: "north", s: "south",
};

function normalizedKey(address) {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((word) => TYPE_ABBREVIATIONS[word] || word)
    .join(" ");
}

/**
 * One site per address. The text sent to the geocoder is the fullest written form of that address
 * anywhere in the notice (a title prints "1 Centre Street", a later line prints "1 Centre Street, New
 * York, NY 10007"): the same words, not an inferred borough.
 */
function distinctSites(workMentions, allMentions) {
  const byKey = new Map();
  for (const mention of workMentions) {
    const key = normalizedKey(mention.body);
    if (byKey.has(key)) continue;
    const forms = allMentions.filter((other) => normalizedKey(other.body) === key).map((other) => other.address);
    const fullest = forms.reduce((best, form) => (form.length > best.length ? form : best), mention.address);
    byKey.set(key, { ...mention, address: fullest });
  }
  return [...byKey.values()];
}

function communityDistrictOf(resolution) {
  const matches = (resolution?.geographies || []).filter((entry) => entry.type === "community_district");
  const distinct = [...new Map(matches.map((entry) => [entry.key, entry])).values()];
  return distinct;
}

const GOODS_DELIVERY_CUE = /\b(?:purchase|purchasing)\b[^.]{0,200}\b(?:deliver(?:y|ed)|installation)\b/i;
const CONSTRUCTION_CUE = /\b(?:renovat\w*|construct\w*|reconstruct\w*|rehabilitat\w*|demolit\w*|moderniz\w*|upgrad\w*|repair\w*|resurfac\w*|abatement)\b/i;
const PROPERTY_OFFER_CUE = /\b(?:leasing\s+opportunit\w*|offered\s+for\s+lease|available\s+for\s+lease|adaptive\s+reuse|long-term\s+lease)\b/i;
const PROPERTY_TITLE_CUE = /\b(?:leasing\s+opportunit\w*|adaptive\s+reuse|industrial\s+business\s+zone|event\s+space|event\s+operator\s+services)\b/i;

/** Resident words for the three typed roles this reader publishes. */
export const OPEN_NOTICE_SITE_LABELS = Object.freeze({
  [CONTRACT_PLACE_ROLES.WORK_SITE]: "Work site",
  [CONTRACT_PLACE_ROLES.DELIVERY_SITE]: "Delivery site",
  [CONTRACT_PLACE_ROLES.FACILITY_SITE]: "Property in this solicitation",
});

/**
 * Typed role for an address the notice already presents as a place.
 * Construction of the place stays work. Goods bought for delivery or installation
 * are delivery. A property offered for lease, reuse or development is the facility.
 *
 * @returns {"work_site"|"delivery_site"|"facility_site"}
 */
export function presentationRole({ title = "", quote = "" } = {}) {
  const text = `${title}\n${quote}`;
  if (PROPERTY_OFFER_CUE.test(text) || (PROPERTY_TITLE_CUE.test(title) && !CONSTRUCTION_CUE.test(text))) {
    return CONTRACT_PLACE_ROLES.FACILITY_SITE;
  }
  if (GOODS_DELIVERY_CUE.test(text) && !CONSTRUCTION_CUE.test(text)) {
    return CONTRACT_PLACE_ROLES.DELIVERY_SITE;
  }
  return CONTRACT_PLACE_ROLES.WORK_SITE;
}

/**
 * Resolve one placed mention through the existing typed-place resolver.
 *
 * @param {object} mention classified `work_site` mention
 * @param {{ requestId: string, geocode: (address: string) => object, layerData: object[], expectedBoundaryVintage?: string|null, placeRole?: string }} ctx
 */
export function resolveWorkSiteMention(mention, { requestId, geocode, layerData, expectedBoundaryVintage = null, placeRole = CONTRACT_PLACE_ROLES.WORK_SITE }) {
  const geocoded = geocode(mention.address);
  if (geocoded?.status === "ambiguous") {
    return { ok: false, state: "ambiguous", reason: geocoded.reason || "ambiguous_address", candidate_count: geocoded.candidate_count ?? null };
  }
  if (geocoded?.status !== "matched" || !Number.isFinite(Number(geocoded.lon)) || !Number.isFinite(Number(geocoded.lat))) {
    return { ok: false, state: "unresolved", reason: geocoded?.reason || "not_covered" };
  }
  const admitted = admitContractPlaceAssertion({
    contract_id: requestId,
    place_role: placeRole,
    input_kind: PLACE_INPUT_KINDS.EXACT_ADDRESS,
    address: mention.address,
    request_id: requestId,
    notice_id: requestId,
    locator: `notice ${requestId} ${mention.field}`,
    source_document_id: `city_record:${requestId}`,
  });
  if (!admitted.ok) return { ok: false, state: "unresolved", reason: admitted.reasons[0] || "not_admitted" };
  const resolution = resolveContractPlaceAssertion(admitted.assertion, {
    layerData,
    geocode: () => ({ lon: Number(geocoded.lon), lat: Number(geocoded.lat) }),
    expectedBoundaryVintage,
  });
  if (resolution.state === RESOLUTION_STATES.AMBIGUOUS) {
    return { ok: false, state: "ambiguous", reason: resolution.reason || "ambiguous_boundary" };
  }
  const districts = communityDistrictOf(resolution);
  if (!districts.length) return { ok: false, state: "unresolved", reason: resolution.reason || "no_community_district" };
  if (districts.length > 1) return { ok: false, state: "ambiguous", reason: "ambiguous_community_district" };
  const [district] = districts;
  return { ok: true, geocoded, district, assertion: admitted.assertion };
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function record(state, reason, asOf) {
  return { state, reason, source: OPEN_NOTICE_WORK_SITE_SOURCE, as_of: asOf };
}

/**
 * Classify one notice. `textRow` is the notice's free-text fields; `ctx` carries the geocoder and layers.
 * @returns {{ coverage: object, sites: object[], scan: object }}
 */
export function workSiteForNotice(notice, textRow, ctx) {
  const { asOf } = ctx;
  if (ctx.unavailableReason || !(textRow && typeof textRow === "object")) {
    const reason = ctx.unavailableReason ? "text_unavailable" : "notice_text_missing";
    return { coverage: record("missing", reason, asOf), sites: [], scan: null };
  }
  const requestId = String(notice?.request_id || textRow.request_id || "");
  const scan = scanNoticeAddresses(textRow);
  const rejected = emptyCounts(ADDRESS_CLASSES.filter((name) => name !== "work_site"));
  const workMentions = [];
  for (const mention of scan.mentions) {
    if (mention.class === "work_site") workMentions.push(mention);
    else rejected[mention.class] += 1;
  }
  const namedSites = distinctSites(workMentions, scan.mentions);
  const scanSummary = {
    addresses_found: scan.mentions.length,
    rejected,
    boroughs_named: scan.boroughs,
    sites_named: namedSites.length,
  };

  const resolved = [];
  const failures = [];
  const title = String(textRow.short_title || "");
  for (const mention of namedSites.slice(0, MAX_SITES_PER_NOTICE)) {
    const placeRole = presentationRole({ title, quote: mention.quote || "" });
    const outcome = resolveWorkSiteMention(mention, { ...ctx, requestId, placeRole });
    if (outcome.ok) resolved.push({ mention, outcome });
    else failures.push({ mention, outcome });
  }

  if (resolved.length) {
    const seen = new Set();
    const sites = [];
    for (const { mention, outcome } of resolved) {
      const key = `${outcome.geocoded.bbl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const role = outcome.assertion.place_role;
      sites.push({
        role,
        label: OPEN_NOTICE_SITE_LABELS[role],
        address: mention.address,
        quote: publishedQuote(title, mention),
        quote_field: mention.field,
        basis: mention.evidence,
        bbl: outcome.geocoded.bbl,
        zip: outcome.geocoded.zip || null,
        borough: outcome.geocoded.borough || null,
        community_district: {
          key: outcome.district.key,
          id: outcome.district.id,
          label: outcome.district.label || null,
          // Numbers above 18 are joint interest areas (parks, airports); they are published as the layer names them.
          area_kind: Number(String(outcome.district.id).slice(1)) <= 18 ? "community_district" : "joint_interest_area",
          boundary_vintage: outcome.district.boundary_vintage || null,
        },
        located_by: "point_containment",
      });
    }
    const unplaced = failures.map(({ mention, outcome }) => ({ address: mention.address, state: outcome.state, reason: outcome.reason }));
    return {
      coverage: record("available", "resolved", asOf),
      sites,
      scan: { ...scanSummary, sites_placed: sites.length },
      unplaced,
    };
  }

  let reason;
  if (failures.some(({ outcome }) => outcome.state === "ambiguous")) reason = "ambiguous";
  else if (failures.length) reason = "address_not_resolved";
  else if (scan.mentions.some((mention) => mention.class === "unclear")) reason = "address_role_unclear";
  else if (scan.broadScope) reason = "broad_scope";
  else if (scan.boroughs.length || scan.mentions.some((mention) => mention.class === "work_site")) reason = "borough_only";
  else if (scan.mentions.length) {
    reason = scan.mentions.every((mention) => mention.class === "meeting") ? "only_meeting_address" : "only_bid_drop_address";
  } else reason = "no_place_named";

  return {
    coverage: record("missing", reason, asOf),
    sites: [],
    scan: { ...scanSummary, sites_placed: 0 },
    unplaced: failures.map(({ mention, outcome }) => ({ address: mention.address, state: outcome.state, reason: outcome.reason })),
  };
}

/**
 * Attach `coverage.work_site` and `work_sites` to each open notice and describe the whole list.
 * A failed text read still publishes every notice, each `missing` with `text_unavailable`.
 *
 * @param {object[]} notices published open-solicitation rows
 * @param {{ textRows?: object[]|null, unavailableReason?: string|null, asOf: string, observedAt?: string|null, geocode?: Function, layerData?: object[], expectedBoundaryVintage?: string|null, sourceUrl?: string, resolverSources?: object }} options
 */
export function attachOpenNoticeWorkSites(notices, options = {}) {
  const {
    textRows = null,
    unavailableReason = null,
    asOf,
    observedAt = null,
    geocode,
    layerData,
    expectedBoundaryVintage = null,
    sourceUrl = null,
    resolverSources = null,
  } = options;
  const unavailable = Boolean(unavailableReason) || !Array.isArray(textRows);
  const byId = new Map((Array.isArray(textRows) ? textRows : []).map((row) => [String(row?.request_id || ""), row]));
  const ctx = {
    asOf,
    geocode,
    layerData,
    expectedBoundaryVintage,
    unavailableReason: unavailable ? (unavailableReason || "text_unavailable") : null,
  };
  const byReason = emptyCounts(WORK_SITE_REASONS);
  const rejectedAddresses = emptyCounts(ADDRESS_CLASSES.filter((name) => name !== "work_site"));
  let sitesPublished = 0;
  let noticesWithManySites = 0;
  const published = (Array.isArray(notices) ? notices : []).map((notice) => {
    const result = workSiteForNotice(notice, byId.get(String(notice?.request_id || "")), ctx);
    byReason[result.coverage.reason] += 1;
    if (result.scan) for (const [name, count] of Object.entries(result.scan.rejected)) rejectedAddresses[name] += count;
    sitesPublished += result.sites.length;
    if (result.sites.length > 1) noticesWithManySites += 1;
    return {
      ...notice,
      coverage: { ...(notice.coverage || {}), work_site: result.coverage },
      work_sites: result.sites,
      ...(result.unplaced?.length ? { work_sites_unplaced: result.unplaced } : {}),
      ...(result.scan ? { work_site_scan: result.scan } : {}),
    };
  });
  const available = published.filter((notice) => notice.coverage.work_site.state === "available").length;
  const coverage = {
    schema: OPEN_NOTICE_WORK_SITE_COVERAGE_SCHEMA,
    state: unavailable ? "unavailable" : "measured",
    unavailable_reason: unavailable ? (unavailableReason || "text_unavailable") : null,
    rule_version: OPEN_NOTICE_WORK_SITE_RULE_VERSION,
    rule: OPEN_NOTICE_WORK_SITE_RULE,
    source: OPEN_NOTICE_WORK_SITE_SOURCE,
    source_url: sourceUrl,
    as_of: asOf,
    observed_at: observedAt,
    open_notices: published.length,
    available,
    missing: published.length - available,
    by_reason: byReason,
    rejected_addresses_by_class: rejectedAddresses,
    sites_published: sitesPublished,
    notices_with_several_sites: noticesWithManySites,
    resolver: resolverSources,
  };
  return { notices: published, coverage };
}
