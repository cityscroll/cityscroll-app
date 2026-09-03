#!/usr/bin/env node
/**
 * Materialize a bounded BBL -> MapPLUTO parcel-polygon lookup, restricted to
 * the exact single-BBL Land project candidates (LM-17).
 *
 * Build-time only, same publisher/endpoint as the existing centroid builder.
 * Resident Land reads never call ArcGIS; the browser only ever sees the
 * committed geometry projection built from this retained lookup.
 *
 * Usage:
 *   node tools/build_land_project_geometry_source.mjs --from-arcgis
 *   node tools/build_land_project_geometry_source.mjs --check
 *   node tools/build_land_project_geometry_source.mjs --fixture
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION,
  LAND_PROJECT_GEOMETRY_MAX_AGE_DAYS,
  assertLandParcelGeometrySource,
  singleBblGeometryCandidates,
} from "../site/land_project_geometry.mjs";
import { normalizeBbl } from "../site/bbl_mappluto_centroids.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = path.join(ROOT, "site", "data", "land_project_geometry_source_lookup.json");
const LAND_DEFAULT = path.join(ROOT, "site", "data", "land_default_ulurp.json");
const BBL_LOOKUP = path.join(ROOT, "site", "data", "zap_bbl_warehouse_lookup.json");
const MAPPLUTO_QUERY =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";

function parseArgs(argv) {
  const out = { check: false, fixture: false, fromArcgis: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else if (arg === "--fixture") out.fixture = true;
    else if (arg === "--from-arcgis") out.fromArcgis = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function candidateBbls() {
  const landDefault = readJson(LAND_DEFAULT);
  const zapBbl = readJson(BBL_LOOKUP);
  const candidates = singleBblGeometryCandidates({ landDefault, zapBbl });
  return [...new Set(candidates.values())].sort();
}

async function fetchArcgisGeometry(bbls) {
  const where = `BBL IN (${bbls.map((bbl) => String(Number(bbl))).join(",")})`;
  const url = new URL(MAPPLUTO_QUERY);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "BBL,Shape__Area");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("geometryPrecision", "6");
  url.searchParams.set("resultRecordCount", String(Math.max(bbls.length, 1)));
  url.searchParams.set("f", "json");
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "cityscroll-land-project-geometry/1.0" },
  });
  if (!response.ok) throw new Error(`MapPLUTO ArcGIS HTTP ${response.status} for ${bbls.length} BBLs`);
  const body = await response.json();
  if (body?.error) throw new Error(`MapPLUTO ArcGIS error: ${JSON.stringify(body.error)}`);
  const byBbl = Object.create(null);
  for (const feature of body?.features || []) {
    const bbl = normalizeBbl(feature?.attributes?.BBL);
    const rings = feature?.geometry?.rings;
    if (!bbl || !Array.isArray(rings)) continue;
    byBbl[bbl] = { rings, source_area: Number(feature?.attributes?.Shape__Area) || null };
  }
  return byBbl;
}

function fixtureGeometry(bbls) {
  // Stable single-lot rectangle fixtures for offline CI; not for production serve.
  const byBbl = Object.create(null);
  for (const bbl of bbls) {
    // Small deterministic square keyed off the BBL so fixtures stay distinct.
    const seed = Number(bbl.slice(-4)) % 90;
    const lon = -73.95 - seed * 0.001;
    const lat = 40.7 + seed * 0.001;
    byBbl[bbl] = {
      rings: [[
        [lon, lat],
        [lon + 0.0003, lat],
        [lon + 0.0003, lat + 0.0003],
        [lon, lat + 0.0003],
        [lon, lat],
      ]],
      source_area: 900,
    };
  }
  return byBbl;
}

function buildDoc({ byBbl, mode, materializedAt }) {
  return {
    schema_version: LAND_PARCEL_GEOMETRY_SOURCE_SCHEMA_VERSION,
    source: { publisher: "NYC Department of City Planning MapPLUTO/PLUTO" },
    mode,
    materialized_at: materializedAt,
    max_age_days: LAND_PROJECT_GEOMETRY_MAX_AGE_DAYS,
    replaces_live_fetch: {
      resident: "site/land_project_geometry.mjs",
      description:
        "Committed MapPLUTO parcel polygons for the exact single-BBL Land geometry candidates; no live ArcGIS on resident reads",
    },
    bbl_count: Object.keys(byBbl).length,
    by_bbl: byBbl,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if ([args.check, args.fixture, args.fromArcgis].filter(Boolean).length > 1) {
    throw new Error("Pass exactly one of --check, --fixture, --from-arcgis");
  }

  const wanted = candidateBbls();

  if (args.check) {
    assert.ok(existsSync(OUT_SITE), `${path.relative(ROOT, OUT_SITE)} missing`);
    const committed = readJson(OUT_SITE);
    assertLandParcelGeometrySource(committed, { candidateBbls: wanted });
    console.log(
      `ok serve-gate ${path.relative(ROOT, OUT_SITE)} candidates=${wanted.length} bbls=${committed.bbl_count}`,
    );
    return;
  }

  const byBbl = args.fixture ? fixtureGeometry(wanted) : await fetchArcgisGeometry(wanted);
  const doc = buildDoc({
    byBbl,
    mode: args.fixture ? "fixture" : "mappluto_arcgis_batch",
    materializedAt: new Date().toISOString(),
  });

  if (!args.fixture) {
    assertLandParcelGeometrySource(doc, { candidateBbls: wanted });
  }

  mkdirSync(path.dirname(OUT_SITE), { recursive: true });
  const rendered = stableStringify(doc);
  writeFileSync(OUT_SITE, rendered);
  console.log(
    `wrote ${path.relative(ROOT, OUT_SITE)} (${Buffer.byteLength(rendered)} bytes) ` +
      `mode=${doc.mode} candidates=${wanted.length} matched=${doc.bbl_count}`,
  );
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
