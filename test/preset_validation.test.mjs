import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deadSelectedSuggestions,
  firstNonEmptyVariant,
  fruitfulSuggestionIndices,
} from "../site/preset_validation.mjs";

const validatorSource = readFileSync(new URL("../tools/validate_presets.mjs", import.meta.url), "utf8");

test("preset validation reads and rewrites the modular site suggestion source", () => {
  assert.match(validatorSource, /site[^\n]+app[^\n]+search-share\.mjs/);
  assert.match(validatorSource, /fallbackFromSiteSource\(siteSuggestions\)/);
  assert.match(validatorSource, /writeFile\(SITE_SUGGESTIONS, siteSuggestions\)/);
  assert.doesNotMatch(validatorSource, /fallbackFromHTML\(html\)/);
});

test("a zero-result week preset widens only to the first non-empty scope", () => {
  const variants = [
    { id: "week", href: "#meetings?when=week" },
    { id: "month", href: "#meetings?when=month" },
    { id: "upcoming", href: "#meetings?when=upcoming" },
  ];
  assert.deepEqual(
    firstNonEmptyVariant(variants, { week: 0, month: 4, upcoming: 9 }),
    { id: "month", href: "#meetings?when=month", count: 4 },
  );
});

test("a preset with no non-empty variant is rejected instead of shipped", () => {
  assert.equal(firstNonEmptyVariant([{ id: "week" }, { id: "month" }], { week: 0, month: 0 }), null);
});

test("rotating suggestions draw only from candidates with results", () => {
  const candidates = [
    { lens: "land", idx: 0, count: 8 },
    { lens: "land", idx: 1, count: 0 },
    { lens: "land", idx: 2, count: 3 },
    { lens: "money", idx: 0, count: 12 },
  ];
  const byLens = fruitfulSuggestionIndices(candidates, 3);
  assert.deepEqual(byLens, { land: [0, 2], money: [0] });
  assert.deepEqual(deadSelectedSuggestions(byLens, candidates, 3), []);
  assert.deepEqual(deadSelectedSuggestions({ land: [1] }, candidates, 3), [{ lens: "land", idx: 1 }]);
});
