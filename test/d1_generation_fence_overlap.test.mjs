/**
 * Overlap fixture for the D1 publication generation fence.
 *
 * Two publication runs are driven against one shared fence store and one shared
 * database, deliberately out of order: the older generation is resumed after a
 * newer one has taken the fence. The fixture proves the three properties the
 * fence exists for.
 *
 *   1. A stale generation performs no visible mutation.
 *   2. The generation that holds the fence stays publishable after that rejection.
 *   3. The rejection receipt names the stale generation and the current one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planBatches, publishBounded, renderBatch } from "../tools/d1_bounded_publisher.mjs";
import { planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import {
  D1_GENERATION_FENCE_OUTCOME_SCHEMA,
  abandonGeneration,
  checkGenerationCommit,
  claimGeneration,
  createMemoryStateStore,
} from "../tools/d1_generation_fence.mjs";
import { loadManifest, modelEntry } from "../tools/d1_manifest.mjs";
import { TABLE_COLUMNS } from "../tools/d1_stable_keys.mjs";
import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = [
  "worker/migrations/0025_search_and_ocp_read_models.sql",
  "worker/migrations/0026_entity_intelligence_read_model.sql",
];
const manifest = loadManifest();
const FINGERPRINT_OLD = "a".repeat(64);
const FINGERPRINT_NEW = "b".repeat(64);
// One fixed fixture clock drives both the fence leases and the write path, so
// the overlap is decided by generation order rather than by elapsed wall time.
const CLOCK = Date.parse("2026-09-03T12:00:00Z");
const clock = () => CLOCK;

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

function baseSources() {
  return {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 1, indexed_count: 1, coverage: [],
          documents: [{ title: "Alpha one", object_ref: "notice:a1", search_text: "first" }],
        },
      },
    },
    ocp_awards: {
      materialized_at: "2026-09-01T00:00:00Z",
      rows: [
        { request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 },
        { request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20 },
      ],
    },
    entity_intelligence: {
      generated_at: "2026-09-01T00:00:00Z", observation_count: 1, entity_count: 1, multi_domain_count: 0,
      by_ref: { "vendor:a": { root: { kind: "vendor", display_name: "Vendor A" }, links: [], domains: {} } },
      by_subject_ref: {},
    },
  };
}

/** The older run's view of the world: amounts revised once. */
function olderSources() {
  const sources = baseSources();
  sources.ocp_awards.materialized_at = "2026-09-02T00:00:00Z";
  sources.ocp_awards.rows = [
    { ...sources.ocp_awards.rows[0], contract_amount: 111 },
    { ...sources.ocp_awards.rows[1], contract_amount: 222 },
  ];
  sources.keyword_search.families.alpha.as_of = "2026-09-02T00:00:00Z";
  sources.keyword_search.families.alpha.documents[0].title = "Alpha one, older run";
  sources.entity_intelligence.generated_at = "2026-09-02T00:00:00Z";
  sources.entity_intelligence.by_ref["vendor:a"].root.display_name = "Vendor A, older run";
  return sources;
}

/** The newer run's view: the state that must survive the overlap. */
function newerSources() {
  const sources = baseSources();
  sources.ocp_awards.materialized_at = "2026-09-03T00:00:00Z";
  sources.ocp_awards.rows = [
    { ...sources.ocp_awards.rows[0], contract_amount: 999 },
    { ...sources.ocp_awards.rows[1], contract_amount: 888 },
  ];
  sources.keyword_search.families.alpha.as_of = "2026-09-03T00:00:00Z";
  sources.keyword_search.families.alpha.documents[0].title = "Alpha one, newer run";
  sources.entity_intelligence.generated_at = "2026-09-03T00:00:00Z";
  sources.entity_intelligence.by_ref["vendor:a"].root.display_name = "Vendor A, newer run";
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

function sqliteExecutor(db) {
  let calls = 0;
  return {
    calls: () => calls,
    async execute(sql) {
      calls += 1;
      db.exec("BEGIN;");
      try {
        db.exec(sql);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    },
  };
}

function batchPlanFor({ from, to, generation, maxOpsPerBatch = 1 }) {
  const plan = planDelta({ prior: snapshotFor(manifest, from), current: snapshotFor(manifest, to) });
  return planBatches({ plan, manifest, sourceDocuments: to, generation, maxOpsPerBatch });
}

/** The rows a run would produce if it were the only publisher. */
function expectedRows(baseline, target) {
  const db = openDatabase();
  seedRebuild(db, baseline);
  const batchPlan = batchPlanFor({ from: baseline, to: target, generation: 1 });
  for (const batch of batchPlan.batches) db.exec(renderBatch(modelEntry(manifest, batch.model_id), batch.ops));
  return dump(db);
}

test(
  "an overlapping pair of generations publishes in generation order, not completion order",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const baseline = baseSources();
    const older = olderSources();
    const newer = newerSources();

    // Both runs claim from the same fence store. The older one is abandoned
    // mid-flight, exactly as a stalled publisher would be, and the newer one
    // then claims the next generation.
    const store = createMemoryStateStore();
    const oldClaim = await claimGeneration({
      store, holder: "publisher-old", fingerprint: FINGERPRINT_OLD,
      watermarks: watermarksFromSnapshot(snapshotFor(manifest, older)), now: CLOCK - 2, leaseMs: 60_000,
    });
    assert.equal(oldClaim.generation, 1);
    await abandonGeneration({ store, generation: 1, holder: "publisher-old", fingerprint: FINGERPRINT_OLD, now: CLOCK - 1 });
    const newClaim = await claimGeneration({
      store, holder: "publisher-new", fingerprint: FINGERPRINT_NEW,
      watermarks: watermarksFromSnapshot(snapshotFor(manifest, newer)), now: CLOCK, leaseMs: 600_000,
    });
    assert.equal(newClaim.generation, 2);

    const db = openDatabase();
    seedRebuild(db, baseline);
    const before = dump(db);

    const checkpointDir = mkdtempSync(join(tmpdir(), "d1-fence-overlap-"));
    try {
      // The stale generation completes its work last and reaches the write path.
      const staleExecutor = sqliteExecutor(db);
      const stalePlan = batchPlanFor({ from: baseline, to: older, generation: 1 });
      assert.ok(stalePlan.batches.length >= 3, "the stale run really does carry work to apply");
      const staleReceipt = await publishBounded({
        batchPlan: stalePlan, manifest, fenceStore: store,
        holder: "publisher-old", fingerprint: FINGERPRINT_OLD, executor: staleExecutor,
        checkpointPath: join(checkpointDir, "stale.json"), now: clock,
      });

      // A1: rejected before any mutation became visible.
      assert.equal(staleReceipt.status, "stopped_fenced");
      assert.equal(staleExecutor.calls(), 0, "the stale generation never reached the database");
      assert.equal(staleReceipt.completed_batches.length, 0);
      assert.deepEqual(dump(db), before, "the database is untouched by the stale generation");

      // A3: the receipt names both generations and the fence result.
      assert.equal(staleReceipt.fence.schema, D1_GENERATION_FENCE_OUTCOME_SCHEMA);
      assert.equal(staleReceipt.fence.result, "rejected");
      assert.equal(staleReceipt.fence.reason, "stale_generation");
      assert.equal(staleReceipt.fence.stale_generation, 1);
      assert.equal(staleReceipt.fence.current_generation, 2);
      assert.equal(staleReceipt.fence.current_holder, "publisher-new");
      assert.equal(staleReceipt.fence.batches_applied, 0);
      assert.equal(staleReceipt.fence.batch_id, stalePlan.batches[0].batch_id);
      assert.match(staleReceipt.stopped_reason, /generation 1 is fenced by generation 2/);
      assert.deepEqual(
        JSON.parse(readFileSync(join(checkpointDir, "stale.json"), "utf8")).fence,
        staleReceipt.fence,
        "the rejection is durable on the checkpoint, not only in memory",
      );

      // A2: the current generation is still publishable afterwards.
      const currentExecutor = sqliteExecutor(db);
      const currentPlan = batchPlanFor({ from: baseline, to: newer, generation: 2 });
      const currentReceipt = await publishBounded({
        batchPlan: currentPlan, manifest, fenceStore: store,
        holder: "publisher-new", fingerprint: FINGERPRINT_NEW, executor: currentExecutor,
        checkpointPath: join(checkpointDir, "current.json"), now: clock,
      });
      assert.equal(currentReceipt.status, "complete");
      assert.equal(currentReceipt.fence.result, "accepted");
      assert.equal(currentReceipt.fence.current_generation, 2);
      assert.equal(currentExecutor.calls(), currentPlan.batches.length);
      assert.deepEqual(
        dump(db),
        expectedRows(baseline, newer),
        "the published rows are the newer generation's, in generation order rather than completion order",
      );
    } finally {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  },
);

test("a generation below the one the store holds can never become committable", async () => {
  const store = createMemoryStateStore();
  await claimGeneration({
    store, holder: "publisher-old", fingerprint: FINGERPRINT_OLD,
    watermarks: { ocp_awards: { __model__: "2026-09-02T00:00:00Z" } }, now: 1000, leaseMs: 10_000,
  });
  await abandonGeneration({ store, generation: 1, holder: "publisher-old", fingerprint: FINGERPRINT_OLD, now: 2000 });
  await claimGeneration({
    store, holder: "publisher-new", fingerprint: FINGERPRINT_NEW,
    watermarks: { ocp_awards: { __model__: "2026-09-03T00:00:00Z" } }, now: 3000, leaseMs: 10_000,
  });

  // The stale holder still believes it holds a live lease with its own identity.
  const stale = await checkGenerationCommit({
    store, generation: 1, holder: "publisher-old", fingerprint: FINGERPRINT_OLD, now: 3500,
  });
  assert.equal(stale.committable, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.current_generation, 2);
  assert.equal(stale.outcome.stale_generation, 1);
  assert.equal(stale.outcome.current_status, "claimed");
  assert.equal((await store.read()).holder, "publisher-new", "a rejection never mutates the fence state");

  const current = await checkGenerationCommit({
    store, generation: 2, holder: "publisher-new", fingerprint: FINGERPRINT_NEW, now: 3600,
  });
  assert.equal(current.committable, true);
  assert.equal(current.outcome.result, "accepted");
  assert.equal(current.outcome.stale_generation, null);
});
