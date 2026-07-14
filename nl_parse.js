// Pure NL -> filter extraction shared by the Money tab's search box and the Alerts tab's
// "Ask" box: given a plain-English sentence, pull out topic keywords, a minimum dollar
// amount, and a due-within-N-months window TOGETHER, not just whichever one field a
// single-payload classifier happened to pick. No DOM, no network — safe to load as a
// plain <script> in the browser (declares globals, like i18n.js) and to require() from
// Node tests.
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

function parseNL(text) {
  var t = " " + text.toLowerCase() + " ";
  var out = { keywords: [], minAmount: null, months: null, excludeSpecial: false };
  var m = t.match(/(?:over|above|more than|at least|>\s*)\s*\$?\s*([\d.,]+)\s*(k|m|thousand|million|mm)?/);
  if (m) {
    var n = parseFloat(m[1].replace(/,/g, ""));
    var u = m[2] || "";
    if (/m/.test(u)) n *= 1e6;
    else if (/k|thousand/.test(u)) n *= 1e3;
    if (n >= 1000) out.minAmount = Math.round(n);
  }
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
  return out;
}

// Node/tooling shim (same pattern as i18n.js's bottom): only reachable outside a browser.
if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = { parseNL: parseNL, NL_CATEGORY_DICT: NL_CATEGORY_DICT };
}
