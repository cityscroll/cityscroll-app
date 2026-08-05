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

const FIELD_CASE_DOC = {
  schema_version: 1,
  phase: "WH-05",
  mode: "test",
  rows: [
    {
      organization_name: "CAMBA  INC",
      ownership_structure_code: "COR",
      organization_phone: "2125550100",
      doing_business_start_date: "2009-05-16",
    },
  ],
};

test("empty committed Doing Business materialization preserves live fallback", () => {
  resetDoingBusinessWarehouseIndexCache();
  const meta = dbMeta();
  assert.equal(meta.schema_version, 1);
  assert.equal(meta.row_count, 0);
  assert.equal(meta.mode, "live_fallback");
  assert.equal(doingBusinessWarehouseReady(), false);
});

test("Doing Business warehouse hit works with a source-backed document", () => {
  const hit = lookupDoingBusinessFromWarehouse("Camba Inc.", FIELD_CASE_DOC);
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.payload.organization_name, "CAMBA  INC");
  assert.equal(hit.payload.organization_phone, "212-555-0100");
});

test("Doing Business warehouse miss leaves SODA fallback room", () => {
  const miss = lookupDoingBusinessFromWarehouse("ZZZ Not A Registered Vendor LLC");
  assert.equal(miss.hit, false);
  assert.equal(miss.payload, null);
});

test("attachDoingBusinessFromWarehouse fills matching profiles from an override", () => {
  const profiles = {
    CAMBA: { stem: "CAMBA", display: "Camba Inc.", variants: [], doingBusiness: null },
    NOPE: { stem: "NOPEVENDORXYZ", display: "Nope Vendor Xyz", variants: [], doingBusiness: null },
  };
  const r = attachDoingBusinessFromWarehouse(profiles, FIELD_CASE_DOC);
  assert.equal(r.used, true);
  assert.equal(r.path, "warehouse");
  assert.equal(r.requests, 0);
  assert.ok(profiles.CAMBA.doingBusiness);
  assert.equal(profiles.CAMBA.doingBusiness.organization_name, "CAMBA  INC");
  assert.equal(profiles.NOPE.doingBusiness, null);
  assert.equal(r.matched, 1);
});
