// WH-05: warehouse materialization is consulted before live SODA for ZAP Open Data.
//
//   node --test worker/test/zap_warehouse_lookup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupZapFromWarehouseMaterialization,
  warehouseZapMaterializationMeta,
  getZapWarehouseIndex,
  resetZapWarehouseIndexCache,
} from "../src/lib/zap_warehouse_lookup.mjs";
import { fetchOpenDataRow } from "../src/zap_outcomes.mjs";

test("committed materialization includes ZAP demo project", () => {
  const meta = warehouseZapMaterializationMeta();
  assert.equal(meta.schema_version, 1);
  assert.equal(meta.phase, "WH-05");
  assert.ok(meta.row_count >= 2);
  const index = getZapWarehouseIndex();
  assert.ok(index.byProjectId.has("2022M0258"));
});

test("warehouse materialization hits without network", () => {
  const hit = lookupZapFromWarehouseMaterialization("2022M0258");
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.join_key, "project_id");
  assert.equal(hit.row.project_id, "2022M0258");
  assert.ok(hit.row.project_name);
  assert.ok(hit.row.ulurp_numbers);
});

test("warehouse materialization miss leaves room for SODA fallback", () => {
  const miss = lookupZapFromWarehouseMaterialization("1999Z0000");
  assert.equal(miss.hit, false);
  assert.equal(miss.row, null);
});

test("fetchOpenDataRow uses warehouse path for materialization hits", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("SODA should not be called on warehouse hit");
  };
  try {
    const row = await fetchOpenDataRow("2022M0258");
    assert.equal(row.lookup_path, "warehouse");
    assert.equal(row.project_id, "2022M0258");
    assert.ok(row.project_name);
    assert.equal(calls.length, 0, "no network on warehouse hit");
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchOpenDataRow falls back to live SODA on materialization miss", async () => {
  const orig = globalThis.fetch;
  let sawZap = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("hgx4-8ukb")) {
      sawZap = true;
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            project_id: "1999Z0000",
            project_name: "SODA Fallback Project",
            primary_applicant: "EDC - Economic Development Corporation for NYC",
            public_status: "Active",
            project_status: "Active",
            borough: "Queens",
            ulurp_numbers: "C990001ZMQ",
            actions: "ZM",
            current_milestone: "Review",
            current_milestone_date: "1999-01-01T00:00:00.000",
          },
        ],
        text: async () => "[]",
      };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
  };
  try {
    const row = await fetchOpenDataRow("1999Z0000");
    assert.equal(row.lookup_path, "soda");
    assert.equal(sawZap, true);
    assert.equal(row.project_name, "SODA Fallback Project");
    assert.equal(row.primary_applicant, "EDC - Economic Development Corporation for NYC");
  } finally {
    globalThis.fetch = orig;
  }
});

test("custom materialization doc overrides committed index (tests)", () => {
  resetZapWarehouseIndexCache();
  const hit = lookupZapFromWarehouseMaterialization("CUSTOMZ1", {
    rows: [
      {
        project_id: "CUSTOMZ1",
        project_name: "Custom ZAP",
        public_status: "Active",
        project_status: "Active",
        borough: "Bronx",
      },
    ],
  });
  assert.equal(hit.hit, true);
  assert.equal(hit.row.project_name, "Custom ZAP");
  resetZapWarehouseIndexCache();
});
