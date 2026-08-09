import { agencyComparisonKey } from "../../site/agency_identity.mjs";

const uniqueStrings = (values) => [...new Set(values
  .map((value) => String(value || "").trim()).filter(Boolean))];

/** Convert the committed publisher bundle into the row shape used by reconciliation. */
export function publisherAgencyRows(crosswalk) {
  const entries = crosswalk?.entries && typeof crosswalk.entries === "object"
    ? crosswalk.entries
    : (crosswalk && !Array.isArray(crosswalk) && typeof crosswalk === "object" ? crosswalk : {});
  return Object.entries(entries).map(([canonical_id, entry]) => Object.freeze({
    canonical_id,
    canonical_name: String(entry?.canonical_name || canonical_id).trim(),
    variants: Object.freeze(uniqueStrings(entry?.variants || [])),
  }));
}

export function agencyPublisherCollisions(rows) {
  const byId = new Map();
  const idsByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const canonical_id = String(row?.canonical_id || "").trim();
    if (!canonical_id) continue;
    byId.set(canonical_id, row);
    for (const surface of [canonical_id, row?.canonical_name, row?.raw_string, ...(row?.variants || [])]) {
      const key = agencyComparisonKey(surface);
      if (!key) continue;
      if (!idsByKey.has(key)) idsByKey.set(key, new Set());
      idsByKey.get(key).add(canonical_id);
    }
  }
  return [...idsByKey.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([comparison_key, ids]) => ({
      comparison_key,
      canonical_ids: [...ids].sort(),
      canonical_names: [...ids].sort().map((id) => byId.get(id)?.canonical_name || id),
    }))
    .sort((left, right) => left.comparison_key.localeCompare(right.comparison_key));
}
