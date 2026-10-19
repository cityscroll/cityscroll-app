// Route-scoped warehouse shard candidate (cc-06).
//
//   node --test worker/test/warehouse_route_scoped_shards.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  WAREHOUSE_ROUTE_SCOPED_ENABLED,
  WAREHOUSE_ROUTE_SCOPED_FLAG,
  WAREHOUSE_ROUTE_SCOPED_KEY_PREFIX,
  WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES,
  WAREHOUSE_ROUTE_SCOPED_SHARD_SCHEMA,
  buildWarehouseRouteScopedShardDocument,
  loadWarehouseRouteScopedShard,
  parseWarehouseRouteScopedShardRecord,
  resetWarehouseRouteScopedShardCache,
  resolveWarehouseRouteScopedLookup,
  warehouseRouteScopedShardCacheSnapshot,
  warehouseRouteScopedShardKey,
  warehouseRouteScopedShardsEnabled,
} from "../src/lib/warehouse_route_scoped_shards.mjs";

function mockKv(store = new Map()) {
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

const REVISION = "f".repeat(40);

test("flag defaults off so static baseline remains the production path", () => {
  assert.equal(warehouseRouteScopedShardsEnabled(undefined), false);
  assert.equal(warehouseRouteScopedShardsEnabled({}), false);
  assert.equal(
    warehouseRouteScopedShardsEnabled({ [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED }),
    true,
  );
});

test("versioned shard keys are route-scoped and revision-bound", () => {
  assert.equal(
    warehouseRouteScopedShardKey("zap-bbl", REVISION),
    `${WAREHOUSE_ROUTE_SCOPED_KEY_PREFIX}:zap-bbl:${REVISION}`,
  );
  assert.throws(() => warehouseRouteScopedShardKey("health", REVISION), /zap-bbl, zap-project, doing-business/);
  assert.throws(() => warehouseRouteScopedShardKey("zap-bbl", "short"), /full commit SHA/);
});

test("parse rejects whole-kv shaped payloads and mismatched identities", () => {
  const ok = buildWarehouseRouteScopedShardDocument("doing-business", {
    schema_version: 1,
    rows: [{ organization_name: "CAMBA  INC" }],
  }, { deployed_revision: REVISION });
  assert.equal(parseWarehouseRouteScopedShardRecord(JSON.stringify(ok), {
    route: "doing-business",
    revision: REVISION,
  }).status, "ok");

  assert.equal(parseWarehouseRouteScopedShardRecord(null).status, "absent");
  assert.equal(parseWarehouseRouteScopedShardRecord("{").status, "failed");
  assert.equal(parseWarehouseRouteScopedShardRecord(JSON.stringify({
    schema: WAREHOUSE_ROUTE_SCOPED_SHARD_SCHEMA,
    kind: "whole-kv-materialization",
    route: "zap-bbl",
    deployed_revision: REVISION,
    materialization: { rows: [] },
  }), { route: "zap-bbl", revision: REVISION }).status, "invalid");
  assert.equal(parseWarehouseRouteScopedShardRecord(JSON.stringify({
    ...ok,
    route: "zap-project",
  }), { route: "zap-bbl", revision: REVISION }).status, "invalid");
});

test("isolate cache reset then load yields index-cold-reset then isolate-reuse-hit", async () => {
  resetWarehouseRouteScopedShardCache();
  const kv = mockKv();
  const shard = buildWarehouseRouteScopedShardDocument("zap-project", {
    schema_version: 1,
    rows: [{ project_id: "2022M0258" }],
  }, { deployed_revision: REVISION });
  await kv.put(warehouseRouteScopedShardKey("zap-project", REVISION), JSON.stringify(shard));

  const env = {
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    ALERT_STATE: kv,
  };
  const cold = await loadWarehouseRouteScopedShard(env, { route: "zap-project", revision: REVISION });
  assert.equal(cold.cache_state, "index-cold-reset");
  assert.equal(cold.kv_reads, 1);
  assert.equal(warehouseRouteScopedShardCacheSnapshot()["zap-project"].revision, REVISION);

  const warm = await loadWarehouseRouteScopedShard(env, { route: "zap-project", revision: REVISION });
  assert.equal(warm.cache_state, "isolate-reuse-hit");
  assert.equal(warm.kv_reads, 0);

  resetWarehouseRouteScopedShardCache("zap-project");
  const afterReset = await loadWarehouseRouteScopedShard(env, { route: "zap-project", revision: REVISION });
  assert.equal(afterReset.cache_state, "index-cold-reset");
  assert.equal(afterReset.kv_reads, 1);

  // Other lookup routes stay independent.
  for (const route of WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES) {
    if (route === "zap-project") continue;
    assert.equal(warehouseRouteScopedShardCacheSnapshot()[route], undefined);
  }
});

test("resolve stays on static-baseline unless the candidate flag is enabled", async () => {
  resetWarehouseRouteScopedShardCache();
  const kv = mockKv();
  const off = await resolveWarehouseRouteScopedLookup({ ALERT_STATE: kv }, {
    route: "zap-bbl",
    revision: REVISION,
  });
  assert.equal(off.path, "static-baseline");
  assert.equal(off.status, "disabled");

  const missing = await resolveWarehouseRouteScopedLookup({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    ALERT_STATE: kv,
  }, { route: "zap-bbl", revision: REVISION });
  assert.equal(missing.path, "abort-retain-baseline");
  assert.equal(missing.operation_recommendation, "retain-baseline");
  assert.equal(missing.shipped_savings_claimed, false);
});
