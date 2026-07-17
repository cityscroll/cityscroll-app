// Pure unit tests for the lens-aware /nl sanitizer. No network, no API key — `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, LENSES, MAX_INPUT, MAX_CALLS_PER_DAY, encodeWatchFilter } from "../src/lib/filter.mjs";

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
  // money's field list is the general procurement-notice filter schema (see AGENTS.md's
  // "Alerts NL query" section for the inventory) — additive, so this list only ever grows.
  assert.deepEqual(Object.keys(sanitize("bogus", {})).sort(),
    ["agency", "category", "excludeSpecial", "keywords", "maxAmount", "minAmount", "months", "noticeType"]);
});

test("money: noticeType constrained to award|solicitation|null", () => {
  assert.equal(sanitize("money", { noticeType: "award" }).noticeType, "award");
  assert.equal(sanitize("money", { noticeType: "solicitation" }).noticeType, "solicitation");
  assert.equal(sanitize("money", { noticeType: "bigaward" }).noticeType, null, "old single-payload values no longer valid");
  assert.equal(sanitize("money", {}).noticeType, null);
});

test("alerts: reuses money's full general schema, plus watchType/place for rezone watches", () => {
  const out = sanitize("alerts", {
    watchType: "rezone", place: "79 Rivington",
    keywords: ["education"], agency: "Education", minAmount: 200000, maxAmount: 900000,
    category: "Goods", months: 3, noticeType: "award", excludeSpecial: true,
  });
  assert.deepEqual(Object.keys(out).sort(),
    ["agency", "category", "excludeSpecial", "keywords", "maxAmount", "minAmount", "months", "noticeType", "place", "watchType"]);
  assert.equal(out.watchType, "rezone");
  assert.equal(out.place, "79 Rivington");
  // A rezone watch has no dollar amount, agency, or deadline, but sanitize() clamps each
  // field independently — it doesn't know the fields are mutually exclusive by convention.
  assert.deepEqual(out.keywords, ["education"]);
  assert.equal(out.agency, "Education");
  assert.equal(out.minAmount, 200000);
  assert.equal(out.maxAmount, 900000);
  assert.equal(out.category, "Goods");
  assert.equal(out.months, 3);
  assert.equal(out.noticeType, "award");
  assert.equal(out.excludeSpecial, true);
  assert.equal(sanitize("alerts", { watchType: "bigaward" }).watchType, null, "old single-payload values no longer valid");
  assert.equal(sanitize("alerts", { watchType: "nope" }).watchType, null);
});

test("alerts: the general case (no watchType) keeps ANY combination of the general schema's fields", () => {
  const out = sanitize("alerts", {
    keywords: ["Education", "Sanitation", "", "x", "y", "z"], agency: "Parks and Recreation",
    minAmount: 200000, months: 3, noticeType: "award",
  });
  assert.equal(out.watchType, null);
  assert.deepEqual(out.keywords, ["education", "sanitation", "x", "y"]);
  assert.equal(out.agency, "Parks and Recreation");
  assert.equal(out.minAmount, 200000);
  assert.equal(out.months, 3);
  assert.equal(out.noticeType, "award");
});

test("limits + lens registry are sane", () => {
  assert.ok(MAX_INPUT > 0 && MAX_INPUT <= 2000);
  assert.ok(MAX_CALLS_PER_DAY > 0 && MAX_CALLS_PER_DAY <= 1000);
  assert.ok(Object.keys(LENSES).length >= 7, "all lenses registered");
});

// w12-12: digest deep-links. Before, a digest item's link carried nothing about the watch
// that surfaced it — a click landed on the plain notice view with no sign of why it matched.
// encodeWatchFilter() is what a notice link's ?w= param is built from.
test("encodeWatchFilter: the education watch (keyword-only) round-trips through sanitize()", () => {
  const w = encodeWatchFilter("money", { keywords: ["education"] });
  assert.equal(w, encodeURIComponent(JSON.stringify({ lens: "money", filter: { keywords: ["education"] } })));
  assert.deepEqual(JSON.parse(decodeURIComponent(w)), { lens: "money", filter: { keywords: ["education"] } });
});

test("encodeWatchFilter: a multi-filter watch carries every non-empty field, dropping null/false/empty ones", () => {
  const w = encodeWatchFilter("money", {
    keywords: ["education"], agency: "Education", minAmount: 200000, maxAmount: null,
    category: null, months: 3, noticeType: "award", excludeSpecial: false,
  });
  const decoded = JSON.parse(decodeURIComponent(w));
  assert.deepEqual(decoded, {
    lens: "money",
    filter: { keywords: ["education"], agency: "Education", minAmount: 200000, months: 3, noticeType: "award" },
  });
});

test("encodeWatchFilter: an amount-only bigaward watch still round-trips (minAmount alone is signal)", () => {
  const w = encodeWatchFilter("money", { minAmount: 1000000 });
  assert.deepEqual(JSON.parse(decodeURIComponent(w)), { lens: "money", filter: { minAmount: 1000000 } });
});

test("encodeWatchFilter: nothing worth carrying (empty filter, or an unregistered lens) -> null", () => {
  assert.equal(encodeWatchFilter("money", {}), null);
  assert.equal(encodeWatchFilter("money", { keywords: [], agency: null }), null);
  assert.equal(encodeWatchFilter("bogus-lens", { keywords: ["x"] }), null);
  assert.equal(encodeWatchFilter(null, { keywords: ["x"] }), null);
});

test("encodeWatchFilter: an unsanitary/malicious filter is clamped through sanitize() first, same as any /nl output", () => {
  const w = encodeWatchFilter("money", { keywords: ["education"], minAmount: "'; DROP TABLE notices; --", agency: { toString: () => "nope" } });
  assert.deepEqual(JSON.parse(decodeURIComponent(w)), { lens: "money", filter: { keywords: ["education"] } });
});
