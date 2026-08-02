// WH-05: warehouse materializations consulted before live SODA.
//
//   node --test worker/test/wh05_warehouse_lookups.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachDoingBusinessFromWarehouse,
  doingBusinessWarehouseReady,
  lookupDoingBusinessFromWarehouse,
  warehouseMaterializationMeta as dbMeta,
  resetDoingBusinessWarehouseIndexCache,
} from "../src/lib/doing_business_warehouse_lookup.mjs";
import {
  lookupZapProjectFromWarehouseMaterialization,
  warehouseMaterializationMeta as zapMeta,
  getZapProjectsWarehouseIndex,
  resetZapProjectsWarehouseIndexCache,
} from "../src/lib/zap_projects_warehouse_lookup.mjs";
import { buildZapOutcomeRecord } from "../src/zap_outcomes.mjs";

test("committed Doing Business materialization is ready", () => {
  resetDoingBusinessWarehouseIndexCache();
  const meta = dbMeta();
  assert.equal(meta.schema_version, 1);
  assert.ok(meta.row_count >= 3);
  assert.equal(doingBusinessWarehouseReady(), true);
});

test("Doing Business warehouse hit for CAMBA without network", () => {
  const hit = lookupDoingBusinessFromWarehouse("Camba Inc.");
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.payload.organization_name, "CAMBA  INC");
  assert.equal(hit.payload.organization_phone, "555-010-0001");
});

test("Doing Business warehouse miss leaves SODA fallback room", () => {
  const miss = lookupDoingBusinessFromWarehouse("ZZZ Not A Registered Vendor LLC");
  assert.equal(miss.hit, false);
  assert.equal(miss.payload, null);
});

test("attachDoingBusinessFromWarehouse fills matching profiles", () => {
  const profiles = {
    CAMBA: { stem: "CAMBA", display: "Camba Inc.", variants: [], doingBusiness: null },
    NOPE: { stem: "NOPEVENDORXYZ", display: "Nope Vendor Xyz", variants: [], doingBusiness: null },
  };
  const r = attachDoingBusinessFromWarehouse(profiles);
  assert.equal(r.used, true);
  assert.equal(r.path, "warehouse");
  assert.equal(r.requests, 0);
  assert.ok(profiles.CAMBA.doingBusiness);
  assert.equal(profiles.CAMBA.doingBusiness.organization_name, "CAMBA  INC");
  assert.equal(profiles.NOPE.doingBusiness, null);
  assert.equal(r.matched, 1);
});

test("committed ZAP projects materialization indexes land default demos", () => {
  resetZapProjectsWarehouseIndexCache();
  const meta = zapMeta();
  assert.equal(meta.schema_version, 1);
  assert.ok(meta.row_count >= 5);
  const index = getZapProjectsWarehouseIndex();
  assert.ok(index.byProjectId.size >= 5);
});

test("ZAP warehouse materialization hits without network", () => {
  const index = getZapProjectsWarehouseIndex();
  const sampleId = [...index.byProjectId.keys()][0];
  const hit = lookupZapProjectFromWarehouseMaterialization(sampleId);
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.row.project_id, sampleId);
});

test("ZAP warehouse miss leaves SODA fallback room", () => {
  const miss = lookupZapProjectFromWarehouseMaterialization("NOPE9999Z9999");
  assert.equal(miss.hit, false);
  assert.equal(miss.row, null);
});

test("buildZapOutcomeRecord uses warehouse open_data without SODA for hits", async () => {
  const index = getZapProjectsWarehouseIndex();
  const sampleId = [...index.byProjectId.keys()][0];
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // ZAP API + other upstreams may still run; only Open Data hgx4 must not.
    if (String(url).includes("hgx4-8ukb")) {
      throw new Error("SODA hgx4 should not be called on warehouse open_data hit");
    }
    // Fail soft other upstreams so the test stays offline.
    return {
      ok: false,
      status: 503,
      json: async () => ({}),
    };
  };
  try {
    const record = await buildZapOutcomeRecord(sampleId, { fetchBbl: false });
    assert.equal(record.project_id, sampleId);
    assert.ok(record.open_data);
    assert.equal(record.open_data.project_id, sampleId);
    assert.equal(record.open_data.lookup_path, "warehouse");
    assert.ok(
      !calls.some((u) => u.includes("hgx4-8ukb")),
      "no Open Data SODA on warehouse hit",
    );
  } finally {
    globalThis.fetch = orig;
  }
});
