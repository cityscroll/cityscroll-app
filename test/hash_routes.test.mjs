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

const { bareCollectionHash, canonicalInputRoute } = new Function(
  `${extractFn("bareCollectionHash")}; ${extractFn("canonicalInputRoute")}; return { bareCollectionHash, canonicalInputRoute };`,
)();

test("staffing input routes normalize to People without changing query parameters", () => {
  assert.equal(
    canonicalInputRoute("staffing?lang=es&view=guide&role=Engineer%20Civil&window=open"),
    "people?lang=es&view=guide&role=Engineer%20Civil&window=open",
  );
  assert.equal(canonicalInputRoute("staffing"), "people");
  assert.equal(canonicalInputRoute("people?lang=zh&q=planner"), "people?lang=zh&q=planner");
  assert.equal(canonicalInputRoute("staffing/legacy"), "staffing/legacy");

  const applyHash = extractFn("applyHash");
  assert.match(applyHash, /canonicalInputRoute\(raw\)/);
  assert.match(applyHash, /history\.replaceState[\s\S]*"#"\+raw/);
});

test("every item route has an intentional bare collection destination", () => {
  assert.deepEqual(
    {
      notice: bareCollectionHash("notice"),
      exam: bareCollectionHash("exam"),
      land: bareCollectionHash("land"),
      vendor: bareCollectionHash("vendor"),
      agency: bareCollectionHash("agency"),
      matter: bareCollectionHash("matter"),
      sharedInvestigation: bareCollectionHash("investigation/shared"),
      taskCanIBid: bareCollectionHash("task/can-i-bid"),
      taskWhatWillChange: bareCollectionHash("task/what-will-change"),
      taskBare: bareCollectionHash("task"),
    },
    {
      notice: "#money",
      exam: "#people?view=guide",
      land: "#land",
      vendor: "#money",
      agency: "#money",
      matter: "#money",
      sharedInvestigation: "#investigation",
      taskCanIBid: "#task/can-i-bid",
      taskWhatWillChange: "#task/what-will-change",
      taskBare: "#money",
    },
  );
});

test("a trailing slash with no item id resolves like the bare collection route", () => {
  for (const route of ["notice", "exam", "land", "vendor", "agency", "matter", "investigation/shared"]) {
    assert.equal(bareCollectionHash(`${route}/`), bareCollectionHash(route), route);
  }
});

test("item and unknown hashes are not mistaken for bare collections", () => {
  assert.equal(bareCollectionHash("exam/7016"), null);
  assert.equal(bareCollectionHash("matter/84124P0003001"), null);
  assert.equal(bareCollectionHash("something-else"), null);
});
