#!/usr/bin/env node
/**
 * Build the committed board ↔ neighborhood association index.
 *
 *   node tools/build_board_neighborhood_index.mjs
 *   node tools/build_board_neighborhood_index.mjs --check
 *
 * Inputs are the committed NTA→CD crosswalk shard, community-board geography
 * lookup, and NTA layer feature subtypes. Polygon intersections are not rerun.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOARD_NEIGHBORHOOD_INDEX_PATH,
  buildBoardNeighborhoodIndex,
  ntaSubtypeMapFromLayer,
  serializeBoardNeighborhoodIndex,
} from "../site/board_neighborhood_index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, BOARD_NEIGHBORHOOD_INDEX_PATH);
const CROSSWALK = path.join(
  ROOT,
  "site/data/geography/crosswalks/nta2020__community_district/26B__2026-05-26.json",
);
const GEOGRAPHY = path.join(ROOT, "site/data/community_board_geography_lookup.json");
const NTA_LAYER = path.join(ROOT, "site/data/geography/layers/nta2020/26B.json");

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson(absolute) {
  return JSON.parse(await readFile(absolute, "utf8"));
}

async function buildDocument() {
  const [crosswalkBytes, geographyBytes, ntaLayerBytes] = await Promise.all([
    readFile(CROSSWALK),
    readFile(GEOGRAPHY),
    readFile(NTA_LAYER),
  ]);
  const crosswalk = JSON.parse(crosswalkBytes.toString("utf8"));
  const geography = JSON.parse(geographyBytes.toString("utf8"));
  const ntaLayer = JSON.parse(ntaLayerBytes.toString("utf8"));
  const sourceHashes = {
    "geography/crosswalks/nta2020__community_district/26B__2026-05-26.json": sha256Bytes(crosswalkBytes),
    "community_board_geography_lookup.json": sha256Bytes(geographyBytes),
    "geography/layers/nta2020/26B.json": sha256Bytes(ntaLayerBytes),
  };
  const builtAt = cleanBuiltAt(geography?.generated_at) || "2026-08-12T00:00:00.000Z";
  return buildBoardNeighborhoodIndex({
    crosswalk,
    geography,
    ntaSubtypeById: ntaSubtypeMapFromLayer(ntaLayer),
    sourceHashes,
    builtAt,
  });
}

function cleanBuiltAt(value) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : null;
}

async function main() {
  const doc = await buildDocument();
  const serialized = serializeBoardNeighborhoodIndex(doc);
  if (process.argv.includes("--check")) {
    const existing = await readFile(OUTPUT, "utf8");
    if (existing !== serialized) {
      throw new Error(`stale board neighborhood index: ${path.relative(ROOT, OUTPUT)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      path: path.relative(ROOT, OUTPUT),
      material_row_count: doc.inventory.material_row_count,
      board_associated_row_count: doc.inventory.board_associated_row_count,
      non_board_row_count: doc.inventory.non_board_row_count,
      board_identity_count: doc.inventory.board_identity_count,
      association_failure_count: doc.inventory.association_failure_count,
      generation: doc.generation.id,
    }));
    return;
  }
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, serialized);
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT),
    material_row_count: doc.inventory.material_row_count,
    board_associated_row_count: doc.inventory.board_associated_row_count,
    non_board_row_count: doc.inventory.non_board_row_count,
    board_identity_count: doc.inventory.board_identity_count,
    association_failure_count: doc.inventory.association_failure_count,
    generation: doc.generation.id,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
