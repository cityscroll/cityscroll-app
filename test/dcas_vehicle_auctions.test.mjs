import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DCAS_VEHICLE_AUCTION_MAX_ROWS,
  buildDcasVehicleAuctionSnapshot,
  dcasVehicleAuctionFreshness,
  detectDcasVehicleAuctionSnapshot,
  normalizeDcasVehicleAuction,
  selectDcasVehicleAuctionSurface,
} from "../site/dcas_vehicle_auctions.mjs";
import { dcasVehicleAuctionQuery } from "../warehouse/scripts/dcas_vehicle_auctions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROWS = JSON.parse(readFileSync(join(ROOT, "test/fixtures/dcas_vehicle_auctions/rows.json"), "utf8"));

test("DCAS fleet rows are goods-surplus and never parcel-shaped", () => {
  const snapshot = buildDcasVehicleAuctionSnapshot(ROWS, {
    asOf: "2026-08-04",
    observedAt: "2026-08-04T12:00:00Z",
    sourceUpdatedAt: "2026-08-01T12:00:00Z",
    sourceTotal: 12316,
    limit: 500,
  });
  assert.equal(snapshot.taxonomy.domain, "goods_surplus");
  assert.equal(snapshot.taxonomy.real_property, false);
  assert.equal(snapshot.taxonomy.include_in_parcel_chains, false);
  assert.equal(snapshot.taxonomy.include_in_map_counts, false);
  assert.equal(snapshot.taxonomy.include_in_parcel_exports, false);
  assert.ok(snapshot.batches.every((batch) => batch.vehicles.every((row) => (
    row.basis === "goods_surplus" && row.real_property === false && !("bbl" in row)
  ))));
  assert.deepEqual(detectDcasVehicleAuctionSnapshot(snapshot), { ok: true, findings: [] });
});

test("surface shows open batches, then only the latest closed batch", () => {
  const snapshot = buildDcasVehicleAuctionSnapshot(ROWS, { asOf: "2026-08-04", limit: 500 });
  const open = selectDcasVehicleAuctionSurface(snapshot, { today: "2026-08-04" });
  assert.equal(open.status, "open");
  assert.equal(open.count, 2);
  assert.deepEqual(open.batches.map((batch) => batch.close_date), ["2026-08-12"]);

  const closed = selectDcasVehicleAuctionSurface(snapshot, { today: "2026-09-01" });
  assert.equal(closed.status, "closed");
  assert.equal(closed.latest_close_date, "2026-08-12");
  assert.equal(closed.batches.length, 1);
});

test("fleet rows expose timed auction ends and preserve optional marketplace facts", () => {
  const row = normalizeDcasVehicleAuction({
    auction_close_date: "2026-08-12T00:00:00.000",
    year: "2020",
    make: "Ford",
    model: "Transit",
    vin: "TESTVIN",
    description: "Cargo van",
    lot_url: "https://www.govdeals.com/lot/123",
    current_bid: "$1,250",
    starting_price: "500",
  });
  assert.equal(row.description, "Cargo van");
  assert.equal(row.lot_url, "https://www.govdeals.com/lot/123");
  assert.equal(row.current_bid, 1250);
  assert.equal(row.starting_price, 500);
  assert.deepEqual(row.timed_events, [{
    kind: "auction_end",
    date: "2026-08-12",
    start: "2026-08-12",
    end: "2026-08-12",
    source: "dcas_vehicle_auction",
  }]);
});

test("fleet freshness distinguishes a weekly snapshot from a stale one", () => {
  const snapshot = buildDcasVehicleAuctionSnapshot(ROWS, {
    asOf: "2026-08-04",
    observedAt: "2026-08-04T12:00:00Z",
    sourceUpdatedAt: "2026-08-01T12:00:00Z",
  });
  assert.equal(dcasVehicleAuctionFreshness(snapshot, { today: "2026-08-05" }).status, "fresh");
  assert.equal(dcasVehicleAuctionFreshness(snapshot, { today: "2026-08-12" }).status, "stale");
  assert.equal(dcasVehicleAuctionFreshness(snapshot, { today: "2026-08-12" }).age_days, 11);
});

test("collector query is date-bounded and hard-capped", () => {
  const query = dcasVehicleAuctionQuery({ asOf: "2026-08-04", windowDays: 90, limit: 500 });
  assert.equal(query.window_start, "2026-05-06");
  assert.match(query.where, /auction_close_date >= '2026-05-06/);
  assert.equal(query.limit, DCAS_VEHICLE_AUCTION_MAX_ROWS);
  assert.match(query.select, /auction_close_date,year,make,model,vin/);
});

test("committed snapshot and receipt preserve the terms gate", () => {
  const snapshot = JSON.parse(readFileSync(join(ROOT, "site/data/dcas_vehicle_auctions.json"), "utf8"));
  const receipt = JSON.parse(readFileSync(
    join(ROOT, "site/data/property_sources/verification_receipts/dcas_surplus_frontier_2026-08-04.json"),
    "utf8",
  ));
  assert.equal(detectDcasVehicleAuctionSnapshot(snapshot).ok, true);
  assert.equal(snapshot.source.provenance_notice_id, "20251106024");
  assert.match(snapshot.source.provenance_notice_url, /RequestDetail\/20251106024$/);
  assert.equal(receipt.taxonomy.domain, "goods_surplus");
  assert.match(receipt.govdeals_gate.short_excerpt, /spiders, crawlers, robots/);
  assert.equal(receipt.govdeals_gate.public_api, "not_public");
  assert.equal(receipt.nonfleet_general_goods.status, "wishlist_partnership_blocked");
});

test("Property mounts the official inventory without merging it into propAll", () => {
  const property = readFileSync(join(ROOT, "site/app/property.mjs"), "utf8");
  const html = readFileSync(join(ROOT, "site/index.html"), "utf8");
  assert.match(html, /id="dcas-fleet-inventory"/);
  assert.match(property, /data\/dcas_vehicle_auctions\.json/);
  assert.match(property, /selectDcasVehicleAuctionSurface/);
  assert.match(property, /renderDcasFleetInventory/);
  assert.match(property, /dcasVehicleAuctionFreshness/);
  assert.match(property, /provenance_notice_url/);
  assert.match(property, /latest_close_date,\{dateOnly:true\}/);
  assert.match(property, /batch\.close_date,\{dateOnly:true\}/);
  assert.doesNotMatch(property, /propAll\.push\([^\n]*dcas/i);
});
