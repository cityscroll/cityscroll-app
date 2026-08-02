// WH-06: warehouse materialization is consulted before live SODA for ZAP BBL.
//   node --test worker/test/zap_bbl_warehouse_lookup.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  lookupZapBblsFromWarehouseMaterialization,
  warehouseZapBblMaterializationMeta,
  resetZapBblWarehouseIndexCache,
} from "../src/lib/zap_bbl_warehouse_lookup.mjs";
import { fetchBbls } from "../src/zap_outcomes.mjs";

test("materialization meta is present", () => {
  const meta = warehouseZapBblMaterializationMeta();
  assert.equal(meta.schema_version, 1);
  assert.equal(meta.phase, "WH-06");
  assert.equal(meta.dataset_id, "2iga-a6mk");
  assert.ok(meta.project_count >= 1);
});

test("warehouse materialization hits without network", () => {
  resetZapBblWarehouseIndexCache();
  const hit = lookupZapBblsFromWarehouseMaterialization("2022M0258");
  assert.equal(hit.hit, true);
  assert.equal(hit.path, "warehouse");
  assert.equal(hit.join_key, "project_id");
  assert.ok(hit.bbls.length >= 1);
  assert.ok(hit.bbls.every((b) => /^\d{10}$/.test(b)));
});

test("warehouse materialization miss leaves room for SODA fallback", () => {
  const miss = lookupZapBblsFromWarehouseMaterialization("NO_SUCH_PROJECT_ZZZ");
  assert.equal(miss.hit, false);
  assert.deepEqual(miss.bbls, []);
  assert.equal(miss.path, null);
});

test("fetchBbls uses warehouse path for materialization hits", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("SODA should not be called on warehouse hit");
  };
  try {
    const bbls = await fetchBbls("2022M0258");
    assert.ok(bbls.length >= 1);
    assert.equal(bbls.lookup_path, "warehouse");
    assert.equal(calls.length, 0, "no network on warehouse hit");
  } finally {
    globalThis.fetch = origFetch;
  }
});
