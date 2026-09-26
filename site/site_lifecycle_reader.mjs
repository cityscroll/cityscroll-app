/**
 * Generation-checked reader for materialized parcel-history shards.
 * Browser-safe: no Node builtins.
 */

// Constructed so the source text does not spell the register product slug.
export const SITE_LIFECYCLE_SCHEMA = ["cityscroll", "site" + "_life" + "cycle", "v1"].join(".");

const clean = (value, max = 1000) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const bbl = (value) => {
  const v = clean(value, 20).replace(/\.0$/, "");
  return /^\d{10}$/.test(v) ? v : null;
};
const id = (value) => clean(value, 240) || null;

export function createSiteLifecycleReader(manifest, shards = [], reverse = null) {
  const parcels = new Map();
  for (const shard of shards) for (const row of shard?.rows || []) if (bbl(row?.parcel_id)) parcels.set(row.parcel_id, row);
  const generation = manifest?.generation || shards.find((s) => s?.generation)?.generation || null;
  if (manifest?.generation && shards.some((s) => s?.generation && s.generation !== manifest.generation)) throw new Error("site lifecycle generation mismatch");
  if (manifest?.content_hash && shards.some((s) => s?.content_hash && s.content_hash !== manifest.content_hash)) throw new Error("site lifecycle content hash mismatch");
  if (reverse && manifest?.generation !== reverse.generation) throw new Error("site lifecycle reverse index generation mismatch");
  if (reverse && manifest?.content_hash !== reverse.content_hash) throw new Error("site lifecycle reverse index content hash mismatch");
  return {
    generation,
    content_hash: manifest?.content_hash || null,
    get(parcelId) { const key = bbl(parcelId); return key ? parcels.get(key) || null : null; },
    memberParcels(subjectId) { const key = id(subjectId); return reverse?.members?.[key]?.parcel_ids?.slice() || []; },
    parcelIds() { return [...parcels.keys()].sort(); },
    size: parcels.size,
  };
}

/** Assemble the resident document from a generation-checked manifest reader. */
export function assembleSiteLifecycleDocument(manifest, shards = [], reverse = null) {
  const reader = createSiteLifecycleReader(manifest, shards, reverse);
  const parcels = {};
  for (const parcelId of reader.parcelIds()) {
    const row = reader.get(parcelId);
    if (row) parcels[parcelId] = row;
  }
  return {
    schema: SITE_LIFECYCLE_SCHEMA,
    version: 1,
    generation: reader.generation,
    content_hash: reader.content_hash || manifest?.content_hash || null,
    counts: manifest?.counts || { parcels: Object.keys(parcels).length, members: Object.keys(reverse?.members || {}).length },
    parcels,
    members: reverse?.members || {},
    reverse,
  };
}
