// WH-07: warehouse PIN-chain materialization is consulted before live SODA
// for City Record related-notice recovery on /contract-lifecycle.
//
//   node --test worker/test/city_record_pin_chain_warehouse_lookup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupPinChainFromWarehouseMaterialization,
  warehousePinChainMaterializationMeta,
  getCityRecordPinChainWarehouseIndex,
  resetCityRecordPinChainWarehouseIndexCache,
} from "../src/lib/city_record_pin_chain_warehouse_lookup.mjs";
import { fetchRelatedProcurementNotices } from "../src/checkbook_lifecycle.mjs";

test("committed materialization includes PIN-chain field-case demos", () => {
  const meta = warehousePinChainMaterializationMeta();
  assert.equal(meta.schema_version, 1);
  assert.ok(meta.row_count >= 3);
  assert.ok(meta.pin_count >= 1);
  const index = getCityRecordPinChainWarehouseIndex();
  assert.ok(index.byPin.has("07219P0148001R004"));
  assert.ok(index.byPin.has("81626W0043001"));
});

test("warehouse materialization hits without network", () => {
  const hit = lookupPinChainFromWarehouseMaterialization("81626W0043001");
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.join_key, "pin");
  assert.ok(hit.rows.some((r) => r.type_of_notice_description === "Solicitation"));
  assert.ok(hit.rows.some((r) => r.type_of_notice_description === "Award"));
  assert.equal(
    hit.rows.find((r) => r.type_of_notice_description === "Award")?.vendor_name,
    "Make it Zesty LLC",
  );
});

test("warehouse materialization miss leaves room for D1/SODA fallback", () => {
  const miss = lookupPinChainFromWarehouseMaterialization("NOT-A-REAL-PIN-ZZZ");
  assert.equal(miss.hit, false);
  assert.equal(miss.rows.length, 0);
});

test("fetchRelatedProcurementNotices uses warehouse path with zero SODA on hit", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("SODA should not be called on warehouse PIN-chain hit");
  };
  try {
    const rows = await fetchRelatedProcurementNotices(
      {},
      {
        request_id: "20260723031",
        pin: "81626W0043001",
        agency_name: "Health and Mental Hygiene",
        type_of_notice_description: "Award",
        short_title: "Catering Services",
      },
    );
    assert.ok(rows.length >= 1, "expected solicitation sibling from warehouse");
    assert.ok(
      rows.some((r) => r.type_of_notice_description === "Solicitation"),
      "warehouse hit should recover the solicitation sibling",
    );
    assert.equal(calls.length, 0, "no network on warehouse PIN-chain hit");
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchRelatedProcurementNotices falls back to live SODA on materialization miss", async () => {
  const orig = globalThis.fetch;
  let sawCityRecord = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("dg92-zbpx")) {
      sawCityRecord = true;
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            request_id: "19990101001",
            start_date: "1999-01-01T00:00:00.000",
            agency_name: "Test Agency",
            type_of_notice_description: "Solicitation",
            short_title: "SODA fallback solicitation",
            pin: "FALLBACKPIN001",
            contract_amount: null,
            vendor_name: null,
          },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    const rows = await fetchRelatedProcurementNotices(
      {},
      {
        request_id: "19990101999",
        pin: "FALLBACKPIN001",
        agency_name: "Test Agency",
        type_of_notice_description: "Award",
        short_title: "SODA fallback award",
      },
    );
    assert.equal(sawCityRecord, true);
    assert.equal(rows[0]?.type_of_notice_description, "Solicitation");
  } finally {
    globalThis.fetch = orig;
  }
});

test("custom materialization doc overrides committed index (tests)", () => {
  resetCityRecordPinChainWarehouseIndexCache();
  const hit = lookupPinChainFromWarehouseMaterialization("CUSTOM-PIN-0001", {
    rows: [
      {
        request_id: "CUSTOM1",
        pin: "CUSTOM-PIN-0001",
        contract_amount: "9",
        vendor_name: "Custom",
        start_date: "2020-01-01",
        agency_name: "A",
        type_of_notice_description: "Solicitation",
        short_title: "T",
      },
    ],
  });
  assert.equal(hit.hit, true);
  assert.equal(hit.rows[0].vendor_name, "Custom");
  resetCityRecordPinChainWarehouseIndexCache();
});
