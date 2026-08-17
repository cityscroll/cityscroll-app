import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  publicationValidationFinding,
  redactForPublication,
} from "../warehouse/experiments/semantic-layer-trial/build_corpus.mjs";
import {
  SOURCE_PASSAGE_MAP_SCHEMA,
  buildSourcePassageMap,
  resolveSourcePassageCandidate,
  validateSourcePassageMap,
} from "../warehouse/lib/source_passage_map.mjs";
import {
  OFFLINE_EMBEDDING_ARTIFACT_SCHEMA,
  OFFLINE_EMBEDDING_MODEL,
  buildOfflineEmbeddingArtifact,
  validateOfflineEmbeddingArtifact,
} from "../warehouse/lib/offline_embedding_artifact.mjs";
import { publishOfflineEmbeddingArtifact } from "../tools/build_offline_embedding_artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRIAL = join(ROOT, "warehouse/experiments/semantic-layer-trial");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("semantic trial corpus and receipts retain the fixed evaluation boundary", () => {
  const corpus = readJson(join(TRIAL, "corpus.json"));
  const retrieval = readJson(join(TRIAL, "receipts/retrieval_review.json"));
  const costs = readJson(join(TRIAL, "receipts/costs.json"));

  assert.equal(corpus.document_count, 122);
  assert.equal(retrieval.query_count, 30);
  assert.equal(retrieval.corpus.documents, 122);
  assert.equal(retrieval.corpus.chunks, 238);
  assert.equal(costs.model.id, "sentence-transformers/all-MiniLM-L6-v2");
  assert.equal(costs.model.dimensions_measured, 384);
  assert.equal(costs.build.metered_api_calls, 0);
  assert.equal(costs.build.metered_cost_usd, 0);
  assert.ok(
    corpus.documents.some((row) => row.publication_redactions?.meeting_credential > 0),
    "the fixture should retain counts for ingest-time meeting-credential redactions",
  );
  assert.ok(
    corpus.documents.every((row) => !/[?&]p[w]d=|\b(?:passcode|password|access code)\b/i.test(row.text)),
    "the committed corpus must not retain meeting credentials",
  );

  for (const query of retrieval.queries) {
    for (const results of Object.values(query.methods)) {
      for (const result of results) {
        assert.equal(result.honest_label, "retrieval_candidate");
      }
    }
  }
});

test("source-passage candidates serialize to one typed source and exact retained boundary", () => {
  const corpus = readJson(join(TRIAL, "corpus.json"));
  const serialized = readFileSync(join(TRIAL, "source_passage_map.json"), "utf8");
  const passageMap = JSON.parse(serialized);

  assert.equal(passageMap.schema, SOURCE_PASSAGE_MAP_SCHEMA);
  assert.equal(passageMap.source_count, corpus.document_count);
  assert.equal(passageMap.passage_count, 238);
  assert.equal(passageMap.unknown_passage_count, 0);
  assert.equal(validateSourcePassageMap(passageMap), passageMap);

  const candidateIds = Object.keys(passageMap.by_candidate_id);
  assert.equal(candidateIds.length, passageMap.passage_count);
  assert.equal(new Set(candidateIds).size, candidateIds.length);

  for (const candidateId of candidateIds) {
    const resolved = resolveSourcePassageCandidate(passageMap, candidateId);
    assert.equal(resolved.candidate_id, candidateId);
    assert.equal(resolved.source.source_record_id, resolved.passage.source_record_id);
    assert.equal(resolved.source.source_family, resolved.passage.source_family);
    assert.match(resolved.source.source_url, /^https:\/\//);
    assert.equal(resolved.source.coverage.state, "partial");
    assert.equal(resolved.source.freshness.state, "observed");

    const corpusRow = corpus.documents.find((row) => (
      row.id === resolved.source.source_native_id
      && row.kind === resolved.source.source_family
    ));
    assert.ok(corpusRow, `missing corpus source for ${candidateId}`);
    const { start, end, unit } = resolved.passage.boundary;
    assert.equal(unit, "utf16_code_unit");
    assert.equal(resolved.passage.text_state, "retained");
    assert.equal(resolved.passage.text, corpusRow.text.slice(start, end));
  }

  const roundTrip = JSON.parse(JSON.stringify(passageMap));
  const example = resolveSourcePassageCandidate(roundTrip, candidateIds.at(-1));
  assert.equal(example.source.source_url, passageMap.sources.at(-1).source_url);
  assert.deepEqual(example.source.freshness, passageMap.sources.at(-1).freshness);
  assert.deepEqual(example.source.coverage, passageMap.sources.at(-1).coverage);
});

test("missing source text stays unknown and cannot manufacture graph identities", () => {
  const passageMap = buildSourcePassageMap({
    schema: "cityscroll.semantic_layer_trial.corpus.v1",
    observed_on: "2026-08-04",
    selection: {},
    documents: [{
      id: "missing-text",
      kind: "city_record_notice",
      title: "Source record without retained text",
      published_at: null,
      source: {
        system: "NYC City Record",
        url: "https://a856-cityrecord.nyc.gov/RequestDetail/missing-text",
      },
    }],
  });
  const candidateId = Object.keys(passageMap.by_candidate_id)[0];
  const resolved = resolveSourcePassageCandidate(passageMap, candidateId);

  assert.equal(resolved.passage.text_state, "unknown");
  assert.equal(resolved.passage.text, null);
  assert.deepEqual(resolved.passage.boundary, {
    unit: "utf16_code_unit",
    start: null,
    end: null,
  });
  assert.equal(resolved.source.coverage.state, "unknown");
  assert.equal(resolved.source.freshness.state, "unknown");
  assert.equal(resolveSourcePassageCandidate(passageMap, "missing"), null);

  const serialized = JSON.stringify(passageMap);
  for (const forbidden of ["entity_id", "mandate_id", "subject_ref", "graph_edge", "cross_spine_edge"]) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }
});

test("offline embedding artifact is typed, pinned, normalized, and tied to the corpus manifest", () => {
  const manifest = readJson(join(ROOT, "warehouse/manifests/semantic_retrieval_corpus_manifest.json"));
  const passageMap = readJson(join(TRIAL, "source_passage_map.json"));
  const artifact = buildOfflineEmbeddingArtifact(manifest, passageMap);

  assert.equal(artifact.schema, OFFLINE_EMBEDDING_ARTIFACT_SCHEMA);
  assert.equal(artifact.authorization.runtime_semantic_retrieval, false);
  assert.equal(artifact.model.id, OFFLINE_EMBEDDING_MODEL.id);
  assert.equal(artifact.model.revision, OFFLINE_EMBEDDING_MODEL.revision);
  assert.equal(artifact.model.dimensions, 256);
  assert.equal(artifact.model.normalization, "l2");
  assert.equal(artifact.inputs.corpus_manifest_sha256, manifest.manifest_sha256);
  assert.equal(artifact.inputs.source_passage_map_sha256, passageMap.map_sha256);
  assert.equal(artifact.input_row_count, passageMap.passage_count);
  assert.equal(artifact.embedded_row_count, passageMap.passage_count);
  assert.equal(artifact.dropped_row_count, 0);
  assert.equal(validateOfflineEmbeddingArtifact(artifact), artifact);

  for (const row of artifact.rows) {
    assert.match(row.candidate_id, /^[^:]+:.+:p\d{4}$/);
    assert.equal(row.vector.length, artifact.model.dimensions);
    const norm = Math.sqrt(row.vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-5, `${row.candidate_id} is not L2-normalized`);
  }

  const reordered = buildOfflineEmbeddingArtifact(manifest, {
    ...passageMap,
    passages: [...passageMap.passages].reverse(),
  });
  assert.equal(reordered.artifact_sha256, artifact.artifact_sha256);
});

test("offline embedding artifact records dropped passage reasons", () => {
  const manifest = {
    schema: "cityscroll.semantic_retrieval.corpus_manifest.v1",
    manifest_sha256: "a".repeat(64),
    input_receipts: { corpus: { sha256: "b".repeat(64) } },
    records: [{ source_record_id: "city_record_notice:kept" }],
  };
  const passageMap = {
    schema: "cityscroll.semantic_retrieval.source_passage_map.v1",
    map_sha256: "c".repeat(64),
    passages: [
      {
        candidate_id: "city_record_notice:kept:p0001",
        passage_id: "city_record_notice:kept:p0001",
        source_record_id: "city_record_notice:kept",
        source_family: "city_record_notice",
        text_state: "retained",
        text: "A retained public passage",
        text_sha256: createHash("sha256").update("A retained public passage").digest("hex"),
      },
      {
        candidate_id: "city_record_notice:kept:p0002",
        passage_id: "city_record_notice:kept:p0002",
        source_record_id: "city_record_notice:kept",
        source_family: "city_record_notice",
        text_state: "unknown",
        text: null,
        text_sha256: null,
      },
      {
        candidate_id: "city_record_notice:outside:p0001",
        passage_id: "city_record_notice:outside:p0001",
        source_record_id: "city_record_notice:outside",
        source_family: "city_record_notice",
        text_state: "retained",
        text: "Outside the manifest",
        text_sha256: createHash("sha256").update("Outside the manifest").digest("hex"),
      },
    ],
  };

  const artifact = buildOfflineEmbeddingArtifact(manifest, passageMap);
  assert.equal(artifact.embedded_row_count, 1);
  assert.equal(artifact.dropped_row_count, 2);
  assert.deepEqual(artifact.dropped_reason_counts, {
    source_not_in_manifest: 1,
    text_not_retained: 1,
  });
});

test("failed embedding refresh preserves the prior-good pointer and lexical site", () => {
  const directory = mkdtempSync(join(tmpdir(), "cityscroll-offline-embedding-"));
  const manifest = readJson(join(ROOT, "warehouse/manifests/semantic_retrieval_corpus_manifest.json"));
  const passageMap = readJson(join(TRIAL, "source_passage_map.json"));
  const lexicalBefore = readFileSync(join(ROOT, "site/index.html"));
  try {
    const first = publishOfflineEmbeddingArtifact({ manifest, passageMap, outputDirectory: directory });
    const receiptBefore = readFileSync(first.receiptPath);
    const artifactBefore = readFileSync(first.artifactPath);

    assert.throws(() => publishOfflineEmbeddingArtifact({
      manifest: { ...manifest, manifest_sha256: "f".repeat(64) },
      passageMap,
      outputDirectory: directory,
      beforePointerSwap() { throw new Error("injected refresh failure"); },
    }), /injected refresh failure/);

    assert.deepEqual(readFileSync(first.receiptPath), receiptBefore);
    assert.deepEqual(readFileSync(first.artifactPath), artifactBefore);
    assert.deepEqual(readFileSync(join(ROOT, "site/index.html")), lexicalBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corpus sanitization is idempotent and diagnostics identify the exact failure", () => {
  const raw = "meeting number (access code) 26373696969 and password retained-value";
  const first = redactForPublication(raw);
  const second = redactForPublication(first.text);

  assert.equal(second.text, first.text);
  assert.deepEqual(second.counts, {
    email: 0,
    phone: 0,
    meeting_credential: 0,
    place_name: 0,
  });
  assert.equal(publicationValidationFinding({ id: "clean", text: first.text }), null);
  assert.deepEqual(
    publicationValidationFinding({ id: "notice-1", text: "Password: example-placeholder" }),
    {
      record_id: "notice-1",
      rule: "meeting_credential_marker",
      match: "Password: example-placeholder",
    },
  );
});

test("learned retrieval does not claim uplift beyond the ranked lexical baseline", () => {
  const receipt = readJson(join(TRIAL, "receipts/retrieval_review.json"));
  const { bm25, semantic, hybrid_rrf: hybrid } = receipt.metrics;

  assert.equal(bm25.precision_at_5_macro, 0.24);
  assert.equal(semantic.precision_at_5_macro, 0.24);
  assert.equal(hybrid.precision_at_5_macro, 0.2467);
  assert.equal(hybrid.queries_with_relevant_at_5, bm25.queries_with_relevant_at_5);
  assert.ok(hybrid.mrr_at_5 < bm25.mrr_at_5);
});

test("semantic joins remain review candidates and do not clear the usefulness gate", () => {
  const receipt = readJson(join(TRIAL, "receipts/join_candidate_review.json"));
  const decision = readJson(join(TRIAL, "receipts/decision.json"));

  assert.equal(receipt.production_wiring, false);
  assert.equal(receipt.candidate_generation.candidates_proposed, 1);
  assert.equal(receipt.candidate_generation.candidates_surviving_review, 1);
  assert.equal(receipt.candidate_generation.clears_usefulness_threshold, false);
  assert.equal(receipt.review_cost.seconds_per_accepted_candidate, 47);
  assert.ok(receipt.candidates.every((row) => row.honest_label === "join_candidate_only"));
  assert.ok(receipt.candidates.every((row) => row.production_edge_authorized === false));
  assert.equal(decision.decision_hook, "not-worth-it");
  assert.equal(decision.production_wiring_in_trial, false);
});

test("offline checks validate without model dependencies or network access", () => {
  const corpusCheck = spawnSync(
    process.execPath,
    [join(TRIAL, "build_corpus.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(corpusCheck.status, 0, corpusCheck.stderr);

  const receiptCheck = spawnSync(
    "python3",
    [join(TRIAL, "trial.py"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(receiptCheck.status, 0, receiptCheck.stderr);

  const passageMapCheck = spawnSync(
    process.execPath,
    [join(ROOT, "tools/build_source_passage_map.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(passageMapCheck.status, 0, passageMapCheck.stderr);

  const embeddingArtifactCheck = spawnSync(
    process.execPath,
    [join(ROOT, "tools/build_offline_embedding_artifact.mjs"), "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(embeddingArtifactCheck.status, 0, embeddingArtifactCheck.stderr || embeddingArtifactCheck.stdout);
});
