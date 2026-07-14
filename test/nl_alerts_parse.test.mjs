// A digest-alert query like "education contracts over $200K due in 3 months" describes a
// category, a dollar floor, and a deadline all at once — or "Parks Department awards over
// $1M due in 3 months" describes an agency, a notice type, an amount, and a deadline. Before
// this, Alerts routed every "Ask" query through a three-way classifier (a big-award threshold
// XOR an RFP keyword XOR a rezoning place) that could only ever keep one signal, then (in a
// first pass at fixing that) a bespoke three-field shape that only generalized as far as the
// one motivating example. parseNL() (nl_parse.js) now fills WHATEVER subset of the real
// queryable fields — keywords, agency, category, minAmount, maxAmount, months, noticeType —
// a sentence actually names, matching worker/src/lib/filter.mjs's LENSES.money field list
// (the single source of truth for the schema, additive — a new field is a new array entry,
// no migration).
//
//   node --test test/nl_alerts_parse.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNL, NL_CATEGORY_DICT, NL_AGENCY_ALIASES } from "../nl_parse.js";

test("parseNL: category + amount + deadline extracted TOGETHER, not one-at-a-time", () => {
  const f = parseNL("education contracts over $200K due in 3 months");
  assert.ok(f.keywords.includes("education"), `keywords: ${JSON.stringify(f.keywords)}`);
  assert.equal(f.minAmount, 200000);
  assert.equal(f.months, 3);
});

test("parseNL: the same signal combo works with looser wording", () => {
  const f = parseNL("email me about school sanitation contracts over 1.5 million due within 6 weeks");
  assert.ok(f.keywords.includes("sanitation"), `keywords: ${JSON.stringify(f.keywords)}`);
  assert.equal(f.minAmount, 1500000);
  assert.equal(f.months, 2, "6 weeks rounds up to 2 months");
});

// The motivating multi-field case for this generalization: agency + notice type + amount +
// deadline, none of which is "keywords" — the field the original bespoke shape covered best.
test("parseNL: agency + notice type + amount + deadline extracted together", () => {
  const f = parseNL("Parks Department awards over $1M in the next 3 months");
  assert.equal(f.agency, "Parks and Recreation");
  assert.equal(f.noticeType, "award");
  assert.equal(f.minAmount, 1000000);
  assert.equal(f.months, 3);
});

test("parseNL: agency phrases resolve common informal names and acronyms", () => {
  assert.equal(parseNL("email me about DOT contracts").agency, "Transportation");
  assert.equal(parseNL("Department of Buildings solicitations").agency, "Buildings");
  assert.equal(parseNL("anything from HPD").agency, "Housing Preservation and Development");
  assert.equal(parseNL("no mention of any agency here").agency, null);
});

test("parseNL: notice-type phrases distinguish awards from solicitations", () => {
  assert.equal(parseNL("show me contract awards from DSNY").noticeType, "award");
  assert.equal(parseNL("open RFPs for catering").noticeType, "solicitation");
  assert.equal(parseNL("construction bids under $500k").noticeType, "solicitation");
  assert.equal(parseNL("winners of the last construction contract").noticeType, "award");
  assert.equal(parseNL("construction contracts over $200k").noticeType, null, "amount alone doesn't set an explicit notice type");
});

test("parseNL: maxAmount (a ceiling) extracts independently of minAmount (a floor)", () => {
  assert.equal(parseNL("construction RFPs under $500k").maxAmount, 500000);
  assert.equal(parseNL("construction RFPs under $500k").minAmount, null);
  assert.equal(parseNL("awards over $1M").maxAmount, null);
});

test("parseNL: a full multi-field sentence fills every applicable field at once", () => {
  const f = parseNL("construction RFPs under $500k from the Department of Buildings");
  assert.ok(f.keywords.includes("construction"));
  assert.equal(f.agency, "Buildings");
  assert.equal(f.maxAmount, 500000);
  assert.equal(f.noticeType, "solicitation");
  assert.equal(f.category, "Construction/Construction Services");
});

test("parseNL: category is inferred only from unambiguous signals, not guessed", () => {
  assert.equal(parseNL("goods and services over $1M").category, "Goods and Services");
  assert.equal(parseNL("human services contracts").category, "Human Services/Client Services");
  assert.equal(parseNL("education contracts over $200K").category, null, "topic keywords alone don't imply a procurement category");
});

test("category dictionary includes education and other common civic categories", () => {
  for (const term of ["education", "schools", "sanitation", "parks"]) {
    assert.ok(NL_CATEGORY_DICT.includes(term), `dictionary missing "${term}"`);
  }
});

test("agency alias dictionary maps to the dataset's current canonical agency_name form", () => {
  const names = NL_AGENCY_ALIASES.map(([canonical]) => canonical);
  for (const n of ["Parks and Recreation", "Sanitation", "Transportation", "Buildings", "Housing Preservation and Development"]) {
    assert.ok(names.includes(n), `agency dictionary missing "${n}"`);
  }
});

test("parseNL: a bare amount or deadline alone still works (no regression)", () => {
  assert.equal(parseNL("awards over $1M").minAmount, 1000000);
  assert.equal(parseNL("construction RFPs due in 3 months").months, 3);
  assert.deepEqual(parseNL("awards over $1M").keywords, []);
});

test("parseNL: no signal at all -> every field stays null/empty", () => {
  const f = parseNL("rezonings near 79 Rivington");
  assert.equal(f.minAmount, null);
  assert.equal(f.maxAmount, null);
  assert.equal(f.months, null);
  assert.equal(f.agency, null);
  assert.equal(f.category, null);
  assert.equal(f.noticeType, null);
  assert.deepEqual(f.keywords, []);
});

test("parseNL: keywords cap at 4 and de-duplicate", () => {
  const f = parseNL("education schools parks recreation sanitation contracts");
  assert.ok(f.keywords.length <= 4, `keywords: ${JSON.stringify(f.keywords)}`);
  assert.equal(new Set(f.keywords).size, f.keywords.length, "no duplicates");
});
