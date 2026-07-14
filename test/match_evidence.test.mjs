// Pins matchEvidence()/digTitleHTML()/digEvidenceHTML() (index.html) -- the on-page digest
// preview's "why did this match" rendering, mirroring worker/src/lib/digest.mjs's matchEvidence()
// (see worker/test/digest.test.mjs and worker/test/digest_match_evidence_render.test.mjs for the
// emailed-digest side of the same fix).
//
// Real observed failure: a keyword search for "education" surfaced "NOS - Equity Index
// Investment Management Products" (an Office of the Comptroller pension-fund notice) in the
// digest preview with nothing visible explaining the match -- the hit was buried in the
// notice's description, which names the Board of Education Retirement System.
//
//   node --test test/match_evidence.test.mjs   (from the crol-list/ dir)

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

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);

const { matchEvidence, digTitleHTML, digEvidenceHTML } = new Function(
  "t", "window",
  extractFn("enTitle") +
  extractFn("locateAnyTerm") +
  extractFn("matchEvidence") +
  extractFn("digTitleHTML") +
  extractFn("digEvidenceHTML") +
  "return { matchEvidence, digTitleHTML, digEvidenceHTML };"
)(t, windowStub);

const compTitle = "NOS - Equity Index Investment Management Products";
const compDescription =
  "The New York City Office of the Comptroller, Bureau of Asset Management, is soliciting " +
  "proposals on behalf of the Boards of Trustees of the New York City Employees' Retirement " +
  "System, Teachers' Retirement System, and the Board of Education Retirement System for " +
  "equity index investment management products.";

test("before: 'education' isn't in the title -- nothing to highlight there", () => {
  assert.equal(compTitle.toLowerCase().includes("education"), false);
});

test("after: matchEvidence locates 'education' in the description, matching worker's field priority", () => {
  const ev = matchEvidence(compTitle, compDescription, ["education"]);
  assert.equal(ev.field, "description");
  assert.match(ev.hit, /^[Ee]ducation$/);
});

test("digTitleHTML: no evidence (amount/name-only watch) renders the plain enTitle-wrapped title", () => {
  const html = digTitleHTML(compTitle, null);
  assert.match(html, /^<span lang="en" dir="ltr">NOS - Equity Index Investment Management Products<\/span>$/);
  assert.doesNotMatch(html, /<mark/);
});

test("digTitleHTML: a title-field match wraps only the hit in <mark>, rest of the title untouched", () => {
  const ev = matchEvidence(compTitle, compDescription, ["equity"]);
  const html = digTitleHTML(compTitle, ev);
  assert.match(html, /<span lang="en" dir="ltr">NOS - <mark>Equity<\/mark> Index Investment Management Products<\/span>/);
});

test("digTitleHTML: empty title still falls back to the untitled string", () => {
  assert.equal(digTitleHTML("", null), t("untitled"));
});

test("digEvidenceHTML: title-field match renders nothing extra -- the highlighted title already shows it", () => {
  const ev = matchEvidence(compTitle, compDescription, ["equity"]);
  assert.equal(digEvidenceHTML(ev), "");
});

test("digEvidenceHTML: description-field match renders a snippet line naming the hit, translated", () => {
  const ev = matchEvidence(compTitle, compDescription, ["education"]);
  const html = digEvidenceHTML(ev);
  assert.match(html, /class="dev"/);
  assert.match(html, /<mark>Education<\/mark>/);
  assert.match(html, /Board of <mark>Education<\/mark> Retirement System/, "real context around the hit, not just the bare word");
});

test("digEvidenceHTML: a term matched via a field the preview doesn't fetch still names the term, not silence", () => {
  const ev = matchEvidence(compTitle, compDescription, ["sanitation"]);
  assert.equal(ev.field, "unknown");
  const html = digEvidenceHTML(ev);
  assert.match(html, /class="dev"/);
  assert.match(html, /<mark>sanitation<\/mark>/);
});

test("digEvidenceHTML: no evidence (no keywords at all) renders nothing", () => {
  assert.equal(digEvidenceHTML(null), "");
});
