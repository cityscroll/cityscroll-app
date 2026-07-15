// Pins chainHTML()'s renewal-linking behavior (crol-fort-pin): a chain entry pulled in by the
// pinBase() renewal-suffix prefix widening carries a DIFFERENT literal PIN than the notice the
// reader opened, so it must render distinguishably from a same-PIN duplicate stage.
//
// Before this fix: a contract renewed once or twice (an "R00N" PIN suffix, 8.8% of Award rows)
// showed up as 2-3 disconnected single-notice pages -- chainHTML() only ever saw a chain of
// length 1 for the renewal notice, and fired the "only this notice is on record so far" note
// even though earlier/later stages existed under the base PIN.
//
//   node --test test/pin_chain.test.mjs   (from the crol-list/ dir)

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
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const { chainHTML, pinBase } = new Function(
  "t", "tn", "window",
  extractConst("RENEWAL_SUFFIX_RE") + extractFn("pinBase") +
  extractFn("cleanText") + extractFn("boxClass") + extractFn("money") + extractFn("fdate") +
  extractConst("REQ_URL") + extractConst("EXT_ATTRS") + extractConst("extSR") +
  extractConst("pivotA") + extractConst("vendorHref") +
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") +
  extractFn("usablePin") +
  extractFn("pastWinnersHTML") +
  extractFn("daysBetween") +
  extractConst("CADENCE_MIN_AWARDS") + extractConst("CADENCE_MIN_GAP_DAYS") + extractConst("CADENCE_MAX_GAP_RATIO") +
  extractConst("CADENCE_YEAR_THRESHOLD_MONTHS") +
  extractFn("isBlanketChain") + extractFn("cadenceEstimate") + extractFn("cadenceMonthYear") +
  extractFn("cadenceApart") + extractFn("cadenceHTML") +
  extractFn("chainHTML") +
  "return { chainHTML, pinBase };"
)(t, tn, windowStub);

// Real pattern from the research: ACS "Housing Navigation and Stabilization Services", same
// vendor, PIN suffix "R001" marking the renewal round.
const baseAward = {
  request_id: "R1", pin: "06823N0030001", agency_name: "Administration for Children's Services",
  type_of_notice_description: "Award", short_title: "Housing Navigation and Stabilization Services",
  start_date: "2023-08-17", vendor_name: "Anthos Home Inc", contract_amount: "15458333.34",
};
const renewalAward = {
  request_id: "R2", pin: "06823N0030001R001", agency_name: "Administration for Children's Services",
  type_of_notice_description: "Award", short_title: "Housing Navigation and Stabilization Services",
  start_date: "2026-01-09", vendor_name: "Anthos Home Inc", contract_amount: "16000000",
};

test("chainHTML: a renewal-linked entry (different literal PIN) gets the renewal badge", () => {
  const html = chainHTML(renewalAward, [baseAward, renewalAward]);
  // baseAward's box: different PIN from the opened notice (renewalAward) -- badged.
  const baseBox = html.slice(0, html.indexOf(renewalAward.request_id));
  assert.match(baseBox, /<span class="tag renewal">Renewal<\/span>/);
});

test("chainHTML: a same-PIN duplicate stage (identical literal PIN) is NOT badged", () => {
  const dup = { ...renewalAward, request_id: "R3", type_of_notice_description: "Intent to Award" };
  const html = chainHTML(renewalAward, [renewalAward, dup]);
  assert.doesNotMatch(html, /class="tag renewal"/);
});

test("chainHTML: full-timeline link uses the opened notice's own (possibly-suffixed) PIN", () => {
  const html = chainHTML(renewalAward, [baseAward, renewalAward]);
  assert.match(html, /#matter\/06823N0030001R001/);
});

test("chainHTML: single-notice chain still fires the unlinked note when the PIN has no suffix", () => {
  const html = chainHTML(baseAward, [baseAward]);
  assert.doesNotMatch(html, /class="tag renewal"/);
  assert.match(html, /on record so far/);
});

test("pinBase round-trips through chainHTML's own renewal fixture", () => {
  assert.equal(pinBase(renewalAward.pin), baseAward.pin);
  assert.equal(pinBase(baseAward.pin), null);
});
