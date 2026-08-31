import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENTRY_DIR,
  ENTRY_SCHEMA,
  PROJECTIONS_RELATIVE,
  SOURCE_CARDS_RELATIVE,
  aggregateArchitectureEvidence,
  encodeEntryId,
  entryRelativePath,
  renderJson,
  sha256Text,
} from "../tools/architecture_evidence_shards.mjs";
import { evaluateCardReconciliation } from "../tools/card_reconciliation_guard.mjs";
import {
  parseReconciliationTriggerPaths,
  pathMatchesTriggerFilter,
} from "../tools/architecture_path_coverage.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = path.join(ROOT, "tools", "architecture_evidence_shards.mjs");
const FIXTURE = path.join(ROOT, "test", "fixtures", "architecture-evidence-shards");

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function put(root, relative, contents) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof contents === "string" ? contents : renderJson(contents));
  return path.relative(root, target).split(path.sep).join("/");
}

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), "cityscroll-architecture-evidence-"));
}

function runCli(args, { cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function validEntry(id, extra = {}) {
  return {
    schema: ENTRY_SCHEMA,
    id,
    status: "implemented",
    fingerprint: `${encodeEntryId(id)}.v1`,
    updated_at: "2026-08-30T00:00:00.000Z",
    projections: extra.projections || [
      { id: `${id}-surface`, path: `site/data/${encodeEntryId(id)}.json` },
    ],
  };
}

test("entry-id-to-path mapping is deterministic and collision-safe", () => {
  assert.equal(
    entryRelativePath("cityscroll-land-map-view/lm-02-project-point-materializer"),
    "architecture/evidence.d/cityscroll-land-map-view--lm-02-project-point-materializer.json",
  );
  assert.equal(encodeEntryId("fixture-stream/card-alpha"), "fixture-stream--card-alpha");
  const root = tmpRoot();
  try {
    put(root, entryRelativePath("owner/has--dash"), validEntry("owner/has--dash"));
    const result = aggregateArchitectureEvidence({ root, compareCommitted: false });
    assert.equal(result.status, "FAIL");
    assert.ok(result.findings.some((row) => row.includes("collision-safe")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration parity preserves the monolithic land-map inventories", () => {
  const root = tmpRoot();
  try {
    const source = readFileSync(
      path.join(FIXTURE, "migration/entries/cityscroll-land-map-view--lm-02-project-point-materializer.json"),
      "utf8",
    );
    put(root, "architecture/evidence.d/cityscroll-land-map-view--lm-02-project-point-materializer.json", source);
    const result = aggregateArchitectureEvidence({ root, compareCommitted: false });
    assert.equal(result.status, "PASS", result.findings.join("; "));
    const expectedSource = JSON.parse(readFileSync(path.join(FIXTURE, "migration/expected/source-cards.json"), "utf8"));
    const expectedProjections = JSON.parse(readFileSync(path.join(FIXTURE, "migration/expected/projections.json"), "utf8"));
    assert.deepEqual(result.sourceCards, expectedSource);
    assert.deepEqual(result.projections.projections, expectedProjections.projections);
    assert.equal(result.projections.membership, "declared");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-entry aggregation sorts by stable id and is byte-identical on repeat", () => {
  const root = tmpRoot();
  try {
    put(root, entryRelativePath("stream/z-last"), validEntry("stream/z-last"));
    put(root, entryRelativePath("stream/a-first"), validEntry("stream/a-first"));
    const first = aggregateArchitectureEvidence({ root, compareCommitted: false });
    const second = aggregateArchitectureEvidence({ root, compareCommitted: false });
    assert.equal(first.status, "PASS", first.findings.join("; "));
    assert.deepEqual(first.sourceCards.cards.map((row) => row.id), ["stream/a-first", "stream/z-last"]);
    assert.deepEqual(first.projections.projections.map((row) => row.id), [
      "stream/a-first-surface",
      "stream/z-last-surface",
    ]);
    assert.equal(first.sourceCardsText, second.sourceCardsText);
    assert.equal(first.projectionsText, second.projectionsText);
    assert.equal(first.receipt.source_cards_sha256, digest(first.sourceCardsText));
    assert.equal(first.receipt.projections_sha256, digest(first.projectionsText));
    assert.equal(first.receipt.source_cards_sha256, second.receipt.source_cards_sha256);
    assert.equal(first.receipt.projections_sha256, second.receipt.projections_sha256);
    assert.equal(first.receipt.source_cards_sha256, sha256Text(first.sourceCardsText));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate and colliding entries fail closed", () => {
  const mismatch = tmpRoot();
  const collidingProjection = tmpRoot();
  try {
    put(mismatch, "architecture/evidence.d/wrong-name.json", validEntry("owner/real-id"));
    const mismatchResult = aggregateArchitectureEvidence({ root: mismatch, compareCommitted: false });
    assert.equal(mismatchResult.status, "FAIL");
    assert.ok(mismatchResult.findings.some((row) => row.includes("does not match path")));

    put(collidingProjection, entryRelativePath("owner/one"), validEntry("owner/one", {
      projections: [{ id: "shared", path: "site/data/shared.json" }],
    }));
    put(collidingProjection, entryRelativePath("owner/two"), validEntry("owner/two", {
      projections: [{ id: "other", path: "site/data/shared.json" }],
    }));
    const collision = aggregateArchitectureEvidence({
      root: collidingProjection,
      compareCommitted: false,
    });
    assert.equal(collision.status, "FAIL");
    assert.ok(collision.findings.some((row) => row.includes("colliding ids")));
  } finally {
    rmSync(mismatch, { recursive: true, force: true });
    rmSync(collidingProjection, { recursive: true, force: true });
  }
});

test("malformed, unsupported, missing, and unregistered shards fail closed", () => {
  const malformed = tmpRoot();
  const unsupported = tmpRoot();
  const missing = tmpRoot();
  const unregistered = tmpRoot();
  try {
    put(malformed, entryRelativePath("owner/bad"), "{");
    const malformedResult = aggregateArchitectureEvidence({ root: malformed, compareCommitted: false });
    assert.equal(malformedResult.status, "FAIL");
    assert.ok(malformedResult.findings.some((row) => row.includes("malformed")));

    put(unsupported, entryRelativePath("owner/future"), {
      ...validEntry("owner/future"),
      schema: "cityscroll.architecture-evidence-entry.v2",
    });
    const unsupportedResult = aggregateArchitectureEvidence({
      root: unsupported,
      compareCommitted: false,
    });
    assert.equal(unsupportedResult.status, "FAIL");
    assert.ok(unsupportedResult.findings.some((row) => row.includes("unsupported schema version")));

    const missingResult = aggregateArchitectureEvidence({ root: missing, compareCommitted: false });
    assert.equal(missingResult.status, "FAIL");
    assert.ok(missingResult.findings.some((row) => row.includes("is missing")));

    put(unregistered, entryRelativePath("owner/ok"), validEntry("owner/ok"));
    put(unregistered, "architecture/evidence.d/notes.txt", "not an entry\n");
    const unregisteredResult = aggregateArchitectureEvidence({
      root: unregistered,
      compareCommitted: false,
    });
    assert.equal(unregisteredResult.status, "FAIL");
    assert.ok(unregisteredResult.findings.some((row) => row.includes("unregistered")));
  } finally {
    rmSync(malformed, { recursive: true, force: true });
    rmSync(unsupported, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
    rmSync(unregistered, { recursive: true, force: true });
  }
});

test("stale generated aggregate fails closed without mutating shards", () => {
  const root = tmpRoot();
  try {
    const entryPath = put(root, entryRelativePath("owner/live"), validEntry("owner/live"));
    const before = readFileSync(path.join(root, entryPath), "utf8");
    const fresh = aggregateArchitectureEvidence({ root, compareCommitted: false });
    put(root, SOURCE_CARDS_RELATIVE, fresh.sourceCardsText);
    put(root, PROJECTIONS_RELATIVE, {
      schema: "cityscroll.card-projection-inventory.v1",
      projections: [],
    });
    const stale = aggregateArchitectureEvidence({ root, compareCommitted: true });
    assert.equal(stale.status, "FAIL");
    assert.ok(stale.findings.some((row) => row.includes(PROJECTIONS_RELATIVE) && row.includes("stale")));
    assert.equal(readFileSync(path.join(root, entryPath), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two independent card changes own disjoint entry files and aggregate without a shared registry edit", () => {
  const alphaFile = "architecture/evidence.d/fixture-stream--card-alpha.json";
  const bravoFile = "architecture/evidence.d/fixture-stream--card-bravo.json";
  const alphaChange = [alphaFile];
  const bravoChange = [bravoFile];
  assert.deepEqual(alphaChange.filter((row) => bravoChange.includes(row)), []);
  assert.equal(alphaChange.includes(SOURCE_CARDS_RELATIVE), false);
  assert.equal(alphaChange.includes(PROJECTIONS_RELATIVE), false);
  assert.equal(bravoChange.includes(SOURCE_CARDS_RELATIVE), false);
  assert.equal(bravoChange.includes(PROJECTIONS_RELATIVE), false);

  const root = tmpRoot();
  try {
    put(root, alphaFile, readFileSync(path.join(FIXTURE, "independent/fixture-stream--card-alpha.json"), "utf8"));
    put(root, bravoFile, readFileSync(path.join(FIXTURE, "independent/fixture-stream--card-bravo.json"), "utf8"));
    const result = aggregateArchitectureEvidence({ root, compareCommitted: false });
    assert.equal(result.status, "PASS", result.findings.join("; "));
    assert.deepEqual(result.receipt.entry_ids, [
      "fixture-stream/card-alpha",
      "fixture-stream/card-bravo",
    ]);
    const reconciliation = evaluateCardReconciliation({
      sourceCards: result.sourceCards,
      projections: result.projections,
    });
    assert.equal(reconciliation.status, "PASS", reconciliation.findings.join("; "));
    assert.equal(existsSync(path.join(root, SOURCE_CARDS_RELATIVE)), false);
    assert.equal(existsSync(path.join(root, PROJECTIONS_RELATIVE)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live shards aggregate, reconcile, and keep architecture path coverage", () => {
  const live = aggregateArchitectureEvidence({ root: ROOT, compareCommitted: true });
  assert.equal(live.status, "PASS", live.findings.join("; "));
  assert.ok(live.receipt.entry_ids.includes(
    "cityscroll-land-map-view/lm-02-project-point-materializer",
  ));
  assert.ok(live.receipt.entry_ids.includes(
    "cityscroll-merge-throughput/mt-7-architecture-evidence-shards",
  ));
  assert.ok(live.receipt.entry_ids.includes(
    "cityscroll-procurement-intent-radar/pir-4",
  ));
  const reconciliation = evaluateCardReconciliation({
    sourceCards: live.sourceCards,
    projections: live.projections,
  });
  assert.equal(reconciliation.status, "PASS", reconciliation.findings.join("; "));
  const patterns = parseReconciliationTriggerPaths();
  assert.equal(pathMatchesTriggerFilter(`${ENTRY_DIR}/cityscroll-land-map-view--lm-02-project-point-materializer.json`, patterns), true);
  assert.equal(pathMatchesTriggerFilter("tools/architecture_evidence_shards.mjs", patterns), true);
  assert.equal(pathMatchesTriggerFilter("architecture/evidence-entry.v1.schema.json", patterns), true);
});

test("CLI --check is read-only and --write is the only aggregate writer", () => {
  const check = runCli(["--check"]);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const payload = JSON.parse(check.stdout);
  assert.equal(payload.status, "PASS");
  assert.equal(payload.receipt.entry_count >= 2, true);

  const isolated = tmpRoot();
  try {
    put(isolated, entryRelativePath("owner/cli"), validEntry("owner/cli"));
    const staleCheck = runCli(["--check", "--root", isolated]);
    assert.notEqual(staleCheck.status, 0);
    assert.match(staleCheck.stderr, /missing|stale/);
    const written = runCli(["--write", "--root", isolated]);
    assert.equal(written.status, 0, written.stderr || written.stdout);
    const after = runCli(["--check", "--root", isolated]);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.equal(existsSync(path.join(isolated, SOURCE_CARDS_RELATIVE)), true);
    assert.equal(existsSync(path.join(isolated, PROJECTIONS_RELATIVE)), true);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
