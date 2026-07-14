// A digest-alert query like "education contracts over $200K due in 3 months" describes a
// category, a dollar floor, and a deadline all at once. Before this, Alerts routed every "Ask"
// query through a three-way classifier (a big-award threshold XOR an RFP keyword XOR a rezoning
// place) that could only ever keep one of those signals — so a combined query like the example
// above lost two of its three parts. parseNL() (nl_parse.js) is the proven combined extractor
// already used by the Money tab's search box; this proves it now backs Alerts too, and that its
// category dictionary actually recognizes common civic categories like "education".
//
//   node --test test/nl_alerts_parse.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNL, NL_CATEGORY_DICT } from "../nl_parse.js";

test("parseNL: category + amount + deadline extracted TOGETHER, not one-at-a-time", () => {
  const f = parseNL("education contracts over $200K due in 3 months");
  assert.ok(f.keywords.includes("education"), `keywords: ${JSON.stringify(f.keywords)}`);
  assert.equal(f.minAmount, 200000);
  assert.equal(f.months, 3);
});

test("parseNL: the same three-signal combo works with looser wording", () => {
  const f = parseNL("email me about school sanitation contracts over 1.5 million due within 6 weeks");
  assert.ok(f.keywords.includes("sanitation"), `keywords: ${JSON.stringify(f.keywords)}`);
  assert.equal(f.minAmount, 1500000);
  assert.equal(f.months, 2, "6 weeks rounds up to 2 months");
});

test("category dictionary includes education and other common civic categories", () => {
  for (const term of ["education", "schools", "sanitation", "parks"]) {
    assert.ok(NL_CATEGORY_DICT.includes(term), `dictionary missing "${term}"`);
  }
});

test("parseNL: a bare amount or deadline alone still works (no regression)", () => {
  assert.equal(parseNL("awards over $1M").minAmount, 1000000);
  assert.equal(parseNL("construction RFPs due in 3 months").months, 3);
  assert.deepEqual(parseNL("awards over $1M").keywords, []);
});

test("parseNL: no dollar/deadline signal -> both stay null, keywords stays empty", () => {
  const f = parseNL("rezonings near 79 Rivington");
  assert.equal(f.minAmount, null);
  assert.equal(f.months, null);
  assert.deepEqual(f.keywords, []);
});

test("parseNL: keywords cap at 4 and de-duplicate", () => {
  const f = parseNL("education schools parks recreation sanitation contracts");
  assert.ok(f.keywords.length <= 4, `keywords: ${JSON.stringify(f.keywords)}`);
  assert.equal(new Set(f.keywords).size, f.keywords.length, "no duplicates");
});
