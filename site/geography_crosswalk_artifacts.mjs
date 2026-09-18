/**
 * Delivery contract for build-time NTA boundary crosswalks.
 *
 * Full-fidelity polygon intersection runs only in the builder. Browser and
 * Worker surfaces read compact relationship rows — never coordinates.
 */

import { GEOGRAPHY_OVERLAY_SCHEMA } from "./civic_geography_overlay.mjs";
import { GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE } from "./geography_navigation_capability.mjs";

export const GEOGRAPHY_CROSSWALK_MANIFEST_SCHEMA =
  "cityscroll.geography_crosswalk_manifest.v1";
export const GEOGRAPHY_CROSSWALK_SHARD_SCHEMA =
  "cityscroll.geography_crosswalk_shard.v1";
export const GEOGRAPHY_CROSSWALK_ROW_SCHEMA = GEOGRAPHY_OVERLAY_SCHEMA;

export const GEOGRAPHY_CROSSWALK_GENERATOR = Object.freeze({
  name: "cityscroll_geography_crosswalk",
  version: 1,
});

/** Absolute area floor (US survey sq ft) separating intersects from below_threshold. */
export const GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT = 50;

/** Presentation projection: retain smaller rows, but do not promote them. */
export const GEOGRAPHY_CROSSWALK_MATERIALITY = Object.freeze({
  field: "pct_from",
  minimum_for_navigation: 0.1,
});

/**
 * Partition-style target layers should nearly cover each NTA. Retained
 * pct_from totals are checked with these absolute percentage-point tolerances;
 * unexplained gaps or excess fail closed instead of silent renormalization.
 *
 * Excess (double-counting) stays tight for every subtype. Under-coverage is
 * tighter for residential NTAs; parks and other special statistical areas may
 * leave uncovered water or out-of-district land within the wider allowance.
 */
export const GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT = Object.freeze({
  excess: 0.05,
  residential_gap: 0.1,
  nonresidential_gap: 10,
});

export const GEOGRAPHY_CROSSWALK_FROM_TYPE = "nta2020";

export const GEOGRAPHY_CROSSWALK_TARGET_TYPES = Object.freeze([
  "community_district",
  "council_district",
  "police_precinct",
]);

/** Target layers whose features partition covered land. */
export const GEOGRAPHY_CROSSWALK_PARTITION_TARGET_TYPES = Object.freeze([
  "community_district",
  "council_district",
  "police_precinct",
]);

export const GEOGRAPHY_CROSSWALK_RELATIONS = Object.freeze([
  "intersects",
  "below_threshold",
  "touches",
]);

export const GEOGRAPHY_CROSSWALK_SITE_ROOT = "site/data/geography/crosswalks";
export const GEOGRAPHY_CROSSWALK_MANIFEST_PATH =
  `${GEOGRAPHY_CROSSWALK_SITE_ROOT}/manifest.json`;

/** Commission-header BK1503 pins. Update only with an explicit fixture diff. */
export const GEOGRAPHY_CROSSWALK_COMMISSION_PINS = Object.freeze({
  selected_key: GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.key,
  from_vintage: GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.selected.boundary_vintage,
  min_area_sqft: GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT,
  materiality: GEOGRAPHY_CROSSWALK_MATERIALITY,
  rows: Object.freeze(
    GEOGRAPHY_NAVIGATION_AREA_OVERLAP_EXAMPLE.relations.map((row) => Object.freeze({
      to_type: row.type,
      to_id: row.id,
      to_key: `geography:${row.type}:${row.id}`,
      to_vintage: row.boundary_vintage,
      relation: row.relation,
      pct_from: row.pct_from,
      intersection_area_sqft: row.area_sq_ft ?? null,
      material_for_navigation: row.material_for_navigation,
    })),
  ),
});

export function geographyCrosswalkPairId(fromType, toType) {
  return `${fromType}__${toType}`;
}

export function geographyCrosswalkVersionSegment(value) {
  return String(value).replace(/[^0-9A-Za-z._-]/g, "-");
}

export function geographyCrosswalkShardPath(fromType, toType, fromVintage, toVintage) {
  const pair = geographyCrosswalkPairId(fromType, toType);
  const fromSeg = geographyCrosswalkVersionSegment(fromVintage);
  const toSeg = geographyCrosswalkVersionSegment(toVintage);
  return `${GEOGRAPHY_CROSSWALK_SITE_ROOT}/${pair}/${fromSeg}__${toSeg}.json`;
}

export function isMaterialForNavigation(pctFrom, {
  minimum = GEOGRAPHY_CROSSWALK_MATERIALITY.minimum_for_navigation,
} = {}) {
  return Number(pctFrom) >= Number(minimum);
}

export function projectCrosswalkDeliveryRow(observation, { toType } = {}) {
  if (!observation || typeof observation !== "object") {
    throw new TypeError("crosswalk delivery row requires an overlay observation");
  }
  if (observation.relation === "disjoint") return null;
  const pctFrom = observation.pct_from;
  return {
    schema: GEOGRAPHY_CROSSWALK_ROW_SCHEMA,
    from_key: observation.from_key,
    to_key: observation.to_key,
    to_type: toType || null,
    relation: observation.relation,
    method: observation.method,
    intersection_area_sqft: observation.intersection_area_sqft,
    pct_from: pctFrom,
    pct_to: observation.pct_to,
    source_vintages: {
      from: observation.source_vintages?.from ?? null,
      to: observation.source_vintages?.to ?? null,
    },
    threshold: {
      min_area_sqft: observation.threshold?.min_area_sqft ?? GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT,
    },
    generator: {
      name: observation.generator?.name || GEOGRAPHY_CROSSWALK_GENERATOR.name,
      version: observation.generator?.version || GEOGRAPHY_CROSSWALK_GENERATOR.version,
    },
    material_for_navigation: isMaterialForNavigation(pctFrom),
  };
}

export function assertNoGeometryPayload(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoGeometryPayload(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "coordinates" || key === "geometry" || key === "rings") {
      throw new Error(`delivery crosswalk must omit ${key} at ${path}.${key}`);
    }
    assertNoGeometryPayload(child, `${path}.${key}`);
  }
}

export function retainedPctFromTotal(rows) {
  return (rows || []).reduce((sum, row) => {
    const value = Number(row?.pct_from);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

export function assertPartitionCoverage(rows, {
  fromKey,
  toType,
  subtype = "residential",
  tolerancePct = GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
} = {}) {
  if (!GEOGRAPHY_CROSSWALK_PARTITION_TARGET_TYPES.includes(toType)) return;
  const total = retainedPctFromTotal(rows);
  const excess = total - 100;
  if (excess > tolerancePct.excess) {
    throw new Error(
      `partition coverage failed for ${fromKey} → ${toType}: retained pct_from total ${total.toFixed(6)} exceeds 100 by ${excess.toFixed(6)} points (tolerance ${tolerancePct.excess}); refusing silent renormalization`,
    );
  }
  const gap = 100 - total;
  const gapTolerance = subtype === "residential"
    ? tolerancePct.residential_gap
    : tolerancePct.nonresidential_gap;
  if (gap > gapTolerance) {
    throw new Error(
      `partition coverage failed for ${fromKey} → ${toType}: retained pct_from total ${total.toFixed(6)} leaves unexplained gap ${gap.toFixed(6)} points for subtype ${subtype} (tolerance ${gapTolerance}); refusing silent renormalization`,
    );
  }
}
