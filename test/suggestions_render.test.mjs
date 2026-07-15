// Pins index.html's client-side half of w12-08 (verified, rotating suggestion chips).
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

const { pickSuggestions, currentSuggestionIndices, setValidated, NL_SUGGESTIONS_FALLBACK } = new Function(
  extractConstBlock("NL_SUGGESTIONS_FALLBACK") +
  "let NL_SUGGESTIONS_VALIDATED = null;" +
  extractFn("currentSuggestionIndices") +
  extractFn("pickSuggestions") +
  "function setValidated(v){ NL_SUGGESTIONS_VALIDATED = v; }" +
  "return { pickSuggestions, currentSuggestionIndices, setValidated, NL_SUGGESTIONS_FALLBACK };"
)();

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
