#!/usr/bin/env node
/**
 * Refresh and publish one coherent board↔neighborhood generation.
 *
 *   node tools/board_neighborhood_refresh.mjs
 *   node tools/board_neighborhood_refresh.mjs --check
 *   node tools/board_neighborhood_refresh.mjs --force
 *   node tools/board_neighborhood_refresh.mjs --fixture-dir DIR
 *   node tools/board_neighborhood_refresh.mjs --inject-failure KIND
 *
 * KIND: missing_crosswalk | invalid_ontology | before_activate | before_active_pointer | mixed_generation
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOARD_NEIGHBORHOOD_INDEX_PATH,
  BOARD_NEIGHBORHOOD_PUBLIC_DIR,
  BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_SCHEMA,
  activateBoardNeighborhoodGeneration,
  createBoardNeighborhoodRefresh,
  loadActiveBoardNeighborhoodGeneration,
  loadBoardNeighborhoodRefreshReceipt,
  writeBoardNeighborhoodRefreshReceipt,
} from "../site/board_neighborhood_refresh.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PUBLIC_DIR = path.join(ROOT, BOARD_NEIGHBORHOOD_PUBLIC_DIR);
const DEFAULT_ACTIVE_INDEX = path.join(ROOT, BOARD_NEIGHBORHOOD_INDEX_PATH);
const DEFAULT_CROSSWALK = path.join(
  ROOT,
  "site/data/geography/crosswalks/nta2020__community_district/26B__2026-05-26.json",
);
const DEFAULT_ONTOLOGY = path.join(ROOT, "site/data/community_board_geography_lookup.json");
const DEFAULT_LABELS = path.join(ROOT, "site/data/geography/layers/nta2020/26B.json");

function parseArgs(argv) {
  const args = {
    check: false,
    force: false,
    fixtureDir: null,
    publicDir: DEFAULT_PUBLIC_DIR,
    activeIndexPath: DEFAULT_ACTIVE_INDEX,
    crosswalkPath: DEFAULT_CROSSWALK,
    ontologyPath: DEFAULT_ONTOLOGY,
    labelsPath: DEFAULT_LABELS,
    injectFailure: null,
    help: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") args.check = true;
    else if (token === "--force") args.force = true;
    else if (token === "--fixture-dir") args.fixtureDir = path.resolve(argv[++index]);
    else if (token === "--public-dir") args.publicDir = path.resolve(argv[++index]);
    else if (token === "--active-index") args.activeIndexPath = path.resolve(argv[++index]);
    else if (token === "--crosswalk") args.crosswalkPath = path.resolve(argv[++index]);
    else if (token === "--ontology") args.ontologyPath = path.resolve(argv[++index]);
    else if (token === "--labels") args.labelsPath = path.resolve(argv[++index]);
    else if (token === "--inject-failure") args.injectFailure = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function applyFixtureDir(args) {
  if (!args.fixtureDir) return args;
  const dir = args.fixtureDir;
  const mapped = { ...args };
  const maybe = (name, key) => {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) mapped[key] = candidate;
  };
  maybe("crosswalk.json", "crosswalkPath");
  maybe("community_board_geography_lookup.json", "ontologyPath");
  maybe("nta2020.json", "labelsPath");
  maybe("board-neighborhood-generations", "publicDir");
  maybe("board_neighborhood_index.json", "activeIndexPath");
  mkdirSync(mapped.publicDir, { recursive: true });
  return mapped;
}

function loadJsonBytes(filePath) {
  const bytes = readFileSync(filePath);
  return {
    bytes,
    json: JSON.parse(bytes.toString("utf8")),
  };
}

export function buildBoardNeighborhoodRefreshAdapters(options = {}) {
  const args = applyFixtureDir({
    publicDir: options.publicDir || DEFAULT_PUBLIC_DIR,
    activeIndexPath: options.activeIndexPath || DEFAULT_ACTIVE_INDEX,
    crosswalkPath: options.crosswalkPath || DEFAULT_CROSSWALK,
    ontologyPath: options.ontologyPath || DEFAULT_ONTOLOGY,
    labelsPath: options.labelsPath || DEFAULT_LABELS,
    fixtureDir: options.fixtureDir || null,
  });

  mkdirSync(args.publicDir, { recursive: true });

  return {
    args,
    loadSources() {
      if (!existsSync(args.crosswalkPath)) {
        const error = new Error(`missing crosswalk: ${args.crosswalkPath}`);
        error.failure_kind = "missing_crosswalk";
        throw error;
      }
      if (!existsSync(args.ontologyPath)) {
        const error = new Error(`missing ontology: ${args.ontologyPath}`);
        error.failure_kind = "invalid_ontology";
        throw error;
      }
      if (!existsSync(args.labelsPath)) {
        const error = new Error(`missing labels: ${args.labelsPath}`);
        error.failure_kind = "missing_labels";
        throw error;
      }
      const crosswalk = loadJsonBytes(args.crosswalkPath);
      const ontology = loadJsonBytes(args.ontologyPath);
      const labels = loadJsonBytes(args.labelsPath);
      return {
        crosswalk: crosswalk.json,
        geography: ontology.json,
        ntaLayer: labels.json,
        crosswalkBytes: crosswalk.bytes,
        ontologyBytes: ontology.bytes,
        labelBytes: labels.bytes,
      };
    },
    loadPreviousReceipt: () => loadBoardNeighborhoodRefreshReceipt(args.publicDir),
    saveReceipt: (receipt) => writeBoardNeighborhoodRefreshReceipt(args.publicDir, receipt),
    loadActiveGeneration: () => (
      loadActiveBoardNeighborhoodGeneration(args.publicDir)?.pointer?.active_generation || null
    ),
    activateGeneration: (activationArgs) => activateBoardNeighborhoodGeneration({
      publicDir: args.publicDir,
      activeIndexPath: args.activeIndexPath,
      ...activationArgs,
    }),
    activeIndexPath: args.activeIndexPath,
  };
}

export function runBoardNeighborhoodRefresh(cliArgs = {}) {
  const adapters = buildBoardNeighborhoodRefreshAdapters(cliArgs);
  const refresh = createBoardNeighborhoodRefresh(adapters);
  return refresh.run({
    force: Boolean(cliArgs.force),
    injectFailure: cliArgs.injectFailure || null,
    now: cliArgs.now || new Date().toISOString(),
    builtAt: cliArgs.builtAt || null,
  });
}

async function main() {
  const args = applyFixtureDir(parseArgs(process.argv));
  if (args.help) {
    console.log(`Usage: node tools/board_neighborhood_refresh.mjs [options]
  --check                 Validate the last refresh receipt and active generation
  --force                 Rebuild even when input hashes match
  --fixture-dir DIR       Controlled inputs for rehearsal
  --public-dir DIR        Generation publication directory
  --active-index PATH     Convenience active index path
  --inject-failure KIND   Rehearse missing_crosswalk|invalid_ontology|before_activate|before_active_pointer|mixed_generation`);
    return;
  }

  if (args.check) {
    const receipt = loadBoardNeighborhoodRefreshReceipt(args.publicDir);
    const active = loadActiveBoardNeighborhoodGeneration(args.publicDir);
    if (!receipt && !active) {
      // Cold derived builds may run --check before the first activation on a
      // fresh tree; treat that as idle rather than failing the boundary.
      console.log("ok board-neighborhood-refresh: no receipt yet (idle)");
      return;
    }
    if (receipt && receipt.schema !== BOARD_NEIGHBORHOOD_REFRESH_RECEIPT_SCHEMA) {
      throw new Error(`unexpected refresh receipt schema: ${receipt.schema}`);
    }
    if (active) {
      const ids = [
        active.index?.generation?.id,
        active.directory?.generation_id,
        active.profile?.generation_id,
      ];
      if (ids.some((id) => id !== active.pointer.active_generation)) {
        throw new Error("active board neighborhood consumers disagree on generation id");
      }
    }
    console.log(
      `ok board-neighborhood-refresh ${receipt?.status || "active"}`
      + (active?.pointer?.active_generation ? ` active=${active.pointer.active_generation}` : ""),
    );
    return;
  }

  const result = runBoardNeighborhoodRefresh(args);
  const summary = {
    status: result.status,
    ok: result.ok,
    active_generation: result.active_generation,
    previous_active_generation: result.previous_active_generation || null,
    reasons: result.plan?.reasons || result.receipt?.plan?.reasons || [],
    failed_at: result.receipt?.failed_at || null,
    vintages: result.receipt?.vintages || null,
  };
  console.log(JSON.stringify(summary));
  if (!result.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
