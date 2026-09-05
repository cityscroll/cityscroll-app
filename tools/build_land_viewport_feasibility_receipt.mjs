#!/usr/bin/env node

// Builds the committed LM-18 stop receipt: given the current Land Map View
// state (pan/zoom exists, no viewport-to-filter compilation has been
// reviewed), the feasibility gate always resolves to a stop. This script
// keeps that receipt derived from site/land_viewport_feasibility_gate.mjs
// rather than hand-typed, so the two cannot drift apart.
//
// Usage:
//   node tools/build_land_viewport_feasibility_receipt.mjs            # write
//   node tools/build_land_viewport_feasibility_receipt.mjs --check    # verify

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildLandViewportFeasibilityReceipt,
  evaluateLandViewportFeasibility,
  validateLandViewportFeasibilityReceipt,
} from "../site/land_viewport_feasibility_gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs/evidence/land-map-viewport-feasibility.json");
const LAND_DEFAULT_ULURP = join(ROOT, "site/data/land_default_ulurp.json");
const LAND_MAP_POINTS = join(ROOT, "site/data/land_project_map_points.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The current default Land browse population, used only to name a real,
 * committed loaded-model/unmapped shape in the receipt. This script never
 * fetches, geocodes, or queries anything; it reads two artifacts the site
 * already ships and asks the gate whether the P0 state may ship a viewport
 * action. It cannot; the answer is a stop receipt either way.
 */
function currentLoadedModel() {
  const defaultSnapshot = readJson(LAND_DEFAULT_ULURP);
  const mapPoints = readJson(LAND_MAP_POINTS);
  const totalIds = (defaultSnapshot?.projects || []).map((project) => String(project.project_id));
  const mappedIds = Object.keys(mapPoints?.points || {});
  const mappedSet = new Set(mappedIds);
  const unmappedIds = totalIds.filter((id) => !mappedSet.has(id));
  return { totalIds, mappedIds, unmappedIds };
}

export function build() {
  const loadedModel = currentLoadedModel();
  const decision = evaluateLandViewportFeasibility({
    // P0 has no viewport-driven request at all: pan/zoom is presentation
    // only, so there is nothing for a resident action to compile from.
    requestedKind: undefined,
    loadedModel,
  });
  const receipt = buildLandViewportFeasibilityReceipt({
    viewport: {
      note: "Land Map pan/zoom is reversible presentation state; no viewport-to-filter action exists to evaluate.",
      surfaces: [
        "site/app/map_runtime.mjs#wireLandPanControls (project-detail Leaflet pan)",
        "site/map_exploration.mjs#panViewBox / #zoomViewBox (citywide choropleth explorer, not Land-filter-owned)",
      ],
    },
    loadedModel,
    decision,
    requestSequence: [],
    sourceVintages: {
      land_default_ulurp: LAND_DEFAULT_ULURP.replace(`${ROOT}/`, ""),
      land_project_map_points: LAND_MAP_POINTS.replace(`${ROOT}/`, ""),
    },
  });
  const validation = validateLandViewportFeasibilityReceipt(receipt);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return receipt;
}

function main() {
  const receipt = build();
  const bytes = serialized(receipt);
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== bytes) throw new Error(`stale LM-18 feasibility receipt: ${OUTPUT}`);
    console.log(`checked LM-18 viewport feasibility receipt: outcome=${receipt.outcome}`);
    return;
  }
  writeFileSync(OUTPUT, bytes);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
