// The score-stage narrow waist. Candidate generation and policy stay owned by
// CityScroll; a scorer only proposes a probability and evidence for each
// already-generated pair.

import { createHash } from "node:crypto";

export const SCORER_CONTRACT_VERSION = "scorer_contract_v1";
export const SCORE_RESULT_SCHEMA_VERSION = "score_result_v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function hashJson(value) {
  return sha256(stableJson(value));
}

function sideIdentity(side = {}) {
  return [
    side.source_record_id,
    side.source_system_id,
    side.native_key,
    side.source_system,
    side.display_name,
  ].find((value) => String(value || "").trim()) || "anonymous";
}

/** Stable pair identity for scorer outputs and cross-language adapters. */
export function pairId(candidate = {}) {
  if (candidate.pair_id || candidate.id) return String(candidate.pair_id || candidate.id);
  const ids = [sideIdentity(candidate.left), sideIdentity(candidate.right)].sort();
  return `pair:${sha256(ids.join("\0")).slice(0, 24)}`;
}

function validateProbability(value, pair) {
  const probability = Number(value);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`scorer returned invalid probability for ${pair}: ${value}`);
  }
  return probability;
}

/**
 * Construct a scorer after checking the public identity it will expose in a
 * resolution_run receipt. `scoreBatch` is intentionally the only required
 * operation; no scorer-specific state leaks into policy or materialization.
 */
export function createScorer({
  name,
  version,
  artifactHash,
  configHash,
  supportsIncremental = false,
  scoreBatch,
  incrementalScoreBatch = null,
} = {}) {
  if (!name || !version || typeof scoreBatch !== "function") {
    throw new TypeError("scorer requires name, version, and scoreBatch(input)");
  }
  if (supportsIncremental && typeof incrementalScoreBatch !== "function") {
    throw new TypeError("incremental scorer requires incrementalScoreBatch(input)");
  }
  return Object.freeze({
    contract_version: SCORER_CONTRACT_VERSION,
    name: String(name),
    version: String(version),
    artifact_hash: String(artifactHash || hashJson({ name, version })),
    config_hash: String(configHash || hashJson({ name, version })),
    supports_incremental: Boolean(supportsIncremental),
    scoreBatch,
    ...(incrementalScoreBatch ? { incrementalScoreBatch } : {}),
  });
}

function normalizeOutput(row, index, expectedPairId, scorer) {
  const output = row || {};
  const outputPairId = String(output.pair_id || expectedPairId);
  if (outputPairId !== expectedPairId) {
    throw new Error(
      `scorer ${scorer.name} returned pair ${outputPairId} for ${expectedPairId}`,
    );
  }
  const evidence = output.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`scorer ${scorer.name} omitted evidence for ${expectedPairId}`);
  }
  return {
    schema_version: SCORE_RESULT_SCHEMA_VERSION,
    pair_id: expectedPairId,
    probability: validateProbability(output.probability, expectedPairId),
    evidence,
    scorer: {
      name: scorer.name,
      version: scorer.version,
      artifact_hash: scorer.artifact_hash,
      config_hash: scorer.config_hash,
    },
    output_index: index,
  };
}

/**
 * Score a batch of candidate pairs plus their versioned feature rows.
 *
 * The input shape is deliberately boring so a Python or Rust adapter can
 * implement it without importing this package:
 * `{ candidate_pairs, features_version }`, where each pair has `features`.
 */
export function scoreCandidatePairs(input = {}, scorer) {
  if (!scorer || scorer.contract_version !== SCORER_CONTRACT_VERSION) {
    throw new TypeError("scoreCandidatePairs requires a scorer contract object");
  }
  const candidatePairs = Array.isArray(input.candidate_pairs)
    ? input.candidate_pairs
    : [];
  const featuresVersion = String(input.features_version || "");
  if (!featuresVersion) throw new Error("score input requires features_version");
  const rows = candidatePairs.map((candidate) => {
    const features = candidate?.features;
    if (!features || features.features_version !== featuresVersion) {
      throw new Error(`feature version mismatch for ${pairId(candidate)}`);
    }
    return { ...candidate, pair_id: pairId(candidate), features };
  });
  const raw = scorer.scoreBatch({
    contract_version: SCORER_CONTRACT_VERSION,
    features_version: featuresVersion,
    candidate_pairs: rows,
  });
  if (!Array.isArray(raw) || raw.length !== rows.length) {
    throw new Error(
      `scorer ${scorer.name} returned ${raw?.length ?? "non-array"} rows for ${rows.length} candidates`,
    );
  }
  return raw.map((output, index) => normalizeOutput(output, index, rows[index].pair_id, scorer));
}

/** Identity recorded beside a run; safe to serialize into JSON receipts. */
export function scorerIdentity(scorer) {
  return {
    contract_version: scorer.contract_version,
    name: scorer.name,
    version: scorer.version,
    artifact_hash: scorer.artifact_hash,
    config_hash: scorer.config_hash,
    supports_incremental: scorer.supports_incremental,
  };
}
