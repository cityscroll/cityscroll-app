// PASSPort Public RFx main_commodity -> NYC L3 commodity category on the published RFx read.
//
// Real rows: test/fixtures/passport/rfx_commodity_sample.js is 20 verbatim lines of the public
// rfxData.js fetched 2026-11-12T12:27:55Z (sha256 9b7558ce..., 12,585 parsed rows in all),
// including one row the engine parser cannot read (raw tab in the title).
//
//   node --test test/passport_rfx_commodity_category.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mapRfxRow, parseRfxDump } from "../worker/src/lib/passport_parse.mjs";
import { enrichLifecycleWithPassport } from "../worker/src/lib/passport_lifecycle.mjs";
import { assembleLifecycle } from "../worker/src/lib/checkbook_lifecycle.mjs";
import {
  passportCommodityCategoryIndex,
  passportRfxCommodityCategory,
  passportRfxCommodityCoverage,
} from "../worker/src/lib/passport_commodity_category.mjs";
import {
  RECEIPT_SCHEMA,
  checkReceipt,
  measurePassportRfxCommodityCategories,
} from "../tools/measure_passport_rfx_commodity_categories.mjs";

const SAMPLE = readFileSync(new URL("./fixtures/passport/rfx_commodity_sample.js", import.meta.url), "utf8");
const RECEIPT_PATH = new URL(
  "../site/data/passport_sources/verification_receipts/passport_rfx_commodity_categories_2026-11-12.json",
  import.meta.url,
);
const cases = JSON.parse(readFileSync(new URL("./fixtures/passport/join_cases.json", import.meta.url), "utf8"));

test("real rows resolve by exact L3 label; the canary row gets IT Consulting (351)", () => {
  const rows = parseRfxDump(SAMPLE);
  assert.equal(rows.length, 19, "20 sample lines, one unreadable by the engine parser");
  const canary = rows.find((row) => row.rfp_id === "39448");
  assert.equal(canary.rfx_status, "Planned");
  assert.deepEqual(passportRfxCommodityCategory(canary), {
    status: "matched", code: "351", label: "IT Consulting", level: 3, parents: ["5", "38"],
    catalog_version: passportCommodityCategoryIndex().version,
  });
  // Publisher trailing space: matched after normalization, not a near-miss.
  const interpreter = rows.find((row) => row.rfp_id === "39440");
  assert.equal(passportRfxCommodityCategory(interpreter).label, "Interpreter and Translation Services");
});

test("failure: a label that matches nothing stays unmatched with its raw text", () => {
  const rows = parseRfxDump(SAMPLE);
  const legacy = rows.filter((row) => passportRfxCommodityCategory(row).status === "unmatched");
  assert.equal(legacy.length, 8);
  for (const row of legacy) {
    const result = passportRfxCommodityCategory(row);
    assert.deepEqual(Object.keys(result).sort(), ["raw_label", "status"]);
    assert.equal(result.raw_label, row.main_commodity);
  }
  assert.deepEqual(
    legacy.map((row) => row.main_commodity).sort(),
    [
      "Architectural Consulting", "CONSULTING SERVICES", "Certified Public Accountant (CPA) Services",
      "Educational Services, Alternative", "Natural Disasters (Fire, Flood, Wind, Quakes) Consulting",
      "PROJECT MANAGEMENT SERVICES", "Professional Services (Not Otherwise Classified)", "Translation Services",
    ],
  );
});

test("coverage counts matched, unmatched and total overall and by RFx status", () => {
  const coverage = passportRfxCommodityCoverage(parseRfxDump(SAMPLE));
  assert.equal(coverage.state, "measured");
  assert.deepEqual(
    { total: coverage.total, matched: coverage.matched, unmatched: coverage.unmatched, no_label: coverage.no_label },
    { total: 19, matched: 11, unmatched: 8, no_label: 0 },
  );
  assert.deepEqual(coverage.by_status.Planned, { total: 4, matched: 3, unmatched: 1, no_label: 0 });
  assert.deepEqual(coverage.by_status.Released, { total: 2, matched: 2, unmatched: 0, no_label: 0 });
  assert.equal(coverage.unmatched_labels.reduce((sum, row) => sum + row.rows, 0), 8);
});

test("failure: a feed without the Main Commodity field yields no category, never a shifted one", () => {
  const eleven = '["1","2","P","I","81026B0003","Name","A","Released","1/1/2026","2/1/2026","Competitive Sealed Bid"]';
  const row = mapRfxRow(JSON.parse(eleven));
  assert.equal(row.main_commodity, null, "an 11-column row must not read procurement method as commodity");
  assert.deepEqual(passportRfxCommodityCategory(row), { status: "no_label" });
  const coverage = passportRfxCommodityCoverage(parseRfxDump(`var public_rfx_data = [\n${eleven},\n${eleven}\n];`));
  assert.equal(coverage.state, "field_absent");
  assert.deepEqual([coverage.total, coverage.matched, coverage.unmatched, coverage.no_label], [2, 0, 0, 2]);
  const blank = parseRfxDump('var public_rfx_data = [\n["1","2","P","I","81026B0003","Name","A","Released","1/1/2026","2/1/2026","","Bid"]\n];');
  assert.equal(passportRfxCommodityCoverage(blank).state, "field_absent");
  assert.equal(passportRfxCommodityCoverage([]).state, "no_rows");
});

test("the published RFx read (contract lifecycle) carries the resolved category", () => {
  const { notice, passport_rfx } = cases.joined_solicitation;
  const base = assembleLifecycle(notice, [], [], [], {
    pinStrategy: "exact",
    lookupStatus: { pending: "ok", registered: "ok", spending: "ok" },
  });
  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [], rfx: [passport_rfx], lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  const category = enriched.rfx_detail.detail.main_commodity_category;
  assert.equal(enriched.rfx_detail.detail.main_commodity, "Historical Preservation Services");
  assert.equal(category.status, "matched");
  assert.equal(category.label, "Historical Preservation Services");
  assert.match(category.code, /^\d{3}$/);
  const sol = enriched.timeline.find((entry) => entry.stage === "solicitation");
  assert.deepEqual(sol.rfx.detail.main_commodity_category, category);
  assert.deepEqual(sol.detail.rfx.main_commodity_category, category);

  const legacy = { ...passport_rfx, main_commodity: "CONSULTING SERVICES" };
  const unmatched = enrichLifecycleWithPassport(base, notice, {
    contracts: [], rfx: [legacy], lookupStatus: { contracts: "ok", rfx: "ok" },
  });
  assert.deepEqual(unmatched.rfx_detail.detail.main_commodity_category, {
    status: "unmatched", raw_label: "CONSULTING SERVICES",
  });
});

test("the committed coverage receipt is consistent and bound to the categories artifact", () => {
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.deepEqual(checkReceipt(receipt), []);
  assert.equal(receipt.source_sha256, "9b7558ce92269c7106f04bca8cfe87b46fecf6ad26089e9921d3085d7e9e2e2d");
  assert.deepEqual(
    [receipt.dump_row_lines, receipt.rows_parsed, receipt.coverage.matched, receipt.coverage.unmatched],
    [12609, 12585, 12533, 52],
  );
  assert.deepEqual(receipt.coverage.by_status.Released, { total: 252, matched: 252, unmatched: 0, no_label: 0 });
  assert.deepEqual(receipt.coverage.by_status.Planned, { total: 845, matched: 844, unmatched: 1, no_label: 0 });
  const tampered = structuredClone(receipt);
  tampered.coverage.matched += 1;
  assert.ok(checkReceipt(tampered).length > 0);
});

test("the measurement tool reproduces sample coverage and refuses a missing clock", () => {
  const receipt = measurePassportRfxCommodityCategories(SAMPLE, { fetchedAt: "2026-11-12T12:27:55Z" });
  assert.deepEqual([receipt.dump_row_lines, receipt.rows_parsed, receipt.coverage.matched], [20, 19, 11]);
  assert.deepEqual(checkReceipt(receipt), []);
  assert.throws(() => measurePassportRfxCommodityCategories(SAMPLE, {}), /fetched-at/);
});
