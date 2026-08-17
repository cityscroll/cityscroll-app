import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CORPUS_MANIFEST_SCHEMA,
  buildCorpusManifest,
  serializeCorpusManifest,
  validateCorpusManifest,
} from "../tools/build_corpus_manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRIAL = join(ROOT, "warehouse/experiments/semantic-layer-trial");
const OUTPUT = join(ROOT, "warehouse/manifests/semantic_retrieval_corpus_manifest.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("published corpus manifest types every real retained source", () => {
  const corpus = readJson(join(TRIAL, "corpus.json"));
  const manifest = readJson(OUTPUT);

  assert.equal(manifest.schema, CORPUS_MANIFEST_SCHEMA);
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.authorization.runtime_semantic_retrieval, false);
  assert.equal(manifest.record_count, corpus.document_count);
  assert.equal(manifest.source_family_count, 3);
  assert.equal(manifest.dropped_record_count, 0);
  assert.deepEqual(
    manifest.source_families.map((family) => family.source_family),
    ["attachment_text", "city_record_notice", "community_board_minutes"],
  );

  for (const family of manifest.source_families) {
    assert.equal(family.type_version, 1);
    assert.equal(family.coverage.state, "partial");
    assert.ok(family.coverage.boundary);
    assert.deepEqual(family.passage_fields, ["title", "text"]);
    assert.deepEqual(family.civic_object_fields, ["civic_object_family"]);
    assert.deepEqual(family.geography_fields, ["body_id"]);
    assert.deepEqual(family.date_fields, ["published_at", "event_date"]);
    assert.equal(family.freshness_receipt.state, "observed");
    assert.equal(family.freshness_receipt.observed_on, corpus.observed_on);
  }

  const corpusKeys = new Set(corpus.documents.map((row) => `${row.kind}:${encodeURIComponent(row.id)}`));
  for (const record of manifest.records) {
    assert.ok(corpusKeys.has(record.source_record_id));
    assert.match(record.source_url, /^https:\/\//);
    assert.ok(["land", "rules", "meetings"].includes(record.civic_object_family));
    assert.equal(record.coverage_state, "partial");
    assert.equal(record.freshness_receipt.observed_on, corpus.observed_on);
    assert.equal(record.passage.text_state, "retained");
    assert.match(record.passage.content_sha256, /^[a-f0-9]{64}$/);
    assert.ok(record.passage.character_count > 0);
  }

  assert.equal(validateCorpusManifest(manifest), manifest);
});

test("manifest serialization is deterministic and content-sensitive", () => {
  const corpus = readJson(join(TRIAL, "corpus.json"));
  const sourceManifest = readJson(join(TRIAL, "source_manifest.json"));
  const options = {
    corpusReceipt: { path: "corpus.json", sha256: "a".repeat(64) },
    selectionReceipt: { path: "source_manifest.json", sha256: "b".repeat(64) },
  };
  const first = buildCorpusManifest(corpus, sourceManifest, options);
  const reordered = buildCorpusManifest(
    { ...corpus, documents: [...corpus.documents].reverse() },
    sourceManifest,
    options,
  );
  assert.equal(serializeCorpusManifest(first), serializeCorpusManifest(reordered));

  const changedCorpus = structuredClone(corpus);
  changedCorpus.documents[0].text += " changed";
  changedCorpus.documents[0].text_sha256 = sha256(changedCorpus.documents[0].text);
  const changed = buildCorpusManifest(changedCorpus, sourceManifest, options);
  assert.notEqual(changed.corpus_sha256, first.corpus_sha256);
  assert.notEqual(changed.manifest_sha256, first.manifest_sha256);
});

test("invalid input rows are retained as typed drop receipts with reasons", () => {
  const validText = "A retained public passage";
  const corpus = {
    schema: "cityscroll.semantic_layer_trial.corpus.v1",
    observed_on: "2026-08-04",
    selection: { notice_ids: "A bounded notice fixture." },
    documents: [
      {
        id: "kept",
        kind: "city_record_notice",
        title: "Kept",
        text: validText,
        text_sha256: sha256(validText),
        body_id: null,
        published_at: "2026-08-01",
        event_date: null,
        source: { url: "https://example.test/kept" },
      },
      {
        id: "missing-url",
        kind: "city_record_notice",
        title: "Dropped",
        text: "Still real text",
        text_sha256: sha256("Still real text"),
        source: {},
      },
      {
        id: "bad-checksum",
        kind: "city_record_notice",
        title: "Dropped too",
        text: "Content",
        text_sha256: "0".repeat(64),
        source: { url: "https://example.test/bad-checksum" },
      },
    ],
  };
  const manifest = buildCorpusManifest(corpus, {
    selection: corpus.selection,
    civic_object_groups: [{
      id: "rules",
      source_family: "city_record_notice",
      source_native_ids: ["kept"],
    }],
  });

  assert.equal(manifest.record_count, 1);
  assert.equal(manifest.dropped_record_count, 2);
  assert.deepEqual(manifest.dropped_reason_counts, {
    content_checksum_mismatch: 1,
    invalid_source_url: 1,
  });
  assert.deepEqual(
    manifest.dropped_records.map((row) => [row.source_native_id, row.reason]),
    [
      ["bad-checksum", "content_checksum_mismatch"],
      ["missing-url", "invalid_source_url"],
    ],
  );
  assert.equal(validateCorpusManifest(manifest), manifest);
});

test("committed corpus manifest is current", () => {
  const check = spawnSync(
    process.execPath,
    [join(ROOT, "tools/build_corpus_manifest.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
});
