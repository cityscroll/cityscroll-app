/**
 * Citywide BBL → parcel-point lookup over committed 256-way shards.
 *
 * Resident reads use the committed generation under site/data/parcel-geography
 * only. MapPLUTO / PLUTO / ArcGIS stay on the offline build path
 * (tools/build_citywide_parcel_points.mjs) — never the resident hot path.
 *
 * District membership layers attach to these same shards in their own build
 * stage (tools/build_parcel_memberships.mjs) and keep their own per-layer
 * status, vintage, and full-polygon provenance. Each parcel entry carries its
 * typed memberships after that stage; this module reads both layers.
 */

import { civicGeographyKey, civicGeographyLayer } from "./civic_geography_registry.mjs";
import { normalizeBbl } from "./bbl_mappluto_centroids.mjs";

export const PARCEL_GEOGRAPHY_MANIFEST_SCHEMA = "cityscroll.parcel-geography-manifest.v1";
export const PARCEL_GEOGRAPHY_SHARD_SCHEMA = "cityscroll.parcel-geography-shard.v1";
export const PARCEL_GEOGRAPHY_DIR = "site/data/parcel-geography";
export const PARCEL_GEOGRAPHY_MANIFEST_PATH = `${PARCEL_GEOGRAPHY_DIR}/manifest.json`;
/** Deterministic BBL shard fan-out: one parcel's bundle is one small fetch. */
export const PARCEL_GEOGRAPHY_SHARD_COUNT = 256;
/** Align with the MapPLUTO source contract's retained-extract max_stale_days. */
export const PARCEL_GEOGRAPHY_MAX_AGE_DAYS = 120;
/**
 * Population floor for a committed citywide generation. This is a property of
 * the official MapPLUTO tax-lot population (hundreds of thousands of lots),
 * deliberately not a named-record expectation: publisher windows roll, and a
 * record id pinned into a gate becomes a deploy outage the day that lot leaves
 * the window. Named-parcel assertions live in the card replay tests only.
 */
export const PARCEL_GEOGRAPHY_MIN_PARCELS = 700_000;
export const PARCEL_GEOGRAPHY_MODES = Object.freeze([
  "mappluto_pluto_csv",
  "mappluto_arcgis_batch",
]);
/** Official MapPLUTO parcel points are the published PLUTO Latitude/Longitude. */
export const PARCEL_GEOGRAPHY_POINT_METHOD = "mappluto_published_latitude_longitude";
/**
 * NYC-envelop bounds for published parcel points. Anything outside is a
 * publisher defect or a misparse, never a coordinate for a NYC tax lot.
 */
export const PARCEL_POINT_NYC_BOUNDS = Object.freeze({
  min_lat: 40.4,
  max_lat: 41.0,
  min_lon: -74.4,
  max_lon: -73.6,
});

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic shard key for a BBL: fnv1a over the normalized 10-digit BBL,
 * mod the shard count, as two lowercase hex digits (for 256 shards).
 * @param {string} bbl
 * @param {number} [shardCount]
 * @returns {string}
 */
export function parcelShardKey(bbl, shardCount = PARCEL_GEOGRAPHY_SHARD_COUNT) {
  const normalized = normalizeBbl(bbl) || String(bbl ?? "").trim();
  const count = Number.isInteger(shardCount) && shardCount > 0 ? shardCount : PARCEL_GEOGRAPHY_SHARD_COUNT;
  return (fnv1a(normalized) % count).toString(16).padStart(2, "0");
}

/**
 * Validate one publisher parcel-point row. Missing, null, nonfinite, or
 * out-of-NYC coordinates return null — they never coerce to zero, a borough
 * center, or any other fabricated point.
 * @param {string} bbl
 * @param {{ lat: number, lon: number }} point
 * @returns {{ lat: number, lon: number }|null}
 */
export function parcelPointEntry(bbl, point) {
  const id = normalizeBbl(bbl);
  if (!id) return null;
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (
    lat < PARCEL_POINT_NYC_BOUNDS.min_lat
    || lat > PARCEL_POINT_NYC_BOUNDS.max_lat
    || lon < PARCEL_POINT_NYC_BOUNDS.min_lon
    || lon > PARCEL_POINT_NYC_BOUNDS.max_lon
  ) {
    return null;
  }
  return { lat, lon };
}

/**
 * Read one parcel's official point from a loaded shard document by exact BBL.
 * @param {object|null|undefined} shardDoc
 * @param {string} bbl
 * @returns {{ bbl: string, lat: number, lon: number, key: string }|null}
 */
export function lookupParcelPoint(shardDoc, bbl) {
  if (!shardDoc || shardDoc.schema !== PARCEL_GEOGRAPHY_SHARD_SCHEMA) return null;
  const id = normalizeBbl(bbl);
  if (!id) return null;
  const hit = shardDoc.parcels?.[id];
  const entry = parcelPointEntry(id, hit);
  if (!entry) return null;
  return { bbl: id, lat: entry.lat, lon: entry.lon, key: String(shardDoc.key || "") };
}

/**
 * Structural / population gate for a committed citywide generation manifest.
 * Asserts population properties and accounting identities only — never a named
 * upstream record. Freshness is carried by the retained coordinate vintage and
 * the source contract's refresh path, not by a wall-clock age check here.
 *
 * opts.minParcels lowers the population floor for replay/rehearsal builds only
 * (their population is the named replay rows, not the citywide tax-lot
 * population); the default floor always applies to the committed generation.
 * @param {object} manifest
 * @param {{ minParcels?: number }} [opts]
 * @returns {string[]} findings (empty means the gate passes)
 */
export function parcelGeographyServeGateFindings(manifest, opts = {}) {
  const minParcels = Number.isFinite(opts.minParcels) && opts.minParcels >= 0
    ? opts.minParcels
    : PARCEL_GEOGRAPHY_MIN_PARCELS;
  const findings = [];
  if (!manifest || typeof manifest !== "object") {
    findings.push("parcel-geography manifest missing");
    return findings;
  }
  if (manifest.schema !== PARCEL_GEOGRAPHY_MANIFEST_SCHEMA) {
    findings.push(
      `parcel-geography schema ${JSON.stringify(manifest.schema)} != ${PARCEL_GEOGRAPHY_MANIFEST_SCHEMA}`,
    );
  }
  if (!PARCEL_GEOGRAPHY_MODES.includes(String(manifest.mode || ""))) {
    findings.push(
      `parcel-geography mode ${JSON.stringify(manifest.mode)} is not a retained MapPLUTO extract (${PARCEL_GEOGRAPHY_MODES.join("|")})`,
    );
  }
  if (String(manifest.point_method || "") !== PARCEL_GEOGRAPHY_POINT_METHOD) {
    findings.push(
      `parcel-geography point_method ${JSON.stringify(manifest.point_method)} != ${PARCEL_GEOGRAPHY_POINT_METHOD}`,
    );
  }
  if (!String(manifest.coordinate_vintage || "").trim()) {
    findings.push("parcel-geography coordinate_vintage missing");
  }
  const source = manifest.source;
  if (!source || typeof source !== "object") {
    findings.push("parcel-geography source receipt missing");
  } else {
    if (!String(source.publisher || "").trim()) findings.push("parcel-geography source.publisher missing");
    if (!/^[0-9a-f]{64}$/i.test(String(source.sha256 || ""))) {
      findings.push("parcel-geography source content hash (sha256) missing");
    }
  }
  if (Number(manifest.shard_count) !== PARCEL_GEOGRAPHY_SHARD_COUNT) {
    findings.push(
      `parcel-geography shard_count ${JSON.stringify(manifest.shard_count)} != ${PARCEL_GEOGRAPHY_SHARD_COUNT}`,
    );
  }
  const shards = manifest.shards && typeof manifest.shards === "object" ? manifest.shards : null;
  if (!shards || Object.keys(shards).length !== PARCEL_GEOGRAPHY_SHARD_COUNT) {
    findings.push("parcel-geography shard descriptors incomplete");
  }
  const coverage = manifest.coverage || {};
  const retained = Number(coverage.retained_parcels);
  if (!Number.isFinite(retained) || retained < minParcels) {
    findings.push(
      `parcel-geography retained_parcels ${retained} below citywide floor ${minParcels}`,
    );
  }
  const excluded = coverage.excluded_rows || {};
  const excludedSum = Object.values(excluded).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const publisherRows = Number(coverage.publisher_rows);
  if (!Number.isFinite(publisherRows) || publisherRows <= 0) {
    findings.push("parcel-geography coverage.publisher_rows missing");
  } else if (Number.isFinite(retained) && retained + excludedSum !== publisherRows) {
    findings.push(
      `parcel-geography accounting broken: retained ${retained} + excluded ${excludedSum} != publisher rows ${publisherRows}`,
    );
  }
  const padReferenced = Number(coverage.pad_referenced_bbls);
  const padOnly = Number(coverage.pad_only_unmatched);
  if (!Number.isFinite(padReferenced) || padReferenced < 0) {
    findings.push("parcel-geography PAD accounting missing");
  }
  if (Number.isFinite(padReferenced) && Number.isFinite(padOnly) && padOnly > padReferenced) {
    findings.push("parcel-geography pad_only_unmatched exceeds pad_referenced_bbls");
  }
  const build = manifest.build;
  if (!build || typeof build !== "object" || !(Number(build.duration_ms) >= 0)) {
    findings.push("parcel-geography build timing receipt missing");
  }
  return findings;
}

export function assertParcelGeographyServeGate(manifest, opts = {}) {
  const findings = parcelGeographyServeGateFindings(manifest, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}

// ---------------------------------------------------------------------------
// Parcel memberships: typed layer matches materialized onto the same shards.
//
// Each parcel shard may carry a `memberships` header (per-layer full-polygon
// provenance) and per-parcel typed membership values. A per-parcel value is
// either the single matched feature id as a string (the common matched case)
// or an object `{ ids, status, boundary_ids? }` for every other outcome.
// Memberships are properties of the source parcel point — never a claim that
// an entrance or the whole lot lies inside the matched polygons.
// ---------------------------------------------------------------------------

export const PARCEL_MEMBERSHIP_LAYERS = Object.freeze([
  "borough",
  "community_district",
  "council_district",
  "nta2020",
  "police_precinct",
]);
export const PARCEL_MEMBERSHIP_SCHEMA = "cityscroll.parcel-memberships.v1";
export const PARCEL_MEMBERSHIP_MANIFEST_SCHEMA = "cityscroll.parcel-membership-manifest.v1";
export const PARCEL_MEMBERSHIP_STATUSES = Object.freeze([
  "matched",
  "ambiguous_boundary",
  "not_covered",
  "source_unavailable",
]);

function overlapsAllowed(type) {
  return civicGeographyLayer(type)?.cardinality === "zero_or_more_overlaps_allowed";
}

/**
 * Normalize one stored per-parcel membership value for a layer type.
 * Returns `{ ids, status, boundaryIds }` or null when the stored value cannot
 * be a truthful membership (unknown ids, invalid status, empty shorthand).
 * A string is the single matched feature id; an object states its own status
 * or has one derived from its ids and the layer cardinality. Nothing here
 * ever derives one layer's membership from another layer's result.
 * @param {string} type registered layer type
 * @param {string|{ids?: string[], status?: string, boundary_ids?: string[]}} stored
 * @returns {{ ids: string[], status: string, boundaryIds: string[] }|null}
 */
export function normalizeParcelMembership(type, stored) {
  const canonicalIds = (ids) => {
    if (!Array.isArray(ids)) return null;
    const out = [];
    for (const id of ids) {
      const value = String(id ?? "");
      if (!civicGeographyKey(type, value)) return null;
      out.push(value);
    }
    return [...new Set(out)].sort();
  };
  if (typeof stored === "string") {
    const ids = canonicalIds([stored]);
    if (!ids || ids.length !== 1) return null;
    return { ids, status: "matched", boundaryIds: [] };
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const ids = canonicalIds(stored.ids);
  if (!ids) return null;
  const boundaryIds = stored.boundary_ids === undefined
    ? []
    : canonicalIds(stored.boundary_ids);
  if (!boundaryIds || boundaryIds.some((id) => !ids.includes(id))) return null;
  let status = stored.status === undefined ? null : String(stored.status);
  if (status === null) {
    if (ids.length === 0) status = "not_covered";
    else if (ids.length > 1 && !overlapsAllowed(type)) status = "ambiguous_boundary";
    else status = "matched";
  } else if (!PARCEL_MEMBERSHIP_STATUSES.includes(status)) {
    return null;
  }
  if (status === "matched" && ids.length === 0) return null;
  if (status === "ambiguous_boundary" && ids.length < 2) return null;
  if (status === "not_covered" && ids.length > 0) return null;
  if (status === "source_unavailable" && ids.length > 0) return null;
  return { ids, status, boundaryIds };
}

/**
 * Read one parcel's materialized membership bundle from a loaded shard.
 * Each layer value carries the shard header's provenance for that layer, so
 * the bundle is self-describing about which polygon generation answered.
 * Returns null when the parcel or the shard's membership layer is absent;
 * callers fall back to `lookupParcelPoint` for points only.
 * @param {object|null|undefined} shardDoc
 * @param {string} bbl
 * @returns {{ bbl: string, lat: number, lon: number, memberships: Record<string, { ids: string[], status: string, boundaryIds: string[], vintage: string|null, geometry_fidelity: string|null, sha256: string|null }> }|null}
 */
export function lookupParcelMemberships(shardDoc, bbl) {
  if (!shardDoc || shardDoc.schema !== PARCEL_GEOGRAPHY_SHARD_SCHEMA) return null;
  const id = normalizeBbl(bbl);
  if (!id) return null;
  const hit = shardDoc.parcels?.[id];
  const entry = parcelPointEntry(id, hit);
  if (!entry || !hit?.memberships || typeof hit.memberships !== "object") return null;
  const header = shardDoc.memberships;
  if (header?.schema !== PARCEL_MEMBERSHIP_SCHEMA) return null;
  const memberships = {};
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const normalized = normalizeParcelMembership(type, hit.memberships[type]);
    if (!normalized) return null;
    const provenance = header.layers?.[type] || {};
    memberships[type] = {
      ...normalized,
      vintage: provenance.vintage ?? null,
      geometry_fidelity: provenance.geometry_fidelity ?? null,
      sha256: provenance.sha256 ?? null,
    };
  }
  return { bbl: id, lat: entry.lat, lon: entry.lon, memberships };
}

/**
 * Structural gate for one materialized shard: the membership header must be
 * present and internally consistent, and every per-parcel value must
 * normalize truthfully. Findings are strings; empty means the gate passes.
 * @param {object|null|undefined} shardDoc
 * @returns {string[]}
 */
export function parcelShardMembershipFindings(shardDoc) {
  const findings = [];
  if (!shardDoc || shardDoc.schema !== PARCEL_GEOGRAPHY_SHARD_SCHEMA) {
    return ["shard document missing or schema mismatch"];
  }
  const header = shardDoc.memberships;
  if (header?.schema !== PARCEL_MEMBERSHIP_SCHEMA) {
    return ["parcel membership header missing (shard not materialized)"];
  }
  const layers = header.layers && typeof header.layers === "object" ? header.layers : null;
  if (!layers) return ["parcel membership header has no layer provenance"];
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const provenance = layers[type];
    if (!provenance || typeof provenance !== "object") {
      findings.push(`membership layer provenance missing for ${type}`);
      continue;
    }
    if (provenance.status === "resolved") {
      if (!/^[0-9a-f]{64}$/i.test(String(provenance.sha256 || ""))) {
        findings.push(`membership provenance sha256 missing for ${type}`);
      }
      if (String(provenance.geometry_fidelity || "") !== "full") {
        findings.push(`membership provenance geometry_fidelity not full for ${type}`);
      }
      if (!String(provenance.vintage || "").trim()) {
        findings.push(`membership provenance vintage missing for ${type}`);
      }
    } else if (provenance.status !== "source_unavailable") {
      findings.push(`membership provenance status invalid for ${type}`);
    }
  }
  const parcels = shardDoc.parcels && typeof shardDoc.parcels === "object" ? shardDoc.parcels : null;
  if (!parcels) {
    findings.push("shard has no parcels");
    return findings;
  }
  let normalized = 0;
  let bad = 0;
  for (const [bbl, entry] of Object.entries(parcels)) {
    if (!entry?.memberships || typeof entry.memberships !== "object") {
      bad += 1;
      if (bad === 1) findings.push(`parcel ${bbl} has no membership values`);
      continue;
    }
    for (const type of PARCEL_MEMBERSHIP_LAYERS) {
      const value = normalizeParcelMembership(type, entry.memberships[type]);
      if (!value) {
        bad += 1;
        if (bad <= 3) findings.push(`parcel ${bbl} has an untruthful ${type} membership`);
        continue;
      }
      if (value.status === "source_unavailable" && layers[type]?.status !== "source_unavailable") {
        bad += 1;
        if (bad <= 3) findings.push(`parcel ${bbl} claims ${type} source_unavailable but the layer resolved`);
      }
      normalized += 1;
    }
  }
  if (bad === 0 && normalized !== Object.keys(parcels).length * PARCEL_MEMBERSHIP_LAYERS.length) {
    findings.push("membership normalization did not cover every parcel layer value");
  }
  return findings;
}
