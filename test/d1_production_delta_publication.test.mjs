import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";
import { publishBounded, planBatches, renderBatch } from "../tools/d1_bounded_publisher.mjs";
import { planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import { abandonGeneration, claimGeneration, completeGeneration, createMemoryStateStore } from "../tools/d1_generation_fence.mjs";
import { loadManifest, modelEntry } from "../tools/d1_manifest.mjs";
import { buildPublicationReceipt } from "../tools/d1_publication_receipt.mjs";
import {
  MISSING_SNAPSHOT_REBUILD_REASON,
  NO_DELTA_SNAPSHOT_BASELINE_REASON,
  applicationCheckpointId,
  buildMissingPriorSnapshotRecovery,
  formatCliFailureMessage,
  resolvePriorSnapshotBaseline,
  runMissingSnapshotRecovery,
  runProductionDelta,
  snapshotKeyForGeneration,
} from "../tools/d1_production_delta.mjs";
import { tableRows } from "../tools/d1_stable_keys.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/d1-production-delta/sources.json"), "utf8"));
const missingSnapshotFixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/d1-production-delta/published-state-missing-snapshot.json"), "utf8"));
const claimedNoBaselineFixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/d1-production-delta/published-state-claimed-no-baseline.json"), "utf8"));
const manifest = loadManifest();
const fingerprint = "b".repeat(64);
const CLOCK = Date.parse("2026-09-12T12:00:00Z");
const clock = () => CLOCK;

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

function databaseAdapter(db, {
  loseConfirmationOnce = false,
  corruptTable = null,
  generation,
  holder = "production-fixture",
} = {}) {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("databaseAdapter requires a positive generation");
  }
  if (typeof holder !== "string" || holder.length === 0) {
    throw new Error("databaseAdapter requires a non-empty holder");
  }
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
          .run(
            batch.batch_id,
            applicationCheckpointId(fingerprint, batch, { generation, holder }),
            generation,
            fingerprint,
            batch.model_id,
            batch.partition,
            batch.ordinal,
            batch.op_count,
            batch.estimated_writes,
          );
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
      const checkpointId = batch
        ? applicationCheckpointId(fingerprint, batch, { generation, holder })
        : batchId;
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
  const claim = await claimGeneration({ fenceStore, store: fenceStore, holder, fingerprint, watermarks: watermarksFromSnapshot(snapshot), now: clock(), leaseMs: 60_000 });
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

test("a published pointer with an absent prior KV snapshot records explicit-rebuild recovery", () => {
  const recovery = buildMissingPriorSnapshotRecovery(missingSnapshotFixture);
  assert.deepEqual(recovery, {
    schema: "cityscroll.d1-publication-recovery.v1",
    status: "bootstrap_required",
    action: "explicit_rebuild",
    reason: "published_snapshot_missing",
    published_generation: 20,
    snapshot_key: "d1-publication:snapshot:v2:20",
    baseline: { status: "unavailable", source: "missing_kv_snapshot" },
    d1_writes: { commands: null, rows: null },
  });
  assert.equal(buildMissingPriorSnapshotRecovery({
    ...missingSnapshotFixture,
    kv_error: "Error: Cloudflare API unavailable (503)",
  }), null, "non-404 failures must still fail the deployment");
});

test("classifies Wrangler's colon-form missing snapshot error for the published generation", () => {
  for (const kv_error of [
    "Failed to fetch https://api.cloudflare.com/.../values/<key> - 404: Not Found",
    "Failed to fetch https://api.cloudflare.com/.../values/<key> - 404",
  ]) {
    const recovery = buildMissingPriorSnapshotRecovery({ ...missingSnapshotFixture, kv_error });
    assert.equal(recovery?.reason, "published_snapshot_missing");
    assert.equal(recovery?.published_generation, missingSnapshotFixture.published_state.generation);
    assert.equal(recovery?.snapshot_key, "d1-publication:snapshot:v2:20");
  }
});

test("claimed fence with no published baseline routes prior-snapshot-key to missing recovery", () => {
  // Exact state from Deploy worker 36858881507 / follow-on failure 36862666147:
  // generation 21 left claimed after 0032 failed, so prior-snapshot-key must not exit 1.
  const state = claimedNoBaselineFixture.published_state;
  assert.equal(state.status, "claimed");
  assert.equal(state.generation, 21);

  const resolved = resolvePriorSnapshotBaseline(state);
  assert.equal(resolved.status, "missing");
  assert.equal(resolved.generation, 21);
  assert.equal(resolved.snapshot_key, "d1-publication:snapshot:v2:21");
  assert.equal(resolved.recovery?.reason, NO_DELTA_SNAPSHOT_BASELINE_REASON);
  assert.equal(resolved.recovery?.observed_fence_status, "claimed");
  assert.equal(resolved.recovery?.status, "bootstrap_required");
  assert.equal(resolved.recovery?.action, "explicit_rebuild");

  const tempDir = mkdtempSync(join(tmpdir(), "d1-no-baseline-"));
  const statePath = join(tempDir, "published.json");
  const baselineOut = join(tempDir, "baseline.json");
  const recoveryOut = join(tempDir, "recovery.json");
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, "tools/d1_production_delta.mjs"),
        "prior-snapshot-key",
        "--state", statePath,
        "--baseline-out", baselineOut,
        "--recovery-out", recoveryOut,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `prior-snapshot-key must exit 0 for claimed baseline:\n${result.stderr}`);
    assert.match(result.stderr, /no delta snapshot baseline/);
    assert.equal(result.stdout.trim(), "");
    const baseline = JSON.parse(readFileSync(baselineOut, "utf8"));
    assert.equal(baseline.status, "missing");
    assert.equal(baseline.observed_fence_status, "claimed");
    const recovery = JSON.parse(readFileSync(recoveryOut, "utf8"));
    assert.equal(recovery.reason, NO_DELTA_SNAPSHOT_BASELINE_REASON);
    assert.equal(recovery.published_generation, 21);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI failure message names outcome, reason, and fence detail for silent recover exits", () => {
  // Deploy worker 36877675700 exited recover-missing-snapshot with code 1 and an
  // empty step log; the generation_not_held fence lived only in artifacts.
  const message = formatCliFailureMessage("recover-missing-snapshot", {
    outcome: "abandoned",
    reason: "generation 23 is fenced by generation 22 before batch 23:entity_intelligence:__model__:0 (generation_not_held)",
    publishReceipt: {
      fence: {
        reason: "generation_not_held",
        current_generation: 22,
        current_holder: "Deploy worker:36872149742:1",
        current_status: "abandoned",
      },
    },
  }, { generation: 23 });
  assert.match(message, /recover-missing-snapshot/);
  assert.match(message, /outcome=abandoned/);
  assert.match(message, /generation_not_held/);
  assert.match(message, /current_generation=22/);
  assert.match(message, /current_holder=Deploy worker:36872149742:1/);
  assert.match(message, /generation=23/);
  assert.equal(message.endsWith("\n"), true);
});

test("applicationCheckpointId scopes markers to generation and holder", () => {
  const batch = { model_id: "entity_intelligence", partition: "__model__", ordinal: 0 };
  const gen27 = applicationCheckpointId(fingerprint, batch, { generation: 27, holder: "Deploy worker:36921583269:1" });
  const gen28 = applicationCheckpointId(fingerprint, batch, { generation: 28, holder: "Deploy worker:36933227439:1" });
  assert.equal(gen27, `27:Deploy worker:36921583269:1:${fingerprint}:entity_intelligence:__model__:0`);
  assert.equal(gen28, `28:Deploy worker:36933227439:1:${fingerprint}:entity_intelligence:__model__:0`);
  assert.notEqual(gen27, gen28);
  assert.notEqual(
    applicationCheckpointId(fingerprint, batch, { generation: 28, holder: "holder-a" }),
    applicationCheckpointId(fingerprint, batch, { generation: 28, holder: "holder-b" }),
  );
  assert.throws(
    () => applicationCheckpointId(fingerprint, batch, { generation: 28 }),
    /non-empty holder/,
  );
  assert.throws(
    () => applicationCheckpointId(fingerprint, batch, { holder: "h" }),
    /positive generation/,
  );
});

test("production delta applies keyed inserts, updates, explicit deletes, and no whole-table rebuild", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const { fenceStore, generation, holder } = await claimed(currentSnapshot);
  const db = openDatabase();
  const adapter = databaseAdapter(db, { generation, holder });
  const result = await runProductionDelta({
    priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
    manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, maxOpsPerBatch: 2, now: clock,
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
  const adapter = databaseAdapter(openDatabase(), { generation, holder });
  const result = await runProductionDelta({
    priorSnapshot: snapshot, currentSnapshot: snapshot, manifest, sourceDocuments: fixture.prior,
    generation, fingerprint, holder, fenceStore, adapter, appliedBatchStore: adapter, policy, now: clock,
  });
  assert.equal(result.outcome, "skipped");
  assert.equal(result.batchPlan.summary.total_ops, 0);
  assert.deepEqual(adapter.executions, []);
});

test("A13: one changed partition converges on a no-op rerun without duplicate logical rows", { skip: !DatabaseSync }, async () => {
  const prior = structuredClone(fixture.prior);
  const current = structuredClone(prior);
  current.keyword_search.families.alpha = {
    ...current.keyword_search.families.alpha,
    as_of: "2026-09-11T00:00:00Z",
    documents: [
      { ...current.keyword_search.families.alpha.documents[0], title: "Alpha hearing revised" },
      current.keyword_search.families.alpha.documents[1],
    ],
  };
  const priorSnapshot = snapshotFor(manifest, prior);
  const currentSnapshot = snapshotFor(manifest, current);
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });
  const changed = plan.models.flatMap((model) => model.partitions
    .filter((partition) => partition.counts.total_ops > 0)
    .map((partition) => ({ model_id: model.model_id, ...partition })));
  assert.deepEqual(changed.map(({ model_id, partition }) => `${model_id}:${partition}`), ["keyword_search:alpha"]);
  assert.ok(plan.models.every((model) => model.partitions
    .filter((partition) => `${model.model_id}:${partition.partition}` !== "keyword_search:alpha")
    .every((partition) => partition.counts.total_ops === 0)));

  const { fenceStore, generation, holder } = await claimed(currentSnapshot, "a13-first-run");
  const db = openDatabase(prior);
  const adapter = databaseAdapter(db, { generation, holder });
  const first = await runProductionDelta({
    priorSnapshot, currentSnapshot, manifest, sourceDocuments: current,
    generation, fingerprint, holder, fenceStore, adapter, appliedBatchStore: adapter, policy,
    maxOpsPerBatch: 2, now: clock,
  });
  assert.equal(first.outcome, "published");

  const rerunClaim = await claimed(currentSnapshot, "a13-no-op-rerun");
  const rerunAdapter = databaseAdapter(db, { generation: rerunClaim.generation, holder: rerunClaim.holder });
  const rerun = await runProductionDelta({
    priorSnapshot: currentSnapshot, currentSnapshot, manifest, sourceDocuments: current,
    generation: rerunClaim.generation, fingerprint, holder: rerunClaim.holder,
    fenceStore: rerunClaim.fenceStore, adapter: rerunAdapter, appliedBatchStore: rerunAdapter, policy, now: clock,
  });
  assert.equal(rerun.outcome, "skipped");
  assert.equal(rerun.batchPlan.summary.total_ops, 0);

  for (const entry of manifest.models) {
    const expected = tableRows(entry, current[entry.model_id]).rows;
    for (const table of entry.tables) {
      const expectedCount = expected.filter((row) => row.table === table.name).length;
      const actualCount = db.prepare(`SELECT COUNT(*) AS count FROM ${table.name}`).get().count;
      assert.equal(actualCount, expectedCount, `${entry.model_id}/${table.name} has no duplicate logical rows`);
    }
  }
});

test("a stale generation is rejected before the first mutation", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const { fenceStore, generation, holder } = await claimed(currentSnapshot, "stale-holder");
  const afterLeaseExpiry = () => CLOCK + 120_000;
  await claimGeneration({ store: fenceStore, holder: "new-holder", fingerprint, watermarks: watermarksFromSnapshot(currentSnapshot), now: afterLeaseExpiry(), leaseMs: 60_000 });
  const adapter = databaseAdapter(openDatabase(), { generation, holder });
  const result = await runProductionDelta({
    priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
    manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, now: afterLeaseExpiry,
  });
  assert.equal(result.outcome, "abandoned");
  assert.deepEqual(adapter.executions, []);
});

test("an interrupted batch is recovered from its atomic marker without replay", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const { fenceStore, generation, holder } = await claimed(currentSnapshot);
  const adapter = databaseAdapter(openDatabase(), { loseConfirmationOnce: true, generation, holder });
  const result = await runProductionDelta({
    priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
    manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, maxOpsPerBatch: 1, now: clock,
  });
  assert.equal(result.outcome, "published");
  assert.equal(new Set(adapter.executions).size, adapter.executions.length);
  assert.ok(result.publishReceipt.completed_batches.some((batch) => batch.recovered === true));
});

test("a replacement generation re-executes batches; prior-generation markers do not skip", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const priorSnapshot = snapshotFor(manifest, fixture.prior);
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });
  const { fenceStore, generation, holder } = await claimed(currentSnapshot, "interrupted-holder");
  const db = openDatabase();
  const adapter = databaseAdapter(db, { generation, holder });
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
    executor: interruptedExecutor, appliedBatchStore: adapter, maxAttempts: 1, now: clock,
  });
  assert.equal(interrupted.status, "stopped_permanent_error");
  assert.equal(adapter.executions.length, 2);

  await abandonGeneration({ store: fenceStore, generation, holder, fingerprint, now: clock() });
  const replacementHolder = "replacement-holder";
  const replacement = await claimGeneration({
    store: fenceStore, holder: replacementHolder, fingerprint,
    watermarks: watermarksFromSnapshot(currentSnapshot), now: clock(), leaseMs: 60_000,
  });
  const replacementPlan = planBatches({
    plan, manifest, sourceDocuments: fixture.current,
    generation: replacement.generation, maxOpsPerBatch: 1,
  });
  const nextAdapter = databaseAdapter(db, { generation: replacement.generation, holder: replacementHolder });
  const resumed = await publishBounded({
    batchPlan: replacementPlan, manifest, fenceStore, holder: replacementHolder,
    fingerprint, executor: nextAdapter, appliedBatchStore: nextAdapter, now: clock,
  });

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.completed_batches.filter((batch) => batch.recovered).length, 0);
  assert.equal(nextAdapter.executions.length, replacementPlan.batches.length);
  assert.equal(new Set(nextAdapter.executions).size, nextAdapter.executions.length);
});

test("canary and reconciliation failures are terminal and block publication", { skip: !DatabaseSync }, async () => {
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  for (const failure of ["canary", "reconcile"]) {
    const { fenceStore, generation, holder } = await claimed(currentSnapshot, `${failure}-holder`);
    const db = openDatabase();
    const adapter = databaseAdapter(db, {
      generation,
      holder,
      corruptTable: failure === "reconcile" ? "ocp_awards_warehouse" : null,
    });
    if (failure === "canary") {
      const original = adapter.execute.bind(adapter);
      adapter.execute = async (sql, batch) => original(sql.split("\n").filter((line) => !line.includes("keyword_search_fts")).join("\n"), batch);
    }
    const result = await runProductionDelta({
      priorSnapshot: snapshotFor(manifest, fixture.prior), currentSnapshot,
      manifest, sourceDocuments: fixture.current, generation, fingerprint, holder,
      fenceStore, adapter, appliedBatchStore: adapter,
      policy: failure === "reconcile" ? { ...policy, canary: { max_partitions: 1, max_rows: 200 } } : policy,
      maxOpsPerBatch: 2, now: clock,
    });
    assert.notEqual(result.outcome, "published", `${failure} failure cannot publish`);
    if (failure === "canary") assert.equal(result.canaryEvidence.status, "failed");
    else assert.equal(result.reconcileReport.consistent, false);
  }
});

test("the ordinary workflow uses the production delta runner and contains no whole-model SQL fallback", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const ordinary = workflow.slice(
    workflow.indexOf("- name: Plan D1 publication delta"),
    workflow.indexOf("- name: Recover missing D1 publication snapshot"),
  );
  assert.match(workflow, /id: d1-prior-snapshot/);
  assert.match(workflow, /classify-prior-snapshot-failure/);
  assert.match(workflow, /status=missing/);
  assert.match(ordinary, /steps\.d1-prior-snapshot\.outputs\.status == 'available'/);
  assert.match(ordinary, /d1_production_delta\.mjs execute/);
  assert.doesNotMatch(ordinary, /build_worker_d1_read_models|keyword_search_read_model\.sql|ocp_awards_read_model\.sql|entity_intelligence_read_model\.sql|--mode\s+rebuild|recover-missing-snapshot/);
  assert.match(ordinary, /d1_delta_plan\.mjs plan/);
  assert.match(ordinary, /d1_bounded_publisher/);
  assert.match(ordinary, /d1_canary/);
  assert.match(ordinary, /d1_reconcile/);
});

test("a missing prior snapshot recovers by rebuild and the next cycle plans a delta", { skip: !DatabaseSync }, async () => {
  const recovery = buildMissingPriorSnapshotRecovery(missingSnapshotFixture);
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const fenceStore = createMemoryStateStore();
  const claim = await claimGeneration({
    fenceStore, store: fenceStore, holder: "missing-snapshot-recovery",
    fingerprint, watermarks: watermarksFromSnapshot(currentSnapshot), now: clock(), leaseMs: 60_000,
  });
  // Start from an empty derived database so the rebuild establishes the baseline.
  const db = new DatabaseSync(":memory:");
  for (const migration of ["0025_search_and_ocp_read_models.sql", "0026_entity_intelligence_read_model.sql", "0031_d1_publication_batches.sql"]) {
    db.exec(readFileSync(join(ROOT, "worker/migrations", migration), "utf8"));
  }
  const recoveryHolder = "missing-snapshot-recovery";
  const adapter = databaseAdapter(db, { generation: claim.generation, holder: recoveryHolder });
  const rebuilt = await runMissingSnapshotRecovery({
    currentSnapshot, recovery, manifest, sourceDocuments: fixture.current,
    generation: claim.generation, fingerprint, holder: recoveryHolder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, maxOpsPerBatch: 8, now: clock,
  });

  assert.equal(rebuilt.outcome, "published");
  assert.equal(rebuilt.plan.operation, "rebuild");
  assert.equal(rebuilt.recovery.status, "rebuilt");
  assert.equal(rebuilt.recovery.rebuilt_generation, claim.generation);
  assert.equal(rebuilt.recovery.rebuilt_snapshot_key, snapshotKeyForGeneration(claim.generation));
  assert.equal(rebuilt.reconcileReport.consistent, true);
  assert.ok(adapter.executions.length > 0);

  // Persist the rebuilt snapshot under the key published state will reference,
  // then complete the fence so the next cycle can claim and apply a delta.
  const persisted = new Map([[rebuilt.recovery.rebuilt_snapshot_key, rebuilt.snapshotToPersist]]);
  assert.equal(persisted.has(snapshotKeyForGeneration(claim.generation)), true);
  const completed = await completeGeneration({
    store: fenceStore, generation: claim.generation, holder: recoveryHolder,
    fingerprint, now: clock(),
  });
  assert.equal(completed.completed, true);

  const nextSources = structuredClone(fixture.current);
  nextSources.keyword_search.families.alpha = {
    ...nextSources.keyword_search.families.alpha,
    as_of: "2026-09-13T00:00:00Z",
    documents: [
      { ...nextSources.keyword_search.families.alpha.documents[0], title: "Alpha hearing after recovery" },
      nextSources.keyword_search.families.alpha.documents[1],
      ...(nextSources.keyword_search.families.alpha.documents.slice(2) || []),
    ],
  };
  const nextSnapshot = snapshotFor(manifest, nextSources);
  const nextClaim = await claimGeneration({
    fenceStore, store: fenceStore, holder: "post-recovery-delta",
    fingerprint, watermarks: watermarksFromSnapshot(nextSnapshot), now: clock(), leaseMs: 60_000,
  });
  const priorFromKv = persisted.get(snapshotKeyForGeneration(claim.generation));
  const deltaAdapter = databaseAdapter(db, {
    generation: nextClaim.generation,
    holder: "post-recovery-delta",
  });
  const delta = await runProductionDelta({
    priorSnapshot: priorFromKv, currentSnapshot: nextSnapshot,
    manifest, sourceDocuments: nextSources, generation: nextClaim.generation,
    fingerprint, holder: "post-recovery-delta",
    fenceStore, adapter: deltaAdapter, appliedBatchStore: deltaAdapter, policy, maxOpsPerBatch: 8, now: clock,
  });
  assert.equal(delta.outcome, "published");
  assert.equal(delta.plan.operation, "delta");
  assert.ok(delta.plan.models.some((model) => model.totals.update > 0 || model.totals.insert > 0));
  assert.ok(delta.batchPlan.batches.every((batch) => batch.ops.every((op) => op.kind !== "truncate")));
});

test("abandoned prior-generation markers do not skip rebuild truncates (Deploy 36933227439)", { skip: !DatabaseSync }, async () => {
  // Reproduces gen27 abandoned delta leaving an ordinal-0 marker that, under
  // fingerprint-only checkpoint ids, made gen28 rebuild skip truncates and hit
  // UNIQUE on entity_intelligence inserts. Generation+holder scoped ids force
  // the rebuild truncate batch to run.
  const currentSnapshot = snapshotFor(manifest, fixture.current);
  const fenceStore = createMemoryStateStore();
  const priorHolder = "Deploy worker:36921583269:1";
  const priorClaim = await claimGeneration({
    fenceStore, store: fenceStore, holder: priorHolder,
    fingerprint, watermarks: watermarksFromSnapshot(currentSnapshot), now: clock(), leaseMs: 60_000,
  });
  const db = openDatabase(fixture.current);
  const entityEntry = modelEntry(manifest, "entity_intelligence");
  const entityRows = tableRows(entityEntry, fixture.current.entity_intelligence).rows;
  assert.ok(entityRows.some((row) => row.table === "entity_intelligence_entities"));

  const priorRebuildPlan = planBatches({
    plan: planDelta({ prior: null, current: currentSnapshot, rebuild: NO_DELTA_SNAPSHOT_BASELINE_REASON }),
    manifest, sourceDocuments: fixture.current, generation: priorClaim.generation, maxOpsPerBatch: 8,
  });
  const priorTruncateBatch = priorRebuildPlan.batches.find(
    (batch) => batch.model_id === "entity_intelligence" && batch.ordinal === 0,
  );
  assert.ok(priorTruncateBatch);
  assert.ok(priorTruncateBatch.ops.some((op) => op.kind === "truncate"));

  // Legacy fingerprint-only marker shape that collided across generations.
  const legacyCheckpointId = `${fingerprint}:entity_intelligence:__model__:0`;
  db.prepare(`INSERT INTO d1_publication_batches
    (batch_id, checkpoint_id, generation, fingerprint, model_id, partition_id, ordinal, op_count, estimated_application_writes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      priorTruncateBatch.batch_id,
      legacyCheckpointId,
      priorClaim.generation,
      fingerprint,
      "entity_intelligence",
      "__model__",
      0,
      priorTruncateBatch.op_count,
      priorTruncateBatch.estimated_writes,
    );
  // Also leave a properly scoped prior-generation marker (post-fix world).
  db.prepare(`INSERT INTO d1_publication_batches
    (batch_id, checkpoint_id, generation, fingerprint, model_id, partition_id, ordinal, op_count, estimated_application_writes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `${priorClaim.generation}:entity_intelligence:__model__:scoped-prior`,
      applicationCheckpointId(fingerprint, priorTruncateBatch, { generation: priorClaim.generation, holder: priorHolder }),
      priorClaim.generation,
      fingerprint,
      "entity_intelligence",
      "__model__",
      0,
      priorTruncateBatch.op_count,
      priorTruncateBatch.estimated_writes,
    );

  await abandonGeneration({
    store: fenceStore, generation: priorClaim.generation, holder: priorHolder, fingerprint, now: clock(),
  });

  const recoveryHolder = "Deploy worker:36933227439:1";
  const nextClaim = await claimGeneration({
    fenceStore, store: fenceStore, holder: recoveryHolder,
    fingerprint, watermarks: watermarksFromSnapshot(currentSnapshot), now: clock(), leaseMs: 60_000,
  });
  assert.notEqual(nextClaim.generation, priorClaim.generation);

  const recovery = {
    schema: "cityscroll.d1-publication-recovery.v1",
    status: "bootstrap_required",
    action: "explicit_rebuild",
    reason: NO_DELTA_SNAPSHOT_BASELINE_REASON,
    published_generation: priorClaim.generation,
    snapshot_key: snapshotKeyForGeneration(priorClaim.generation),
    baseline: { status: "unavailable", source: "no_published_fence_baseline" },
    d1_writes: { commands: null, rows: null },
    observed_fence_status: "abandoned",
  };
  const adapter = databaseAdapter(db, { generation: nextClaim.generation, holder: recoveryHolder });
  const rebuilt = await runMissingSnapshotRecovery({
    currentSnapshot, recovery, manifest, sourceDocuments: fixture.current,
    generation: nextClaim.generation, fingerprint, holder: recoveryHolder,
    fenceStore, adapter, appliedBatchStore: adapter, policy, maxOpsPerBatch: 8, now: clock,
  });

  assert.equal(rebuilt.outcome, "published");
  assert.equal(rebuilt.plan.operation, "rebuild");
  const truncateBatchId = `${nextClaim.generation}:entity_intelligence:__model__:0`;
  assert.ok(adapter.executions.includes(truncateBatchId), "rebuild truncate batch must execute");
  const truncateReceipt = rebuilt.publishReceipt.completed_batches.find((batch) => batch.batch_id === truncateBatchId);
  assert.ok(truncateReceipt);
  assert.equal(truncateReceipt.recovered, false);
  assert.ok(truncateReceipt.attempt >= 1);
  const entityCount = db.prepare("SELECT COUNT(*) AS count FROM entity_intelligence_entities").get().count;
  assert.equal(entityCount, entityRows.filter((row) => row.table === "entity_intelligence_entities").length);
});

test("missing-snapshot recovery honors the incremental kill switch wiring", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const recovery = workflow.slice(
    workflow.indexOf("- name: Recover missing D1 publication snapshot"),
    workflow.indexOf("- name: Record published D1 fingerprint"),
  );
  assert.match(recovery, /d1_production_delta\.mjs recover-missing-snapshot/);
  assert.match(recovery, /incremental-enabled == 'true'/);
  assert.match(recovery, /status == 'missing'/);
  assert.match(workflow, /reason="incremental-publication-disabled"/);
  // Cause fix: a missing prior snapshot must not hard-code permanent failure;
  // recovery artifacts feed the receipt, and the snapshot is written before fence completion.
  assert.doesNotMatch(
    workflow,
    /PRIOR_SNAPSHOT_STATUS" = "missing"[\s\S]{0,80}outcome=failed_permanent[\s\S]{0,120}explicit rebuild recovery is required/,
  );
  assert.match(workflow, /d1-missing-snapshot-recovery\/result\.json/);
  const record = workflow.slice(
    workflow.indexOf("- name: Record published D1 fingerprint"),
    workflow.indexOf("- name: Record D1 publication receipt"),
  );
  // Packed snapshot put (gzip/chunked) must land before fence complete; the
  // hard assert-fits check keeps an oversize value from failing only at KV.
  assert.match(record, /d1_publication_snapshot_kv\.mjs pack/);
  assert.match(record, /d1_publication_snapshot_kv\.mjs assert-fits/);
  assert.match(record, /kv key put "\$put_key"/);
  assert.ok(record.indexOf("d1_publication_snapshot_kv.mjs pack") < record.indexOf("kv key put \"$put_key\""));
  assert.ok(record.indexOf("kv key put \"$put_key\"") < record.indexOf("d1_generation_fence.mjs complete"));
  assert.match(workflow, /d1_publication_snapshot_kv\.mjs unpack/);
});

test("recovery reason stays bound to the missing-snapshot rebuild contract", () => {
  assert.match(MISSING_SNAPSHOT_REBUILD_REASON, /missing generation-qualified snapshot/);
  assert.match(MISSING_SNAPSHOT_REBUILD_REASON, /explicit rebuild recovery/);
});

test("the Wrangler adapter commits the application SQL and checkpoint marker in one import", async () => {
  const { createWranglerD1PublicationAdapter } = await import("../tools/d1_production_delta.mjs");
  let imported = "";
  const holder = "fixture-holder";
  const expectedCheckpoint = applicationCheckpointId(fingerprint, {
    model_id: "model", partition: "part", ordinal: 0,
  }, { generation: 4, holder });
  const adapter = createWranglerD1PublicationAdapter({
    database: "fixture-db", generation: 4, fingerprint, holder,
    run: async (args) => {
      const fileIndex = args.indexOf("--file");
      if (fileIndex >= 0) {
        imported = readFileSync(args[fileIndex + 1], "utf8");
        return { stdout: "" };
      }
      return { stdout: JSON.stringify([{ success: true, results: [{ checkpoint_id: expectedCheckpoint }] }]) };
    },
  });
  const batch = {
    batch_id: "4:model:part:0", model_id: "model", partition: "part", ordinal: 0,
    op_count: 1, estimated_writes: 1,
  };
  await adapter.execute("UPDATE sample SET value = 'new' WHERE id = 'one';", batch);
  assert.match(imported, /UPDATE sample/);
  assert.match(imported, /INSERT INTO d1_publication_batches/);
  assert.match(imported, new RegExp(expectedCheckpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(imported.indexOf("UPDATE sample") < imported.indexOf("INSERT INTO d1_publication_batches"));
  assert.equal(await adapter.has(batch.batch_id, batch), true);
});
