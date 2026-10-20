import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES,
  WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE,
  WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA,
  WAREHOUSE_ROUTE_SCOPED_PUBLICATION_LEDGER_SCHEMA,
  WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA,
  assertPublishOwnershipForCleanup,
  buildFixtureNonOwnershipCheckpoint,
  buildIssuedCheckpoint,
  buildWarehouseRouteScopedPublishIntent,
  cleanupWarehouseRouteScopedShards,
  issuedCheckpointArtifactName,
  loadIssuedCheckpoint,
  loadShardPublicationLedger,
  loadWarehouseRouteScopedPublishIntent,
  makeShardPublicationLedger,
  markShardAcked,
  markShardIssued,
  mergeOwnershipFromIntentAndCheckpoints,
  ownedValuesFromPublishIntent,
  persistIssuedCheckpoint,
  persistShardPublicationLedger,
  persistWarehouseRouteScopedPublishIntent,
  planExactValueShardClear,
  planWarehouseRouteScopedCleanup,
  planWarehouseRouteScopedPublication,
  preflightWarehouseRouteScopedPublicationReadonly,
  probeWarehouseRouteScopedBaselineAbsence,
  publishWarehouseRouteScopedShards,
  recoveryLedgerFromPublishIntent,
  verifyIssuedCheckpoint,
  verifyWarehouseRouteScopedPublishIntent,
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

function fakeWrangler({
  failAtPut = null,
  loseAckAtPut = null,
  failAtGet = null,
  failAtDelete = null,
  seed = new Map(),
} = {}) {
  const values = new Map(seed);
  const calls = [];
  let puts = 0;
  let gets = 0;
  let deletes = 0;
  return {
    values,
    calls,
    async invoke(args) {
      calls.push([...args]);
      if (args[0] === "kv" && args[1] === "key" && args[2] === "get") {
        gets += 1;
        if (failAtGet != null && gets === failAtGet) {
          const error = new Error("injected GET timeout");
          error.code = "ETIMEDOUT";
          throw error;
        }
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
        if (loseAckAtPut != null && puts === loseAckAtPut) {
          throw new Error("injected lost ACK after applied PUT");
        }
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

/** External checkpoint store for offline proofs (simulates CI upload-artifact). */
function fakeCheckpointStore(root) {
  const uploaded = [];
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    uploaded,
    async upload(checkpoint, { path, artifactName }) {
      const dest = join(root, `${artifactName}.json`);
      writeFileSync(dest, readFileSync(path, "utf8"), { mode: 0o600 });
      uploaded.push({ artifactName, path: dest, key: checkpoint.key, route: checkpoint.route });
      return { store: "dir", dest, artifactName };
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
  const store = fakeCheckpointStore(join(dir, "checkpoints"));
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
      uploadIssuedCheckpoint: store.upload,
    });
    assert.equal(receipt.decision, "published");
    // 3 pre-write GETs + 3 puts.
    assert.deepEqual(receipt.attempted, { kv_reads: 3, shard_puts: 3, shard_deletes: 0 });
    assert.deepEqual(receipt.confirmed, { kv_reads: 3, shard_puts: 3, shard_deletes: 0 });
    assert.deepEqual(receipt.unknown, { kv_reads: 0, shard_puts: 0, shard_deletes: 0 });
    assert.equal(receipt.baseline_absence.all_absent, true);
    assert.equal(receipt.baseline_absence.confirmed_kv_reads, 3);
    assert.equal(receipt.baseline_absence.unknown_kv_reads, 0);
    assert.equal(receipt.shards.length, 3);
    assert.equal(remote.values.size, 3);
    // One external checkpoint uploaded per key before its PUT.
    assert.equal(store.uploaded.length, 3);
    assert.deepEqual(
      store.uploaded.map((row) => row.artifactName).sort(),
      [
        "cc06-route-scoped-issued-doing-business",
        "cc06-route-scoped-issued-zap-bbl",
        "cc06-route-scoped-issued-zap-project",
      ],
    );

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
  const store = fakeCheckpointStore(join(dir, "checkpoints"));
  const remote = fakeWrangler({ failAtPut: 2 });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  try {
    let caught = null;
    try {
      await publishWarehouseRouteScopedShards({
        plan,
        invoke: remote.invoke,
        ledgerPath,
        attempt_id: "attempt-fixture-unknown",
        uploadIssuedCheckpoint: store.upload,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.match(String(caught.message || caught), /injected put failure/);
    const failureReceipt = caught.publication_receipt;
    assert.equal(failureReceipt.decision, "publish-failed");
    assert.equal(failureReceipt.confirmed.shard_puts, 1);
    assert.equal(failureReceipt.unknown.shard_puts, 1);
    assert.equal(failureReceipt.acknowledged_provider_writes_lower_bound, 1);
    assert.equal(failureReceipt.provider_write_outcome, "UNKNOWN");
    // Must not claim provider_writes:0 as a fact when ACK is lost.
    assert.equal(Object.hasOwn(failureReceipt, "provider_writes"), false);
    const ledger = loadShardPublicationLedger(ledgerPath);
    // First put acked, second unknown (failed at response), third never issued.
    const entries = Object.values(ledger.entries);
    assert.equal(entries.length, 2);
    assert.equal(entries.filter((e) => e.phase === "acked").length, 1);
    assert.equal(entries.filter((e) => e.phase === "unknown").length, 1);
    // Checkpoint for the failed key was uploaded before the PUT was sent.
    assert.equal(store.uploaded.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeBaseline confirms only observed present/absent; GET timeout stays UNKNOWN", async () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const remote = fakeWrangler({ failAtGet: 2 });
  const baseline = await probeWarehouseRouteScopedBaselineAbsence({
    plan,
    invoke: remote.invoke,
  });
  assert.equal(baseline.attempted_kv_reads, 3);
  assert.equal(baseline.confirmed_kv_reads, 2);
  assert.equal(baseline.unknown_kv_reads, 1);
  assert.equal(baseline.all_absent, false);
  const statuses = Object.values(baseline.keys).map((row) => row.status).sort();
  assert.deepEqual(statuses, ["absent", "absent", "unknown"]);
});

test("publish refuses PUT when external checkpoint upload is missing or fails", async () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const remote = fakeWrangler();
  await assert.rejects(
    () => publishWarehouseRouteScopedShards({
      plan,
      invoke: remote.invoke,
      attempt_id: "attempt-no-uploader",
    }),
    /uploadIssuedCheckpoint/,
  );
  assert.equal(remote.calls.filter((args) => args[2] === "put").length, 0);

  const failingRemote = fakeWrangler();
  await assert.rejects(
    () => publishWarehouseRouteScopedShards({
      plan,
      invoke: failingRemote.invoke,
      attempt_id: "attempt-upload-fail",
      uploadIssuedCheckpoint: async () => {
        throw new Error("artifact upload failed");
      },
    }),
    /artifact upload failed/,
  );
  assert.equal(failingRemote.calls.filter((args) => args[2] === "put").length, 0);
  // Baseline GETs still ran; zero PUTs.
  assert.equal(failingRemote.calls.filter((args) => args[2] === "get").length, 3);
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

test("CI workflow is workflow_dispatch-only and never push-triggered", () => {
  const yaml = readFileSync(new URL("../.github/workflows/warehouse-route-scoped-publication.yml", import.meta.url), "utf8");
  assert.match(yaml, /workflow_dispatch:/);
  assert.doesNotMatch(yaml, /^\s+push:\s*$/m);
  assert.doesNotMatch(yaml, /^\s+pull_request:\s*$/m);
  assert.doesNotMatch(yaml, /^\s+schedule:\s*$/m);
  assert.doesNotMatch(yaml, /^\s+merge_group:\s*$/m);
  assert.match(yaml, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(yaml, /GO-cc06-A1-publish EXECUTE/);
  assert.match(yaml, /GO-cc06-A1-cleanup EXECUTE/);
  assert.match(yaml, /GO-cc06-A1-dry-run/);
  assert.match(yaml, /GO-cc06-A1-fixture-non-ownership/);
  assert.match(yaml, /fixture-non-ownership/);
  assert.match(yaml, /write-fixture-checkpoint/);
  assert.match(yaml, /cc06-fixture-non-ownership-drill/);
  assert.match(yaml, /Upload fixture-non-ownership checkpoint artifact/);
  assert.match(yaml, /Fetch fixture-non-ownership checkpoint artifact/);
  assert.match(yaml, /Cleanup refuses fetched fixture as non-ownership/);
  // Cross-run artifact download must use run-id + github-token (not github-run-id).
  assert.match(yaml, /run-id: \$\{\{ inputs\.intent_run_id \}\}/);
  assert.match(yaml, /github-token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(yaml, /github-run-id:/);
  // Real pre-write GETs before intent upload; per-key checkpoint upload before each PUT.
  const probeAt = yaml.indexOf("Probe baseline absence (real GETs; zero PUTs)");
  const intentUploadAt = yaml.indexOf("Upload durable intent artifact (before any KV put)");
  const checkpointUploadAt = yaml.indexOf("Upload issued checkpoint zap-bbl (before PUT)");
  const putAt = yaml.indexOf("PUT zap-bbl (after checkpoint upload)");
  assert.ok(probeAt > 0 && intentUploadAt > probeAt, "baseline probe must precede intent upload");
  assert.ok(intentUploadAt > 0 && checkpointUploadAt > intentUploadAt, "intent upload precedes per-key checkpoints");
  assert.ok(checkpointUploadAt > 0 && putAt > checkpointUploadAt, "checkpoint upload must precede PUT");
  assert.match(yaml, /probe-baseline/);
  assert.match(yaml, /write-issued-checkpoint/);
  assert.match(yaml, /put-one/);
  assert.match(yaml, /cc06-route-scoped-issued-zap-bbl/);
  assert.match(yaml, /cc06-route-scoped-issued-zap-project/);
  assert.match(yaml, /cc06-route-scoped-issued-doing-business/);
  assert.match(yaml, /pattern: cc06-route-scoped-issued-\*/);
  assert.match(yaml, /--checkpoint-dir/);
  assert.match(yaml, /assemble-attempt-receipt/);
  assert.match(yaml, /Assemble honest attempt receipt/);
  assert.match(yaml, /if: \$\{\{ always\(\)/);
  // Fixture upload must precede local wipe and fetch; cleanup refusal follows fetch.
  const fixtureWriteAt = yaml.indexOf("Write labeled fixture-non-ownership checkpoint (no KV)");
  const fixtureUploadAt = yaml.indexOf("Upload fixture-non-ownership checkpoint artifact");
  const fixtureWipeAt = yaml.indexOf("Remove local fixture copy before fetch proof");
  const fixtureFetchAt = yaml.indexOf("Fetch fixture-non-ownership checkpoint artifact");
  const fixtureRefuseAt = yaml.indexOf("Cleanup refuses fetched fixture as non-ownership (no KV)");
  assert.ok(fixtureWriteAt > 0 && fixtureUploadAt > fixtureWriteAt, "write precedes upload");
  assert.ok(fixtureWipeAt > fixtureUploadAt && fixtureFetchAt > fixtureWipeAt, "wipe precedes fetch");
  assert.ok(fixtureRefuseAt > fixtureFetchAt, "cleanup refusal follows artifact fetch");
});

test("pre-existing identical or foreign value aborts publish with zero PUTs", async () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const identicalSeed = new Map(plan.shards.map((s) => [s.key, s.value]));
  const identicalRemote = fakeWrangler({ seed: identicalSeed });
  await assert.rejects(
    () => publishWarehouseRouteScopedShards({
      plan,
      invoke: identicalRemote.invoke,
      attempt_id: "attempt-preexisting-identical",
      uploadIssuedCheckpoint: async () => ({ store: "mock" }),
    }),
    /pre-existing or unknown/,
  );
  assert.equal(
    identicalRemote.calls.filter((args) => args[2] === "put").length,
    0,
  );
  assert.equal(
    identicalRemote.calls.filter((args) => args[2] === "delete").length,
    0,
  );
  assert.equal(
    identicalRemote.calls.filter((args) => args[2] === "get").length,
    3,
  );

  const foreignKey = plan.shards[0].key;
  const foreignRemote = fakeWrangler({ seed: new Map([[foreignKey, '{"foreign":true}']]) });
  await assert.rejects(
    () => publishWarehouseRouteScopedShards({
      plan,
      invoke: foreignRemote.invoke,
      attempt_id: "attempt-preexisting-foreign",
      uploadIssuedCheckpoint: async () => ({ store: "mock" }),
    }),
    /pre-existing or unknown/,
  );
  assert.equal(foreignRemote.calls.filter((args) => args[2] === "put").length, 0);
});

test("cleanup refuses dry-run and never-issued publish intents", () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const dryRun = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: "attempt-dry-run",
    purpose: "dry-run",
  });
  assert.throws(
    () => assertPublishOwnershipForCleanup(dryRun),
    /purpose=dry-run/,
  );
  assert.throws(
    () => ownedValuesFromPublishIntent(dryRun),
    /purpose=dry-run/,
  );

  const prepareOnly = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: "attempt-prepare",
    purpose: "prepare",
  });
  assert.throws(
    () => assertPublishOwnershipForCleanup(prepareOnly),
    /purpose=prepare/,
  );

  const neverIssued = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: "attempt-publish-never-issued",
    purpose: "publish",
  });
  assert.throws(
    () => assertPublishOwnershipForCleanup(neverIssued),
    /never-issued/,
  );
  assert.throws(
    () => recoveryLedgerFromPublishIntent(neverIssued),
    /never-issued/,
  );
});

test("crash after issued PUT with lost ACK recovers only that exact own value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-intent-issued-"));
  const intentPath = join(dir, "publish-intent.json");
  const ledgerPath = join(dir, "partial-ledger.json");
  const store = fakeCheckpointStore(join(dir, "checkpoints"));
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  try {
    const intent = buildWarehouseRouteScopedPublishIntent({
      plan,
      attempt_id: "attempt-fixture-partial-issue",
      purpose: "publish",
    });
    persistWarehouseRouteScopedPublishIntent(intentPath, intent);

    const remote = fakeWrangler({ failAtPut: 2 });
    await assert.rejects(
      () => publishWarehouseRouteScopedShards({
        plan,
        invoke: remote.invoke,
        ledgerPath,
        intent,
        intentPath,
        attempt_id: "attempt-fixture-partial-issue",
        uploadIssuedCheckpoint: store.upload,
      }),
      /injected put failure/,
    );

    const loaded = loadWarehouseRouteScopedPublishIntent(intentPath);
    // First key issued+acked (or unknown if fail was on response); second issued+unknown;
    // third never issued.
    const issued = loaded.shards.filter((s) => s.issued_at);
    assert.equal(issued.length, 2);
    assert.equal(loaded.shards.filter((s) => !s.issued_at).length, 1);
    assert.ok(issued.every((s) => typeof s.issued_at === "string" && s.issued_at.length > 0));

    const ownership = assertPublishOwnershipForCleanup(loaded);
    assert.equal(ownership.issued_count, 2);

    const recovered = recoveryLedgerFromPublishIntent(loaded);
    assert.equal(Object.keys(recovered.entries).length, 2);
    assert.ok(Object.values(recovered.entries).every((e) => e.issued_at));
    // Never invent a third entry for the planned-only key.
    assert.equal(Object.keys(recovered.entries).includes(plan.shards[2].key), false);

    const owned = ownedValuesFromPublishIntent(loaded);
    assert.equal(Object.keys(owned).length, 2);

    const cleanupPlan = planWarehouseRouteScopedCleanup({
      deployed_revision: REVISION,
      owned_entries: recovered.entries,
      live_values: Object.fromEntries(Object.entries(owned)),
      active_revision: ROLLBACK_REVISION,
    });
    const cleanupRemote = fakeWrangler({ seed: new Map(Object.entries(owned)) });
    const receipt = await cleanupWarehouseRouteScopedShards({
      plan: cleanupPlan,
      invoke: cleanupRemote.invoke,
      owned_values: owned,
      ledger: recovered,
    });
    assert.equal(receipt.decision, "cleaned");
    assert.equal(receipt.confirmed.shard_deletes, 2);
    // The never-issued third key was never written and is not deleted.
    assert.equal(cleanupRemote.calls.filter((args) => args[2] === "delete").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner death after PUT with no final artifact recovers from external checkpoints only", async () => {
  // Simulates: intent uploaded, two checkpoints uploaded + PUTs acked, runner dies
  // before final receipt. Cleanup sees only initial intent + checkpoint artifacts.
  const publisher = mkdtempSync(join(tmpdir(), "cc06-pub-run-"));
  const recovery = mkdtempSync(join(tmpdir(), "cc06-cleanup-run-"));
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  try {
    const attemptId = "attempt-death-no-final";
    const intent = buildWarehouseRouteScopedPublishIntent({
      plan,
      attempt_id: attemptId,
      purpose: "publish",
    });
    const intentPath = join(publisher, "publish-intent.json");
    persistWarehouseRouteScopedPublishIntent(intentPath, intent);

    // Only first two routes got checkpoints + PUTs before death.
    const ownedShards = plan.shards.slice(0, 2);
    const checkpointDir = join(recovery, "prior-checkpoints");
    mkdirSync(checkpointDir, { recursive: true });
    const checkpoints = [];
    const seed = new Map();
    for (const shard of ownedShards) {
      const checkpoint = buildIssuedCheckpoint({
        attempt_id: attemptId,
        route: shard.route,
        key: shard.key,
        deployed_revision: shard.deployed_revision,
        value: shard.value,
        value_sha256: shard.value_sha256,
        issued_at: "2026-10-19T16:00:00.000Z",
        row_count: shard.row_count,
      });
      assert.equal(checkpoint.schema, WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA);
      const path = join(checkpointDir, `${issuedCheckpointArtifactName(shard.route)}.json`);
      persistIssuedCheckpoint(path, checkpoint);
      assert.equal(loadIssuedCheckpoint(path).key, shard.key);
      checkpoints.push(checkpoint);
      seed.set(shard.key, shard.value);
    }

    // Cross-run handoff: recovery runner only has initial (unissued) intent + checkpoints.
    const recoveryIntentPath = join(recovery, "prior-intent", "publish-intent.json");
    mkdirSync(join(recovery, "prior-intent"), { recursive: true });
    // Initial intent has no local issued markers (as uploaded before first PUT).
    const initialIntent = buildWarehouseRouteScopedPublishIntent({
      plan,
      attempt_id: attemptId,
      purpose: "publish",
    });
    persistWarehouseRouteScopedPublishIntent(recoveryIntentPath, initialIntent);
    assert.equal(initialIntent.shards.filter((s) => s.issued_at).length, 0);

    const ownership = mergeOwnershipFromIntentAndCheckpoints({
      intent: loadWarehouseRouteScopedPublishIntent(recoveryIntentPath),
      checkpoints,
    });
    assert.equal(ownership.status, "publish-owned-from-checkpoints");
    assert.equal(ownership.issued_count, 2);
    assert.equal(ownership.planned_unissued_keys.length, 1);
    assert.equal(ownership.planned_unissued_keys[0], plan.shards[2].key);
    // Possibly-issued stays UNKNOWN (no final ACK).
    for (const entry of Object.values(ownership.ledger.entries)) {
      assert.equal(entry.phase, "unknown");
      assert.ok(entry.issued_at);
    }

    const cleanupPlan = planWarehouseRouteScopedCleanup({
      deployed_revision: REVISION,
      owned_entries: ownership.ledger.entries,
      live_values: Object.fromEntries(Object.entries(ownership.owned_values)),
      active_revision: ROLLBACK_REVISION,
    });
    const cleanupRemote = fakeWrangler({ seed });
    const receipt = await cleanupWarehouseRouteScopedShards({
      plan: cleanupPlan,
      invoke: cleanupRemote.invoke,
      owned_values: ownership.owned_values,
      ledger: ownership.ledger,
    });
    assert.equal(receipt.decision, "cleaned");
    assert.equal(receipt.confirmed.shard_deletes, 2);
    assert.equal(cleanupRemote.values.size, 0);
    // Never-issued third key was never written and is not deleted.
    assert.equal(cleanupRemote.calls.filter((args) => args[2] === "delete").length, 2);
  } finally {
    rmSync(publisher, { recursive: true, force: true });
    rmSync(recovery, { recursive: true, force: true });
  }
});

test("checkpoint uploaded but PUT never sent: cleanup finds absent, deletes nothing foreign", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-checkpoint-no-put-"));
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  try {
    const attemptId = "attempt-checkpoint-no-put";
    const intent = buildWarehouseRouteScopedPublishIntent({
      plan,
      attempt_id: attemptId,
      purpose: "publish",
    });
    const shard = plan.shards[0];
    const checkpoint = buildIssuedCheckpoint({
      attempt_id: attemptId,
      route: shard.route,
      key: shard.key,
      deployed_revision: shard.deployed_revision,
      value: shard.value,
      value_sha256: shard.value_sha256,
      issued_at: "2026-10-19T16:05:00.000Z",
    });
    const ownership = mergeOwnershipFromIntentAndCheckpoints({
      intent,
      checkpoints: [checkpoint],
    });
    assert.equal(ownership.issued_count, 1);
    assert.equal(ownership.planned_unissued_keys.length, 2);

    // Key never made it to KV (PUT never sent). Foreign key is present.
    const foreignKey = plan.shards[1].key;
    const foreignValue = '{"foreign":true}';
    const cleanupPlan = planWarehouseRouteScopedCleanup({
      deployed_revision: REVISION,
      owned_entries: ownership.ledger.entries,
      live_values: {
        [shard.key]: null,
        [foreignKey]: foreignValue,
      },
      active_revision: ROLLBACK_REVISION,
    });
    const cleanupRemote = fakeWrangler({
      seed: new Map([[foreignKey, foreignValue]]),
    });
    const receipt = await cleanupWarehouseRouteScopedShards({
      plan: cleanupPlan,
      invoke: cleanupRemote.invoke,
      owned_values: ownership.owned_values,
      ledger: ownership.ledger,
    });
    // Owned key absent → already-clear; foreign key never owned → never deleted.
    assert.ok(["cleaned", "already-clean"].includes(receipt.decision));
    assert.equal(receipt.confirmed.shard_deletes, 0);
    assert.equal(cleanupRemote.values.get(foreignKey), foreignValue);
    assert.equal(cleanupRemote.calls.filter((args) => args[2] === "delete").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeOwnership refuses zero checkpoints and dry-run intent", () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const publishIntent = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: "attempt-no-checkpoints",
    purpose: "publish",
  });
  assert.throws(
    () => mergeOwnershipFromIntentAndCheckpoints({ intent: publishIntent, checkpoints: [] }),
    /no external per-key issued checkpoints/,
  );
  const dryRun = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: "attempt-dry",
    purpose: "dry-run",
  });
  assert.throws(
    () => mergeOwnershipFromIntentAndCheckpoints({
      intent: dryRun,
      checkpoints: [
        buildIssuedCheckpoint({
          attempt_id: "attempt-dry",
          route: plan.shards[0].route,
          key: plan.shards[0].key,
          deployed_revision: plan.shards[0].deployed_revision,
          value: plan.shards[0].value,
          value_sha256: plan.shards[0].value_sha256,
          issued_at: "2026-10-19T16:00:00.000Z",
        }),
      ],
    }),
    /purpose=dry-run/,
  );
});

test("cross-run dry-run readback verifies intent without provider writes", () => {
  const runA = mkdtempSync(join(tmpdir(), "cc06-dryrun-a-"));
  const runB = mkdtempSync(join(tmpdir(), "cc06-dryrun-b-"));
  try {
    const plan = planWarehouseRouteScopedPublication({
      deployed_revision: REVISION,
      materializations: tinyMaterializations(),
    });
    const intent = buildWarehouseRouteScopedPublishIntent({
      plan,
      attempt_id: "attempt-dry-run-a",
      purpose: "dry-run",
    });
    const intentPathA = join(runA, "publish-intent.json");
    persistWarehouseRouteScopedPublishIntent(intentPathA, intent);

    // Simulate cross-run artifact handoff: B only sees A's intent file.
    const intentPathB = join(runB, "prior-intent", "publish-intent.json");
    mkdirSync(join(runB, "prior-intent"), { recursive: true });
    writeFileSync(intentPathB, readFileSync(intentPathA, "utf8"));

    const loaded = loadWarehouseRouteScopedPublishIntent(intentPathB);
    assert.equal(loaded.purpose, "dry-run");
    const verification = verifyWarehouseRouteScopedPublishIntent(loaded, { plan });
    assert.equal(verification.status, "verified");
    assert.equal(verification.provider_writes, 0);
    assert.equal(verification.shard_count, 3);
    // Dry-run intent must not own cleanup.
    assert.throws(() => assertPublishOwnershipForCleanup(loaded), /purpose=dry-run/);
  } finally {
    rmSync(runA, { recursive: true, force: true });
    rmSync(runB, { recursive: true, force: true });
  }
});

const CLI = fileURLToPath(new URL("./warehouse_route_scoped_publication.mjs", import.meta.url));
const GO = "C6-abcdef12";

function runCli(args, { env = {}, expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CC06_PUBLISH_EXECUTE_CODE: GO,
      CC06_ALLOW_WINDOW_OVERLAP: "1",
      ...env,
    },
  });
  if (expectStatus === 0 && result.status !== 0) {
    throw new Error(
      `cli failed status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  if (expectStatus !== 0) {
    assert.notEqual(result.status, 0);
  } else {
    assert.equal(result.status, 0);
  }
  return result;
}

test("fixture-non-ownership-drill checkpoint is refused by cleanup ownership", () => {
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: REVISION,
    materializations: tinyMaterializations(),
  });
  const intent = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: "attempt-fixture-drill",
    purpose: "publish",
  });
  const shard = plan.shards[0];
  const fixture = buildFixtureNonOwnershipCheckpoint({
    attempt_id: "attempt-fixture-drill",
    route: shard.route,
    key: shard.key,
    deployed_revision: shard.deployed_revision,
    value: shard.value,
    value_sha256: shard.value_sha256,
    issued_at: "2026-10-19T17:00:00.000Z",
  });
  assert.equal(fixture.purpose, WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE);
  assert.equal(fixture.fixture_label, "cc06-fixture-non-ownership-drill");
  assert.throws(
    () => verifyIssuedCheckpoint(fixture, { intent }),
    /fixture-non-ownership-drill/,
  );
  assert.throws(
    () => mergeOwnershipFromIntentAndCheckpoints({ intent, checkpoints: [fixture] }),
    /fixture-non-ownership-drill|purpose/,
  );
});

test("real CLI entrypoints: write-issued-checkpoint → put-one → cleanup with offline KV", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-happy-"));
  const kv = join(dir, "kv");
  const store = join(dir, "checkpoint-store");
  mkdirSync(kv, { recursive: true });
  mkdirSync(store, { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const ledgerPath = join(dir, "ledger.json");
    const attemptId = "attempt-cli-happy";
    runCli([
      "prepare-intent",
      "--revision", REVISION,
      "--intent", intentPath,
      "--attempt-id", attemptId,
      "--out", join(dir, "prepare.json"),
    ]);
    // Promote purpose + baseline via probe-baseline against empty offline KV.
    runCli([
      "probe-baseline",
      "--revision", REVISION,
      "--intent", intentPath,
      "--attempt-id", attemptId,
      "--out", join(dir, "baseline-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });
    const baseline = JSON.parse(readFileSync(join(dir, "baseline-receipt.json"), "utf8"));
    assert.equal(baseline.attempted.kv_reads, 3);
    assert.equal(baseline.confirmed.kv_reads, 3);
    assert.equal(baseline.unknown.kv_reads, 0);

    for (const route of ["zap-bbl", "zap-project", "doing-business"]) {
      const checkpointPath = join(dir, "checkpoints", `${route}.json`);
      mkdirSync(join(dir, "checkpoints"), { recursive: true });
      runCli([
        "write-issued-checkpoint",
        "--revision", REVISION,
        "--intent", intentPath,
        "--ledger", ledgerPath,
        "--checkpoint", checkpointPath,
        "--route", route,
        "--attempt-id", attemptId,
        "--out", join(dir, `checkpoint-${route}-receipt.json`),
      ]);
      // Externalize before PUT (store dir simulates upload-artifact).
      copyFileSync(
        checkpointPath,
        join(store, `${issuedCheckpointArtifactName(route)}.json`),
      );
      runCli([
        "put-one",
        "--revision", REVISION,
        "--intent", intentPath,
        "--ledger", ledgerPath,
        "--checkpoint", checkpointPath,
        "--route", route,
        "--attempt-id", attemptId,
        "--out", join(dir, `put-${route}-receipt.json`),
      ], { env: { CC06_OFFLINE_KV_STORE: kv } });
      const putReceipt = JSON.parse(readFileSync(join(dir, `put-${route}-receipt.json`), "utf8"));
      assert.equal(putReceipt.decision, "put-one-acked");
      assert.equal(putReceipt.confirmed.shard_puts, 1);
      assert.equal(putReceipt.unknown.shard_puts, 0);
    }

    runCli([
      "assemble-attempt-receipt",
      "--artifact-dir", dir,
      "--out", join(dir, "receipt.json"),
    ]);
    const assembled = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    assert.equal(assembled.decision, "published");
    assert.deepEqual(assembled.planned, { kv_reads: 3, shard_puts: 3, shard_deletes: 0 });
    assert.deepEqual(assembled.attempted, { kv_reads: 3, shard_puts: 3, shard_deletes: 0 });
    assert.deepEqual(assembled.confirmed, { kv_reads: 3, shard_puts: 3, shard_deletes: 0 });
    assert.deepEqual(assembled.unknown, { kv_reads: 0, shard_puts: 0, shard_deletes: 0 });

    runCli([
      "cleanup",
      "--revision", REVISION,
      "--intent", intentPath,
      "--checkpoint-dir", store,
      "--ledger", join(dir, "cleanup-ledger.json"),
      "--active", ROLLBACK_REVISION,
      "--out", join(dir, "cleanup-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });
    const cleanup = JSON.parse(readFileSync(join(dir, "cleanup-receipt.json"), "utf8"));
    assert.equal(cleanup.decision, "cleaned");
    assert.equal(cleanup.confirmed.shard_deletes, 3);
    assert.ok(cleanup.confirmed.kv_reads >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI: PUT failure writes failed-attempt receipt; assemble keeps UNKNOWN", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-fail-"));
  const kv = join(dir, "kv");
  mkdirSync(kv, { recursive: true });
  mkdirSync(join(dir, "checkpoints"), { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const ledgerPath = join(dir, "ledger.json");
    const attemptId = "attempt-cli-fail";
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "prepare.json"),
    ]);
    runCli([
      "probe-baseline", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "baseline-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });

    const route = "zap-bbl";
    const checkpointPath = join(dir, "checkpoints", `${route}.json`);
    runCli([
      "write-issued-checkpoint", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, `checkpoint-${route}-receipt.json`),
    ]);
    runCli([
      "put-one", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, `put-${route}-receipt.json`),
    ], {
      env: { CC06_OFFLINE_KV_STORE: kv, CC06_OFFLINE_KV_FAIL_AT_PUT: "1" },
      expectStatus: 1,
    });
    const failed = JSON.parse(readFileSync(join(dir, `put-${route}-receipt.json`), "utf8"));
    assert.equal(failed.decision, "put-one-failed-attempt");
    assert.equal(failed.phase, "unknown");
    assert.equal(failed.attempted.shard_puts, 1);
    assert.equal(failed.confirmed.shard_puts, 0);
    assert.equal(failed.unknown.shard_puts, 1);
    assert.equal(failed.checkpoint_uploaded, true);
    assert.equal(failed.acknowledged_provider_writes_lower_bound, 0);
    assert.equal(failed.provider_write_outcome, "UNKNOWN");
    assert.equal(Object.hasOwn(failed, "provider_writes"), false);

    writeFileSync(join(dir, "attempt-id.txt"), `${attemptId}\n`);
    writeFileSync(join(dir, "revision.txt"), `${REVISION}\n`);
    runCli([
      "assemble-attempt-receipt", "--artifact-dir", dir, "--out", join(dir, "receipt.json"),
    ], { expectStatus: 1 });
    const assembled = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    assert.equal(assembled.decision, "publish-attempt-partial");
    assert.equal(assembled.attempted.kv_reads, 3);
    assert.equal(assembled.confirmed.kv_reads, 3);
    assert.equal(assembled.attempted.shard_puts, 1);
    assert.equal(assembled.confirmed.shard_puts, 0);
    assert.equal(assembled.unknown.shard_puts, 1);
    assert.equal(assembled.acknowledged_provider_writes_lower_bound, 0);
    assert.equal(assembled.provider_write_outcome, "UNKNOWN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI: dry-run intent refused by cleanup; fixture checkpoint refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-refuse-"));
  const kv = join(dir, "kv");
  mkdirSync(kv, { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    runCli([
      "dry-run", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", "attempt-dry-cli", "--out", join(dir, "dry.json"),
    ]);
    const fixtureDir = join(dir, "fixture-checkpoints");
    mkdirSync(fixtureDir, { recursive: true });
    const plan = planWarehouseRouteScopedPublication({
      deployed_revision: REVISION,
      materializations: tinyMaterializations(),
    });
    const shard = plan.shards[0];
    const fixture = buildFixtureNonOwnershipCheckpoint({
      attempt_id: "attempt-dry-cli",
      route: shard.route,
      key: shard.key,
      deployed_revision: shard.deployed_revision,
      value: shard.value,
      value_sha256: shard.value_sha256,
      issued_at: "2026-10-19T17:05:00.000Z",
    });
    persistIssuedCheckpoint(join(fixtureDir, "fixture.json"), fixture);

    runCli([
      "cleanup", "--revision", REVISION, "--intent", intentPath,
      "--checkpoint-dir", fixtureDir, "--out", join(dir, "cleanup.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv }, expectStatus: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI: write-fixture-checkpoint labels non-ownership and cleanup refuses it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-fixture-write-"));
  const kv = join(dir, "kv");
  mkdirSync(kv, { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", "attempt-fixture-cli", "--out", join(dir, "prepare.json"),
    ]);
    // Promote so refusal attributes to the fixture label, not purpose=prepare.
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    intent.purpose = "publish";
    writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

    const checkpointPath = join(dir, "checkpoints", "fixture.json");
    mkdirSync(join(dir, "checkpoints"), { recursive: true });
    const written = runCli([
      "write-fixture-checkpoint",
      "--revision", REVISION,
      "--checkpoint", checkpointPath,
      "--attempt-id", "attempt-fixture-cli",
      "--out", join(dir, "fixture-write.json"),
    ]);
    const receipt = JSON.parse(written.stdout);
    assert.equal(receipt.decision, "fixture-checkpoint-written");
    assert.equal(receipt.purpose, WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE);
    assert.equal(receipt.fixture_label, "cc06-fixture-non-ownership-drill");
    assert.equal(receipt.ownership, "none");
    assert.equal(receipt.provider_writes, 0);
    assert.equal(receipt.artifact_name, "cc06-fixture-non-ownership-drill");

    const onDisk = JSON.parse(readFileSync(checkpointPath, "utf8"));
    assert.equal(onDisk.purpose, WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE);
    assert.equal(onDisk.ownership, "none");

    const refused = runCli([
      "cleanup", "--revision", REVISION, "--intent", intentPath,
      "--checkpoint-dir", join(dir, "checkpoints"),
      "--out", join(dir, "cleanup.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv }, expectStatus: 1 });
    assert.match(String(refused.stderr || ""), /fixture-non-ownership-drill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI: foreign live value is left alone during cleanup from checkpoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-foreign-"));
  const kv = join(dir, "kv");
  const store = join(dir, "checkpoints-ext");
  mkdirSync(kv, { recursive: true });
  mkdirSync(store, { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const ledgerPath = join(dir, "ledger.json");
    const attemptId = "attempt-cli-foreign";
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "prepare.json"),
    ]);
    runCli([
      "probe-baseline", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "baseline-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });

    const route = "zap-bbl";
    const checkpointPath = join(dir, "checkpoints", `${route}.json`);
    mkdirSync(join(dir, "checkpoints"), { recursive: true });
    runCli([
      "write-issued-checkpoint", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, "checkpoint-receipt.json"),
    ]);
    copyFileSync(checkpointPath, join(store, `${issuedCheckpointArtifactName(route)}.json`));
    // Checkpoint uploaded; PUT truly never sent. Seed a foreign value under another key.
    const plan = planWarehouseRouteScopedPublication({
      deployed_revision: REVISION,
      materializations: tinyMaterializations(),
    });
    const foreign = plan.shards[1];
    writeFileSync(
      join(kv, Buffer.from(foreign.key).toString("base64url")),
      '{"foreign":true}',
      { mode: 0o600 },
    );

    runCli([
      "cleanup", "--revision", REVISION, "--intent", intentPath,
      "--checkpoint-dir", store, "--active", ROLLBACK_REVISION,
      "--out", join(dir, "cleanup-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });
    const cleanup = JSON.parse(readFileSync(join(dir, "cleanup-receipt.json"), "utf8"));
    assert.ok(["cleaned", "already-clean"].includes(cleanup.decision));
    assert.equal(cleanup.confirmed.shard_deletes, 0);
    assert.equal(
      readFileSync(join(kv, Buffer.from(foreign.key).toString("base64url")), "utf8"),
      '{"foreign":true}',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI (a): applied PUT + lost ACK → UNKNOWN then exact owned cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-lose-ack-"));
  const kv = join(dir, "kv");
  const store = join(dir, "checkpoint-store");
  mkdirSync(kv, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(join(dir, "checkpoints"), { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const ledgerPath = join(dir, "ledger.json");
    const attemptId = "attempt-cli-lose-ack";
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "prepare.json"),
    ]);
    runCli([
      "probe-baseline", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "baseline-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });

    const route = "zap-bbl";
    const checkpointPath = join(dir, "checkpoints", `${route}.json`);
    runCli([
      "write-issued-checkpoint", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, "checkpoint-receipt.json"),
    ]);
    copyFileSync(checkpointPath, join(store, `${issuedCheckpointArtifactName(route)}.json`));
    runCli([
      "put-one", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, `put-${route}-receipt.json`),
    ], {
      env: { CC06_OFFLINE_KV_STORE: kv, CC06_OFFLINE_KV_LOSE_ACK_AT_PUT: "1" },
      expectStatus: 1,
    });
    const failed = JSON.parse(readFileSync(join(dir, `put-${route}-receipt.json`), "utf8"));
    assert.equal(failed.decision, "put-one-failed-attempt");
    assert.equal(failed.provider_write_outcome, "UNKNOWN");
    assert.equal(failed.acknowledged_provider_writes_lower_bound, 0);
    assert.equal(failed.unknown.shard_puts, 1);
    // Provider applied the write even though ACK was lost — use checkpoint value.
    const checkpoint = loadIssuedCheckpoint(checkpointPath);
    assert.equal(
      readFileSync(join(kv, Buffer.from(checkpoint.key).toString("base64url")), "utf8"),
      checkpoint.value,
    );

    runCli([
      "cleanup", "--revision", REVISION, "--intent", intentPath,
      "--checkpoint-dir", store, "--active", ROLLBACK_REVISION,
      "--out", join(dir, "cleanup-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });
    const cleanup = JSON.parse(readFileSync(join(dir, "cleanup-receipt.json"), "utf8"));
    assert.equal(cleanup.decision, "cleaned");
    assert.equal(cleanup.confirmed.shard_deletes, 1);
    assert.equal(
      existsSync(join(kv, Buffer.from(checkpoint.key).toString("base64url"))),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI (b): die with checkpoint + no put receipt → artifact recovery clears owned value", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-die-no-receipt-"));
  const kv = join(dir, "kv");
  const store = join(dir, "checkpoint-store");
  mkdirSync(kv, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(join(dir, "checkpoints"), { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const ledgerPath = join(dir, "ledger.json");
    const attemptId = "attempt-cli-die-no-receipt";
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "prepare.json"),
    ]);
    runCli([
      "probe-baseline", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "baseline-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });

    const route = "zap-project";
    const checkpointPath = join(dir, "checkpoints", `${route}.json`);
    runCli([
      "write-issued-checkpoint", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, "checkpoint-receipt.json"),
    ]);
    copyFileSync(checkpointPath, join(store, `${issuedCheckpointArtifactName(route)}.json`));

    // Simulate: PUT applied at provider, process dies before writing put receipt.
    // Seed the exact owned checkpoint value (CLI materializations, not tiny fixtures).
    const checkpoint = loadIssuedCheckpoint(checkpointPath);
    writeFileSync(
      join(kv, Buffer.from(checkpoint.key).toString("base64url")),
      checkpoint.value,
      { mode: 0o600 },
    );

    writeFileSync(join(dir, "attempt-id.txt"), `${attemptId}\n`);
    writeFileSync(join(dir, "revision.txt"), `${REVISION}\n`);
    runCli([
      "assemble-attempt-receipt", "--artifact-dir", dir, "--out", join(dir, "receipt.json"),
    ], { expectStatus: 1 });
    const assembled = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    assert.equal(assembled.decision, "publish-attempt-partial");
    // Checkpoint without put receipt → possibly-issued UNKNOWN (not "PUT never sent").
    assert.equal(assembled.attempted.shard_puts, 0);
    assert.equal(assembled.confirmed.shard_puts, 0);
    assert.equal(assembled.unknown.shard_puts, 1);
    assert.deepEqual(assembled.possibly_issued_routes, [route]);
    assert.equal(assembled.acknowledged_provider_writes_lower_bound, 0);
    assert.equal(assembled.provider_write_outcome, "UNKNOWN");

    runCli([
      "cleanup", "--revision", REVISION, "--intent", intentPath,
      "--checkpoint-dir", store, "--active", ROLLBACK_REVISION,
      "--out", join(dir, "cleanup-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });
    const cleanup = JSON.parse(readFileSync(join(dir, "cleanup-receipt.json"), "utf8"));
    assert.equal(cleanup.decision, "cleaned");
    assert.equal(cleanup.confirmed.shard_deletes, 1);
    assert.equal(existsSync(join(kv, Buffer.from(checkpoint.key).toString("base64url"))), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI (c): GET timeout on probe-baseline is UNKNOWN, not confirmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-get-timeout-"));
  const kv = join(dir, "kv");
  mkdirSync(kv, { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const attemptId = "attempt-cli-get-timeout";
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "prepare.json"),
    ]);
    runCli([
      "probe-baseline", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "baseline-receipt.json"),
    ], {
      env: { CC06_OFFLINE_KV_STORE: kv, CC06_OFFLINE_KV_FAIL_AT_GET: "2" },
      expectStatus: 2,
    });
    const baseline = JSON.parse(readFileSync(join(dir, "baseline-receipt.json"), "utf8"));
    assert.equal(baseline.decision, "baseline-blocked");
    assert.equal(baseline.attempted.kv_reads, 3);
    assert.equal(baseline.confirmed.kv_reads, 2);
    assert.equal(baseline.unknown.kv_reads, 1);
    assert.equal(baseline.baseline_absence.unknown_kv_reads, 1);
    assert.equal(baseline.baseline_absence.confirmed_kv_reads, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI (d): checkpoint without PUT stays possibly-issued until absent readback; foreign held", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc06-cli-possibly-issued-"));
  const kv = join(dir, "kv");
  const store = join(dir, "checkpoint-store");
  mkdirSync(kv, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(join(dir, "checkpoints"), { recursive: true });
  try {
    const intentPath = join(dir, "publish-intent.json");
    const ledgerPath = join(dir, "ledger.json");
    const attemptId = "attempt-cli-possibly-issued";
    runCli([
      "prepare-intent", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "prepare.json"),
    ]);
    runCli([
      "probe-baseline", "--revision", REVISION, "--intent", intentPath,
      "--attempt-id", attemptId, "--out", join(dir, "baseline-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });

    const route = "doing-business";
    const checkpointPath = join(dir, "checkpoints", `${route}.json`);
    runCli([
      "write-issued-checkpoint", "--revision", REVISION, "--intent", intentPath,
      "--ledger", ledgerPath, "--checkpoint", checkpointPath, "--route", route,
      "--attempt-id", attemptId, "--out", join(dir, "checkpoint-receipt.json"),
    ]);
    copyFileSync(checkpointPath, join(store, `${issuedCheckpointArtifactName(route)}.json`));
    // PUT truly never sent. Seed a foreign value under a different key.
    const plan = planWarehouseRouteScopedPublication({
      deployed_revision: REVISION,
      materializations: tinyMaterializations(),
    });
    const foreign = plan.shards.find((s) => s.route === "zap-bbl");
    writeFileSync(
      join(kv, Buffer.from(foreign.key).toString("base64url")),
      '{"foreign":true}',
      { mode: 0o600 },
    );

    writeFileSync(join(dir, "attempt-id.txt"), `${attemptId}\n`);
    writeFileSync(join(dir, "revision.txt"), `${REVISION}\n`);
    runCli([
      "assemble-attempt-receipt", "--artifact-dir", dir, "--out", join(dir, "receipt.json"),
    ], { expectStatus: 1 });
    const assembled = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
    assert.equal(assembled.unknown.shard_puts, 1);
    assert.equal(assembled.attempted.shard_puts, 0);
    assert.equal(assembled.confirmed.shard_puts, 0);
    assert.deepEqual(assembled.possibly_issued_routes, [route]);
    assert.equal(assembled.provider_write_outcome, "UNKNOWN");

    runCli([
      "cleanup", "--revision", REVISION, "--intent", intentPath,
      "--checkpoint-dir", store, "--active", ROLLBACK_REVISION,
      "--out", join(dir, "cleanup-receipt.json"),
    ], { env: { CC06_OFFLINE_KV_STORE: kv } });
    const cleanup = JSON.parse(readFileSync(join(dir, "cleanup-receipt.json"), "utf8"));
    // Owned key absent on readback → already-clear; foreign never owned → held.
    assert.ok(["cleaned", "already-clean"].includes(cleanup.decision));
    assert.equal(cleanup.confirmed.shard_deletes, 0);
    assert.equal(
      readFileSync(join(kv, Buffer.from(foreign.key).toString("base64url")), "utf8"),
      '{"foreign":true}',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
