/**
 * Build and reassemble the sharded shared meeting read model.
 *
 * The published document at data/shared_meeting_read_model.json is the index:
 * it keeps the catalog envelope (schema, vintage, sources, counts, relations)
 * and names the bounded shards that carry the meeting rows. `hearings` is the
 * Worker/feed vocabulary alias of those same rows; the builder already sets
 * hearings to the rows array, so shards store rows once and combine restores
 * the alias. Packing rows into shards bounded well below the Pages headroom
 * mark makes published size a property of the shard ceiling instead of a
 * property of the growing meeting corpus.
 */

export const SHARED_MEETING_READ_MODEL_SHARD_SCHEMA = "cityscroll.shared_meeting_read_model_shard.v1";
export const SHARED_MEETING_READ_MODEL_SHARD_DIRECTORY = "shared_meeting_read_model";

// Well under the 15 MiB structural target and the 18 MiB Pages refresh headroom
// mark, so a source refresh that grows the population still leaves margin
// before any published part approaches the 24 MiB Pages guard.
export const DEFAULT_SHARED_MEETING_SHARD_MAX_BYTES = 12 * 1024 * 1024;

function serializedShardBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function sharedMeetingShardPayload(shardId, rows) {
  return {
    schema: SHARED_MEETING_READ_MODEL_SHARD_SCHEMA,
    version: 1,
    shard_id: shardId,
    rows,
  };
}

/** Bytes a row costs inside a shard's indented `rows` array. */
function nestedRowBytes(row) {
  return new TextEncoder().encode(JSON.stringify(row, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")).byteLength + 16;
}

export function sharedMeetingReadModelShardPath(index) {
  return `${SHARED_MEETING_READ_MODEL_SHARD_DIRECTORY}/shard-${String(index).padStart(3, "0")}.json`;
}

/** True when a loaded document is an index that keeps its rows in shards. */
export function isShardedSharedMeetingReadModel(document) {
  return !Array.isArray(document?.rows)
    && !Array.isArray(document?.hearings)
    && Array.isArray(document?.shards);
}

export function sharedMeetingReadModelShardPaths(manifest) {
  return isShardedSharedMeetingReadModel(manifest)
    ? manifest.shards.map((descriptor) => descriptor?.path).filter(Boolean)
    : [];
}

/**
 * Return the index and the shard payloads for one shared meeting catalog.
 * Row order is preserved. Hearings are not duplicated into shards; combine
 * restores the hearings alias from the reassembled rows.
 */
export function buildSharedMeetingReadModelShardArtifacts(
  model,
  { maxShardBytes = DEFAULT_SHARED_MEETING_SHARD_MAX_BYTES } = {},
) {
  const rows = Array.isArray(model?.rows)
    ? model.rows
    : (Array.isArray(model?.hearings) ? model.hearings : []);
  const emptyShardBytes = serializedShardBytes(sharedMeetingShardPayload("candidate", []));
  const chunks = [];
  let current = { rows: [], bytes: emptyShardBytes };

  for (const row of rows) {
    const rowBytes = nestedRowBytes(row);
    if (current.rows.length && current.bytes + rowBytes > maxShardBytes) {
      chunks.push(current);
      current = { rows: [], bytes: emptyShardBytes };
    }
    current.rows.push(row);
    current.bytes += rowBytes;
  }
  chunks.push(current);

  const shards = chunks.map((chunk, index) => sharedMeetingShardPayload(
    String(index).padStart(3, "0"),
    chunk.rows,
  ));
  const descriptors = shards.map((shard, index) => ({
    path: sharedMeetingReadModelShardPath(index),
    bytes: serializedShardBytes(shard),
    row_count: shard.rows.length,
  }));
  for (const descriptor of descriptors) {
    if (descriptor.bytes > maxShardBytes) {
      throw new Error(`shared meeting read model shard ${descriptor.path} is ${descriptor.bytes} bytes, `
        + `above the ${maxShardBytes}-byte shard ceiling. A single row exceeds one shard: reduce the row, `
        + "not the ceiling, because Cloudflare Pages rejects a published file over 25 MiB.");
    }
  }

  const {
    rows: _rows,
    hearings: _hearings,
    ...envelope
  } = model || {};
  const manifest = {
    ...envelope,
    representation: "sharded",
    shard_schema: SHARED_MEETING_READ_MODEL_SHARD_SCHEMA,
    row_count: rows.length,
    shards: descriptors,
  };
  return { manifest, shards };
}

/** Reassemble the original catalog shape from an index and its shards. */
export function combineSharedMeetingReadModel(manifest, shards = []) {
  if (Array.isArray(manifest?.rows) || Array.isArray(manifest?.hearings)) {
    const rows = Array.isArray(manifest?.rows) ? manifest.rows
      : (Array.isArray(manifest?.hearings) ? manifest.hearings : []);
    return {
      ...manifest,
      rows,
      hearings: Array.isArray(manifest?.hearings) ? manifest.hearings : rows,
    };
  }
  const {
    representation: _representation,
    shard_schema: _shardSchema,
    row_count: _rowCount,
    shards: _shards,
    ...envelope
  } = manifest || {};
  const rows = (Array.isArray(shards) ? shards : [])
    .flatMap((shard) => Array.isArray(shard?.rows) ? shard.rows : []);
  return {
    ...envelope,
    rows,
    // Worker/feed vocabulary alias of the same catalog rows.
    hearings: rows,
  };
}

/**
 * Load a shared meeting catalog through its index, following shards when the
 * document is sharded. `fetchJson` reads one document-relative URL.
 */
export async function loadSharedMeetingReadModelDocument(url, fetchJson) {
  const manifest = await fetchJson(url);
  if (!manifest) return null;
  if (!isShardedSharedMeetingReadModel(manifest)) {
    return combineSharedMeetingReadModel(manifest);
  }
  const base = String(url).slice(0, String(url).lastIndexOf("/") + 1);
  const shards = await Promise.all(sharedMeetingReadModelShardPaths(manifest)
    .map((path) => fetchJson(`${base}${path}`)));
  if (shards.length !== manifest.shards.length || shards.some((shard) => !Array.isArray(shard?.rows))) {
    return null;
  }
  return combineSharedMeetingReadModel(manifest, shards);
}
