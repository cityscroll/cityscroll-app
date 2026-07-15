// Pins the extension of matchEvidence()/digTitleHTML()/digEvidenceHTML() -- the Alerts-page ask
// preview's "why did this match" rendering (see test/match_evidence.test.mjs) -- into every other
// lens result list: Money/Contracts (moneyRowHTML), Land (landRowHTML), Property/Rules/Meetings
// (feedCardHTML), and Staffing (roleRowHTML, personRowHTML), all in index.html.
//
// Real observed failure: request_id 20260709010, a DYCD "COMPASS Center Base CD - Queens 13
// Middle School" award, surfaces for a real "childcare" search (the SODA $q text search) with
// nothing explaining the match in a lens list -- it "did not look education focused" even though
// the notice is squarely about an afterschool/childcare program in NYC public schools. The
// notice's own additional_description_1 column is blank; the explanatory text lives entirely in
// other_info_1, a column the app never fetched before this fix -- so even the already-working
// Alerts ask preview would have shown this notice as "matched via a field this preview doesn't
// fetch" instead of quoting the real text. Fixture data pulled 2026-07-15 from the live City
// Record dataset (dg92-zbpx) via
//   curl 'https://data.cityofnewyork.us/resource/dg92-zbpx.json?request_id=20260709010'
// and confirmed live against the exact Money-tab Award query (type_of_notice_description='Award'
// AND contract_amount >= 1000 AND contract_amount < 5000000000, $q=childcare) that this notice is
// a real, current result -- not a hypothetical.
//
//   node --test test/lens_match_evidence.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}
// extractDecl: a `const NAME = ...;` declaration, single- or multi-line, via bracket-depth
// tracking rather than a semicolon regex -- SECTIONS/ASSET_BUCKETS span multiple lines, which a
// single-line `^const NAME = .*$` match (see forecast_render.test.mjs's extractConst) can't reach.
function extractDecl(name) {
  const m = src.match(new RegExp(`(?:^|\\n)const ${name}\\s*=`));
  assert.ok(m, `const ${name} not found`);
  const start = m.index + m[0].indexOf("const");
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn, fmtNumber } = new Function(
  "window",
  i18nSrc + "\nreturn { t: window.t, tn: window.tn, fmtNumber: window.fmtNumber };"
)(windowStub);

const {
  matchEvidence, matchText, digTitleHTML, digEvidenceHTML,
  moneyRowHTML, landRowHTML, feedCardHTML, roleRowHTML, personRowHTML,
} = new Function(
  "t", "tn", "fmtNumber", "window",
  extractDecl("JUNK_PINS") +
  extractDecl("JUNK_PIN_TEXT_RE") +
  extractFn("usablePin") +
  extractFn("cleanText") +
  extractFn("enTitle") +
  extractFn("money") +
  extractFn("fdate") +
  extractFn("fdt") +
  extractFn("daysLeft") +
  extractDecl("_SPELL") +
  extractFn("_spellNum") +
  extractFn("deadlineTag") +
  extractFn("eventTag") +
  extractFn("locateAnyTerm") +
  extractFn("matchEvidence") +
  extractFn("matchText") +
  extractFn("digTitleHTML") +
  extractFn("digEvidenceHTML") +
  extractFn("moneyRowHTML") +
  extractDecl("mihOn") +
  extractFn("landRowHTML") +
  extractDecl("SECTIONS") +
  extractFn("goodAddr") +
  extractDecl("REQ_URL") +
  extractDecl("EXT_ATTRS") +
  extractDecl("extSR") +
  extractDecl("pivotA") +
  extractDecl("agencyHref") +
  extractDecl("ASSET_BUCKETS") +
  extractDecl("ASSET_LABEL") +
  extractFn("feedCardHTML") +
  extractFn("roleRowHTML") +
  extractFn("personRowHTML") +
  "return { matchEvidence, matchText, digTitleHTML, digEvidenceHTML, moneyRowHTML, landRowHTML, feedCardHTML, roleRowHTML, personRowHTML };"
)(t, tn, fmtNumber, windowStub);

// Real fixture: request_id 20260709010 (see file header for provenance). additional_description_1
// is genuinely blank on this row -- other_info_1 carries all the real text.
const compassNotice = {
  request_id: "20260709010",
  agency_name: "Youth and Community Development",
  type_of_notice_description: "Award",
  category_description: "Human Services/Client Services",
  short_title: "COMPASS Center Base CD - Queens 13 Middle School",
  contract_amount: "1188000",
  start_date: "2026-07-15T00:00:00.000",
  due_date: null,
  pin: "26026P0004094",
  additional_description_1: null,
  other_info_1:
    "DYCD has determined that Competitive Sealed Bidding is neither practicable nor advantageous " +
    "to the City because this procurement necessitates the exercise of judgment in evaluating " +
    "competing proposals and requires a balancing of price, quality, and programmatic factors to " +
    "achieve the best outcomes. DYCD is seeking pre-qualified Health and Human Services (HHS) " +
    "providers to operate COMPASS programs. These programs are located in New York City Public " +
    "School (NYCPS) sites and charter schools housed within NYCPS buildings and serve elementary " +
    "and middle school students across all five boroughs. COMPASS programs are a critical part of " +
    "the City's effort to support working families by providing free, high-quality afterschool " +
    "and summer childcare services. They offer a wide range of enrichment activities that help " +
    "students in Kindergarten through Grade 8 develop academically, socially, and emotionally, " +
    "both in and out of the classroom.",
};

test("before: additional_description_1 alone has nothing to match 'childcare' against", () => {
  assert.equal(compassNotice.additional_description_1, null);
  assert.doesNotMatch(compassNotice.short_title.toLowerCase(), /childcare/);
});

test("matchText: concatenates additional_description_1 and other_info_1, tolerating a blank first field", () => {
  const text = matchText(compassNotice);
  assert.match(text, /high-quality afterschool and summer childcare services/);
});

test("before: matching against additional_description_1 only (the old fetch) falls back to the unnamed 'unknown' field", () => {
  const ev = matchEvidence(compassNotice.short_title, compassNotice.additional_description_1, ["childcare"]);
  assert.equal(ev.field, "unknown");
});

test("after: moneyRowHTML surfaces the real school/childcare text for a 'childcare' search, not silence", () => {
  const html = moneyRowHTML(compassNotice, 0, ["childcare"]);
  assert.match(html, /COMPASS Center Base CD - Queens 13 Middle School/, "title still renders in full");
  assert.match(html, /class="dev"/, "a why-matched line is present");
  assert.match(html, /<mark>childcare<\/mark>/);
  assert.match(html, /high-quality afterschool and summer <mark>childcare<\/mark> services/, "real surrounding context, not just the bare word");
});

test("moneyRowHTML: plain browsing (no #kw typed) renders exactly as it did before this existed", () => {
  const html = moneyRowHTML(compassNotice, 0, []);
  assert.doesNotMatch(html, /<mark/);
  assert.doesNotMatch(html, /class="dev"/);
});

test("moneyRowHTML: a title-field match highlights inline, no separate evidence line", () => {
  const html = moneyRowHTML(compassNotice, 0, ["Middle School"]);
  assert.match(html, /<mark>Middle School<\/mark>/);
  assert.doesNotMatch(html, /class="dev"/);
});

test("moneyRowHTML: an untitled row still falls back to untitled_notice, unaffected by evidence", () => {
  const html = moneyRowHTML({ ...compassNotice, short_title: "" }, 0, ["childcare"]);
  assert.match(html, new RegExp(t("untitled_notice")));
});

// ---- Land -----------------------------------------------------------------------------------
const rezoning = {
  project_id: "P2026X001",
  project_name: "Allen Street Mall Rezoning",
  project_brief: "A proposed rezoning to allow a new elementary school annex on the site, expanding classroom capacity for the district.",
  borough: "Manhattan",
  public_status: "Certified",
};

test("landRowHTML: a description-field match (not in the title) shows the evidence line", () => {
  const html = landRowHTML(rezoning, 0, ["classroom"]);
  assert.match(html, /Allen Street Mall Rezoning/);
  assert.match(html, /class="dev"/);
  assert.match(html, /<mark>classroom<\/mark>/);
});

test("landRowHTML: a resolved geocode block lookup passes no text-match terms (kwIsTextMatch=false upstream)", () => {
  const html = landRowHTML(rezoning, 0, []);
  assert.doesNotMatch(html, /<mark/);
});

// ---- Property/Rules/Meetings ------------------------------------------------------------------
const rulesNotice = {
  request_id: "20260710099",
  agency_name: "Buildings",
  type_of_notice_description: "Adopted Rule",
  short_title: "Facade Inspection Safety Program rule amendment",
  street_address_1: "not listed",
  additional_description_1: "This rule amends filing deadlines for the periodic facade inspection safety program covering exterior walls of buildings over six stories.",
  other_info_1: null,
};

test("feedCardHTML: a rules feed card highlights a description-field match with the standard evidence line", () => {
  const html = feedCardHTML("rules", rulesNotice, ["exterior walls"]);
  assert.match(html, /Facade Inspection Safety Program rule amendment/, "title renders unmarked -- the term isn't in the title");
  assert.match(html, /class="dev"/);
  assert.match(html, /<mark>exterior walls<\/mark>/);
});

test("feedCardHTML: plain browsing (no keyword) renders with no match markup", () => {
  const html = feedCardHTML("rules", rulesNotice, []);
  assert.doesNotMatch(html, /<mark/);
  assert.doesNotMatch(html, /class="dev"/);
});

// ---- Staffing ---------------------------------------------------------------------------------
test("roleRowHTML: the LIKE query guarantees a title-field hit -- kw highlights inline in the role title", () => {
  const html = roleRowHTML({ title_description: "SCHOOL SAFETY AGENT", n: "12", mn: "40000", mx: "55000", avg: "47000" }, 0, ["SCHOOL"], false);
  assert.match(html, /<mark>SCHOOL<\/mark> SAFETY AGENT/i);
});

test("personRowHTML: evidence is located in the underlying action text, not the person's own name", () => {
  const person = {
    name: "SMITH, JANE",
    agency: "Youth and Community Development",
    actions: [
      { text: "SMITH, JANE APPOINTED afterschool program coordinator overseeing childcare enrichment activities" },
    ],
  };
  const html = personRowHTML(person, 0, ["childcare"]);
  assert.match(html, />SMITH, JANE</, "person's name still renders plainly (not the match field)");
  assert.match(html, /class="dev"/);
  assert.match(html, /<mark>childcare<\/mark>/);
});

test("personRowHTML: prefers a non-'unknown' hit over an earlier action that doesn't literally contain the term", () => {
  const person = {
    name: "DOE, JOHN",
    agency: "Health and Mental Hygiene",
    actions: [
      { text: "DOE, JOHN INCREASE salary adjustment effective July" }, // no literal hit -> "unknown"
      { text: "DOE, JOHN APPOINTED childcare inspector for licensed daycare facilities" }, // real hit
    ],
  };
  const html = personRowHTML(person, 0, ["childcare"]);
  assert.match(html, /<mark>childcare<\/mark>/);
});
