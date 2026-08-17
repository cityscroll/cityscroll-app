import { createHash } from "node:crypto";

import {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  EMBED_DIM,
  EMBED_METHOD_HASHED,
  MAX_EMBED_CHARS,
  buildIdf,
  embedDocument,
} from "./attachment_embeddings.mjs";

export const OFFLINE_EMBEDDING_ARTIFACT_SCHEMA =
  "cityscroll.semantic_retrieval.offline_embedding_artifact.v1";

export const OFFLINE_EMBEDDING_MODEL = Object.freeze({
  id: "cityscroll/hashed-ngram-tfidf",
  revision: EMBED_METHOD_HASHED,
  implementation: "warehouse/lib/attachment_embeddings.mjs",
  dimensions: EMBED_DIM,
  normalization: "l2",
  configuration: Object.freeze({
    feature_space: "signed_fnv1a_word_and_character_ngrams",
    weighting: "corpus_idf_with_augmented_term_frequency",
    maximum_input_characters: MAX_EMBED_CHARS,
    document_chunk_characters: CHUNK_CHARS,
    document_chunk_overlap_characters: CHUNK_OVERLAP,
    vector_number_format: "decimal_float_8",
  }),
});

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function countReasons(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function artifactChecksumPayload(artifact) {
  const { artifact_sha256: _checksum, ...payload } = artifact;
  return payload;
}

function roundedVector(vector) {
  return [...vector].map((value) => Number(value.toFixed(8)));
}

function droppedPassage(passage, reason) {
  return {
    candidate_id: String(passage?.candidate_id || "").trim() || null,
    passage_id: String(passage?.passage_id || "").trim() || null,
    source_record_id: String(passage?.source_record_id || "").trim() || null,
    source_family: String(passage?.source_family || "").trim() || null,
    reason,
  };
}

export function buildOfflineEmbeddingArtifact(manifest, passageMap) {
  if (manifest?.schema !== "cityscroll.semantic_retrieval.corpus_manifest.v1") {
    throw new Error("offline embedding artifact requires corpus manifest v1");
  }
  if (passageMap?.schema !== "cityscroll.semantic_retrieval.source_passage_map.v1") {
    throw new Error("offline embedding artifact requires source passage map v1");
  }
  if (!Array.isArray(manifest.records) || !Array.isArray(passageMap.passages)) {
    throw new Error("offline embedding inputs require manifest records and source passages");
  }
  if (!SHA256.test(String(manifest.manifest_sha256 || ""))) {
    throw new Error("offline embedding corpus manifest checksum is missing");
  }
  if (!SHA256.test(String(passageMap.map_sha256 || ""))) {
    throw new Error("offline embedding source passage map checksum is missing");
  }
  const corpusReceiptSha256 = manifest?.input_receipts?.corpus?.sha256 || null;
  if (corpusReceiptSha256 && passageMap.corpus_sha256 && corpusReceiptSha256 !== passageMap.corpus_sha256) {
    throw new Error("offline embedding inputs do not describe the same corpus receipt");
  }

  const manifestSourceIds = new Set(manifest.records.map((row) => String(row.source_record_id || "")));
  const orderedPassages = [...passageMap.passages].sort((left, right) =>
    String(left.candidate_id || "").localeCompare(String(right.candidate_id || "")));
  const retained = [];
  const droppedRows = [];
  const seenCandidateIds = new Set();

  for (const passage of orderedPassages) {
    const candidateId = String(passage?.candidate_id || "").trim();
    if (!candidateId || seenCandidateIds.has(candidateId)) {
      droppedRows.push(droppedPassage(passage, "duplicate_or_missing_candidate_id"));
      continue;
    }
    seenCandidateIds.add(candidateId);
    if (!manifestSourceIds.has(String(passage.source_record_id || ""))) {
      droppedRows.push(droppedPassage(passage, "source_not_in_manifest"));
      continue;
    }
    if (passage.text_state !== "retained") {
      droppedRows.push(droppedPassage(passage, "text_not_retained"));
      continue;
    }
    if (typeof passage.text !== "string" || passage.text.trim() === "") {
      droppedRows.push(droppedPassage(passage, "missing_text"));
      continue;
    }
    if (passage.text_sha256 !== sha256(passage.text)) {
      droppedRows.push(droppedPassage(passage, "text_checksum_mismatch"));
      continue;
    }
    retained.push(passage);
  }

  const idf = buildIdf(retained.map((passage) => passage.text));
  const rows = [];
  for (const passage of retained) {
    const vector = roundedVector(embedDocument(passage.text, { idf, dim: OFFLINE_EMBEDDING_MODEL.dimensions }));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm < 1e-12) {
      droppedRows.push(droppedPassage(passage, "empty_embedding"));
      continue;
    }
    rows.push({
      candidate_id: passage.candidate_id,
      passage_id: passage.passage_id,
      source_record_id: passage.source_record_id,
      source_family: passage.source_family,
      passage_text_sha256: passage.text_sha256,
      vector,
    });
  }

  droppedRows.sort((left, right) =>
    String(left.candidate_id || "").localeCompare(String(right.candidate_id || ""))
      || left.reason.localeCompare(right.reason));
  const versionSeed = `${manifest.manifest_sha256}:${passageMap.map_sha256}:${OFFLINE_EMBEDDING_MODEL.revision}`;
  const artifact = {
    schema: OFFLINE_EMBEDDING_ARTIFACT_SCHEMA,
    artifact_version: `v1-${sha256(versionSeed).slice(0, 16)}`,
    authorization: {
      runtime_semantic_retrieval: false,
      public_search_mode: "lexical",
      use: "offline_evaluation_only",
    },
    model: OFFLINE_EMBEDDING_MODEL,
    inputs: {
      corpus_manifest_schema: manifest.schema,
      corpus_manifest_sha256: manifest.manifest_sha256,
      corpus_content_sha256: manifest.corpus_sha256 || null,
      corpus_receipt_sha256: corpusReceiptSha256,
      source_passage_map_schema: passageMap.schema,
      source_passage_map_sha256: passageMap.map_sha256,
    },
    coverage: manifest.coverage || { state: "unknown", boundary: null },
    input_row_count: passageMap.passages.length,
    embedded_row_count: rows.length,
    dropped_row_count: droppedRows.length,
    dropped_reason_counts: countReasons(droppedRows),
    dropped_rows: droppedRows,
    rows,
  };
  artifact.artifact_sha256 = sha256(JSON.stringify(artifactChecksumPayload(artifact)));
  return validateOfflineEmbeddingArtifact(artifact);
}

export function validateOfflineEmbeddingArtifact(artifact) {
  if (artifact?.schema !== OFFLINE_EMBEDDING_ARTIFACT_SCHEMA) {
    throw new Error("offline embedding artifact schema mismatch");
  }
  if (artifact.authorization?.runtime_semantic_retrieval !== false
      || artifact.authorization?.public_search_mode !== "lexical") {
    throw new Error("offline embedding artifact must not authorize public semantic retrieval");
  }
  if (artifact.model?.id !== OFFLINE_EMBEDDING_MODEL.id
      || artifact.model?.revision !== OFFLINE_EMBEDDING_MODEL.revision
      || artifact.model?.dimensions !== OFFLINE_EMBEDDING_MODEL.dimensions
      || artifact.model?.normalization !== OFFLINE_EMBEDDING_MODEL.normalization) {
    throw new Error("offline embedding model or configuration drift");
  }
  if (!Array.isArray(artifact.rows) || !Array.isArray(artifact.dropped_rows)) {
    throw new Error("offline embedding rows are missing");
  }
  if (artifact.embedded_row_count !== artifact.rows.length
      || artifact.dropped_row_count !== artifact.dropped_rows.length
      || artifact.input_row_count !== artifact.embedded_row_count + artifact.dropped_row_count) {
    throw new Error("offline embedding row counts do not reconcile");
  }
  if (JSON.stringify(artifact.dropped_reason_counts) !== JSON.stringify(countReasons(artifact.dropped_rows))) {
    throw new Error("offline embedding dropped reason counts do not reconcile");
  }

  const candidateIds = new Set();
  for (const row of artifact.rows) {
    if (!row.candidate_id || candidateIds.has(row.candidate_id)) {
      throw new Error(`duplicate or missing embedded candidate ${row.candidate_id || "unknown"}`);
    }
    candidateIds.add(row.candidate_id);
    if (!row.source_record_id || !row.source_family || !row.passage_id || !SHA256.test(row.passage_text_sha256)) {
      throw new Error(`embedded candidate identity is incomplete ${row.candidate_id}`);
    }
    if (!Array.isArray(row.vector) || row.vector.length !== OFFLINE_EMBEDDING_MODEL.dimensions
        || row.vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`embedded candidate vector is invalid ${row.candidate_id}`);
    }
    const norm = Math.sqrt(row.vector.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) >= 1e-5) {
      throw new Error(`embedded candidate vector is not normalized ${row.candidate_id}`);
    }
  }
  const expectedChecksum = sha256(JSON.stringify(artifactChecksumPayload(artifact)));
  if (artifact.artifact_sha256 !== expectedChecksum) {
    throw new Error("offline embedding artifact checksum mismatch");
  }
  return artifact;
}

export function serializeOfflineEmbeddingArtifact(artifact) {
  validateOfflineEmbeddingArtifact(artifact);
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
