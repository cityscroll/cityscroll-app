// Pins worker/src/lib/prior_cycle.mjs — the server-side port of index.html's cross-PIN
// prior-cycle STRICT matcher (rankPriorCycleCandidates) and the looser NEAR-match "maybe" tier
// (rankNearMatchCandidates). This is the dual-implemented twin of the client's copies (same
// convention as lib/lineage.mjs); the fixtures below are the SAME real, live-queried award rows
// the client's own test uses (crol-list/test/near_match_prior_cycles.test.mjs), so a divergence
// between the two ports fails here.
//
//   node --test test/prior_cycle_lib.test.mjs   (from the crol-list/worker/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  priorCycleTitleWords, daysBetween, rankPriorCycleCandidates,
  priorCycleEligibleCount, pinPrefixShared, nearMatchReasons, rankNearMatchCandidates,
  NEAR_MATCH_MAX_MATCHES,
} from "../src/lib/prior_cycle.mjs";

// ---- strict tier (rankPriorCycleCandidates) --------------------------------------------------

test("priorCycleTitleWords: lowercases, strips punctuation, drops stopwords and <=2-char words", () => {
  assert.deepEqual(
    priorCycleTitleWords("Renewal of HVAC Services for the Rikers Island Facility").sort(),
    ["facility", "hvac", "island", "rikers"].sort(),
  );
  assert.deepEqual(priorCycleTitleWords(""), []);
});

test("daysBetween: absolute day gap, null on unparseable", () => {
  assert.equal(daysBetween("2020-01-01", "2020-01-31"), 30);
  assert.equal(daysBetween("2020-01-31", "2020-01-01"), 30); // absolute
  assert.equal(daysBetween("not-a-date", "2020-01-01"), null);
});

test("rankPriorCycleCandidates: keeps a real renewal-suffix prior cycle far apart in time", () => {
  // Real strict-match pair (crol-list/test/unit.test.mjs fixture): ACS "Housing Navigation and
  // Stabilization Services", explicit renewal-suffix PIN, same vendor, ~17 months apart.
  const r = { request_id: "R2", agency_name: "Administration for Children's Services",
    pin: "06823N0030001R001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2026-01-09", type_of_notice_description: "Award" };
  const prior = { request_id: "R1", agency_name: "Administration for Children's Services",
    pin: "06823N0030001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2023-08-17", vendor_name: "Anthos Home Inc", contract_amount: "15458333.34",
    type_of_notice_description: "Award" };
  const strict = rankPriorCycleCandidates(r, [prior], {});
  assert.equal(strict.length, 1);
  assert.equal(strict[0].request_id, "R1");
});

test("rankPriorCycleCandidates: excludes a concurrent-cohort sibling (same RFP, under the gap floor)", () => {
  const r = { request_id: "R2", agency_name: "Parks and Recreation", pin: "8571900001",
    short_title: "Guide Rail Posts Fencing Installation", start_date: "2019-09-01",
    contract_amount: "100000", type_of_notice_description: "Award" };
  const sibling = { request_id: "R1", agency_name: "Parks and Recreation", pin: "8571900002",
    short_title: "Guide Rail Posts Fencing Installation", start_date: "2019-07-15", // 48 days earlier
    contract_amount: "105000", type_of_notice_description: "Award" };
  assert.deepEqual(rankPriorCycleCandidates(r, [sibling], {}), []);
});

test("rankPriorCycleCandidates: excludes the notice's own PIN chain (that's chainHTML's job)", () => {
  const r = { request_id: "R2", agency_name: "Sanitation", pin: "82714B0001001",
    short_title: "Street Sweeping Vehicle Maintenance", start_date: "2024-01-01",
    type_of_notice_description: "Award" };
  const samePin = { request_id: "R1", agency_name: "Sanitation", pin: "82714B0001001",
    short_title: "Street Sweeping Vehicle Maintenance", start_date: "2021-01-01",
    type_of_notice_description: "Award" };
  assert.deepEqual(rankPriorCycleCandidates(r, [samePin], {}), []);
});

test("rankPriorCycleCandidates: below the 0.5 title bar is not a strict match", () => {
  const r = { request_id: "R2", agency_name: "Housing Preservation and Development",
    pin: "80622E0016001", start_date: "2022-03-18",
    short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    type_of_notice_description: "Award" };
  const weak = { request_id: "R1", agency_name: "Housing Preservation and Development",
    pin: "80619E0021001", short_title: "IMMEDIATE EMERGENCY DEMOLITION", start_date: "2019-06-28",
    type_of_notice_description: "Award" }; // 3/7 words = 0.43, below strict bar
  assert.deepEqual(rankPriorCycleCandidates(r, [weak], {}), []);
});

// ---- eligibleCount (priorCycleEligibleCount) — the pre-0.5-bar pool the Phase 1b endpoint -----
// returns so the client can pick 67's no_candidates-vs-low_confidence empty-state message. The
// eligibleCount logic used to live in index.html's priorCycleEligibleCount() (the source of truth
// for 67); Phase 1b moves that source of truth into this lib and the client reads the computed
// count off the endpoint, so these assertions pin the same behavior the client's own test used to.

test("priorCycleEligibleCount: counts self-excluded, strictly-earlier, >=180-day-gap same-agency rows", () => {
  const r = { request_id: "R0", agency_name: "Parks and Recreation", pin: "",
    short_title: "Guide Rail Posts Fencing Installation", start_date: "2019-09-01",
    type_of_notice_description: "Award" };
  const eligible = { request_id: "C1", agency_name: "Parks and Recreation", pin: "8571100001",
    short_title: "Guide Rail Barrier Repair", start_date: "2016-01-01",
    type_of_notice_description: "Award" }; // 3+ years earlier, same agency
  assert.equal(priorCycleEligibleCount(r, [eligible]), 1);
});

test("priorCycleEligibleCount: the documented HPD case — self, a later award, and a same-round sibling all count 0", () => {
  // The strict $q has no date bound and matches the notice's own title, so its rows routinely
  // include the notice itself, later awards, and near-in-time siblings. None are prior-eligible.
  const hpd = {
    request_id: "20220314107", agency_name: "Housing Preservation and Development",
    pin: "80622E0016001", type_of_notice_description: "Award",
    short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
    start_date: "2022-03-18", contract_amount: "550000",
  };
  const rows = [
    hpd, // self
    { request_id: "L1", agency_name: hpd.agency_name, pin: "80624E0001001", short_title: "IMMEDIATE EMERGENCY DEMOLITION", start_date: "2024-01-01" }, // later
    { request_id: "S1", agency_name: hpd.agency_name, pin: "80622E0017001", short_title: "IMMEDIATE EMERGENCY DEMOLITION", start_date: "2022-02-01" }, // 45 days earlier — same-round sibling
  ];
  assert.equal(priorCycleEligibleCount(hpd, rows), 0);
});

test("priorCycleEligibleCount: excludes the notice's own PIN chain (that's chainHTML's job)", () => {
  const r = { request_id: "R2", agency_name: "Sanitation", pin: "82714B0001001",
    short_title: "Street Sweeping Vehicle Maintenance", start_date: "2024-01-01",
    type_of_notice_description: "Award" };
  const samePin = { request_id: "R1", agency_name: "Sanitation", pin: "82714B0001001",
    short_title: "Street Sweeping Vehicle Maintenance", start_date: "2021-01-01",
    type_of_notice_description: "Award" };
  assert.equal(priorCycleEligibleCount(r, [samePin]), 0);
});

// ---- near tier (rankNearMatchCandidates) — same real fixtures as the client's own test --------

const hpdNotice = {
  request_id: "20220314107", agency_name: "Housing Preservation and Development",
  pin: "80622E0016001", type_of_notice_description: "Award",
  short_title: "IMMEDIATE EMERGENCY DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)",
  start_date: "2022-03-18", contract_amount: "550000", vendor_name: "Granite Environmental, LLC",
};
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
  const kinds = near[0].reasons.map((r) => r.kind);
  assert.ok(kinds.includes("amount"), "expected amount corroboration");
  assert.ok(!kinds.includes("pin"), "PIN prefix is too short here to corroborate — should not fire");
});

test("rankNearMatchCandidates: a weak title match with NO corroborating signal is excluded", () => {
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

test("rankNearMatchCandidates: never re-surfaces a confident strict match as a maybe", () => {
  const r = { request_id: "R2", agency_name: "Administration for Children's Services",
    pin: "06823N0030001R001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2026-01-09", type_of_notice_description: "Award" };
  const strictMatch = { request_id: "R1", agency_name: "Administration for Children's Services",
    pin: "06823N0030001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2023-08-17", vendor_name: "Anthos Home Inc", contract_amount: "15458333.34",
    type_of_notice_description: "Award" };
  assert.deepEqual(rankNearMatchCandidates(r, [strictMatch], [strictMatch], {}), []);
});

test("rankNearMatchCandidates: PIN-prefix corroboration surfaces a deeply-shared-PIN weak-title match", () => {
  // Constructed (amounts 10x apart) so ONLY the PIN-prefix path can corroborate.
  const r = { request_id: "R2", agency_name: "Design and Construction", pin: "85021B0073D04",
    short_title: "Reconstruction of Foster Avenue Playground Fencing", start_date: "2021-06-01",
    contract_amount: "1000000", type_of_notice_description: "Award" };
  const c = { request_id: "R1", agency_name: "Design and Construction", pin: "85021B0073D01",
    short_title: "Reconstruction of Foster Street Comfort Station", start_date: "2019-01-01",
    contract_amount: "100000", type_of_notice_description: "Award" };
  const near = rankNearMatchCandidates(r, [c], [], {});
  assert.equal(near.length, 1);
  const kinds = near[0].reasons.map((x) => x.kind);
  assert.ok(kinds.includes("pin"), "expected PIN-prefix corroboration");
  assert.ok(!kinds.includes("amount"), "amounts are 10x apart — should not corroborate");
});

test("rankNearMatchCandidates: caps at NEAR_MATCH_MAX_MATCHES, one row per PIN", () => {
  const r = { request_id: "R0", agency_name: "Citywide Administrative Services", pin: "8572100094",
    short_title: "Guide Rail Posts and Fencing Accessories", start_date: "2021-12-17",
    contract_amount: "100000", type_of_notice_description: "Award" };
  const mk = (id, pin, title, date, amt) => ({ request_id: id, agency_name: "Citywide Administrative Services",
    pin, short_title: title, start_date: date, contract_amount: amt, type_of_notice_description: "Award" });
  const candidates = [
    mk("C1", "8571100001", "Guide Rail Bridge Repair", "2012-01-01", "110000"),
    mk("C2", "8571100002", "Rail Posts Barrier Work", "2013-01-01", "105000"),
    mk("C3", "8571100003", "Posts Fencing Barrier Panel", "2014-01-01", "95000"),
    mk("C4", "8571100004", "Fencing Accessories Barrier Unit", "2015-01-01", "90000"),
  ];
  assert.equal(rankNearMatchCandidates(r, candidates, [], {}).length, NEAR_MATCH_MAX_MATCHES);
});

test("pinPrefixShared: counts shared leading chars after stripping a renewal suffix", () => {
  assert.equal(pinPrefixShared("80619E0021001", "80622E0016001"), 3);
  assert.equal(pinPrefixShared("06823N0030001R001", "06823N0030001"), 13);
  assert.equal(pinPrefixShared("ABC", "XYZ"), 0);
});

test("nearMatchReasons: agency and title always present; PIN/amount conditional", () => {
  const reasons = nearMatchReasons(hpdNotice, hpdTruePriorRound, ["immediate", "emergency", "demolition"]);
  assert.deepEqual(reasons.map((r) => r.kind), ["agency", "title", "amount"]);
});

// ---- dual-implementation cross-check: the port must not diverge from index.html's copies ------

test("ported lib matches index.html's client functions byte-for-behavior on the shared fixtures", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const extractFn = (name) => {
    let start = html.indexOf("async function " + name + "(");
    if (start === -1) start = html.indexOf("function " + name + "(");
    assert.notEqual(start, -1, `function ${name} not found in index.html`);
    let depth = 0, seen = false;
    for (let j = html.indexOf("{", start); j < html.length; j++) {
      if (html[j] === "{") { depth++; seen = true; }
      else if (html[j] === "}" && --depth === 0 && seen) return html.slice(start, j + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  };
  const extractConst = (name) => {
    const m = html.match(new RegExp(`^const ${name} = .*$`, "m"));
    assert.ok(m, `const ${name} not found`);
    return m[0] + "\n";
  };
  const client = new Function(
    html.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") + extractFn("usablePin")
    + html.match(/const RENEWAL_SUFFIX_RE = [^;]*;/)[0] + extractFn("pinBase")
    + extractConst("PRIOR_CYCLE_MIN_GAP_DAYS") + extractConst("PRIOR_CYCLE_MAX_MATCHES")
    + extractConst("PRIOR_CYCLE_STOPWORDS")
    + extractFn("priorCycleTitleWords") + extractFn("daysBetween")
    + extractFn("rankPriorCycleCandidates")
    + extractConst("NEAR_MATCH_MIN_SCORE") + extractConst("NEAR_MATCH_MAX_MATCHES")
    + extractConst("NEAR_MATCH_PIN_PREFIX_MIN_LEN") + extractConst("NEAR_MATCH_AMOUNT_RATIO_MAX")
    + extractFn("pinPrefixShared") + extractFn("nearMatchReasons") + extractFn("rankNearMatchCandidates")
    + "return { rankPriorCycleCandidates, rankNearMatchCandidates };",
  )();

  const strictCases = [
    [hpdNotice, [hpdTruePriorRound]],
    [{ request_id: "R2", agency_name: "ACS", pin: "06823N0030001R001",
      short_title: "Housing Navigation and Stabilization Services", start_date: "2026-01-09",
      type_of_notice_description: "Award" },
      [{ request_id: "R1", agency_name: "ACS", pin: "06823N0030001",
        short_title: "Housing Navigation and Stabilization Services", start_date: "2023-08-17",
        type_of_notice_description: "Award" }]],
  ];
  for (const [r, cands] of strictCases) {
    assert.deepEqual(
      rankPriorCycleCandidates(r, cands, {}),
      client.rankPriorCycleCandidates(r, cands, {}),
      "strict tier port diverged from index.html",
    );
  }
  assert.deepEqual(
    rankNearMatchCandidates(hpdNotice, [hpdTruePriorRound], [], {}),
    client.rankNearMatchCandidates(hpdNotice, [hpdTruePriorRound], [], {}),
    "near tier port diverged from index.html",
  );
});
