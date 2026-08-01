// Shared immutable source-observation helpers for entity-resolution replay.
// Importers remain responsible for choosing a publisher-stable source key and
// for keeping shadow writes fail-soft relative to their current read models.

export const SOURCE_RECORD_INSERT_SQL = `INSERT OR IGNORE INTO source_records
  (source_system, source_system_id, content_hash, raw_snapshot, normalized_snapshot, ingested_at)
 VALUES (?,?,?,?,?,?)`;

function canonicalJson(value) {
  const type = typeof value;
  if (value === null || type !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export async function computeSourceRecordHash(row) {
  const data = new TextEncoder().encode(canonicalJson(row));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sourceRecordDualWriteEnabled(env, flag) {
  return String(env?.[flag] || "").toLowerCase() === "true";
}

