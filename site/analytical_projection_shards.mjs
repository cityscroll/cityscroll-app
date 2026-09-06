/**
 * Build and reassemble the sharded registered-contract analytical projection.
 *
 * The published document at data/analytics_registered_contracts.json is the
 * index: it keeps the whole projection envelope — schema, vintage, population
 * definition, dimensions, measures and receipts — and names the bounded shards
 * that carry the rows. Readers that only need the envelope stop at the index;
 * readers that need the population follow every shard it names.
 *
 * The row population is refreshed on the release runner before the site is
 * built, so its published size is not the size any pull request measured. A
 * monolithic document therefore grows past Cloudflare Pages' per-file limit on
 * a day nobody touched it. Packing rows into shards bounded well below that
 * limit makes the published size a property of the shard ceiling instead of a
 * property of the population, which is the same reason
 * site/procurement_read_model_shards.mjs shards the shared procurement read
 * model, and this module follows its conventions.
 */

export const ANALYTICAL_PROJECTION_SHARD_SCHEMA = "cityscroll.analytics_registered_contracts_shard.v1";
export const ANALYTICAL_PROJECTION_SHARD_DIRECTORY = "analytics_registered_contracts";

// Deliberately below Cloudflare Pages' 24 MiB guard, and the same figure
// DEFAULT_PROCUREMENT_SHARD_MAX_BYTES and the Pages headroom mark already use,
// so a sharded family satisfies the refresh-headroom budget by construction.
export const DEFAULT_ANALYTICAL_PROJECTION_SHARD_MAX_BYTES = 18 * 1024 * 1024;

function serializedShardBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function analyticalShardPayload(shardId, rows) {
  return {
    schema: ANALYTICAL_PROJECTION_SHARD_SCHEMA,
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

export function analyticalProjectionShardPath(index) {
  return `${ANALYTICAL_PROJECTION_SHARD_DIRECTORY}/shard-${String(index).padStart(3, "0")}.json`;
}

/** True when a loaded document is an index that keeps its rows in shards. */
export function isShardedAnalyticalProjection(document) {
  return !Array.isArray(document?.rows) && Array.isArray(document?.shards);
}

export function analyticalProjectionShardPaths(manifest) {
  return isShardedAnalyticalProjection(manifest)
    ? manifest.shards.map((descriptor) => descriptor?.path).filter(Boolean)
    : [];
}

/**
 * Return the index and the shard payloads for one registered-contract
 * projection. Row order is preserved, so the same population always produces
 * the same shards.
 */
export function buildAnalyticalProjectionShardArtifacts(
  projection,
  { maxShardBytes = DEFAULT_ANALYTICAL_PROJECTION_SHARD_MAX_BYTES } = {},
) {
  const rows = Array.isArray(projection?.rows) ? projection.rows : [];
  const emptyShardBytes = serializedShardBytes(analyticalShardPayload("candidate", []));
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

  const shards = chunks.map((chunk, index) => analyticalShardPayload(
    String(index).padStart(3, "0"),
    chunk.rows,
  ));
  const descriptors = shards.map((shard, index) => ({
    path: analyticalProjectionShardPath(index),
    bytes: serializedShardBytes(shard),
    row_count: shard.rows.length,
  }));
  // The estimate above is what packs the shards; this is the measured size of
  // what will actually be written. A shard over the ceiling means one row is
  // larger than a whole shard, which no split can fix, so the build stops here
  // with the offending path rather than handing Cloudflare Pages a file it
  // rejects at deploy time.
  for (const descriptor of descriptors) {
    if (descriptor.bytes > maxShardBytes) {
      throw new Error(`registered-contract projection shard ${descriptor.path} is ${descriptor.bytes} bytes, `
        + `above the ${maxShardBytes}-byte shard ceiling. A single row exceeds one shard: reduce the row, `
        + "not the ceiling, because Cloudflare Pages rejects a published file over 25 MiB.");
    }
  }

  const { rows: _rows, ...envelope } = projection || {};
  const manifest = {
    ...envelope,
    representation: "sharded",
    shard_schema: ANALYTICAL_PROJECTION_SHARD_SCHEMA,
    row_count: rows.length,
    shards: descriptors,
  };
  return { manifest, shards };
}

/** Reassemble the original projection shape from an index and its shards. */
export function combineAnalyticalProjection(manifest, shards = []) {
  if (Array.isArray(manifest?.rows)) return manifest;
  const {
    representation: _representation,
    shard_schema: _shardSchema,
    row_count: _rowCount,
    shards: _shards,
    ...envelope
  } = manifest || {};
  // `rows` was the projection's last key before the split, so appending it here
  // restores the original key order and any fingerprint taken over it.
  return {
    ...envelope,
    rows: (Array.isArray(shards) ? shards : [])
      .flatMap((shard) => Array.isArray(shard?.rows) ? shard.rows : []),
  };
}

/**
 * Load a projection document through its index, following shards when the
 * document is sharded. `fetchJson` reads one document-relative URL.
 */
export async function loadAnalyticalProjectionDocument(url, fetchJson) {
  const manifest = await fetchJson(url);
  if (!isShardedAnalyticalProjection(manifest)) return manifest;
  const base = String(url).slice(0, String(url).lastIndexOf("/") + 1);
  const shards = await Promise.all(analyticalProjectionShardPaths(manifest)
    .map((path) => fetchJson(`${base}${path}`)));
  // A missing shard is a truncated population, not a smaller one. Report the
  // projection as unavailable rather than letting a partial count read as whole.
  if (shards.length !== manifest.shards.length || shards.some((shard) => !Array.isArray(shard?.rows))) return null;
  return combineAnalyticalProjection(manifest, shards);
}
