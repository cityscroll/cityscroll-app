import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DERIVED_AGGREGATE_RELATIVE,
  FORBIDDEN_AGGREGATE_RELATIVE,
  SHARD_DIRECTORY_RELATIVE,
  aggregatePlacementShards,
  derivePlacementFacts,
  documentTree,
  expectedShardValues,
  hasRawInventoryRows,
  privateSchemeFindings,
  trackedAggregateFindings,
  idForShardPath,
  loadPlacementShards,
  shardPathForId,
} from "../tools/rcp03_evidence_placement.mjs";
import { aggregateArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";

const FACTS = derivePlacementFacts();

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "rcp06-placement-"));
  cpSync(SHARD_DIRECTORY_RELATIVE, directory, { recursive: true });
  return directory;
}

function loadFixture(directory) {
  return loadPlacementShards({ directory, facts: FACTS });
}

function readShard(directory, id) {
  return JSON.parse(readFileSync(join(directory, shardPathForId(id)), "utf8"));
}

function writeShard(directory, id, document) {
  writeFileSync(join(directory, shardPathForId(id)), `${JSON.stringify(document, null, 2)}\n`);
}

function failure(directory) {
  try {
    loadFixture(directory);
  } catch (error) {
    return error.message;
  }
  return null;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "rcp06-repo-"));
  const run = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=Check", "-c", "user.email=check@example.test", ...args], { encoding: "utf8" });
  run("init", "--initial-branch=main", "--quiet");
  return { root, run };
}

test("the whole-repository placement receipt is no longer a tracked file", () => {
  const tracked = execFileSync("git", ["ls-files", "--", FORBIDDEN_AGGREGATE_RELATIVE], { encoding: "utf8" }).trim();
  assert.equal(tracked, "", `${FORBIDDEN_AGGREGATE_RELATIVE} must stay derived at check time`);
  assert.equal(existsSync(FORBIDDEN_AGGREGATE_RELATIVE), false);
  const ignored = spawnSync("git", ["check-ignore", "-q", FORBIDDEN_AGGREGATE_RELATIVE]);
  assert.equal(ignored.status, 0, "the derived aggregate path must stay ignored");
});

test("placement inputs are owned per document tree and decode to exactly one key", () => {
  assert.equal(documentTree("docs/analytics-readiness-audit.md"), "docs");
  assert.equal(documentTree("docs/evidence/authority-native-procurement/before/capture.json"), "docs/evidence");
  assert.equal(shardPathForId("document-tree:docs/evidence"), "document-tree--docs--evidence.json");
  assert.equal(idForShardPath("document-tree--docs--evidence.json"), "document-tree:docs/evidence");
  assert.equal(idForShardPath("scrim-inventory.json"), "scrim-inventory");
  for (const id of expectedShardValues(FACTS).keys()) assert.equal(idForShardPath(shardPathForId(id)), id);
  assert.throws(() => shardPathForId("document-tree:docs/EVIDENCE"), /unsupported document tree/);
});

test("the derived receipt keeps the v1 contract and every RCP-03 count", () => {
  const receipt = aggregatePlacementShards(loadFixture(SHARD_DIRECTORY_RELATIVE), { directory: SHARD_DIRECTORY_RELATIVE });
  assert.equal(receipt.schema, "cityscroll.repository_evidence_placement.v1");
  assert.equal(receipt.card, "cityscroll-repository-control-plane/rcp-03");
  assert.equal(receipt.privacy_model, "placement-not-deletion");
  assert.equal(receipt.generated_at, "2026-08-31T00:00:00.000Z");
  assert.equal(receipt.private_inventory.scrim_review.row_count, 1144);
  assert.equal(receipt.private_inventory.document_count, 51);
  assert.equal(receipt.private_inventory.reference_count, 2644);
  assert.equal(receipt.public_result.raw_inventory_rows_retained, 0);
  assert.equal(receipt.public_result.private_reference_occurrences_retained_in_public_content, 0);
  assert.equal(receipt.served_artifact_baseline.sha256, receipt.served_artifact_baseline.expected_after_sha256);
  assert.equal(receipt.served_artifact_baseline.reference, "inspected-main-commit");
  assert.equal(receipt.history_treatment, "none; this is a tip-level placement change");

  // Every retained document keeps its digest-backed disposition and maintainer resolution.
  for (const row of receipt.private_inventory.private_reference_documents) {
    assert.match(row.source_sha256, /^[a-f0-9]{64}$/);
    assert.equal(row.disposition, "register:cityscroll-repository-control-plane/rcp-03#private-evidence");
    assert.equal(row.maintainer_resolution, "register:cityscroll-repository-control-plane/rcp-03#authorized-maintainer-access");
  }
  const paths = receipt.private_inventory.private_reference_documents.map((row) => row.path);
  assert.deepEqual(paths, [...paths].sort(), "document rows aggregate in stable path order");
  assert.equal(new Set(paths).size, paths.length);

  // Aggregation is check-time only and names its own source inputs.
  assert.equal(receipt.materialization.mode, "derived-at-check-time");
  assert.equal(receipt.materialization.tracked_aggregate, null);
  assert.equal(receipt.materialization.compatibility_projection, DERIVED_AGGREGATE_RELATIVE);
  assert.equal(receipt.materialization.input_revision, receipt.inspected_main_commit);
  assert.deepEqual(
    receipt.materialization.shards.map((row) => row.id),
    [...receipt.materialization.shards].map((row) => row.id).sort(),
  );
  for (const row of receipt.materialization.shards) {
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(row.path.startsWith(`${SHARD_DIRECTORY_RELATIVE}/`));
  }
});

test("the same pinned inputs derive identical receipt content and hashes", () => {
  const first = aggregatePlacementShards(loadFixture(SHARD_DIRECTORY_RELATIVE), { directory: SHARD_DIRECTORY_RELATIVE });
  const directory = fixtureDirectory();
  try {
    const second = aggregatePlacementShards(loadFixture(directory), { directory });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing placement input fails closed", () => {
  const directory = fixtureDirectory();
  try {
    rmSync(join(directory, shardPathForId("document-tree:docs/screenshots")));
    const message = failure(directory);
    assert.match(message, /missing required placement input document-tree:docs\/screenshots/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale placement input fails closed", () => {
  const directory = fixtureDirectory();
  try {
    const shard = readShard(directory, "scrim-inventory");
    shard.input_revision = "0".repeat(40);
    writeShard(directory, "scrim-inventory", shard);
    assert.match(failure(directory), /stale input_revision/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a malformed placement input fails closed", () => {
  const directory = fixtureDirectory();
  try {
    writeFileSync(join(directory, shardPathForId("preservation")), "{ not json");
    assert.match(failure(directory), /preservation\.json: malformed JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a duplicate owner for one semantic key fails closed", () => {
  const directory = fixtureDirectory();
  try {
    const shard = readShard(directory, "public-result");
    shard.id = "preservation";
    writeShard(directory, "public-result", shard);
    const message = failure(directory);
    assert.match(message, /id\/path mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a semantically incomplete document tree fails closed", () => {
  const directory = fixtureDirectory();
  try {
    const shard = readShard(directory, "document-tree:docs/evidence");
    shard.value.documents = shard.value.documents.slice(1);
    shard.value.document_count = shard.value.documents.length;
    writeShard(directory, "document-tree:docs/evidence", shard);
    assert.match(failure(directory), /document-tree--docs--evidence\.json: placement input does not match the inspected commit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unregistered placement input fails closed", () => {
  const directory = fixtureDirectory();
  try {
    const shard = readShard(directory, "document-tree:docs");
    shard.id = "document-tree:site";
    shard.owner = "document-tree:site";
    writeShard(directory, "document-tree:site", shard);
    assert.match(failure(directory), /stale or unregistered placement input document-tree:site/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unowned or extended placement input fails closed", () => {
  const directory = fixtureDirectory();
  try {
    const shard = readShard(directory, "bibliography");
    shard.owner = "preservation";
    shard.rationale = "not a declared field";
    writeShard(directory, "bibliography", shard);
    const message = failure(directory);
    assert.match(message, /owner must equal stable semantic key/);
    assert.match(message, /unsupported field rationale/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retained public policy, contracts, and merge-throughput evidence stay accepted", () => {
  const receipt = aggregatePlacementShards(loadFixture(SHARD_DIRECTORY_RELATIVE), { directory: SHARD_DIRECTORY_RELATIVE });
  for (const path of ["ARCHITECTURE.md", "docs/architecture.md", "docs/adr"]) assert.ok(existsSync(path), `${path} is retained`);
  for (const path of receipt.preservation.architecture) assert.ok(existsSync(path.replace(/\/$/, "")), `${path} is retained`);
  for (const path of receipt.preservation.mt7_evidence) assert.ok(existsSync(path.replace(/\/$/, "")), `${path} is retained`);
  assert.ok(existsSync("architecture/evidence.d/cityscroll-merge-throughput--mt-8-architecture-evidence-generated-aggregates.json"));
  assert.ok(existsSync("ontology"), "public source contracts are retained");
  assert.ok(existsSync("test/fixtures"), "fixtures are retained");
  assert.ok(existsSync("docs/evidence"), "legitimate public evidence is retained");
  assert.ok(existsSync("docs/repository-control-plane/evidence-placement-shard.v1.schema.json"));
  assert.ok(existsSync(`${SHARD_DIRECTORY_RELATIVE}/README.md`));

  // Placement inputs never overlap the served product trees.
  const covered = [
    receipt.private_inventory.scrim_review.source_path_at_inspected_commit,
    ...receipt.private_inventory.private_reference_documents.map((row) => row.path),
    ...receipt.materialization.shards.map((row) => row.path),
  ];
  for (const path of covered) {
    assert.equal(path.startsWith("site/") || path.startsWith("worker/"), false, `${path} must not touch a served tree`);
  }
});

test("independent changes to different document trees do not collide", () => {
  const merged = (setup) => {
    const { root, run } = repository();
    try {
      setup.baseline(root);
      run("add", "-A");
      run("commit", "--quiet", "-m", "baseline");
      for (const [branch, apply] of Object.entries(setup.changes)) {
        run("checkout", "--quiet", "-B", branch, "main");
        apply(root);
        run("add", "-A");
        run("commit", "--quiet", "-m", branch);
      }
      const branches = Object.keys(setup.changes);
      run("checkout", "--quiet", branches[0]);
      const merge = spawnSync("git", ["-C", root, "-c", "user.name=Check", "-c", "user.email=check@example.test", "merge", "--no-edit", branches[1]], { encoding: "utf8" });
      const conflicted = execFileSync("git", ["-C", root, "diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean);
      return { status: merge.status, conflicted };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  // Before: one committed whole-repository aggregate that every change had to rewrite.
  const aggregateOf = (digest, count) => `${JSON.stringify({
    schema: "cityscroll.repository_evidence_placement.v1",
    served_artifact_baseline: { file_count: count, sha256: digest, expected_after_sha256: digest },
  }, null, 2)}\n`;
  const before = merged({
    baseline: (root) => writeFileSync(join(root, "evidence-placement.v1.json"), aggregateOf("0".repeat(64), 2748)),
    changes: {
      "tree-evidence": (root) => writeFileSync(join(root, "evidence-placement.v1.json"), aggregateOf("1".repeat(64), 2749)),
      "tree-screenshots": (root) => writeFileSync(join(root, "evidence-placement.v1.json"), aggregateOf("2".repeat(64), 2750)),
    },
  });
  assert.notEqual(before.status, 0, "the shared whole-repository aggregate collides");
  assert.deepEqual(before.conflicted, ["evidence-placement.v1.json"]);

  // After: each document tree owns its own placement input, so the same two changes merge cleanly.
  const touch = (id) => (root) => {
    const shardPath = join(root, "evidence-placement.d", shardPathForId(id));
    const shard = JSON.parse(readFileSync(shardPath, "utf8"));
    shard.value.documents = [...shard.value.documents].reverse();
    writeFileSync(shardPath, `${JSON.stringify(shard, null, 2)}\n`);
  };
  const after = merged({
    baseline: (root) => cpSync(SHARD_DIRECTORY_RELATIVE, join(root, "evidence-placement.d"), { recursive: true }),
    changes: {
      "tree-evidence": touch("document-tree:docs/evidence"),
      "tree-screenshots": touch("document-tree:docs/screenshots"),
    },
  });
  assert.equal(after.status, 0, "independent document trees must merge without a rebase");
  assert.deepEqual(after.conflicted, []);
});


test("private schemes and raw inventory rows stay rejected from retained public content", () => {
  const directory = mkdtempSync(join(tmpdir(), "rcp06-guard-"));
  try {
    const scheme = ["backstage", "://", "cityscroll-evidence/"].join("");
    writeFileSync(join(directory, "policy.md"), "# Retained public policy\n\nNo private locator here.\n");
    writeFileSync(join(directory, "leak.md"), `A retained note citing ${scheme}capture-001.json\n`);
    writeFileSync(join(directory, "served.mjs"), `export const source = "${scheme}capture-002.json";\n`);
    assert.deepEqual(privateSchemeFindings(["policy.md"], { root: directory }), []);
    assert.deepEqual(privateSchemeFindings(["leak.md"], { root: directory }), ["leak.md: private evidence scheme remains"]);
    assert.deepEqual(
      privateSchemeFindings(["served.mjs"], { root: directory, detail: "private evidence scheme remains in a served artifact" }),
      ["served.mjs: private evidence scheme remains in a served artifact"],
    );
    assert.deepEqual(privateSchemeFindings(["absent.md"], { root: directory }), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(hasRawInventoryRows(readFileSync("docs/repository-scrim-review.md", "utf8")), false);
  assert.equal(hasRawInventoryRows("| PB-0001 | docs/example.md | tip | benign-public |\n"), true);
});

test("reintroducing the whole-repository aggregate fails the check", () => {
  const { root, run } = repository();
  try {
    mkdirSync(join(root, "docs", "repository-control-plane"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# Fixture\n");
    run("add", "-A");
    run("commit", "--quiet", "-m", "baseline");
    assert.deepEqual(trackedAggregateFindings(root), []);
    writeFileSync(join(root, FORBIDDEN_AGGREGATE_RELATIVE), "{}\n");
    run("add", "-A");
    const findings = trackedAggregateFindings(root);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /must not be tracked; it is derived at check time/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("every disposition and maintainer resolution names a registered card", () => {
  const architecture = aggregateArchitectureEvidence({});
  assert.equal(architecture.status, "PASS");
  const registered = new Set(architecture.sourceCards.cards.map((row) => row.id));
  const receipt = aggregatePlacementShards(loadFixture(SHARD_DIRECTORY_RELATIVE), { directory: SHARD_DIRECTORY_RELATIVE });
  const references = [
    receipt.private_inventory.scrim_review.disposition,
    receipt.private_inventory.scrim_review.maintainer_resolution,
    receipt.private_inventory.unresolved_research_owner,
    ...receipt.private_inventory.private_reference_documents.flatMap((row) => [row.disposition, row.maintainer_resolution]),
    ...receipt.bibliography_mapping.map((row) => row.disposition).filter(Boolean),
  ];
  assert.ok(references.length > 100);
  for (const reference of references) {
    const match = /^register:([^#]+)#([a-z-]+)$/.exec(reference);
    assert.ok(match, `${reference} must be a register reference`);
    assert.ok(registered.has(match[1]), `${match[1]} must be a registered card`);
  }
  assert.ok(registered.has("cityscroll-repository-control-plane/rcp-06"), "this change registers its own entry");
});

test("the placement check passes on the current tip and under a merge-group ref", () => {
  const output = execFileSync("node", ["tools/rcp03_evidence_placement.mjs", "--check"], { encoding: "utf8" });
  assert.match(output, /served artifacts unchanged/);
  assert.match(output, /1144 review rows, 2644 private references/);
  assert.match(output, /source-owned inputs/);

  const mergeGroupHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const mergeGroupOutput = execFileSync("node", ["tools/rcp03_evidence_placement.mjs", "--check"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "merge_group", GITHUB_SHA: mergeGroupHead },
  });
  assert.match(mergeGroupOutput, /served artifacts unchanged/);
});

test("the derived receipt cannot be written back into the tracked tree", () => {
  const result = spawnSync("node", ["tools/rcp03_evidence_placement.mjs", "--write", "--output-dir", "docs/repository-control-plane"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must never be written into the tracked tree/);
  assert.equal(existsSync(FORBIDDEN_AGGREGATE_RELATIVE), false);
});
