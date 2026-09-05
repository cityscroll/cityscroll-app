import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  D1_CANARY_EVIDENCE_SCHEMA,
  D1CanaryError,
  D1ReleasePolicyError,
  buildCanaryEvidence,
  classifyPartitionFindings,
  keyPredicate,
  loadReleasePolicy,
  parseArgs as parseCanaryArgs,
  runCanary,
  selectCanaryScope,
  validateReleasePolicy,
  verifyPartitionScope,
} from "../tools/d1_canary.mjs";
import {
  D1_RECONCILE_REPORT_SCHEMA,
  D1ReconcileError,
  buildReconcileReport,
  parseArgs as parseReconcileArgs,
  runReconcile,
  selectReconcileScope,
} from "../tools/d1_reconcile.mjs";
import {
  buildPublicationReceipt,
  validatePublicationReceipt,
  PublicationReceiptError,
} from "../tools/d1_publication_receipt.mjs";
import { PLAN_SCHEMA, planDelta, snapshotFor, watermarksFromSnapshot } from "../tools/d1_delta_plan.mjs";
import { claimGeneration, createMemoryStateStore } from "../tools/d1_generation_fence.mjs";
import { loadManifest } from "../tools/d1_manifest.mjs";
import { statementsForModel } from "../tools/build_worker_d1_read_models.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANARY_CLI = resolve(ROOT, "tools/d1_canary.mjs");
const RECONCILE_CLI = resolve(ROOT, "tools/d1_reconcile.mjs");
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
            { title: "Alpha one", summary: "first", object_ref: "notice:a1" },
            { title: "Alpha two", object_ref: "notice:a2", search_text: "second" },
          ],
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
      generated_at: "2026-09-01T00:00:00Z", observation_count: 2, entity_count: 1, multi_domain_count: 0,
      by_ref: { "vendor:a": { root: { kind: "vendor", display_name: "Vendor A" }, links: [], domains: {} } },
      by_subject_ref: {},
    },
  };
}

function changedSources() {
  const sources = baseSources();
  sources.ocp_awards.materialized_at = "2026-09-02T00:00:00Z";
  sources.ocp_awards.rows = [
    { ...sources.ocp_awards.rows[0], contract_amount: 15 }, // update
    sources.ocp_awards.rows[1],                             // unchanged
    { request_id: "r4", pin: "p4", start_date: "2026-01-04", agency_name: "DOB", vendor_name: "Vendor D", contract_amount: 40 }, // insert
  ];
  sources.keyword_search.families.alpha.as_of = "2026-09-03T00:00:00Z";
  sources.keyword_search.families.alpha.documents[0].title = "Alpha one revised";
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

function adapterFor(db) {
  return {
    async execute(sql) {
      db.exec("BEGIN;");
      try {
        db.exec(sql);
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    },
    async select(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
  };
}

/** Drops every SQL line mentioning `lossyTable`, simulating a batch renderer that silently loses writes for one table. */
function lossyAdapterFor(db, lossyTable) {
  const straight = adapterFor(db);
  return {
    ...straight,
    async execute(sql) {
      const filtered = sql.split("\n").filter((line) => !line.includes(lossyTable)).join("\n");
      await straight.execute(filtered);
    },
  };
}

async function claimTestGeneration({ current, holder = "test-canary", now = Date.now(), leaseMs = 10_000_000 }) {
  const store = createMemoryStateStore();
  const claim = await claimGeneration({ store, holder, fingerprint: FINGERPRINT_A, watermarks: watermarksFromSnapshot(current), now, leaseMs });
  assert.equal(claim.claimed, true);
  return { store, generation: claim.generation, holder, fingerprint: FINGERPRINT_A };
}

function testPolicy(overrides = {}) {
  return {
    schema: "cityscroll.d1-release-policy.v1",
    canary: { max_partitions: 3, max_rows: 200 },
    reconcile: { max_partitions: 25, max_rows: 5000 },
    abort_threshold: { max_findings: 25 },
    ...overrides,
  };
}

function withTempFile(value, run) {
  const dir = mkdtempSync(join(tmpdir(), "d1rc-08-"));
  const path = join(dir, "fixture.json");
  writeFileSync(path, JSON.stringify(value));
  try {
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- production policy -----------------------------------------------------

test("the checked-in production policy validates and declares canary scope, reconcile scope, and an abort threshold", () => {
  const policy = loadReleasePolicy();
  assert.equal(policy.schema, "cityscroll.d1-release-policy.v1");
  assert.ok(Number.isInteger(policy.canary.max_partitions) && policy.canary.max_partitions > 0);
  assert.ok(Number.isInteger(policy.canary.max_rows) && policy.canary.max_rows > 0);
  assert.ok(Number.isInteger(policy.reconcile.max_partitions) && policy.reconcile.max_partitions > 0);
  assert.ok(Number.isInteger(policy.reconcile.max_rows) && policy.reconcile.max_rows > 0);
  assert.ok(Number.isInteger(policy.abort_threshold.max_findings) && policy.abort_threshold.max_findings > 0);
});

test("the release policy rejects an unknown field and a non-positive bound", () => {
  assert.throws(() => validateReleasePolicy({ ...testPolicy(), extra: true }), D1ReleasePolicyError);
  assert.throws(() => validateReleasePolicy({ ...testPolicy(), canary: { max_partitions: 0, max_rows: 10 } }), D1ReleasePolicyError);
});

// --- canary: scope selection and policy refusal -----------------------------

test("canary selects a bounded partition set from a delta plan, greedily within the policy scope", () => {
  const prior = snapshotFor(manifest, baseSources());
  const current = snapshotFor(manifest, changedSources());
  const plan = planDelta({ prior, current });
  const policy = testPolicy({ canary: { max_partitions: 5, max_rows: 5 } });
  const scope = selectCanaryScope({ plan, policy });
  assert.ok(scope.selected.length > 0);
  assert.ok(scope.rows <= 5);
  assert.ok(scope.candidate_count >= scope.selected.length);
});

test("canary refuses an explicit scope request larger than the policy allows", () => {
  const prior = snapshotFor(manifest, baseSources());
  const current = snapshotFor(manifest, changedSources());
  const plan = planDelta({ prior, current });
  const policy = testPolicy({ canary: { max_partitions: 1, max_rows: 10 } });
  assert.throws(() => selectCanaryScope({ plan, policy, maxPartitions: 2 }), D1CanaryError);
  assert.throws(() => selectCanaryScope({ plan, policy, maxRows: 11 }), D1CanaryError);
});

test("canary refuses to run when no changed partition fits the policy scope at all", () => {
  const prior = snapshotFor(manifest, baseSources());
  const current = snapshotFor(manifest, changedSources());
  const plan = planDelta({ prior, current });
  const policy = testPolicy({ canary: { max_partitions: 5, max_rows: 1 } });
  assert.throws(() => selectCanaryScope({ plan, policy }), /no changed partition fits the canary policy/);
});

test("canary refuses a rebuild plan; it only canaries an incremental delta", () => {
  const current = snapshotFor(manifest, baseSources());
  const rebuildPlan = planDelta({ prior: null, current, rebuild: "first publication" });
  assert.throws(() => selectCanaryScope({ plan: rebuildPlan, policy: testPolicy() }), /delta plan only/);
});

// --- canary: positive and negative end-to-end fixtures ----------------------

test(
  "canary applies a bounded partition set through the bounded publisher and verifies it clean (positive fixture)",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const prior = baseSources();
    const current = changedSources();
    const priorSnapshot = snapshotFor(manifest, prior);
    const currentSnapshot = snapshotFor(manifest, current);
    const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });
    assert.equal(plan.schema, PLAN_SCHEMA);

    const { store, generation, holder, fingerprint } = await claimTestGeneration({ current: currentSnapshot });
    const db = openDatabase();
    seedRebuild(db, prior);
    const adapter = adapterFor(db);

    const evidence = await runCanary({
      plan, manifest, sourceDocuments: current, generation, policy: testPolicy(),
      fenceStore: store, holder, fingerprint, executor: adapter, adapter,
    });

    assert.equal(evidence.schema, D1_CANARY_EVIDENCE_SCHEMA);
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.publish_status, "complete");
    assert.equal(evidence.findings_count, 0);
    assert.deepEqual(evidence.findings, []);
    assert.ok(evidence.scope.selected.length > 0);
    assert.match(evidence.content_hash, /^[a-f0-9]{64}$/);
  },
);

test(
  "canary fails and never claims success when the applied target diverges from source-derived expectations (negative fixture)",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const prior = baseSources();
    const current = changedSources();
    const priorSnapshot = snapshotFor(manifest, prior);
    const currentSnapshot = snapshotFor(manifest, current);
    const plan = planDelta({ prior: priorSnapshot, current: currentSnapshot });

    const { store, generation, holder, fingerprint } = await claimTestGeneration({ current: currentSnapshot });
    const db = openDatabase();
    seedRebuild(db, prior);
    // A lossy executor drops every write to keyword_search_fts, simulating a
    // publisher that silently fails to converge one table while the rest of
    // the batch still reports success.
    const lossyAdapter = lossyAdapterFor(db, "keyword_search_fts");

    const evidence = await runCanary({
      plan, manifest, sourceDocuments: current, generation, policy: testPolicy({ canary: { max_partitions: 5, max_rows: 200 } }),
      fenceStore: store, holder, fingerprint, executor: lossyAdapter, adapter: adapterFor(db),
    });

    assert.equal(evidence.status, "failed");
    assert.ok(evidence.findings_count > 0, "the dropped fts write is caught as an invariant failure");
    assert.ok(evidence.findings.some((finding) => finding.table === "keyword_search_fts"));
  },
);

test("verifyPartitionScope and classifyPartitionFindings are pure and reusable outside a full canary run", async () => {
  const sources = baseSources();
  const entry = manifest.models.find((model) => model.model_id === "ocp_awards");
  const db = openDatabase();
  seedRebuild(db, sources);
  const adapter = adapterFor(db);
  const { findings } = await verifyPartitionScope({
    manifest, sourceDocuments: sources, adapter, selection: [{ model_id: "ocp_awards", partition: "__model__" }],
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(
    classifyPartitionFindings({
      entry, table: "ocp_awards_warehouse", partition: "__model__",
      expectedRows: [{ key: "k1", columns: { a: 1 } }],
      observedByKey: new Map(),
    }),
    [{ classification: "missing", model_id: "ocp_awards", table: "ocp_awards_warehouse", partition: "__model__", key: "k1" }],
  );
});

// --- reconcile: one dedicated test per finding classification ---------------

function seededDb(sources = baseSources()) {
  const db = openDatabase();
  seedRebuild(db, sources);
  return db;
}

test(
  "reconcile classifies a deleted row as missing",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    db.exec("DELETE FROM ocp_awards_warehouse WHERE request_id = 'r1'");
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy: testPolicy(), generation: 1 });
    assert.equal(report.schema, D1_RECONCILE_REPORT_SCHEMA);
    assert.equal(report.consistent, false);
    assert.equal(report.findings_by_classification.missing, 1);
    assert.ok(report.findings.some((finding) => finding.classification === "missing" && finding.table === "ocp_awards_warehouse"));
  },
);

test(
  "reconcile classifies a repeated key as duplicate",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    const existing = db.prepare("SELECT document_id, family_id, search_text FROM keyword_search_fts LIMIT 1").get();
    db.prepare("INSERT INTO keyword_search_fts (document_id, family_id, search_text) VALUES (?, ?, ?)")
      .run(existing.document_id, existing.family_id, existing.search_text);
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy: testPolicy(), generation: 1 });
    assert.equal(report.consistent, false);
    assert.equal(report.findings_by_classification.duplicate, 1);
    assert.ok(report.findings.some((finding) => finding.classification === "duplicate" && finding.table === "keyword_search_fts"));
  },
);

test(
  "reconcile classifies a row whose content differs from what the source currently derives as stale",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    db.exec("UPDATE entity_intelligence_entities SET display_name = 'Corrupted' WHERE entity_ref = 'vendor:a'");
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy: testPolicy(), generation: 1 });
    assert.equal(report.consistent, false);
    assert.equal(report.findings_by_classification.stale, 1);
    assert.ok(report.findings.some((finding) => finding.classification === "stale" && finding.table === "entity_intelligence_entities" && finding.key === "vendor:a"));
  },
);

test(
  "reconcile classifies a target row with no matching source identity as unexpected",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    db.prepare("INSERT INTO ocp_awards_warehouse (row_key, request_id, vendor_name) VALUES (?, ?, ?)")
      .run("ghost-key", "ghost", "Ghost Vendor");
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy: testPolicy(), generation: 1 });
    assert.equal(report.consistent, false);
    assert.equal(report.findings_by_classification.unexpected, 1);
    assert.ok(report.findings.some((finding) => finding.classification === "unexpected" && finding.table === "ocp_awards_warehouse" && finding.key === "ghost-key"));
  },
);

test(
  "reconcile on a clean generation reports consistent with every representative query and watermark passing",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy: testPolicy(), generation: 7 });
    assert.equal(report.generation, 7);
    assert.equal(report.consistent, true);
    assert.equal(report.truncated, false);
    assert.equal(report.findings_count, 0);
    assert.ok(report.watermarks.every((watermark) => watermark.status !== "mismatch"));
    assert.ok(report.representative_queries.every((query) => query.status !== "failed"));
  },
);

// --- reconcile: bounded scope, refusal, and truncation ----------------------

test("reconcile refuses an explicit scope request larger than the policy allows", () => {
  const policy = testPolicy({ reconcile: { max_partitions: 1, max_rows: 10 } });
  assert.throws(() => selectReconcileScope({ manifest, sourceDocuments: baseSources(), policy, maxPartitions: 2 }), D1ReconcileError);
  assert.throws(() => selectReconcileScope({ manifest, sourceDocuments: baseSources(), policy, maxRows: 11 }), D1ReconcileError);
});

test(
  "a reconcile scan bounded below the full partition set is reported truncated, never consistent",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    const policy = testPolicy({ reconcile: { max_partitions: 1, max_rows: 5000 } });
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy, generation: 1 });
    assert.equal(report.truncated, true);
    assert.equal(report.consistent, false, "a truncated reconcile is never reported as consistent even with zero findings so far");
  },
);

test(
  "reconcile stops accumulating findings once the abort threshold is reached and reports the run truncated",
  { skip: !DatabaseSync && "node:sqlite unavailable" },
  async () => {
    const sources = baseSources();
    const db = seededDb(sources);
    db.exec("DELETE FROM ocp_awards_warehouse WHERE request_id = 'r1'");
    db.exec("UPDATE entity_intelligence_entities SET display_name = 'Corrupted' WHERE entity_ref = 'vendor:a'");
    const policy = testPolicy({ abort_threshold: { max_findings: 1 } });
    const report = await runReconcile({ manifest, sourceDocuments: sources, adapter: adapterFor(db), policy, generation: 1 });
    assert.equal(report.truncated, true);
    assert.equal(report.consistent, false);
    assert.ok(report.findings_count >= 1);
  },
);

// --- exit codes: a mismatch is never reported as success --------------------

test("the canary CLI check exits non-zero on a failing evidence object and zero on a passing one", () => {
  const policy = testPolicy();
  const failing = buildCanaryEvidence({
    generation: 1, policy,
    scope: { candidate_count: 1, selected: [{ model_id: "ocp_awards", partition: "__model__" }], rows: 1, truncated: false },
    publishReceipt: { status: "complete" },
    verification: {
      findings: [{ classification: "missing", model_id: "ocp_awards", table: "ocp_awards_warehouse", partition: "__model__", key: "k1" }],
      watermarks: [], representativeQueries: [],
    },
  });
  const passing = buildCanaryEvidence({
    generation: 1, policy,
    scope: { candidate_count: 0, selected: [], rows: 0, truncated: false },
    publishReceipt: null, verification: null,
  });
  assert.equal(failing.status, "failed");
  assert.equal(passing.status, "passed");

  withTempFile(failing, (path) => {
    const result = spawnSync(process.execPath, [CANARY_CLI, "check", "--evidence", path]);
    assert.notEqual(result.status, 0);
  });
  withTempFile(passing, (path) => {
    const result = spawnSync(process.execPath, [CANARY_CLI, "check", "--evidence", path]);
    assert.equal(result.status, 0);
  });
});

test("the reconcile CLI check exits non-zero for every finding classification and for a truncated run", () => {
  const policy = testPolicy();
  const scope = { candidate_count: 1, selected: [{ model_id: "ocp_awards", partition: "__model__" }], rows: 1 };
  for (const classification of ["missing", "duplicate", "stale", "unexpected"]) {
    const report = buildReconcileReport({
      generation: 1, policy, scope,
      verification: {
        findings: [{ classification, model_id: "ocp_awards", table: "ocp_awards_warehouse", partition: "__model__", key: "k1" }],
        watermarks: [], representativeQueries: [],
      },
      truncated: false,
    });
    assert.equal(report.consistent, false, classification);
    withTempFile(report, (path) => {
      const result = spawnSync(process.execPath, [RECONCILE_CLI, "check", "--report", path]);
      assert.notEqual(result.status, 0, classification);
    });
  }

  const truncatedReport = buildReconcileReport({
    generation: 1, policy, scope,
    verification: { findings: [], watermarks: [], representativeQueries: [] },
    truncated: true,
  });
  assert.equal(truncatedReport.consistent, false, "a truncated report is never consistent even with zero findings");
  withTempFile(truncatedReport, (path) => {
    const result = spawnSync(process.execPath, [RECONCILE_CLI, "check", "--report", path]);
    assert.notEqual(result.status, 0);
  });

  const consistentReport = buildReconcileReport({
    generation: 1, policy, scope,
    verification: { findings: [], watermarks: [], representativeQueries: [] },
    truncated: false,
  });
  assert.equal(consistentReport.consistent, true);
  withTempFile(consistentReport, (path) => {
    const result = spawnSync(process.execPath, [RECONCILE_CLI, "check", "--report", path]);
    assert.equal(result.status, 0);
  });
});

// --- wired into the d1-07 publication receipt shape -------------------------

test("a publication receipt carries bounded canary and reconcile sections without losing any existing field", () => {
  const policy = testPolicy();
  const canaryEvidence = buildCanaryEvidence({
    generation: 3, policy,
    scope: { candidate_count: 1, selected: [{ model_id: "ocp_awards", partition: "__model__" }], rows: 2, truncated: false },
    publishReceipt: { status: "complete" },
    verification: { findings: [], watermarks: [{ model_id: "ocp_awards", partition: "__model__", status: "not_applicable", expected: null, observed: null }], representativeQueries: [] },
  });
  const reconcileReport = buildReconcileReport({
    generation: 3, policy,
    scope: { candidate_count: 3, selected: [], rows: 0 },
    verification: { findings: [], watermarks: [], representativeQueries: [] },
    truncated: false,
  });

  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "1234", attempt: 1 },
    outcome: "published",
    reason: "canary and reconcile both attached",
    deployFingerprint: FINGERPRINT_A,
    generation: 3,
    canaryEvidence,
    reconcileReport,
  });

  assert.equal(receipt.canary.status, "passed");
  assert.equal(receipt.canary.generation, 3);
  assert.equal(receipt.canary.content_hash, canaryEvidence.content_hash);
  assert.equal(receipt.reconcile.consistent, true);
  assert.equal(receipt.reconcile.content_hash, reconcileReport.content_hash);
  // every field d1-07 already produced is still present and unaffected
  assert.equal(receipt.run.workflow, "Deploy worker");
  assert.equal(receipt.outcome, "published");
  assert.equal(receipt.deploy_fingerprint, FINGERPRINT_A);
  validatePublicationReceipt(receipt);

  const withoutEither = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "5678", attempt: 1 },
    outcome: "skipped_fingerprint_unchanged",
    reason: "no canary or reconcile ran for this outcome",
    deployFingerprint: FINGERPRINT_A,
  });
  assert.equal(withoutEither.canary, null);
  assert.equal(withoutEither.reconcile, null);
  validatePublicationReceipt(withoutEither);
});

test("a receipt refuses a canary section claiming passed while a finding is recorded", () => {
  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "1", attempt: 1 },
    outcome: "published", reason: "x", deployFingerprint: FINGERPRINT_A,
  });
  const corrupted = { ...receipt, canary: { status: "passed", generation: 1, findings_count: 1, watermark_mismatch_count: 0, representative_query_failed_count: 0, content_hash: "a".repeat(64) } };
  assert.throws(() => validatePublicationReceipt(corrupted), PublicationReceiptError);
});

test("a receipt refuses a reconcile section claiming consistent while truncated is true", () => {
  const receipt = buildPublicationReceipt({
    run: { workflow: "Deploy worker", run_id: "1", attempt: 1 },
    outcome: "published", reason: "x", deployFingerprint: FINGERPRINT_A,
  });
  const corrupted = {
    ...receipt,
    reconcile: {
      consistent: true, truncated: true, generation: 1, findings_count: 0,
      findings_by_classification: { missing: 0, duplicate: 0, stale: 0, unexpected: 0 },
      content_hash: "a".repeat(64),
    },
  };
  assert.throws(() => validatePublicationReceipt(corrupted), PublicationReceiptError);
});

test("keyPredicate builds a bounded, escaped SQL predicate from the manifest's key columns", () => {
  const entry = manifest.models.find((model) => model.model_id === "ocp_awards");
  assert.equal(keyPredicate(entry, "ocp_awards_warehouse", ["r1's key"]), "row_key = 'r1''s key'");
});

// --- CLI argument parsing: bare boolean flags never swallow the next flag --

test("a bare boolean flag directly ahead of another flag is recorded as true, not the next flag's name", () => {
  // The exact production shape: --binding X --remote --config Y. A naive
  // parser that unconditionally consumes the next token as a value reads
  // --remote's value as "--config", then trips on the bare "Y" token that
  // follows — which is exactly how this ladder's fence CLI broke tonight.
  const argv = ["node", "tools/d1_canary.mjs", "select", "--binding", "ALERT_STATE", "--remote", "--config", "worker/wrangler.toml"];
  const args = parseCanaryArgs(argv);
  assert.equal(args.binding, "ALERT_STATE");
  assert.equal(args.remote, true);
  assert.equal(args.config, "worker/wrangler.toml");
});

test("a trailing bare boolean flag with nothing after it is recorded as true, not undefined swallowing past the array end", () => {
  const argv = ["node", "tools/d1_reconcile.mjs", "select", "--policy", "worker/d1-release-policy.json", "--remote"];
  const args = parseReconcileArgs(argv);
  assert.equal(args.policy, "worker/d1-release-policy.json");
  assert.equal(args.remote, true);
});

/**
 * Extract every `node tools/d1_*.mjs <command> ...` (or `node ../tools/d1_*.mjs`)
 * invocation from a GitHub Actions workflow's shell blocks, joining a
 * backslash-continued command onto one line and tokenizing it the way a
 * shell would: a double-quoted span (which may contain spaces, e.g. a
 * `${{ ... }}` expression) is one token.
 */
function extractD1Invocations(yamlText) {
  const lines = yamlText.split("\n");
  const invocations = [];
  const START = /^\s*node\s+(?:\.\.\/)?tools\/(d1_[a-z0-9_]+\.mjs)\s+(\S+)/;
  for (let index = 0; index < lines.length; index += 1) {
    const start = START.exec(lines[index]);
    if (!start) continue;
    const [, tool, command] = start;
    let joined = lines[index].trim();
    let cursor = index;
    while (joined.endsWith("\\")) {
      cursor += 1;
      joined = `${joined.slice(0, -1)} ${lines[cursor].trim()}`;
    }
    invocations.push({ tool, command, text: joined });
  }
  return invocations;
}

const SHELL_CONTROL_OPERATORS = new Set(["||", "&&", ";"]);

/** Splits one shell command line into words, stopping at an unquoted control operator (e.g. `|| true`) that ends the invocation's own argv. */
function splitShellWords(text) {
  const words = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const word = match[1] ?? match[2] ?? match[3];
    if (match[3] !== undefined && SHELL_CONTROL_OPERATORS.has(word)) break;
    words.push(word);
  }
  return words;
}

test("every d1_* CLI invocation in the deploy workflow parses through d1_canary and d1_reconcile without a flag swallowing another flag's name", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/deploy-worker.yml"), "utf8");
  const invocations = extractD1Invocations(workflow);
  assert.ok(invocations.length > 0, "the workflow does carry d1_* invocations to check against");

  for (const invocation of invocations) {
    const words = splitShellWords(invocation.text);
    // words[0]="node", words[1]="tools/d1_x.mjs" (or "../tools/..."), words[2]=command; the rest are flags/values.
    // A bash array expansion (`"${some_flag[@]}"`) expands at shell runtime to zero or more
    // literal words this static extraction cannot resolve; drop the placeholder rather than
    // feeding it to the parser as a bare (and therefore always-invalid) argument.
    const flagWords = words.slice(3).filter((word) => !/^\$\{[a-zA-Z_][a-zA-Z0-9_]*\[@\]\}$/.test(word));

    for (const [label, parse] of [["d1_canary.mjs", parseCanaryArgs], ["d1_reconcile.mjs", parseReconcileArgs]]) {
      const argv = ["node", `tools/${label}`, invocation.command, ...flagWords];
      let args;
      assert.doesNotThrow(() => {
        args = parse(argv);
      }, `${label} parsing ${invocation.tool} ${invocation.command}'s argv should not throw: ${invocation.text}`);
      for (const [flag, value] of Object.entries(args)) {
        if (flag === "command") continue;
        assert.ok(
          value === true || (typeof value === "string" && !value.startsWith("--")),
          `${label}: --${flag} must not have swallowed a following flag's name in ${invocation.tool} ${invocation.command}: ${invocation.text}`,
        );
      }
    }
  }
});
