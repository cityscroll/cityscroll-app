import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";
import { publishBounded, planBatches, renderBatch } from "../tools/d1_bounded_publisher.mjs";
import { planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import { abandonGeneration, claimGeneration, createMemoryStateStore } from "../tools/d1_generation_fence.mjs";
import { loadManifest, modelEntry } from "../tools/d1_manifest.mjs";
import { buildPublicationReceipt } from "../tools/d1_publication_receipt.mjs";
import { runProductionDelta } from "../tools/d1_production_delta.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/d1-production-delta/sources.json"), "utf8"));
const manifest = loadManifest();
const fingerprint = "b".repeat(64);

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

function openDatabase(sources = fixture.prior) {
  const db = new DatabaseSync(":memory:");
  for (const migration of ["0025_search_and_ocp_read_models.sql", "0026_entity_intelligence_read_model.sql", "0031_d1_publication_batches.sql"]) {
    db.exec(readFileSync(join(ROOT, "worker/migrations", migration), "utf8"));
  }
  for (const entry of manifest.models) db.exec(statementsForModel(entry, sources[entry.model_id], { mode: "rebuild" }).sql);
  return db;
}

function databaseAdapter(db, { loseConfirmationOnce = false, corruptTable = null } = {}) {
  let confirmationLost = false;
  const executions = [];
  const adapter = {
    executions,
    async execute(sql, batch) {
      executions.push(batch.batch_id);
      db.exec("BEGIN;");
      try {
        db.exec(sql);
        db.prepare(`INSERT INTO d1_publication_batches
          (batch_id, checkpoint_id, generation, fingerprint, model_id, partition_id, ordinal, op_count, estimated_application_writes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(batch.batch_id, `${fingerprint}:${batch.model_id}:${batch.partition}:${batch.ordinal}`, Number(batch.batch_id.split(":", 1)[0]), fingerprint, batch.model_id, batch.partition, batch.ordinal, batch.op_count, batch.estimated_writes);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
      if (loseConfirmationOnce && !confirmationLost) {
        confirmationLost = true;
        const error = new Error("simulated timeout after D1 committed the batch");
        error.transient = true;
        throw error;
      }
    },
    async has(batchId, batch = null) {
      const checkpointId = batch ? `${fingerprint}:${batch.model_id}:${batch.partition}:${batch.ordinal}` : batchId;
      return Boolean(db.prepare("SELECT 1 FROM d1_publication_batches WHERE checkpoint_id = ?").get(checkpointId));
    },
    async select(sql, params = []) {
      if (corruptTable && sql.includes(corruptTable)) {
        db.exec("UPDATE ocp_awards_warehouse SET vendor_name = 'corrupt' WHERE request_id = 'r1'");
        corruptTable = null;
      }
      return db.prepare(sql).all(...params);
    },
  };
  return adapter;
}

async function claimed(snapshot, holder = "production-fixture") {
  const fenceStore = createMemoryStateStore();
  const claim = await claimGeneration({ fenceStore, store: fenceStore, holder, fingerprint, watermarks: watermarksFromSnapshot(snapshot), leaseMs: 60_000 });
  return { fenceStore, generation: claim.generation, holder };
}

const policy = {
  schema: "cityscroll.d1-release-policy.v1",
  canary: { max_partitions: 3, max_rows: 200 },
  reconcile: { max_partitions: 25, max_rows: 5000 },
  abort_threshold: { max_findings: 25 }
};

test("every ordinary production model declares delta-upsert publication", () => {
  assert.ok(manifest.models.every((model) => model.publication_mode === "delta_upsert"));
});

test("production delta applies keyed inserts, updates, explicit deletes, and no whole-table rebuild", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const { fenceStore, generation, holder } = await claimed(currentSnapshot);
  const db = openDatabase();
  const adapter = databaseAdapter(db);
  const result = await runProductionDelta({
    priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
    manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, maxOpsPerBatch: 2,
  });

  assert.equal(result.outcome, "published");
  assert.equal(result.canaryEvidence.status, "passed");
  assert.equal(result.reconcileReport.consistent, true);
  assert.ok(result.batchPlan.batches.length > 1);
  assert.ok(result.batchPlan.batches.every((batch) => batch.ops.every((op) => op.kind !== "truncate")));
  assert.ok(result.plan.models.some((model) => model.totals.insert > 0 && model.totals.update > 0 && model.totals.delete > 0));
  const keyword = result.plan.models.find((model) => model.model_id === "keyword_search");
  const unchangedFts = keyword.partitions.flatMap((part) => part.ops.update).filter((op) => op.table === "keyword_search_fts" && op.key.includes("notice:a2"));
  assert.deepEqual(unchangedFts, [], "an unchanged parent leaves its FTS companion untouched");
  assert.equal(new Set(adapter.executions).size, adapter.executions.length, "canary batches are not replayed by the wide phase");

  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "fixture", attempt: 1 },
    outcome: result.outcome, reason: result.reason, deployFingerprint: fingerprint,
    generation, snapshot: currentSnapshot, batchPlan: result.batchPlan,
    publishReceipt: result.publishReceipt, canaryEvidence: result.canaryEvidence,
    reconcileReport: result.reconcileReport,
  });
  assert.equal(receipt.generation, generation);
  assert.equal(receipt.deploy_fingerprint, fingerprint);
  assert.equal(receipt.totals.estimated_writes, receipt.totals.observed_writes);
  assert.ok(receipt.models.every((model) => model.delta_counts && model.batch_count !== null));
});

test("an unchanged snapshot is a zero-write skip", { skip: !DatabaseSync }, async () => {
  const snapshot = snapshotFor(manifest, fixture.prior);
  const { fenceStore, generation, holder } = await claimed(snapshot);
  const adapter = databaseAdapter(openDatabase());
  const result = await runProductionDelta({
    priorSnapshot: snapshot, currentSnapshot: snapshot, manifest, sourceDocuments: fixture.prior,
    generation, fingerprint, holder, fenceStore, adapter, appliedBatchStore: adapter, policy,
  });
  assert.equal(result.outcome, "skipped");
  assert.equal(result.batchPlan.summary.total_ops, 0);
  assert.deepEqual(adapter.executions, []);
});

test("a stale generation is rejected before the first mutation", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const { fenceStore, generation, holder } = await claimed(currentSnapshot, "stale-holder");
  await claimGeneration({ store: fenceStore, holder: "new-holder", fingerprint, watermarks: watermarksFromSnapshot(currentSnapshot), now: Date.now() + 120_000, leaseMs: 60_000 });
  const adapter = databaseAdapter(openDatabase());
  const result = await runProductionDelta({
    priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
    manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
    fenceStore, adapter, appliedBatchStore: adapter, policy,
  });
  assert.equal(result.outcome, "abandoned");
  assert.deepEqual(adapter.executions, []);
});

test("an interrupted batch is recovered from its atomic marker without replay", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const { fenceStore, generation, holder } = await claimed(currentSnapshot);
  const adapter = databaseAdapter(openDatabase(), { loseConfirmationOnce: true });
  const result = await runProductionDelta({
    priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
    manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, maxOpsPerBatch: 1,
  });
  assert.equal(result.outcome, "published");
  assert.equal(new Set(adapter.executions).size, adapter.executions.length);
  assert.ok(result.publishReceipt.completed_batches.some((batch) => batch.recovered === true));
});

test("a replacement generation resumes durable batches without replay", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const priorSnapshot = snapshotFor(manifest, fixture.prior);
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });
  const { fenceStore, generation, holder } = await claimed(currentSnapshot, "interrupted-holder");
  const adapter = databaseAdapter(openDatabase());
  const firstPlan = planBatches({ plan, manifest, sourceDocuments: fixture.current, generation, maxOpsPerBatch: 1 });
  let successfulBatches = 0;
  const interruptedExecutor = {
    async execute(sql, batch) {
      if (successfulBatches === 2) throw new Error("simulated runner termination");
      successfulBatches += 1;
      return adapter.execute(sql, batch);
    },
  };
  const interrupted = await publishBounded({
    batchPlan: firstPlan, manifest, fenceStore, holder, fingerprint,
    executor: interruptedExecutor, appliedBatchStore: adapter, maxAttempts: 1,
  });
  assert.equal(interrupted.status, "stopped_permanent_error");
  assert.equal(adapter.executions.length, 2);

  await abandonGeneration({ store: fenceStore, generation, holder, fingerprint });
  const replacementHolder = "replacement-holder";
  const replacement = await claimGeneration({
    store: fenceStore, holder: replacementHolder, fingerprint,
    watermarks: watermarksFromSnapshot(currentSnapshot), leaseMs: 60_000,
  });
  const replacementPlan = planBatches({
    plan, manifest, sourceDocuments: fixture.current,
    generation: replacement.generation, maxOpsPerBatch: 1,
  });
  const resumed = await publishBounded({
    batchPlan: replacementPlan, manifest, fenceStore, holder: replacementHolder,
    fingerprint, executor: adapter, appliedBatchStore: adapter,
  });

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.completed_batches.filter((batch) => batch.recovered).length, 2);
  assert.equal(adapter.executions.length, replacementPlan.batches.length);
  assert.equal(new Set(adapter.executions).size, adapter.executions.length);
});

test("canary and reconciliation failures are terminal and block publication", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  for (const failure of ["canary", "reconcile"]) {
    const { fenceStore, generation, holder } = await claimed(currentSnapshot, `${failure}-holder`);
    const db = openDatabase();
    const adapter = databaseAdapter(db, { corruptTable: failure === "reconcile" ? "ocp_awards_warehouse" : null });
    if (failure === "canary") {
      const original = adapter.execute.bind(adapter);
      adapter.execute = async (sql, batch) => original(sql.split("\n").filter((line) => !line.includes("keyword_search_fts")).join("\n"), batch);
    }
    const result = await runProductionDelta({
      priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
      manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
      fenceStore, adapter, appliedBatchStore: adapter,
      policy: failure === "reconcile" ? { ...policy, canary: { max_partitions: 1, max_rows: 200 } } : policy,
      maxOpsPerBatch: 2,
    });
    assert.notEqual(result.outcome, "published", `${failure} failure cannot publish`);
    if (failure === "canary") assert.equal(result.canaryEvidence.status, "failed");
    else assert.equal(result.reconcileReport.consistent, false);
  }
});

test("the ordinary workflow uses the production delta runner and contains no whole-model SQL fallback", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const ordinary = workflow.slice(workflow.indexOf("- name: Plan D1 publication delta"), workflow.indexOf("- name: Record D1 publication receipt"));
  assert.match(ordinary, /d1_production_delta\.mjs execute/);
  assert.doesNotMatch(ordinary, /build_worker_d1_read_models|keyword_search_read_model\.sql|ocp_awards_read_model\.sql|entity_intelligence_read_model\.sql|--mode\s+rebuild/);
  assert.match(ordinary, /d1_delta_plan\.mjs plan/);
  assert.match(ordinary, /d1_bounded_publisher/);
  assert.match(ordinary, /d1_canary/);
  assert.match(ordinary, /d1_reconcile/);
});

test("the Wrangler adapter commits the application SQL and checkpoint marker in one import", async () => {
  const { createWranglerD1PublicationAdapter } = await import("../tools/d1_production_delta.mjs");
  let imported = "";
  const adapter = createWranglerD1PublicationAdapter({
    database: "fixture-db", generation: 4, fingerprint,
    run: async (args) => {
      const fileIndex = args.indexOf("--file");
      if (fileIndex >= 0) {
        imported = readFileSync(args[fileIndex + 1], "utf8");
        return { stdout: "" };
      }
      return { stdout: JSON.stringify([{ success: true, results: [{ checkpoint_id: `${fingerprint}:model:part:0` }] }]) };
    },
  });
  const batch = {
    batch_id: "4:model:part:0", model_id: "model", partition: "part", ordinal: 0,
    op_count: 1, estimated_writes: 1,
  };
  await adapter.execute("UPDATE sample SET value = 'new' WHERE id = 'one';", batch);
  assert.match(imported, /UPDATE sample/);
  assert.match(imported, /INSERT INTO d1_publication_batches/);
  assert.ok(imported.indexOf("UPDATE sample") < imported.indexOf("INSERT INTO d1_publication_batches"));
  assert.equal(await adapter.has(batch.batch_id, batch), true);
});
