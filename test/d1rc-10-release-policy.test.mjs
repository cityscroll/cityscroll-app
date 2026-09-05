import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  checkReleasePolicy,
  parseArgs,
  validateWorkflowWiring,
} from "../tools/d1_release_policy.mjs";
import { buildPublicationReceipt } from "../tools/d1_publication_receipt.mjs";
import { planBatches, publishBounded } from "../tools/d1_bounded_publisher.mjs";
import { claimGeneration, createMemoryStateStore } from "../tools/d1_generation_fence.mjs";
import { planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import { runReconcile } from "../tools/d1_reconcile.mjs";
import { loadManifest } from "../tools/d1_manifest.mjs";
import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const manifest = loadManifest();
const FINGERPRINT = "a".repeat(64);

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

function sourcesAt(date, extraAward = null) {
  const sources = {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: date, source_row_count: 1, indexed_count: 1, coverage: [],
          documents: [{ title: "Alpha one", object_ref: "notice:a1" }],
        },
      },
    },
    ocp_awards: {
      materialized_at: date,
      rows: [{ request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 }],
    },
    entity_intelligence: {
      generated_at: date, observation_count: 1, entity_count: 1, multi_domain_count: 0,
      by_ref: {}, by_subject_ref: {},
    },
  };
  if (extraAward) sources.ocp_awards.rows.push(extraAward);
  return sources;
}

function policy() {
  return {
    schema: "cityscroll.d1-release-policy.v1",
    canary: { max_partitions: 3, max_rows: 200 },
    reconcile: { max_partitions: 25, max_rows: 5000 },
    abort_threshold: { max_findings: 25 },
  };
}

test("the release policy checks path filters, fingerprint gating order, and the no-rebuild ordinary path", () => {
  const result = checkReleasePolicy();
  assert.equal(result.policy.incremental_publication.enabled, true);
  assert.deepEqual(result.wiring.paths, [
    "worker/**", "capabilities/**", "entity_resolution/**", "ontology/**",
    "site/**", "tools/**", "warehouse/**", ".github/workflows/deploy-worker.yml",
  ]);
  assert.deepEqual(parseArgs(["node", "tools/d1_release_policy.mjs", "--check"]), { check: true });
  assert.match(readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8"), /disable_incremental_publication/);
});

test("a no-data-change deploy records a visible skipped receipt with zero writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1rc-10-skip-"));
  try {
    const local = join(dir, "receipts.jsonl");
    const output = join(dir, "receipt.json");
    const result = spawnSync(process.execPath, [
      "tools/d1_publication_receipt.mjs", "record",
      "--workflow", "Deploy worker", "--run-id", "d1rc10-skip", "--attempt", "1",
      "--deploy-fingerprint", FINGERPRINT, "--outcome", "skipped", "--reason", "fingerprint-unchanged",
      "--local", local, "--out", output,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(receipt.outcome, "skipped");
    assert.equal(receipt.reason, "fingerprint-unchanged");
    assert.deepEqual(receipt.totals, { estimated_writes: 0, observed_writes: 0, total_ops: 0, batch_count: 0 });
    assert.equal(JSON.parse(readFileSync(local, "utf8")).totals.observed_writes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed snapshot uses bounded writes and reconciles consistently", { skip: !DatabaseSync && "node:sqlite unavailable" }, async () => {
  const prior = sourcesAt("2026-09-01T00:00:00Z");
  const current = sourcesAt("2026-09-02T00:00:00Z", {
    request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20,
  });
  const db = new DatabaseSync(":memory:");
  for (const migration of ["worker/migrations/0025_search_and_ocp_read_models.sql", "worker/migrations/0026_entity_intelligence_read_model.sql"]) {
    db.exec(readFileSync(join(ROOT, migration), "utf8"));
  }
  for (const entry of manifest.models) db.exec(statementsForModel(entry, prior[entry.model_id], { mode: "rebuild" }).sql);
  const adapter = {
    async execute(sql) {
      db.exec("BEGIN;");
      try { db.exec(sql); db.exec("COMMIT;"); } catch (error) { db.exec("ROLLBACK;"); throw error; }
    },
    async select(sql, params = []) { return db.prepare(sql).all(...params); },
  };
  const plan = planDelta({ prior: snapshotFor(manifest, prior), current: snapshotFor(manifest, current) });
  const fenceStore = createMemoryStateStore();
  const claim = await claimGeneration({
    store: fenceStore, holder: "d1rc10-test", fingerprint: FINGERPRINT,
    watermarks: watermarksFromSnapshot(snapshotFor(manifest, current)),
  });
  const batchPlan = planBatches({ plan, manifest, sourceDocuments: current, generation: claim.generation, maxOpsPerBatch: 1 });
  const publication = await publishBounded({
    batchPlan, manifest, fenceStore, holder: "d1rc10-test", fingerprint: FINGERPRINT,
    executor: adapter, backoffMs: 0,
  });
  assert.equal(publication.status, "complete");
  assert.ok(publication.completed_batches.length > 0);
  assert.ok(publication.completed_batches.length <= batchPlan.batches.length);
  const reconcile = await runReconcile({ manifest, sourceDocuments: current, adapter, policy: policy(), generation: claim.generation });
  assert.equal(reconcile.consistent, true);
  assert.equal(reconcile.truncated, false);
  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "d1rc10-publish", attempt: 1 },
    outcome: "published", reason: "changed snapshot", deployFingerprint: FINGERPRINT,
    generation: claim.generation, snapshot: snapshotFor(manifest, current), batchPlan, publishReceipt: publication,
    reconcileReport: reconcile,
  });
  assert.ok(receipt.totals.observed_writes <= receipt.totals.estimated_writes);
  assert.equal(receipt.reconcile.consistent, true);
});

test("the policy documents explicit recovery, invoice authority, and dashboard lag", () => {
  const doc = readFileSync(join(ROOT, "docs/d1-release-policy-v1.md"), "utf8");
  assert.match(doc, /d1-explicit-rebuild-v1\.md/);
  assert.match(doc, /Cloudflare's final invoice is the authority/);
  assert.match(doc, /dashboard usage\s+may lag/);
  assert.match(doc, /operating budget report links here/);
});

test("the disabled incremental flag does not add a rebuild to the ordinary workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  validateWorkflowWiring(workflow);
  const ordinary = workflow.slice(workflow.indexOf("- name: Build D1 search"), workflow.indexOf("- name: Record D1 publication receipt"));
  assert.doesNotMatch(ordinary, /d1_explicit_rebuild\.mjs|--mode\s+rebuild/);
  assert.match(workflow, /outcome=skipped\s*\n\s*reason="fingerprint-unchanged"/);
  assert.match(workflow, /INCREMENTAL_ENABLED/);
});
