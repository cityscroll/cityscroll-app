// w12-09 field report (site owner, production): on the Land lens, following the suggestion
// "rezonings in Queens", the interpretation echo read "We understood this as: in Queens" --
// dropping "rezonings" entirely. Root cause: "rezonings" has no field in the filter schema
// (it's lens-implicit -- ZAP's Land tab returns nothing else), so a query that resolves to
// {boro:"Queens", keywords:[]} left NL.land.chips() with only a borough chip to show. Same
// class of gap existed in nlFeed() (shared by Property/Rules/Meetings): each of those tabs is
// also pinned to one City Record section_name with no filter field naming it, so an
// agency-only resolution (e.g. "HPD property sales" -> {agency:"...", keywords:[]}) dropped
// "property sales" from the echo the same way.
//
// Entry-path parity: index.html's suggestion-chip click handler and the Ask box's "Go"
// button/Enter key both call the SAME nlTranslateLens(lens) function (see
// renderNLSamples()/injectNLBoxes() in index.html) -- so once NL.<lens>.chips() states the
// complete interpretation, every entry path that resolves through it inherits the fix by
// construction. This file pins that wiring plus the chip content itself.
//
//   node --test test/nl_echo_completeness.test.mjs   (from the crol-list/ dir)

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
const { t, tSection } = new Function(
  "window",
  i18nSrc + "\nreturn { t: window.t, tSection: window.tSection };"
)(windowStub);

const { NL, SECTIONS, nlTransHTML } = new Function(
  "t", "tSection", "window",
  extractDecl("SECTIONS") +
  extractDecl("LENS_IMPLIED_WORDS") +
  extractFn("stripImpliedKeywords") +
  extractFn("nlFeed") +
  extractDecl("NL") +
  extractFn("nlTransHTML") +
  "return { NL, SECTIONS, nlTransHTML };"
)(t, tSection, windowStub);

// ---- Land: the exact field-report reproduction --------------------------------------------
test("before: NL.land.chips() dropped the lens-implied 'rezonings' part for a borough-only query", () => {
  // The old chips() had no unconditional entry -- a {boro, keywords:[]} filter produced only
  // the borough chip. Pin the shape of the bug via the filter alone (no code under test here),
  // so the "after" assertion below is meaningfully a fix and not a tautology.
  const filter = { boro: "Queens", keywords: [], status: null };
  assert.equal(filter.keywords.length, 0, "\"rezonings\" never lands in keywords -- it's lens-implicit");
});

test("after: NL.land.chips() states both the lens-implied kind and the borough for 'rezonings in Queens'", () => {
  const chips = NL.land.chips({ boro: "Queens", keywords: [], status: null }).filter(Boolean);
  const joined = chips.join(" ");
  assert.match(joined, />rezonings</, "the lens-implied chip renders, unconditional on any extracted field");
  assert.match(joined, /in <b>Queens<\/b>/);
});

test("NL.land.chips(): the lens-implied chip is present even for a bare/empty filter", () => {
  const chips = NL.land.chips({}).filter(Boolean);
  assert.equal(chips.length, 1);
  assert.match(chips[0], />rezonings</);
});

test("NL.land.chips(): keywords and the 'all' status chip still render alongside the lens-implied chip, in plain language", () => {
  const chips = NL.land.chips({ boro: "Brooklyn", keywords: ["waterfront"], status: "all" }).filter(Boolean);
  assert.equal(chips.length, 4);
  assert.match(chips[0], />rezonings</);
  assert.match(chips[1], /in <b>Brooklyn<\/b>/);
  assert.match(chips[2], /about <b>waterfront<\/b>/);
  assert.match(chips[3], />including closed rezonings</, "a full sentence fragment, not filter jargon like 'all · incl. closed'");
});

// w12-09 field report #2 (site owner, production): "rezonings in the Bronx" echoed "We
// understood this as: in Bronxall · incl. closed" -- two bugs at once. (a) chips.join("") in
// nlTransHTML() left zero characters between adjacent <span> chips, so anything reading
// textContent (a screen reader's accessible-name computation for the role="status" line, or a
// plain copy/paste) saw "Bronx" and "all" run together with no boundary. (b) the status="all"
// chip itself was raw, untranslated filter jargon ("all · incl. closed").
test("before: chips.join('') left no boundary between adjacent chips -- 'Bronx' and 'all' ran together", () => {
  const chips = ["<span>Bronx</span>", "<span>all</span>"];
  assert.equal(chips.join(""), "<span>Bronx</span><span>all</span>", "no text node at all between the two spans");
});

test("nlTransHTML: joins chips with a real separator, and the status chip reads as plain language", () => {
  const chips = NL.land.chips({ boro: "Bronx", keywords: [], status: "all" }).filter(Boolean);
  const html = nlTransHTML(chips, "#nlq-land", false);
  assert.match(html, /Bronx<\/b><\/span> <span/, "a real character sits between the boro chip and the next chip");
  assert.doesNotMatch(html, /Bronxall/);
  assert.doesNotMatch(html, /incl\.|·.*closed/i, "no abbreviation/jargon shorthand survives in the rendered echo");
});

// ---- Property/Rules/Meetings: same class of gap, same fix -------------------------------
test("NL.property.chips(): an agency-only resolution ('HPD property sales') still names what the results are", () => {
  const chips = NL.property.chips({ agency: "Department of Housing Preservation and Development", keywords: [] }).filter(Boolean);
  const joined = chips.join(" ");
  assert.match(joined, new RegExp(SECTIONS.property.section), "reuses the exact section_name label already shown elsewhere (tSection)");
  assert.match(joined, /agency <b>Department of Housing Preservation and Development<\/b>/);
});

test("NL.rules.chips()/NL.meetings.chips(): each carries its own section's lens-implied chip, not a copy-pasted one", () => {
  const rulesChips = NL.rules.chips({ agency: null, keywords: [] }).filter(Boolean);
  const meetingsChips = NL.meetings.chips({ agency: null, keywords: [], when: null }).filter(Boolean);
  assert.match(rulesChips[0], new RegExp(SECTIONS.rules.section));
  assert.match(meetingsChips[0], new RegExp(SECTIONS.meetings.section));
  assert.notEqual(rulesChips[0], meetingsChips[0]);
});

// w12-09 field report #3 (site owner, production), Property lens: the suggestion "police
// department property" echoed "We understood this as: agency Police Department" -- dropping
// "property", the lens-implicit type, the exact same class of bug as the Land/Queens case
// above (a different lens, verbatim reproduction pinned per the card's acceptance criteria).
test("before: an agency-only Property resolution ('police department property') dropped 'property' from the echo", () => {
  const filter = { agency: "Police Department", keywords: [] };
  assert.equal(filter.keywords.length, 0, "\"property\" never lands in keywords -- it's lens-implicit, same as Land's \"rezonings\"");
});

test("after: NL.property.chips() states the lens-implied kind for 'police department property', not just the agency", () => {
  const chips = NL.property.chips({ agency: "Police Department", keywords: [] }).filter(Boolean);
  const joined = chips.join(" ");
  assert.match(joined, new RegExp(SECTIONS.property.section), "the lens-implied 'Property Disposition' chip renders even though the query named no property-specific field");
  assert.match(joined, /agency <b>Police Department<\/b>/);
});

// w12-09 field report #4 (site owner, production), Property lens: "environmental protection
// land" echoed "about environmental protection / land" -- "land" is Property's own
// lens-implied word demoted into keyword soup, inconsistent with how the Land/Queens and
// police-department cases drop the lens word entirely. Normalized: the lens-implied chip
// always states the type distinctly, and a lens word is stripped out of "about", never left to
// sit alongside real topic keywords.
test("before: 'land' rode along in the keyword chip as if it were a real topic, next to 'environmental protection'", () => {
  const rawKeywords = ["environmental protection", "land"];
  assert.ok(rawKeywords.includes("land"), "the raw extraction includes Property's own lens word as a keyword");
});

test("after: NL.property.chips() strips the lens word out of 'about' and states the kind distinctly, for 'environmental protection land'", () => {
  const chips = NL.property.chips({ agency: null, keywords: ["environmental protection", "land"] }).filter(Boolean);
  assert.equal(chips.length, 2, "the kind chip + a clean keyword chip -- 'land' does not survive as a third, redundant fragment");
  assert.match(chips[0], new RegExp(SECTIONS.property.section));
  assert.match(chips[1], />about <b>environmental protection<\/b></);
  assert.doesNotMatch(chips[1], /\/ land|land \//, "'land' never rides along in the keyword chip");
});

// w12-08 (a sibling card, landed on main mid-session) moved suggestion-chip text out of a
// hardcoded NL_SAMPLES array and into i18n keys (sugg_<lens>_<idx>), server-validated and
// rotated daily -- same click-through-nlTranslateLens() wiring, just a different text source.
// Pin the field-report strings against their new home instead.
test("sugg_land_*/sugg_property_* i18n keys carry the exact field-report strings verbatim, for both reproduced lenses", () => {
  assert.equal(t("sugg_land_1"), "rezonings in Queens");
  assert.equal(t("sugg_land_3"), "rezonings in the Bronx");
  assert.equal(t("sugg_property_1"), "environmental protection land");
  assert.equal(t("sugg_property_2"), "police department property");
});

// ---- Entry-path parity: chip click and the Ask box converge on one function ---------------
test("suggestion-chip click handler resolves through nlTranslateLens(lens) -- the same function the Ask box's Go/Enter path calls", () => {
  const clickBlock = src.slice(src.indexOf("function renderNLSamples"), src.indexOf("function injectNLBoxes"));
  assert.match(clickBlock, /nlTranslateLens\(lens\)/, "a non-money chip click must resolve through the shared NL pipeline, not call landSearch()/loadSection() etc. directly");
  const goBlock = src.slice(src.indexOf("function injectNLBoxes"), src.indexOf("function injectNLBoxes") + 1500);
  assert.match(goBlock, /addEventListener\("click",\(\)=>nlTranslateLens\(lens\)\)/, "the Ask box's own Go button calls the identical function");
});
