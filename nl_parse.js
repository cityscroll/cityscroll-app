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

function extractAgency(t) {
  for (var i = 0; i < NL_AGENCY_ALIASES.length; i++) {
    var canonical = NL_AGENCY_ALIASES[i][0], aliases = NL_AGENCY_ALIASES[i][1];
    for (var j = 0; j < aliases.length; j++) {
      if (t.indexOf(" " + aliases[j] + " ") !== -1) return canonical;
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

function parseNL(text) {
  var t = " " + text.toLowerCase() + " ";
  var out = {
    keywords: [], agency: null, minAmount: null, maxAmount: null, category: null,
    months: null, noticeType: null, excludeSpecial: false,
  };
  var m = t.match(/(?:over|above|more than|at least|>\s*)\s*\$?\s*([\d.,]+)\s*(k|m|thousand|million|mm)?/);
  if (m) out.minAmount = parseMoney(m[1], m[2]);
  m = t.match(/(?:under|below|less than|<\s*)\s*\$?\s*([\d.,]+)\s*(k|m|thousand|million|mm)?/);
  if (m) out.maxAmount = parseMoney(m[1], m[2]);
  m = t.match(/(\d+)\s*month/);
  if (m) out.months = parseInt(m[1]);
  if (!out.months) {
    m = t.match(/(\d+)\s*week/);
    if (m) out.months = Math.max(1, Math.round(parseInt(m[1]) / 4));
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
  out.noticeType = extractNoticeType(t);
  out.category = extractCategory(t, out.keywords);
  return out;
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
  };
}
