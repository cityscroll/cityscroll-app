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
const propEnv = new Function(
  extractFn("cleanText") + extractFn("daysLeft") + extractFn("classifyAsset") + extractFn("propStage") + extractFn("dollarBadge")
  + "return { classifyAsset, propStage, dollarBadge };"
)();

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
const _spellConst = src.match(/^const _SPELL = \[[^\]]*\];/m)[0];
const tagEnv = new Function(
  "function t(k,v){ return k; }\n" +
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
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] + extractFn("usablePin") + extractFn("money")
  + src.match(/const escXml = [^\n]*;/)[0] + "return { usablePin, money, escXml };"
)();
test("usablePin rejects junk pins", () => {
  assert.ok(miscEnv.usablePin("8502026AB0031"));
  for (const junk of ["NoPINFound", "TBD", "N/A", "000", "x"]) assert.ok(!miscEnv.usablePin(junk), junk);
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
