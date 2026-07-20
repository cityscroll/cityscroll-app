// Pins the lineage-discoverability indicator (crol-list/w12-10): a compact "N cycles" badge
// on a Money/Contracts result row, computed from ONE batched SODA lookup per renderList() call
// (not one request per row), so a reader can see which notices have prior award cycles before
// clicking in.
//
// Field evidence (2026-07-15): the site owner, already aware the cadence
// estimate (w12-04) and past-winners strip (w12-05) had just shipped, could not locate a live
// notice exhibiting either feature without being handed fixture PINs directly — both only
// reveal themselves after opening a notice that happens to have a chain. Before this fix: a
// result row gave no hint that its contract had any history at all. After: a row belonging to
// a chain with >=2 Award/Intent-to-Award stages (and not a blanket-code pool) carries a
// count-bearing badge; a chainless row, or one whose only history is a blanket-code
// simultaneous-award pool, carries none — the same honesty gate pastWinnersHTML()/
// cadenceEstimate() already apply on the detail view, so the badge never promises more than
// clicking through will show.
//
// Fixtures are real award rows queried live from the City Record dataset (SODA dg92-zbpx),
// the same three chains test/cadence_estimate.test.mjs and test/past_winners.test.mjs already
// pin, plus their real agency_name field (queried live, not present in those earlier fixtures
// since agency_name wasn't needed for cadence/past-winners math but IS needed here to build
// the batch lookup's $where clause the same way loadChain() scopes its own query):
//   DOC "Inmate Phone System", PIN base 07219P0148001, agency "Correction"
//   DOE "Assessments for Special Education Services", PIN base 04021B0003005, agency "Education"
//   DHS "Homeless Shelter", PIN base 07106R0045CNV, agency "Homeless Services"
//   Sanitation blanket code 82714CC00040, agency "Sanitation" (6 of 21 real same-day rows)
//
//   node --test test/lineage_indicator.test.mjs   (from the crol-list/ dir)

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
  return m[0] + "\n";
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const {
  lineageChainKey, lineageDedupeKey, lineageBatchClauses, computeLineageBadgeCounts,
} = new Function(
  "t", "tn", "window",
  src.match(/const RENEWAL_SUFFIX_RE = [^;]*;/)[0] + extractFn("pinBase") +
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") +
  extractFn("usablePin") +
  extractFn("isBlanketChain") +
  extractConst("LINEAGE_MIN_STAGES") + extractConst("LINEAGE_MAX_STAGES") +
  extractFn("lineageChainKey") + extractFn("lineageDedupeKey") +
  extractFn("lineageBatchClauses") + extractFn("computeLineageBadgeCounts") +
  "return { lineageChainKey, lineageDedupeKey, lineageBatchClauses, computeLineageBadgeCounts };"
)(t, tn, windowStub);

// Real DOC "Inmate Phone System" renewal chain (same 3 rows test/cadence_estimate.test.mjs
// pins), agency_name queried live for this test since the cadence fixture didn't need it.
const inmatePhoneBatch = [
  { pin: "07219P0148001R002", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "07219P0148001R003", agency_name: "Correction", type_of_notice_description: "Award" },
  { pin: "07219P0148001R004", agency_name: "Correction", type_of_notice_description: "Award" },
];
const inmatePhoneListRow = { pin: "07219P0148001R004", agency_name: "Correction" };

// Real DOE 3-cycle chain (test/past_winners.test.mjs's eduChain), agency "Education".
const eduBatch = [
  { pin: "04021B0003005", agency_name: "Education", type_of_notice_description: "Award" },
  { pin: "04021B0003005R001", agency_name: "Education", type_of_notice_description: "Award" },
  { pin: "04021B0003005R002", agency_name: "Education", type_of_notice_description: "Award" },
];
const eduListRow = { pin: "04021B0003005R002", agency_name: "Education" };

// Real DHS 3-stage chain (test/past_winners.test.mjs's dhsChain, vendor-unlisted third stage),
// agency "Homeless Services".
const dhsBatch = [
  { pin: "07106R0045CNVR001", agency_name: "Homeless Services", type_of_notice_description: "Award" },
  { pin: "07106R0045CNVR001", agency_name: "Homeless Services", type_of_notice_description: "Award" },
  { pin: "07106R0045CNVR002", agency_name: "Homeless Services", type_of_notice_description: "Award" },
];
const dhsListRow = { pin: "07106R0045CNVR002", agency_name: "Homeless Services" };

// Real Sanitation blanket-code pool (test/cadence_estimate.test.mjs's blanketChain, 6 of 21
// real same-day rows), agency "Sanitation" — a simultaneous multi-vendor pool, not sequential
// rebid cycles; isBlanketChain()'s length>5-all-Award threshold must suppress the badge here.
const blanketBatch = Array.from({ length: 6 }, () => ({
  pin: "82714CC00040", agency_name: "Sanitation", type_of_notice_description: "Award",
}));
const blanketListRow = { pin: "82714CC00040", agency_name: "Sanitation" };

// A lone Award with no renewal suffix and no sibling stages on record.
const chainlessListRow = { pin: "20260112345", agency_name: "Parks" };
const chainlessBatch = [
  { pin: "20260112345", agency_name: "Parks", type_of_notice_description: "Award" },
];

// Real pinBase()-widening collision found live while manually verifying this feature against
// production data (not a synthetic edge case): PIN "82626R0001001" (NYC Environmental
// Protection) is an ordinary, unrelated single Award — its own digits merely happen to end in
// something RENEWAL_SUFFIX_RE also matches, widening it to base "82626" and prefix-matching
// ~180 unrelated contracts sharing that agency's fiscal-year PIN prefix. isBlanketChain()
// doesn't catch this (the false-widened set mixes Award/Intent-to-Award/Solicitation stages,
// so its "every stage is Award" check is false) — LINEAGE_MAX_STAGES is the honesty backstop
// this feature adds specifically for that gap; a widened chain deep enough to be UNBELIEVABLE
// (well past every genuine chain fixture in this codebase, the longest of which is 6 stages)
// is treated the same as "uncertain", not shown as a giant, misleading badge.
const pinCollisionListRow = { pin: "82626R0001001", agency_name: "Environmental Protection" };
const pinCollisionBatch = Array.from({ length: 20 }, (_, i) => ({
  pin: `82626${i}`, agency_name: "Environmental Protection", type_of_notice_description: i % 3 === 0 ? "Intent to Award" : "Award",
}));

test("computeLineageBadgeCounts: the real DOC Inmate Phone System chain gets a 3-cycle badge", () => {
  const counts = computeLineageBadgeCounts([inmatePhoneListRow], inmatePhoneBatch);
  assert.equal(counts[0], 3);
});

test("computeLineageBadgeCounts: the real DOE 3-cycle chain gets a 3-cycle badge", () => {
  const counts = computeLineageBadgeCounts([eduListRow], eduBatch);
  assert.equal(counts[0], 3);
});

test("computeLineageBadgeCounts: the real DHS chain (vendor-unlisted stage) still gets a 3-cycle badge", () => {
  // Before this fix: nothing on the result row hinted this notice had two prior stages at all
  // (vendor-unlisted or not) — the count is a property of the CHAIN, not of any one stage's
  // completeness, so a missing vendor_name/contract_amount elsewhere must not suppress it.
  const counts = computeLineageBadgeCounts([dhsListRow], dhsBatch);
  assert.equal(counts[0], 3);
});

test("computeLineageBadgeCounts: a blanket-code simultaneous-award pool renders no badge — honest-data convention", () => {
  // Before this fix (and separately, without this test): a naive count would report "6 cycles"
  // for 6 same-day awards to 6 different vendors — not a rebid cadence at all. isBlanketChain()'s
  // existing exclusion (shared with chainHTML()'s own blanket_note and cadenceEstimate()) must
  // suppress the badge the same way it suppresses the cadence/past-winners features.
  const counts = computeLineageBadgeCounts([blanketListRow], blanketBatch);
  assert.equal(counts[0], null);
});

test("computeLineageBadgeCounts: a pinBase()-widening collision past LINEAGE_MAX_STAGES renders no badge", () => {
  // Real live example, not synthetic: PIN 82626R0001001 (Environmental Protection) widens to
  // base "82626" and prefix-matches ~180 unrelated contracts on production data. isBlanketChain()
  // alone does not exclude it (the false-widened set isn't pure-Award); LINEAGE_MAX_STAGES is
  // the backstop that keeps a PIN-prefix collision from rendering as a nonsensical giant badge.
  const counts = computeLineageBadgeCounts([pinCollisionListRow], pinCollisionBatch);
  assert.equal(counts[0], null);
});

test("computeLineageBadgeCounts: a chainless notice (a single Award, no siblings) renders no badge", () => {
  const counts = computeLineageBadgeCounts([chainlessListRow], chainlessBatch);
  assert.equal(counts[0], null);
});

test("computeLineageBadgeCounts: a row with no usable PIN renders no badge regardless of batch data", () => {
  const counts = computeLineageBadgeCounts([{ pin: "TBD", agency_name: "Parks" }], inmatePhoneBatch);
  assert.equal(counts[0], null);
});

test("computeLineageBadgeCounts: two rows sharing the same chain both get the same count, computed once", () => {
  const rows = [inmatePhoneListRow, { pin: "07219P0148001R003", agency_name: "Correction" }];
  const counts = computeLineageBadgeCounts(rows, inmatePhoneBatch);
  assert.deepEqual(counts, [3, 3]);
});

test("computeLineageBadgeCounts: rows for two different real chains resolve independently in one batch call", () => {
  // Exercises the actual shape loadLineageBadges() uses: ALL visible rows' chain keys folded
  // into one $where clause, then bucketed back apart by (agency, widened-PIN-prefix) — not one
  // request per row.
  const rows = [inmatePhoneListRow, eduListRow, blanketListRow, chainlessListRow];
  const batch = [...inmatePhoneBatch, ...eduBatch, ...blanketBatch, ...chainlessBatch];
  const counts = computeLineageBadgeCounts(rows, batch);
  assert.deepEqual(counts, [3, 3, null, null]);
});

test("lineageChainKey: widens a renewal-suffixed PIN to its base, same as pinBase()/loadChain()", () => {
  const k = lineageChainKey(inmatePhoneListRow);
  assert.equal(k.base, "07219P0148001");
  assert.equal(k.agency_name, "Correction");
});

test("lineageChainKey: a bare PIN with no renewal suffix carries no base (exact-match only)", () => {
  const k = lineageChainKey(chainlessListRow);
  assert.equal(k.base, null);
});

test("lineageBatchClauses: builds one OR'd, quote-escaped clause per chain key", () => {
  const keys = [
    lineageChainKey(inmatePhoneListRow),
    lineageChainKey({ pin: "20260112345", agency_name: "Parks & Rec" }),
  ];
  const clauses = lineageBatchClauses(keys);
  assert.equal(clauses[0], "(pin LIKE '07219P0148001%' AND agency_name='Correction')");
  assert.equal(clauses[1], "(pin='20260112345' AND agency_name='Parks & Rec')");
});

test("lineageDedupeKey: two rows of the same widened chain collapse to the same key", () => {
  const a = lineageDedupeKey(lineageChainKey(inmatePhoneListRow));
  const b = lineageDedupeKey(lineageChainKey({ pin: "07219P0148001R003", agency_name: "Correction" }));
  assert.equal(a, b);
});
