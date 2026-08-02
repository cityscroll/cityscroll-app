// WH-03: warehouse materialization is consulted before live SODA for OCP awards.
//
//   node --test worker/test/ocp_warehouse_lookup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupOcpFromWarehouseMaterialization,
  warehouseMaterializationMeta,
  getOcpWarehouseIndex,
  resetOcpWarehouseIndexCache,
} from "../src/lib/ocp_warehouse_lookup.mjs";
import { fetchOcpAwardRows } from "../src/checkbook_lifecycle.mjs";

test("committed materialization includes OCP field-case demos", () => {
  const meta = warehouseMaterializationMeta();
  assert.equal(meta.schema_version, 1);
  assert.ok(meta.row_count >= 3);
  const index = getOcpWarehouseIndex();
  assert.ok(index.byRequestId.has("20260723031"));
});

test("warehouse materialization hits without network", () => {
  const hit = lookupOcpFromWarehouseMaterialization({
    request_id: "20260723031",
  });
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.join_key, "request_id");
  assert.equal(hit.rows[0].vendor_name, "Make it Zesty LLC");
  assert.equal(hit.rows[0].contract_amount, "250000");
});

test("warehouse materialization miss leaves room for SODA fallback", () => {
  const miss = lookupOcpFromWarehouseMaterialization({
    request_id: "19990101000",
    pin: "NOT-A-REAL-PIN",
  });
  assert.equal(miss.hit, false);
  assert.equal(miss.rows.length, 0);
});

test("fetchOcpAwardRows uses warehouse path for materialization hits", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("SODA should not be called on warehouse hit");
  };
  try {
    const r = await fetchOcpAwardRows({ request_id: "20260723031" });
    assert.equal(r.ok, true);
    assert.equal(r.lookup_path, "warehouse");
    assert.equal(r.rows[0].vendor_name, "Make it Zesty LLC");
    assert.equal(calls.length, 0, "no network on warehouse hit");
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchOcpAwardRows falls back to live SODA on materialization miss", async () => {
  const orig = globalThis.fetch;
  let sawOcp = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("qyyg-4tf5")) {
      sawOcp = true;
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            request_id: "19990101000",
            start_date: "1999-01-01T00:00:00.000",
            agency_name: "Test Agency",
            type_of_notice_description: "Award",
            short_title: "SODA fallback row",
            pin: "FALLBACK-PIN",
            contract_amount: "42",
            vendor_name: "SODA Vendor",
          },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    const r = await fetchOcpAwardRows({ request_id: "19990101000" });
    assert.equal(r.ok, true);
    assert.equal(r.lookup_path, "soda");
    assert.equal(sawOcp, true);
    assert.equal(r.rows[0].vendor_name, "SODA Vendor");
  } finally {
    globalThis.fetch = orig;
  }
});

test("custom materialization doc overrides committed index (tests)", () => {
  resetOcpWarehouseIndexCache();
  const hit = lookupOcpFromWarehouseMaterialization(
    { request_id: "CUSTOM1" },
    {
      rows: [
        {
          request_id: "CUSTOM1",
          pin: "P1",
          contract_amount: "9",
          vendor_name: "Custom",
          start_date: "2020-01-01",
          agency_name: "A",
          type_of_notice_description: "Award",
          short_title: "T",
        },
      ],
    }
  );
  assert.equal(hit.hit, true);
  assert.equal(hit.rows[0].vendor_name, "Custom");
  resetOcpWarehouseIndexCache();
});
