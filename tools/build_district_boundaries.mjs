#!/usr/bin/env node
// Build the registered baseline geography layers (borough, Community District,
// City Council District) from source-native adapters. Full-fidelity geometry is
// retained for build-time overlays; simplified per-layer twins serve the site
// and Worker. The legacy combined district artifacts remain compatibility
// views with their historical conservative boundary_vintage scalar.
//
//   node tools/build_district_boundaries.mjs
//   node tools/build_district_boundaries.mjs --check
//   node tools/build_district_boundaries.mjs --fixture

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CIVIC_GEOGRAPHY_LAYERS,
  GEOGRAPHY_LAYER_REGISTRY_SCHEMA,
  validateCivicGeographyRegistry,
} from "../site/civic_geography_registry.mjs";
import {
  DEFAULT_DELIVERY_TOLERANCE_DEG,
  buildGeographyLayer,
  jsonText,
  legacyPolygonsForFeature,
  sha256Text,
} from "./lib/geography_layer_builder.mjs";
import {
  communityIdFromBoroCd,
  normalizeBoroughSource,
  normalizeCommunityDistrictSource,
  normalizeCouncilDistrictSource,
} from "./lib/district_boundary_source_adapters.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_UNIFIED = join(ROOT, "site/data/district_boundaries.json");
const WORKER_UNIFIED = join(ROOT, "worker/src/data/district_boundaries.json");
const SITE_COUNCIL = join(ROOT, "site/data/council_district_boundaries.json");
const WORKER_COUNCIL = join(ROOT, "worker/src/data/council_district_boundaries.json");
const SITE_REGISTRY = join(ROOT, "site/data/geography/layer_registry.json");
const WORKER_REGISTRY = join(ROOT, "worker/src/data/geography/layer_registry.json");

const SCHEMA_V1 = "cityscroll.district_boundaries.v1";
const SCHEMA_COUNCIL_V0 = "cityscroll.district_boundaries.v0";
const TOL = DEFAULT_DELIVERY_TOLERANCE_DEG;

const COMMUNITY = Object.freeze({
  id: "community_district",
  dataset_id: "5crt-au7u",
  name: "Community Districts",
  meta_url: "https://data.cityofnewyork.us/api/views/5crt-au7u.json",
  geo_url: "https://data.cityofnewyork.us/resource/5crt-au7u.geojson?$limit=100",
  source_url: "https://data.cityofnewyork.us/d/5crt-au7u",
});

const COUNCIL = Object.freeze({
  id: "council_district",
  dataset_id: "872g-cjhh",
  name: "City Council Districts",
  meta_url: "https://data.cityofnewyork.us/api/views/872g-cjhh.json",
  geo_url: "https://data.cityofnewyork.us/resource/872g-cjhh.geojson?$limit=60",
  source_url: "https://data.cityofnewyork.us/d/872g-cjhh",
});

function vintageFromMeta(meta) {
  const timestamp = Number(meta.rowsUpdatedAt || meta.viewLastModified || 0);
  if (!timestamp) return { boundary_vintage: null, source_updated_at: null };
  return {
    boundary_vintage: new Date(timestamp * 1000).toISOString().slice(0, 10),
    source_updated_at: new Date(timestamp * 1000).toISOString(),
  };
}

async function fetchSourceMeta(spec, fetchImpl) {
  const response = await fetchImpl(spec.meta_url);
  if (!response.ok) throw new Error(`${spec.id} meta HTTP ${response.status}`);
  const meta = await response.json();
  return {
    dataset_id: spec.dataset_id,
    dataset_name: meta.name || spec.name,
    source_url: spec.source_url,
    ...vintageFromMeta(meta),
  };
}

async function fetchGeojson(spec, fetchImpl) {
  const response = await fetchImpl(spec.geo_url);
  if (!response.ok) throw new Error(`${spec.id} geojson HTTP ${response.status}`);
  return response.json();
}

function definition(type) {
  const found = CIVIC_GEOGRAPHY_LAYERS.find((row) => row.type === type);
  if (!found) throw new Error(`unregistered geography layer ${type}`);
  return found;
}

function buildLayerPair(type, sourceMeta, normalizedFeatures, builtAt) {
  const registered = definition(type);
  return {
    full: buildGeographyLayer({
      definition: registered,
      sourceMeta,
      normalizedFeatures,
      fidelity: "full",
      builtAt,
      deliveryTolerance: TOL,
    }),
    simplified: buildGeographyLayer({
      definition: registered,
      sourceMeta,
      normalizedFeatures,
      fidelity: "simplified",
      builtAt,
      deliveryTolerance: TOL,
    }),
  };
}

export function buildGeographyBundle({
  communityMeta,
  councilMeta,
  communityGeo,
  councilGeo,
  builtAt,
  allowIncomplete = false,
}) {
  const communityFeatures = normalizeCommunityDistrictSource(communityGeo);
  const councilFeatures = normalizeCouncilDistrictSource(councilGeo);
  const boroughFeatures = normalizeBoroughSource(communityFeatures);
  const layers = {
    borough: buildLayerPair("borough", communityMeta, boroughFeatures, builtAt),
    community_district: buildLayerPair("community_district", communityMeta, communityFeatures, builtAt),
    council_district: buildLayerPair("council_district", councilMeta, councilFeatures, builtAt),
  };
  for (const [type, pair] of Object.entries(layers)) {
    if (!allowIncomplete
      && (pair.full.coverage.status !== "complete" || pair.simplified.coverage.status !== "complete")) {
      throw new Error(`${type}: source coverage is ${pair.full.coverage.status}`);
    }
  }
  const unified = compatibilityDistrictLayer(layers, builtAt);
  return { builtAt, layers, unified, council: councilOnlyLayer(unified) };
}

function minVintage(...values) {
  const present = values.filter(Boolean).map(String).sort();
  return present[0] || null;
}

function compatibilitySource(layer) {
  return {
    dataset_id: layer.source.dataset_id,
    dataset_name: layer.source.dataset_name,
    source_url: layer.source.url,
    boundary_vintage: layer.vintage.id,
    source_updated_at: layer.source.updated_at,
  };
}

function compatibilityFeature(feature, type) {
  return {
    id: feature.id,
    ...(type === "community_district"
      ? { boro_cd: String(feature.source_properties?.boro_cd || "") }
      : {}),
    label: feature.label,
    bbox: feature.bbox,
    polygons: legacyPolygonsForFeature(feature),
  };
}

/** Temporary combined view; only this compatibility shape collapses clocks. */
export function compatibilityDistrictLayer(layers, builtAt) {
  const community = layers.community_district.simplified;
  const council = layers.council_district.simplified;
  const communityDistricts = community.features.map((feature) => compatibilityFeature(feature, community.type));
  const councilDistricts = council.features.map((feature) => compatibilityFeature(feature, council.type));
  return {
    schema: SCHEMA_V1,
    boundary_vintage: minVintage(community.vintage.id, council.vintage.id),
    sources: {
      community_district: compatibilitySource(community),
      council_district: compatibilitySource(council),
    },
    built_at: builtAt,
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    community_district_count: communityDistricts.length,
    council_district_count: councilDistricts.length,
    community_districts: communityDistricts,
    council_districts: councilDistricts,
  };
}

/** Council-only v0 twin retained for older request paths. */
export function councilOnlyLayer(unified) {
  const source = unified.sources?.council_district || {};
  return {
    schema: SCHEMA_COUNCIL_V0,
    layer: "council_district",
    dataset_id: source.dataset_id || COUNCIL.dataset_id,
    dataset_name: source.dataset_name || COUNCIL.name,
    source_url: source.source_url || COUNCIL.source_url,
    boundary_vintage: source.boundary_vintage || unified.boundary_vintage,
    source_updated_at: source.source_updated_at || null,
    built_at: unified.built_at,
    crs: "EPSG:4326",
    simplify_tolerance_deg: TOL,
    district_count: unified.council_district_count,
    districts: unified.council_districts,
  };
}

function artifactPaths(type, vintage) {
  const version = String(vintage).replace(/[^0-9A-Za-z._-]/g, "-");
  return {
    full: `data/geography/layers/${type}/${version}.full.json`,
    site: `site/data/geography/layers/${type}/${version}.json`,
    worker: `worker/src/data/geography/layers/${type}/${version}.json`,
  };
}

function registryForBundle(bundle) {
  return {
    schema: GEOGRAPHY_LAYER_REGISTRY_SCHEMA,
    generated_at: bundle.builtAt,
    layers: CIVIC_GEOGRAPHY_LAYERS.map((registered) => {
      const pair = bundle.layers[registered.type];
      const paths = artifactPaths(registered.type, pair.full.vintage.id);
      const fullText = jsonText(pair.full);
      const simplifiedText = jsonText(pair.simplified);
      return {
        type: registered.type,
        class: registered.class,
        namespace: registered.namespace,
        canonical_id: registered.canonical_id,
        label: registered.label,
        source: pair.full.source,
        boundary_vintage: pair.full.vintage.id,
        cardinality: registered.cardinality,
        coverage: pair.full.coverage,
        freshness: registered.freshness,
        public_relations: registered.public_relations,
        declared_uses: registered.declared_uses,
        artifacts: {
          full: {
            path: paths.full,
            sha256: sha256Text(fullText),
            bytes: Buffer.byteLength(fullText),
            geometry_fidelity: "full",
          },
          simplified: {
            site_path: paths.site,
            worker_path: paths.worker,
            sha256: sha256Text(simplifiedText),
            bytes: Buffer.byteLength(simplifiedText),
            geometry_fidelity: "simplified",
          },
        },
      };
    }),
  };
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path, value, options) {
  const text = jsonText(value, options);
  writeText(path, text);
  return text;
}

/** Compatibility-only writer retained for callers that already hold v1. */
export function writeLayer(unified) {
  const council = councilOnlyLayer(unified);
  writeJson(SITE_UNIFIED, unified);
  writeJson(WORKER_UNIFIED, unified);
  writeJson(SITE_COUNCIL, council);
  writeJson(WORKER_COUNCIL, council);
  return { unified, council };
}

export function writeGeographyBundle(bundle) {
  const registry = registryForBundle(bundle);
  for (const row of registry.layers) {
    const pair = bundle.layers[row.type];
    writeJson(join(ROOT, row.artifacts.full.path), pair.full);
    writeJson(join(ROOT, row.artifacts.simplified.site_path), pair.simplified);
    writeJson(join(ROOT, row.artifacts.simplified.worker_path), pair.simplified);
  }
  writeJson(SITE_REGISTRY, registry, { pretty: true });
  writeJson(WORKER_REGISTRY, registry, { pretty: true });
  writeLayer(bundle.unified);
  return { ...bundle, registry };
}

function fixtureSources() {
  const ring = [
    [-73.89, 40.74],
    [-73.87, 40.74],
    [-73.87, 40.755],
    [-73.89, 40.755],
    [-73.89, 40.74],
  ];
  const meta = (spec) => ({
    dataset_id: spec.dataset_id,
    dataset_name: `${spec.name} (fixture)`,
    source_url: spec.source_url,
    boundary_vintage: "2026-05-26",
    source_updated_at: "2026-05-26T19:35:31.000Z",
  });
  return {
    communityMeta: meta(COMMUNITY),
    councilMeta: meta(COUNCIL),
    communityGeo: {
      type: "FeatureCollection",
      features: [{ properties: { boro_cd: "404" }, geometry: { type: "Polygon", coordinates: [ring] } }],
    },
    councilGeo: {
      type: "FeatureCollection",
      features: [{ properties: { coundist: "25" }, geometry: { type: "Polygon", coordinates: [ring] } }],
    },
  };
}

export function fixtureBundle() {
  return buildGeographyBundle({
    ...fixtureSources(),
    builtAt: new Date().toISOString(),
    allowIncomplete: true,
  });
}

/** Historical fixture export: return the combined compatibility view. */
export function fixtureLayer() {
  return fixtureBundle().unified;
}

export async function buildBundleFromOpenData(fetchImpl = fetch) {
  const [communityMeta, councilMeta, communityGeo, councilGeo] = await Promise.all([
    fetchSourceMeta(COMMUNITY, fetchImpl),
    fetchSourceMeta(COUNCIL, fetchImpl),
    fetchGeojson(COMMUNITY, fetchImpl),
    fetchGeojson(COUNCIL, fetchImpl),
  ]);
  return buildGeographyBundle({
    communityMeta,
    councilMeta,
    communityGeo,
    councilGeo,
    builtAt: new Date().toISOString(),
  });
}

/** Historical programmatic export: return the combined compatibility view. */
export async function buildFromOpenData(fetchImpl = fetch) {
  return (await buildBundleFromOpenData(fetchImpl)).unified;
}

function readText(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function checkLayer() {
  const errors = [];
  if (!existsSync(SITE_UNIFIED)) return { errors: ["missing site/data/district_boundaries.json"] };
  const committed = JSON.parse(readFileSync(SITE_UNIFIED, "utf8"));
  if (committed.schema !== SCHEMA_V1) errors.push("compatibility schema mismatch");
  if (!committed.boundary_vintage) errors.push("compatibility boundary_vintage missing");
  if (!committed.sources?.community_district?.boundary_vintage) errors.push("community source vintage missing");
  if (!committed.sources?.council_district?.boundary_vintage) errors.push("council source vintage missing");
  if ((committed.community_districts || []).length < 59) errors.push("community compatibility coverage incomplete");
  if ((committed.council_districts || []).length !== 51) errors.push("council compatibility coverage incomplete");
  if (!existsSync(WORKER_UNIFIED) || readFileSync(WORKER_UNIFIED, "utf8") !== readFileSync(SITE_UNIFIED, "utf8")) {
    errors.push("worker unified twin drift");
  }
  if (!existsSync(SITE_COUNCIL) || !existsSync(WORKER_COUNCIL)) errors.push("council-only twin missing");
  else if (readFileSync(SITE_COUNCIL, "utf8") !== readFileSync(WORKER_COUNCIL, "utf8")) errors.push("council-only twin drift");

  if (!existsSync(SITE_REGISTRY)) return { errors: [...errors, "missing geography layer registry"], committed };
  const registryText = readFileSync(SITE_REGISTRY, "utf8");
  const registry = JSON.parse(registryText);
  errors.push(...validateCivicGeographyRegistry(registry));
  if (!existsSync(WORKER_REGISTRY) || readFileSync(WORKER_REGISTRY, "utf8") !== registryText) {
    errors.push("worker geography registry twin drift");
  }
  for (const row of registry.layers || []) {
    for (const [fidelity, path] of [
      ["full", row.artifacts?.full?.path],
      ["simplified", row.artifacts?.simplified?.site_path],
    ]) {
      if (!path || !existsSync(join(ROOT, path))) {
        errors.push(`${row.type}: missing ${fidelity} artifact`);
        continue;
      }
      const text = readText(path);
      const layer = JSON.parse(text);
      if (layer.type !== row.type || layer.class !== row.class) errors.push(`${row.type}: artifact identity mismatch`);
      if (layer.geometry_fidelity !== fidelity) errors.push(`${row.type}: ${fidelity} fidelity mismatch`);
      if (layer.vintage?.id !== row.boundary_vintage) errors.push(`${row.type}: artifact vintage mismatch`);
      if (layer.coverage?.status !== "complete") errors.push(`${row.type}: artifact coverage incomplete`);
      const expectedHash = fidelity === "full" ? row.artifacts.full.sha256 : row.artifacts.simplified.sha256;
      if (sha256Text(text) !== expectedHash) errors.push(`${row.type}: ${fidelity} fingerprint mismatch`);
    }
    const workerPath = row.artifacts?.simplified?.worker_path;
    const sitePath = row.artifacts?.simplified?.site_path;
    if (!workerPath || !existsSync(join(ROOT, workerPath)) || readText(workerPath) !== readText(sitePath)) {
      errors.push(`${row.type}: worker simplified twin drift`);
    }
  }
  const expectedCompatVintage = minVintage(
    registry.layers?.find((row) => row.type === "community_district")?.boundary_vintage,
    registry.layers?.find((row) => row.type === "council_district")?.boundary_vintage,
  );
  if (committed.boundary_vintage !== expectedCompatVintage) errors.push("compatibility vintage view drift");
  return { errors: errors.sort(), committed, registry };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--check")) {
    const { errors, registry } = checkLayer();
    if (errors.length) {
      console.error(`district boundaries check failed: ${errors.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`district boundaries: OK (${registry.layers.length} registered layers, independent vintages)`);
    return;
  }
  const bundle = argv.includes("--fixture") ? fixtureBundle() : await buildBundleFromOpenData();
  const written = writeGeographyBundle(bundle);
  console.log(
    `wrote ${relative(ROOT, SITE_REGISTRY)} + per-layer full/simplified artifacts; `
    + `compatibility view ${written.unified.community_district_count} community + `
    + `${written.unified.council_district_count} council, vintage ${written.unified.boundary_vintage}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_district_boundaries.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  SCHEMA_V1,
  SITE_UNIFIED,
  WORKER_UNIFIED,
  SITE_REGISTRY,
  WORKER_REGISTRY,
  communityIdFromBoroCd,
  checkLayer,
};
