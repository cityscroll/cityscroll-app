#!/usr/bin/env node
// Build/check the first four backstage-only geography-spine layers. Source
// acquisition is explicit: DCP archives are converted to WGS84 GeoJSON by the
// operator, while Socrata exports stay source-native. The committed receipt
// preserves both the fetched bytes and normalized-input fingerprints.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CIVIC_GEOGRAPHY_LAYERS,
  GEOGRAPHY_LAYER_REGISTRY_SCHEMA,
  validateCivicGeographyRegistry,
} from "../site/civic_geography_registry.mjs";
import { checkLayer } from "./build_district_boundaries.mjs";
import {
  buildGeographyLayer,
  jsonText,
  sha256Text,
} from "./lib/geography_layer_builder.mjs";
import {
  normalizeBusinessImprovementDistrictSource,
  normalizeNta2020Source,
  normalizePolicePrecinctSource,
  normalizeSanitationDistrictSource,
} from "./lib/civic_geography_source_adapters.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_REGISTRY = join(ROOT, "site/data/geography/layer_registry.json");
const WORKER_REGISTRY = join(ROOT, "worker/src/data/geography/layer_registry.json");
const REVIEWED_BID_IDS = join(ROOT, "ontology/geography/bid_reviewed_ids.json");
const FIRST_FOUR = Object.freeze([
  "nta2020",
  "police_precinct",
  "sanitation_district",
  "business_improvement_district",
]);

const SOURCE_SPECS = Object.freeze({
  nta2020: {
    dataset_id: "nynta2020_26b",
    dataset_name: "2020 Neighborhood Tabulation Areas",
    source_url: "https://s-media.nyc.gov/agencies/dcp/assets/files/zip/data-tools/bytes/neighborhood-tabulation-areas/nynta2020_26b.zip",
    boundary_vintage: "26B",
    source_updated_at: "2026-05-04T00:00:00.000Z",
    input: "nta.geojson",
    acquisition: "nynta2020_26b.zip",
  },
  police_precinct: {
    dataset_id: "nypp_26b",
    dataset_name: "Police Precincts",
    source_url: "https://s-media.nyc.gov/agencies/dcp/assets/files/zip/data-tools/bytes/police-precincts/nypp_26b.zip",
    boundary_vintage: "26B",
    source_updated_at: "2026-05-04T00:00:00.000Z",
    input: "pp.geojson",
    acquisition: "nypp_26b.zip",
  },
  sanitation_district: {
    dataset_id: "i6mn-amj2",
    dataset_name: "DSNY Districts",
    source_url: "https://data.cityofnewyork.us/resource/i6mn-amj2.geojson?$limit=100",
    boundary_vintage: "2024-04-10",
    source_updated_at: "2024-04-10T10:00:05.000Z",
    input: "dsny.geojson",
    acquisition: "dsny.geojson",
  },
  business_improvement_district: {
    dataset_id: "7jdm-inj8",
    dataset_name: "Business Improvement Districts",
    source_url: "https://data.cityofnewyork.us/resource/7jdm-inj8.geojson?$limit=500",
    boundary_vintage: "2024-10-08",
    source_updated_at: "2024-10-08T15:54:16.000Z",
    input: "bid.geojson",
    acquisition: "bid.geojson",
  },
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function definition(type) {
  const found = CIVIC_GEOGRAPHY_LAYERS.find((row) => row.type === type);
  if (!found) throw new Error(`unregistered geography layer ${type}`);
  return found;
}

function buildPair(type, sourceMeta, features, builtAt) {
  const registered = definition(type);
  return {
    full: buildGeographyLayer({
      definition: registered,
      sourceMeta,
      normalizedFeatures: features,
      fidelity: "full",
      builtAt,
    }),
    simplified: buildGeographyLayer({
      definition: registered,
      sourceMeta,
      normalizedFeatures: features,
      fidelity: "simplified",
      builtAt,
    }),
  };
}

export function buildFirstFourLayers({ sources, reviewedBidIds, builtAt }) {
  const bid = normalizeBusinessImprovementDistrictSource(
    sources.business_improvement_district,
    reviewedBidIds,
  );
  const normalized = {
    nta2020: normalizeNta2020Source(sources.nta2020),
    police_precinct: normalizePolicePrecinctSource(sources.police_precinct),
    sanitation_district: normalizeSanitationDistrictSource(sources.sanitation_district),
    business_improvement_district: bid.features,
  };
  const pairs = Object.fromEntries(FIRST_FOUR.map((type) => [
    type,
    buildPair(type, SOURCE_SPECS[type], normalized[type], builtAt),
  ]));
  return {
    pairs,
    diagnostics: {
      business_improvement_district: {
        rejections: bid.rejections,
        identity_field_rejections: bid.identity_field_rejections,
      },
    },
  };
}

function versionSegment(value) {
  return String(value).replace(/[^0-9A-Za-z._-]/g, "-");
}

function artifactPaths(type, vintage) {
  const version = versionSegment(vintage);
  return {
    full: `data/geography/layers/${type}/${version}.full.json`,
    site: `site/data/geography/layers/${type}/${version}.json`,
    worker: `worker/src/data/geography/layers/${type}/${version}.json`,
    receipt: `data/geography/receipts/${type}/${version}.json`,
  };
}

function registryRow(registered, pair, receiptPath) {
  const paths = artifactPaths(registered.type, pair.full.vintage.id);
  const fullText = jsonText(pair.full);
  const simplifiedText = jsonText(pair.simplified);
  const receiptText = readFileSync(join(ROOT, receiptPath), "utf8");
  return {
    type: registered.type,
    class: registered.class,
    namespace: registered.namespace,
    canonical_id: registered.canonical_id,
    label: registered.label,
    source: pair.full.source,
    boundary_vintage: pair.full.vintage.id,
    cardinality: registered.cardinality,
    ...(registered.subtypes ? { subtypes: registered.subtypes } : {}),
    coverage: pair.full.coverage,
    freshness: registered.freshness,
    public_relations: registered.public_relations,
    declared_uses: registered.declared_uses,
    receipt: {
      path: receiptPath,
      sha256: sha256Text(receiptText),
    },
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
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function sourceReceipt(type, pair, spec, sourceFiles, diagnostics, builtAt) {
  const acquisition = readFileSync(sourceFiles.acquisition);
  const input = readFileSync(sourceFiles.input);
  const paths = artifactPaths(type, pair.full.vintage.id);
  const fullText = jsonText(pair.full);
  const simplifiedText = jsonText(pair.simplified);
  const rejected = diagnostics?.rejections || [];
  return {
    schema: "cityscroll.geography_ingestion_receipt.v1",
    type,
    acquired_at: builtAt,
    boundary_vintage: pair.full.vintage.id,
    source: {
      contract_id: pair.full.source.contract_id,
      publisher: pair.full.source.publisher,
      dataset_id: spec.dataset_id,
      url: spec.source_url,
      publisher_updated_at: spec.source_updated_at,
      sha256: hashBytes(acquisition),
      bytes: acquisition.byteLength,
      source_feature_count: pair.full.feature_count + rejected.length,
    },
    normalized_input: {
      format: "GeoJSON",
      crs: "EPSG:4326",
      sha256: hashBytes(input),
      bytes: input.byteLength,
      ...(type === "nta2020" || type === "police_precinct"
        ? { conversion: "ogr2ogr source EPSG:2263 to EPSG:4326" }
        : {}),
    },
    admission: {
      accepted_feature_count: pair.full.feature_count,
      rejected_feature_count: rejected.length,
      rejected_features: rejected,
      ...(diagnostics?.identity_field_rejections
        ? { rejected_identity_fields: diagnostics.identity_field_rejections }
        : {}),
    },
    artifacts: {
      full: { path: paths.full, sha256: sha256Text(fullText), geometry_fidelity: "full" },
      simplified: {
        site_path: paths.site,
        worker_path: paths.worker,
        sha256: sha256Text(simplifiedText),
        geometry_fidelity: "simplified",
      },
    },
    qa: {
      point_canaries: "data/geography/qa/first_four_point_canaries.json",
      pluto_cross_checks: "data/geography/qa/first_four_pluto_cross_checks.json",
      moda_oracle: "data/geography/oracles/moda-v2025.09.29.json",
    },
  };
}

function sourcesFromDirectory(sourceDir) {
  const sources = {};
  const files = {};
  for (const type of FIRST_FOUR) {
    const spec = SOURCE_SPECS[type];
    const input = join(sourceDir, spec.input);
    const acquisition = join(sourceDir, spec.acquisition);
    if (!existsSync(input)) throw new Error(`${type}: missing normalized source ${input}`);
    if (!existsSync(acquisition)) throw new Error(`${type}: missing acquisition bytes ${acquisition}`);
    sources[type] = readJson(input);
    files[type] = { input, acquisition };
  }
  return { sources, files };
}

export function writeFirstFour({ sourceDir, builtAt }) {
  const { sources, files } = sourcesFromDirectory(sourceDir);
  const reviewedBidIds = readJson(REVIEWED_BID_IDS);
  const built = buildFirstFourLayers({ sources, reviewedBidIds, builtAt });
  const committedRegistry = readJson(SITE_REGISTRY);
  const existing = new Map((committedRegistry.layers || []).map((row) => [row.type, row]));
  const rows = new Map(existing);

  for (const type of FIRST_FOUR) {
    const pair = built.pairs[type];
    const paths = artifactPaths(type, pair.full.vintage.id);
    const receipt = sourceReceipt(
      type,
      pair,
      SOURCE_SPECS[type],
      files[type],
      built.diagnostics[type],
      builtAt,
    );
    writeText(join(ROOT, paths.full), jsonText(pair.full));
    writeText(join(ROOT, paths.site), jsonText(pair.simplified));
    writeText(join(ROOT, paths.worker), jsonText(pair.simplified));
    writeText(join(ROOT, paths.receipt), jsonText(receipt, { pretty: true }));
    rows.set(type, registryRow(definition(type), pair, paths.receipt));
  }

  const registry = {
    schema: GEOGRAPHY_LAYER_REGISTRY_SCHEMA,
    generated_at: builtAt,
    layers: CIVIC_GEOGRAPHY_LAYERS.map((registered) => rows.get(registered.type)),
  };
  const missing = CIVIC_GEOGRAPHY_LAYERS.filter((registered) => !rows.get(registered.type));
  if (missing.length) throw new Error(`missing existing geography layers: ${missing.map((row) => row.type).join(", ")}`);
  const errors = validateCivicGeographyRegistry(registry);
  if (errors.length) throw new Error(errors.join("; "));
  const registryText = jsonText(registry, { pretty: true });
  writeText(SITE_REGISTRY, registryText);
  writeText(WORKER_REGISTRY, registryText);
  return registry;
}

function checkFirstFour(types = FIRST_FOUR) {
  const errors = [...checkLayer().errors];
  const registry = readJson(SITE_REGISTRY);
  for (const type of types) {
    const row = registry.layers.find((candidate) => candidate.type === type);
    if (!row) {
      errors.push(`${type}: missing registry projection`);
      continue;
    }
    if ((row.public_relations || []).length) errors.push(`${type}: ingestion-only layer declares public relations`);
    if (!row.receipt?.path || !existsSync(join(ROOT, row.receipt.path))) {
      errors.push(`${type}: missing acquisition receipt`);
      continue;
    }
    const receiptText = readFileSync(join(ROOT, row.receipt.path), "utf8");
    if (sha256Text(receiptText) !== row.receipt.sha256) errors.push(`${type}: receipt fingerprint mismatch`);
    const receipt = JSON.parse(receiptText);
    if (receipt.boundary_vintage !== row.boundary_vintage) errors.push(`${type}: receipt vintage mismatch`);
    const fullText = readFileSync(join(ROOT, row.artifacts.full.path), "utf8");
    const simplifiedText = readFileSync(join(ROOT, row.artifacts.simplified.site_path), "utf8");
    if (sha256Text(fullText) === sha256Text(simplifiedText)) errors.push(`${type}: full/simplified geometry collapsed`);
    const full = JSON.parse(fullText);
    const ids = full.features.map((feature) => feature.id);
    if (new Set(ids).size !== ids.length) errors.push(`${type}: duplicate canonical IDs`);
    if (full.feature_count !== row.coverage.actual_feature_count) errors.push(`${type}: coverage count drift`);
  }
  return errors.sort();
}

function parseArgs(argv) {
  const options = { check: false, sourceDir: null, builtAt: null, layers: FIRST_FOUR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--source-dir") options.sourceDir = argv[++index];
    else if (arg === "--built-at") options.builtAt = argv[++index];
    else if (arg === "--layers") options.layers = argv[++index].split(",").filter(Boolean);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  for (const type of options.layers) {
    if (!FIRST_FOUR.includes(type)) throw new Error(`not a gs-03 layer: ${type}`);
  }
  if (options.check) {
    const errors = checkFirstFour(options.layers);
    if (errors.length) {
      console.error(`civic geography check failed: ${errors.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`civic geography: OK (${options.layers.length} ingestion-only layers)`);
    return;
  }
  if (!options.sourceDir) throw new Error("pass --source-dir with nta.geojson, pp.geojson, dsny.geojson, bid.geojson, and DCP archives");
  const builtAt = options.builtAt || new Date().toISOString();
  const registry = writeFirstFour({ sourceDir: resolve(options.sourceDir), builtAt });
  console.log(`wrote ${FIRST_FOUR.length} layers; registry now contains ${registry.layers.length} independent vintages`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { FIRST_FOUR, SOURCE_SPECS, checkFirstFour };
