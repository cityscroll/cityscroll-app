#!/usr/bin/env node
/**
 * Materialize the Land default-corpus mapability census from committed artifacts.
 *
 * Usage:
 *   node tools/build_land_mapability_census.mjs
 *   node tools/build_land_mapability_census.mjs --check
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLandMapabilityContract,
  censusLandMapability,
  renderLandMapabilityCensusMarkdown,
} from "./lib/land_mapability_census.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CENSUS_JSON = "docs/evidence/land-map-view-census.json";
export const CENSUS_MD = "docs/evidence/land-map-view-census.md";

const LAND_DEFAULT = "site/data/land_default_ulurp.json";
const ZAP_BBL = "site/data/zap_bbl_warehouse_lookup.json";
const MAPPLUTO = "site/data/bbl_mappluto_centroids_lookup.json";
const PROPERTY = "site/data/property_domain_observations.json";

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

export function buildLandMapabilityCensusFromRepo(root = ROOT) {
  const landPath = path.join(root, LAND_DEFAULT);
  return censusLandMapability({
    landDefault: JSON.parse(readFileSync(landPath, "utf8")),
    zapBbl: JSON.parse(readFileSync(path.join(root, ZAP_BBL), "utf8")),
    mapplutoCentroids: JSON.parse(readFileSync(path.join(root, MAPPLUTO), "utf8")),
    propertyObservations: JSON.parse(readFileSync(path.join(root, PROPERTY), "utf8")),
    listBytes: statSync(landPath).size,
    artifactHashes: {
      land_default: sha256File(root, LAND_DEFAULT),
      zap_bbl: sha256File(root, ZAP_BBL),
      mappluto_centroids: sha256File(root, MAPPLUTO),
      property_observations: sha256File(root, PROPERTY),
    },
  });
}

export function writeLandMapabilityCensus({ check = false, root = ROOT } = {}) {
  const census = buildLandMapabilityCensusFromRepo(root);
  assertLandMapabilityContract(census);
  const jsonText = stableStringify(census);
  const mdText = renderLandMapabilityCensusMarkdown(census);
  const jsonPath = path.join(root, CENSUS_JSON);
  const mdPath = path.join(root, CENSUS_MD);
  if (check) {
    const committedJson = readFileSync(jsonPath, "utf8");
    const committedMd = readFileSync(mdPath, "utf8");
    if (committedJson !== jsonText) {
      throw new Error(`${CENSUS_JSON} drifted; rerun without --check`);
    }
    if (committedMd !== mdText) {
      throw new Error(`${CENSUS_MD} drifted; rerun without --check`);
    }
    return census;
  }
  writeFileSync(jsonPath, jsonText);
  writeFileSync(mdPath, mdText);
  return census;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const census = writeLandMapabilityCensus({ check: args.check });
  const agg = census.aggregations;
  console.log(
    args.check
      ? `land mapability census check ok: ${agg.mapped}/${agg.denominator}`
      : `wrote ${CENSUS_JSON} and ${CENSUS_MD}: ${agg.mapped}/${agg.denominator}`,
  );
}
