// Read committed register shards (cityscroll.register_shard.v1) back into register records.
// Id shards are kind "id" (DOL, SCA) or "ein" (IRS columnar). Stem shards are a name index
// and are not records. Bucket width follows the manifest: one hex digit at 16 buckets, two above.

import { normalizeIrsRecord, IRS_COLUMNS } from "./irs_eo_bmf.mjs";

export const REGISTER_SHARD_SCHEMA = "cityscroll.register_shard.v1";
export const REGISTER_ID_KINDS = Object.freeze(["id", "ein"]);

/** Hex bucket for a record id, matching warehouse/lib/register_lookups.mjs registerBucket. */
export function registerIdBucket(id, bucketCount = 64) {
  const text = String(id || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const width = bucketCount <= 16 ? 1 : 2;
  return ((hash >>> 0) % bucketCount).toString(16).padStart(width, "0");
}

export function isRegisterIdShard(shard) {
  return Boolean(shard && REGISTER_ID_KINDS.includes(shard.kind));
}

/** Published path of a shard entry. Manifest paths are relative to the register directory. */
export function registerShardPath(register, shard) {
  const path = String(shard?.path || "");
  if (!path) return "";
  if (path.startsWith("data/")) return path;
  return `data/${register}/${path}`;
}

/**
 * -> { ok:true, records, kind } | { ok:false, problems }
 * Stem shards return an empty record list. IRS columnar rows are normalized with the IRS reader
 * so each record carries the published fields. DOL and SCA id shards already store records.
 */
export function recordsFromRegisterShard(doc) {
  if (!doc || typeof doc !== "object") return { ok: false, problems: ["shard is not an object"] };
  if (doc.schema !== REGISTER_SHARD_SCHEMA) return { ok: false, problems: [`schema ${doc.schema}`] };
  if (doc.kind === "stem") return { ok: true, records: [], kind: "stem" };
  if (Array.isArray(doc.columns) && Array.isArray(doc.rows)) {
    const index = new Map(doc.columns.map((name, i) => [name, i]));
    const records = doc.rows.map((row) => {
      const values = {};
      for (const column of IRS_COLUMNS) {
        const at = index.get(column);
        values[column] = at == null ? "" : String(row[at] ?? "");
      }
      return normalizeIrsRecord(values, { collected_at: doc.collected_at });
    });
    if (doc.row_count != null && doc.row_count !== records.length) {
      return { ok: false, problems: [`row_count ${doc.row_count} != ${records.length}`] };
    }
    return { ok: true, records, kind: doc.kind };
  }
  if (!Array.isArray(doc.records)) return { ok: false, problems: ["shard has neither records nor columns"] };
  if (doc.row_count != null && doc.row_count !== doc.records.length) {
    return { ok: false, problems: [`row_count ${doc.row_count} != ${doc.records.length}`] };
  }
  return { ok: true, records: doc.records, kind: doc.kind };
}
