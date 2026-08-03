#!/usr/bin/env node
// Build the one contracted district-boundary layer: community districts
// (5crt-au7u) + City Council districts (872g-cjhh). Simplify polygons for
// browser/worker point-in-polygon; label boundary_vintage per source and on
// the combined artifact. Dual-write site/ + worker/ twins. No live GIS at
// request time.
//
//   node tools/build_district_boundaries.mjs
//   node tools/build_district_boundaries.mjs --check
//   node tools/build_district_boundaries.mjs --fixture
//
// Compat: also writes the council-only v0 shape consumed by older paths.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_UNIFIED = join(ROOT, "site/data/district_boundaries.json");
const WORKER_UNIFIED = join(ROOT, "worker/src/data/district_boundaries.json");
const SITE_COUNCIL = join(ROOT, "site/data/council_district_boundaries.json");
const WORKER_COUNCIL = join(ROOT, "worker/src/data/council_district_boundaries.json");

const SCHEMA_V1 = "cityscroll.district_boundaries.v1";
const SCHEMA_COUNCIL_V0 = "cityscroll.district_boundaries.v0";
const TOL = 0.00045;

const COMMUNITY = {
  id: "community_district",
  dataset_id: "5crt-au7u",
  name: "Community Districts",
  meta_url: "https://data.cityofnewyork.us/api/views/5crt-au7u.json",
  geo_url: "https://data.cityofnewyork.us/resource/5crt-au7u.geojson?$limit=100",
  source_url: "https://data.cityofnewyork.us/d/5crt-au7u",
};

const COUNCIL = {
  id: "council_district",
  dataset_id: "872g-cjhh",
  name: "City Council Districts",
  meta_url: "https://data.cityofnewyork.us/api/views/872g-cjhh.json",
  geo_url: "https://data.cityofnewyork.us/resource/872g-cjhh.geojson?$limit=60",
  source_url: "https://data.cityofnewyork.us/d/872g-cjhh",
};

const BORO_PREFIX = { 1: "M", 2: "X", 3: "K", 4: "Q", 5: "R" };
const BORO_NAME = {
  M: "Manhattan",
  X: "Bronx",
  K: "Brooklyn",
  Q: "Queens",
  R: "Staten Island",
};

function round(n) {
  return Math.round(n * 1e5) / 1e5;
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points, eps) {
  if (points.length <= 2) return points.slice();
  let maxDist = -1;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = distToSegment(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > eps) {
    const left = douglasPeucker(points.slice(0, index + 1), eps);
    const right = douglasPeucker(points.slice(index), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

function simplifyRing(ring, eps) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const closed =
    ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1];
  const core = (closed ? ring.slice(0, -1) : ring.slice())
    .map((c) => [Number(c[0]), Number(c[1])]);
  if (core.length < 3) return null;
  let simplified = douglasPeucker(core, eps).map((c) => [round(c[0]), round(c[1])]);
  if (simplified.length < 3) return null;
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    simplified = simplified.concat([[first[0], first[1]]]);
  }
  return simplified;
}

function simplifyGeometry(geom, eps) {
  if (!geom) return [];
  const polygons = [];
  if (geom.type === "Polygon") {
    const rings = geom.coordinates.map((ring) => simplifyRing(ring, eps)).filter(Boolean);
    if (rings.length) polygons.push({ rings });
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      const rings = poly.map((ring) => simplifyRing(ring, eps)).filter(Boolean);
      if (rings.length) polygons.push({ rings });
    }
  }
  return polygons;
}

function bboxOf(polygons) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const poly of polygons) {
    for (const ring of poly.rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return [round(minLon), round(minLat), round(maxLon), round(maxLat)];
}

/** boro_cd "404" → product id "Q04"; JIAs keep borough letter + padded remainder. */
function communityIdFromBoroCd(boroCd) {
  const raw = String(boroCd || "").trim();
  if (!/^[1-5]\d{2}$/.test(raw)) return null;
  const boro = Number(raw[0]);
  const district = Number(raw.slice(1));
  const prefix = BORO_PREFIX[boro];
  if (!prefix || !Number.isInteger(district) || district < 1) return null;
  return prefix + String(district).padStart(2, "0");
}

function communityLabel(id, boroCd) {
  const prefix = id && id[0];
  const num = id ? Number(id.slice(1)) : NaN;
  const boro = BORO_NAME[prefix] || "NYC";
  if (Number.isInteger(num) && num >= 1 && num <= 18) {
    return `${boro} Community District ${num}`;
  }
  return `${boro} community district area ${boroCd}`;
}

function vintageFromMeta(meta) {
  const vintageTs = Number(meta.rowsUpdatedAt || meta.viewLastModified || 0);
  if (!vintageTs) return { boundary_vintage: null, source_updated_at: null, vintageTs: 0 };
  return {
    boundary_vintage: new Date(vintageTs * 1000).toISOString().slice(0, 10),
    source_updated_at: new Date(vintageTs * 1000).toISOString(),
    vintageTs,
  };
}

async function fetchSourceMeta(spec, fetchImpl) {
  const metaRes = await fetchImpl(spec.meta_url);
  if (!metaRes.ok) throw new Error(`${spec.id} meta HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const vintage = vintageFromMeta(meta);
  return {
    dataset_id: spec.dataset_id,
    dataset_name: meta.name || spec.name,
    source_url: spec.source_url,
    boundary_vintage: vintage.boundary_vintage,
    source_updated_at: vintage.source_updated_at,
  };
}

async function fetchGeojson(spec, fetchImpl) {
  const geoRes = await fetchImpl(spec.geo_url);
  if (!geoRes.ok) throw new Error(`${spec.id} geojson HTTP ${geoRes.status}`);
  return geoRes.json();
}

function buildCouncilDistricts(geo) {
  const byId = new Map();
  for (const feature of geo.features || []) {
    const raw = feature.properties?.coundist ?? feature.properties?.counDist;
    const id = String(raw ?? "").trim().replace(/^0+/, "") || String(raw ?? "").trim();
    const normalized = /^(?:[1-9]|[1-4]\d|5[01])$/.test(id) ? id : null;
    if (!normalized) continue;
    const polygons = simplifyGeometry(feature.geometry, TOL);
    if (!polygons.length) continue;
    const existing = byId.get(normalized);
    if (existing) {
      existing.polygons.push(...polygons);
      existing.bbox = bboxOf(existing.polygons);
    } else {
      byId.set(normalized, {
        id: normalized,
        label: `City Council District ${normalized}`,
        bbox: bboxOf(polygons),
        polygons,
      });
    }
  }
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

function buildCommunityDistricts(geo) {
  const byId = new Map();
  for (const feature of geo.features || []) {
    const boroCd = String(feature.properties?.boro_cd ?? feature.properties?.boroCd ?? "").trim();
    const id = communityIdFromBoroCd(boroCd);
    if (!id) continue;
    const polygons = simplifyGeometry(feature.geometry, TOL);
    if (!polygons.length) continue;
    const existing = byId.get(id);
    if (existing) {
      existing.polygons.push(...polygons);
      existing.bbox = bboxOf(existing.polygons);
    } else {
      byId.set(id, {
        id,
        boro_cd: boroCd,
        label: communityLabel(id, boroCd),
        bbox: bboxOf(polygons),
        polygons,
      });
    }
  }
  // Regular CDs (district ≤ 18) first so point-in-polygon prefers them over JIAs.
  return [...byId.values()].sort((a, b) => {
    const aReg = Number(a.id.slice(1)) <= 18 ? 0 : 1;
    const bReg = Number(b.id.slice(1)) <= 18 ? 0 : 1;
    if (aReg !== bReg) return aReg - bReg;
    return a.id.localeCompare(b.id);
  });
}

function minVintage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a <= b ? a : b;
}

function fixtureLayer() {
  // Elmhurst, Queens — golden location-awareness point (-73.8832, 40.7473).
  // Tight squares so unit tests stay offline.
  const ring = [
    [-73.89, 40.74],
    [-73.87, 40.74],
    [-73.87, 40.755],
    [-73.89, 40.755],
    [-73.89, 40.74],
  ];
  const poly = { rings: [ring] };
  const bbox = [-73.89, 40.74, -73.87, 40.755];
  return {
    schema: SCHEMA_V1,
    boundary_vintage: "2026-05-26",
    sources: {
      community_district: {
        dataset_id: COMMUNITY.dataset_id,
        dataset_name: "Community Districts (fixture)",
        source_url: COMMUNITY.source_url,
        boundary_vintage: "2026-05-26",
        source_updated_at: "2026-05-26T19:35:31.000Z",
      },
      council_district: {
        dataset_id: COUNCIL.dataset_id,
        dataset_name: "City Council Districts (fixture)",
        source_url: COUNCIL.source_url,
        boundary_vintage: "2026-05-26",
        source_updated_at: "2026-05-26T19:35:31.000Z",
      },
    },
    built_at: new Date().toISOString(),
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    community_district_count: 1,
    council_district_count: 1,
    community_districts: [{
      id: "Q04",
      boro_cd: "404",
      label: "Queens Community District 4",
      bbox,
      polygons: [poly],
    }],
    council_districts: [{
      id: "25",
      label: "City Council District 25",
      bbox,
      polygons: [poly],
    }],
  };
}

async function buildFromOpenData(fetchImpl = fetch) {
  const [communityMeta, councilMeta, communityGeo, councilGeo] = await Promise.all([
    fetchSourceMeta(COMMUNITY, fetchImpl),
    fetchSourceMeta(COUNCIL, fetchImpl),
    fetchGeojson(COMMUNITY, fetchImpl),
    fetchGeojson(COUNCIL, fetchImpl),
  ]);

  const community_districts = buildCommunityDistricts(communityGeo);
  const council_districts = buildCouncilDistricts(councilGeo);

  if (community_districts.length < 59) {
    throw new Error(`expected ≥59 community districts, got ${community_districts.length}`);
  }
  if (council_districts.length < 50) {
    throw new Error(`expected at least 50 council districts, got ${council_districts.length}`);
  }

  const boundary_vintage = minVintage(
    communityMeta.boundary_vintage,
    councilMeta.boundary_vintage,
  );

  return {
    schema: SCHEMA_V1,
    boundary_vintage,
    sources: {
      community_district: communityMeta,
      council_district: councilMeta,
    },
    built_at: new Date().toISOString(),
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    community_district_count: community_districts.length,
    council_district_count: council_districts.length,
    community_districts,
    council_districts,
  };
}

/** Council-only v0 twin for paths that still load council_district_boundaries.json. */
function councilOnlyLayer(unified) {
  const src = unified.sources?.council_district || {};
  return {
    schema: SCHEMA_COUNCIL_V0,
    layer: "council_district",
    dataset_id: src.dataset_id || COUNCIL.dataset_id,
    dataset_name: src.dataset_name || COUNCIL.name,
    source_url: src.source_url || COUNCIL.source_url,
    boundary_vintage: src.boundary_vintage || unified.boundary_vintage,
    source_updated_at: src.source_updated_at || null,
    built_at: unified.built_at,
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    district_count: unified.council_district_count,
    districts: unified.council_districts,
  };
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(obj)}\n`;
  writeFileSync(path, text);
  return text;
}

function writeLayer(unified) {
  const council = councilOnlyLayer(unified);
  writeJson(SITE_UNIFIED, unified);
  writeJson(WORKER_UNIFIED, unified);
  writeJson(SITE_COUNCIL, council);
  writeJson(WORKER_COUNCIL, council);
  return { unified, council };
}

function checkLayer() {
  const errors = [];
  if (!existsSync(SITE_UNIFIED)) {
    return { errors: ["missing site/data/district_boundaries.json"] };
  }
  const committed = JSON.parse(readFileSync(SITE_UNIFIED, "utf8"));
  if (committed.schema !== SCHEMA_V1) errors.push("schema mismatch");
  if (!committed.boundary_vintage) errors.push("missing boundary_vintage");
  if (!committed.sources?.community_district?.boundary_vintage) {
    errors.push("missing community source boundary_vintage");
  }
  if (!committed.sources?.council_district?.boundary_vintage) {
    errors.push("missing council source boundary_vintage");
  }
  if (!Array.isArray(committed.community_districts) || committed.community_districts.length < 59) {
    errors.push(`community_district_count ${committed.community_districts?.length}`);
  }
  if (!Array.isArray(committed.council_districts) || committed.council_districts.length < 50) {
    errors.push(`council_district_count ${committed.council_districts?.length}`);
  }
  if (!existsSync(WORKER_UNIFIED)) errors.push("missing worker unified twin");
  else {
    const worker = JSON.parse(readFileSync(WORKER_UNIFIED, "utf8"));
    if (worker.boundary_vintage !== committed.boundary_vintage) {
      errors.push("worker unified vintage drift");
    }
    if (worker.community_district_count !== committed.community_district_count) {
      errors.push("worker community count drift");
    }
  }
  if (!existsSync(SITE_COUNCIL)) errors.push("missing council-only site twin");
  else {
    const council = JSON.parse(readFileSync(SITE_COUNCIL, "utf8"));
    if (!council.boundary_vintage) errors.push("council-only missing boundary_vintage");
    if (council.district_count !== committed.council_district_count) {
      errors.push("council-only count drift");
    }
  }
  if (!existsSync(WORKER_COUNCIL)) errors.push("missing worker council twin");
  return { errors, committed };
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const fixture = argv.includes("--fixture");

  if (check) {
    const { errors } = checkLayer();
    if (errors.length) {
      console.error(`district boundaries check failed: ${errors.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("district boundaries: OK");
    return;
  }

  const unified = fixture ? fixtureLayer() : await buildFromOpenData();
  writeLayer(unified);
  console.log(
    `wrote ${SITE_UNIFIED} (+ worker twin, council-only twins): `
    + `${unified.community_district_count} community + ${unified.council_district_count} council, `
    + `vintage ${unified.boundary_vintage}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_district_boundaries.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export {
  SCHEMA_V1,
  SITE_UNIFIED,
  WORKER_UNIFIED,
  buildFromOpenData,
  communityIdFromBoroCd,
  councilOnlyLayer,
  fixtureLayer,
  writeLayer,
};
