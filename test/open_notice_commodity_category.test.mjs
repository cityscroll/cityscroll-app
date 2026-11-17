// Commodity category on an open City Record notice, joined from PASSPort Public RFx.
// Run: node --test test/open_notice_commodity_category.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  OPEN_NOTICE_COMMODITY_COVERAGE_SCHEMA,
  OPEN_NOTICE_COMMODITY_SOURCE,
  attachOpenNoticeCommodityCategories,
} from "../tools/lib/open_notice_commodity_category.mjs";

const AS_OF = "2026-11-12";
const OBSERVED = "2026-11-12T03:26:38.728Z";

function notice(id, pin) {
  return {
    request_id: id,
    pin,
    agency_name: "Department of Example",
    short_title: "Example notice",
    category_description: "Goods",
  };
}

const RFX = [
  { epin: "EXACT10001", main_commodity: "IT Consulting", rfx_status: "Released" },
  { epin: "EXACT10001", main_commodity: "IT Consulting", rfx_status: "Planned" },
  { epin: "99990001", main_commodity: "Fleet Services", rfx_status: "Released" },
  { epin: "PREFIX100099", main_commodity: "Fleet Services", rfx_status: "Released" },
  { epin: "STEM12345678", main_commodity: "IT Consulting", rfx_status: "Released" },
  { epin: "AMBIG1001", main_commodity: "IT Consulting", rfx_status: "Released" },
  { epin: "AMBIG1001", main_commodity: "Fleet Services", rfx_status: "Released" },
  { epin: "UNMATCH01", main_commodity: "NOT A CITY CATEGORY", rfx_status: "Released" },
  { epin: "NOLABEL01", main_commodity: null, rfx_status: "Released" },
];

function attached(rows) {
  return attachOpenNoticeCommodityCategories(rows, { rfxRows: RFX, asOf: AS_OF, observedAt: OBSERVED });
}

function byId(result) {
  return new Map(result.notices.map((row) => [row.request_id, row]));
}

// The shape a matched L3 category must have for the existing RFx reader, plus the join.
function matchedCategoryIsComplete(category) {
  return Boolean(
    category
    && category.status === "matched"
    && category.level === 3
    && /^\d{3}$/.test(category.code)
    && typeof category.label === "string"
    && category.label.trim()
    && Array.isArray(category.parents)
    && category.parents.length === 2
    && /^\d$/.test(category.parents[0])
    && /^\d{2}$/.test(category.parents[1])
    && typeof category.catalog_version === "string"
    && category.catalog_version.trim(),
  );
}

test("a joined notice publishes the matched L3 category and the join method", () => {
  const result = attached([
    notice("exact", "EXACT10001"),
    notice("suffix", "99990001A001"),
    notice("pin-prefix", "PREFIX1000"),
    notice("epin-prefix", "STEM1234567899"),
  ]);
  const rows = byId(result);

  const exact = rows.get("exact");
  assert.equal(matchedCategoryIsComplete(exact.main_commodity_category), true);
  assert.equal(exact.main_commodity_category.label, "IT Consulting");
  assert.equal(exact.main_commodity_category.code, "351");
  assert.deepEqual(exact.main_commodity_category.parents, ["5", "38"]);
  assert.equal(exact.main_commodity_category.state, "available");
  assert.equal(exact.main_commodity_category.reason, "joined_l3");
  assert.deepEqual(exact.main_commodity_category.join, { method: "exact", epin: "EXACT10001" });
  assert.deepEqual(exact.coverage.category, {
    state: "available",
    reason: "joined_l3",
    source: OPEN_NOTICE_COMMODITY_SOURCE,
    as_of: AS_OF,
  });

  assert.equal(rows.get("suffix").main_commodity_category.label, "Fleet Services");
  assert.equal(rows.get("suffix").main_commodity_category.code, "052");
  assert.deepEqual(rows.get("suffix").main_commodity_category.parents, ["1", "08"]);
  assert.equal(rows.get("suffix").main_commodity_category.join.method, "pin_strip_suffix");

  assert.equal(rows.get("pin-prefix").main_commodity_category.join.method, "pin_prefix_of_epin");
  assert.equal(rows.get("pin-prefix").main_commodity_category.label, "Fleet Services");
  assert.equal(rows.get("epin-prefix").main_commodity_category.join.method, "epin_prefix_of_pin");
  assert.equal(rows.get("epin-prefix").main_commodity_category.label, "IT Consulting");

  assert.equal(result.coverage.state, "measured");
  assert.equal(result.coverage.available, 4);
  assert.equal(result.coverage.missing, 0);
  assert.equal(result.coverage.by_join_method.exact, 1);
  assert.equal(result.coverage.by_join_method.pin_strip_suffix, 1);
  assert.equal(result.coverage.by_join_method.pin_prefix_of_epin, 1);
  assert.equal(result.coverage.by_join_method.epin_prefix_of_pin, 1);
  assert.equal(result.coverage.catalog_version, exact.main_commodity_category.catalog_version);
});

test("notices the join cannot cover stay listed and name the gap", () => {
  const result = attached([
    notice("no-pin", ""),
    notice("blank-pin", "   "),
    notice("unjoined", "NO-SUCH-PIN"),
    notice("ambiguous", "AMBIG1001"),
    notice("unmatched", "UNMATCH01"),
    notice("no-label", "NOLABEL01"),
  ]);
  const rows = byId(result);
  const gap = (id, reason) => {
    const row = rows.get(id);
    assert.equal(row.main_commodity_category.state, "missing", id);
    assert.equal(row.main_commodity_category.reason, reason, id);
    assert.notEqual(row.main_commodity_category.status, "matched", id);
    assert.equal(row.coverage.category.state, "missing", id);
    assert.equal(row.coverage.category.reason, reason, id);
    assert.equal(row.short_title, "Example notice", id);
  };
  gap("no-pin", "no_pin");
  gap("blank-pin", "no_pin");
  gap("unjoined", "pin_not_joined");
  gap("ambiguous", "ambiguous_epin");
  gap("unmatched", "joined_unmatched");
  gap("no-label", "joined_no_label");

  assert.equal(rows.get("no-pin").main_commodity_category.status, "not_published");
  assert.equal(rows.get("unjoined").main_commodity_category.join, undefined);
  assert.deepEqual(rows.get("ambiguous").main_commodity_category.candidate_labels, ["IT Consulting", "Fleet Services"]);
  assert.equal(rows.get("unmatched").main_commodity_category.status, "unmatched");
  assert.equal(rows.get("unmatched").main_commodity_category.raw_label, "NOT A CITY CATEGORY");
  assert.equal(rows.get("no-label").main_commodity_category.status, "no_label");

  assert.equal(result.coverage.available, 0);
  assert.equal(result.coverage.missing, 6);
  assert.equal(result.coverage.open_notices, 6);
  assert.deepEqual(
    [result.coverage.by_reason.no_pin, result.coverage.by_reason.pin_not_joined, result.coverage.by_reason.ambiguous_epin, result.coverage.by_reason.joined_unmatched, result.coverage.by_reason.joined_no_label],
    [2, 1, 1, 1, 1],
  );
});

test("a failed or empty RFx read is unavailable, not a measured zero", () => {
  const notices = [notice("one", "EXACT10001"), notice("two", "")];
  const failed = attachOpenNoticeCommodityCategories(notices, {
    unavailableReason: "rfx-http-503",
    asOf: AS_OF,
    observedAt: OBSERVED,
  });
  assert.equal(failed.coverage.state, "unavailable");
  assert.equal(failed.coverage.unavailable_reason, "rfx-http-503");
  assert.equal(failed.coverage.available, 0);
  assert.equal(failed.coverage.missing, 2);
  assert.equal(failed.notices[0].main_commodity_category.reason, "rfx_unavailable");
  assert.equal(failed.notices[0].coverage.category.state, "missing");

  const empty = attachOpenNoticeCommodityCategories(notices, { rfxRows: [], asOf: AS_OF, observedAt: OBSERVED });
  assert.equal(empty.coverage.state, "unavailable");
  assert.equal(empty.coverage.unavailable_reason, "rfx_empty");
  assert.equal(empty.notices.every((row) => row.main_commodity_category.reason === "rfx_empty"), true);
});

test("coverage names the cohort: how many, the rule, and the source", () => {
  const result = attached([notice("exact", "EXACT10001"), notice("unjoined", "NO-SUCH-PIN")]);
  assert.equal(result.coverage.schema, OPEN_NOTICE_COMMODITY_COVERAGE_SCHEMA);
  assert.equal(result.coverage.source, OPEN_NOTICE_COMMODITY_SOURCE);
  assert.equal(result.coverage.source_url, "https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js");
  assert.match(result.coverage.join_rule, /Nothing is guessed/);
  assert.equal(result.coverage.as_of, AS_OF);
  assert.equal(result.coverage.observed_at, OBSERVED);
  assert.deepEqual(
    [result.coverage.open_notices, result.coverage.available, result.coverage.missing],
    [2, 1, 1],
  );
  assert.equal(result.coverage.rfx_rows, RFX.length);
});

test("the publisher does not name an internal product", () => {
  const source = readFileSync(new URL("../tools/lib/open_notice_commodity_category.mjs", import.meta.url), "utf8");
  assert.equal(/waypoint|cityscroll-product/i.test(source), false);
});
