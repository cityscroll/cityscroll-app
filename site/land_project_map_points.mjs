/**
 * Bounded Land project-location projection.
 *
 * Joins the default Land snapshot to retained WH-06 BBLs and MapPLUTO
 * centroids, then asks the known-point resolver for a mapped coordinate.
 * Geocodes, district/borough centers, and outcome-only points never publish.
 */

import { centroidEntry, normalizeBbl } from "./bbl_mappluto_centroids.mjs";
import {
  KNOWN_LAND_PROJECT_GEOGRAPHY_SCHEMA,
  KNOWN_LAND_UNMAPPED_REASONS,
  REJECTED_KNOWN_LAND_POINT_METHODS,
  resolveKnownLandProjectPoint,
} from "./land_project_geography.mjs";
import { landParcelPolygonFindings } from "./land_project_geometry.mjs";

export const LAND_PROJECT_MAP_POINTS_SCHEMA = "cityscroll.land_project_map_points.v1";
export const LAND_PROJECT_MAP_POINTS_RECEIPT_SCHEMA = "cityscroll.land_project_map_points_receipt.v1";
export const LAND_PROJECT_MAP_POINTS_JOIN_VERSION = "exact_project_id_wh06_bbl_mappluto_centroid_v1";
export const LAND_PROJECT_MAP_POINTS_RESOLVER_VERSION = KNOWN_LAND_PROJECT_GEOGRAPHY_SCHEMA;
export const LAND_PROJECT_MAP_POINTS_MAX_BYTES = 64 * 1024;

export const LAND_PROJECT_MAP_POINT_SPECIMENS = Object.freeze({
  single_bbl: "2026R0127",
  multi_bbl: "2025K0305",
  no_retained_bbl: "2025M0252",
});

export const LAND_PROJECT_MAP_POINT_OUTCOMES = Object.freeze({
  MAPPED: "mapped",
  UNMAPPED: "unmapped",
  REJECTED: "rejected",
  SOURCE_MISSING: "source_missing",
});

export const LAND_PROJECT_MAP_POINT_REASONS = Object.freeze({
  NO_RETAINED_BBL: "no_retained_bbl",
  EXACT_BBL_MISSING_CENTROID: "exact_bbl_missing_centroid",
  ...KNOWN_LAND_UNMAPPED_REASONS,
});

const REJECTED_REASON_SET = new Set([
  KNOWN_LAND_UNMAPPED_REASONS.ADDRESS_GEOCODE_REJECTED,
  KNOWN_LAND_UNMAPPED_REASONS.UNSUPPORTED_METHOD,
]);

function trimId(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sortedKeys(record) {
  return Object.keys(record).sort();
}

function indexBblsByProject(zapBbl) {
  const byProject = new Map();
  const rows = Array.isArray(zapBbl?.rows) ? zapBbl.rows : [];
  for (const row of rows) {
    const projectId = trimId(row?.project_id);
    if (!projectId) continue;
    const list = byProject.get(projectId) || [];
    for (const value of Array.isArray(row?.bbls) ? row.bbls : []) {
      const bbl = normalizeBbl(value);
      if (bbl) list.push(bbl);
    }
    byProject.set(projectId, list);
  }
  return byProject;
}

function projectUniverse(landDefault) {
  const projects = Array.isArray(landDefault?.projects) ? landDefault.projects : [];
  const seen = new Set();
  const out = [];
  for (const project of projects) {
    const projectId = trimId(project?.project_id);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    out.push({ project_id: projectId, record: project });
  }
  return out;
}

function matchedCentroidPoints(bbls, byBbl) {
  const out = [];
  const seen = new Set();
  for (const bbl of bbls) {
    if (seen.has(bbl)) continue;
    seen.add(bbl);
    const entry = centroidEntry(bbl, byBbl?.[bbl]);
    if (!entry) continue;
    out.push({ bbl, lat: entry.lat, lon: entry.lon });
  }
  return out;
}

function extraPoint(bag, projectId) {
  if (!bag || typeof bag !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(bag, projectId)) return bag[projectId];
  return undefined;
}

function classifyOutcome({ uniqueExactCount, matchedCount, resolved }) {
  if (resolved.status === "mapped") {
    return {
      status: LAND_PROJECT_MAP_POINT_OUTCOMES.MAPPED,
      reason: null,
    };
  }
  if (uniqueExactCount > 0 && matchedCount === 0) {
    return {
      status: LAND_PROJECT_MAP_POINT_OUTCOMES.SOURCE_MISSING,
      reason: LAND_PROJECT_MAP_POINT_REASONS.EXACT_BBL_MISSING_CENTROID,
    };
  }
  if (uniqueExactCount === 0 && REJECTED_REASON_SET.has(resolved.reason)) {
    return {
      status: LAND_PROJECT_MAP_POINT_OUTCOMES.REJECTED,
      reason: resolved.reason,
    };
  }
  if (uniqueExactCount === 0) {
    return {
      status: LAND_PROJECT_MAP_POINT_OUTCOMES.SOURCE_MISSING,
      reason: LAND_PROJECT_MAP_POINT_REASONS.NO_RETAINED_BBL,
    };
  }
  if (REJECTED_REASON_SET.has(resolved.reason)) {
    return {
      status: LAND_PROJECT_MAP_POINT_OUTCOMES.REJECTED,
      reason: resolved.reason,
    };
  }
  return {
    status: LAND_PROJECT_MAP_POINT_OUTCOMES.UNMAPPED,
    reason: resolved.reason || LAND_PROJECT_MAP_POINT_REASONS.NO_ACCEPTED_POINT,
  };
}

function mappedEntry(resolved, shape) {
  return {
    lat: resolved.lat,
    lon: resolved.lon,
    method: resolved.method,
    precision: resolved.precision,
    bbl_count: resolved.bblCount,
    // Additive only (LM-17): a bounded, optional richer shape for the same exact point.
    // Never required, never touches lat/lon/method/precision/bbl_count above.
    shape: shape || null,
  };
}

function geometryByProjectMap(value) {
  if (value instanceof Map) return value;
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return new Map(Object.entries(record));
}

function receiptRow({ projectId, outcome, resolved, uniqueExactCount }) {
  return {
    project_id: projectId,
    status: outcome.status,
    reason: outcome.reason,
    method: resolved.method,
    precision: resolved.status === "mapped" ? resolved.precision : null,
    bbl_count: resolved.bblCount,
    exact_bbl_count: uniqueExactCount,
    selected_bbl: resolved.status === "mapped" ? resolved.bbl : null,
  };
}

function artifactVintage(doc, fields) {
  const out = {};
  for (const field of fields) {
    if (doc?.[field] != null && doc[field] !== "") out[field] = doc[field];
  }
  return out;
}

function inputRecord({ path, countField, vintage, sha256 }) {
  return {
    path,
    count: countField,
    vintage,
    sha256: sha256 || null,
  };
}

/**
 * Materialize mapped Land project points plus an honest receipt for the rest.
 *
 * Extra keys (`geocode`, district/borough centroids, neighboring parcels,
 * outcome points) are ignored unless explicitly passed as resolver extras
 * for tests. Those extras still cannot mint a published point when the
 * resolver rejects them.
 *
 * @param {object} inputs
 * @param {object} inputs.landDefault
 * @param {object} inputs.zapBbl
 * @param {object} inputs.mapplutoCentroids
 * @param {{ land_default?: string, zap_bbl?: string, mappluto_centroids?: string }} [inputs.artifactHashes]
 * @param {object} [inputs.publisherPoints]
 * @param {object} [inputs.propertyPoints]
 * @param {object} [inputs.geometryPoints]
 */
export function materializeLandProjectMapPoints(inputs = {}) {
  const landDefault = asObject(inputs.landDefault);
  const zapBbl = asObject(inputs.zapBbl);
  const centroidsDoc = asObject(inputs.mapplutoCentroids);
  const byBbl = asObject(centroidsDoc.by_bbl);
  const hashes = asObject(inputs.artifactHashes);
  const universe = projectUniverse(landDefault);
  const bblsByProject = indexBblsByProject(zapBbl);
  const geometryByProject = geometryByProjectMap(inputs.geometryByProject);

  const points = {};
  const outcomes = [];
  const counts = {
    universe: universe.length,
    mapped: 0,
    unmapped: 0,
    rejected: 0,
    source_missing: 0,
  };
  const byStatus = {
    mapped: [],
    unmapped: [],
    rejected: [],
    source_missing: [],
  };
  const exactBblMissingCentroid = [];
  const noRetainedBbl = [];

  for (const item of universe) {
    const projectId = item.project_id;
    const exactBbls = bblsByProject.get(projectId) || [];
    const uniqueExact = [...new Set(exactBbls)];
    const bblPoints = matchedCentroidPoints(uniqueExact, byBbl);
    const resolved = resolveKnownLandProjectPoint({
      publisherPoint: extraPoint(inputs.publisherPoints, projectId),
      bblPoints,
      propertyPoint: extraPoint(inputs.propertyPoints, projectId),
      geometryPoint: extraPoint(inputs.geometryPoints, projectId),
    });
    const outcome = classifyOutcome({
      uniqueExactCount: uniqueExact.length,
      matchedCount: bblPoints.length,
      resolved,
    });
    counts[outcome.status] += 1;
    byStatus[outcome.status].push(projectId);
    if (outcome.reason === LAND_PROJECT_MAP_POINT_REASONS.EXACT_BBL_MISSING_CENTROID) {
      exactBblMissingCentroid.push(projectId);
    }
    if (outcome.reason === LAND_PROJECT_MAP_POINT_REASONS.NO_RETAINED_BBL) {
      noRetainedBbl.push(projectId);
    }
    if (outcome.status === LAND_PROJECT_MAP_POINT_OUTCOMES.MAPPED) {
      points[projectId] = mappedEntry(resolved, geometryByProject.get(projectId) || null);
    }
    outcomes.push(receiptRow({
      projectId,
      outcome,
      resolved,
      uniqueExactCount: uniqueExact.length,
    }));
  }

  const payload = {
    schema: LAND_PROJECT_MAP_POINTS_SCHEMA,
    points: Object.fromEntries(sortedKeys(points).map((id) => [id, points[id]])),
  };

  const receipt = {
    schema: LAND_PROJECT_MAP_POINTS_RECEIPT_SCHEMA,
    resolver_version: LAND_PROJECT_MAP_POINTS_RESOLVER_VERSION,
    join_version: LAND_PROJECT_MAP_POINTS_JOIN_VERSION,
    rejected_placement_methods: [...REJECTED_KNOWN_LAND_POINT_METHODS],
    inputs: {
      land_default: inputRecord({
        path: "site/data/land_default_ulurp.json",
        countField: Number(landDefault.count ?? universe.length),
        vintage: artifactVintage(landDefault, ["generated_at", "schema_version", "delivery_tier"]),
        sha256: hashes.land_default,
      }),
      zap_bbl: inputRecord({
        path: "site/data/zap_bbl_warehouse_lookup.json",
        countField: Number(zapBbl.project_count ?? (Array.isArray(zapBbl.rows) ? zapBbl.rows.length : 0)),
        vintage: artifactVintage(zapBbl, ["phase", "dataset_id", "mode", "materialized_at"]),
        sha256: hashes.zap_bbl,
      }),
      mappluto_centroids: inputRecord({
        path: "site/data/bbl_mappluto_centroids_lookup.json",
        countField: Number(centroidsDoc.bbl_count ?? Object.keys(byBbl).length),
        vintage: artifactVintage(centroidsDoc, ["source", "mode", "materialized_at"]),
        sha256: hashes.mappluto_centroids,
      }),
      join_keys: ["project_id", "bbl"],
    },
    counts,
    output: {
      mapped: counts.mapped,
      unmapped: counts.unmapped,
      rejected: counts.rejected,
      source_missing: counts.source_missing,
    },
    mapped_project_ids: byStatus.mapped,
    unmapped_project_ids: byStatus.unmapped,
    rejected_project_ids: byStatus.rejected,
    source_missing_project_ids: byStatus.source_missing,
    unmapped_exact_bbl_missing_centroid: exactBblMissingCentroid,
    unmapped_no_retained_bbl: noRetainedBbl,
    outcomes,
    generation: {
      derivation: "node tools/build_land_project_map_points.mjs",
      resolver_version: LAND_PROJECT_MAP_POINTS_RESOLVER_VERSION,
      join_version: LAND_PROJECT_MAP_POINTS_JOIN_VERSION,
    },
  };

  return { payload, receipt };
}

export function landProjectMapPointsFindings(payload, receipt, opts = {}) {
  const findings = [];
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : LAND_PROJECT_MAP_POINTS_MAX_BYTES;
  if (!payload || payload.schema !== LAND_PROJECT_MAP_POINTS_SCHEMA) {
    findings.push(`payload schema ${JSON.stringify(payload?.schema)} != ${LAND_PROJECT_MAP_POINTS_SCHEMA}`);
  }
  if (!receipt || receipt.schema !== LAND_PROJECT_MAP_POINTS_RECEIPT_SCHEMA) {
    findings.push(`receipt schema ${JSON.stringify(receipt?.schema)} != ${LAND_PROJECT_MAP_POINTS_RECEIPT_SCHEMA}`);
  }
  if (receipt?.resolver_version !== LAND_PROJECT_MAP_POINTS_RESOLVER_VERSION) {
    findings.push("receipt resolver_version mismatch");
  }
  if (receipt?.join_version !== LAND_PROJECT_MAP_POINTS_JOIN_VERSION) {
    findings.push("receipt join_version mismatch");
  }
  const points = payload?.points && typeof payload.points === "object" ? payload.points : {};
  const pointIds = Object.keys(points);
  const mappedIds = new Set(receipt?.mapped_project_ids || []);
  if (pointIds.length !== mappedIds.size) {
    findings.push(`payload mapped ${pointIds.length} != receipt mapped ${mappedIds.size}`);
  }
  for (const id of pointIds) {
    const point = points[id];
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) {
      findings.push(`${id} mapped without finite coordinates`);
    }
    if (!point?.method) findings.push(`${id} mapped without method`);
    if (!point?.precision) findings.push(`${id} mapped without precision`);
    if (!Number.isInteger(point?.bbl_count) || point.bbl_count < 1) {
      findings.push(`${id} mapped without a positive bbl_count`);
    }
    if (point && ("reason" in point || "status" in point || "selected_bbl" in point)) {
      findings.push(`${id} payload carries receipt fields`);
    }
    if (!mappedIds.has(id)) findings.push(`${id} is in the payload but not the receipt mapped set`);
    if (point?.shape) {
      const shapeInvalid = landParcelPolygonFindings(point.shape);
      if (shapeInvalid) findings.push(`${id} shape invalid: ${shapeInvalid}`);
      if (!point.shape.method || !point.shape.precision || !point.shape.relation || !point.shape.vintage) {
        findings.push(`${id} shape missing method, precision, relation, or vintage`);
      }
    }
  }
  const represented = new Set([
    ...(receipt?.mapped_project_ids || []),
    ...(receipt?.unmapped_project_ids || []),
    ...(receipt?.rejected_project_ids || []),
    ...(receipt?.source_missing_project_ids || []),
  ]);
  const universe = receipt?.counts?.universe;
  if (Number.isInteger(universe) && represented.size !== universe) {
    findings.push(`receipt represents ${represented.size} projects, universe ${universe}`);
  }
  for (const method of REJECTED_KNOWN_LAND_POINT_METHODS) {
    if (pointIds.some((id) => points[id]?.method === method)) {
      findings.push(`payload used rejected method ${method}`);
    }
  }
  const payloadBytes = Number(opts.payloadBytes);
  if (Number.isFinite(payloadBytes) && payloadBytes > maxBytes) {
    findings.push(`payload ${payloadBytes} bytes exceeds ${maxBytes}`);
  }
  if (payload && ("outcomes" in payload || "generation" in payload || "inputs" in payload)) {
    findings.push("payload contains receipt operational fields");
  }
  return findings;
}

export function assertLandProjectMapPoints(payload, receipt, opts = {}) {
  const findings = landProjectMapPointsFindings(payload, receipt, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}
