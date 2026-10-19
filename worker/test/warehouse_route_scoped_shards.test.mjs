// Route-scoped warehouse shard candidate (cc-06).
//
//   node --test worker/test/warehouse_route_scoped_shards.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  warehouseRouteScopedRevisionFromEnv,
  warehouseRouteScopedShardCacheSnapshot,
  warehouseRouteScopedShardKey,
  warehouseRouteScopedShardsEnabled,
} from "../src/lib/warehouse_route_scoped_shards.mjs";
import { fetchOpenDataRow, fetchBbls } from "../src/zap_outcomes.mjs";
import { completeLandProjectPopulation } from "../src/land_projects.mjs";
import {
  resetZapWarehouseIndexCache,
  warehouseZapMaterializationMeta,
} from "../src/lib/zap_warehouse_lookup.mjs";
import {
  resetZapBblWarehouseIndexCache,
  warehouseZapBblMaterializationMeta,
} from "../src/lib/zap_bbl_warehouse_lookup.mjs";

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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_SOURCE = path.join(HERE, "../src/lib/warehouse_route_scoped_shards.mjs");

const ZAP_PROJECT_ROW = {
  project_id: "2022M0258",
  project_name: "Route Scoped Timbale",
  public_status: "Completed",
  project_status: "Complete",
  borough: "Manhattan",
  ulurp_numbers: "240046HAM",
  actions: "HA",
  materialized_marker: "route-scoped-zap-project",
};

const ZAP_BBL_ROW = {
  project_id: "2022M0258",
  bbls: ["1001660025"],
};

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
  assert.equal(off.kv_reads, 0);

  const missing = await resolveWarehouseRouteScopedLookup({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    ALERT_STATE: kv,
  }, { route: "zap-bbl", revision: REVISION });
  assert.equal(missing.path, "abort-retain-baseline");
  assert.equal(missing.operation_recommendation, "retain-baseline");
  assert.equal(missing.shipped_savings_claimed, false);
});

test("kv absent stays absent; thrown kv.get stays failed/kv-read-error", async () => {
  resetWarehouseRouteScopedShardCache();
  const revision = REVISION;
  const absent = await loadWarehouseRouteScopedShard({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    ALERT_STATE: mockKv(),
  }, { route: "zap-bbl", revision });
  assert.equal(absent.status, "absent");
  assert.equal(absent.reason, "empty");
  assert.equal(absent.abort, true);
  assert.equal(absent.kv_reads, 1);

  const failingKv = {
    async get() {
      throw new Error("kv unavailable");
    },
  };
  const failed = await loadWarehouseRouteScopedShard({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    ALERT_STATE: failingKv,
  }, { route: "doing-business", revision });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "kv-read-error");
  assert.equal(failed.abort, true);
  assert.equal(failed.operation_recommendation, "retain-baseline");
  assert.equal(failed.kv_reads, 1);
});

test("flag-on with missing or invalid GIT_COMMIT_SHA aborts retain-baseline", async () => {
  resetWarehouseRouteScopedShardCache();
  assert.equal(warehouseRouteScopedRevisionFromEnv({ GIT_COMMIT_SHA: "short" }), null);
  const noRev = await resolveWarehouseRouteScopedLookup({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    ALERT_STATE: mockKv(),
  }, { route: "zap-project" });
  assert.equal(noRev.path, "abort-retain-baseline");
  assert.equal(noRev.status, "failed");
  assert.equal(noRev.reason, "revision-missing-or-invalid");
  assert.equal(noRev.kv_reads, 0);

  const bad = await resolveWarehouseRouteScopedLookup({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    GIT_COMMIT_SHA: "not-a-sha",
    ALERT_STATE: mockKv(),
  }, { route: "zap-project" });
  assert.equal(bad.path, "abort-retain-baseline");
  assert.equal(bad.reason, "revision-missing-or-invalid");
});

test("candidate module source does not statically import warehouse_lookup JSON", () => {
  const source = fs.readFileSync(CANDIDATE_SOURCE, "utf8");
  assert.equal(
    /warehouse_lookup\.json/.test(source),
    false,
    "route-scoped candidate must not import warehouse_lookup.json",
  );
  assert.equal(
    /from\s+["'][^"']*warehouse_lookup\.json["']/.test(source),
    false,
  );
  assert.equal(
    /import\s+.*warehouse_lookup/.test(source),
    false,
  );
});

test("fetchOpenDataRow flag-off keeps static baseline with zero KV reads", async () => {
  resetWarehouseRouteScopedShardCache();
  resetZapWarehouseIndexCache();
  let reads = 0;
  const kv = {
    async get() {
      reads += 1;
      return null;
    },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("SODA should not run on baseline warehouse hit");
  };
  try {
    const row = await fetchOpenDataRow("2022M0258", {
      env: { ALERT_STATE: kv },
    });
    assert.equal(row.lookup_path, "warehouse");
    assert.equal(row.project_id, "2022M0258");
    assert.notEqual(row.project_name, ZAP_PROJECT_ROW.project_name);
    assert.equal(reads, 0, "flag-off must not read route-scoped KV");
    assert.ok(warehouseZapMaterializationMeta().row_count >= 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchOpenDataRow flag-on hit uses shard with cold then isolate-reuse", async () => {
  resetWarehouseRouteScopedShardCache();
  resetZapWarehouseIndexCache();
  const kv = mockKv();
  let reads = 0;
  const countingKv = {
    async get(key) {
      reads += 1;
      return kv.get(key);
    },
    async put(key, value) {
      return kv.put(key, value);
    },
  };
  const shard = buildWarehouseRouteScopedShardDocument("zap-project", {
    schema_version: 1,
    mode: "fixture",
    materialized_at: "2026-10-19T12:00:00.000Z",
    phase: "WH-05",
    rows: [ZAP_PROJECT_ROW],
  }, { deployed_revision: REVISION });
  await countingKv.put(warehouseRouteScopedShardKey("zap-project", REVISION), JSON.stringify(shard));

  const env = {
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    GIT_COMMIT_SHA: REVISION,
    ALERT_STATE: countingKv,
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("SODA should not run on route-scoped warehouse hit");
  };
  try {
    const coldResolve = await resolveWarehouseRouteScopedLookup(env, { route: "zap-project" });
    assert.equal(coldResolve.path, "route-scoped-shards");
    assert.equal(coldResolve.cache_state, "index-cold-reset");
    assert.equal(coldResolve.kv_reads, 1);
    assert.equal(coldResolve.doc.deployed_revision, REVISION);
    assert.equal(coldResolve.materialization.materialized_at, "2026-10-19T12:00:00.000Z");

    const row = await fetchOpenDataRow("2022M0258", { env });
    assert.equal(row.lookup_path, "warehouse");
    assert.equal(row.project_name, ZAP_PROJECT_ROW.project_name);

    const warmResolve = await resolveWarehouseRouteScopedLookup(env, { route: "zap-project" });
    assert.equal(warmResolve.cache_state, "isolate-reuse-hit");
    assert.equal(warmResolve.kv_reads, 0);

    const miss = await fetchOpenDataRow("NO_SUCH_PROJECT_ZZZ", { env });
    assert.equal(miss.lookup_path, "soda");
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(reads, 1, "only the cold resolve should read KV");
});

test("fetchOpenDataRow flag-on absent shard retains static baseline", async () => {
  resetWarehouseRouteScopedShardCache();
  resetZapWarehouseIndexCache();
  const env = {
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    GIT_COMMIT_SHA: REVISION,
    ALERT_STATE: mockKv(),
  };
  const aborted = await resolveWarehouseRouteScopedLookup(env, { route: "zap-project" });
  assert.equal(aborted.path, "abort-retain-baseline");
  assert.equal(aborted.status, "absent");

  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("SODA should not run on baseline warehouse hit");
  };
  try {
    const row = await fetchOpenDataRow("2022M0258", { env });
    assert.equal(row.lookup_path, "warehouse");
    assert.equal(row.project_id, "2022M0258");
    assert.notEqual(row.project_name, ZAP_PROJECT_ROW.project_name);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchBbls flag arms: off baseline, on hit, on absent retain baseline", async () => {
  resetWarehouseRouteScopedShardCache();
  resetZapBblWarehouseIndexCache();
  const baselineMeta = warehouseZapBblMaterializationMeta();

  const off = await fetchBbls("2022M0258", { env: { ALERT_STATE: mockKv() } });
  assert.equal(off.lookup_path, "warehouse");
  assert.ok(off.length >= 1);

  const kv = mockKv();
  const shard = buildWarehouseRouteScopedShardDocument("zap-bbl", {
    schema_version: 1,
    mode: "fixture",
    materialized_at: "2026-10-19T12:30:00.000Z",
    phase: "WH-06",
    dataset_id: "2iga-a6mk",
    rows: [ZAP_BBL_ROW],
  }, { deployed_revision: REVISION });
  await kv.put(warehouseRouteScopedShardKey("zap-bbl", REVISION), JSON.stringify(shard));
  const env = {
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    GIT_COMMIT_SHA: REVISION,
    ALERT_STATE: kv,
  };
  resetWarehouseRouteScopedShardCache();
  const hit = await fetchBbls("2022M0258", { env });
  assert.equal(hit.lookup_path, "warehouse");
  assert.deepEqual([...hit], ["1001660025"]);
  const resolved = await resolveWarehouseRouteScopedLookup(env, { route: "zap-bbl" });
  assert.equal(resolved.cache_state, "isolate-reuse-hit");
  assert.equal(resolved.materialization.materialized_at, "2026-10-19T12:30:00.000Z");

  const missEnv = {
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    GIT_COMMIT_SHA: REVISION,
    ALERT_STATE: mockKv(),
  };
  resetWarehouseRouteScopedShardCache();
  const retained = await fetchBbls("2022M0258", { env: missEnv });
  assert.equal(retained.lookup_path, "warehouse");
  assert.ok(retained.length >= 1);
  assert.ok(baselineMeta.project_count >= 1);
});

test("completeLandProjectPopulation uses zap-project shard when enabled", async () => {
  resetWarehouseRouteScopedShardCache();
  resetZapWarehouseIndexCache();
  const uniqueRow = {
    project_id: "ROUTESCOPED1",
    project_name: "Route Scoped Only Project",
    public_status: "Active",
    project_status: "Active",
    borough: "Brooklyn",
  };
  const kv = mockKv();
  const shard = buildWarehouseRouteScopedShardDocument("zap-project", {
    schema_version: 1,
    mode: "fixture",
    materialized_at: "2026-10-19T13:00:00.000Z",
    rows: [uniqueRow],
  }, { deployed_revision: REVISION });
  await kv.put(warehouseRouteScopedShardKey("zap-project", REVISION), JSON.stringify(shard));

  const population = await completeLandProjectPopulation({
    [WAREHOUSE_ROUTE_SCOPED_FLAG]: WAREHOUSE_ROUTE_SCOPED_ENABLED,
    GIT_COMMIT_SHA: REVISION,
    ALERT_STATE: kv,
  });
  const row = population.rows.find((r) => r.project_id === "ROUTESCOPED1");
  assert.ok(row, "shard-only project must appear in the land population");
  assert.equal(row.project_name, uniqueRow.project_name);
  assert.equal(population.sources.warehouse_floor.row_count, 1);
  assert.equal(population.sources.warehouse_floor.materialized_at, "2026-10-19T13:00:00.000Z");

  resetWarehouseRouteScopedShardCache();
  const baseline = await completeLandProjectPopulation({ ALERT_STATE: mockKv() });
  assert.equal(
    baseline.rows.some((r) => r.project_id === "ROUTESCOPED1"),
    false,
    "flag-off baseline must not invent the shard-only project",
  );
});
