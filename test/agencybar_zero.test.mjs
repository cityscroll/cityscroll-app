// SODA's count(1) aggregate returns the STRING "0" (not the number 0) when an agency has no
// matching awards. A bare `stats.n` truthiness check treats "0" as present, so the notice-detail
// and agency-profile aggregate blocks rendered a dash-and-zero scoreboard ("— total awarded / 0
// contract awards published") for an agency that simply doesn't publish awards. Both call sites
// now go through a shared numeric guard and fall back to an honest sentence instead.
//
//   node --test           (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
const i18nSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "i18n.js"), "utf8");

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
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = [^;]*;`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);
const fmtNumber = new Function("window", i18nSrc + "\nreturn window.fmtNumber;")(windowStub);

const { awardCoverage, awardSourceFor } = await import("../external_awards.js");

const env = new Function(
  "t", "fmtNumber", "window", "awardCoverage", "awardSourceFor", "EXT_ATTRS", "extSR",
  extractFn("money") +
  extractConst("agencyHref") +
  extractConst("pivotA") +
  extractFn("hasAgencyAwards") +
  extractConst("CHECKBOOK_NYCHA_AGENCY_ID") +
  extractFn("aboSourceLink") +
  extractFn("checkbookNychaLink") +
  extractFn("checkbookNychaContractsLink") +
  extractFn("agencyAwardsNote") +
  extractFn("noticeAgencyBar") +
  extractFn("agencyProfileBar") +
  "return { hasAgencyAwards, agencyAwardsNote, noticeAgencyBar, agencyProfileBar };"
)(t, fmtNumber, windowStub, awardCoverage, awardSourceFor,
  'target="_blank" rel="noopener noreferrer"', () => '<span class="sr-only"> (opens in new tab)</span>');

test("hasAgencyAwards: SODA's string \"0\" is not truthy for award count", () => {
  assert.equal(env.hasAgencyAwards({ n: "0", total: null }), false);
  assert.equal(env.hasAgencyAwards({ n: 0 }), false);
  assert.equal(env.hasAgencyAwards(null), false);
  assert.equal(env.hasAgencyAwards(undefined), false);
  assert.equal(env.hasAgencyAwards({ n: "3", total: "150000" }), true);
  assert.equal(env.hasAgencyAwards({ n: 3 }), true);
});

test("noticeAgencyBar: a covered agency's zero stats names its source, not a dash-and-zero scoreboard — and the source name is a working scoped link, not plain text", () => {
  const html = env.noticeAgencyBar({ n: "0", total: null }, "Housing Authority");
  assert.doesNotMatch(html, /class="big">—/);
  assert.doesNotMatch(html, /class="big">0</);
  assert.match(html, /files its contract awards with/, "NYCHA is a covered exact-key agency");
  // Before: {source} was plain text ("Checkbook NYC" with no href) — a
  // statement naming the source with no way to go look. Now it's a link to NYCHA's own
  // Checkbook contracts view (no PIN in scope here, so the agency-wide fallback).
  assert.match(html, /<a href="https:\/\/www\.checkbooknyc\.com\/nycha_contracts\/datasource\/checkbook_nycha\/agency\/162"[^>]*>Checkbook NYC/);
});

test("noticeAgencyBar: an unknown agency's zero stats keeps the soft hedge", () => {
  // An agency the registry doesn't classify falls back to the pre-registry honest hedge.
  const html = env.noticeAgencyBar({ n: "0", total: null }, "Some Unlisted Agency");
  assert.doesNotMatch(html, /class="big">0</);
  assert.match(html, /No contract awards from this agency appear in the City Record/);
});

test("noticeAgencyBar: real stats render the scoreboard", () => {
  const html = env.noticeAgencyBar({ n: "12", total: "4500000" }, "Sanitation");
  assert.match(html, /class="agencybar"/);
  assert.match(html, />12</);
  assert.doesNotMatch(html, /No contract awards/);
});

test("agencyProfileBar: a verified-absent agency states the absence but keeps the open-RFPs stat", () => {
  const html = env.agencyProfileBar(null, 3, "Tax Commission");
  assert.doesNotMatch(html, /class="big">—/);
  assert.doesNotMatch(html, /class="big">0</);
  assert.match(html, /not published in any open dataset/);
  assert.match(html, />3</, "open RFPs count still renders");
});

test("agencyProfileBar: real stats render the full three-stat scoreboard", () => {
  const html = env.agencyProfileBar({ n: "40", total: "9000000" }, 2);
  assert.doesNotMatch(html, /No contract awards/);
  assert.match(html, />40</);
  assert.match(html, />2</);
});
