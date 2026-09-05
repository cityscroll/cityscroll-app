#!/usr/bin/env node

// Builds the committed LM-16 density-measurement receipt: given the current
// default Land browse population and its committed point projection, this
// measures marker overlap in the exact viewBox/radius the browse Map canvas
// renders with, then asks the gate whether a density summary may ship. No
// task-impact review has been recorded, so the answer is a stop receipt
// either way; the measurement stays derived from the committed modules
// rather than hand-typed, so the two cannot drift apart.
//
// Usage:
//   node tools/build_land_map_density_receipt.mjs            # write
//   node tools/build_land_map_density_receipt.mjs --check    # verify

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { landMapMarkerPositions } from "../site/app/map_runtime.mjs";
import {
  buildLandMapDensityReceipt,
  computeMarkerOverlap,
  evaluateLandMapDensitySummary,
  markerAccounting,
  validateLandMapDensityReceipt,
} from "../site/land_map_density_measurement.mjs";
import { buildLandMapModel } from "../site/land_map_model.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs/evidence/land-map-density-measurement.json");
const LAND_DEFAULT_ULURP = join(ROOT, "site/data/land_default_ulurp.json");
const LAND_MAP_POINTS = join(ROOT, "site/data/land_project_map_points.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function build() {
  const defaultSnapshot = readJson(LAND_DEFAULT_ULURP);
  const mapPoints = readJson(LAND_MAP_POINTS);
  const rows = defaultSnapshot?.projects || [];

  // Same join the real browse Map renders from (site/land_map_model.mjs):
  // filtered rows in, mapped markers + explicit unmapped identities out.
  const model = buildLandMapModel({ rows, pointLookup: mapPoints });

  const accounting = markerAccounting({
    totalIds: rows.map((row) => String(row.project_id)),
    mappedIds: model.mapped.map((item) => item.projectId),
    unmappedIds: model.unmapped.map((item) => item.projectId),
  });

  // Same projection and radius the SVG canvas paints markers with
  // (site/app/map_runtime.mjs#landMapMarkerPositions) — never re-derived here.
  const { positions, radius } = landMapMarkerPositions(model);
  const overlap = computeMarkerOverlap(positions, radius);

  const decision = evaluateLandMapDensitySummary({ accounting, overlap });
  const receipt = buildLandMapDensityReceipt({
    decision,
    sourceVintages: {
      land_default_ulurp: LAND_DEFAULT_ULURP.replace(`${ROOT}/`, ""),
      land_project_map_points: LAND_MAP_POINTS.replace(`${ROOT}/`, ""),
    },
  });
  const validation = validateLandMapDensityReceipt(receipt);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return receipt;
}

function main() {
  const receipt = build();
  const bytes = serialized(receipt);
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== bytes) throw new Error(`stale LM-16 density measurement receipt: ${OUTPUT}`);
    console.log(`checked LM-16 density measurement receipt: outcome=${receipt.outcome}`);
    return;
  }
  writeFileSync(OUTPUT, bytes);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
