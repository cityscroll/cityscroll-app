import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildExplicitRebuild,
  expectedConfirmation,
  parseArgs as parseRebuildArgs,
  snapshotSha256,
} from "../tools/d1_explicit_rebuild.mjs";
import { parseArgs as parseGeneratorArgs } from "../tools/build_worker_d1_read_models.mjs";
import { loadManifest } from "../tools/d1_manifest.mjs";
import { runReconcile } from "../tools/d1_reconcile.mjs";
import { snapshotFor } from "../tools/d1_delta_plan.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const GENERATOR = join(ROOT, "tools/build_worker_d1_read_models.mjs");
const MIGRATIONS = [
  "worker/migrations/0025_search_and_ocp_read_models.sql",
  "worker/migrations/0026_entity_intelligence_read_model.sql",
];
const manifest = loadManifest();

function sourcesAt(date = "2026-09-01T00:00:00Z") {
  return {
    keyword_search: {
      families: {
        alpha: {
          source: "alpha-src", as_of: date, source_row_count: 2, indexed_count: 2, coverage: [],
          documents: [
            { title: "Alpha one", summary: "first", object_ref: "notice:a1" },
            { title: "Alpha two", object_ref: "notice:a2", search_text: "second" },
          ],
        },
      },
    },
    ocp_awards: {
      materialized_at: date,
      rows: [
        { request_id: "r1", pin: "p1", start_date: "2026-01-01", agency_name: "DOT", vendor_name: "Vendor A", contract_amount: 10 },
      ],
    },
    entity_intelligence: {
      generated_at: date, observation_count: 1, entity_count: 1, multi_domain_count: 0,
      by_ref: { "vendor:a": { root: { kind: "vendor", display_name: "Vendor A" }, links: [], domains: {} } },
      by_subject_ref: {},
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "d1rc-09-"));
  const sourceDocuments = sourcesAt();
  const currentDocuments = sourcesAt("2026-09-02T00:00:00Z");
  currentDocuments.ocp_awards.rows.push({
    request_id: "r2", pin: "p2", start_date: "2026-01-02", agency_name: "DEP", vendor_name: "Vendor B", contract_amount: 20,
  });
  const sourcePath = join(dir, "source-snapshot.json");
  writeFileSync(sourcePath, `${JSON.stringify(snapshotFor(manifest, sourceDocuments), null, 2)}\n`);
  return { dir, sourcePath, sourceDocuments, currentDocuments };
}

function buildFixture(outputDir, values = {}) {
  const f = values.fixture || fixture();
  const snapshotBytes = readFileSync(f.sourcePath);
  const sourceHash = snapshotSha256(snapshotBytes);
  return buildExplicitRebuild({
    reason: values.reason || "repair a deliberately selected derived-state backfill",
    sourceSnapshotPath: f.sourcePath,
    confirm: values.confirm || expectedConfirmation(values.reason || "repair a deliberately selected derived-state backfill", sourceHash),
    estimateWrites: values.estimateWrites || 42,
    outputDir,
    actor: values.actor || "release-operator",
    runId: values.runId || "9001",
    workflow: "D1 explicit rebuild",
    attempt: 1,
    manifest,
    sourceDocuments: values.currentDocuments || f.currentDocuments,
    currentSnapshot: snapshotFor(manifest, values.currentDocuments || f.currentDocuments),
  });
}

function withoutGitHubIdentity(run) {
  const saved = { actor: process.env.GITHUB_ACTOR, runId: process.env.GITHUB_RUN_ID };
  delete process.env.GITHUB_ACTOR;
  delete process.env.GITHUB_RUN_ID;
  try {
    return run();
  } finally {
    if (saved.actor === undefined) delete process.env.GITHUB_ACTOR;
    else process.env.GITHUB_ACTOR = saved.actor;
    if (saved.runId === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = saved.runId;
  }
}

test("ordinary generation refuses a rebuild request and keeps the legacy file", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1rc-09-generator-"));
  try {
    const result = spawnSync(process.execPath, [GENERATOR, "--mode", "rebuild", "--output-dir", dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reserved for tools\/d1_explicit_rebuild/);
    assert.match(readFileSync(GENERATOR, "utf8").slice(0, 500), /Legacy SQL generator/);
    assert.equal(parseGeneratorArgs(["node", GENERATOR]).mode, "upsert");
    assert.throws(() => parseGeneratorArgs(["node", GENERATOR, "--mode", "rebuild"]), /reserved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow argv parses through the explicit tool's parser", () => {
  const args = parseRebuildArgs([
    "node", "tools/d1_explicit_rebuild.mjs",
    "--reason", "repair a derived state backfill",
    "--source-snapshot", "worker/.d1-read-models/partition-snapshot.json",
    "--confirm", "d1-rebuild-confirmation",
    "--estimate-writes", "42",
    "--actor", "release-operator",
    "--run-id", "9001",
    "--workflow", "D1 explicit rebuild",
    "--attempt", "1",
    "--output-dir", ".artifacts/d1-explicit-rebuild",
  ]);
  assert.equal(args.reason, "repair a derived state backfill");
  assert.equal(args.sourceSnapshotPath, resolve(ROOT, "worker/.d1-read-models/partition-snapshot.json"));
  assert.equal(args.estimateWrites, "42");
  assert.equal(args.outputDir, resolve(ROOT, ".artifacts/d1-explicit-rebuild"));
});

test("manual rebuild refuses each missing required input", () => {
  const f = fixture();
  const base = {
    sourceSnapshotPath: f.sourcePath,
    confirm: expectedConfirmation("reason", snapshotSha256(readFileSync(f.sourcePath))),
    estimateWrites: 42,
    outputDir: join(f.dir, "out"),
    actor: "release-operator",
    runId: "9001",
    manifest,
    sourceDocuments: f.currentDocuments,
  };
  assert.throws(() => buildExplicitRebuild({ ...base, reason: "" }), /reason/);
  assert.throws(() => buildExplicitRebuild({ ...base, sourceSnapshotPath: null, reason: "reason" }), /source-snapshot/);
  assert.throws(() => buildExplicitRebuild({ ...base, confirm: "wrong", reason: "reason" }), /confirm/);
  assert.throws(() => buildExplicitRebuild({ ...base, estimateWrites: 0, reason: "reason" }), /estimate-writes/);
  withoutGitHubIdentity(() => {
    assert.throws(() => buildExplicitRebuild({ ...base, actor: null, reason: "reason" }), /actor/);
    assert.throws(() => buildExplicitRebuild({ ...base, runId: null, reason: "reason" }), /run-id/);
  });
  rmSync(f.dir, { recursive: true, force: true });
});

test("explicit rebuild stages deterministic output and records the guarded inputs", () => {
  const f = fixture();
  const firstDir = join(f.dir, "first");
  const secondDir = join(f.dir, "second");
  const first = buildFixture(firstDir, { fixture: f });
  const second = buildFixture(secondDir, { fixture: f });
  for (const name of [
    "rebuild-plan.json", "bounded-publish-plan.json", "bounded-publish-dry-run.json",
    "publication-receipt.json", "staging-manifest.json",
    "keyword_search_read_model.sql", "ocp_awards_read_model.sql", "entity_intelligence_read_model.sql",
  ]) {
    assert.deepEqual(readFileSync(join(firstDir, name)), readFileSync(join(secondDir, name)), name);
  }
  assert.equal(first.receipt.actor, "release-operator");
  assert.equal(first.receipt.run.run_id, "9001");
  assert.equal(first.receipt.rebuild.source_snapshot_sha256, first.sourceSnapshotHash);
  assert.equal(first.receipt.rebuild.estimated_writes, 42);
  assert.equal(first.receipt.reason, "repair a deliberately selected derived-state backfill");
  assert.equal(first.plan.operation, "rebuild");
  assert.equal(first.dryRun.schema, "cityscroll.d1-bounded-publish-dry-run.v1");
  rmSync(f.dir, { recursive: true, force: true });
});

test("the staged SQL reconciles cleanly in the D1-08 fixture", { skip: !process.versions.sqlite && "node:sqlite unavailable" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = fixture();
  const result = buildFixture(join(f.dir, "out"), { fixture: f });
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) db.exec(readFileSync(join(ROOT, migration), "utf8"));
  for (const name of ["keyword_search_read_model.sql", "ocp_awards_read_model.sql", "entity_intelligence_read_model.sql"]) {
    db.exec(readFileSync(join(result.outputDir, name), "utf8"));
  }
  const report = await runReconcile({
    manifest,
    sourceDocuments: f.currentDocuments,
    adapter: { select: async (sql, params = []) => db.prepare(sql).all(...params) },
    policy: { schema: "cityscroll.d1-release-policy.v1", canary: { max_partitions: 3, max_rows: 200 }, reconcile: { max_partitions: 25, max_rows: 5000 }, abort_threshold: { max_findings: 25 } },
    generation: 1,
  });
  assert.equal(report.consistent, true);
  assert.equal(report.findings_count, 0);
  rmSync(f.dir, { recursive: true, force: true });
});
