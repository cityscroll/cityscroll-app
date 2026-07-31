// entity_resolution/candidate_generation — production candidate-pair boundary.
// The blocker remains pure: it only shapes pairs for downstream matchers and
// does not write links or mutate source records.

import {
  BLOCKER_ID,
  BLOCKER_VERSION,
  blockKeysForSide,
} from "../eval/blockers/token_v0.mjs";

export const CANDIDATE_GENERATION_VERSION = `${BLOCKER_ID}_v${BLOCKER_VERSION}`;

/**
 * Produce deterministic candidate pairs using the token_v0 block keys.
 * Records must expose display_name (or vendor_name) and may carry attrs.pin.
 * The output is intentionally matcher-neutral so it can be used by shadow
 * runs without implying an entity merge.
 *
 * @param {Array<object>} records
 * @param {{ blocker?: string, entityType?: string }} [opts]
 * @returns {Array<{left: object, right: object, shared_keys: string[], blocker: string}>}
 */
export function generateCandidates(records = [], opts = {}) {
  const blocker = opts.blocker || BLOCKER_ID;
  if (blocker === "none") return [];
  if (blocker !== BLOCKER_ID && blocker !== "token_v0") {
    throw new Error(`unknown candidate blocker: ${blocker}`);
  }

  const buckets = new Map();
  const candidates = new Map();
  const list = Array.isArray(records) ? records : [];

  list.forEach((record, index) => {
    if (!record || typeof record !== "object") return;
    const side = record.display_name === undefined && record.vendor_name !== undefined
      ? { ...record, display_name: record.vendor_name }
      : record;
    const entityType = record.entity_type || opts.entityType || "vendor";
    for (const key of blockKeysForSide(side, entityType)) {
      const bucket = buckets.get(key) || [];
      for (const prior of bucket) {
        const pair = prior.index < index
          ? [prior.index, index]
          : [index, prior.index];
        const pairKey = `${pair[0]}:${pair[1]}`;
        const existing = candidates.get(pairKey) || {
          left: list[pair[0]],
          right: list[pair[1]],
          shared_keys: new Set(),
          blocker: BLOCKER_ID,
        };
        existing.shared_keys.add(key);
        candidates.set(pairKey, existing);
      }
      bucket.push({ index });
      buckets.set(key, bucket);
    }
  });

  return [...candidates.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, pair]) => ({
      ...pair,
      shared_keys: [...pair.shared_keys].sort(),
    }));
}
