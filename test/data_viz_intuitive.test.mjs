// The data page answers two different questions with bars:
// - ranked comparisons use the largest row as the honest 100% reference;
// - compositions use the total, so their widths add to 100%.
// In both cases the raw value remains directly visible.
//
// Run: node --test test/data_viz_intuitive.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data.html"), "utf8");

function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in data.html`);
  let depth = 0;
  let seen = false;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seen = true;
    } else if (src[i] === "}" && --depth === 0 && seen) {
      return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const env = new Function(
  "esc",
  "t",
  "fmtPercent",
  extractFn("chartRows") +
    extractFn("bars") +
    "return { chartRows, bars };",
)(
  (value) => String(value),
  (key, vars = {}) => key === "data_value_share"
    ? `${vars.value} · ${vars.share} of total`
    : key,
  (share) => `${Math.round(share * 100)}%`,
);

test("close ranking values retain an honest zero baseline and print every value", () => {
  const rows = [
    { label: "First", amount: 3600 },
    { label: "Second", amount: 3100 },
    { label: "Third", amount: 2700 },
  ];
  const model = env.chartRows(rows, "amount", "ranking");
  assert.deepEqual(model.map((row) => Math.round(row.width)), [100, 86, 75]);

  const el = { innerHTML: "", dataset: {} };
  env.bars(el, rows, "label", "amount", (value) => value.toLocaleString("en-US"), "ranking");
  assert.match(el.innerHTML, />3,600</);
  assert.match(el.innerHTML, />3,100</);
  assert.match(el.innerHTML, />2,700</);
});

test("composition widths use share of total and add to approximately 100%", () => {
  const rows = [
    { label: "Awards", count: 3237 },
    { label: "Solicitations", count: 929 },
    { label: "Intent to award", count: 488 },
    { label: "Vendor lists", count: 13 },
  ];
  const model = env.chartRows(rows, "count", "composition");
  const widthTotal = model.reduce((sum, row) => sum + row.width, 0);
  assert.ok(Math.abs(widthTotal - 100) < 0.01, `composition widths total ${widthTotal}`);

  const el = { innerHTML: "", dataset: {} };
  env.bars(el, rows, "label", "count", String, "composition");
  assert.match(el.innerHTML, /3,237|3237/);
  assert.match(el.innerHTML, /69% of total/);
});

test("bar fills establish a real layout box so percentage widths render", () => {
  assert.match(src, /\.bar \.fil\{[^}]*display:block/);
});
