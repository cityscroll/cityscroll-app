// Unit tests for the pure functions inside index.html (both feature rounds).
// Same approach as fallback.test.mjs: pull the real functions out of the source by
// brace-matching so the tests can't drift from what ships.
//
//   node --test           (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");

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
// Extract a top-level `const NAME = …;` statement (single line or balanced to the first `;\n`).
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = [^;]*;`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

// ---------- entity resolution (N1/N7) ----------
const { vendorStem } = new Function(
  extractConst("VENDOR_SUFFIX") + extractFn("cleanText") + extractFn("vendorStem") + "return { vendorStem };"
)();

test("vendorStem: suffix/case/punctuation variants share a stem", () => {
  const stem = vendorStem("Sinergia Inc");
  assert.equal(stem, "SINERGIA");
  assert.equal(vendorStem("Sinergia Incorporated"), stem);
  assert.equal(vendorStem("SINERGIA, INC."), stem);
  assert.equal(vendorStem("sinergia"), stem);
  assert.notEqual(vendorStem("Sinergia Partners LLC"), stem);
});
test("vendorStem: strips chained suffixes, keeps short names intact", () => {
  assert.equal(vendorStem("Acme Co Inc"), "ACME");
  assert.equal(vendorStem("Consolidated Scaffolding, Inc."), "CONSOLIDATED SCAFFOLDING");
  assert.equal(vendorStem("AB"), "AB"); // too short to strip into nothing
});

// ---------- property explorer (round1 #9) ----------
// dollarBadge routes its labels through t() (2026-07-13 i18n hotfix) — evaluate the REAL
// dictionary from i18n.js so the assertions stay pinned to the shipped English strings.
const i18nSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "i18n.js"), "utf8");
const realT = new Function("window", i18nSrc + "\nreturn window.t;")({});

const propEnv = new Function(
  "t",
  extractFn("cleanText") + extractFn("daysLeft") + extractFn("classifyAsset") + extractFn("propStage") + extractFn("dollarBadge")
  + "return { classifyAsset, propStage, dollarBadge };"
)(realT);

test("classifyAsset: distinctive vocabularies route to the right bucket", () => {
  const c = (title, desc="") => propEnv.classifyAsset({ short_title: title, additional_description_1: desc });
  assert.equal(c("Forest Management Project #5205", "134,164 board feet of sawtimber"), "forest");
  assert.equal(c("Upset Price Notice", "32 accessible minifleet medallions"), "medallion");
  assert.equal(c("AUTO AUCTION", "vehicle and heavy machinery auctions"), "vehequip");
  assert.equal(c("Notice", "in the custody of the property clerk"), "seized");
  assert.equal(c("Property Disposition", "sale of City-owned property, Disposition Area"), "realty");
  assert.equal(c("Something unclassifiable", "no keywords at all"), "other");
});
test("propStage: lifecycle derivation", () => {
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();
  const far = new Date(Date.now() + 90 * 86400000).toISOString();
  assert.equal(propEnv.propStage({ event_date: soon }), "soon");
  assert.equal(propEnv.propStage({ event_date: far }), "upcoming");
  assert.equal(propEnv.propStage({ type_of_notice_description: "Public Hearings" }), "proposed");
  assert.equal(propEnv.propStage({ type_of_notice_description: "Sale" }), "past");
});
test("dollarBadge: labeled figures only, never a bare number", () => {
  const b = (t) => propEnv.dollarBadge({ short_title: "", additional_description_1: t });
  assert.equal(b("the minimum upset price for the medallions will be $850,000 per"), "upset price $850,000");
  assert.equal(b("property appraised at a value of $7,070,000 for the parcel"), "appraised $7,070,000");
  assert.equal(b("shall be sold for $1.00 as consideration"), "$1 nominal");
  assert.equal(b("the project costs $5,000,000 in total"), null, "unlabeled $ stays a non-badge");
});

// ---------- deadline chips (round1 #5) ----------
// deadlineTag uses t() (i18n) and _spellNum(); provide stubs so the eval is self-contained.
// eventTag/deadlineTag call tn(base, n) (w8-01 plural helper) for their pluralized chips —
// stub it the same shape as the real one (minus actual CLDR category selection).
const _spellConst = src.match(/^const _SPELL = \[[^\]]*\];/m)[0];
const tagEnv = new Function(
  "function t(k,v){ return k; }\n" +
  "function tn(base,n){ return base + '_' + (n === 1 ? 'one' : 'other'); }\n" +
  _spellConst + "\n" +
  extractFn("_spellNum") + extractFn("daysLeft") + extractFn("deadlineTag") + extractFn("eventTag") +
  "return { deadlineTag, eventTag };"
)();
const inDays = (n) => new Date(Date.now() + n * 86400000 + 3600000).toISOString();

test("deadlineTag: closed / hot / soon / open ramp", () => {
  assert.match(tagEnv.deadlineTag(inDays(-2)), /closed/);
  assert.match(tagEnv.deadlineTag(inDays(2)), /tag hot/);
  assert.match(tagEnv.deadlineTag(inDays(10)), /tag soon/);
  assert.match(tagEnv.deadlineTag(inDays(40)), /tag open/);
  assert.equal(tagEnv.deadlineTag(null), "");
});
test("eventTag: past events get no urgency chip", () => {
  assert.equal(tagEnv.eventTag(inDays(-5)), "");
  assert.match(tagEnv.eventTag(inDays(1)), /tag hot/);
});

// ---------- glance helpers (round1 #6) ----------
const glanceEnv = new Function(
  src.match(/const AGENCY_ABBR = \{[\s\S]*?\};/)[0] + extractFn("agencyWho") + extractFn("ordinal") + "return { agencyWho, ordinal };"
)();
test("agencyWho: appends known acronyms, passes unknowns through", () => {
  assert.equal(glanceEnv.agencyWho("Citywide Administrative Services"), "Citywide Administrative Services (DCAS)");
  assert.equal(glanceEnv.agencyWho("City Planning Commission"), "City Planning Commission");
});
test("ordinal", () => {
  assert.deepEqual([1,2,3,4,11,21].map(glanceEnv.ordinal), ["1st","2nd","3rd","4th","11th","21st"]);
});

// ---------- misc shared helpers ----------
const miscEnv = new Function(
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE")
  + extractFn("usablePin") + extractConst("RENEWAL_SUFFIX_RE") + extractFn("pinBase") + extractFn("money")
  + src.match(/const escXml = [^\n]*;/)[0] + "return { usablePin, pinBase, money, escXml };"
)();
test("usablePin rejects junk pins (exact JUNK_PINS set)", () => {
  assert.ok(miscEnv.usablePin("8502026AB0031"));
  for (const junk of ["NoPINFound", "TBD", "N/A", "000", "x"]) assert.ok(!miscEnv.usablePin(junk), junk);
});
// JUNK_PINS' exact-match set missed common real-world phrasings of the same
// "see the list below" placeholder (measured 37.7% miss rate on a 300-row Award sample) --
// before this fix, each of these rendered a live "PIN {value}" badge, a dead-end Checkbook
// lookup, and a #matter/ link that resolved to nothing. Named after the phrasing categories the
// audit found, not just the literal JUNK_PINS strings already covered above.
test("usablePin rejects placeholder-text variants JUNK_PINS' exact match missed", () => {
  const variants = [
    "See list below", "SEE BELOW FOR PINS", "see attachment for PINs",
    "Line 17 below", "line  17  below",
    "n/a", "N/A", "na",
    "TBD", "Various", "PENDING", "Attached",
  ];
  for (const v of variants) assert.ok(!miscEnv.usablePin(v), v);
});
test("usablePin: word-boundary regex leaves a real alphanumeric PIN containing those letters alone", () => {
  // "SEE" is a substring of this real-shaped PIN but never a standalone word -- must NOT be
  // caught by the looser JUNK_PIN_TEXT_RE pass (that would be a false positive on real PINs).
  assert.ok(miscEnv.usablePin("SEE12345678"));
  assert.ok(miscEnv.usablePin("TBD2026AB0031"));
});
test("usablePin: floors the one confirmed placeholder-default numeric collision (123456)", () => {
  assert.ok(!miscEnv.usablePin("123456"));
});
test("pinBase: strips a renewal suffix (…R001), leaves a base PIN alone", () => {
  // Real pattern from the research: ACS "Housing Navigation and Stabilization Services" renewal.
  assert.equal(miscEnv.pinBase("06823N0030001R001"), "06823N0030001");
  assert.equal(miscEnv.pinBase("06823N0030001"), null);
  assert.equal(miscEnv.pinBase("8502026AB0031"), null);
  assert.equal(miscEnv.pinBase("07PO028001R0X00"), null); // "R0X00" isn't digits-only after R0 -- not a renewal suffix
});
test("money formatting", () => {
  assert.equal(miscEnv.money(10837045), "$10.84M");
  assert.equal(miscEnv.money(1500000000), "$1.50B");
  assert.equal(miscEnv.money(0), null);
});
test("escXml escapes the five", () => {
  assert.equal(miscEnv.escXml(`<&>'"`), "&lt;&amp;&gt;&apos;&quot;");
});

// ---------- workerFetch failover (the City-Planning-share bug, 2026-07-02) ----------
function makeWorkerFetch(fetchImpl) {
  return new Function("fetch",
    'const API = "https://api.example";\nconst API_FALLBACK = "https://fallback.example";\nlet apiBase = API;\n'
    + extractFn("workerFetch")
    + "\nreturn { workerFetch, calls: () => undefined };"
  )(fetchImpl);
}
test("workerFetch: primary works → no fallback", async () => {
  const calls = [];
  const { workerFetch } = makeWorkerFetch(async (url) => { calls.push(url); return { ok: true, url }; });
  const r = await workerFetch("/inv", { method: "POST" });
  assert.equal(r.url, "https://api.example/inv");
  assert.equal(calls.length, 1);
});
test("workerFetch: NXDOMAIN on primary → falls over and REMEMBERS", async () => {
  const calls = [];
  const { workerFetch } = makeWorkerFetch(async (url) => {
    calls.push(url);
    if (url.startsWith("https://api.example")) throw new TypeError("net::ERR_NAME_NOT_RESOLVED");
    return { ok: true, url };
  });
  const r1 = await workerFetch("/inv", { method: "POST" });
  assert.equal(r1.url, "https://fallback.example/inv");
  const r2 = await workerFetch("/nl", { method: "POST" });
  assert.equal(r2.url, "https://fallback.example/nl", "second call goes straight to the remembered base");
  assert.deepEqual(calls, ["https://api.example/inv", "https://fallback.example/inv", "https://fallback.example/nl"]);
});
test("workerFetch: both bases down → rejects (callers show their own error)", async () => {
  const { workerFetch } = makeWorkerFetch(async () => { throw new TypeError("down"); });
  await assert.rejects(() => workerFetch("/inv", {}));
});

// ---------- priorCycleAwards: cross-cycle recurring-bid heuristic (research-spike findings) ----------
// The research measured a naive agency+title match at ~48% precision on real award data — NYC
// commonly makes several SIMULTANEOUS awards from one RFP, which looks like a false "renewal"
// under a bare title match. Requiring the closest two award dates be >=180 days apart measured
// ~92-96% precise on a fresh sample. These fixtures encode both failure modes so a regression
// in either direction (too loose → concurrent siblings leak in; too strict → real renewals drop)
// fails a test, not just a manual re-read.
const priorCycleEnv = new Function(
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractConst("JUNK_PIN_TEXT_RE") + extractFn("usablePin")
  + extractConst("PRIOR_CYCLE_MIN_GAP_DAYS") + extractConst("PRIOR_CYCLE_MAX_MATCHES")
  + extractConst("PRIOR_CYCLE_STOPWORDS") + extractFn("priorCycleTitleWords")
  + extractFn("daysBetween") + extractFn("rankPriorCycleCandidates")
  + "return { rankPriorCycleCandidates, priorCycleTitleWords, daysBetween };"
)();

test("priorCycleAwards: excludes a concurrent multi-vendor award from the same RFP", () => {
  // Real pattern found in the research: DOHMH awarded "Substance Abuse Services" to several
  // different vendors within days of each other — siblings from one solicitation, not a
  // sequential renewal cycle a bidder should be shown as "prior cycle" history.
  const r = { request_id: "R2", agency_name: "Health and Mental Hygiene", pin: "07PO028001R0X00",
    short_title: "Substance Abuse Services", start_date: "2006-09-07" };
  const candidates = [
    { request_id: "R1", agency_name: "Health and Mental Hygiene", pin: "07PO022901R0X00",
      short_title: "Substance Abuse Services", start_date: "2006-08-16", vendor_name: "Faith Mission" },
  ];
  assert.deepEqual(priorCycleEnv.rankPriorCycleCandidates(r, candidates, {}), []);
});

test("priorCycleAwards: keeps a genuine renewal (explicit R001 PIN suffix, same vendor, far apart)", () => {
  // Real pattern found in the research: ACS "Housing Navigation and Stabilization Services",
  // same vendor, PIN suffix "R001" marking the renewal round, ~17 months later.
  const r = { request_id: "R2", agency_name: "Administration for Children's Services",
    pin: "06823N0030001R001", short_title: "Housing Navigation and Stabilization Services",
    start_date: "2026-01-09" };
  const candidates = [
    { request_id: "R1", agency_name: "Administration for Children's Services", pin: "06823N0030001",
      short_title: "Housing Navigation and Stabilization Services", start_date: "2023-08-17",
      vendor_name: "Anthos Home Inc", contract_amount: "15458333.34" },
  ];
  const matches = priorCycleEnv.rankPriorCycleCandidates(r, candidates, {});
  assert.equal(matches.length, 1);
  assert.equal(matches[0].request_id, "R1");
});

test("priorCycleAwards: never re-surfaces this notice's own PIN (that's chainHTML's job)", () => {
  const r = { request_id: "R2", agency_name: "Parks and Recreation", pin: "8571500455",
    short_title: "Pool Paints", start_date: "2018-05-31" };
  const candidates = [
    { request_id: "R1", agency_name: "Parks and Recreation", pin: "8571500455",
      short_title: "Pool Paints", start_date: "2015-09-01", vendor_name: "Aldoray" },
  ];
  assert.deepEqual(priorCycleEnv.rankPriorCycleCandidates(r, candidates, {}), []);
});

test("priorCycleAwards: excludes a different agency even with an identical title", () => {
  const r = { request_id: "R2", agency_name: "Citywide Administrative Services", pin: "8571800149",
    short_title: "Pool Paints", start_date: "2024-07-05" };
  const candidates = [
    { request_id: "R1", agency_name: "Parks and Recreation", pin: "8571200426",
      short_title: "Pool Paints", start_date: "2012-07-09", vendor_name: "National Paint Industries" },
  ];
  assert.deepEqual(priorCycleEnv.rankPriorCycleCandidates(r, candidates, {}), []);
});

test("priorCycleAwards: excludes a later notice (only PRIOR cycles count, not future ones)", () => {
  const r = { request_id: "R1", agency_name: "Citywide Administrative Services", pin: "8571200426",
    short_title: "Pool Paints", start_date: "2012-07-09" };
  const candidates = [
    { request_id: "R2", agency_name: "Citywide Administrative Services", pin: "8571800149",
      short_title: "Pool Paints", start_date: "2024-07-05", vendor_name: "Jack Loconsolo" },
  ];
  assert.deepEqual(priorCycleEnv.rankPriorCycleCandidates(r, candidates, {}), []);
});

test("priorCycleAwards: caps at maxN, most recent first, one row per PIN", () => {
  const r = { request_id: "R0", agency_name: "Citywide Administrative Services", pin: "8572100094",
    short_title: "Guide Rail, Posts and Accessories", start_date: "2021-12-17" };
  const candidates = [
    { request_id: "R1", agency_name: "Citywide Administrative Services", pin: "857200896",
      short_title: "Guide Rail, Posts and Accessories", start_date: "2003-01-10" },
    { request_id: "R2", agency_name: "Citywide Administrative Services", pin: "857400833",
      short_title: "Guide Rail, Posts and Accessories", start_date: "2004-08-24" },
    { request_id: "R3", agency_name: "Citywide Administrative Services", pin: "857500934",
      short_title: "Guide Rail, Posts and Accessories.", start_date: "2006-01-17" },
    { request_id: "R4", agency_name: "Citywide Administrative Services", pin: "8571100454",
      short_title: "GUIDE RAIL, POSTS AND ACCESSORIES", start_date: "2012-02-02" },
  ];
  const matches = priorCycleEnv.rankPriorCycleCandidates(r, candidates, {});
  assert.equal(matches.length, 3); // PRIOR_CYCLE_MAX_MATCHES
  assert.deepEqual(matches.map(m => m.request_id), ["R4", "R3", "R2"]); // most recent first
});

test("priorCycleTitleWords: strips stopwords/punctuation, case-insensitive, deduped", () => {
  const words = priorCycleEnv.priorCycleTitleWords("Renewal for late arrival to homeless families with children");
  assert.ok(!words.includes("for"));
  assert.ok(!words.includes("renewal")); // in the stopword list — too generic on its own to search on
  assert.ok(words.includes("homeless"));
  assert.ok(words.includes("families"));
});

test("daysBetween: absolute day gap, null on unparseable dates", () => {
  assert.equal(priorCycleEnv.daysBetween("2023-01-01", "2023-07-01"), 181);
  assert.equal(priorCycleEnv.daysBetween("not-a-date", "2023-07-01"), null);
});
