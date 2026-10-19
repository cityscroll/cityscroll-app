import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES,
  WAREHOUSE_ROUTE_SCOPED_PUBLICATION_LEDGER_SCHEMA,
  cleanupWarehouseRouteScopedShards,
  loadShardPublicationLedger,
  makeShardPublicationLedger,
  markShardAcked,
  markShardIssued,
  persistShardPublicationLedger,
  planExactValueShardClear,
  planWarehouseRouteScopedCleanup,
  planWarehouseRouteScopedPublication,
  preflightWarehouseRouteScopedPublicationReadonly,
  publishWarehouseRouteScopedShards,
} from "./lib/warehouse_route_scoped_publication.mjs";
import {
  WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES,
  warehouseRouteScopedShardKey,
} from "../worker/src/lib/warehouse_route_scoped_shards.mjs";
import {
  evaluateWarehouseRouteScopedAbort,
  planWarehouseCacheResetReuseRehearsal,
  planWarehouseRouteScopedRollbackOrAbort,
} from "./lib/worker_cost_control.mjs";

const REVISION = "108ab97d3cc9973a83b4df00628f5b89c0431251";
const ROLLBACK_REVISION = "38fd7f11249a0000000000000000000000000001";

function tinyMaterializations() {
  return {
    "zap-bbl": {
      schema_version: 1,
      mode: "fixture",
      materialized_at: "2026-10-19T00:00:00Z",
      rows: [{ bbl: "3000000001" }],
      bbl_row_count: 1,
    },
    "zap-project": {
      schema_version: 1,
      mode: "fixture",
      materialized_at: "2026-10-19T00:00:00Z",
      rows: [{ project_id: "P1" }],
      row_count: 1,
    },
    "doing-business": {
      schema_version: 1,
      mode: "fixture",
      materialized_at: "2026-10-19T00:00:00Z",
      rows: [{ organization_name: "FIXTURE ORG" }],
      row_count: 1,
    },
  };
}

function fakeWrangler({ failAtPut = null, failAtDelete = null, seed = new Map() } = {}) {
  const values = new Map(seed);
  const calls = [];
  let puts = 0;
  let deletes = 0;
  return {
    values,
    calls,
    async invoke(args) {
      calls.push([...args]);
      if (args[0] === "kv" && args[1] === "key" && args[2] === "get") {
        const key = args[3];
        if (!values.has(key)) {
          const error = new Error("Value not found");
          error.status = 1;
          error.stdout = "Value not found";
          throw error;
        }
        return { stdout: values.get(key) };
      }
      if (args[0] === "kv" && args[1] === "key" && args[2] === "put") {
        puts += 1;
        if (failAtPut != null && puts === failAtPut) {
          throw new Error("injected put failure");
        }
        const key = args[3];
        const path = args[args.indexOf("--path") + 1];
        values.set(key, readFileSync(path, "utf8"));
        return { stdout: "" };
      }
      if (args[0] === "kv" && args[1] === "key" && args[2] === "delete") {
        deletes += 1;
        if (failAtDelete != null && deletes === failAtDelete) {
          throw new Error("injected delete failure");
        }
        values.delete(args[3]);
        return { stdout: "" };
      }
      throw new Error(`unexpected wrangler args: ${args.join(" ")}`);
    },
  };
}

test("publication plan emits exactly three lookup shards and excludes health/browse", () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  assert.equal(plan.decision, "publish-revision-shards");
  assert.equal(plan.shards.length, 3);
  assert.equal(plan.planned.shard_puts, 3);
  assert.deepEqual([...plan.control_routes], ["health", "browse"]);
  assert.deepEqual([...plan.lookup_routes], [...WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES]);
  assert.equal(plan.activation.enables_flag, false);
  for (const shard of plan.shards) {
    assert.ok(WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(shard.route));
    assert.equal(shard.key, warehouseRouteScopedShardKey(shard.route, REVISION));
    assert.match(shard.value_sha256, /^[a-f0-9]{64}$/);
    for (const control of WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES) {
      assert.equal(shard.key.includes(`:${control}:`), false);
    }
  }
});

test("publication plan refuses invalid revision and control-route collision", () => {
  assert.throws(
    () => planWarehouseRouteScopedPublication({
      deployed_revision: "abc",
      materializations: tinyMaterializations(),
    }),
    /full commit SHA/,
  );
  assert.throws(
    () => planWarehouseRouteScopedPublication({
      deployed_revision: REVISION,
      materializations: tinyMaterializations(),
      control_routes: ["health", "zap-bbl"],
    }),
    /control route/,
  );
});

test("publish issues-before-ack, accounts KV ops, and persists durable ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-pub-"));
  const ledgerPath = join(dir, "ledger.json");
  const remote = fakeWrangler();
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  try {
    const receipt = await publishWarehouseRouteScopedShards({
      plan,
      invoke: remote.invoke,
      ledgerPath,
      attempt_id: "attempt-fixture-publish",
    });
    assert.equal(receipt.decision, "published");
    assert.deepEqual(receipt.attempted, { kv_reads: 0, shard_puts: 3, shard_deletes: 0 });
    assert.deepEqual(receipt.confirmed, { shard_puts: 3, shard_deletes: 0 });
    assert.equal(receipt.shards.length, 3);
    assert.equal(remote.values.size, 3);

    const ledger = loadShardPublicationLedger(ledgerPath);
    assert.equal(ledger.schema, WAREHOUSE_ROUTE_SCOPED_PUBLICATION_LEDGER_SCHEMA);
    assert.equal(ledger.attempt_id, "attempt-fixture-publish");
    for (const shard of plan.shards) {
      const entry = ledger.entries[shard.key];
      assert.equal(entry.phase, "acked");
      assert.equal(entry.value_sha256, shard.value_sha256);
      assert.equal(remote.values.get(shard.key), shard.value);
      assert.ok(remote.calls.some((args) => args.includes("--binding") && args.includes("ALERT_STATE")));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish marks unknown and keeps durable recovery when put response is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-pub-unknown-"));
  const ledgerPath = join(dir, "ledger.json");
  const remote = fakeWrangler({ failAtPut: 2 });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  try {
    await assert.rejects(
      () => publishWarehouseRouteScopedShards({
        plan,
        invoke: remote.invoke,
        ledgerPath,
        attempt_id: "attempt-fixture-unknown",
      }),
      /injected put failure/,
    );
    const ledger = loadShardPublicationLedger(ledgerPath);
    // First put acked, second unknown (failed at response), third never issued.
    const entries = Object.values(ledger.entries);
    assert.equal(entries.length, 2);
    assert.equal(entries.filter((e) => e.phase === "acked").length, 1);
    assert.equal(entries.filter((e) => e.phase === "unknown").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exact-value clear: owned match clears; foreign aborts; absent is already-clear", () => {
  assert.deepEqual(
    planExactValueShardClear({ ownedValue: "A", liveValue: "A" }),
    { action: "clear-owned", reason: "live-equals-owned", foreign: false },
  );
  assert.deepEqual(
    planExactValueShardClear({ ownedValue: "A", liveValue: "B" }),
    { action: "leave-foreign", reason: "live-value-differs-from-owned", foreign: true },
  );
  assert.deepEqual(
    planExactValueShardClear({ ownedValue: "A", liveValue: null }),
    { action: "already-absent", reason: "live-value-absent", foreign: false },
  );
  assert.equal(
    planExactValueShardClear({ ownedValue: null, liveValue: "A" }).action,
    "refuse-missing-owned-value",
  );
});

test("cleanup refuses active and rollback revisions; clears only exact owned values", async () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const owned = Object.fromEntries(plan.shards.map((s) => [s.key, s.value]));
  const seed = new Map(Object.entries(owned));
  // Foreign overwrite on one key
  const foreignKey = plan.shards[1].key;
  seed.set(foreignKey, `${owned[foreignKey]}-FOREIGN\n`);

  const refuseActive = planWarehouseRouteScopedCleanup({
    deployed_revision: REVISION,
    owned_entries: owned,
    active_revision: REVISION,
  });
  assert.equal(refuseActive.decision, "refuse-active-revision");

  const refuseRollback = planWarehouseRouteScopedCleanup({
    deployed_revision: REVISION,
    owned_entries: owned,
    rollback_revision: REVISION,
  });
  assert.equal(refuseRollback.decision, "refuse-rollback-revision");

  const cleanupPlan = planWarehouseRouteScopedCleanup({
    deployed_revision: REVISION,
    owned_entries: owned,
    live_values: Object.fromEntries(seed),
    active_revision: ROLLBACK_REVISION,
  });
  assert.equal(cleanupPlan.decision, "cleanup-owned-revision");
  assert.equal(cleanupPlan.planned.shard_deletes, 2);

  const remote = fakeWrangler({ seed });
  const ledger = makeShardPublicationLedger({
    attempt_id: "attempt-fixture-cleanup",
    deployed_revision: REVISION,
  });
  for (const shard of plan.shards) {
    const entry = {
      route: shard.route,
      key: shard.key,
      deployed_revision: REVISION,
      phase: "acked",
      value: shard.value,
      value_sha256: shard.value_sha256,
    };
    markShardIssued(entry, { value: shard.value, value_sha256: shard.value_sha256 }, "t0");
    markShardAcked(entry, "t1");
    ledger.entries[shard.key] = entry;
  }

  const receipt = await cleanupWarehouseRouteScopedShards({
    plan: cleanupPlan,
    invoke: remote.invoke,
    owned_values: owned,
    ledger,
  });
  assert.equal(receipt.decision, "cleaned");
  assert.equal(receipt.confirmed.shard_deletes, 2);
  const foreignAction = receipt.actions.find((row) => row.key === foreignKey);
  assert.equal(foreignAction.action, "leave-foreign");
  assert.equal(remote.values.has(foreignKey), true, "foreign value left in place");
  assert.equal(remote.values.size, 1);
});

test("readonly preflight passes for tip fixtures and records zero provider writes", () => {
  const report = preflightWarehouseRouteScopedPublicationReadonly({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
    live_shard_values: {
      [warehouseRouteScopedShardKey("zap-bbl", REVISION)]: null,
      [warehouseRouteScopedShardKey("zap-project", REVISION)]: null,
      [warehouseRouteScopedShardKey("doing-business", REVISION)]: null,
    },
    health_commit: REVISION,
    flag_binding_present: false,
  });
  assert.equal(report.outcome, "preflight-readonly-passed");
  assert.equal(report.provider_writes, 0);
  assert.equal(report.mode, "readonly");
  assert.equal(report.checks.control_routes_excluded, true);
  assert.equal(report.plan_summary.shard_puts, 3);
  assert.equal(report.plan_summary.activation.enables_flag, false);
});

test("health/browse stay controls in cache rehearsal and abort/rollback identity planners", () => {
  const rehearsal = planWarehouseCacheResetReuseRehearsal({
    deployed_revision: REVISION,
    control_routes: ["health", "browse"],
  });
  assert.deepEqual([...rehearsal.control_routes], ["health", "browse"]);
  assert.equal(rehearsal.routes.includes("health"), false);
  assert.equal(rehearsal.abort_rules.on_materialization_failed, "retain-baseline");

  const abort = evaluateWarehouseRouteScopedAbort({ materialization_status: "absent" });
  assert.equal(abort.abort, true);
  assert.equal(abort.operation_recommendation, "retain-baseline");

  const bound = planWarehouseRouteScopedRollbackOrAbort({ abort });
  assert.equal(bound.action, "retain-baseline");
  assert.equal(bound.rollback, null);
  assert.equal(bound.financial_savings_confirmed, false);
});

test("durable ledger round-trip preserves issued/acked phases", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-ledger-"));
  const path = join(dir, "ownership.json");
  try {
    const ledger = makeShardPublicationLedger({
      attempt_id: "attempt-roundtrip",
      deployed_revision: REVISION,
      active_revision: REVISION,
      rollback_revision: ROLLBACK_REVISION,
    });
    const key = warehouseRouteScopedShardKey("zap-bbl", REVISION);
    ledger.entries[key] = {
      route: "zap-bbl",
      key,
      deployed_revision: REVISION,
      phase: null,
      value: null,
      value_sha256: null,
    };
    markShardIssued(ledger.entries[key], { value: '{"a":1}\n', value_sha256: "abc" }, "t0");
    markShardAcked(ledger.entries[key], "t1");
    persistShardPublicationLedger(path, ledger, { nowIso: () => "t2" });
    const loaded = loadShardPublicationLedger(path);
    assert.equal(loaded.entries[key].phase, "acked");
    assert.equal(loaded.active_revision, REVISION);
    assert.equal(loaded.rollback_revision, ROLLBACK_REVISION);
    assert.deepEqual(loaded.control_routes, ["health", "browse"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
