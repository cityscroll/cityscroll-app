#!/usr/bin/env node
/**
 * Materialize the admitted Land project catalog.
 *
 * Usage:
 *   node tools/build_land_project_catalog.mjs
 *   node tools/build_land_project_catalog.mjs --check
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAND_PROJECT_CATALOG_DEFAULTS_PATH,
  LAND_PROJECT_CATALOG_PATH,
  LAND_PROJECT_CATALOG_WAREHOUSE_PATH,
  buildLandProjectCatalog,
} from "../site/land_project_catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAYLOAD_JSON = LAND_PROJECT_CATALOG_PATH;

const WAREHOUSE = LAND_PROJECT_CATALOG_WAREHOUSE_PATH;
const DEFAULTS = LAND_PROJECT_CATALOG_DEFAULTS_PATH;
const BBL_INDEX = "site/data/zap_bbl_warehouse_lookup.json";

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

function readRequiredJson(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    const error = new Error(`missing required catalog source: ${relativePath}`);
    error.code = "LAND_PROJECT_CATALOG_SOURCE_MISSING";
    throw error;
  }
  return JSON.parse(readFileSync(absolute, "utf8"));
}

export function buildLandProjectCatalogFromRepo(root = ROOT) {
  const warehouse = readRequiredJson(root, WAREHOUSE);
  const defaults = readRequiredJson(root, DEFAULTS);
  const bblIndex = existsSync(path.join(root, BBL_INDEX))
    ? JSON.parse(readFileSync(path.join(root, BBL_INDEX), "utf8"))
    : null;
  const catalog = buildLandProjectCatalog({
    warehouse,
    defaults,
    // Passed explicitly so tests and builders prove it never enlarges admission.
    bblIndex,
    artifactHashes: {
      warehouse: sha256File(root, WAREHOUSE),
      defaults: sha256File(root, DEFAULTS),
    },
  });
  const payloadText = stableStringify(catalog);
  return { catalog, payloadText };
}

export function writeLandProjectCatalog({ check = false, root = ROOT } = {}) {
  const built = buildLandProjectCatalogFromRepo(root);
  const payloadPath = path.join(root, PAYLOAD_JSON);
  if (check) {
    if (!existsSync(payloadPath)) {
      throw new Error(`${PAYLOAD_JSON} missing; rerun without --check`);
    }
    const committed = readFileSync(payloadPath, "utf8");
    if (committed !== built.payloadText) {
      throw new Error(`${PAYLOAD_JSON} drifted; rerun without --check`);
    }
    return built;
  }
  writeFileSync(payloadPath, built.payloadText);
  return built;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const built = writeLandProjectCatalog({ check: args.check });
  console.log(
    args.check ? "land_project_catalog ok" : "land_project_catalog wrote",
    {
      path: PAYLOAD_JSON,
      project_count: built.catalog.project_count,
      content_id: built.catalog.generation.content_id,
      source_dates: built.catalog.source_dates,
    },
  );
}
