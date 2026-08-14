import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deadSelectedSuggestions,
  firstNonEmptyVariant,
  fruitfulSuggestionIndices,
} from "../site/preset_validation.mjs";
import { canRefreshGeneratedFallback } from "../tools/preset_fallback_ci.mjs";
import { SUGGESTION_POOL } from "../worker/src/lib/suggestions.mjs";
import { validateLiveSuggestions } from "../tools/validate_presets.mjs";

const validatorSource = readFileSync(new URL("../tools/validate_presets.mjs", import.meta.url), "utf8");
const ciSource = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("preset validation reads and rewrites the modular site suggestion source", () => {
  assert.match(validatorSource, /site[^\n]+app[^\n]+search-share\.mjs/);
  assert.match(validatorSource, /fallbackFromSiteSource\(siteSuggestions\)/);
  assert.match(validatorSource, /writeFile\(SITE_SUGGESTIONS, siteSuggestions\)/);
  assert.doesNotMatch(validatorSource, /fallbackFromHTML\(html\)/);
});

test("CI refresh is allowed only for inherited fallback drift", () => {
  const site = "prefix\nconst NL_SUGGESTIONS_FALLBACK = {\n  money: [1],\n};\nsuffix";
  const changedOutsideFallback = `${site}\nother UI code`;
  const baseSources = {
    "site/app/search-share.mjs": site,
    "worker/src/lib/suggestions.mjs": "worker source",
    "site/data/preset-validation.json": "receipt",
    "tools/validate_presets.mjs": "validator",
    "site/preset_validation.mjs": "helpers",
  };
  assert.equal(
    canRefreshGeneratedFallback(baseSources, {
      ...baseSources,
      "site/app/search-share.mjs": changedOutsideFallback,
    }),
    true,
  );
  assert.equal(
    canRefreshGeneratedFallback(baseSources, {
      ...baseSources,
      "site/app/search-share.mjs": site.replace("[1]", "[2]"),
    }),
    false,
  );
  assert.equal(
    canRefreshGeneratedFallback(baseSources, {
      ...baseSources,
      "worker/src/lib/suggestions.mjs": "hand-edited worker source",
    }),
    false,
  );
  assert.equal(
    canRefreshGeneratedFallback({ ...baseSources, "worker/src/lib/suggestions.mjs": null }, baseSources),
    true,
  );
});

test("refresh retains an inherited candidate when live resolution is temporarily unavailable", async () => {
  const retainedKey = "money:0";
  const candidatesByLens = SUGGESTION_POOL.reduce((byLens, candidate) => {
    (byLens[candidate.lens] ||= []).push(candidate);
    return byLens;
  }, {});
  const previous = {
    minResults: 1,
    byLens: candidatesByLens,
    candidates: SUGGESTION_POOL.map((candidate) => ({
      ...candidate,
      filter: { candidate: `${candidate.lens}:${candidate.idx}` },
      count: 7,
    })),
  };
  for (const [lens, candidates] of Object.entries(previous.byLens)) {
    previous.byLens[lens] = candidates.map(({ idx }) => idx);
  }
  const warnings = [];
  const refreshed = await validateLiveSuggestions(previous, {
    resolve: async (candidate) => {
      if (`${candidate.lens}:${candidate.idx}` === retainedKey) {
        throw Object.assign(new Error("resolver returned degraded payload"), {
          code: "PRESET_SUGGESTION_UNRESOLVED",
        });
      }
      return { candidate: `${candidate.lens}:${candidate.idx}` };
    },
    count: async () => 5,
    warn: (message) => warnings.push(message),
  });
  const retained = refreshed.candidates.find((candidate) => `${candidate.lens}:${candidate.idx}` === retainedKey);
  assert.deepEqual(retained.filter, previous.candidates[0].filter);
  assert.equal(retained.count, previous.candidates[0].count);
  assert.deepEqual(refreshed.byLens.money, previous.byLens.money);
  assert.match(warnings[0], /money:0/);
});

test("a broad resolver outage retains the inherited fallback wholesale", async () => {
  const candidatesByLens = SUGGESTION_POOL.reduce((byLens, candidate) => {
    (byLens[candidate.lens] ||= []).push(candidate);
    return byLens;
  }, {});
  const previous = {
    minResults: 1,
    byLens: Object.fromEntries(
      Object.entries(candidatesByLens).map(([lens, candidates]) => [lens, candidates.map(({ idx }) => idx)]),
    ),
    candidates: SUGGESTION_POOL.map((candidate) => ({
      ...candidate,
      filter: { candidate: `${candidate.lens}:${candidate.idx}` },
      count: 7,
    })),
  };
  const warnings = [];
  const retained = await validateLiveSuggestions(previous, {
    resolve: async () => {
      throw Object.assign(new Error("resolver unavailable"), { code: "PRESET_SUGGESTION_UNRESOLVED" });
    },
    count: async () => {
      throw new Error("inherited candidates should not be recounted");
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(retained, previous);
  assert.match(warnings.at(-1), /retaining the inherited fallback wholesale/);
});

test("a hand-edited fallback remains ineligible for CI refresh", () => {
  const site = "prefix\nconst NL_SUGGESTIONS_FALLBACK = {\n  money: [1],\n};\nsuffix";
  const baseSources = {
    "site/app/search-share.mjs": site,
    "worker/src/lib/suggestions.mjs": "worker source",
    "site/data/preset-validation.json": "receipt",
  };
  assert.equal(
    canRefreshGeneratedFallback(baseSources, {
      ...baseSources,
      "site/app/search-share.mjs": site.replace("[1]", "[2]"),
    }),
    false,
  );
});

test("CI fetches the PR base before comparing a shallow checkout", () => {
  assert.match(ciSource, /git fetch --no-tags --depth=1 origin \"\$PRESET_BASE_SHA\"/);
});

test("live SODA fetch retries with exponential backoff on transient timeouts", () => {
  assert.match(validatorSource, /isTransientFetchError/);
  assert.match(validatorSource, /FETCH_BACKOFF_MS/);
  assert.match(validatorSource, /2 \*\* attempt/);
  assert.match(validatorSource, /TimeoutError|AbortError/);
  // CI defaults give SODA more attempts than local so short Open Data blips
  // do not fail the unit gate when the rest of the suite is green.
  assert.match(validatorSource, /process\.env\.CI \? 4 : 2/);
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
