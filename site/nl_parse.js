// Pure NL -> filter extraction shared by the Money tab's search box and the Alerts tab's
// "Ask" box: given a plain-English sentence, pull out WHATEVER subset of the real queryable
// fields it can find — keywords, an agency, a notice type, a dollar range, a due-within
// window, a procurement category — together, not just whichever one field a single-payload
// classifier happened to pick. The field list here is not a bespoke invention: it mirrors
// exactly what worker/src/lib/compile.mjs can actually turn into a SODA query for the money
// lens (see LENSES.money in worker/src/lib/filter.mjs, the single source of truth for the
// schema) — so parseNL()'s output shape and the stored subscription filter shape are the
// same object, and adding a field here later needs no migration on either side.
//
// No DOM, no network — safe to load as a plain <script> in the browser (declares globals,
// like i18n.js) and to require() from Node tests.
//
// Category dictionary — topic/trade terms a keyword search matches. Keep entries short
// and non-overlapping (e.g. no bare "housing" alongside "affordable housing", or a
// substring match would fire on both and duplicate the keyword).
var NL_CATEGORY_DICT = [
  "affordable housing", "construction", "renovation", "electrical", "plumbing", "hvac",
  "security", "janitorial", "information technology", "software", "consulting",
  "engineering", "architecture", "demolition", "roofing", "elevator", "transportation",
  "shelter", "homeless", "mental health", "health", "catering", "legal", "staffing",
  "maintenance", "landscaping", "food",
  // Civic/agency categories (schools, sanitation, parks, etc.) — added after "education
  // contracts" mismatched to Environmental Protection/Parks/Youth & Community Development
  // instead, because none of these terms existed in the dictionary at all.
  "education", "schools", "sanitation", "parks", "recreation", "environmental",
  "youth services", "senior services", "childcare", "libraries", "fire safety",
  "emergency management", "correctional", "courts", "waste management", "public safety",
];

// Agency name recognition: informal names/acronyms a person would actually type -> the
// canonical agency_name string as it currently appears in the live City Record dataset
// (dg92-zbpx has ~300 raw variants across years — legacy ALL-CAPS/abbreviated rows and the
// current clean Title Case form; picked the current form since alerts only ever watch NEW,
// future notices). This is necessarily a bounded, best-effort list of commonly-named
// agencies, matched the same way NL_CATEGORY_DICT is — not a general-purpose agency-name
// normalizer. Longer/more specific aliases are listed before shorter ones so "department of
// parks" is tried before the bare "parks" fallback.
var NL_AGENCY_ALIASES = [
  ["Parks and Recreation", ["department of parks and recreation", "parks and recreation", "parks department", "department of parks", "dpr", "parks"]],
  ["Sanitation", ["department of sanitation", "sanitation department", "dsny", "sanitation"]],
  ["Transportation", ["department of transportation", "transportation department", "dot"]],
  ["Education", ["department of education", "education department", "doe", "schools department"]],
  ["Housing Preservation and Development", ["housing preservation and development", "hpd", "housing preservation"]],
  ["Buildings", ["department of buildings", "buildings department", "dob"]],
  ["Environmental Protection", ["department of environmental protection", "environmental protection department", "dep"]],
  ["Police Department", ["police department", "nypd"]],
  ["Fire Department", ["fire department", "fdny"]],
  ["Health and Mental Hygiene", ["health and mental hygiene", "department of health", "dohmh"]],
  ["Administration for Children's Services", ["administration for children's services", "administration for children s services", "children's services", "acs"]],
  ["Citywide Administrative Services", ["citywide administrative services", "dcas"]],
  ["Design and Construction", ["design and construction", "ddc"]],
  ["Small Business Services", ["small business services", "sbs"]],
  ["Correction", ["department of correction", "correction department", "doc"]],
  ["Finance", ["department of finance", "finance department", "dof"]],
  ["Aging", ["department for the aging", "dfta"]],
  ["Human Resources Administration", ["human resources administration", "hra"]],
  ["City Planning", ["department of city planning", "city planning department", "dcp"]],
  ["Probation", ["department of probation", "probation department"]],
  ["Cultural Affairs", ["department of cultural affairs", "cultural affairs", "dcla"]],
  ["Consumer and Worker Protection", ["consumer and worker protection", "dcwp"]],
];

var NOTICE_TYPE_AWARD_RE = /\b(awards?|awarded|winners?)\b/;
var NOTICE_TYPE_SOLICITATION_RE = /\b(rfps?|solicitations?|bids?|proposals?)\b/;

function normalizeNaturalLanguageText(value) {
  return (" " + String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/\bst[.]?(?=\s+[a-z])/g, "saint")
    .replace(/\.(?!\d)/g, " ")
    .replace(/[^a-z0-9.$<>]+/g, " ")
    .replace(/\s+/g, " ").trim() + " ");
}

function containsAliasWords(text, alias) {
  var normalized = normalizeNaturalLanguageText(alias);
  if (text.includes(normalized)) return true;
  var words = normalized.trim().split(/\s+/).filter(word => !/^(?:the|of|and|department)$/.test(word));
  if (!words.length) return false;
  return words.every(word => text.includes(" " + word + " "));
}

function extractAgency(t) {
  for (var i = 0; i < NL_AGENCY_ALIASES.length; i++) {
    var canonical = NL_AGENCY_ALIASES[i][0], aliases = NL_AGENCY_ALIASES[i][1];
    for (var j = 0; j < aliases.length; j++) {
      if (containsAliasWords(t, aliases[j])) return canonical;
    }
  }
  return null;
}

function extractNoticeType(t) {
  if (NOTICE_TYPE_AWARD_RE.test(t)) return "award";
  if (NOTICE_TYPE_SOLICITATION_RE.test(t)) return "solicitation";
  return null;
}

// Conservative, high-precision only — the procurement category_description enum (Goods /
// Goods and Services / Services / Human Services / Construction / Construction Related) is
// about procurement METHOD, not topic, so guessing it from arbitrary phrasing is riskier
// than leaving it null (an over-eager wrong category silently narrows a subscriber's alert).
// Only infer it when the text is unambiguous; the model-backed /nl endpoint (worker/src/
// nl.mjs) handles the harder cases with real semantic judgment via its own enum-constrained
// tool call.
function extractCategory(t, keywords) {
  if (/\bgoods and services\b/.test(t)) return "Goods and Services";
  if (/\bconstruction related\b/.test(t)) return "Construction Related Services";
  if (/\bhuman services\b/.test(t) || /\bclient services\b/.test(t)) return "Human Services/Client Services";
  if (/\bgoods\b/.test(t) && !/\bhuman\b/.test(t)) return "Goods";
  var constructionKeywords = ["construction", "renovation", "electrical", "plumbing", "hvac", "roofing", "elevator", "demolition"];
  if (keywords.some(function(k) { return constructionKeywords.indexOf(k) !== -1; })) return "Construction/Construction Services";
  return null;
}

// Discovery-parity extractors (district / process / deadline / entity / near-me). Shared by
// parseNL (money + alerts) and index.html's deviceParse for every other lens so the on-device
// path and the worker field schema stay aligned without a second NL framework.

function extractClosingWeek(t) {
  // "this week" deadline — the Money tab's closing-week chip, not a multi-month due window.
  if (/\b(closing|due|deadline|ends?)\b.{0,24}\bthis week\b/.test(t)) return true;
  if (/\bthis week\b.{0,24}\b(closing|due|deadline)\b/.test(t)) return true;
  if (/\bcontracts? closing this week\b/.test(t)) return true;
  return false;
}

function extractCouncilDistrict(t) {
  var m = t.match(/\bcouncil(?:\s+district)?\s*(?:#|no\.?|number)?\s*([1-9]|[1-4]\d|5[01])\b/);
  if (m) return m[1];
  m = t.match(/\bdistrict\s+([1-9]|[1-4]\d|5[01])\b/);
  if (m && !/\bcommunity\b/.test(t.slice(Math.max(0, t.indexOf(m[0]) - 14), t.indexOf(m[0])))) {
    return m[1];
  }
  return null;
}

function extractCommunityDistrict(t) {
  var m = t.match(/\b([mxkqr])\s*0*([1-9]|1[0-8])\b/i);
  if (m) {
    var prefix = m[1].toUpperCase();
    var n = String(parseInt(m[2], 10)).padStart(2, "0");
    return prefix + n;
  }
  m = t.match(/\bcommunity(?:\s+board|\s+district)?\s*(?:#|no\.?|number)?\s*([1-9]|1[0-8])\b/);
  if (m) {
    // Bare "community district 4" needs a borough to build M04/K04/… — leave null without boro.
    return null;
  }
  m = t.match(/\bcd\s*([mxkqr])?\s*0*([1-9]|1[0-8])\b/i);
  if (m && m[1]) {
    return m[1].toUpperCase() + String(parseInt(m[2], 10)).padStart(2, "0");
  }
  return null;
}

function communityDistrictWithBoro(t, boro) {
  var direct = extractCommunityDistrict(t);
  if (direct) return direct;
  var m = t.match(/\b(?:community(?:\s+board|\s+district)?|cd)\s*(?:#|no\.?|number)?\s*0*([1-9]|1[0-8])\b/);
  if (!m || !boro) return null;
  var prefixes = {
    Manhattan: "M", Bronx: "X", Brooklyn: "K", Queens: "Q", "Staten Island": "R",
  };
  var prefix = prefixes[boro];
  if (!prefix) return null;
  return prefix + String(parseInt(m[1], 10)).padStart(2, "0");
}

function extractNearMe(t) {
  return /\bnear me\b|\bnear my\b|\bmy (?:area|neighborhood|block|district)\b|\baround me\b/.test(t);
}

function extractMeetingWhen(t) {
  if (/\bthis week\b|\bcoming week\b|\bnext 7 days\b/.test(t)) return "week";
  if (/\bnext (?:30|thirty) days\b|\bthis month\b|\bnext month\b|\bnext 4 weeks\b/.test(t)) return "month";
  if (/\bupcoming\b|\bfuture\b|\bahead\b/.test(t)) return "upcoming";
  if (/\brecent\b|\bpast\b|\balready held\b/.test(t)) return "past";
  return null;
}

function extractRulesProcess(t) {
  if (/\bopen for comment\b|\bpublic comment\b|\bcomment period\b|\bcomment on\b|\bto comment\b/.test(t)) {
    return "public_process";
  }
  if (/\bpublic (?:hearing|process)\b|\bhearing on (?:the )?rules?\b/.test(t)) return "public_process";
  if (/\badopt(?:ed|ion)?\b/.test(t) && !/\badoption (?:forecast|estimate|lag)\b/.test(t)) return "adoption";
  if (/\beffective\b|\btakes? effect\b/.test(t)) return "effective";
  if (/\bpropos(?:al|ed)\b|\bproposed rules?\b/.test(t)) return "proposal";
  return null;
}

function extractPropertyProcess(t) {
  if (/\bauctions?\b|\brfps?\b|\bsales?\b|\bselling\b|\breal estate offerings?\b/.test(t) && !/\bdisposition hearings?\b/.test(t)) {
    return "auction_or_rfp";
  }
  if (/\bhearings?\b|\bdisposition hearings?\b/.test(t)) return "hearing";
  if (/\bawarded\b|\bconvey(?:ance|ed)\b|\bsold\b/.test(t)) return "award_or_conveyance";
  return null;
}

function extractMeetingsProcess(t) {
  if (/\bagenda\b/.test(t)) return "agenda";
  if (/\boutcomes?\b|\bvotes?\b|\broll call\b/.test(t)) return "outcomes";
  if (/\bheld\b|\bpast hearing\b/.test(t)) return "held";
  if (/\bscheduled\b|\bupcoming hearing\b/.test(t)) return "scheduled";
  return null;
}

// Agency forecast / entity-profile intents — surface is #agency/<name>?tab=forecast (or bare
// profile), not a SODA keyword list. Conservative: only when the text clearly names a forecast
// or an agency profile, not every bare agency mention.
function extractEntityRoute(t, agency) {
  var wantsForecast = /\bforecast\b|\bexpir(?:e|ing|ation)\b|\brenewal\b|\bpredicted (?:bid|rfp|expir)/.test(t);
  var wantsProfile = /\bagency profile\b|\bprofile for\b|\bfollow (?:this )?agency\b|\bwho is\b/.test(t);
  if (!agency && !wantsForecast && !wantsProfile) return null;
  if (wantsForecast && agency) {
    return { route: "agency", name: agency, tab: "forecast" };
  }
  if (wantsProfile && agency) {
    return { route: "agency", name: agency, tab: null };
  }
  // "Parks contract forecast" without a separate agency field still needs the agency — recover
  // from aliases if extractAgency already ran.
  if (wantsForecast && agency) return { route: "agency", name: agency, tab: "forecast" };
  return null;
}

function extractStaffingGuide(t) {
  if (/\bopen competitive\b|\bcivil service exams?\b|\bexam guide\b|\bcareer guide\b|\bexams? (?:open|closing|actionable)\b/.test(t)) {
    return true;
  }
  return false;
}

function parseNL(text) {
  var t = normalizeNaturalLanguageText(text);
  var out = {
    keywords: [], agency: null, minAmount: null, maxAmount: null, category: null,
    months: null, noticeType: null, excludeSpecial: false, closingWeek: false,
    route: null, name: null, tab: null,
  };
  var m = t.match(/(?:over|above|more than|at least|>\s*)\s*\$?\s*([\d.,]+)\s*(k|m|thousand|million|mm)?/);
  if (m) out.minAmount = parseMoney(m[1], m[2]);
  m = t.match(/(?:under|below|less than|<\s*)\s*\$?\s*([\d.,]+)\s*(k|m|thousand|million|mm)?/);
  if (m) out.maxAmount = parseMoney(m[1], m[2]);
  m = t.match(/(\d+)\s*month/);
  if (m) out.months = parseInt(m[1]);
  if (!out.months) {
    m = t.match(/(\d+)\s*week/);
    // "this week" is closingWeek, not a rounded month window.
    if (m && !extractClosingWeek(t)) out.months = Math.max(1, Math.round(parseInt(m[1]) / 4));
  }
  if (extractClosingWeek(t)) {
    out.closingWeek = true;
    if (!out.noticeType) out.noticeType = "solicitation";
    // Prefer the Money chip's week window over a fabricated months value.
    out.months = null;
  }
  if (/no special|without special|standard requirement|no .{0,14}requirement/.test(t)) out.excludeSpecial = true;
  NL_CATEGORY_DICT.forEach(function(k) { if (t.includes(" " + k)) out.keywords.push(k); });
  m = t.match(/specializ\w+ in ([a-z &]+?)(?:\.|,| and | who | that |$)/);
  if (m) {
    var kw = m[1].trim();
    if (kw.length > 2 && out.keywords.indexOf(kw) === -1) out.keywords.unshift(kw);
  }
  out.keywords = Array.from(new Set(out.keywords)).slice(0, 4);
  out.agency = extractAgency(t);
  out.noticeType = out.noticeType || extractNoticeType(t);
  out.category = extractCategory(t, out.keywords);
  var entity = extractEntityRoute(t, out.agency);
  if (entity) {
    out.route = entity.route;
    out.name = entity.name;
    out.tab = entity.tab;
  }
  return out;
}

// Distinguishes a literal keyword (safe to send to SODA/aFetch as-is, unchanged behavior)
// from a natural-language query that should route through parseNL()/the worker instead —
// shared by index.html's resolveMoneyNarrow(), the one place the Alerts tab's "rfpkw"
// watch (reached directly via "Build an alert" or prefilled by the 60-second quiz's "Narrow
// by keyword") decides whether typed text is a plain keyword or a full sentence to
// interpret. A single word or a fully quoted phrase is literal; anything else with more
// than one word is treated as a sentence.
function isLiteralKeyword(text) {
  var s = (text || "").trim();
  if (!s) return true;
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return true;
  return !/\s/.test(s);
}

function parseMoney(digits, unit) {
  var n = parseFloat(digits.replace(/,/g, ""));
  var u = unit || "";
  if (/m/.test(u)) n *= 1e6;
  else if (/k|thousand/.test(u)) n *= 1e3;
  return n >= 1000 ? Math.round(n) : null;
}

// Node/tooling shim (same pattern as i18n.js's bottom): only reachable outside a browser.
if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = {
    parseNL: parseNL,
    NL_CATEGORY_DICT: NL_CATEGORY_DICT,
    NL_AGENCY_ALIASES: NL_AGENCY_ALIASES,
    isLiteralKeyword: isLiteralKeyword,
    extractAgency: extractAgency,
    extractClosingWeek: extractClosingWeek,
    extractCouncilDistrict: extractCouncilDistrict,
    extractCommunityDistrict: extractCommunityDistrict,
    communityDistrictWithBoro: communityDistrictWithBoro,
    extractNearMe: extractNearMe,
    extractMeetingWhen: extractMeetingWhen,
    extractRulesProcess: extractRulesProcess,
    extractPropertyProcess: extractPropertyProcess,
    extractMeetingsProcess: extractMeetingsProcess,
    extractEntityRoute: extractEntityRoute,
    extractStaffingGuide: extractStaffingGuide,
  };
}
