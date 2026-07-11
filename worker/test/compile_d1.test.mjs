// Tests for worker/src/lib/compile_d1.mjs
// Verifies that compileSub descriptors translate correctly to buildNoticesQuery opts
// and that D1 rows are mapped to the SODA field names that subDigestHtml expects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { subToD1Opts, compileSub_d1, toDigestRow, OFF_MIRROR_LENSES } from "../src/lib/compile_d1.mjs";
import { buildNoticesQuery } from "../src/lib/notices.mjs";

// ---- OFF_MIRROR_LENSES -------------------------------------------------

test("land lens is always off-mirror (ZAP dataset, not D1)", () => {
  assert.ok(OFF_MIRROR_LENSES.has("land"));
  assert.equal(subToD1Opts({ lens: "land", filter: {} }, "2026-07-10"), null);
});

test("compileSub_d1 returns null for land", () => {
  assert.equal(compileSub_d1({ lens: "land", filter: { keywords: ["rezoning"] } }, "2026-07-10"), null);
});

// ---- money lens --------------------------------------------------------

test("money/minAmount → Award notice type, minAmount forwarded", () => {
  const opts = subToD1Opts({ lens: "money", filter: { minAmount: 500000 } }, "2026-07-10");
  assert.equal(opts.noticeType, "Award");
  assert.equal(opts.minAmount, 500000);
  assert.equal(opts.maxAmount, undefined);
});

test("money/maxAmount only → Award (any amount bound implies Award branch per EDA)", () => {
  const opts = subToD1Opts({ lens: "money", filter: { maxAmount: 1000000 } }, "2026-07-10");
  assert.equal(opts.noticeType, "Award");
  assert.equal(opts.maxAmount, 1000000);
});

test("money/no-amount → Solicitation (RFP), openOnly=true", () => {
  const opts = subToD1Opts({ lens: "money", filter: {} }, "2026-07-10");
  assert.equal(opts.noticeType, "Solicitation");
  assert.equal(opts.openOnly, true);
  assert.equal(opts.today, "2026-07-10");
});

test("money/keywords → termGroups included", () => {
  const opts = subToD1Opts({ lens: "money", filter: { keywords: ["hvac", "construction"] } }, "2026-07-10");
  assert.deepEqual(opts.termGroups, [["hvac", "construction"]]);
});

test("money/category → category opt forwarded", () => {
  const opts = subToD1Opts({ lens: "money", filter: { category: "Goods" } }, "2026-07-10");
  assert.equal(opts.category, "Goods");
});

test("money D1 opts produce valid SQL via buildNoticesQuery", () => {
  const opts = subToD1Opts({ lens: "money", filter: { minAmount: 100000 } }, "2026-07-10");
  const { sql } = buildNoticesQuery(opts);
  assert.match(sql, /contract_amount_valid = 1/);
  assert.match(sql, /type_of_notice = \?/);
  assert.match(sql, /contract_amount >= \?/);
});

// ---- entity lens -------------------------------------------------------

test("entity/agency → agency opt, no postFilter", () => {
  const res = compileSub_d1({ lens: "entity", filter: { kind: "agency", name: "Buildings" } }, "2026-07-10");
  assert.ok(res);
  assert.equal(res.opts.agency, "Buildings");
  assert.equal(res.postFilter, undefined);
});

test("entity/vendor → termGroups on stem, postFilter present", () => {
  const res = compileSub_d1({ lens: "entity", filter: { kind: "vendor", name: "Sinergia Inc" } }, "2026-07-10");
  assert.ok(res);
  // Stem is "SINERGIA" — the term group carries it
  assert.deepEqual(res.opts.termGroups, [["SINERGIA"]]);
  assert.equal(typeof res.postFilter, "function");
  assert.ok(res.postFilter({ vendor_name: "Sinergia Incorporated" }), "variant matches stem");
  assert.ok(!res.postFilter({ vendor_name: "Sinergy Partners LLC" }), "different stem rejected");
});

test("entity: empty name compiles to null", () => {
  assert.equal(compileSub_d1({ lens: "entity", filter: { kind: "vendor", name: "" } }, "2026-07-10"), null);
});

test("entity: two-char name compiles to null (stem too short)", () => {
  assert.equal(compileSub_d1({ lens: "entity", filter: { kind: "vendor", name: "AB" } }, "2026-07-10"), null);
});

// ---- section lenses ----------------------------------------------------

test("property → section=Property Disposition, sinceDate set", () => {
  const opts = subToD1Opts({ lens: "property", filter: {} }, "2026-07-10");
  assert.equal(opts.section, "Property Disposition");
  assert.ok(opts.sinceDate, "sinceDate should be set to ~30 days ago");
  assert.ok(opts.sinceDate < "2026-07-10", "sinceDate is in the past");
});

test("rules → section=Agency Rules, agency forwarded", () => {
  const opts = subToD1Opts({ lens: "rules", filter: { agency: "Buildings", keywords: ["scaffold"] } }, "2026-07-10");
  assert.equal(opts.section, "Agency Rules");
  assert.equal(opts.agency, "Buildings");
  assert.deepEqual(opts.termGroups, [["scaffold"]]);
});

test("meetings → section=Public Hearings and Meetings, openOnly=true", () => {
  const opts = subToD1Opts({ lens: "meetings", filter: {} }, "2026-07-10");
  assert.equal(opts.section, "Public Hearings and Meetings");
  assert.equal(opts.openOnly, true);
  assert.equal(opts.today, "2026-07-10");
});

test("unknown lens → null", () => {
  assert.equal(subToD1Opts({ lens: "nonsense", filter: {} }, "2026-07-10"), null);
});

// ---- toDigestRow field mapping -----------------------------------------

test("toDigestRow: D1 field names mapped to SODA-style names for rendering", () => {
  const d1Row = {
    request_id: "CR-2026-001",
    start_date: "2026-07-01",
    agency: "Buildings",
    short_title: "Emergency Repair",
    pin: "84624-PA-01",
    contract_amount: 500000,
    contract_amount_valid: 1,
    vendor_name: "ACME CORP",
    due_date: "2026-08-01 00:00:00",
    section: "Procurement",
    event_date: "2026-07-15 10:00:00",
    event_addr1: "100 Church St",
  };
  const row = toDigestRow(d1Row);
  assert.equal(row.agency_name, "Buildings");       // D1 "agency" → "agency_name"
  assert.equal(row.section_name, "Procurement");    // D1 "section" → "section_name"
  assert.equal(row.contract_amount, 500000);        // valid amount passes through
  assert.equal(row.contact_name, null);             // absent from D1 mirror
  assert.equal(row.contact_phone, null);
  assert.equal(row.email, null);
  assert.equal(row.street_address_1, "100 Church St");
});

test("toDigestRow: corrupt amount (valid=0) is nulled", () => {
  const row = toDigestRow({ contract_amount: 96000000000000, contract_amount_valid: 0 });
  assert.equal(row.contract_amount, null);
});

test("toDigestRow: absent fields become null, not undefined", () => {
  const row = toDigestRow({ request_id: "X1" });
  assert.strictEqual(row.agency_name, null);
  assert.strictEqual(row.due_date, null);
  assert.strictEqual(row.pin, null);
});

// ---- round-trip sanity: opts → SQL contains expected clauses -----------

test("entity/agency round-trip → SQL has agency LIKE clause", () => {
  const res = compileSub_d1({ lens: "entity", filter: { kind: "agency", name: "Sanitation" } }, "2026-07-10");
  const { sql, params } = buildNoticesQuery(res.opts);
  assert.match(sql, /lower\(agency\) LIKE \?/);
  assert.ok(params.includes("%sanitation%"));
});

test("money/Solicitation round-trip → SQL has due_date >= today (openOnly)", () => {
  const res = compileSub_d1({ lens: "money", filter: {} }, "2026-07-10");
  const { sql, params } = buildNoticesQuery(res.opts);
  assert.match(sql, /due_date >= \?/);
  assert.ok(params.includes("2026-07-10"));
});
