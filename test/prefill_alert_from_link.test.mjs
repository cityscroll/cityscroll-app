import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Saved-search health fix path + context-carry entry:
// #alerts?lens=<lens>&filter=<json>&freq=<daily|weekly>&notice=<id>
// prefillAlertFromLink() is what applyHash() calls to turn that link into a pre-filled
// builder (and optional real digItemHTML seed for the email-template preview).
//
//   node --test test/prefill_alert_from_link.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";

const src = SITE_SOURCE;

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in site source`);
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

// Fakes: prefillAlertFromLink touches DOM via $(), NL/aWatchChange/aPreview/
// refreshQuizDisplay, plus context-carry seed helpers.
function makeFixture(){
  const fields = {
    "#afreq": { selectedIndex: 0 },
    "#awatch": { value: "" },
    "#aparam": { value: "" },
    "#aagency": { value: "" },
    "#adest": { value: "", focus() {} },
  };
  const $ = (sel) => fields[sel];
  const calls = { aWatchChange: 0, aPreview: 0, refreshQuizDisplay: 0, nlApplyArg: null, seed: 0 };
  const aWatchChange = () => { calls.aWatchChange++; };
  const aPreview = async () => { calls.aPreview++; };
  const refreshQuizDisplay = () => { calls.refreshQuizDisplay++; };
  const paintAlertContextLead = () => {};
  const applyNoticeWatchSeed = async () => { calls.seed++; };
  const NL = { alerts: { apply: (f) => { calls.nlApplyArg = f; } } };
  let noticeWatchSeed = null;
  let meetingWatchExtra = {};
  let propertyWatchExtra = {};
  let awardWatchTarget = null;
  const SECTION_WATCH_LABEL_SRC = extractConst("SECTION_WATCH_LABEL");
  const SECTION_WATCH_LABEL = new Function(SECTION_WATCH_LABEL_SRC + "\nreturn SECTION_WATCH_LABEL;")();
  const prefillAlertFromLink = new Function(
    "$", "NL", "aWatchChange", "aPreview", "refreshQuizDisplay", "SECTION_WATCH_LABEL",
    "paintAlertContextLead", "applyNoticeWatchSeed",
    "noticeWatchSeed", "meetingWatchExtra", "propertyWatchExtra", "awardWatchTarget",
    extractFn("prefillAlertFromLink") + "\nreturn prefillAlertFromLink;"
  )(
    $, NL, aWatchChange, aPreview, refreshQuizDisplay, SECTION_WATCH_LABEL,
    paintAlertContextLead, applyNoticeWatchSeed,
    noticeWatchSeed, meetingWatchExtra, propertyWatchExtra, awardWatchTarget,
  );
  return { prefillAlertFromLink, fields, calls };
}

test("money lens: routes through NL.alerts.apply() (the SAME path the Ask box uses), so the existing echo applies", async () => {
  const { prefillAlertFromLink, calls } = makeFixture();
  const filter = { keywords: ["asbestos"], minAmount: 200000, months: 3 };
  await prefillAlertFromLink("money", filter, "weekly");
  assert.deepEqual(calls.nlApplyArg, filter, "the exact stored filter is handed to NL.alerts.apply(), unmodified");
  assert.equal(calls.refreshQuizDisplay, 1);
});

test("entity lens (vendor): #awatch=entityvendor, #aparam=the vendor name, preview runs", async () => {
  const { prefillAlertFromLink, fields, calls } = makeFixture();
  await prefillAlertFromLink("entity", { kind: "vendor", name: "Acme Snow & Ice LLC" });
  assert.equal(fields["#awatch"].value, "entityvendor");
  assert.equal(fields["#aparam"].value, "Acme Snow & Ice LLC");
  assert.equal(calls.aWatchChange, 1);
  assert.equal(calls.aPreview, 1);
});

test("entity lens (agency): #awatch=entityagency", async () => {
  const { prefillAlertFromLink, fields } = makeFixture();
  await prefillAlertFromLink("entity", { kind: "agency", name: "NYCHA" });
  assert.equal(fields["#awatch"].value, "entityagency");
  assert.equal(fields["#aparam"].value, "NYCHA");
});

test("land lens: #awatch=rezone, #aparam joins the stored keywords", async () => {
  const { prefillAlertFromLink, fields, calls } = makeFixture();
  await prefillAlertFromLink("land", { keywords: ["rivington"], status: "all" });
  assert.equal(fields["#awatch"].value, "rezone");
  assert.equal(fields["#aparam"].value, "rivington");
  assert.equal(calls.aPreview, 1);
});

test("a section lens (property/rules/meetings): #awatch=the lens itself, #aparam=keywords, #aagency=agency", async () => {
  const { prefillAlertFromLink, fields } = makeFixture();
  await prefillAlertFromLink("property", { keywords: ["environmental", "protection"], agency: "DEP" });
  assert.equal(fields["#awatch"].value, "property");
  assert.equal(fields["#aparam"].value, "environmental protection");
  assert.equal(fields["#aagency"].value, "DEP");
});

test("freq=weekly/daily sets #afreq's selectedIndex; an absent/garbage freq leaves it untouched", async () => {
  const a = makeFixture(); await a.prefillAlertFromLink("land", {}, "weekly");
  assert.equal(a.fields["#afreq"].selectedIndex, 1);
  const b = makeFixture(); await b.prefillAlertFromLink("land", {}, "daily");
  assert.equal(b.fields["#afreq"].selectedIndex, 0);
  const c = makeFixture(); await c.prefillAlertFromLink("land", {}, null);
  assert.equal(c.fields["#afreq"].selectedIndex, 0, "untouched from its default");
});

test("a null/undefined filter never throws — treated as an empty filter", async () => {
  const { prefillAlertFromLink, fields } = makeFixture();
  await assert.doesNotReject(() => prefillAlertFromLink("entity", null, "daily"));
  assert.equal(fields["#aparam"].value, "");
});

test("an unrecognized lens leaves the builder untouched rather than guessing (fail-soft)", async () => {
  const { prefillAlertFromLink, fields, calls } = makeFixture();
  await prefillAlertFromLink("not-a-real-lens", { keywords: ["x"] }, "daily");
  assert.equal(fields["#awatch"].value, "", "no watch type is guessed for an unknown lens");
  assert.equal(calls.aWatchChange, 0);
  assert.equal(calls.aPreview, 0);
  assert.equal(calls.refreshQuizDisplay, 1, "still repaints the quiz view so it never shows a stale mismatch");
});

test("notice id option triggers seed load for real digItemHTML preview", async () => {
  const { prefillAlertFromLink, calls } = makeFixture();
  await prefillAlertFromLink("meetings", { agency: "Transportation" }, "daily", { noticeId: "20260716009" });
  // Seed may run twice when aWatchChange clears the seed on type switch, then re-seeds.
  assert.ok(calls.seed >= 1, "applyNoticeWatchSeed runs for notice= id");
  assert.equal(calls.aPreview, 1);
});
