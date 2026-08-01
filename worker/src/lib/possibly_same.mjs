// Read-only false-split visibility for the entity-resolution desk.
// Recent immutable observations are blocked in-process; this module never writes
// source records, links, canonical entities, or review state.

import {
  CANDIDATE_GENERATION_VERSION,
  generateCandidates,
} from "../../../entity_resolution/candidate_generation/index.mjs";
import { extractFeatures } from "../../../entity_resolution/features/index.mjs";
import { buildAssertionEvidence } from "../../../entity_resolution/review/assertion_evidence.mjs";

export const POSSIBLY_SAME_LOOKBACK_DAYS = 30;
export const POSSIBLY_SAME_RECORD_LIMIT = 250;
export const POSSIBLY_SAME_PAIR_LIMIT = 100;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function snapshotObject(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sourceRecordId(row) {
  return [row.source_system, row.source_system_id, row.content_hash].map(clean).join(":");
}

function sourceUrl(sourceSystem, sourceSystemId, snapshot, rawSnapshot) {
  for (const record of [snapshot, rawSnapshot]) {
    for (const key of ["source_url", "record_url", "url", "web_url"]) {
      const value = clean(record?.[key]);
      if (/^https?:\/\//i.test(value)) return value;
    }
  }
  if (sourceSystem === "city_record") {
    return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(sourceSystemId)}`;
  }
  return "";
}

function observedFields(snapshot) {
  return Object.fromEntries(Object.entries(snapshot)
    .filter(([, value]) => value != null && value !== "" && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 30)
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]));
}

function observationFromRow(row) {
  const snapshot = snapshotObject(row.normalized_snapshot);
  const rawSnapshot = snapshotObject(row.raw_snapshot);
  const vendorName = clean(snapshot.vendor_name);
  const sourceSystem = clean(row.source_system);
  const sourceSystemId = clean(row.source_system_id);
  const contentHash = clean(row.content_hash);
  if (!vendorName || !sourceSystem || !sourceSystemId || !contentHash) return null;
  return {
    source_record_id: sourceRecordId(row),
    native_record_id: `${sourceSystem}:${sourceSystemId}`,
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: contentHash,
    vendor_name: vendorName,
    display_name: vendorName,
    ingested_at: clean(row.ingested_at),
    source_url: sourceUrl(sourceSystem, sourceSystemId, snapshot, rawSnapshot),
    observed_fields: observedFields(snapshot),
    raw_snapshot: rawSnapshot,
    attrs: snapshot,
    canonical_entity_ids: new Set(),
  };
}

function shareCanonicalEntity(left, right) {
  if (!left.canonical_entity_ids.size || !right.canonical_entity_ids.size) return false;
  for (const id of left.canonical_entity_ids) {
    if (right.canonical_entity_ids.has(id)) return true;
  }
  return false;
}

/**
 * Convert joined source_record/entity_link rows into non-assertive desk leads.
 * Newest snapshot wins per publisher-native record so content revisions are not
 * compared with themselves. Pairs already joined to one canonical entity are omitted.
 */
export function reviewPairsFromDualWriteRows(rows = [], opts = {}) {
  const snapshots = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const id = sourceRecordId(row);
    let observation = snapshots.get(id);
    if (!observation) {
      observation = observationFromRow(row);
      if (!observation) continue;
      snapshots.set(id, observation);
    }
    const canonicalId = clean(row.canonical_entity_id);
    if (canonicalId) observation.canonical_entity_ids.add(canonicalId);
  }

  const newestByNativeRecord = new Map();
  for (const observation of snapshots.values()) {
    const current = newestByNativeRecord.get(observation.native_record_id);
    if (!current || observation.ingested_at > current.ingested_at) {
      newestByNativeRecord.set(observation.native_record_id, observation);
    }
  }

  const candidates = generateCandidates([...newestByNativeRecord.values()], {
    blocker: "token_v0",
    entityType: "vendor",
  });
  const pairs = [];
  for (const candidate of candidates) {
    const { left, right, shared_keys: sharedKeys } = candidate;
    if (left.native_record_id === right.native_record_id) continue;
    if (shareCanonicalEntity(left, right)) continue;
    pairs.push({
      id: `${left.source_record_id}::${right.source_record_id}`,
      method: candidate.blocker,
      matcher_version: CANDIDATE_GENERATION_VERSION,
      confidence: null,
      left: {
        source_record_id: left.source_record_id,
        vendor_name: left.vendor_name,
        source_system: left.source_system,
        source_system_id: left.source_system_id,
        source_url: left.source_url,
        observed_fields: left.observed_fields,
        ingested_at: left.ingested_at,
      },
      right: {
        source_record_id: right.source_record_id,
        vendor_name: right.vendor_name,
        source_system: right.source_system,
        source_system_id: right.source_system_id,
        source_url: right.source_url,
        observed_fields: right.observed_fields,
        ingested_at: right.ingested_at,
      },
      evidence: {
        shared_keys: sharedKeys,
        left_linked: left.canonical_entity_ids.size > 0,
        right_linked: right.canonical_entity_ids.size > 0,
        comparison_features: extractFeatures(left, right, { entityType: "vendor" }),
        assertion_interpretation: buildAssertionEvidence(left, right),
      },
      observed_at: [left.ingested_at, right.ingested_at].sort().at(-1) || "",
    });
  }

  const pairLimit = Math.max(0, Number(opts.pairLimit) || POSSIBLY_SAME_PAIR_LIMIT);
  return pairs
    .sort((a, b) => b.evidence.shared_keys.length - a.evidence.shared_keys.length
      || b.observed_at.localeCompare(a.observed_at)
      || a.id.localeCompare(b.id))
    .slice(0, pairLimit);
}

/** Read recent dual-write observations and return desk review leads. */
export async function readPossiblySamePairs(db, opts = {}) {
  if (!db) return [];
  const lookbackDays = Math.max(1, Math.min(365, Number(opts.lookbackDays) || POSSIBLY_SAME_LOOKBACK_DAYS));
  const recordLimit = Math.max(1, Math.min(1000, Number(opts.recordLimit) || POSSIBLY_SAME_RECORD_LIMIT));
  const query = db.prepare(
    `SELECT recent.source_system, recent.source_system_id, recent.content_hash,
            recent.raw_snapshot, recent.normalized_snapshot, recent.ingested_at,
            link.canonical_entity_id, link.decision AS link_decision
       FROM (
         SELECT source_system, source_system_id, content_hash,
                raw_snapshot, normalized_snapshot, ingested_at
           FROM source_records
          WHERE julianday(ingested_at) >= julianday('now', ?)
          ORDER BY ingested_at DESC
          LIMIT ?
       ) AS recent
       LEFT JOIN entity_link AS link
         ON link.source_record_id = (
           recent.source_system || ':' || recent.source_system_id || ':' || recent.content_hash
         )
      ORDER BY recent.ingested_at DESC`,
  );
  const result = await query.bind(`-${lookbackDays} days`, recordLimit).all();
  return reviewPairsFromDualWriteRows(result?.results || [], opts);
}
