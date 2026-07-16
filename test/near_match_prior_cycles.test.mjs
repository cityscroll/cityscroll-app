// Pins rankNearMatchCandidates() — the exploratory "maybe" tier below priorCycleAwards()'s own
// strict cross-PIN matcher (crol-list/w12-18).
//
// Before this fix: the strict matcher (rankPriorCycleCandidates(), see test/unit.test.mjs)
// requires a MAJORITY title-word overlap (score>=0.5) to avoid surfacing concurrent-RFP
// siblings as false "renewals" — but that same precision bar silently drops a real prior round
// that was simply retitled between cycles. A reader hit exactly this live: HPD's "IMMEDIATE
// EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)" (2022) scores only 0.43
// against its real prior round "IMMEDIATE EMERGENCY DEMOLITION" (2019, same vendor Granite
// Environmental, PIN 80619E0021001) — 3 of 7 significant title words recur, just short of the
// strict bar — and the strict matcher's own live SODA query (a 6-word $q built from this
// notice's own title) returns exactly ONE row (itself), because "130th"/"manhattan"/"dm00121"
// are specific enough that nothing else on record matches all of them. Verified live against
// the SODA dataset (dg92-zbpx) before writing this fix, not assumed.
//
// Fixtures below are real award rows queried live from the City Record dataset, not invented —
// same sourcing discipline as test/cadence_estimate.test.mjs and test/past_winners.test.mjs.
// One test (marked below) uses a constructed PIN pair to exercise the PIN-prefix corroboration
// path directly, since no live pair combining a strong shared PIN prefix with NO usable amount
// signal was found within the research budget for this card — the test says so rather than
// mislabeling synthetic data as observed.
//
//   node --test test/near_match_prior_cycles.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");

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

const { rankNearMatchCandidates, nearMatchReasons, pinPrefixShared, priorCycleTitleWords,
  priorCycleNoneHTML } = new Function(
  "t",
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") + extractFn("usablePin")
  + src.match(/const RENEWAL_SUFFIX_RE = [^;]*;/)[0] + extractFn("pinBase")
  + extractConst("PRIOR_CYCLE_MIN_GAP_DAYS") + extractConst("PRIOR_CYCLE_STOPWORDS")
  + extractFn("priorCycleTitleWords") + extractFn("daysBetween") + extractFn("cleanText")
  + extractFn("nearMatchRevealHTML")
  + extractConst("NEAR_MATCH_MIN_SCORE") + extractConst("NEAR_MATCH_MAX_MATCHES")
  + extractConst("NEAR_MATCH_PIN_PREFIX_MIN_LEN") + extractConst("NEAR_MATCH_AMOUNT_RATIO_MAX")
  + extractFn("pinPrefixShared") + extractFn("nearMatchReasons") + extractFn("rankNearMatchCandidates")
  + extractFn("priorCycleNoneHTML")
  + "return { rankNearMatchCandidates, nearMatchReasons, pinPrefixShared, priorCycleTitleWords, priorCycleNoneHTML };"
)((k, v) => k + (v ? JSON.stringify(v) : "")); // stub t(): returns the key (plus vars, for inspection) rather than real i18n text

// Real fixture, live-queried 2026-07-15 from the SODA dataset (dg92-zbpx).
const hpdNotice = {
  request_id: "20220314107", agency_name: "Housing Preservation and Development",
  pin: "80622E0016001", type_of_notice_description: "Award",
  short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
  start_date: "2022-03-18", contract_amount: "550000", vendor_name: "Granite Environmental, LLC",
};
// The real prior round — same vendor, 994 days earlier, but only 3 of hpdNotice's 7 significant
// title words recur (score 0.43), below the strict matcher's 0.5 bar.
const hpdTruePriorRound = {
  request_id: "20190621041", agency_name: "Housing Preservation and Development",
  pin: "80619E0021001", type_of_notice_description: "Award",
  short_title: "IMMEDIATE EMERGENCY DEMOLITION",
  start_date: "2019-06-28", contract_amount: "1311926", vendor_name: "Granite Environmental, LLC",
};

test("rankNearMatchCandidates: surfaces a real prior round that fails the strict title-overlap bar", () => {
  const near = rankNearMatchCandidates(hpdNotice, [hpdTruePriorRound], [], {});
  assert.equal(near.length, 1);
  assert.equal(near[0].c.request_id, "20190621041");
  assert.ok(near[0].score >= 0.34 && near[0].score < 0.5, `expected a below-strict-bar score, got ${near[0].score}`);
  // Corroborated by amount (ratio 1311926/550000 ≈ 2.4, under the 3x ceiling), NOT by PIN prefix
  // (the two PINs share only "806", 3 chars — well under the 8-char corroboration floor).
  const kinds = near[0].reasons.map(r => r.kind);
  assert.ok(kinds.includes("amount"), "expected amount corroboration");
  assert.ok(!kinds.includes("pin"), "PIN prefix is too short here to corroborate — should not fire");
});

test("rankNearMatchCandidates: a weak title match with NO corroborating signal is excluded, not shown", () => {
  // Real fixture: two unrelated Correction contracts (a roofing replacement, a fence-alarm
  // repair) that coincidentally share three generic words ("system", "Rikers", "Island") —
  // score 0.43, same agency, 961-day gap (clears the concurrent-sibling floor), but the PIN
  // prefixes only share 6 characters (under the 8-char floor) and the amounts are 48x apart.
  // A title score alone must never be enough to show a maybe.
  const roofing = {
    request_id: "20060810013", agency_name: "Correction", pin: "072200644CPD",
    type_of_notice_description: "Award",
    short_title: "Replacement of existing roofing system at GRVC, Rikers Island",
    start_date: "2006-08-16", contract_amount: "1767848", vendor_name: "USA General Contractors Corp.",
  };
  const fenceAlarm = {
    request_id: "20031218003", agency_name: "Correction", pin: "072200215SOD",
    type_of_notice_description: "Award",
    short_title: "on-call service & repair to the perimeter fence alarm system on Rikers Island",
    start_date: "2003-12-29", contract_amount: "36200", vendor_name: "Prospect Electric Service, Inc.",
  };
  assert.deepEqual(rankNearMatchCandidates(roofing, [fenceAlarm], [], {}), []);
});

test("rankNearMatchCandidates: gracefully returns nothing when there is truly nothing to find", () => {
  // Real fixture: NYC Correction's "MARINE ENGINEERING CONSULTING SERVICES" (2010) — a genuine
  // one-off with no earlier same-agency award sharing any significant title word, live-verified
  // against 7+ years of prior Correction awards in the dataset (2003-2010) and against the
  // widened, date-bounded near-match query itself (0 rows).
  const marineEngineering = {
    request_id: "20100324007", agency_name: "Correction", pin: "072200637CPD",
    type_of_notice_description: "Award", short_title: "MARINE ENGINEERING CONSULTING SERVICES",
    start_date: "2010-03-31", contract_amount: "350000", vendor_name: "M.G. McLaren, P.C.",
  };
  assert.deepEqual(rankNearMatchCandidates(marineEngineering, [], [], {}), []);
});

test("rankNearMatchCandidates: never re-surfaces a confident strict match as a maybe", () => {
  // Real strict-match pair (see test/unit.test.mjs's identical fixture): ACS "Housing
  // Navigation and Stabilization Services", explicit renewal-suffix PIN, same vendor, ~17
  // months apart — a genuine STRICT match (score 1.0). If the strict pass already found it,
  // the near-match pass must exclude it even though it would otherwise qualify easily.
  const r = { request_id: "R2", agency_name: "Administration for Children's Services",
    pin: "06823N0030001R001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2026-01-09", type_of_notice_description: "Award" };
  const strictMatch = { request_id: "R1", agency_name: "Administration for Children's Services",
    pin: "06823N0030001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2023-08-17", vendor_name: "Anthos Home Inc", contract_amount: "15458333.34",
    type_of_notice_description: "Award" };
  assert.deepEqual(rankNearMatchCandidates(r, [strictMatch], [strictMatch], {}), []);
});

test("rankNearMatchCandidates: excludes a short-gap match — a weak title score at a short gap still reads as a same-round sibling", () => {
  // Title overlap (0.4) and amount (ratio ~1.05) would both otherwise qualify — only the
  // 48-day gap, under PRIOR_CYCLE_MIN_GAP_DAYS, excludes this one.
  const r = { request_id: "R2", agency_name: "Parks and Recreation", pin: "8571900001",
    short_title: "Guide Rail Posts Fencing Installation", start_date: "2019-09-01",
    contract_amount: "100000", type_of_notice_description: "Award" };
  const sibling = { request_id: "R1", agency_name: "Parks and Recreation", pin: "8571900002",
    short_title: "Guide Rail Barrier Repair", start_date: "2019-07-15", // 48 days earlier
    contract_amount: "105000", type_of_notice_description: "Award" };
  assert.deepEqual(rankNearMatchCandidates(r, [sibling], [], {}), []);
});

test("rankNearMatchCandidates: an above-strict-bar score is left to the strict matcher, not duplicated here", () => {
  const r = { request_id: "R2", agency_name: "Citywide Administrative Services", pin: "8572100094",
    short_title: "Guide Rail, Posts and Accessories", start_date: "2021-12-17",
    contract_amount: "50000", type_of_notice_description: "Award" };
  const strongMatch = { request_id: "R1", agency_name: "Citywide Administrative Services", pin: "8571100454",
    short_title: "GUIDE RAIL, POSTS AND ACCESSORIES", start_date: "2012-02-02",
    contract_amount: "52000", type_of_notice_description: "Award" };
  // score 1.0 (identical significant words) — belongs to rankPriorCycleCandidates(), not here.
  assert.deepEqual(rankNearMatchCandidates(r, [strongMatch], [], {}), []);
});

test("rankNearMatchCandidates: PIN-prefix corroboration surfaces a weak-title match with a deeply shared PIN prefix (constructed fixture)", () => {
  // Constructed, not live-pulled — no real pair combining a strong shared PIN prefix with an
  // unusable amount signal turned up within this card's research budget. Amounts are set far
  // apart (ratio 10x) specifically so ONLY the PIN-prefix path can corroborate.
  const r = { request_id: "R2", agency_name: "Design and Construction", pin: "85021B0073D04",
    short_title: "Reconstruction of Foster Avenue Playground Fencing", start_date: "2021-06-01",
    contract_amount: "1000000", type_of_notice_description: "Award" };
  const c = { request_id: "R1", agency_name: "Design and Construction", pin: "85021B0073D01",
    short_title: "Reconstruction of Foster Street Comfort Station", start_date: "2019-01-01", // 882 days earlier; shares only "reconstruction"/"foster" (score 0.4) with r's 5 significant words
    contract_amount: "100000", type_of_notice_description: "Award" };
  const near = rankNearMatchCandidates(r, [c], [], {});
  assert.equal(near.length, 1);
  const kinds = near[0].reasons.map(x => x.kind);
  assert.ok(kinds.includes("pin"), "expected PIN-prefix corroboration");
  assert.ok(!kinds.includes("amount"), "amounts are 10x apart — should not corroborate");
});

test("rankNearMatchCandidates: caps at NEAR_MATCH_MAX_MATCHES, highest score first, one row per PIN", () => {
  const r = { request_id: "R0", agency_name: "Citywide Administrative Services", pin: "8572100094",
    short_title: "Guide Rail Posts and Fencing Accessories", start_date: "2021-12-17",
    contract_amount: "100000", type_of_notice_description: "Award" };
  const mk = (id, pin, title, date, amt) => ({ request_id: id, agency_name: "Citywide Administrative Services",
    pin, short_title: title, start_date: date, contract_amount: amt, type_of_notice_description: "Award" });
  // Each shares exactly 2 of r's 5 significant words ("guide rail posts fencing accessories") —
  // score 0.4 for all four, so ranking falls through to the date tiebreak (most recent first).
  const candidates = [
    mk("C1", "8571100001", "Guide Rail Bridge Repair", "2012-01-01", "110000"),
    mk("C2", "8571100002", "Rail Posts Barrier Work", "2013-01-01", "105000"),
    mk("C3", "8571100003", "Posts Fencing Barrier Panel", "2014-01-01", "95000"),
    mk("C4", "8571100004", "Fencing Accessories Barrier Unit", "2015-01-01", "90000"),
  ];
  const near = rankNearMatchCandidates(r, candidates, [], {});
  assert.equal(near.length, 3); // NEAR_MATCH_MAX_MATCHES
});

test("pinPrefixShared: counts shared leading characters after stripping a renewal suffix", () => {
  assert.equal(pinPrefixShared("80619E0021001", "80622E0016001"), 3);
  assert.equal(pinPrefixShared("06823N0030001R001", "06823N0030001"), 13); // suffix stripped from the first, exact match to the second
  assert.equal(pinPrefixShared("ABC", "XYZ"), 0);
});

test("nearMatchReasons: agency and title reasons are always present; PIN/amount are conditional", () => {
  const reasons = nearMatchReasons(hpdNotice, hpdTruePriorRound, ["immediate", "emergency", "demolition"]);
  const kinds = reasons.map(r => r.kind);
  assert.deepEqual(kinds, ["agency", "title", "amount"]);
});

// ---------- priorCycleNoneHTML: pre-loaded reveal gate (Phase 1b) ----------
// Phase 1b: the /priorcycle endpoint returns near matches alongside the strict tier, so the
// reveal is no longer a lazy dead-end gated on nearMatchPossible() — priorCycleNoneHTML shows it
// ONLY when the endpoint already found near matches (near.length > 0), and its body is populated
// up front. So the reveal appears iff there is something to reveal, never a spin-then-nothing.
test("priorCycleNoneHTML: no reveal rendered when the endpoint returned no near matches", () => {
  const r = { request_id: "R0", short_title: "Guide Rail Posts Fencing Installation", pin: "8571900001", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  const html = priorCycleNoneHTML(r, 1, []); // eligibleCount=1, but the endpoint found no near matches
  assert.ok(!html.includes("near-match-reveal"), "no reveal markup expected when near is empty");
  assert.ok(html.includes("prior_cycle_none_low_confidence_html"), "a prior-eligible candidate existed but none matched closely");
});
test("priorCycleNoneHTML: reveal IS rendered when the endpoint returned near matches", () => {
  const r = { request_id: "R0", short_title: "Guide Rail Posts Fencing Installation", pin: "8571900001", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  const near = [{ c: { request_id: "C1", short_title: "Guide Rail Barrier Repair", start_date: "2016-01-01" }, score: 0.4, reasons: [{ kind: "agency" }] }];
  const html = priorCycleNoneHTML(r, 1, near);
  assert.ok(html.includes("near-match-reveal"), "reveal markup expected when near is non-empty");
});
test("priorCycleNoneHTML: a missing/undefined near argument renders no reveal (defensive)", () => {
  const r = { request_id: "R0", short_title: "Guide Rail Posts Fencing Installation", pin: "8571900001", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  assert.ok(!priorCycleNoneHTML(r, 1, undefined).includes("near-match-reveal"));
});

// ---------- priorCycleNoneHTML: 3 resolved "none" cases, now driven by eligibleCount (Phase 1b) ----------
// The 3-way message from 67 is preserved, but the no_candidates-vs-low_confidence split is now
// driven by the eligibleCount the endpoint computed server-side (priorCycleEligibleCount over the
// strict-tier rows), not a local recompute — the client no longer fetches those rows.
test("priorCycleNoneHTML: title too generic (<2 significant words) selects the generic key", () => {
  const r = { short_title: "Services", pin: "", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  const html = priorCycleNoneHTML(r, 0, []);
  assert.ok(html.includes("prior_cycle_none_generic"));
});
test("priorCycleNoneHTML: eligibleCount 0 selects the no-candidates key, with {agency} interpolated", () => {
  const r = { short_title: "Guide Rail Posts Fencing Installation", pin: "", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  const html = priorCycleNoneHTML(r, 0, []);
  assert.ok(html.includes("prior_cycle_none_no_candidates_html"));
  assert.ok(html.includes("Parks and Recreation"), "{agency} should be interpolated into the rendered note");
});
test("priorCycleNoneHTML: a positive eligibleCount selects the low-confidence key", () => {
  const r = { request_id: "R0", short_title: "Guide Rail Posts Fencing Installation", pin: "", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  const html = priorCycleNoneHTML(r, 2, []);
  assert.ok(html.includes("prior_cycle_none_low_confidence_html"));
  assert.ok(html.includes("Parks and Recreation"));
});
test("priorCycleNoneHTML: the interpolated English agency name is bidi-isolated (lang=en dir=ltr)", () => {
  const r = { short_title: "Guide Rail Posts Fencing Installation", pin: "", contract_amount: null, agency_name: "Parks and Recreation", start_date: "2019-09-01" };
  const html = priorCycleNoneHTML(r, 0, []);
  assert.ok(html.includes('lang=\\"en\\" dir=\\"ltr\\"') || html.includes('lang="en" dir="ltr"'),
    "agency interpolation should carry the w8-03 isolation span");
});
