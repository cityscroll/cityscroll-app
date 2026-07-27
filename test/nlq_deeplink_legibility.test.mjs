import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(ROOT, "index.html"), "utf8");
const {
  canonicalSearchURL,
  moneyActiveFilterItems,
} = require("../nl_deeplink.js");

const PINNED_HASH =
  "#money?mode=award&min=500000&category=Construction%2FConstruction+Services";

test("the pinned cold-open fixture exposes every active filter needed to understand the results", () => {
  assert.equal(typeof moneyActiveFilterItems, "function");
  assert.deepEqual(
    moneyActiveFilterItems({
      noticeType: "award",
      minAmount: 500000,
      category: "Construction/Construction Services",
    }),
    [
      { kind: "noticeType", value: "award" },
      { kind: "category", value: "Construction/Construction Services" },
      { kind: "minAmount", value: 500000 },
    ],
  );
});

test("category-only, max-plus-months, and standard-only hidden filters all require an interpreted row", () => {
  assert.deepEqual(
    moneyActiveFilterItems({
      noticeType: "solicitation",
      category: "Goods and Services",
    }),
    [
      { kind: "noticeType", value: "solicitation" },
      { kind: "category", value: "Goods and Services" },
    ],
  );
  assert.deepEqual(
    moneyActiveFilterItems({
      noticeType: "solicitation",
      maxAmount: 750000,
      months: 3,
    }),
    [
      { kind: "noticeType", value: "solicitation" },
      { kind: "maxAmount", value: 750000 },
      { kind: "months", value: 3 },
    ],
  );
  assert.deepEqual(
    moneyActiveFilterItems({
      noticeType: "solicitation",
      excludeSpecial: true,
    }),
    [
      { kind: "noticeType", value: "solicitation" },
      { kind: "excludeSpecial", value: true },
    ],
  );
});

test("widget-visible filters alone do not produce a redundant interpreted row", () => {
  assert.deepEqual(
    moneyActiveFilterItems({
      noticeType: "award",
      agency: "Department of Buildings",
      keywords: ["roofing"],
      minAmount: 500000,
    }),
    [],
  );
});

test("the Money page projects active state into one visible row with a clear-filters control", () => {
  assert.match(indexSource, /id="moneyactivefilters"/);
  assert.match(indexSource, /function renderMoneyActiveFilters\(\)/);
  assert.match(indexSource, /moneyActiveFilterItems\(\{/);
  assert.match(indexSource, /id="moneyactiveclear"/);
  assert.match(indexSource, /moneyNlResolved=\{\}/);

  const applyHashStart = indexSource.indexOf("function applyHash()");
  const applyHashEnd = indexSource.indexOf("const NOTICE_SELECT", applyHashStart);
  const applyHashSource = indexSource.slice(applyHashStart, applyHashEnd);
  assert.match(applyHashSource, /showTab\("money"\); search\(\)/);
});

test("same-hash sharing resolves to a canonical absolute URL and opens a new tab safely", () => {
  assert.equal(typeof canonicalSearchURL, "function");
  assert.equal(
    canonicalSearchURL(
      { origin: "https://crol-list.org", pathname: "/index.html" },
      PINNED_HASH,
    ),
    "https://crol-list.org/index.html" + PINNED_HASH,
  );
  assert.match(
    indexSource,
    /id="nlqshare"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
  );
  assert.match(indexSource, /share\.href=canonicalSearchURL\(location, hash\)/);
});
