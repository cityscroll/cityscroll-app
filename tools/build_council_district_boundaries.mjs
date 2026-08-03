#!/usr/bin/env node
// Build the committed City Council district boundary layer from NYC Open Data
// 872g-cjhh. Simplify polygons for browser-side point-in-polygon; dual-write
// site/ + worker/ data copies. No live GIS at request time.
//
//   node tools/build_council_district_boundaries.mjs
//   node tools/build_council_district_boundaries.mjs --check
//   node tools/build_council_district_boundaries.mjs --fixture   # tiny offline layer

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_OUT = join(ROOT, "site/data/council_district_boundaries.json");
const WORKER_OUT = join(ROOT, "worker/src/data/council_district_boundaries.json");
const DATASET = "872g-cjhh";
const META_URL = `https://data.cityofnewyork.us/api/views/${DATASET}.json`;
const GEO_URL = `https://data.cityofnewyork.us/resource/${DATASET}.geojson?$limit=60`;
const TOL = 0.00045;
const SCHEMA = "cityscroll.district_boundaries.v0";

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

function fixtureLayer() {
  // Elmhurst, Queens — covers the location-awareness golden point (-73.8832, 40.7473).
  // District 25 is the real council seat for that neighborhood; the ring is a tight
  // test square so unit tests stay offline.
  const ring = [
    [-73.89, 40.74],
    [-73.87, 40.74],
    [-73.87, 40.755],
    [-73.89, 40.755],
    [-73.89, 40.74],
  ];
  return {
    schema: SCHEMA,
    layer: "council_district",
    dataset_id: DATASET,
    dataset_name: "City Council Districts (fixture)",
    source_url: `https://data.cityofnewyork.us/d/${DATASET}`,
    boundary_vintage: "2026-05-26",
    source_updated_at: "2026-05-26T19:35:31.000Z",
    built_at: new Date().toISOString(),
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    district_count: 1,
    districts: [{
      id: "25",
      label: "City Council District 25",
      bbox: [-73.89, 40.74, -73.87, 40.755],
      polygons: [{ rings: [ring] }],
    }],
  };
}

async function buildFromOpenData(fetchImpl = fetch) {
  const metaRes = await fetchImpl(META_URL);
  if (!metaRes.ok) throw new Error(`council district meta HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const vintageTs = Number(meta.rowsUpdatedAt || meta.viewLastModified || 0);
  const boundary_vintage = vintageTs
    ? new Date(vintageTs * 1000).toISOString().slice(0, 10)
    : null;

  const geoRes = await fetchImpl(GEO_URL);
  if (!geoRes.ok) throw new Error(`council district geojson HTTP ${geoRes.status}`);
  const geo = await geoRes.json();
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

  const districts = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  if (districts.length < 50) {
    throw new Error(`expected ~51 council districts, got ${districts.length}`);
  }

  return {
    schema: SCHEMA,
    layer: "council_district",
    dataset_id: DATASET,
    dataset_name: meta.name || "City Council Districts",
    source_url: `https://data.cityofnewyork.us/d/${DATASET}`,
    boundary_vintage,
    source_updated_at: vintageTs ? new Date(vintageTs * 1000).toISOString() : null,
    built_at: new Date().toISOString(),
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    district_count: districts.length,
    districts,
  };
}

function serialize(layer) {
  // Stable key order is already construction order; strip volatile built_at for --check.
  return `${JSON.stringify(layer)}\n`;
}

function writeLayer(layer) {
  const text = serialize(layer);
  mkdirSync(dirname(SITE_OUT), { recursive: true });
  mkdirSync(dirname(WORKER_OUT), { recursive: true });
  writeFileSync(SITE_OUT, text);
  writeFileSync(WORKER_OUT, text);
  return text;
}

function checkLayer(layer) {
  const expected = serialize({
    ...layer,
    // Compare without built_at so a same-day rebuild does not false-fail.
    built_at: JSON.parse(readFileSync(SITE_OUT, "utf8")).built_at,
  });
  // Structure checks rather than byte-identity on full live rebuilds:
  const committed = JSON.parse(readFileSync(SITE_OUT, "utf8"));
  const errors = [];
  if (committed.schema !== SCHEMA) errors.push("schema mismatch");
  if (committed.layer !== "council_district") errors.push("layer mismatch");
  if (committed.dataset_id !== DATASET) errors.push("dataset_id mismatch");
  if (!committed.boundary_vintage) errors.push("missing boundary_vintage");
  if (!Array.isArray(committed.districts) || committed.districts.length < 50) {
    errors.push(`district_count ${committed.districts?.length}`);
  }
  if (!existsSync(WORKER_OUT)) errors.push("missing worker twin");
  else {
    const worker = JSON.parse(readFileSync(WORKER_OUT, "utf8"));
    if (worker.district_count !== committed.district_count) {
      errors.push("worker twin district_count drift");
    }
    if (worker.boundary_vintage !== committed.boundary_vintage) {
      errors.push("worker twin vintage drift");
    }
  }
  return { errors, expected, committed };
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const fixture = argv.includes("--fixture");

  if (check) {
    if (!existsSync(SITE_OUT)) {
      console.error("council district boundaries missing; run build without --check");
      process.exitCode = 1;
      return;
    }
    const { errors } = checkLayer(null);
    if (errors.length) {
      console.error(`council district boundaries check failed: ${errors.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("council district boundaries: OK");
    return;
  }

  const layer = fixture ? fixtureLayer() : await buildFromOpenData();
  const text = writeLayer(layer);
  console.log(`wrote ${SITE_OUT} and ${WORKER_OUT} (${text.length} bytes, ${layer.district_count} districts, vintage ${layer.boundary_vintage})`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_council_district_boundaries.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { buildFromOpenData, fixtureLayer, SITE_OUT, WORKER_OUT };
