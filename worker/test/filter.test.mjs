// Pure unit tests for the lens-aware /nl sanitizer. No network, no API key — `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, LENSES, MAX_INPUT, MAX_CALLS_PER_DAY } from "../src/lib/filter.mjs";

test("money: canonical construction example normalizes", () => {
  const out = sanitize("money", {
    keywords: ["Affordable Housing", "Construction", "", "  x  ", "y", "z"],
    minAmount: 500000, months: 3, excludeSpecial: true, agency: null,
  });
  assert.deepEqual(out.keywords, ["affordable housing", "construction", "x", "y"]); // lowercased, trimmed, blanks dropped, capped at 4
  assert.equal(out.minAmount, 500000);
  assert.equal(out.months, 3);
  assert.equal(out.excludeSpecial, true);
  assert.equal(out.agency, null);
});

test("money: clamps junk / out-of-range (defense in depth)", () => {
  const out = sanitize("money", { keywords: "nope", minAmount: 5, months: 999, excludeSpecial: "yes", agency: "   " });
  assert.deepEqual(out.keywords, []);
  assert.equal(out.minAmount, null);
  assert.equal(out.months, null);
  assert.equal(out.excludeSpecial, true);
  assert.equal(out.agency, null);
});

test("land: only land fields; borough validated to the 5", () => {
  const out = sanitize("land", { keywords: ["housing"], boro: "brooklyn", status: "all", minAmount: 9999 /* not a land field */ });
  assert.deepEqual(Object.keys(out).sort(), ["boro", "keywords", "status"]);
  assert.equal(out.boro, "Brooklyn"); // normalized to canonical casing
  assert.equal(out.status, "all");
  assert.deepEqual(out.keywords, ["housing"]);
});

test("land: a neighborhood is not a borough -> null", () => {
  assert.equal(sanitize("land", { boro: "Bushwick" }).boro, null);
});

test("people: lookupType constrained to role|person", () => {
  assert.equal(sanitize("people", { lookupType: "person" }).lookupType, "person");
  assert.equal(sanitize("people", { lookupType: "banana" }).lookupType, null);
  assert.deepEqual(Object.keys(sanitize("people", {})).sort(), ["keywords", "lookupType"]);
});

test("meetings: when constrained; unknown lens falls back to money shape", () => {
  assert.equal(sanitize("meetings", { when: "upcoming" }).when, "upcoming");
  assert.equal(sanitize("meetings", { when: "someday" }).when, null);
  // maxAmount + category joined the money lens in the crol-alert vocab merge (issue #1 PR-3).
  assert.deepEqual(Object.keys(sanitize("bogus", {})).sort(), ["agency", "category", "excludeSpecial", "keywords", "maxAmount", "minAmount", "months"]);
});

test("alerts: watchType constrained to rezone|null; category+amount+deadline kept together", () => {
  const out = sanitize("alerts", { watchType: "rezone", place: "79 Rivington", keywords: ["education"], minAmount: 200000, months: 3 });
  assert.deepEqual(Object.keys(out).sort(), ["keywords", "minAmount", "months", "place", "watchType"]);
  assert.equal(out.watchType, "rezone");
  assert.equal(out.place, "79 Rivington");
  // A rezone watch has no dollar amount or deadline, but sanitize() clamps per-field
  // independently — it doesn't know the fields are mutually exclusive by convention.
  assert.deepEqual(out.keywords, ["education"]);
  assert.equal(out.minAmount, 200000);
  assert.equal(out.months, 3);
  assert.equal(sanitize("alerts", { watchType: "bigaward" }).watchType, null, "old single-payload values no longer valid");
  assert.equal(sanitize("alerts", { watchType: "nope" }).watchType, null);
});

test("alerts: the combined-filter case (no watchType) keeps keywords + minAmount + months", () => {
  const out = sanitize("alerts", { keywords: ["Education", "Sanitation", "", "x", "y", "z"], minAmount: 200000, months: 3 });
  assert.equal(out.watchType, null);
  assert.deepEqual(out.keywords, ["education", "sanitation", "x", "y"]);
  assert.equal(out.minAmount, 200000);
  assert.equal(out.months, 3);
});

test("limits + lens registry are sane", () => {
  assert.ok(MAX_INPUT > 0 && MAX_INPUT <= 2000);
  assert.ok(MAX_CALLS_PER_DAY > 0 && MAX_CALLS_PER_DAY <= 1000);
  assert.ok(Object.keys(LENSES).length >= 7, "all lenses registered");
});
