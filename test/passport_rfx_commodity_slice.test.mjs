// The committed PASSPort RFx commodity slice: the open-solicitation category join reads it when
// the live PASSPort dump refuses the build host, so a blocked hosted runner still publishes the
// categories PASSPort states instead of 191 "PASSPort data not readable" gaps.
// Run: node --test test/passport_rfx_commodity_slice.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PASSPORT_RFX_COMMODITY_SLICE_SCHEMA,
  buildPassportRfxCommoditySlice,
  renderPassportRfxCommoditySlice,
  rfxRowsFromCommoditySlice,
} from "../tools/lib/passport_rfx_commodity_slice.mjs";
import { readOpenNoticeCommodity } from "../tools/lib/open_notice_commodity_category.mjs";
import { buildMoneyOpenSolicitationsSnapshot } from "../tools/lib/batch_precompute_snapshots.mjs";

const NOW = new Date("2026-11-25T10:21:13.025Z");
const SLICE_OBSERVED = "2026-11-24T09:00:00.000Z";

// Rows as parseRfxDump returns them, trimmed to the fields the join reads plus noise it must drop.
const RFX_ROWS = [
  { epin: "85827Y1435", epin_norm: "85827Y1435", main_commodity: "IT Consulting", agency: "DOITT", rfx_status: "Released" },
  { epin: "06926P0012", epin_norm: "06926P0012", main_commodity: "IT Consulting", agency: "DCAS", rfx_status: "Released" },
  { epin: "80626B0099", epin_norm: "80626B0099", main_commodity: "", agency: "HPD", rfx_status: "Released" },
  { epin: "80626B0099", epin_norm: "80626B0099", main_commodity: "", agency: "HPD", rfx_status: "Released" },
];

function openRows() {
  return [
    { request_id: "20261100001", start_date: "2026-11-20T00:00:00.000", agency_name: "Information Technology", type_of_notice_description: "Solicitation", category_description: "Services (other than human services)", short_title: "Test engineer", pin: "85827Y1435", due_date: "2026-12-02T10:00:00.000", selection_method_description: "Request for Proposals" },
    { request_id: "20261100002", start_date: "2026-11-21T00:00:00.000", agency_name: "Citywide Administrative Services", type_of_notice_description: "Solicitation", category_description: "Services (other than human services)", short_title: "Consulting", pin: "06926P0012", due_date: "2026-12-03T10:00:00.000", selection_method_description: "Request for Proposals" },
    { request_id: "20261100003", start_date: "2026-11-21T00:00:00.000", agency_name: "Housing Preservation and Development", type_of_notice_description: "Solicitation", category_description: "Construction/Construction Services", short_title: "Boilers", pin: "80626B0099", due_date: "2026-12-04T10:00:00.000", selection_method_description: "Competitive Sealed Bids" },
    // Not in the slice, and published before the slice was taken: PASSPort had no such EPIN.
    { request_id: "20261100004", start_date: "2026-11-10T00:00:00.000", agency_name: "Parks and Recreation", type_of_notice_description: "Solicitation", category_description: "Goods", short_title: "Mowers", pin: "84626B0001", due_date: "2026-12-05T10:00:00.000", selection_method_description: "Competitive Sealed Bids" },
    // Not in the slice, and published after it was taken: PASSPort was not read for this notice.
    { request_id: "20261100005", start_date: "2026-11-25T00:00:00.000", agency_name: "Parks and Recreation", type_of_notice_description: "Solicitation", category_description: "Goods", short_title: "Trucks", pin: "84626B0002", due_date: "2026-12-06T10:00:00.000", selection_method_description: "Competitive Sealed Bids" },
  ];
}

function slice() {
  return buildPassportRfxCommoditySlice(RFX_ROWS, { observedAt: SLICE_OBSERVED });
}

function refusingFetch(status) {
  return async () => ({ ok: false, status, text: async () => "<html>Forbidden</html>" });
}

test("slice keeps one row per distinct EPIN and label, and round-trips to join rows", () => {
  const s = slice();
  assert.equal(s.schema, PASSPORT_RFX_COMMODITY_SLICE_SCHEMA);
  assert.equal(s.as_of, "2026-11-24");
  assert.equal(s.source_rows, 4);
  assert.equal(s.rows.length, 3);
  const rows = rfxRowsFromCommoditySlice(s);
  assert.deepEqual(rows.map((r) => [r.epin, r.main_commodity]), [
    ["06926P0012", "IT Consulting"],
    ["80626B0099", ""],
    ["85827Y1435", "IT Consulting"],
  ]);
  const rendered = renderPassportRfxCommoditySlice(s);
  assert.deepEqual(rfxRowsFromCommoditySlice(JSON.parse(rendered)), rows);
  assert.ok(rendered.split("\n").length < 40, "one line per row, not one per array element");
});

test("a malformed slice is refused rather than read as an empty PASSPort", () => {
  assert.throws(() => rfxRowsFromCommoditySlice({ schema: "other" }), /schema/);
  assert.throws(() => rfxRowsFromCommoditySlice({ ...slice(), rows: [["X", 99]] }), /label/);
  assert.throws(() => rfxRowsFromCommoditySlice({ ...slice(), rows: [] }), /no rows/);
});

test("a live read refreshes the slice", async () => {
  const commodity = await readOpenNoticeCommodity({
    now: NOW,
    fetchRows: async () => ({ rows: RFX_ROWS, observedAt: NOW.toISOString() }),
    loadSlice: async () => { throw new Error("must not read the slice when the live read works"); },
  });
  assert.equal(commodity.read.mode, "live");
  assert.equal(commodity.rfxRows.length, 4);
  assert.equal(commodity.slice.as_of, "2026-11-25");
});

test("a host PASSPort refuses (HTTP 403) reads the committed slice and still publishes categories", async () => {
  const commodity = await readOpenNoticeCommodity({ now: NOW, fetchImpl: refusingFetch(403), loadSlice: async () => slice() });
  assert.equal(commodity.read.mode, "committed_slice");
  assert.equal(commodity.read.live_failure, "rfx-http-403");
  assert.equal(commodity.slice, undefined, "a fallback read never rewrites the slice");

  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: openRows(), sourceCount: 5, commodity }, { now: NOW });
  const cov = snap.commodity_category_coverage;
  assert.equal(cov.state, "measured");
  assert.equal(cov.unavailable_reason, null);
  assert.deepEqual(cov.rfx_read, { mode: "committed_slice", observed_at: SLICE_OBSERVED, as_of: "2026-11-24", live_failure: "rfx-http-403" });
  assert.equal(cov.as_of, "2026-11-24", "categories are as of the PASSPort read, not the list day");
  const reasons = Object.fromEntries(snap.notices.map((n) => [n.request_id, n.coverage.category.reason]));
  assert.deepEqual(reasons, {
    20261100001: "joined_l3",
    20261100002: "joined_l3",
    20261100003: "joined_no_label",
    20261100004: "pin_not_joined",
    20261100005: "rfx_unavailable",
  });
  assert.equal(cov.available, 2);
  assert.equal(snap.notices[0].main_commodity_category.label, "IT Consulting");
  assert.equal(snap.notices[0].coverage.category.as_of, "2026-11-24");
});

test("with no usable slice a refused read is still reported as unavailable", async () => {
  const commodity = await readOpenNoticeCommodity({
    now: NOW,
    fetchImpl: refusingFetch(403),
    loadSlice: async () => { throw new Error("ENOENT"); },
  });
  assert.equal(commodity.unavailable, "rfx-http-403");
  const snap = buildMoneyOpenSolicitationsSnapshot({ rows: openRows(), sourceCount: 5, commodity }, { now: NOW });
  assert.equal(snap.commodity_category_coverage.state, "unavailable");
  assert.equal(snap.commodity_category_coverage.unavailable_reason, "rfx-http-403");
  assert.ok(snap.notices.every((n) => n.coverage.category.reason === "rfx_unavailable"));
});
