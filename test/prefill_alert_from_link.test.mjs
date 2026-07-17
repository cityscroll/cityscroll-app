// Saved-search health fix path: a quiet watch's digest links back to the alerts page as
// #alerts?lens=<lens>&filter=<json>&freq=<daily|weekly> (see worker/src/lib/search_health.mjs's
// alertsFixUrl()). prefillAlertFromLink() (index.html) is what applyHash() calls to turn that
// link into a pre-filled builder — the exact {lens,filter} shape already stored on a
// subscription, so visiting the link shows the same watch the digest was talking about.
//
//   node --test test/prefill_alert_from_link.test.mjs   (from the crol-list/ dir)

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
  return m[0];
}

// Fakes injected the same way quiz_narrow_resolve.test.mjs / forecast_render.test.mjs do —
// prefillAlertFromLink only touches DOM through $(), plus NL/aWatchChange/aPreview/
// refreshQuizDisplay as globals.
function makeFixture(){
  const fields = {
    "#afreq": { selectedIndex: 0 },
    "#awatch": { value: "" },
    "#aparam": { value: "" },
    "#aagency": { value: "" },
  };
  const $ = (sel) => fields[sel];
  const calls = { aWatchChange: 0, aPreview: 0, refreshQuizDisplay: 0, nlApplyArg: null };
  const aWatchChange = () => { calls.aWatchChange++; };
  const aPreview = () => { calls.aPreview++; };
  const refreshQuizDisplay = () => { calls.refreshQuizDisplay++; };
  const NL = { alerts: { apply: (f) => { calls.nlApplyArg = f; } } };
  const SECTION_WATCH_LABEL_SRC = extractConst("SECTION_WATCH_LABEL");
  const SECTION_WATCH_LABEL = new Function(SECTION_WATCH_LABEL_SRC + "\nreturn SECTION_WATCH_LABEL;")();
  const prefillAlertFromLink = new Function(
    "$", "NL", "aWatchChange", "aPreview", "refreshQuizDisplay", "SECTION_WATCH_LABEL",
    extractFn("prefillAlertFromLink") + "\nreturn prefillAlertFromLink;"
  )($, NL, aWatchChange, aPreview, refreshQuizDisplay, SECTION_WATCH_LABEL);
  return { prefillAlertFromLink, fields, calls };
}

test("money lens: routes through NL.alerts.apply() (the SAME path the Ask box uses), so the existing echo applies", () => {
  const { prefillAlertFromLink, calls } = makeFixture();
  const filter = { keywords: ["asbestos"], minAmount: 200000, months: 3 };
  prefillAlertFromLink("money", filter, "weekly");
  assert.deepEqual(calls.nlApplyArg, filter, "the exact stored filter is handed to NL.alerts.apply(), unmodified");
  assert.equal(calls.refreshQuizDisplay, 1);
});

test("entity lens (vendor): #awatch=entityvendor, #aparam=the vendor name, preview runs", () => {
  const { prefillAlertFromLink, fields, calls } = makeFixture();
  prefillAlertFromLink("entity", { kind: "vendor", name: "Acme Snow & Ice LLC" });
  assert.equal(fields["#awatch"].value, "entityvendor");
  assert.equal(fields["#aparam"].value, "Acme Snow & Ice LLC");
  assert.equal(calls.aWatchChange, 1);
  assert.equal(calls.aPreview, 1);
});

test("entity lens (agency): #awatch=entityagency", () => {
  const { prefillAlertFromLink, fields } = makeFixture();
  prefillAlertFromLink("entity", { kind: "agency", name: "NYCHA" });
  assert.equal(fields["#awatch"].value, "entityagency");
  assert.equal(fields["#aparam"].value, "NYCHA");
});

test("land lens: #awatch=rezone, #aparam joins the stored keywords", () => {
  const { prefillAlertFromLink, fields, calls } = makeFixture();
  prefillAlertFromLink("land", { keywords: ["rivington"], status: "all" });
  assert.equal(fields["#awatch"].value, "rezone");
  assert.equal(fields["#aparam"].value, "rivington");
  assert.equal(calls.aPreview, 1);
});

test("a section lens (property/rules/meetings): #awatch=the lens itself, #aparam=keywords, #aagency=agency", () => {
  const { prefillAlertFromLink, fields } = makeFixture();
  prefillAlertFromLink("property", { keywords: ["environmental", "protection"], agency: "DEP" });
  assert.equal(fields["#awatch"].value, "property");
  assert.equal(fields["#aparam"].value, "environmental protection");
  assert.equal(fields["#aagency"].value, "DEP");
});

test("freq=weekly/daily sets #afreq's selectedIndex; an absent/garbage freq leaves it untouched", () => {
  const a = makeFixture(); a.prefillAlertFromLink("land", {}, "weekly");
  assert.equal(a.fields["#afreq"].selectedIndex, 1);
  const b = makeFixture(); b.prefillAlertFromLink("land", {}, "daily");
  assert.equal(b.fields["#afreq"].selectedIndex, 0);
  const c = makeFixture(); c.prefillAlertFromLink("land", {}, null);
  assert.equal(c.fields["#afreq"].selectedIndex, 0, "untouched from its default");
});

test("a null/undefined filter never throws — treated as an empty filter", () => {
  const { prefillAlertFromLink, fields } = makeFixture();
  assert.doesNotThrow(() => prefillAlertFromLink("entity", null, "daily"));
  assert.equal(fields["#aparam"].value, "");
});

test("an unrecognized lens leaves the builder untouched rather than guessing (fail-soft)", () => {
  const { prefillAlertFromLink, fields, calls } = makeFixture();
  prefillAlertFromLink("not-a-real-lens", { keywords: ["x"] }, "daily");
  assert.equal(fields["#awatch"].value, "", "no watch type is guessed for an unknown lens");
  assert.equal(calls.aWatchChange, 0);
  assert.equal(calls.aPreview, 0);
  assert.equal(calls.refreshQuizDisplay, 1, "still repaints the quiz view so it never shows a stale mismatch");
});
