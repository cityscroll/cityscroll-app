import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildManifest, scanUnclassifiedFixture, validateManifest } from "../tools/repository_control_plane_manifest.mjs";

test("manifest enumerates every required current-main candidate", () => {
  const manifest = buildManifest();
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.inspection.frontier_enumerated_count, 33);
  assert.equal(manifest.inspection.frontier_declared_count, 31);
  assert.equal(manifest.inspection.frontier_discrepancy, 2);
  assert.equal(manifest.entries.filter((item) => item.id.startsWith("frontier:") && item.id !== "frontier:declared-count-discrepancy").length, 33);
  assert.equal(manifest.entries.filter((item) => item.id.startsWith("lens:")).length, 5);
  assert.equal(manifest.entries.filter((item) => item.id.startsWith("architecture-decision:")).length, 2);
  assert.equal(manifest.entries.filter((item) => item.id.startsWith("private-uri:")).length, manifest.inspection.private_uri_document_count);
  assert.ok(manifest.entries.some((item) => item.id === "agents:durable-routing"));
  assert.ok(manifest.entries.some((item) => item.id === "agents:implementation-scrapbook"));
  assert.ok(manifest.entries.some((item) => item.id === "scrim:generated-inventory"));
});

test("validation fails closed on every required field", () => {
  const manifest = buildManifest();
  for (const field of ["canonical_owner", "kraken_id", "stable_replacement_reference", "history_treatment"]) {
    const candidate = structuredClone(manifest);
    delete candidate.entries[0][field];
    assert.ok(validateManifest(candidate).some((finding) => finding.includes(`missing ${field}`)));
  }
});

test("unclassified planning, owner decisions, and private evidence fail with named findings", () => {
  const path = "test/fixtures/repository_control_plane/negative/unclassified.md";
  const findings = scanUnclassifiedFixtureDocuments([[path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]]);
  assert.deepEqual(findings, [
    `${path}: private-evidence-uri`,
    `${path}: unclassified-rollout-register`,
    `${path}: unresolved-owner-decision`,
  ]);
});

test("accepted ADR and implementation evidence fixtures pass", () => {
  const paths = [
    "test/fixtures/repository_control_plane/positive/accepted-adr.md",
    "test/fixtures/repository_control_plane/positive/code-evidence.json",
    "test/fixtures/repository_control_plane/positive/test-example.mjs",
    "test/fixtures/repository_control_plane/positive/fixture-example.json",
    "test/fixtures/repository_control_plane/positive/mt7-shard.json",
  ];
  const documents = paths.map((path) => ({ path, text: readFileSync(new URL(`../${path}`, import.meta.url), "utf8") }));
  assert.deepEqual(scanUnclassifiedFixture(documents), []);
});

function scanUnclassifiedFixtureDocuments(rows) {
  return scanUnclassifiedFixture(rows.map(([path, text]) => ({ path, text })));
}
