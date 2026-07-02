import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNames, MAX_NAMES } from "../src/lib/batch.mjs";

test("parseNames: trims, dedupes case-insensitively, caps count and length", () => {
  const names = parseNames(["  Acme   Corp ", "acme corp", "AB", "", "Sinergia Inc", "x".repeat(200)]);
  assert.deepEqual(names.slice(0, 2), ["Acme Corp", "Sinergia Inc"]);
  assert.ok(names.every(n => n.length <= 80));
  assert.equal(parseNames(Array.from({length: 50}, (_, i) => "Vendor Number " + i)).length, MAX_NAMES);
});

test("parseNames: non-arrays yield empty", () => {
  assert.deepEqual(parseNames("Acme"), []);
  assert.deepEqual(parseNames(null), []);
});
