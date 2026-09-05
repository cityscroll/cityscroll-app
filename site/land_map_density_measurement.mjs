/**
 * Land Map marker-density measurement (LM-16).
 *
 * A pure, evidence-first gate for a *possible* visually secondary density
 * summary over the browse Map's already filtered marker set
 * (site/land_map_model.mjs `model.markers`). It never picks a rendering,
 * never touches district/borough geometry, and never treats a computed
 * overlap number alone as permission to ship: shipping additionally needs an
 * explicit, reviewed record of task-impact evidence that this module cannot
 * generate on its own. Absent that review, or when the measured overlap
 * does not cross the configured threshold, the outcome is a stop.
 *
 * Marker positions and the shared render radius are supplied by the caller
 * from the exact projection the SVG canvas paints with
 * (site/app/map_runtime.mjs#landMapMarkerPositions), so this module never
 * re-derives — and can never drift from — that projection. It has no notion
 * of geography, lon/lat, or the NYC extent: it only measures distance
 * between already-projected points.
 */

export const LAND_MAP_DENSITY_SCHEMA = "cityscroll.land_map_density_measurement.v1";
export const LAND_MAP_DENSITY_VERSION = 1;
export const LAND_MAP_DENSITY_METHOD = "rendered_circle_overlap_v1";

/**
 * Share of all possible marker pairs that must visually overlap in the
 * rendered viewBox before a density summary is even considered. Below this,
 * an overlap is read as an isolated coincidence, not a corpus-wide crowding
 * problem worth a second layer.
 */
export const LAND_MAP_DENSITY_OVERLAP_RATE_THRESHOLD = 0.05;

export const LAND_MAP_DENSITY_STOP_REASONS = Object.freeze({
  MARKER_ACCOUNTING_MISMATCH: "marker_accounting_mismatch",
  NO_MAPPED_MARKERS: "no_mapped_markers",
  BELOW_OVERLAP_THRESHOLD: "below_overlap_threshold",
  UNSUPPORTED_TASK_IMPACT: "unsupported_task_impact",
});

/**
 * Verbatim negative-rule ledger from the LM-16 card, kept as data so a test
 * can assert none of them were quietly dropped from what this gate actually
 * enforces.
 */
export const LAND_MAP_DENSITY_NEGATIVE_RULES = Object.freeze([
  "ship_district_or_borough_choropleth",
  "infer_density_for_unmapped_projects",
  "use_boundary_geometry_as_denominator",
  "suppress_project_markers",
  "aggregate_raw_point_data_outside_filtered_model",
  "add_density_as_new_filter_engine",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
  return [...new Set(asArray(values).map(String))].sort();
}

/**
 * Reconcile a set of mapped/unmapped project ids against the model's own
 * total. Mirrors LM-18's set-equality invariant (site/land_viewport_feasibility_gate.mjs):
 * mapped ids plus unmapped ids must union back to exactly the total, with no
 * overlap and nothing left over.
 *
 * @param {{totalIds?: unknown[], mappedIds?: unknown[], unmappedIds?: unknown[]}} [input]
 */
export function markerAccounting({ totalIds, mappedIds, unmappedIds } = {}) {
  const total = uniqueSorted(totalIds);
  const mapped = uniqueSorted(mappedIds);
  const unmapped = uniqueSorted(unmappedIds);
  const totalSet = new Set(total);
  const overlapIds = mapped.filter((id) => unmapped.includes(id));
  const union = uniqueSorted([...mapped, ...unmapped]);
  const reconciled = total.length > 0
    && overlapIds.length === 0
    && union.length === total.length
    && union.every((id) => totalSet.has(id));
  return { total, mapped, unmapped, reconciled };
}

/**
 * Pure Euclidean overlap over already-projected marker positions. Two
 * markers overlap when the distance between their centers is less than
 * twice the shared render radius (the two rendered circles intersect).
 *
 * @param {ReadonlyArray<{projectId: string, x: number, y: number}>} positions
 * @param {number} radius
 */
export function computeMarkerOverlap(positions, radius) {
  const points = asArray(positions)
    .filter((p) => p && p.projectId && Number.isFinite(p.x) && Number.isFinite(p.y));
  const overlappingPairs = [];
  const affected = new Set();
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < radius * 2) {
        overlappingPairs.push({ a: a.projectId, b: b.projectId, distance: Number(distance.toFixed(4)) });
        affected.add(a.projectId);
        affected.add(b.projectId);
      }
    }
  }
  const totalPairs = points.length > 1 ? (points.length * (points.length - 1)) / 2 : 0;
  const overlapRate = totalPairs > 0 ? overlappingPairs.length / totalPairs : 0;
  const affectedMarkerIds = uniqueSorted([...affected]);
  return Object.freeze({
    method: LAND_MAP_DENSITY_METHOD,
    radius,
    markerCount: points.length,
    markerIds: uniqueSorted(points.map((p) => p.projectId)),
    overlappingPairs: Object.freeze(overlappingPairs),
    overlapRate: Number(overlapRate.toFixed(6)),
    affectedMarkerIds: Object.freeze(affectedMarkerIds),
    affectedMarkerShare: points.length > 0 ? Number((affectedMarkerIds.length / points.length).toFixed(6)) : 0,
  });
}

/**
 * Decide whether a candidate density summary may ship, or must resolve to a
 * stop. Pure: reads only its arguments, issues no request, mutates nothing.
 * Shipping requires both a measured overlap at or above `threshold` AND an
 * explicit, reviewed task-impact record — geometry alone is never enough.
 *
 * @param {{
 *   accounting: {total: string[], mapped: string[], unmapped: string[], reconciled: boolean},
 *   overlap: ReturnType<typeof computeMarkerOverlap>|null,
 *   reviewed?: boolean,
 *   taskImpactEvidence?: string|null,
 *   threshold?: number,
 * }} input
 */
export function evaluateLandMapDensitySummary({
  accounting,
  overlap,
  reviewed = false,
  taskImpactEvidence = null,
  threshold = LAND_MAP_DENSITY_OVERLAP_RATE_THRESHOLD,
} = {}) {
  if (!accounting?.reconciled) {
    return { outcome: "stop", reason: LAND_MAP_DENSITY_STOP_REASONS.MARKER_ACCOUNTING_MISMATCH, accounting, overlap: overlap || null, threshold };
  }
  if (!overlap || overlap.markerCount === 0) {
    return { outcome: "stop", reason: LAND_MAP_DENSITY_STOP_REASONS.NO_MAPPED_MARKERS, accounting, overlap: overlap || null, threshold };
  }
  if (overlap.overlapRate < threshold) {
    return { outcome: "stop", reason: LAND_MAP_DENSITY_STOP_REASONS.BELOW_OVERLAP_THRESHOLD, accounting, overlap, threshold };
  }
  const hasTaskImpactEvidence = reviewed === true
    && typeof taskImpactEvidence === "string"
    && taskImpactEvidence.trim().length > 0;
  if (!hasTaskImpactEvidence) {
    return { outcome: "stop", reason: LAND_MAP_DENSITY_STOP_REASONS.UNSUPPORTED_TASK_IMPACT, accounting, overlap, threshold };
  }
  return {
    outcome: "ship",
    accounting,
    overlap,
    threshold,
    summary: {
      method: overlap.method,
      numerator: accounting.mapped.length,
      scope: "projects currently mapped in the active filtered Land Map result",
      markerIds: overlap.markerIds,
      affectedMarkerIds: overlap.affectedMarkerIds,
    },
  };
}

/**
 * Build the evidence-contract receipt for one density measurement/decision:
 * marker accounting, overlap measurement, disclosed numerator/scope,
 * source vintages, and the explicit ship/stop result.
 */
export function buildLandMapDensityReceipt({
  decision,
  sourceVintages = {},
  cardId = "cityscroll-land-map-view/lm-16-density-summary",
} = {}) {
  const accounting = decision?.accounting || { total: [], mapped: [], unmapped: [], reconciled: false };
  const overlap = decision?.overlap || null;
  return {
    schema: LAND_MAP_DENSITY_SCHEMA,
    version: LAND_MAP_DENSITY_VERSION,
    workstream_card: cardId,
    marker_accounting: {
      total_ids: accounting.total,
      mapped_ids: accounting.mapped,
      unmapped_ids: accounting.unmapped,
      total_count: accounting.total.length,
      mapped_count: accounting.mapped.length,
      unmapped_count: accounting.unmapped.length,
      accounting_reconciled: accounting.reconciled,
    },
    overlap_measurement: overlap ? {
      method: overlap.method,
      radius: overlap.radius,
      marker_count: overlap.markerCount,
      overlapping_pairs: overlap.overlappingPairs,
      overlap_rate: overlap.overlapRate,
      affected_marker_ids: overlap.affectedMarkerIds,
      affected_marker_share: overlap.affectedMarkerShare,
      threshold: decision?.threshold ?? LAND_MAP_DENSITY_OVERLAP_RATE_THRESHOLD,
    } : null,
    disclosure: {
      numerator: decision?.summary?.numerator ?? accounting.mapped.length,
      scope: decision?.summary?.scope
        ?? "projects currently mapped in the active filtered Land Map result; unmapped projects and anything outside the current filter are excluded",
    },
    source_vintages: sourceVintages,
    outcome: decision?.outcome === "ship" ? "ship" : "stop",
    stop_reason: decision?.outcome === "ship" ? null : (decision?.reason || null),
    negative_rules_enforced: LAND_MAP_DENSITY_NEGATIVE_RULES,
  };
}

/** Structural check that a receipt actually carries every evidence-contract field. */
export function validateLandMapDensityReceipt(receipt) {
  const errors = [];
  if (receipt?.schema !== LAND_MAP_DENSITY_SCHEMA) errors.push("schema mismatch");
  if (receipt?.version !== LAND_MAP_DENSITY_VERSION) errors.push("version mismatch");
  if (!["ship", "stop"].includes(receipt?.outcome)) errors.push("outcome missing or invalid");
  if (receipt?.outcome === "stop" && !receipt?.stop_reason) errors.push("stop receipt missing stop_reason");
  if (receipt?.outcome === "ship" && receipt?.stop_reason) errors.push("ship receipt must not carry a stop_reason");
  const accounting = receipt?.marker_accounting;
  if (!accounting || accounting.accounting_reconciled !== true) {
    errors.push("marker accounting is not reconciled");
  } else if (accounting.mapped_count + accounting.unmapped_count !== accounting.total_count) {
    errors.push("marker accounting counts do not sum to the total");
  }
  if (receipt?.overlap_measurement) {
    const overlapIds = receipt.overlap_measurement.affected_marker_ids || [];
    const markerSet = new Set(accounting?.mapped_ids || []);
    if (!overlapIds.every((id) => markerSet.has(id))) {
      errors.push("affected marker ids are not a subset of mapped marker ids");
    }
  }
  if (!Array.isArray(receipt?.negative_rules_enforced) || !receipt.negative_rules_enforced.length) {
    errors.push("negative rules ledger missing");
  }
  if (!receipt?.disclosure || !receipt.disclosure.scope || !("numerator" in receipt.disclosure)) {
    errors.push("disclosure numerator/scope missing");
  }
  return { ok: errors.length === 0, errors };
}
