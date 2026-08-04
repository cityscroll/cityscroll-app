import { SITE_SOURCE } from "./helpers/site_source.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = SITE_SOURCE;

function extractFn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function explainerHarness(seen = false) {
  const details = { open: false };
  const values = new Map(seen ? [["crol_exam_how_seen_v1", "1"]] : []);
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  return new Function(
    "$",
    "localStorage",
    `let careerHowPrepared=false;
     const CAREER_HOW_SEEN_KEY="crol_exam_how_seen_v1";
     ${extractFn("prepareCareerHow")}
     return { prepareCareerHow, prepared: () => careerHowPrepared };`,
  )(selector => {
    assert.equal(selector, "#career-how-details");
    return details;
  }, localStorage);
}

test("the exam explanation starts collapsed and preserves a manual toggle", () => {
  const harness = explainerHarness();
  const details = { open: false };
  const values = new Map();
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const prepared = new Function(
    "$",
    "localStorage",
    `let careerHowPrepared=false;
     const CAREER_HOW_SEEN_KEY="crol_exam_how_seen_v1";
     ${extractFn("prepareCareerHow")}
     return prepareCareerHow;`,
  )(() => details, localStorage);

  prepared();
  assert.equal(details.open, false);
  assert.equal(values.has("crol_exam_how_seen_v1"), false);
  details.open = true;
  prepared();
  assert.equal(details.open, true, "later renders do not override the visitor's toggle");
  assert.ok(harness.prepared() === false, "separate page harness remains independent");
});

test("returning visitors start with the exam explanation collapsed", () => {
  const details = { open: true };
  const localStorage = {
    getItem: () => "1",
    setItem: () => assert.fail("returning visit should not rewrite the seen flag"),
  };
  const prepared = new Function(
    "$",
    "localStorage",
    `let careerHowPrepared=false;
     const CAREER_HOW_SEEN_KEY="crol_exam_how_seen_v1";
     ${extractFn("prepareCareerHow")}
     return prepareCareerHow;`,
  )(() => details, localStorage);
  prepared();
  assert.equal(details.open, false);
});

test("the Contracts lens exposes four sourced matter examples with copy controls", () => {
  const pins = [
    "84124P0003001",
    "06820P8165KXLR002",
    "07124N0007001R001",
    "82626B0029001",
  ];
  for (const pin of pins) {
    assert.match(source, new RegExp(`href="#matter/${pin}"`));
    assert.match(source, new RegExp(`data-matter-copy="${pin}"`));
  }
  assert.equal((source.match(/data-matter-copy="/g) || []).length, pins.length);
});
