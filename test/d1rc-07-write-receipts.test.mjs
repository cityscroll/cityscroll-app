import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  D1_PUBLICATION_RECEIPT_SCHEMA,
  OUTCOMES,
  PublicationReceiptError,
  appendReceiptToKv,
  assertOneTerminalOutcomePerRun,
  buildPublicationReceipt,
  compareReceipts,
  createMemoryReceiptStore,
  fileReceiptStore,
  recordPublicationReceipt,
  retriesFromPublishReceipt,
  summarizeModels,
  summarizeReceipt,
  validatePublicationReceipt,
} from "../tools/d1_publication_receipt.mjs";
import { planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import { dryRunReport, planBatches, publishBounded } from "../tools/d1_bounded_publisher.mjs";
import { claimGeneration, createMemoryStateStore } from "../tools/d1_generation_fence.mjs";
import { loadManifest } from "../tools/d1_manifest.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = loadManifest();
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

function baseSources() {
  return {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: "2026-09-01T00:00:00Z", source_row_count: 1, indexed_count: 1, coverage: [],
          documents: [{ title: "Alpha one", object_ref: "notice:a1" }],
        },
      },
    },
    ocp_awards: {
      materialized_at: "2026-09-01T00:00:00Z",
      rows: [{ request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 }],
    },
    entity_intelligence: {
      generated_at: "2026-09-01T00:00:00Z", observation_count: 1, entity_count: 1, multi_domain_count: 0,
      by_ref: {}, by_subject_ref: {},
    },
  };
}

function changedSources() {
  const sources = baseSources();
  sources.ocp_awards.materialized_at = "2026-09-02T00:00:00Z";
  sources.ocp_awards.rows.push({ request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20 });
  return sources;
}

/** A real delta plan, batch plan, generation claim, and successful publish receipt — the evidence a "published" run actually has on hand. */
async function publishedFixture({ holder = "publisher-a" } = {}) {
  const prior = baseSources();
  const current = changedSources();
  const priorSnapshot = snapshotFor(manifest, prior);
  const currentSnapshot = snapshotFor(manifest, current);
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });

  const store = createMemoryStateStore();
  const claim = await claimGeneration({
    store, holder, fingerprint: FINGERPRINT_B, watermarks: watermarksFromSnapshot(currentSnapshot),
  });
  assert.equal(claim.claimed, true);
  const batchPlan = planBatches({ plan, manifest, sourceDocuments: current, generation: claim.generation, maxOpsPerBatch: 500 });
  const publishReceipt = await publishBounded({
    batchPlan, manifest, fenceStore: store, holder, fingerprint: FINGERPRINT_B,
    executor: { execute: async () => {} },
  });
  assert.equal(publishReceipt.status, "complete");
  return { currentSnapshot, plan, batchPlan, publishReceipt, generation: claim.generation };
}

/** A publish attempt that fails partway: the batch fixture, an executor that fails once, and the resulting checkpoint receipt. */
async function failedFixture({ classification }) {
  const prior = baseSources();
  const current = changedSources();
  const priorSnapshot = snapshotFor(manifest, prior);
  const currentSnapshot = snapshotFor(manifest, current);
  const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });

  const store = createMemoryStateStore();
  const claim = await claimGeneration({
    store, holder: "publisher-a", fingerprint: FINGERPRINT_B, watermarks: watermarksFromSnapshot(currentSnapshot),
  });
  const batchPlan = planBatches({ plan, manifest, sourceDocuments: current, generation: claim.generation, maxOpsPerBatch: 1 });
  const executor = {
    execute: async () => {
      const error = new Error(classification === "transient" ? "request timed out" : "SQLITE_CONSTRAINT failed");
      if (classification === "transient") error.transient = true;
      throw error;
    },
  };
  const publishReceipt = await publishBounded({
    batchPlan, manifest, fenceStore: store, holder: "publisher-a", fingerprint: FINGERPRINT_B, executor,
    maxAttempts: 2, backoffMs: 0,
  });
  assert.equal(publishReceipt.status, "stopped_permanent_error");
  return { currentSnapshot, plan, batchPlan, publishReceipt, generation: claim.generation };
}

function tmpJsonlPath() {
  const dir = mkdtempSync(join(tmpdir(), "d1-publication-receipts-"));
  return { dir, path: join(dir, "receipts.jsonl") };
}

test("every schema, workflow, and outcome enum is exactly as documented", () => {
  assert.equal(D1_PUBLICATION_RECEIPT_SCHEMA, "cityscroll.d1-publication-receipt.v2");
  assert.deepEqual([...OUTCOMES].sort(), [
    "abandoned",
    "failed_permanent",
    "failed_transient_exhausted",
    "published",
    "rolled_back",
    "skipped_fence_busy",
    "skipped_fingerprint_unchanged",
  ]);
});

test("every D1 exit path produces exactly one valid terminal receipt with the right outcome", async () => {
  const published = await publishedFixture();
  const permanentFailure = await failedFixture({ classification: "permanent" });
  const transientExhausted = await failedFixture({ classification: "transient" });

  const cases = [
    {
      name: "gate skip: fingerprint unchanged",
      outcome: "skipped_fingerprint_unchanged",
      build: () => buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "1001", attempt: 1 },
        outcome: "skipped_fingerprint_unchanged",
        reason: "deploy fingerprint unchanged since the last publication",
        deployFingerprint: FINGERPRINT_A,
        previousFingerprint: FINGERPRINT_A,
      }),
      expectModels: false,
    },
    {
      name: "fence busy: another holder has a live claim",
      outcome: "skipped_fence_busy",
      build: () => buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "1002", attempt: 1 },
        outcome: "skipped_fence_busy",
        reason: "another publication run holds a live generation fence",
        deployFingerprint: FINGERPRINT_B,
        previousFingerprint: FINGERPRINT_A,
      }),
      expectModels: false,
    },
    {
      name: "publish success",
      outcome: "published",
      build: () => buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "1003", attempt: 1 },
        outcome: "published",
        reason: "D1 read models were published for this deploy fingerprint",
        deployFingerprint: FINGERPRINT_B,
        previousFingerprint: FINGERPRINT_A,
        generation: published.generation,
        snapshot: published.currentSnapshot,
        batchPlan: published.batchPlan,
        publishReceipt: published.publishReceipt,
        durationMs: 4200,
        verification: { status: "passed", detail: "post-deploy MCP canary read the published rows" },
      }),
      expectModels: true,
      extra: (receipt) => {
        assert.ok(receipt.totals.estimated_writes > 0);
        assert.equal(receipt.totals.estimated_writes, receipt.totals.observed_writes);
        assert.equal(receipt.verification.status, "passed");
      },
    },
    {
      name: "publisher failure: permanent error stops the generation",
      outcome: "failed_permanent",
      build: () => buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "1004", attempt: 1 },
        outcome: "failed_permanent",
        reason: "the publication SQL step failed; its generation fence claim was abandoned",
        deployFingerprint: FINGERPRINT_B,
        previousFingerprint: FINGERPRINT_A,
        generation: permanentFailure.generation,
        snapshot: permanentFailure.currentSnapshot,
        batchPlan: permanentFailure.batchPlan,
        publishReceipt: permanentFailure.publishReceipt,
      }),
      expectModels: true,
      extra: (receipt) => {
        assert.equal(receipt.retries.transient_failures, 0);
        assert.equal(receipt.totals.observed_writes, 0, "nothing completed before the permanent failure, but the attempt is a real zero-write observation");
        assert.ok(receipt.totals.estimated_writes > 0);
      },
    },
    {
      name: "publisher failure: transient retries exhausted",
      outcome: "failed_transient_exhausted",
      build: () => buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "1005", attempt: 1 },
        outcome: "failed_transient_exhausted",
        reason: "transient publication errors exhausted the retry budget",
        deployFingerprint: FINGERPRINT_B,
        previousFingerprint: FINGERPRINT_A,
        generation: transientExhausted.generation,
        snapshot: transientExhausted.currentSnapshot,
        batchPlan: transientExhausted.batchPlan,
        publishReceipt: transientExhausted.publishReceipt,
      }),
      expectModels: true,
      extra: (receipt) => {
        assert.ok(receipt.retries.transient_failures > 0);
      },
    },
    {
      name: "abandoned: generation superseded before SQL execution",
      outcome: "abandoned",
      build: () => buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "1006", attempt: 1 },
        outcome: "abandoned",
        reason: "the generation fence was superseded before SQL execution started",
        deployFingerprint: FINGERPRINT_B,
        previousFingerprint: FINGERPRINT_A,
        generation: 4,
      }),
      expectModels: false,
    },
  ];

  for (const testCase of cases) {
    const receipt = testCase.build();
    assert.equal(receipt.outcome, testCase.outcome, testCase.name);
    validatePublicationReceipt(receipt);
    assert.equal(receipt.models !== null, testCase.expectModels, `${testCase.name}: models presence`);
    testCase.extra?.(receipt);
  }

  // A rollback is its own run, compensating an earlier one rather than rewriting it.
  const rollbackReceipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "1007", attempt: 1 },
    outcome: "rolled_back",
    reason: "operator rollback after a permanent publication failure",
    deployFingerprint: FINGERPRINT_B,
    previousFingerprint: FINGERPRINT_A,
    rollback: {
      compensatesReceipt: "1004:1:none",
      rebuildCommand: "node tools/d1_explicit_rebuild.mjs --reason <reason> --source-snapshot <snapshot> --confirm <confirmation> --estimate-writes <n>",
      reason: "restore a consistent read model after the permanent failure",
    },
  });
  assert.equal(rollbackReceipt.outcome, "rolled_back");
  assert.equal(rollbackReceipt.rollback.compensates_receipt, "1004:1:none");
  validatePublicationReceipt(rollbackReceipt);

  const allReceipts = [...cases.map((c) => c.build()), rollbackReceipt];
  assertOneTerminalOutcomePerRun(allReceipts);
  assert.equal(new Set(allReceipts.map((r) => r.outcome)).size, OUTCOMES.length, "every outcome in the enum was exercised exactly once");
});

test("rollback is refused outside outcome=rolled_back, and required inside it", () => {
  assert.throws(
    () => buildPublicationReceipt({
      run: { workflow: "Deploy worker", run_id: "2001", attempt: 1 },
      outcome: "published",
      reason: "should not carry a rollback pointer",
      deployFingerprint: FINGERPRINT_A,
      rollback: { compensatesReceipt: "x", rebuildCommand: "node tools/d1_explicit_rebuild.mjs --reason <reason> --source-snapshot <snapshot> --confirm <confirmation> --estimate-writes <n>", reason: "n/a" },
    }),
    /rollback.*must be null unless outcome is "rolled_back"/,
  );
  assert.throws(
    () => validatePublicationReceipt({
      ...buildPublicationReceipt({
        run: { workflow: "Deploy worker", run_id: "2002", attempt: 1 },
        outcome: "rolled_back",
        reason: "placeholder",
        deployFingerprint: FINGERPRINT_A,
        rollback: { compensatesReceipt: "x", rebuildCommand: "node tools/build_worker_d1_read_models.mjs --mode rebuild", reason: "n/a" },
      }),
      rollback: null,
    }),
    PublicationReceiptError,
  );
});

test("the validator rejects an unknown field, a token-shaped string, an over-long identifier, and a row payload", () => {
  const base = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "3001", attempt: 1 },
    outcome: "skipped_fingerprint_unchanged",
    reason: "deploy fingerprint unchanged since the last publication",
    deployFingerprint: FINGERPRINT_A,
  });

  assert.throws(
    () => validatePublicationReceipt({ ...base, notes: "an undeclared field" }),
    /receipt\.notes is not a known field/,
  );

  // A dense, delimiter-free, mixed-case-plus-digit run — the general shape of an API
  // key or session token — generated rather than a literal lookalike constant.
  const denseOpaqueRun = Array.from({ length: 28 }, (_, i) => "Aa1Bb2Cc3Dd4Ee5Ff6"[i % 18]).join("");
  assert.throws(
    () => validatePublicationReceipt({ ...base, reason: denseOpaqueRun }),
    /looks like a secret or access token/,
  );
  assert.throws(
    () => validatePublicationReceipt({ ...base, run: { ...base.run, workflow: denseOpaqueRun } }),
    /looks like a secret or access token/,
  );

  assert.throws(
    () => validatePublicationReceipt({ ...base, run: { ...base.run, workflow: "w".repeat(500) } }),
    /must be at most \d+ characters/,
  );
  assert.throws(
    () => validatePublicationReceipt({ ...base, receipt_id: "r".repeat(500) }),
    /must be at most \d+ characters/,
  );

  // A row payload smuggled onto a model entry: real source-row columns, not a count.
  const withRowPayload = {
    ...base,
    models: [{
      model_id: "ocp_awards",
      model_version: 1,
      watermark_summary: null,
      delta_counts: null,
      batch_count: null,
      estimated_writes: null,
      observed_writes: null,
      row: { request_id: "r1", vendor_name: "Vendor A", contract_amount: 10 },
    }],
  };
  assert.throws(() => validatePublicationReceipt(withRowPayload), /receipt\.models\[0\]\.row is not a known field/);

  // A row payload smuggled in as a whole new top-level field.
  assert.throws(
    () => validatePublicationReceipt({ ...base, sample_row: { pin: "p1", agency_name: "DOT", vendor_name: "Vendor A" } }),
    /receipt\.sample_row is not a known field/,
  );
});

test("summarizeModels merges watermark provenance, delta/batch/estimated counts, and observed writes by model id", async () => {
  const { currentSnapshot, batchPlan, publishReceipt } = await publishedFixture();
  const models = summarizeModels({ snapshot: currentSnapshot, batchPlan, publishReceipt });
  const ocp = models.find((model) => model.model_id === "ocp_awards");
  assert.equal(ocp.model_version, 1);
  assert.ok(ocp.watermark_summary.min_watermark <= ocp.watermark_summary.max_watermark);
  assert.equal(ocp.delta_counts.insert, 1);
  assert.ok(ocp.batch_count >= 1);
  assert.equal(ocp.estimated_writes, ocp.observed_writes, "an uninterrupted publish observes exactly what was estimated");

  // A dry-run report alone (no publish receipt yet) still supplies delta/batch/estimated
  // counts, with observed_writes left null since nothing has actually run.
  const dryRun = dryRunReport({ plan: { manifest_fingerprint: batchPlan.manifest_fingerprint }, batchPlan });
  const fromDryRun = summarizeModels({ snapshot: currentSnapshot, dryRun });
  const ocpFromDryRun = fromDryRun.find((model) => model.model_id === "ocp_awards");
  assert.equal(ocpFromDryRun.estimated_writes, ocp.estimated_writes);
  assert.equal(ocpFromDryRun.observed_writes, null);

  assert.equal(summarizeModels({}), null, "no evidence at all summarizes to null, not an empty array");
});

test("observed_writes is a real zero, not null, for an attempted publish that completed no batches for a model", async () => {
  const { currentSnapshot, batchPlan, publishReceipt } = await failedFixture({ classification: "permanent" });
  const models = summarizeModels({ snapshot: currentSnapshot, batchPlan, publishReceipt });
  assert.ok(models.some((model) => model.observed_writes === 0), "an attempted-but-uncompleted model is a zero observation");
  assert.ok(models.every((model) => model.observed_writes !== null), "every model in an attempted publish gets an observation, even if zero");
});

test("a publish receipt without its batch plan cannot be attributed to a model", async () => {
  const { publishReceipt } = await publishedFixture();
  assert.throws(() => summarizeModels({ publishReceipt }), /batchPlan.*is required/);
});

test("retriesFromPublishReceipt counts total attempts and transient retries from completed batches", async () => {
  const { publishReceipt } = await publishedFixture();
  assert.deepEqual(retriesFromPublishReceipt(null), { attempts: 0, transient_failures: 0 });
  const retries = retriesFromPublishReceipt(publishReceipt);
  assert.equal(retries.attempts, publishReceipt.completed_batches.length);
  assert.equal(retries.transient_failures, 0);
});

test("recordPublicationReceipt appends without truncating and never allows a second terminal receipt for the same run", () => {
  const { path, dir } = tmpJsonlPath();
  try {
    const first = buildPublicationReceipt({
      run: { workflow: "Deploy worker", run_id: "4001", attempt: 1 },
      outcome: "failed_permanent", reason: "publication SQL step failed", deployFingerprint: FINGERPRINT_A,
    });
    recordPublicationReceipt({ receipt: first, localPath: path });

    const second = buildPublicationReceipt({
      run: { workflow: "Deploy worker", run_id: "4002", attempt: 1 },
      outcome: "published", reason: "D1 read models were published for this deploy fingerprint", deployFingerprint: FINGERPRINT_B,
    });
    recordPublicationReceipt({ receipt: second, localPath: path });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "append-only: both receipts are present, neither overwrote the other");
    assert.deepEqual(JSON.parse(lines[0]), first);
    assert.deepEqual(JSON.parse(lines[1]), second);

    const duplicateRun = buildPublicationReceipt({
      run: { workflow: "Deploy worker", run_id: "4001", attempt: 1 },
      outcome: "abandoned", reason: "a second receipt for the same run", deployFingerprint: FINGERPRINT_A,
    });
    assert.throws(() => recordPublicationReceipt({ receipt: duplicateRun, localPath: path }), /already has a terminal receipt/);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2, "the rejected duplicate was never appended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rollback appends a compensating receipt rather than rewriting the receipt it compensates", () => {
  const { path, dir } = tmpJsonlPath();
  try {
    const original = buildPublicationReceipt({
      run: { workflow: "Deploy worker", run_id: "5001", attempt: 1 },
      outcome: "failed_permanent", reason: "publication SQL step failed", deployFingerprint: FINGERPRINT_A,
    });
    recordPublicationReceipt({ receipt: original, localPath: path });

    const rollback = buildPublicationReceipt({
      run: { workflow: "Deploy worker", run_id: "5002", attempt: 1 },
      outcome: "rolled_back",
      reason: "operator rollback after the permanent failure",
      deployFingerprint: FINGERPRINT_A,
      rollback: {
        compensatesReceipt: original.receipt_id,
        rebuildCommand: "node tools/d1_explicit_rebuild.mjs --reason <reason> --source-snapshot <snapshot> --confirm <confirmation> --estimate-writes <n>",
        reason: "restore a consistent read model",
      },
    });
    recordPublicationReceipt({ receipt: rollback, localPath: path });

    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], original, "the original receipt was never rewritten");
    assert.equal(lines[1].rollback.compensates_receipt, original.receipt_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the KV store adapter receives exactly one put per receipt, keyed under the receipt prefix", async () => {
  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "6001", attempt: 1 },
    outcome: "published", reason: "D1 read models were published for this deploy fingerprint", deployFingerprint: FINGERPRINT_A,
  });
  const memoryStore = createMemoryReceiptStore();
  await appendReceiptToKv(memoryStore, receipt);
  assert.equal(memoryStore.puts.length, 1);
  assert.equal(memoryStore.puts[0].key, `d1-publication:receipt:v1:${receipt.receipt_id}`);
  assert.deepEqual(memoryStore.puts[0].value, receipt);

  const dir = mkdtempSync(join(tmpdir(), "d1-publication-receipt-kv-"));
  try {
    await appendReceiptToKv(fileReceiptStore(dir), receipt);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), "utf8")), receipt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeReceipt prints one compact line naming the run, generation, outcome, and writes", () => {
  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "7001", attempt: 2 },
    outcome: "skipped_fence_busy", reason: "another publication run holds a live generation fence", deployFingerprint: FINGERPRINT_A,
  });
  const line = summarizeReceipt(receipt);
  assert.equal(line.split("\n").length, 1);
  assert.match(line, /run=Deploy worker:7001:2/);
  assert.match(line, /outcome=skipped_fence_busy/);
});

test("compare totals estimated vs. observed writes deterministically, independent of receipt order", async () => {
  const { currentSnapshot, batchPlan, publishReceipt } = await publishedFixture({ holder: "publisher-b" });
  const published = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "8001", attempt: 1 },
    outcome: "published", reason: "published", deployFingerprint: FINGERPRINT_B,
    snapshot: currentSnapshot, batchPlan, publishReceipt,
    recordedAt: "2026-09-02T00:00:00Z",
  });
  const skipped = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "8002", attempt: 1 },
    outcome: "skipped_fingerprint_unchanged", reason: "unchanged", deployFingerprint: FINGERPRINT_B,
    recordedAt: "2026-09-03T00:00:00Z",
  });
  const outOfRange = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "8003", attempt: 1 },
    outcome: "skipped_fingerprint_unchanged", reason: "unchanged", deployFingerprint: FINGERPRINT_B,
    recordedAt: "2026-08-01T00:00:00Z",
  });

  const forward = compareReceipts([published, skipped, outOfRange], { from: "2026-09-01T00:00:00Z", to: "2026-09-10T00:00:00Z" });
  const shuffled = compareReceipts([outOfRange, skipped, published], { from: "2026-09-01T00:00:00Z", to: "2026-09-10T00:00:00Z" });
  assert.deepEqual(forward, shuffled, "order of the input receipts never changes the totals");

  assert.equal(forward.run_count, 2, "the out-of-range receipt is excluded");
  assert.equal(forward.by_outcome.published, 1);
  assert.equal(forward.by_outcome.skipped_fingerprint_unchanged, 1);
  assert.equal(forward.estimated_writes, published.totals.estimated_writes);
  assert.equal(forward.observed_writes, published.totals.observed_writes);
  assert.deepEqual(forward.receipt_ids, [published.receipt_id, skipped.receipt_id]);
});

test("the workflow records exactly one D1 publication receipt per run, covering every exit path", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const recordSteps = workflow.match(/- name: Record D1 publication receipt/g) || [];
  assert.equal(recordSteps.length, 1, "exactly one receipt-recording step exists");

  const stepIndex = workflow.indexOf("- name: Record D1 publication receipt");
  const stepText = workflow.slice(stepIndex, workflow.indexOf("\n      - name:", stepIndex + 1));
  assert.match(stepText, /if: always\(\)/);
  assert.match(stepText, /outcome=skipped_fingerprint_unchanged/);
  assert.match(stepText, /outcome=skipped_fence_busy/);
  assert.match(stepText, /outcome=published/);
  assert.match(stepText, /outcome=failed_permanent/);
  assert.match(stepText, /outcome=abandoned/);
  assert.match(stepText, /node tools\/d1_publication_receipt\.mjs record/);
  assert.match(stepText, /\.artifacts\/d1-publication-receipts\.jsonl/);

  assert.match(workflow, /\.artifacts\/d1-publication-receipts\.jsonl/);
  assert.ok(
    workflow.indexOf("- name: Record published D1 fingerprint") < stepIndex,
    "the receipt step observes the publish-completion step's outcome, so it must run after it",
  );
});
