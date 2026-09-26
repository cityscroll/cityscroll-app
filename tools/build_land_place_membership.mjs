#!/usr/bin/env node
/**
 * Materialize Land project-place membership from published lots.
 *
 * Usage:
 *   node tools/build_land_place_membership.mjs
 *   node tools/build_land_place_membership.mjs --check
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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LAND_PROJECT_CATALOG_PATH } from "../site/land_project_catalog.mjs";
import {
  LAND_PLACE_BBL_INDEX_PATH,
  LAND_PLACE_EVIDENCE_DIR,
  LAND_PLACE_EVIDENCE_SHARD_COUNT,
  LAND_PLACE_MEMBERSHIP_PATH,
  landPlaceEvidenceShardPath,
} from "../site/land_place_membership.mjs";
import { buildLandPlaceMembershipFromSources } from "../site/land_place_refresh.mjs";
import { PARCEL_GEOGRAPHY_MANIFEST_PATH } from "../site/parcel_geography.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function readOptionalJson(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8"));
}

export function buildLandPlaceMembershipFromRepo(root = ROOT) {
  const catalogPath = path.join(root, LAND_PROJECT_CATALOG_PATH);
  if (!existsSync(catalogPath)) {
    const error = new Error(
      `missing ${LAND_PROJECT_CATALOG_PATH}; run node tools/build_land_project_catalog.mjs`,
    );
    error.code = "LAND_PLACE_CATALOG_MISSING";
    throw error;
  }

  const catalog = readJson(root, LAND_PROJECT_CATALOG_PATH);
  const bblIndex = readOptionalJson(root, LAND_PLACE_BBL_INDEX_PATH);
  const parcelManifest = readOptionalJson(root, PARCEL_GEOGRAPHY_MANIFEST_PATH);

  const parcelDir = path.join(root, "site/data/parcel-geography");
  const loadParcelShard = (shardKey) => {
    const absolute = path.join(parcelDir, `${shardKey}.json`);
    if (!existsSync(absolute)) return null;
    return JSON.parse(readFileSync(absolute, "utf8"));
  };

  const artifactHashes = {
    catalog: sha256File(root, LAND_PROJECT_CATALOG_PATH),
    bbl_index: bblIndex ? sha256File(root, LAND_PLACE_BBL_INDEX_PATH) : null,
    parcel_manifest: parcelManifest ? sha256File(root, PARCEL_GEOGRAPHY_MANIFEST_PATH) : null,
  };

  // Share generation-id stamping with the refresh publication path so --check
  // agrees with tools/land_place_refresh.mjs live mirrors.
  const built = buildLandPlaceMembershipFromSources({
    catalog,
    bblIndex,
    loadParcelShard,
    parcelManifest,
    artifactHashes,
  });

  const indexText = stableStringify(built.indexDoc);
  const evidenceTexts = {};
  for (const [key, shard] of Object.entries(built.evidenceShards)) {
    evidenceTexts[key] = stableStringify(shard);
  }

  return {
    index: built.indexDoc,
    evidenceShards: built.evidenceShards,
    inputHashes: built.inputHashes,
    indexText,
    evidenceTexts,
  };
}

function expectedEvidenceKeys() {
  const keys = [];
  for (let i = 0; i < LAND_PLACE_EVIDENCE_SHARD_COUNT; i += 1) {
    keys.push(i.toString(16).padStart(2, "0"));
  }
  return keys;
}

export function writeLandPlaceMembership({ check = false, root = ROOT } = {}) {
  const built = buildLandPlaceMembershipFromRepo(root);
  const indexPath = path.join(root, LAND_PLACE_MEMBERSHIP_PATH);
  const evidenceDir = path.join(root, LAND_PLACE_EVIDENCE_DIR);
  const expectedKeys = expectedEvidenceKeys();

  if (check) {
    if (!existsSync(indexPath)) {
      throw new Error(`${LAND_PLACE_MEMBERSHIP_PATH} missing; rerun without --check`);
    }
    const committedIndex = readFileSync(indexPath, "utf8");
    if (committedIndex !== built.indexText) {
      throw new Error(`${LAND_PLACE_MEMBERSHIP_PATH} drifted; rerun without --check`);
    }
    if (!existsSync(evidenceDir)) {
      throw new Error(`${LAND_PLACE_EVIDENCE_DIR} missing; rerun without --check`);
    }
    const present = new Set(
      readdirSync(evidenceDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)),
    );
    for (const key of expectedKeys) {
      if (!present.has(key)) {
        throw new Error(`${landPlaceEvidenceShardPath(key)} missing; rerun without --check`);
      }
      const absolute = path.join(evidenceDir, `${key}.json`);
      const committed = readFileSync(absolute, "utf8");
      if (committed !== built.evidenceTexts[key]) {
        throw new Error(`${landPlaceEvidenceShardPath(key)} drifted; rerun without --check`);
      }
    }
    for (const key of present) {
      if (!expectedKeys.includes(key)) {
        throw new Error(`unexpected evidence shard ${key}.json`);
      }
    }
    return built;
  }

  mkdirSync(evidenceDir, { recursive: true });
  // Remove stale shard names outside the 00..ff set before rewriting.
  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir)) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -5);
      if (!expectedKeys.includes(key)) {
        rmSync(path.join(evidenceDir, name));
      }
    }
  }

  writeFileSync(indexPath, built.indexText);
  for (const key of expectedKeys) {
    writeFileSync(path.join(evidenceDir, `${key}.json`), built.evidenceTexts[key]);
  }
  return built;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const built = writeLandPlaceMembership({ check: args.check });
  const nonempty = Object.values(built.evidenceShards).filter((shard) => shard.project_count > 0).length;
  console.log(
    args.check ? "land_place_membership ok" : "land_place_membership wrote",
    {
      path: LAND_PLACE_MEMBERSHIP_PATH,
      evidence_dir: LAND_PLACE_EVIDENCE_DIR,
      project_count: built.index.project_count,
      evidence_shards: LAND_PLACE_EVIDENCE_SHARD_COUNT,
      nonempty_evidence_shards: nonempty,
      content_id: built.index.generation.content_id,
      bbl_source: built.index.bbl_source.status,
    },
  );
}
