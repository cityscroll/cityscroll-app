import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(ROOT, "index.html"), "utf8");
const { parseNL } = require("../nl_parse.js");
const {
  buildMoneyDeepLink,
  parsePresetStore,
  savePreset,
  removePreset,
} = require("../nl_deeplink.js");

test("pinned fixture resolves to the deterministic construction-awards hash", () => {
  const filter = parseNL("construction contracts over $500k");
  assert.equal(
    buildMoneyDeepLink(filter),
    "#money?mode=award&q=construction&min=500000&category=Construction%2FConstruction+Services",
  );
});

test("the hash preserves every structured Money filter in canonical order", () => {
  assert.equal(
    buildMoneyDeepLink({
      keywords: ["roofing"],
      agency: "Buildings",
      minAmount: null,
      maxAmount: 750000,
      category: "Goods and Services",
      months: 3,
      noticeType: "solicitation",
      excludeSpecial: true,
    }),
    "#money?mode=open&agency=Buildings&q=roofing&max=750000&category=Goods+and+Services&months=3&standard=1",
  );
});

test("an unresolved query never receives a fabricated deep link", () => {
  assert.equal(buildMoneyDeepLink(parseNL("show me something interesting")), null);
  assert.equal(buildMoneyDeepLink(null), null);
});

test("saved presets are validated, deduplicated by hash, and removable", () => {
  const first = savePreset([], "Construction contracts over $500k", "#money?mode=award&q=construction&min=500000");
  const updated = savePreset(first, "Large construction awards", "#money?mode=award&q=construction&min=500000");
  assert.deepEqual(updated, [{
    label: "Large construction awards",
    hash: "#money?mode=award&q=construction&min=500000",
  }]);
  assert.deepEqual(removePreset(updated, 0), []);
  assert.deepEqual(parsePresetStore("{not json"), []);
  assert.deepEqual(parsePresetStore(JSON.stringify([{ label: "", hash: "#money" }, { label: "Bad", hash: "#land" }])), []);
});

test("the Money UI wires resolved links, complete replay filters, and local presets", () => {
  assert.match(indexSource, /<script src="nl_deeplink\.js"><\/script>/);
  assert.match(indexSource, /const deepLink=buildMoneyDeepLink\(p\)/);
  assert.match(indexSource, /bindNLQResolvedActions\(text, deepLink\)/);
  assert.match(indexSource, /category_description='\$\{category\.replace/);
  assert.match(indexSource, /contract_amount <= \$\{maxAmount\}/);
  assert.match(indexSource, /due_date <= '\$\{addMonthsISO\(todayISO\(\), months\)\}'/);
  assert.match(indexSource, /selection_method_description NOT LIKE '%Special%'/);
  assert.match(indexSource, /const NLQ_PRESET_KEY = "crd_nlq_presets_v1"/);
  assert.match(indexSource, /renderNLQPresets\(\)/);
});

test("the hash router restores Money filters directly without resolving natural language", () => {
  const start = indexSource.indexOf("function applyHash()");
  const end = indexSource.indexOf("const NOTICE_SELECT", start);
  const applyHashSource = indexSource.slice(start, end);
  assert.match(applyHashSource, /moneyNlResolved = \{/);
  assert.match(applyHashSource, /showTab\("money"\); search\(\)/);
  assert.doesNotMatch(applyHashSource, /nlResolve|workerFetch|\/nl/);
});
