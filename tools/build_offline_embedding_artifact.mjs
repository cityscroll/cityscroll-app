#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildOfflineEmbeddingArtifact,
  serializeOfflineEmbeddingArtifact,
  validateOfflineEmbeddingArtifact,
} from "../warehouse/lib/offline_embedding_artifact.mjs";

export const OFFLINE_EMBEDDING_RECEIPT_SCHEMA =
  "cityscroll.semantic_retrieval.offline_embedding_receipt.v1";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "warehouse/manifests/semantic_retrieval_corpus_manifest.json");
const PASSAGE_MAP_PATH = join(ROOT, "warehouse/experiments/semantic-layer-trial/source_passage_map.json");
const OUTPUT_DIRECTORY = join(ROOT, "warehouse/embeddings/semantic_retrieval");
const RECEIPT_PATH = join(ROOT, "warehouse/receipts/proof/semantic_retrieval_offline_embedding_latest.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function repositoryPath(path) {
  const candidate = relative(ROOT, path).split("\\").join("/");
  return candidate.startsWith("../") ? basename(path) : candidate;
}

function receiptChecksumPayload(receipt) {
  const { receipt_sha256: _checksum, ...payload } = receipt;
  return payload;
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function artifactReference(artifact, artifactPath, state) {
  return {
    state,
    artifact_version: artifact.artifact_version,
    artifact_path: repositoryPath(artifactPath),
    artifact_sha256: artifact.artifact_sha256,
  };
}

export function buildOfflineEmbeddingReceipt(artifact, artifactPath, previousActive = null) {
  validateOfflineEmbeddingArtifact(artifact);
  const active = artifactReference(artifact, artifactPath, "active");
  const previousGood = previousActive
    ? { ...previousActive, state: "previous_good" }
    : artifactReference(artifact, artifactPath, "bootstrap_known_good");
  const receipt = {
    schema: OFFLINE_EMBEDDING_RECEIPT_SCHEMA,
    receipt_version: 1,
    authorization: artifact.authorization,
    model: artifact.model,
    inputs: artifact.inputs,
    row_counts: {
      input: artifact.input_row_count,
      embedded: artifact.embedded_row_count,
      dropped: artifact.dropped_row_count,
    },
    dropped_reason_counts: artifact.dropped_reason_counts,
    active_artifact: active,
    previous_good_artifact: previousGood,
    refresh_publication: {
      strategy: "content_addressed_artifact_then_atomic_pointer_swap",
      failure_behavior: "Leave the active receipt and prior artifact unchanged.",
      lexical_search_dependency: false,
    },
  };
  receipt.receipt_sha256 = sha256(JSON.stringify(receiptChecksumPayload(receipt)));
  return receipt;
}

export function validateOfflineEmbeddingReceipt(receipt) {
  if (receipt?.schema !== OFFLINE_EMBEDDING_RECEIPT_SCHEMA) {
    throw new Error("offline embedding receipt schema mismatch");
  }
  if (receipt.authorization?.runtime_semantic_retrieval !== false
      || receipt.refresh_publication?.lexical_search_dependency !== false) {
    throw new Error("offline embedding receipt must preserve lexical search");
  }
  for (const key of ["active_artifact", "previous_good_artifact"]) {
    const reference = receipt[key];
    if (!reference?.artifact_path || !reference?.artifact_version
        || !/^[a-f0-9]{64}$/.test(String(reference.artifact_sha256 || ""))) {
      throw new Error(`offline embedding receipt has an invalid ${key} pointer`);
    }
  }
  const expectedChecksum = sha256(JSON.stringify(receiptChecksumPayload(receipt)));
  if (receipt.receipt_sha256 !== expectedChecksum) {
    throw new Error("offline embedding receipt checksum mismatch");
  }
  return receipt;
}

export function publishOfflineEmbeddingArtifact({
  manifest,
  passageMap,
  outputDirectory = OUTPUT_DIRECTORY,
  receiptPath = join(outputDirectory, "semantic_retrieval_offline_embedding_latest.json"),
  beforePointerSwap = null,
} = {}) {
  const artifact = buildOfflineEmbeddingArtifact(manifest, passageMap);
  const artifactPath = join(outputDirectory, `${artifact.artifact_version}.json`);
  const serializedArtifact = serializeOfflineEmbeddingArtifact(artifact);
  mkdirSync(outputDirectory, { recursive: true });
  if (existsSync(artifactPath)) {
    if (readFileSync(artifactPath, "utf8") !== serializedArtifact) {
      throw new Error(`content-addressed embedding artifact collision: ${artifactPath}`);
    }
  } else {
    atomicWrite(artifactPath, serializedArtifact);
  }

  let previousActive = null;
  if (existsSync(receiptPath)) {
    const previousReceipt = validateOfflineEmbeddingReceipt(readJson(receiptPath));
    previousActive = previousReceipt.active_artifact;
  }
  const receipt = buildOfflineEmbeddingReceipt(artifact, artifactPath, previousActive);
  validateOfflineEmbeddingReceipt(receipt);
  if (beforePointerSwap) beforePointerSwap({ artifact, artifactPath, receipt, receiptPath });
  atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { artifact, artifactPath, receipt, receiptPath };
}

function checkCommittedArtifact(manifest, passageMap) {
  const artifact = buildOfflineEmbeddingArtifact(manifest, passageMap);
  const artifactPath = join(OUTPUT_DIRECTORY, `${artifact.artifact_version}.json`);
  if (!existsSync(artifactPath)) throw new Error("offline embedding artifact is missing; rebuild without --check");
  if (readFileSync(artifactPath, "utf8") !== serializeOfflineEmbeddingArtifact(artifact)) {
    throw new Error("offline embedding artifact is stale; rebuild without --check");
  }
  if (!existsSync(RECEIPT_PATH)) throw new Error("offline embedding receipt is missing; rebuild without --check");
  const receipt = validateOfflineEmbeddingReceipt(readJson(RECEIPT_PATH));
  if (receipt.active_artifact.artifact_version !== artifact.artifact_version
      || receipt.active_artifact.artifact_sha256 !== artifact.artifact_sha256
      || receipt.active_artifact.artifact_path !== repositoryPath(artifactPath)) {
    throw new Error("offline embedding receipt does not point to the current artifact");
  }
  return artifact;
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const manifest = readJson(MANIFEST_PATH);
  const passageMap = readJson(PASSAGE_MAP_PATH);
  if (check) {
    const artifact = checkCommittedArtifact(manifest, passageMap);
    console.log(`offline embedding artifact ok version=${artifact.artifact_version} rows=${artifact.embedded_row_count}`);
    return;
  }
  const result = publishOfflineEmbeddingArtifact({
    manifest,
    passageMap,
    outputDirectory: OUTPUT_DIRECTORY,
    receiptPath: RECEIPT_PATH,
  });
  console.log(`wrote offline embedding artifact version=${result.artifact.artifact_version} rows=${result.artifact.embedded_row_count}`);
}

if (import.meta.url === `file://${process.argv[1]}`
    || process.argv[1]?.endsWith("build_offline_embedding_artifact.mjs")) {
  main();
}
