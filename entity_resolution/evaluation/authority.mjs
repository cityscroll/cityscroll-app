// Offline silver-label evaluation from immutable source-record snapshots.

import { generateCandidates } from "../candidate_generation/index.mjs";
import {
  extractFeatures,
  normalizeHardIdentifier,
} from "../features/index.mjs";
import { MATCHERS_VERSION, scorePair } from "../matchers/index.mjs";
import {
  authorityKeyId,
  authorityKeysForSide,
} from "../authority_keys/index.mjs";

export const AUTHORITY_VERSION = "nyc_scoped_authority_keys_v1";
export const AUTHORITY_LABEL = Object.freeze({
  SAME: "same",
  NEVER_AUTO: "never_auto",
});

const CONTRACT_KEYS = [
  "contract_id",
  "contract_ids",
  "contractid",
  "ctr_id",
  "prime_contract_id",
  "contract_number",
];

function valuesForKeys(snapshot, keys) {
  const lower = new Map(
    Object.entries(snapshot || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const values = [];
  for (const key of keys) {
    const raw = lower.get(key);
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const normalized = normalizeHardIdentifier(value);
      if (normalized) values.push(normalized);
    }
  }
  return [...new Set(values)].sort();
}

function parseSnapshot(value, lineNo) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`line ${lineNo}: normalized_snapshot must be JSON text or an object`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`line ${lineNo}: invalid normalized_snapshot JSON (${error.message})`);
  }
}

/** Load newline-delimited rows exported from the source_records table. */
export function loadSourceRecords(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("source-record input is empty");
  }
  const rows = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const lineNo = index + 1;
    let row;
    try {
      row = JSON.parse(raw);
    } catch (error) {
      throw new Error(`line ${lineNo}: invalid JSON (${error.message})`);
    }
    for (const field of ["source_system", "source_system_id", "content_hash", "ingested_at"]) {
      if (typeof row?.[field] !== "string" || !row[field]) {
        throw new Error(`line ${lineNo}: ${field} is required`);
      }
    }
    rows.push({
      ...row,
      normalized_snapshot: parseSnapshot(row.normalized_snapshot, lineNo),
    });
  }
  if (rows.length === 0) throw new Error("source-record input has no rows");
  return rows;
}

/** Keep the newest immutable version of each upstream record. */
export function latestSourceRecords(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    const key = `${row.source_system}\u0000${row.source_system_id}`;
    const prior = latest.get(key);
    if (!prior || row.ingested_at > prior.ingested_at ||
        (row.ingested_at === prior.ingested_at && row.content_hash > prior.content_hash)) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort((a, b) =>
    a.source_system.localeCompare(b.source_system) ||
    a.source_system_id.localeCompare(b.source_system_id) ||
    a.content_hash.localeCompare(b.content_hash)
  );
}

function displayName(snapshot, fallback) {
  for (const key of [
    "display_name",
    "short_title",
    "title",
    "description",
    "name",
    "vendor_name",
  ]) {
    const value = snapshot?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function toObservation(row) {
  const snapshot = row.normalized_snapshot || {};
  const authorityKeys = authorityKeysForSide({ attrs: snapshot });
  const contractIds = valuesForKeys(snapshot, CONTRACT_KEYS);
  return {
    source_record_id: `${row.source_system}:${row.source_system_id}:${row.content_hash}`,
    source_system: row.source_system,
    native_key: row.source_system_id,
    display_name: displayName(snapshot, row.source_system_id),
    entity_type: "procurement",
    attrs: {
      ...snapshot,
      authority_keys: authorityKeys,
      contract_ids: contractIds,
    },
    authority_ids: {
      scoped: authorityKeys,
      contract: contractIds,
    },
    ingested_at: row.ingested_at,
  };
}

function pairKey(left, right) {
  return [left.source_record_id, right.source_record_id].sort().join("\u0000");
}

function orderedPair(left, right) {
  return left.source_record_id.localeCompare(right.source_record_id) <= 0
    ? [left, right]
    : [right, left];
}

function hardKeySet(observation) {
  const keys = [];
  for (const key of observation.authority_ids.scoped) {
    keys.push(`authority:${authorityKeyId(key)}`);
  }
  for (const value of observation.authority_ids.contract) keys.push(`contract:${value}`);
  return keys;
}

function pairEvidence(left, right) {
  const shared = [];
  const conflicts = [];
  const leftScoped = left.authority_ids.scoped;
  const rightScoped = right.authority_ids.scoped;
  const rightScopedIds = new Set(rightScoped.map(authorityKeyId));
  const commonScoped = leftScoped.filter((key) => rightScopedIds.has(authorityKeyId(key)));
  shared.push(...commonScoped.map((key) => `authority:${authorityKeyId(key)}`));
  if (commonScoped.length === 0 && leftScoped.some((leftKey) =>
    rightScoped.some((rightKey) =>
      leftKey.scheme === rightKey.scheme && leftKey.scope === rightKey.scope
    )
  )) {
    conflicts.push("scoped_authority_key");
  }
  const leftContracts = left.authority_ids.contract;
  const rightContracts = right.authority_ids.contract;
  const commonContracts = leftContracts.filter((value) => rightContracts.includes(value));
  shared.push(...commonContracts.map((value) => `contract:${value}`));
  if (leftContracts.length > 0 && rightContracts.length > 0 && commonContracts.length === 0) {
    conflicts.push("contract");
  }
  return {
    shared_hard_ids: shared.sort(),
    conflicting_hard_id_families: conflicts.sort(),
  };
}

function namesAreSimilar(left, right) {
  const features = extractFeatures(left, right, { entityType: "procurement" });
  return features.token_jaccard >= 0.8 ||
    (features.name_containment && Math.min(features.left_token_count, features.right_token_count) >= 2);
}

function authorityCase(leftInput, rightInput, label, evidence) {
  const [left, right] = orderedPair(leftInput, rightInput);
  return {
    id: `authority:${left.source_record_id}|${right.source_record_id}`,
    entity_type: "procurement",
    authority_label: label,
    left,
    right,
    evidence,
  };
}

/**
 * Derive silver pairs without human labels.
 * Shared PIN/EPIN or contract identifiers are same-authority evidence.
 * Name-similar pairs with comparable but disjoint identifiers are never-auto pressure.
 */
export function deriveAuthorityCases(rows) {
  const observations = latestSourceRecords(rows).map(toObservation);
  const byHardKey = new Map();
  const cases = new Map();

  for (const observation of observations) {
    for (const key of hardKeySet(observation)) {
      const bucket = byHardKey.get(key) || [];
      for (const prior of bucket) {
        const evidence = pairEvidence(prior, observation);
        const keyForPair = pairKey(prior, observation);
        cases.set(
          keyForPair,
          authorityCase(prior, observation, AUTHORITY_LABEL.SAME, evidence),
        );
      }
      bucket.push(observation);
      byHardKey.set(key, bucket);
    }
  }

  const conflictObservations = observations.filter(
    (observation) => hardKeySet(observation).length > 0,
  );
  const conflictCandidates = generateCandidates(conflictObservations, {
    blocker: "token_v0",
    entityType: "procurement",
  });
  for (const candidate of conflictCandidates) {
    const { left, right } = candidate;
    const keyForPair = pairKey(left, right);
    if (cases.has(keyForPair) || !namesAreSimilar(left, right)) continue;
    const evidence = pairEvidence(left, right);
    if (evidence.shared_hard_ids.length > 0 ||
        evidence.conflicting_hard_id_families.length === 0) continue;
    cases.set(
      keyForPair,
      authorityCase(left, right, AUTHORITY_LABEL.NEVER_AUTO, {
        ...evidence,
        shared_name_block_keys: candidate.shared_keys,
      }),
    );
  }

  return [...cases.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Score silver pairs with the conventional matcher; no links or records are written. */
export function predictAuthorityCases(cases) {
  const predictions = new Map();
  for (const row of cases || []) {
    const features = extractFeatures(row.left, row.right, {
      entityType: row.entity_type,
    });
    predictions.set(row.id, scorePair(row.left, row.right, features));
  }
  return predictions;
}

/** Pair-level metrics for hard-key recovery and conflict auto-link pressure. */
export function computeAuthorityMetrics(cases, predictions) {
  const same = (cases || []).filter((row) => row.authority_label === AUTHORITY_LABEL.SAME);
  const conflicts = (cases || []).filter(
    (row) => row.authority_label === AUTHORITY_LABEL.NEVER_AUTO,
  );
  const decision = (row) => {
    const prediction = predictions?.get(row.id);
    return typeof prediction === "string" ? prediction : prediction?.decision || "unresolved";
  };
  const recovered = same.filter((row) => decision(row) === "same").length;
  const conflictAutoLinks = conflicts.filter((row) => decision(row) === "same").length;
  return {
    authority_recall: same.length === 0 ? null : recovered / same.length,
    authority_conflict_auto_link_rate:
      conflicts.length === 0 ? null : conflictAutoLinks / conflicts.length,
  };
}

export function buildAuthorityReport(rows, sourcePath = null) {
  const latest = latestSourceRecords(rows);
  const cases = deriveAuthorityCases(rows);
  const predictions = predictAuthorityCases(cases);
  const metrics = computeAuthorityMetrics(cases, predictions);
  const silverSame = cases.filter((row) => row.authority_label === AUTHORITY_LABEL.SAME);
  const conflicts = cases.filter((row) => row.authority_label === AUTHORITY_LABEL.NEVER_AUTO);
  const decision = (row) => predictions.get(row.id)?.decision || "unresolved";
  return {
    authority_version: AUTHORITY_VERSION,
    matcher_version: MATCHERS_VERSION,
    source_path: sourcePath,
    source_records: rows.length,
    latest_source_records: latest.length,
    composition: {
      silver_same: silverSame.length,
      never_auto: conflicts.length,
    },
    metrics,
    examples: {
      false_splits: silverSame.filter((row) => decision(row) !== "same").slice(0, 5),
      conflict_auto_links: conflicts.filter((row) => decision(row) === "same").slice(0, 5),
    },
  };
}
