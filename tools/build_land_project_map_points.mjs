#!/usr/bin/env node
/**
 * Materialize the bounded Land project-location projection.
 *
 * Usage:
 *   node tools/build_land_project_map_points.mjs
 *   node tools/build_land_project_map_points.mjs --check
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLandProjectMapPoints,
  LAND_PROJECT_MAP_POINTS_MAX_BYTES,
  materializeLandProjectMapPoints,
} from "../site/land_project_map_points.mjs";
import {
  LAND_PROJECT_GEOMETRY_SHARD_DIR,
  landProjectGeometryShardFindings,
  landProjectGeometryShardPath,
  materializeLandProjectGeometry,
  partitionLandProjectGeometryShards,
} from "../site/land_project_geometry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAYLOAD_JSON = "site/data/land_project_map_points.json";
export const RECEIPT_JSON = "site/data/land_project_map_points_receipt.json";
export const GEOMETRY_SHARD_DIR = LAND_PROJECT_GEOMETRY_SHARD_DIR;

const LAND_CATALOG = "site/data/land_project_catalog.json";
const LAND_DEFAULT = "site/data/land_default_ulurp.json";
const ZAP_BBL = "site/data/zap_bbl_warehouse_lookup.json";
const MAPPLUTO = "site/data/bbl_mappluto_centroids_lookup.json";
const GEOMETRY_SOURCE = "site/data/land_project_geometry_source_lookup.json";

function readJsonIfPresent(filePath) {
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : {};
}

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function sha256File(root, relativePath) {
  return createHash("sha256").update(readFileSync(path.join(root, relativePath))).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function shardTextsFromPartition(shards) {
  const out = {};
  for (const key of Object.keys(shards).sort()) {
    out[key] = stableStringify(shards[key]);
  }
  return out;
}

function listCommittedShardKeys(root) {
  const dir = path.join(root, GEOMETRY_SHARD_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[0-9a-f]{2}\.json$/.test(name))
    .map((name) => name.slice(0, 2))
    .sort();
}

/**
 * Runtime observation of the catalog generation the geography (map-points)
 * builder loads through its real input path.
 *
 * @param {string} [root]
 * @param {{ catalog?: object }} [opts] — optional catalog override for positive controls
 */
export function observeLandCatalogGenerationFromMapPointsBuilder(root = ROOT, opts = {}) {
  const catalogPath = path.join(root, LAND_CATALOG);
  if (!opts.catalog && !existsSync(catalogPath)) {
    throw new Error(`${LAND_CATALOG} missing; run node tools/build_land_project_catalog.mjs`);
  }
  const catalog = opts.catalog || JSON.parse(readFileSync(catalogPath, "utf8"));
  // An injected catalog (positive control) must not be checked against the
  // committed defaults snapshot — seed defaults from the same population.
  const landDefault = opts.catalog
    ? { projects: Array.isArray(opts.catalog.projects) ? opts.catalog.projects : [] }
    : (existsSync(path.join(root, LAND_DEFAULT))
      ? JSON.parse(readFileSync(path.join(root, LAND_DEFAULT), "utf8"))
      : { projects: [] });
  const built = materializeLandProjectMapPoints({
    catalog,
    landDefault,
    zapBbl: { rows: [] },
    mapplutoCentroids: { by_bbl: {} },
    artifactHashes: opts.catalog
      ? {}
      : { land_project_catalog: sha256File(root, LAND_CATALOG) },
  });
  const vintage = built.receipt?.inputs?.land_project_catalog?.vintage || {};
  return {
    consumer: "geography_builder",
    identity: {
      content_id: vintage.content_id || null,
      source_dates: {
        warehouse_materialized_at: vintage.warehouse_materialized_at || null,
        defaults_generated_at: vintage.defaults_generated_at || null,
      },
    },
    receipt: built.receipt,
  };
}

export function buildLandProjectMapPointsFromRepo(root = ROOT) {
  const catalogPath = path.join(root, LAND_CATALOG);
  if (!existsSync(catalogPath)) {
    throw new Error(`${LAND_CATALOG} missing; run node tools/build_land_project_catalog.mjs`);
  }
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const landDefault = JSON.parse(readFileSync(path.join(root, LAND_DEFAULT), "utf8"));
  const zapBbl = JSON.parse(readFileSync(path.join(root, ZAP_BBL), "utf8"));
  const mapplutoCentroids = JSON.parse(readFileSync(path.join(root, MAPPLUTO), "utf8"));
  const artifactHashes = {
    land_project_catalog: sha256File(root, LAND_CATALOG),
    land_default: sha256File(root, LAND_DEFAULT),
    zap_bbl: sha256File(root, ZAP_BBL),
    mappluto_centroids: sha256File(root, MAPPLUTO),
  };

  // Pass 1: which projects get an accepted point at all. Geometry never
  // influences that decision -- it can only ride on a point pass 1 already accepted.
  const pass1 = materializeLandProjectMapPoints({
    catalog,
    landDefault,
    zapBbl,
    mapplutoCentroids,
    artifactHashes,
  });
  const mappedProjectIds = Object.keys(pass1.payload.points);

  const geometrySource = readJsonIfPresent(path.join(root, GEOMETRY_SOURCE));
  const { payload: geometryPayload } = materializeLandProjectGeometry({
    catalog,
    landDefault,
    zapBbl,
    geometrySource,
    mappedProjectIds,
  });
  const geometryByProject = new Map(Object.entries(geometryPayload.shapes));
  const geometryShards = partitionLandProjectGeometryShards(geometryPayload.shapes, {
    generationId: catalog.generation?.content_id || null,
  });
  const geometryShardTexts = shardTextsFromPartition(geometryShards);

  // Pass 2: the same points, now with geometry_shard locators where an exact
  // shape exists. Lat/lon/method/precision/bbl_count stay byte-identical to pass 1.
  const { payload, receipt } = materializeLandProjectMapPoints({
    catalog,
    landDefault,
    zapBbl,
    mapplutoCentroids,
    artifactHashes,
    geometryByProject,
  });
  const payloadText = stableStringify(payload);
  const payloadBytes = Buffer.byteLength(payloadText);
  const stamped = {
    ...receipt,
    generation: {
      ...receipt.generation,
      payload_path: PAYLOAD_JSON,
      payload_bytes: payloadBytes,
      payload_sha256: sha256Text(payloadText),
      geometry_shard_dir: GEOMETRY_SHARD_DIR,
      geometry_shard_keys: Object.keys(geometryShardTexts).sort(),
      geometry_shard_count: Object.keys(geometryShardTexts).length,
    },
  };
  assertLandProjectMapPoints(payload, stamped, { payloadBytes });
  for (const [key, text] of Object.entries(geometryShardTexts)) {
    const findings = landProjectGeometryShardFindings(JSON.parse(text), { expectedKey: key });
    if (findings.length) throw new Error(`geometry shard ${key}: ${findings.join("; ")}`);
  }
  return {
    payload,
    receipt: stamped,
    payloadText,
    receiptText: stableStringify(stamped),
    geometryShards,
    geometryShardTexts,
    oversize: payloadBytes > LAND_PROJECT_MAP_POINTS_MAX_BYTES,
  };
}

function assertCommittedShards(root, geometryShardTexts) {
  const expectedKeys = Object.keys(geometryShardTexts).sort();
  const committedKeys = listCommittedShardKeys(root);
  if (committedKeys.join(",") !== expectedKeys.join(",")) {
    throw new Error(
      `${GEOMETRY_SHARD_DIR} keys drifted; expected [${expectedKeys.join(", ")}] got [${committedKeys.join(", ")}]`,
    );
  }
  for (const key of expectedKeys) {
    const relative = landProjectGeometryShardPath(key);
    const committed = readFileSync(path.join(root, relative), "utf8");
    if (committed !== geometryShardTexts[key]) {
      throw new Error(`${relative} drifted; rerun without --check`);
    }
  }
}

function writeGeometryShards(root, geometryShardTexts) {
  const dir = path.join(root, GEOMETRY_SHARD_DIR);
  mkdirSync(dir, { recursive: true });
  const expected = new Set(Object.keys(geometryShardTexts));
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/^[0-9a-f]{2}\.json$/.test(name)) continue;
    const key = name.slice(0, 2);
    if (!expected.has(key)) rmSync(path.join(dir, name));
  }
  for (const [key, text] of Object.entries(geometryShardTexts)) {
    writeFileSync(path.join(root, landProjectGeometryShardPath(key)), text);
  }
}

export function writeLandProjectMapPoints({ check = false, root = ROOT } = {}) {
  const built = buildLandProjectMapPointsFromRepo(root);
  const payloadPath = path.join(root, PAYLOAD_JSON);
  const receiptPath = path.join(root, RECEIPT_JSON);

  if (built.oversize) {
    // Fail publication and retain last-good committed output.
    const message =
      `${PAYLOAD_JSON} is ${built.receipt.generation.payload_bytes} bytes; ` +
      `exceeds ${LAND_PROJECT_MAP_POINTS_MAX_BYTES} and retains last-good output`;
    if (check) throw new Error(message);
    if (!existsSync(payloadPath) || !existsSync(receiptPath)) {
      throw new Error(`${message}; no last-good payload present to retain`);
    }
    throw new Error(message);
  }

  if (check) {
    const committedPayload = readFileSync(payloadPath, "utf8");
    const committedReceipt = readFileSync(receiptPath, "utf8");
    if (committedPayload !== built.payloadText) {
      throw new Error(`${PAYLOAD_JSON} drifted; rerun without --check`);
    }
    if (committedReceipt !== built.receiptText) {
      throw new Error(`${RECEIPT_JSON} drifted; rerun without --check`);
    }
    assertCommittedShards(root, built.geometryShardTexts);
    return built;
  }

  writeFileSync(payloadPath, built.payloadText);
  writeFileSync(receiptPath, built.receiptText);
  writeGeometryShards(root, built.geometryShardTexts);
  return built;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const built = writeLandProjectMapPoints({ check: args.check });
  const mapped = built.receipt.counts.mapped;
  const universe = built.receipt.counts.universe;
  const shards = built.receipt.generation.geometry_shard_count;
  console.log(
    args.check
      ? `land project map points check ok: ${mapped}/${universe} shards=${shards}`
      : `wrote ${PAYLOAD_JSON}, ${RECEIPT_JSON}, and ${GEOMETRY_SHARD_DIR}: ${mapped}/${universe} shards=${shards}`,
  );
}
