// WH-05: Doing Business warehouse materialization consulted before live SODA.
// ZAP open_data warehouse path is covered by worker/test/zap_warehouse_lookup.test.mjs.
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
  assert.equal(hit.payload.organization_phone, "5550100");
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
