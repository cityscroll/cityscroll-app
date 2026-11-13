/**
 * Shared helpers for public entity-register materializations (IRS, DOL, SCA, DOS batch).
 * Retain-last-good on failed refresh; never invent zeros for unknown fields.
 */

import { createHash } from "node:crypto";

export const REGISTER_LOOKUP_IDS = Object.freeze({
  irs_eo_bmf_ny: "irs_eo_bmf_ny",
  nys_dol_contractor_registry: "nys_dol_contractor_registry",
  nyc_sca_prequalified_firms: "nyc_sca_prequalified_firms",
  dos_entities: "dos_entities",
});

export const REGISTER_ROW_FLOORS = Object.freeze({
  irs_eo_bmf_ny: 100_000,
  nys_dol_contractor_registry: 10_000,
  nyc_sca_prequalified_firms: 1_500,
  dos_entities: 1,
});

export const REGISTER_DRIFT_ALLOWANCE = 0.05;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** FNV-1a 32-bit bucket, matching worker/src/vendor_profile.mjs vendorProfileBucket. */
export function registerBucket(stem, bucketCount = 64) {
  const text = String(stem || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bucket = (hash >>> 0) % bucketCount;
  const width = bucketCount <= 16 ? 1 : 2;
  return bucket.toString(16).padStart(width, "0");
}

export function driftRatio(previousCount, nextCount) {
  const prev = Number(previousCount);
  const next = Number(nextCount);
  if (!Number.isFinite(prev) || prev <= 0) return 0;
  if (!Number.isFinite(next)) return Number.POSITIVE_INFINITY;
  return Math.abs(next - prev) / prev;
}

/**
 * Decide whether to publish a new register artifact or retain the last verified one.
 * @returns {{ action: "publish"|"retain"|"reject", reason: string }}
 */
export function decideRegisterPublish({
  register,
  previous = null,
  next = null,
  ok = false,
  reason = null,
  floor = null,
} = {}) {
  const rowFloor = floor ?? REGISTER_ROW_FLOORS[register] ?? 1;
  if (!ok || !next) {
    if (previous) return { action: "retain", reason: reason || "source_failed_retained_last_good" };
    return { action: "reject", reason: reason || "source_failed_no_prior_artifact" };
  }
  const count = Number(next.row_count ?? next.records?.length ?? 0);
  if (!Number.isFinite(count) || count < rowFloor) {
    if (previous) {
      return {
        action: "retain",
        reason: `row_count ${count} below floor ${rowFloor}; retained_last_good`,
      };
    }
    return { action: "reject", reason: `row_count ${count} below floor ${rowFloor}` };
  }
  if (previous?.row_count != null) {
    const drift = driftRatio(previous.row_count, count);
    if (drift > REGISTER_DRIFT_ALLOWANCE) {
      return {
        action: "retain",
        reason: `row_count drift ${(drift * 100).toFixed(1)}% exceeds ${(REGISTER_DRIFT_ALLOWANCE * 100).toFixed(0)}%; retained_last_good`,
      };
    }
  }
  return { action: "publish", reason: "ok" };
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
