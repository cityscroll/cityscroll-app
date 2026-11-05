import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  publishProcurementDocuments,
  readProcurementDocumentPublication,
} from "../tools/publish_procurement_documents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DATA = path.join(ROOT, "site/data");
const MANIFEST_PATH = path.join(PUBLIC_DATA, "procurement_documents.json");
const SHARD_PATH = path.join(PUBLIC_DATA, "procurement_documents/rfx-37728.json");

function copyCommittedPublication(destination) {
  mkdirSync(path.join(destination, "procurement_documents"), { recursive: true });
  cpSync(MANIFEST_PATH, path.join(destination, "procurement_documents.json"));
  cpSync(SHARD_PATH, path.join(destination, "procurement_documents/rfx-37728.json"));
}

test("A1: the served manifest and shard declare matching contract bytes and rows", () => {
  const publication = readProcurementDocumentPublication(PUBLIC_DATA);
  assert.equal(publication.manifest.schema, "cityscroll.procurement_document_read_model.v1");
  assert.equal(publication.manifest.representation, "sharded");
  assert.equal(publication.shards.length, 1);
  const [{ entry, bytes, shard }] = publication.shards;
  assert.equal(entry.rfp_id, "37728");
  assert.equal(entry.bytes, bytes.length);
  assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(entry.row_count, shard.rows.length);
  assert.equal(shard.subject.rfp_id, "37728");
  assert.equal(shard.subject.bpm_id, "37402");
  assert.equal(shard.subject.round_label, "1");

  const events = shard.rows.flatMap((row) => row.events || []);
  assert.deepEqual(events.map((event) => event.local), [
    "2026-11-09T14:00:00",
    "2026-11-09T15:00:00",
  ]);
  const facts = new Map(shard.rows.flatMap((row) => row.facts || []).map((fact) => [fact.id, fact]));
  for (const id of ["bid-bond", "bid-security", "performance-bond", "payment-bond"]) {
    assert.equal(facts.get(id)?.applicability, "not_applicable", id);
  }
});

test("A2: publication copies validated bytes and leaves the shared read model untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "procurement-document-publication-"));
  const generatedDir = path.join(root, "generated");
  const siteDataDir = path.join(root, "site/data");
  copyCommittedPublication(generatedDir);
  mkdirSync(siteDataDir, { recursive: true });
  const sharedPath = path.join(siteDataDir, "shared_procurement_read_model.json");
  const sharedBytes = Buffer.from('{"sentinel":"unchanged"}\n');
  writeFileSync(sharedPath, sharedBytes);

  try {
    const result = publishProcurementDocuments({ generatedDir, siteDataDir });
    assert.equal(result.row_count, 2);
    assert.ok(readFileSync(path.join(siteDataDir, "procurement_documents.json")).equals(readFileSync(MANIFEST_PATH)));
    assert.ok(readFileSync(path.join(siteDataDir, "procurement_documents/rfx-37728.json")).equals(readFileSync(SHARD_PATH)));
    assert.ok(readFileSync(sharedPath).equals(sharedBytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2: a missing generated shard fails before changing served output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "procurement-document-publication-missing-"));
  const generatedDir = path.join(root, "generated");
  const siteDataDir = path.join(root, "site/data");
  copyCommittedPublication(generatedDir);
  mkdirSync(siteDataDir, { recursive: true });
  const destinationManifest = path.join(siteDataDir, "procurement_documents.json");
  const original = Buffer.from('{"served":"previous"}\n');
  writeFileSync(destinationManifest, original);
  rmSync(path.join(generatedDir, "procurement_documents"), { recursive: true, force: true });

  try {
    assert.throws(
      () => publishProcurementDocuments({ generatedDir, siteDataDir }),
      /missing generated output/,
    );
    assert.ok(readFileSync(destinationManifest).equals(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3: the public readback exposes its generation time and shard hash inputs", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const shardBytes = readFileSync(SHARD_PATH);
  const shard = JSON.parse(shardBytes.toString("utf8"));
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(manifest.shards[0].path, "procurement_documents/rfx-37728.json");
  assert.equal(manifest.shards[0].sha256, createHash("sha256").update(shardBytes).digest("hex"));
  assert.ok(shard.rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));
});
