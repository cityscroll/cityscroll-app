// Pins index.html's client-side half of w12-08 (verified, rotating suggestion chips) and its
// w12-17 extension (lineage/forecast discoverability indicators).
//
// Before this card: NL_SAMPLES was a hardcoded, never-checked array — the money lens's
// "IT consulting RFPs"/"shelter services contracts" chips could (and, per the site owner's
// field report, did) return zero live results forever, with nothing in the client ever
// excluding them. These tests pin: pickSuggestions() rotates deterministically (same day ->
// same picks, different day -> different picks, per the day-seed contract), currentSuggestionIndices()
// prefers a daily-validated set over the static fallback when one exists for the lens, falls
// back cleanly when it doesn't (or is empty), and the static NL_SUGGESTIONS_FALLBACK itself
// never includes money idx 1/2 — the two dead field-evidence examples — by construction.
//
// w12-17 (owner directive: make lineage/forecast "much more discoverable" through the
// suggestions themselves): before this card, a validated suggestion carried no hint at all
// about whether its own results have prior award-cycle history or agency forecast data —
// clicking one and then also finding the lineage/forecast features was pure luck. These tests
// additionally pin: currentSuggestionMeta() reads the daily-computed lineageRich/
// forecastBearing flags into idx sets (empty — never a guess — when unvalidated),
// pickSuggestionsGuaranteed() guarantees representation of lineage-rich chips on Money without
// excluding the rest of the pool, and trychipHTML() renders the subtle indicator class(es) +
// an accessible sr-only hint only for a chip whose signal is actually known.
//
//   node --test test/suggestions_render.test.mjs   (from the crol-list/ dir)

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
// NL_SUGGESTIONS_FALLBACK is a multi-line object literal (unlike escUiHtml's single-line
// const), so this brace-matches from "const NAME = {" the same way extractFn does for
// functions, rather than extractConst's to-end-of-line regex (which only ever fits one line).
function extractConstBlock(name) {
  const start = src.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `const ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1) + ";";
  }
  throw new Error(`unbalanced braces extracting const ${name}`);
}

const {
  pickSuggestions, currentSuggestionIndices, currentSuggestionMeta, pickSuggestionsGuaranteed,
  trychipHTML, setValidated, NL_SUGGESTIONS_FALLBACK, LINEAGE_GUARANTEE_MIN,
} = new Function(
  "t",
  extractConstBlock("NL_SUGGESTIONS_FALLBACK") +
  "let NL_SUGGESTIONS_VALIDATED = null;" +
  extractFn("currentSuggestionIndices") +
  extractFn("currentSuggestionMeta") +
  extractFn("pickSuggestions") +
  src.match(/^const LINEAGE_GUARANTEE_MIN = .*$/m)[0] +
  extractFn("pickSuggestionsGuaranteed") +
  extractFn("trychipHTML") +
  "function setValidated(v){ NL_SUGGESTIONS_VALIDATED = v; }" +
  "return { pickSuggestions, currentSuggestionIndices, currentSuggestionMeta, pickSuggestionsGuaranteed, trychipHTML, setValidated, NL_SUGGESTIONS_FALLBACK, LINEAGE_GUARANTEE_MIN };"
)((key) => ({ sugg_lineage_hint: "Includes contracts with award history", sugg_forecast_hint: "Includes contracts with forecast data" }[key] || key));

// ---- pickSuggestions: deterministic day-seeded rotation --------------------------------

test("pickSuggestions: same seed -> identical picks (stable within a day)", () => {
  const a = pickSuggestions([0, 3, 4, 5], 3, 42);
  const b = pickSuggestions([0, 3, 4, 5], 3, 42);
  assert.deepEqual(a, b);
});

test("pickSuggestions: consecutive day seeds rotate the window (varied across days)", () => {
  const day0 = pickSuggestions([0, 3, 4, 5], 3, 0);
  const day1 = pickSuggestions([0, 3, 4, 5], 3, 1);
  assert.deepEqual(day0, [0, 3, 4]);
  assert.deepEqual(day1, [3, 4, 5]);
  assert.notDeepEqual(day0, day1);
});

test("pickSuggestions: wraps around the pool", () => {
  assert.deepEqual(pickSuggestions([0, 3, 4, 5], 3, 3), [5, 0, 3]);
});

test("pickSuggestions: never asks for more than the pool has", () => {
  assert.deepEqual(pickSuggestions([0, 1], 3, 0), [0, 1]);
});

test("pickSuggestions: empty pool -> nothing to show, not a crash", () => {
  assert.deepEqual(pickSuggestions([], 3, 5), []);
  assert.deepEqual(pickSuggestions(null, 3, 5), []);
});

// ---- currentSuggestionIndices: validated set wins, fallback otherwise ------------------

test("currentSuggestionIndices: before the worker responds, money falls back to the evergreen static subset (never idx 1/2, the dead field-evidence examples)", () => {
  setValidated(null);
  const idxs = currentSuggestionIndices("money");
  assert.deepEqual(idxs, NL_SUGGESTIONS_FALLBACK.money);
  assert.ok(!idxs.includes(1), "IT consulting RFPs (idx 1) must never be in the static fallback");
  assert.ok(!idxs.includes(2), "shelter services contracts (idx 2) must never be in the static fallback");
});

test("currentSuggestionIndices: once the worker's validated set arrives, it wins over the static fallback", () => {
  setValidated({ money: [{ idx: 0, count: 57 }, { idx: 4, count: 12 }] });
  assert.deepEqual(currentSuggestionIndices("money"), [0, 4]);
});

test("currentSuggestionIndices: an empty validated array for a lens still falls back to static (an all-fruitless day must not blank the chips)", () => {
  setValidated({ money: [] });
  assert.deepEqual(currentSuggestionIndices("money"), NL_SUGGESTIONS_FALLBACK.money);
});

test("currentSuggestionIndices: 'people' always uses its own fallback — it has no validated set (payroll counting isn't wired into the worker)", () => {
  setValidated({ money: [{ idx: 0, count: 57 }] }); // validated set present, but never names "people"
  assert.deepEqual(currentSuggestionIndices("people"), NL_SUGGESTIONS_FALLBACK.people);
});

test("NL_SUGGESTIONS_FALLBACK: every validatable lens has a non-empty static subset", () => {
  for (const lens of ["money", "people", "land", "property", "rules", "meetings", "alerts"]) {
    assert.ok(Array.isArray(NL_SUGGESTIONS_FALLBACK[lens]) && NL_SUGGESTIONS_FALLBACK[lens].length > 0, `missing fallback for ${lens}`);
  }
});

// ---- currentSuggestionMeta (w12-17): reads lineageRich/forecastBearing into idx sets --------

test("currentSuggestionMeta: before the worker responds, no signal is known — empty sets, not a guess", () => {
  setValidated(null);
  const meta = currentSuggestionMeta("money");
  assert.equal(meta.lineage.size, 0);
  assert.equal(meta.forecast.size, 0);
});

test("currentSuggestionMeta: reads lineageRich/forecastBearing flags off the validated entries", () => {
  setValidated({ money: [
    { idx: 0, count: 42, lineageRich: true, forecastBearing: false },
    { idx: 3, count: 8, lineageRich: false, forecastBearing: true },
    { idx: 4, count: 5, lineageRich: true, forecastBearing: true },
    { idx: 5, count: 3, lineageRich: false, forecastBearing: false },
  ] });
  const meta = currentSuggestionMeta("money");
  assert.deepEqual([...meta.lineage].sort(), [0, 4]);
  assert.deepEqual([...meta.forecast].sort(), [3, 4]);
});

test("currentSuggestionMeta: an entry missing the flags entirely (older cache shape) reads as no signal, not a crash", () => {
  setValidated({ money: [{ idx: 0, count: 42 }] });
  const meta = currentSuggestionMeta("money");
  assert.equal(meta.lineage.size, 0);
  assert.equal(meta.forecast.size, 0);
});

// ---- pickSuggestionsGuaranteed (w12-17): representation, not exclusivity --------------------

test("pickSuggestionsGuaranteed: with no lineage-rich idx available, behaves exactly like pickSuggestions", () => {
  const plain = pickSuggestions([0, 3, 4, 5], 3, 7);
  const guaranteed = pickSuggestionsGuaranteed([0, 3, 4, 5], [], 3, 7, LINEAGE_GUARANTEE_MIN);
  assert.deepEqual(guaranteed, plain);
});

test("pickSuggestionsGuaranteed: guarantees LINEAGE_GUARANTEE_MIN lineage-rich chips are present when available", () => {
  const picked = pickSuggestionsGuaranteed([0, 1, 3, 4, 5], [0, 4], 3, 0, LINEAGE_GUARANTEE_MIN);
  const lineageInPicked = picked.filter((idx) => [0, 4].includes(idx));
  assert.equal(picked.length, 3);
  assert.equal(lineageInPicked.length, LINEAGE_GUARANTEE_MIN);
});

test("pickSuggestionsGuaranteed: never exceeds displayCount even when the lineage-rich pool alone is bigger", () => {
  const picked = pickSuggestionsGuaranteed([0, 1, 2, 3, 4], [0, 1, 2, 3], 3, 2, LINEAGE_GUARANTEE_MIN);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3, "no duplicate idx in one chip row");
});

test("pickSuggestionsGuaranteed: the general pool still fills the remaining slots — representation, not exclusivity", () => {
  const picked = pickSuggestionsGuaranteed([0, 1, 2, 3, 4], [0], 3, 0, LINEAGE_GUARANTEE_MIN);
  // Only one lineage-rich idx exists, so the guarantee is capped at 1 — the other two slots
  // come from the ordinary rotation over the full pool, not exclusively from lineage idx.
  assert.equal(picked.filter((idx) => idx === 0).length, 1);
  assert.equal(picked.length, 3);
});

// ---- trychipHTML (w12-17): subtle indicator classes + accessible hints ----------------------

test("trychipHTML: a chip with no signal renders as a plain .trychip — no class, no aria-describedby, no hint span", () => {
  const html = trychipHTML("money", 0, { lineage: new Set(), forecast: new Set() });
  assert.match(html, /class="trychip"/);
  assert.doesNotMatch(html, /has-lineage|has-forecast|aria-describedby/);
  assert.doesNotMatch(html, /sr-only/);
});

test("trychipHTML: a lineage-rich chip gets the has-lineage class, aria-describedby, and a sr-only hint span", () => {
  const html = trychipHTML("money", 0, { lineage: new Set([0]), forecast: new Set() });
  assert.match(html, /class="trychip has-lineage"/);
  assert.match(html, /aria-describedby="sugghint-lineage-money-0"/);
  assert.match(html, /<span id="sugghint-lineage-money-0" class="sr-only"[^>]*>Includes contracts with award history<\/span>/);
});

test("trychipHTML: a forecast-bearing chip gets its own distinct class + hint, not the lineage one", () => {
  const html = trychipHTML("money", 3, { lineage: new Set(), forecast: new Set([3]) });
  assert.match(html, /class="trychip has-forecast"/);
  assert.match(html, /<span id="sugghint-forecast-money-3" class="sr-only"[^>]*>Includes contracts with forecast data<\/span>/);
  assert.doesNotMatch(html, /has-lineage/);
});

test("trychipHTML: a chip that is both lineage-rich and forecast-bearing carries both classes and both hints", () => {
  const html = trychipHTML("money", 4, { lineage: new Set([4]), forecast: new Set([4]) });
  assert.match(html, /class="trychip has-lineage has-forecast"/);
  assert.match(html, /aria-describedby="sugghint-lineage-money-4 sugghint-forecast-money-4"/);
  assert.match(html, /sugghint-lineage-money-4.*sugghint-forecast-money-4/s);
});

test("trychipHTML: the hint span is a SIBLING of the button, never nested inside it — data-i18n on the button keeps zero children", () => {
  // If the hint were nested inside the <button>, applyStrings()'s "el.children.length === 0"
  // guard would silently stop retranslating the button's own label on a language switch.
  const html = trychipHTML("money", 0, { lineage: new Set([0]), forecast: new Set() });
  const buttonOnly = html.slice(0, html.indexOf("</button>") + "</button>".length);
  assert.doesNotMatch(buttonOnly, /<span/);
});
