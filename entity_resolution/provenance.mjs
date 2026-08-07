// Shared provenance and link-lineage contracts for resolution runs.

export const RESOLUTION_PROVENANCE_SCHEMA_VERSION = 1;
export const NOT_USED_VERSION = "not_used";

function text(value, fallback) {
  const result = String(value ?? "").trim();
  return result || fallback;
}

/**
 * Build the versioned card stored beside every resolution run.
 * Watermarks are intentionally opaque to this module: each source can carry
 * its own snapshot date, source hash, or cursor without changing the schema.
 */
export function buildResolutionRunProvenance(input = {}) {
  const watermarks = input.watermarks && typeof input.watermarks === "object"
    && !Array.isArray(input.watermarks)
    ? input.watermarks
    : {};
  return {
    schema_version: RESOLUTION_PROVENANCE_SCHEMA_VERSION,
    model_artifact_hash: text(input.model_artifact_hash, "not_available"),
    gold_version: text(input.gold_version, NOT_USED_VERSION),
    feature_version: text(input.feature_version, NOT_USED_VERSION),
    blocking_version: text(input.blocking_version, NOT_USED_VERSION),
    policy_version: text(input.policy_version, NOT_USED_VERSION),
    watermarks,
  };
}

function sameLink(left, right) {
  return left?.source_record_id === right?.source_record_id
    && left?.canonical_entity_id === right?.canonical_entity_id
    && left?.decision === right?.decision
    && left?.method === right?.method
    && left?.matcher_version === right?.matcher_version;
}

function supersessionReason(current, prior) {
  if (current.canonical_entity_id !== prior.canonical_entity_id) {
    return "canonical_target_changed";
  }
  if (current.decision !== prior.decision) return "decision_revised";
  if (current.method !== prior.method || current.matcher_version !== prior.matcher_version) {
    return "method_replaced";
  }
  return "link_recomputed";
}

/**
 * Relate current links to prior links for the same source record.
 * The rows are append-only relationships; neither link is mutated or deleted.
 */
export function buildLinkSupersessions(currentLinks = [], priorLinks = []) {
  const priorBySource = new Map();
  for (const prior of Array.isArray(priorLinks) ? priorLinks : []) {
    if (!prior?.id || !prior?.source_record_id) continue;
    const rows = priorBySource.get(prior.source_record_id) || [];
    rows.push(prior);
    priorBySource.set(prior.source_record_id, rows);
  }

  const result = [];
  const seen = new Set();
  for (const current of Array.isArray(currentLinks) ? currentLinks : []) {
    if (!current?.id || !current?.source_record_id) continue;
    for (const prior of priorBySource.get(current.source_record_id) || []) {
      if (current.id === prior.id || sameLink(current, prior)) continue;
      const key = `${current.id}\u0000${prior.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        superseding_link_id: current.id,
        superseded_link_id: prior.id,
        reason: supersessionReason(current, prior),
      });
    }
  }
  return result;
}

/** Attach the first supersession to the new link for row-oriented consumers.
 * The relationship table remains authoritative when one link replaces more
 * than one prior row.
 */
export function annotateLinkSupersession(currentLinks = [], lineage = []) {
  const firstByNew = new Map();
  for (const row of Array.isArray(lineage) ? lineage : []) {
    if (!firstByNew.has(row.superseding_link_id)) firstByNew.set(row.superseding_link_id, row);
  }
  return (Array.isArray(currentLinks) ? currentLinks : []).map((link) => {
    const row = firstByNew.get(link.id);
    return {
      ...link,
      supersedes_link_id: row?.superseded_link_id || null,
      supersession_reason: row?.reason || null,
    };
  });
}
