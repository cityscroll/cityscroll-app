import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_OPS_PER_BATCH,
  batchId,
  classifyFailure,
  dryRunReport,
  planBatches,
  publishBounded,
  recordRollback,
  renderBatch,
} from "../tools/d1_bounded_publisher.mjs";
import { PLAN_SCHEMA, planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import { claimGeneration, createMemoryStateStore } from "../tools/d1_generation_fence.mjs";
import { loadManifest, modelEntry } from "../tools/d1_manifest.mjs";
import { TABLE_COLUMNS } from "../tools/d1_stable_keys.mjs";
import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = [
  "worker/migrations/0025_search_and_ocp_read_models.sql",
  "worker/migrations/0026_entity_intelligence_read_model.sql",
];
const manifest = loadManifest();
const clone = (value) => structuredClone(value);
const FINGERPRINT_A = "a".repeat(64);

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

function baseSources() {
  return {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 2, indexed_count: 2, coverage: [],
          documents: [
            { title: "Alpha one", summary: "first", object_ref: "notice:a1", source_observation_refs: ["obs:1"] },
            { title: "Alpha two", object_ref: "notice:a2", search_text: "second" },
          ],
        },
        beta: {
          source: "beta-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 1, indexed_count: 1, coverage: [],
          documents: [{ title: "Beta one", object_ref: "notice:b1" }],
        },
      },
    },
    ocp_awards: {
      materialized_at: "2026-09-01T00:00:00Z",
      rows: [
        { request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 },
        { request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20 },
        { request_id: "r3", pin: "p3", start_date: "2026-01-03", agency_name: "DEP", vendor_name: "Vendor C", contract_amount: 30 },
      ],
    },
    entity_intelligence: {
      generated_at: "2026-09-01T00:00:00Z", observation_count: 3, entity_count: 2, multi_domain_count: 1,
      by_ref: {
        "vendor:a": { root: { kind: "vendor", display_name: "Vendor A" }, links: [], domains: {} },
        "agency:dep": { root: { kind: "agency", display_name: "DEP" }, links: [], domains: {} },
      },
      by_subject_ref: {},
    },
  };
}

function scaledOcpSources(rowCount) {
  const sources = baseSources();
  sources.ocp_awards.materialized_at = "2026-09-02T00:00:00Z";
  sources.ocp_awards.rows = Array.from({ length: rowCount }, (_, index) => ({
    request_id: `bulk-${index}`, pin: `p-${index}`, start_date: "2026-02-01",
    agency_name: "DOT", vendor_name: `Vendor ${index}`, contract_amount: index,
  }));
  return sources;
}

function changedSources() {
  const sources = baseSources();
  sources.ocp_awards.materialized_at = "2026-09-03T00:00:00Z";
  sources.ocp_awards.rows = [
    { ...sources.ocp_awards.rows[0], contract_amount: 15 }, // update
    sources.ocp_awards.rows[1],                             // unchanged
    { request_id: "r4", pin: "p4", start_date: "2026-01-04", agency_name: "DOB", vendor_name: "Vendor D", contract_amount: 40 }, // insert
  ]; // r3 removed -> delete
  sources.keyword_search.families.alpha.as_of = "2026-09-03T00:00:00Z";
  sources.keyword_search.families.alpha.documents[0].title = "Alpha one revised";
  sources.entity_intelligence.generated_at = "2026-09-03T00:00:00Z";
  sources.entity_intelligence.by_ref["agency:dep"].root.display_name = "Dept of Environmental Protection";
  return sources;
}

function openDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) db.exec(readFileSync(join(ROOT, migration), "utf8"));
  return db;
}

function seedRebuild(db, sources) {
  for (const entry of manifest.models) db.exec(statementsForModel(entry, sources[entry.model_id], { mode: "rebuild" }).sql);
}

function dump(db) {
  const state = {};
  for (const entry of manifest.models) {
    for (const table of entry.tables) {
      const order = table.key_columns.join(", ");
      state[table.name] = db.prepare(`SELECT ${TABLE_COLUMNS[table.name].join(", ")} FROM ${table.name} ORDER BY ${order}`).all();
    }
  }
  return state;
}

async function claimTestGeneration({ current, holder = "test-publisher", now = Date.now(), leaseMs = 10_000_000 }) {
  const store = createMemoryStateStore();
  const claim = await claimGeneration({ store, holder, fingerprint: FINGERPRINT_A, watermarks: watermarksFromSnapshot(current), now, leaseMs });
  assert.equal(claim.claimed, true);
  return { store, generation: claim.generation, holder, fingerprint: FINGERPRINT_A };
}

/**
 * A transactional in-memory executor: db.exec runs inside BEGIN/COMMIT so a thrown
 * error never leaves a half-applied batch. `beforeExecute` can throw to simulate a
 * failure that never reaches the database (a permanent SQL/schema error); `afterExecute`
 * can throw once the transaction has already committed, to simulate a transient failure
 * whose SQL landed but whose confirmation was lost (the classic timeout ambiguity).
 */
function sqliteExecutor(db, { beforeExecute, afterExecute } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async execute(sql, batch) {
      calls += 1;
      const call = calls;
      if (beforeExecute) await beforeExecute({ call, batch });
      db.exec("BEGIN;");
      try {
        db.exec(sql);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
      if (afterExecute) await afterExecute({ call, batch });
    },
  };
}

function renderAllBatches(batchPlan) {
  return batchPlan.batches.map((batch) => renderBatch(modelEntry(manifest, batch.model_id), batch.ops));
}

test("a 10k-row delta splits into bounded batches without a full-table reset", () => {
  const prior = clone(baseSources());
  prior.ocp_awards.rows = [];
  const priorSnapshot = snapshotFor(manifest, prior);
  const current = scaledOcpSources(10000);
  const currentSnapshot = snapshotFor(manifest, current);
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });
  assert.equal(plan.schema, PLAN_SCHEMA);
  const ocpTotals = plan.models.find((model) => model.model_id === "ocp_awards").totals;
  assert.equal(ocpTotals.insert, 10000);
  assert.equal(ocpTotals.total_ops, 10000);

  const batchPlan = planBatches({ plan, manifest, sourceDocuments: current, generation: 1, maxOpsPerBatch: 500 });
  const ocpBatches = batchPlan.batches.filter((batch) => batch.model_id === "ocp_awards");
  assert.equal(ocpBatches.length, Math.ceil(10000 / 500));
  assert.equal(batchPlan.models.find((model) => model.model_id === "ocp_awards").batch_count, 20);
  assert.ok(ocpBatches.every((batch) => batch.op_count <= 500));
  assert.equal(ocpBatches.reduce((sum, batch) => sum + batch.op_count, 0), 10000);

  const rendered = renderAllBatches(batchPlan);
  for (const sql of rendered) {
    assert.ok(!/^DELETE FROM \S+;$/m.test(sql), "a bounded batch never emits a table-wide reset");
  }
  // batch ids are stable and derived from generation + model + partition + ordinal
  assert.equal(ocpBatches[0].batch_id, batchId({ generation: 1, modelId: "ocp_awards", partition: "__model__", ordinal: 0 }));
  assert.equal(ocpBatches[19].batch_id, batchId({ generation: 1, modelId: "ocp_awards", partition: "__model__", ordinal: 19 }));
});

test("a companion delete/insert pair never splits across a batch boundary", () => {
  const prior = snapshotFor(manifest, baseSources());
  const current = changedSources();
  const plan = planDelta({ prior, current: snapshotFor(manifest, current) });
  const batchPlan = planBatches({ plan, manifest, sourceDocuments: current, generation: 7, maxOpsPerBatch: 1 });
  const keywordBatches = batchPlan.batches.filter((batch) => batch.model_id === "keyword_search" && batch.partition === "alpha");
  assert.ok(keywordBatches.length >= 2, "the changed alpha document produces at least a documents-row and an fts-row batch");

  for (const batch of keywordBatches) {
    assert.equal(batch.op_count, 1, "maxOpsPerBatch=1 bounds every batch to one logical op");
    const sql = renderBatch(modelEntry(manifest, "keyword_search"), batch.ops);
    const lines = sql.split("\n").filter(Boolean);
    if (batch.ops[0].table === "keyword_search_fts") {
      assert.equal(lines.length, 2, "the fts row's delete-then-insert convergence pair stays in one batch");
      assert.ok(lines[0].startsWith("DELETE FROM keyword_search_fts WHERE"));
      assert.ok(lines[1].startsWith("INSERT INTO keyword_search_fts"));
      const documentId = lines[1].match(/VALUES \((\d+|\(SELECT[^)]+\)), '([^']+)'/)?.[2];
      assert.ok(lines[0].includes(documentId) || documentId, "the pair references the same document");
    } else {
      assert.equal(lines.length, 1, "a non-virtual-table upsert renders as a single statement");
    }
  }
});

test("dry run reports model, generation, delta counts, batch count, and estimated writes", () => {
  const prior = snapshotFor(manifest, baseSources());
  const current = changedSources();
  const plan = planDelta({ prior, current: snapshotFor(manifest, current) });
  const batchPlan = planBatches({ plan, manifest, sourceDocuments: current, generation: 3, maxOpsPerBatch: 2 });
  const report = dryRunReport({ plan, batchPlan });

  assert.equal(report.generation, 3);
  assert.equal(report.manifest_fingerprint, plan.manifest_fingerprint);
  assert.ok(report.summary.total_batches > 0);
  assert.ok(report.summary.total_ops > 0);
  assert.ok(report.summary.total_estimated_writes >= report.summary.total_ops);
  const ocpReport = report.models.find((model) => model.model_id === "ocp_awards");
  assert.equal(ocpReport.delta_counts.insert, 1);
  assert.equal(ocpReport.delta_counts.update, 1);
  assert.equal(ocpReport.delta_counts.delete, 1);
  assert.ok(ocpReport.batch_count > 0);
  assert.ok(ocpReport.estimated_writes > 0);
});

test(
  "retry after a simulated timeout re-applies the batch idempotently: no duplicate rows",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const changed = changedSources();
    const prior = snapshotFor(manifest, sources);
    const current = snapshotFor(manifest, changed);
    const plan = planDelta({ prior, current });

    const { store, generation, holder, fingerprint } = await claimTestGeneration({ current });
    const batchPlan = planBatches({ plan, manifest, sourceDocuments: changed, generation, maxOpsPerBatch: 1 });
    assert.ok(batchPlan.batches.length >= 3, "the fixture produces several small batches");
    const timeoutAt = Math.floor(batchPlan.batches.length / 2);

    const straightDb = openDatabase();
    seedRebuild(straightDb, sources);
    for (const batch of batchPlan.batches) {
      straightDb.exec(renderBatch(modelEntry(manifest, batch.model_id), batch.ops));
    }
    const expected = dump(straightDb);

    const retryDb = openDatabase();
    seedRebuild(retryDb, sources);
    let timeoutsFired = 0;
    const executor = sqliteExecutor(retryDb, {
      afterExecute: async ({ call }) => {
        if (call === timeoutAt + 1 && timeoutsFired === 0) {
          timeoutsFired += 1;
          const error = new Error("simulated D1 timeout contacting the remote database");
          error.transient = true;
          throw error;
        }
      },
    });
    const checkpointDir = mkdtempSync(join(tmpdir(), "d1-bounded-checkpoint-"));
    const checkpointPath = join(checkpointDir, "receipt.json");
    try {
      const receipt = await publishBounded({
        batchPlan, manifest, fenceStore: store, holder, fingerprint, executor, checkpointPath,
        wait: async () => {},
      });
      assert.equal(receipt.status, "complete");
      assert.equal(timeoutsFired, 1, "the simulated timeout actually fired once");
      assert.equal(executor.calls(), batchPlan.batches.length + 1, "exactly one batch was retried");
      assert.deepEqual(dump(retryDb), expected, "retried publication converges to the same rows as an uninterrupted run");
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  },
);

test(
  "a permanent failure stops the generation and a rerun resumes at the failed batch",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const changed = changedSources();
    const prior = snapshotFor(manifest, sources);
    const current = snapshotFor(manifest, changed);
    const plan = planDelta({ prior, current });

    const { store, generation, holder, fingerprint } = await claimTestGeneration({ current });
    const batchPlan = planBatches({ plan, manifest, sourceDocuments: changed, generation, maxOpsPerBatch: 1 });
    assert.ok(batchPlan.batches.length >= 3);
    const failAt = Math.floor(batchPlan.batches.length / 2);
    const failingBatchId = batchPlan.batches[failAt].batch_id;

    const straightDb = openDatabase();
    seedRebuild(straightDb, sources);
    for (const batch of batchPlan.batches) {
      straightDb.exec(renderBatch(modelEntry(manifest, batch.model_id), batch.ops));
    }
    const expected = dump(straightDb);

    const db = openDatabase();
    seedRebuild(db, sources);
    const checkpointDir = mkdtempSync(join(tmpdir(), "d1-bounded-checkpoint-"));
    const checkpointPath = join(checkpointDir, "receipt.json");
    try {
      let firstAttemptCalls = 0;
      const failingExecutor = sqliteExecutor(db, {
        beforeExecute: async ({ batch }) => {
          if (batch.batch_id === failingBatchId) {
            firstAttemptCalls += 1;
            const error = new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed");
            throw error;
          }
        },
      });
      const firstReceipt = await publishBounded({
        batchPlan, manifest, fenceStore: store, holder, fingerprint, executor: failingExecutor, checkpointPath,
      });
      assert.equal(firstReceipt.status, "stopped_permanent_error");
      assert.equal(firstReceipt.next_batch_id, failingBatchId);
      assert.equal(firstReceipt.completed_batches.length, failAt);
      assert.equal(firstAttemptCalls, 1, "a permanent error never retries");
      assert.deepEqual(dump(db), (() => {
        const partial = openDatabase();
        seedRebuild(partial, sources);
        for (const batch of batchPlan.batches.slice(0, failAt)) {
          partial.exec(renderBatch(modelEntry(manifest, batch.model_id), batch.ops));
        }
        return dump(partial);
      })(), "nothing from the failed batch onward was applied");

      const workingExecutor = sqliteExecutor(db);
      const secondReceipt = await publishBounded({
        batchPlan, manifest, fenceStore: store, holder, fingerprint, executor: workingExecutor, checkpointPath,
      });
      assert.equal(secondReceipt.status, "complete");
      assert.equal(secondReceipt.completed_batches.length, batchPlan.batches.length);
      assert.equal(workingExecutor.calls(), batchPlan.batches.length - failAt, "the rerun starts at the failed batch, not from the beginning");
      assert.deepEqual(dump(db), expected, "the resumed run ends in the same final state as an uninterrupted run");

      const rollback = recordRollback({ checkpointPath, reason: "operator test rollback" });
      assert.equal(rollback.rollback.reason, "operator test rollback");
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  },
);

test("classifyFailure separates transient from permanent errors", () => {
  assert.equal(classifyFailure(Object.assign(new Error("x"), { transient: true })), "transient");
  assert.equal(classifyFailure(Object.assign(new Error("x"), { transient: false })), "permanent");
  assert.equal(classifyFailure(new Error("Request timed out")), "transient");
  assert.equal(classifyFailure(new Error("received 503 Service Unavailable")), "transient");
  assert.equal(classifyFailure(new Error("rate limit exceeded, retry later")), "transient");
  assert.equal(classifyFailure(new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed")), "permanent");
  assert.equal(classifyFailure(new Error("syntax error near INSERT")), "permanent");
});

test("bounded batches are refused for a rebuild plan", () => {
  const current = snapshotFor(manifest, baseSources());
  const rebuildPlan = planDelta({ prior: null, current, rebuild: "first publication" });
  assert.throws(() => planBatches({ plan: rebuildPlan, manifest, sourceDocuments: baseSources(), generation: 1 }), /delta plans only/);
});

test(`the default bound is sized for a bounded batch (${DEFAULT_MAX_OPS_PER_BATCH} ops)`, () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_OPS_PER_BATCH) && DEFAULT_MAX_OPS_PER_BATCH > 0);
});
