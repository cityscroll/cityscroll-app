#!/usr/bin/env node
/**
 * Build/check deterministic NTA ↔ district/precinct crosswalk delivery shards.
 *
 * Consumes full-fidelity paths and hashes from the geography layer registry,
 * runs the exact overlay engine, and emits compact relationship facts for the
 * browser. Simplified geometry is rejected. Disjoint pairs are omitted.
 *
 *   node tools/build_geography_crosswalks.mjs
 *   node tools/build_geography_crosswalks.mjs --check
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { overlayCivicGeographies } from "../site/civic_geography_overlay.mjs";
import {
  GEOGRAPHY_CROSSWALK_COMMISSION_PINS,
  GEOGRAPHY_CROSSWALK_FROM_TYPE,
  GEOGRAPHY_CROSSWALK_GENERATOR,
  GEOGRAPHY_CROSSWALK_MANIFEST_PATH,
  GEOGRAPHY_CROSSWALK_MANIFEST_SCHEMA,
  GEOGRAPHY_CROSSWALK_MATERIALITY,
  GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT,
  GEOGRAPHY_CROSSWALK_PARTITION_TARGET_TYPES,
  GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
  GEOGRAPHY_CROSSWALK_SHARD_SCHEMA,
  GEOGRAPHY_CROSSWALK_SITE_ROOT,
  GEOGRAPHY_CROSSWALK_TARGET_TYPES,
  assertNoGeometryPayload,
  assertPartitionCoverage,
  geographyCrosswalkPairId,
  geographyCrosswalkShardPath,
  projectCrosswalkDeliveryRow,
} from "../site/geography_crosswalk_artifacts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = join(ROOT, "site/data/geography/layer_registry.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function bboxOverlaps(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left[0] <= right[2]
    && right[0] <= left[2]
    && left[1] <= right[3]
    && right[1] <= left[3];
}

function registryLayer(registry, type) {
  const row = (registry.layers || []).find((candidate) => candidate.type === type);
  if (!row) throw new Error(`layer registry missing ${type}`);
  return row;
}

function loadFullLayer(registry, type) {
  const registered = registryLayer(registry, type);
  const relativePath = registered.artifacts?.full?.path;
  if (!relativePath) throw new Error(`layer ${type} has no full artifact path`);
  const absolute = join(ROOT, relativePath);
  if (!existsSync(absolute)) throw new Error(`missing full geography layer ${relativePath}`);
  const text = readFileSync(absolute, "utf8");
  const digest = sha256Text(text);
  const layer = JSON.parse(text);
  if (layer.geometry_fidelity !== "full") {
    throw new Error(`layer ${type} artifact is not full-fidelity (${layer.geometry_fidelity})`);
  }
  if (layer.type !== type) {
    throw new Error(`layer ${type} artifact declares type ${layer.type}`);
  }
  const vintageId = layer.vintage?.id || registered.boundary_vintage;
  if (String(vintageId) !== String(registered.boundary_vintage)) {
    throw new Error(
      `layer ${type} vintage mismatch: registry ${registered.boundary_vintage} artifact ${vintageId}`,
    );
  }
  return {
    registered,
    layer,
    relativePath,
    sha256: digest,
    registrySha256: registered.artifacts.full.sha256 || null,
    vintageId: String(vintageId),
  };
}

function compareRows(left, right) {
  const from = String(left.from_key).localeCompare(String(right.from_key));
  if (from !== 0) return from;
  const pct = (Number(right.pct_from) || 0) - (Number(left.pct_from) || 0);
  if (pct !== 0) return pct < 0 ? -1 : 1;
  return String(left.to_key).localeCompare(String(right.to_key));
}

function overlayPair(fromLoaded, toLoaded) {
  const fromLayer = fromLoaded.layer;
  const toLayer = toLoaded.layer;
  const rows = [];
  let compared = 0;
  let bboxSkipped = 0;

  for (const fromFeature of fromLayer.features || []) {
    const keptForFrom = [];
    for (const toFeature of toLayer.features || []) {
      if (!bboxOverlaps(fromFeature.bbox, toFeature.bbox)) {
        bboxSkipped += 1;
        continue;
      }
      compared += 1;
      const observation = overlayCivicGeographies({
        fromLayer,
        fromFeature,
        toLayer,
        toFeature,
        minAreaSqFt: GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT,
        requireFullFidelity: true,
      });
      const row = projectCrosswalkDeliveryRow(observation, { toType: toLayer.type });
      if (row) keptForFrom.push(row);
    }
    assertPartitionCoverage(keptForFrom, {
      fromKey: fromFeature.key,
      toType: toLayer.type,
      subtype: fromFeature.subtype || "residential",
      tolerancePct: GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
    });
    rows.push(...keptForFrom);
  }

  rows.sort(compareRows);
  return {
    rows,
    compared_pairs: compared,
    bbox_skipped_pairs: bboxSkipped,
  };
}

function buildShard({ fromLoaded, toLoaded, pairStats }) {
  const fromType = fromLoaded.layer.type;
  const toType = toLoaded.layer.type;
  const path = geographyCrosswalkShardPath(
    fromType,
    toType,
    fromLoaded.vintageId,
    toLoaded.vintageId,
  );
  const shard = {
    schema: GEOGRAPHY_CROSSWALK_SHARD_SCHEMA,
    pair: {
      id: geographyCrosswalkPairId(fromType, toType),
      from_type: fromType,
      to_type: toType,
    },
    source_vintages: {
      from: fromLoaded.vintageId,
      to: toLoaded.vintageId,
    },
    source_artifacts: {
      from: {
        path: fromLoaded.relativePath,
        sha256: fromLoaded.sha256,
        geometry_fidelity: "full",
      },
      to: {
        path: toLoaded.relativePath,
        sha256: toLoaded.sha256,
        geometry_fidelity: "full",
      },
    },
    method: "polygon_intersection_epsg2263",
    threshold: { min_area_sqft: GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT },
    materiality: GEOGRAPHY_CROSSWALK_MATERIALITY,
    generator: GEOGRAPHY_CROSSWALK_GENERATOR,
    partition_check: GEOGRAPHY_CROSSWALK_PARTITION_TARGET_TYPES.includes(toType)
      ? {
        enabled: true,
        tolerance_pct: GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
        policy: "fail_closed_no_renormalization",
      }
      : { enabled: false },
    inventory: {
      from_feature_count: fromLoaded.layer.features.length,
      to_feature_count: toLoaded.layer.features.length,
      retained_row_count: pairStats.rows.length,
      compared_pairs: pairStats.compared_pairs,
      bbox_skipped_pairs: pairStats.bbox_skipped_pairs,
      material_row_count: pairStats.rows.filter((row) => row.material_for_navigation).length,
    },
    rows: pairStats.rows,
  };
  assertNoGeometryPayload(shard);
  return { path, shard };
}

function assertCommissionPins(shardsByPair) {
  const pins = GEOGRAPHY_CROSSWALK_COMMISSION_PINS;
  for (const pin of pins.rows) {
    const pairId = geographyCrosswalkPairId(GEOGRAPHY_CROSSWALK_FROM_TYPE, pin.to_type);
    const shard = shardsByPair.get(pairId);
    if (!shard) throw new Error(`commission pin missing shard ${pairId}`);
    if (shard.source_vintages.from !== pins.from_vintage) {
      throw new Error(
        `commission from vintage drifted: expected ${pins.from_vintage} got ${shard.source_vintages.from}`,
      );
    }
    if (shard.source_vintages.to !== pin.to_vintage) {
      throw new Error(
        `commission to vintage drifted for ${pin.to_key}: expected ${pin.to_vintage} got ${shard.source_vintages.to}`,
      );
    }
    const row = shard.rows.find((candidate) => (
      candidate.from_key === pins.selected_key && candidate.to_key === pin.to_key
    ));
    if (!row) {
      throw new Error(`commission pin missing row ${pins.selected_key} → ${pin.to_key}`);
    }
    if (row.relation !== pin.relation) {
      throw new Error(
        `commission relation drift ${pin.to_key}: expected ${pin.relation} got ${row.relation}`,
      );
    }
    if (row.pct_from !== pin.pct_from) {
      throw new Error(
        `commission pct_from drift ${pin.to_key}: expected ${pin.pct_from} got ${row.pct_from}`,
      );
    }
    if (row.material_for_navigation !== pin.material_for_navigation) {
      throw new Error(
        `commission materiality drift ${pin.to_key}: expected ${pin.material_for_navigation} got ${row.material_for_navigation}`,
      );
    }
    if (pin.intersection_area_sqft != null
      && row.intersection_area_sqft !== pin.intersection_area_sqft) {
      throw new Error(
        `commission area drift ${pin.to_key}: expected ${pin.intersection_area_sqft} got ${row.intersection_area_sqft}`,
      );
    }
  }
}

function sourceLayerBinding(loaded) {
  return {
    boundary_vintage: loaded.vintageId,
    full_path: loaded.relativePath,
    full_sha256: loaded.sha256,
    geometry_fidelity: "full",
  };
}

export function buildGeographyCrosswalkArtifacts({ registry = readJson(REGISTRY_PATH) } = {}) {
  const fromLoaded = loadFullLayer(registry, GEOGRAPHY_CROSSWALK_FROM_TYPE);
  const loadedByType = new Map([[fromLoaded.layer.type, fromLoaded]]);
  const shards = [];
  const shardsByPair = new Map();

  for (const toType of GEOGRAPHY_CROSSWALK_TARGET_TYPES) {
    const toLoaded = loadFullLayer(registry, toType);
    loadedByType.set(toType, toLoaded);
    const pairStats = overlayPair(fromLoaded, toLoaded);
    const built = buildShard({ fromLoaded, toLoaded, pairStats });
    shards.push(built);
    shardsByPair.set(built.shard.pair.id, built.shard);
  }

  assertCommissionPins(shardsByPair);

  const manifest = {
    schema: GEOGRAPHY_CROSSWALK_MANIFEST_SCHEMA,
    from_type: GEOGRAPHY_CROSSWALK_FROM_TYPE,
    target_types: [...GEOGRAPHY_CROSSWALK_TARGET_TYPES],
    generator: GEOGRAPHY_CROSSWALK_GENERATOR,
    method: "polygon_intersection_epsg2263",
    threshold: { min_area_sqft: GEOGRAPHY_CROSSWALK_MIN_AREA_SQFT },
    materiality: GEOGRAPHY_CROSSWALK_MATERIALITY,
    partition_check: {
      target_types: [...GEOGRAPHY_CROSSWALK_PARTITION_TARGET_TYPES],
      tolerance_pct: GEOGRAPHY_CROSSWALK_PARTITION_TOLERANCE_PCT,
      policy: "fail_closed_no_renormalization",
    },
    commission_pins: {
      selected_key: GEOGRAPHY_CROSSWALK_COMMISSION_PINS.selected_key,
      from_vintage: GEOGRAPHY_CROSSWALK_COMMISSION_PINS.from_vintage,
      row_count: GEOGRAPHY_CROSSWALK_COMMISSION_PINS.rows.length,
    },
    source_layers: Object.fromEntries(
      [GEOGRAPHY_CROSSWALK_FROM_TYPE, ...GEOGRAPHY_CROSSWALK_TARGET_TYPES].map((type) => [
        type,
        sourceLayerBinding(loadedByType.get(type)),
      ]),
    ),
    shards: shards.map(({ path, shard }) => ({
      path,
      pair_id: shard.pair.id,
      from_type: shard.pair.from_type,
      to_type: shard.pair.to_type,
      source_vintages: shard.source_vintages,
      source_artifacts: shard.source_artifacts,
      row_count: shard.inventory.retained_row_count,
      material_row_count: shard.inventory.material_row_count,
      sha256: sha256Text(stableText(shard)),
    })),
  };
  assertNoGeometryPayload(manifest);
  return { manifest, shards };
}

function expectedPairDirs() {
  return GEOGRAPHY_CROSSWALK_TARGET_TYPES.map((toType) => (
    geographyCrosswalkPairId(GEOGRAPHY_CROSSWALK_FROM_TYPE, toType)
  ));
}

function writeArtifacts(artifacts) {
  const root = join(ROOT, GEOGRAPHY_CROSSWALK_SITE_ROOT);
  mkdirSync(root, { recursive: true });
  for (const pairId of expectedPairDirs()) {
    const dir = join(root, pairId);
    mkdirSync(dir, { recursive: true });
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      rmSync(join(dir, name), { force: true });
    }
  }

  for (const { path, shard } of artifacts.shards) {
    const absolute = join(ROOT, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, stableText(shard));
  }
  writeFileSync(join(ROOT, GEOGRAPHY_CROSSWALK_MANIFEST_PATH), stableText(artifacts.manifest));
}

function readCommittedArtifacts() {
  const manifestPath = join(ROOT, GEOGRAPHY_CROSSWALK_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(`missing ${GEOGRAPHY_CROSSWALK_MANIFEST_PATH}`);
  }
  const manifest = readJson(manifestPath);
  const shards = (manifest.shards || []).map((entry) => {
    const absolute = join(ROOT, entry.path);
    if (!existsSync(absolute)) throw new Error(`missing crosswalk shard ${entry.path}`);
    const text = readFileSync(absolute, "utf8");
    const digest = sha256Text(text);
    if (entry.sha256 && entry.sha256 !== digest) {
      throw new Error(`crosswalk shard digest drift ${entry.path}`);
    }
    return { path: entry.path, shard: JSON.parse(text), text };
  });
  return { manifest, shards };
}

export function assertRegistryBinding(manifest, registry = readJson(REGISTRY_PATH)) {
  for (const type of [GEOGRAPHY_CROSSWALK_FROM_TYPE, ...GEOGRAPHY_CROSSWALK_TARGET_TYPES]) {
    const registered = registryLayer(registry, type);
    const recorded = manifest.source_layers?.[type];
    if (!recorded) throw new Error(`manifest missing source layer ${type}`);
    if (String(recorded.boundary_vintage) !== String(registered.boundary_vintage)) {
      throw new Error(
        `crosswalk vintage drift for ${type}: manifest ${recorded.boundary_vintage} registry ${registered.boundary_vintage}`,
      );
    }
    if (recorded.full_path !== registered.artifacts.full.path) {
      throw new Error(
        `crosswalk source-path drift for ${type}: manifest ${recorded.full_path} registry ${registered.artifacts.full.path}`,
      );
    }
    const absolute = join(ROOT, recorded.full_path);
    if (!existsSync(absolute)) throw new Error(`missing bound source layer ${recorded.full_path}`);
    const diskSha = sha256Text(readFileSync(absolute, "utf8"));
    if (recorded.full_sha256 !== diskSha) {
      throw new Error(
        `crosswalk source-hash drift for ${type}: manifest ${recorded.full_sha256} disk ${diskSha}`,
      );
    }
  }
}

function assertArtifactsEqual(expected, committed) {
  const expectedManifest = stableText(expected.manifest);
  const committedManifest = stableText(committed.manifest);
  if (expectedManifest !== committedManifest) {
    throw new Error("geography crosswalk manifest drifted; rebuild with tools/build_geography_crosswalks.mjs");
  }
  const expectedByPath = new Map(expected.shards.map((entry) => [entry.path, stableText(entry.shard)]));
  const committedByPath = new Map(committed.shards.map((entry) => [entry.path, entry.text.endsWith("\n") ? entry.text : `${entry.text}\n`]));
  if (expectedByPath.size !== committedByPath.size) {
    throw new Error("geography crosswalk shard inventory drifted");
  }
  for (const [path, text] of expectedByPath) {
    if (committedByPath.get(path) !== text) {
      throw new Error(`geography crosswalk shard drifted: ${path}`);
    }
  }
}

function parseArgs(argv) {
  return { check: argv.includes("--check") };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = readJson(REGISTRY_PATH);
  const built = buildGeographyCrosswalkArtifacts({ registry });

  if (options.check) {
    const committed = readCommittedArtifacts();
    assertRegistryBinding(committed.manifest, registry);
    assertNoGeometryPayload(committed.manifest);
    for (const entry of committed.shards) assertNoGeometryPayload(entry.shard);
    assertCommissionPins(new Map(committed.shards.map((entry) => [entry.shard.pair.id, entry.shard])));
    assertArtifactsEqual(built, committed);
    const rowCount = built.shards.reduce((sum, entry) => sum + entry.shard.rows.length, 0);
    console.log(
      `geography crosswalks ok pairs=${built.shards.length} rows=${rowCount} manifest=${relative(ROOT, join(ROOT, GEOGRAPHY_CROSSWALK_MANIFEST_PATH))}`,
    );
    return;
  }

  writeArtifacts(built);
  const rowCount = built.shards.reduce((sum, entry) => sum + entry.shard.rows.length, 0);
  console.log(JSON.stringify({
    manifest: GEOGRAPHY_CROSSWALK_MANIFEST_PATH,
    shards: built.shards.map((entry) => entry.path),
    row_count: rowCount,
    material_row_count: built.shards.reduce(
      (sum, entry) => sum + entry.shard.inventory.material_row_count,
      0,
    ),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
