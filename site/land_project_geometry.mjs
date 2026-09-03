/**
 * Bounded Land project geometry projection.
 *
 * A project may receive a richer shape only when it has exactly one exact
 * WH-06 BBL: that single retained parcel is trusted as the full project site,
 * mirroring the trust the accepted point resolver already gives
 * `single_bbl_centroid`. A project with two or more retained BBLs has no
 * documented relation proving those parcels are the project's complete
 * assemblage, so it is always `ambiguous_relation` and never receives a
 * shape — merging those parcels would launder overlap into a footprint.
 *
 * Geometry acquisition stays build-time only, bounded to the single-BBL
 * candidate set, and reads a retained lookup committed beside the code —
 * never live ArcGIS on the resident path.
 */

import { normalizeBbl } from "./bbl_mappluto_centroids.mjs";

export const LAND_PROJECT_GEOMETRY_SCHEMA = "cityscroll.land_project_geometry.v1";
export const LAND_PROJECT_GEOMETRY_RECEIPT_SCHEMA = "cityscroll.land_project_geometry_receipt.v1";
export const LAND_PROJECT_GEOMETRY_JOIN_VERSION = "exact_single_bbl_wh06_mappluto_parcel_polygon_v1";
export const LAND_PROJECT_GEOMETRY_MAX_BYTES = 16 * 1024;
export const LAND_PROJECT_GEOMETRY_MAX_AGE_DAYS = 120;
export const LAND_PROJECT_GEOMETRY_MAX_RING_POINTS = 200;

export const LAND_PROJECT_GEOMETRY_METHOD = "single_bbl_parcel_polygon";
export const LAND_PROJECT_GEOMETRY_PRECISION = "tax_lot_boundary";
export const LAND_PROJECT_GEOMETRY_RELATION = "exact_single_retained_bbl_full_project_site";

export const LAND_PROJECT_GEOMETRY_COVERAGE_STATES = Object.freeze({
  EXACT: "exact",
  AMBIGUOUS_RELATION: "ambiguous_relation",
  INVALID: "invalid",
  STALE: "stale",
  MISSING_GEOMETRY_ROW: "missing_geometry_row",
  NOT_APPLICABLE_UNMAPPED: "not_applicable_unmapped",
});

const LAND_PARCEL_NYC_BOUNDS = { minLat: 40.4, maxLat: 41.0, minLon: -74.4, maxLon: -73.6 };

function trimGeometryId(value) {
  return String(value ?? "").trim();
}

function asGeometryObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sortedGeometryKeys(record) {
  return Object.keys(record).sort();
}

function geometryProjectUniverse(landDefault) {
  const projects = Array.isArray(landDefault?.projects) ? landDefault.projects : [];
  const seen = new Set();
  const out = [];
  for (const project of projects) {
    const projectId = trimGeometryId(project?.project_id);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    out.push(projectId);
  }
  return out;
}

function exactBblsByProject(zapBbl) {
  const byProject = new Map();
  const rows = Array.isArray(zapBbl?.rows) ? zapBbl.rows : [];
  for (const row of rows) {
    const projectId = trimGeometryId(row?.project_id);
    if (!projectId) continue;
    const seen = byProject.get(projectId) || new Set();
    for (const value of Array.isArray(row?.bbls) ? row.bbls : []) {
      const bbl = normalizeBbl(value);
      if (bbl) seen.add(bbl);
    }
    byProject.set(projectId, seen);
  }
  return byProject;
}

/**
 * Single-BBL candidates: project id -> its one exact BBL. Every other
 * project is either ambiguous (2+ retained BBLs) or has none.
 */
export function singleBblGeometryCandidates({ landDefault, zapBbl }) {
  const universe = geometryProjectUniverse(landDefault);
  const byProject = exactBblsByProject(zapBbl);
  const out = new Map();
  for (const projectId of universe) {
    const bbls = byProject.get(projectId);
    if (bbls && bbls.size === 1) out.set(projectId, [...bbls][0]);
  }
  return out;
}

function ringIsClosed(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const [firstLon, firstLat] = ring[0] || [];
  const [lastLon, lastLat] = ring[ring.length - 1] || [];
  return Number(firstLon) === Number(lastLon) && Number(firstLat) === Number(lastLat);
}

function shoelaceArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Validate one candidate polygon. Returns null when valid, else a reason.
 */
export function landParcelPolygonFindings(entry) {
  const rings = Array.isArray(entry?.rings) ? entry.rings : null;
  if (!rings || rings.length !== 1) {
    return "geometry must carry exactly one simple ring (no multi-part or donut parcels in P0)";
  }
  const ring = rings[0];
  if (!ringIsClosed(ring)) return "ring is not closed";
  if (ring.length > LAND_PROJECT_GEOMETRY_MAX_RING_POINTS) {
    return `ring has ${ring.length} points, exceeds bound ${LAND_PROJECT_GEOMETRY_MAX_RING_POINTS}`;
  }
  for (const point of ring) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "ring has a non-finite point";
    if (
      lat < LAND_PARCEL_NYC_BOUNDS.minLat ||
      lat > LAND_PARCEL_NYC_BOUNDS.maxLat ||
      lon < LAND_PARCEL_NYC_BOUNDS.minLon ||
      lon > LAND_PARCEL_NYC_BOUNDS.maxLon
    ) {
      return "ring point falls outside the NYC bounding box";
    }
  }
  if (shoelaceArea(ring) <= 0) return "ring encloses zero or negative area";
  return null;
}

function geometryAge(materializedAt, now) {
  const stamped = materializedAt ? Date.parse(String(materializedAt)) : NaN;
  const nowMs = Date.parse(String(now || new Date().toISOString()));
  if (!Number.isFinite(stamped) || !Number.isFinite(nowMs)) return null;
  return (nowMs - stamped) / 86_400_000;
}

function shapeEntry({ projectId, bbl, geometryRow, source, materializedAt }) {
  return {
    project_id: projectId,
    bbl,
    geometry_type: "Polygon",
    rings: geometryRow.rings,
    method: LAND_PROJECT_GEOMETRY_METHOD,
    relation: LAND_PROJECT_GEOMETRY_RELATION,
    precision: LAND_PROJECT_GEOMETRY_PRECISION,
    coverage_state: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.EXACT,
    source,
    vintage: materializedAt,
    materialization_version: LAND_PROJECT_GEOMETRY_JOIN_VERSION,
  };
}

function geometryReceiptRow({ projectId, bbl, uniqueExactCount, coverageState, reason }) {
  return {
    project_id: projectId,
    bbl: bbl || null,
    exact_bbl_count: uniqueExactCount,
    coverage_state: coverageState,
    reason: reason || null,
  };
}

/**
 * Materialize the bounded project-geometry projection plus its full-corpus
 * recon receipt. `mappedProjectIds`/`unmappedProjectIds` come from the
 * already-materialized point projection (LM-02) so this module never
 * recomputes or touches point resolution.
 *
 * @param {object} inputs
 * @param {object} inputs.landDefault
 * @param {object} inputs.zapBbl
 * @param {object} inputs.geometrySource retained BBL -> polygon lookup
 * @param {string[]} inputs.mappedProjectIds project ids with an accepted point
 * @param {{ now?: string }} [opts]
 */
export function materializeLandProjectGeometry(inputs = {}, opts = {}) {
  const landDefault = asGeometryObject(inputs.landDefault);
  const zapBbl = asGeometryObject(inputs.zapBbl);
  const geometrySource = asGeometryObject(inputs.geometrySource);
  const byBbl = asGeometryObject(geometrySource.by_bbl);
  const mappedIds = new Set(Array.isArray(inputs.mappedProjectIds) ? inputs.mappedProjectIds : []);
  const universe = geometryProjectUniverse(landDefault);
  const byProject = exactBblsByProject(zapBbl);
  const now = opts.now || new Date().toISOString();
  const source = geometrySource.source || null;
  const materializedAt = geometrySource.materialized_at || null;
  const maxAge = Number.isFinite(Number(geometrySource.max_age_days))
    ? Number(geometrySource.max_age_days)
    : LAND_PROJECT_GEOMETRY_MAX_AGE_DAYS;

  const shapes = {};
  const rows = [];
  const counts = {};
  for (const state of Object.values(LAND_PROJECT_GEOMETRY_COVERAGE_STATES)) counts[state] = 0;
  const byState = {};
  for (const state of Object.values(LAND_PROJECT_GEOMETRY_COVERAGE_STATES)) byState[state] = [];

  for (const projectId of universe) {
    const bbls = byProject.get(projectId) || new Set();
    const uniqueExactCount = bbls.size;

    if (!mappedIds.has(projectId)) {
      rows.push(geometryReceiptRow({
        projectId,
        bbl: null,
        uniqueExactCount,
        coverageState: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.NOT_APPLICABLE_UNMAPPED,
        reason: "project has no accepted point; geometry never substitutes for one",
      }));
      counts[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.NOT_APPLICABLE_UNMAPPED] += 1;
      byState[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.NOT_APPLICABLE_UNMAPPED].push(projectId);
      continue;
    }

    if (uniqueExactCount !== 1) {
      rows.push(geometryReceiptRow({
        projectId,
        bbl: null,
        uniqueExactCount,
        coverageState: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.AMBIGUOUS_RELATION,
        reason: "two or more retained BBLs have no documented complete-assemblage relation",
      }));
      counts[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.AMBIGUOUS_RELATION] += 1;
      byState[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.AMBIGUOUS_RELATION].push(projectId);
      continue;
    }

    const bbl = [...bbls][0];
    const geometryRow = byBbl[bbl];
    if (!geometryRow) {
      rows.push(geometryReceiptRow({
        projectId,
        bbl,
        uniqueExactCount,
        coverageState: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.MISSING_GEOMETRY_ROW,
        reason: "exact BBL has no retained parcel geometry",
      }));
      counts[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.MISSING_GEOMETRY_ROW] += 1;
      byState[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.MISSING_GEOMETRY_ROW].push(projectId);
      continue;
    }

    const invalidReason = landParcelPolygonFindings(geometryRow);
    if (invalidReason) {
      rows.push(geometryReceiptRow({
        projectId,
        bbl,
        uniqueExactCount,
        coverageState: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.INVALID,
        reason: invalidReason,
      }));
      counts[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.INVALID] += 1;
      byState[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.INVALID].push(projectId);
      continue;
    }

    const ageDays = geometryAge(materializedAt, now);
    if (ageDays != null && ageDays > maxAge) {
      rows.push(geometryReceiptRow({
        projectId,
        bbl,
        uniqueExactCount,
        coverageState: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.STALE,
        reason: `geometry age ${ageDays.toFixed(1)}d exceeds max ${maxAge}d`,
      }));
      counts[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.STALE] += 1;
      byState[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.STALE].push(projectId);
      continue;
    }

    shapes[projectId] = shapeEntry({ projectId, bbl, geometryRow, source, materializedAt });
    rows.push(geometryReceiptRow({
      projectId,
      bbl,
      uniqueExactCount,
      coverageState: LAND_PROJECT_GEOMETRY_COVERAGE_STATES.EXACT,
      reason: null,
    }));
    counts[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.EXACT] += 1;
    byState[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.EXACT].push(projectId);
  }

  const payload = {
    schema: LAND_PROJECT_GEOMETRY_SCHEMA,
    shapes: Object.fromEntries(sortedGeometryKeys(shapes).map((id) => [id, shapes[id]])),
  };

  const receipt = {
    schema: LAND_PROJECT_GEOMETRY_RECEIPT_SCHEMA,
    join_version: LAND_PROJECT_GEOMETRY_JOIN_VERSION,
    new_publisher_work: false,
    runtime_network: false,
    geocoder_input: false,
    rejected_relations: [
      "multi_bbl_union",
      "address_or_title_join",
      "proximity_or_overlap_join",
      "borough_or_district_boundary_as_footprint",
    ],
    source: {
      dataset: "mappluto",
      publisher: source?.publisher || "NYC Department of City Planning MapPLUTO/PLUTO",
      mode: geometrySource.mode || null,
      materialized_at: materializedAt,
      max_age_days: maxAge,
    },
    counts: { universe: universe.length, ...counts },
    project_ids: byState,
    point_fallback_preserved: true,
    projects: rows,
    generation: {
      derivation: "node tools/build_land_project_geometry.mjs",
      join_version: LAND_PROJECT_GEOMETRY_JOIN_VERSION,
    },
  };

  return { payload, receipt };
}

export function landProjectGeometryFindings(payload, receipt, opts = {}) {
  const findings = [];
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : LAND_PROJECT_GEOMETRY_MAX_BYTES;
  if (!payload || payload.schema !== LAND_PROJECT_GEOMETRY_SCHEMA) {
    findings.push(`payload schema ${JSON.stringify(payload?.schema)} != ${LAND_PROJECT_GEOMETRY_SCHEMA}`);
  }
  if (!receipt || receipt.schema !== LAND_PROJECT_GEOMETRY_RECEIPT_SCHEMA) {
    findings.push(`receipt schema ${JSON.stringify(receipt?.schema)} != ${LAND_PROJECT_GEOMETRY_RECEIPT_SCHEMA}`);
  }
  if (receipt?.join_version !== LAND_PROJECT_GEOMETRY_JOIN_VERSION) {
    findings.push("receipt join_version mismatch");
  }
  if (receipt?.new_publisher_work !== false) findings.push("new_publisher_work must be false");
  if (receipt?.runtime_network !== false) findings.push("runtime_network must be false");
  if (receipt?.geocoder_input !== false) findings.push("geocoder_input must be false");
  const shapes = payload?.shapes && typeof payload.shapes === "object" ? payload.shapes : {};
  const shapeIds = Object.keys(shapes);
  const exactIds = new Set(receipt?.project_ids?.[LAND_PROJECT_GEOMETRY_COVERAGE_STATES.EXACT] || []);
  if (shapeIds.length !== exactIds.size) {
    findings.push(`payload shapes ${shapeIds.length} != receipt exact ${exactIds.size}`);
  }
  for (const id of shapeIds) {
    const shape = shapes[id];
    if (!exactIds.has(id)) findings.push(`${id} shape not listed as exact in the receipt`);
    if (shape.coverage_state !== LAND_PROJECT_GEOMETRY_COVERAGE_STATES.EXACT) {
      findings.push(`${id} shape coverage_state != exact`);
    }
    if (shape.method !== LAND_PROJECT_GEOMETRY_METHOD) findings.push(`${id} shape method mismatch`);
    if (shape.precision !== LAND_PROJECT_GEOMETRY_PRECISION) findings.push(`${id} shape precision mismatch`);
    if (shape.relation !== LAND_PROJECT_GEOMETRY_RELATION) findings.push(`${id} shape relation mismatch`);
    if (!shape.vintage) findings.push(`${id} shape missing vintage`);
    const shapeInvalid = landParcelPolygonFindings(shape);
    if (shapeInvalid) findings.push(`${id} shape geometry invalid: ${shapeInvalid}`);
  }
  const represented = new Set(
    Object.values(receipt?.project_ids || {}).flat(),
  );
  const universe = receipt?.counts?.universe;
  if (Number.isInteger(universe) && represented.size !== universe) {
    findings.push(`receipt represents ${represented.size} projects, universe ${universe}`);
  }
  const payloadBytes = Number(opts.payloadBytes);
  if (Number.isFinite(payloadBytes) && payloadBytes > maxBytes) {
    findings.push(`payload ${payloadBytes} bytes exceeds ${maxBytes}`);
  }
  if (payload && ("projects" in payload || "generation" in payload || "counts" in payload)) {
    findings.push("payload contains receipt operational fields");
  }
  return findings;
}

export function assertLandProjectGeometry(payload, receipt, opts = {}) {
  const findings = landProjectGeometryFindings(payload, receipt, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}

export const LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION = 1;
export const LAND_PARCEL_GEOMETRY_SOURCE_MODES = Object.freeze(["mappluto_arcgis_batch", "fixture"]);

/**
 * Gate findings for the retained BBL -> polygon source lookup (mirrors
 * `bblMapplutoCentroidsServeGateFindings`, scoped to the bounded
 * single-BBL candidate set instead of the full sell-facing universe).
 */
export function landParcelGeometrySourceFindings(doc, opts = {}) {
  const findings = [];
  if (!doc || typeof doc !== "object") return ["land parcel geometry source document missing"];
  if (Number(doc.schema_version) !== LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION) {
    findings.push(
      `land parcel geometry source schema_version ${doc.schema_version} != ${LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION}`,
    );
  }
  if (!LAND_PARCEL_GEOMETRY_SOURCE_MODES.includes(String(doc.mode || ""))) {
    findings.push(`land parcel geometry source mode ${JSON.stringify(doc.mode)} is not retained MapPLUTO geometry`);
  }
  const byBbl = doc.by_bbl && typeof doc.by_bbl === "object" ? doc.by_bbl : null;
  const wanted = Array.isArray(opts.candidateBbls) ? opts.candidateBbls : [];
  if (!byBbl) {
    findings.push("land parcel geometry source by_bbl is empty");
  } else {
    for (const bbl of wanted) {
      const row = byBbl[bbl];
      if (!row) {
        findings.push(`land parcel geometry source missing candidate BBL ${bbl}`);
        continue;
      }
      const rowInvalid = landParcelPolygonFindings(row);
      if (rowInvalid) findings.push(`land parcel geometry source BBL ${bbl} invalid: ${rowInvalid}`);
    }
  }
  const stamped = doc.materialized_at ? Date.parse(String(doc.materialized_at)) : NaN;
  const nowMs = Date.parse(String(opts.now || new Date().toISOString()));
  const maxAge = Number.isFinite(Number(doc.max_age_days)) ? Number(doc.max_age_days) : LAND_PROJECT_GEOMETRY_MAX_AGE_DAYS;
  if (!Number.isFinite(stamped)) {
    findings.push("land parcel geometry source missing materialized_at");
  } else if (Number.isFinite(nowMs)) {
    const ageDays = (nowMs - stamped) / 86_400_000;
    if (ageDays > maxAge) {
      findings.push(`land parcel geometry source age ${ageDays.toFixed(1)}d exceeds max ${maxAge}d — refresh and republish`);
    }
    if (ageDays < -1) findings.push("land parcel geometry source materialized_at is in the future");
  }
  return findings;
}

export function assertLandParcelGeometrySource(doc, opts = {}) {
  const findings = landParcelGeometrySourceFindings(doc, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}
