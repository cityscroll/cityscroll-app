#!/usr/bin/env node
/**
 * Refresh and publish one coherent Land place-membership generation.
 *
 *   node tools/land_place_refresh.mjs
 *   node tools/land_place_refresh.mjs --check
 *   node tools/land_place_refresh.mjs --force
 *   node tools/land_place_refresh.mjs --fixture-dir DIR
 *   node tools/land_place_refresh.mjs --inject-failure KIND
 *
 * KIND: partial_download | mismatched_boundary | before_activate | mixed_generation
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LAND_PROJECT_CATALOG_PATH } from "../site/land_project_catalog.mjs";
import {
  LAND_PLACE_BBL_INDEX_PATH,
  LAND_PLACE_EVIDENCE_DIR,
  LAND_PLACE_MEMBERSHIP_PATH,
} from "../site/land_place_membership.mjs";
import {
  LAND_PLACE_PUBLIC_DIR,
  LAND_PLACE_REFRESH_RECEIPT_SCHEMA,
  activateLandPlaceGeneration,
  createLandPlaceRefresh,
  loadActiveLandPlaceGeneration,
  loadLandPlaceRefreshReceipt,
  writeLandPlaceRefreshReceipt,
} from "../site/land_place_refresh.mjs";
import { PARCEL_GEOGRAPHY_MANIFEST_PATH } from "../site/parcel_geography.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PUBLIC_DIR = path.join(ROOT, LAND_PLACE_PUBLIC_DIR);
const DEFAULT_ACTIVE_INDEX = path.join(ROOT, LAND_PLACE_MEMBERSHIP_PATH);
const DEFAULT_ACTIVE_EVIDENCE = path.join(ROOT, LAND_PLACE_EVIDENCE_DIR);
const DEFAULT_CATALOG = path.join(ROOT, LAND_PROJECT_CATALOG_PATH);
const DEFAULT_BBL = path.join(ROOT, LAND_PLACE_BBL_INDEX_PATH);
const DEFAULT_PARCEL_MANIFEST = path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH);
const DEFAULT_PARCEL_DIR = path.join(ROOT, "site/data/parcel-geography");
const DEFAULT_ADDRESS_MANIFEST = path.join(ROOT, "site/data/address-index/manifest.json");

function parseArgs(argv) {
  const args = {
    check: false,
    force: false,
    fixtureDir: null,
    publicDir: DEFAULT_PUBLIC_DIR,
    activeIndexPath: DEFAULT_ACTIVE_INDEX,
    activeEvidenceDir: DEFAULT_ACTIVE_EVIDENCE,
    catalogPath: DEFAULT_CATALOG,
    bblPath: DEFAULT_BBL,
    parcelManifestPath: DEFAULT_PARCEL_MANIFEST,
    parcelDir: DEFAULT_PARCEL_DIR,
    addressManifestPath: DEFAULT_ADDRESS_MANIFEST,
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
    else if (token === "--active-evidence-dir") args.activeEvidenceDir = path.resolve(argv[++index]);
    else if (token === "--catalog") args.catalogPath = path.resolve(argv[++index]);
    else if (token === "--bbl-index") args.bblPath = path.resolve(argv[++index]);
    else if (token === "--parcel-manifest") args.parcelManifestPath = path.resolve(argv[++index]);
    else if (token === "--parcel-dir") args.parcelDir = path.resolve(argv[++index]);
    else if (token === "--address-manifest") args.addressManifestPath = path.resolve(argv[++index]);
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
  maybe("land_project_catalog.json", "catalogPath");
  maybe("zap_bbl_warehouse_lookup.json", "bblPath");
  maybe("parcel-geography/manifest.json", "parcelManifestPath");
  maybe("parcel-geography", "parcelDir");
  maybe("address-index/manifest.json", "addressManifestPath");
  maybe("land-place-generations", "publicDir");
  maybe("land_place_membership.json", "activeIndexPath");
  maybe("land-place-evidence", "activeEvidenceDir");
  mkdirSync(mapped.publicDir, { recursive: true });
  return mapped;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function buildLandPlaceRefreshAdapters(options = {}) {
  const args = applyFixtureDir({
    publicDir: options.publicDir || DEFAULT_PUBLIC_DIR,
    activeIndexPath: options.activeIndexPath || DEFAULT_ACTIVE_INDEX,
    activeEvidenceDir: options.activeEvidenceDir || DEFAULT_ACTIVE_EVIDENCE,
    catalogPath: options.catalogPath || DEFAULT_CATALOG,
    bblPath: options.bblPath || DEFAULT_BBL,
    parcelManifestPath: options.parcelManifestPath || DEFAULT_PARCEL_MANIFEST,
    parcelDir: options.parcelDir || DEFAULT_PARCEL_DIR,
    addressManifestPath: options.addressManifestPath || DEFAULT_ADDRESS_MANIFEST,
    fixtureDir: options.fixtureDir || null,
  });

  mkdirSync(args.publicDir, { recursive: true });

  return {
    args,
    loadSources() {
      if (!existsSync(args.catalogPath)) {
        const error = new Error(`missing catalog: ${args.catalogPath}`);
        error.failure_kind = "missing_catalog";
        throw error;
      }
      const catalog = loadJson(args.catalogPath);
      const bblIndex = existsSync(args.bblPath) ? loadJson(args.bblPath) : null;
      const parcelManifest = existsSync(args.parcelManifestPath)
        ? loadJson(args.parcelManifestPath)
        : null;
      const addressIndexManifest = existsSync(args.addressManifestPath)
        ? loadJson(args.addressManifestPath)
        : null;

      const shardCache = new Map();
      const loadParcelShard = (shardKey) => {
        const key = String(shardKey || "");
        if (shardCache.has(key)) return shardCache.get(key);
        const candidates = [
          path.join(args.parcelDir, `${key}.json`),
          path.join(args.parcelDir, "00.json"),
        ];
        let doc = null;
        for (const filePath of candidates) {
          if (!existsSync(filePath)) continue;
          doc = loadJson(filePath);
          break;
        }
        shardCache.set(key, doc);
        return doc;
      };

      const artifactHashes = {
        catalog: sha256File(args.catalogPath),
        bbl_index: bblIndex ? sha256File(args.bblPath) : null,
        parcel_manifest: parcelManifest ? sha256File(args.parcelManifestPath) : null,
      };

      return {
        catalog,
        bblIndex,
        parcelManifest,
        loadParcelShard,
        artifactHashes,
        addressIndexManifest,
      };
    },
    loadPreviousReceipt: () => loadLandPlaceRefreshReceipt(args.publicDir),
    saveReceipt: (receipt) => writeLandPlaceRefreshReceipt(args.publicDir, receipt),
    loadActiveGeneration: () => (
      loadActiveLandPlaceGeneration(args.publicDir)?.pointer?.active_generation || null
    ),
    activateGeneration: (activationArgs) => activateLandPlaceGeneration({
      publicDir: args.publicDir,
      activeIndexPath: args.activeIndexPath,
      activeEvidenceDir: args.activeEvidenceDir,
      ...activationArgs,
    }),
    activeIndexPath: args.activeIndexPath,
    activeEvidenceDir: args.activeEvidenceDir,
  };
}

export function runLandPlaceRefresh(cliArgs = {}) {
  const adapters = buildLandPlaceRefreshAdapters(cliArgs);
  const refresh = createLandPlaceRefresh(adapters);
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
    console.log(`Usage: node tools/land_place_refresh.mjs [options]
  --check                 Validate the last refresh receipt and active generation
  --force                 Rebuild even when input hashes match
  --fixture-dir DIR       Controlled inputs for rehearsal
  --public-dir DIR        Generation publication directory
  --active-index PATH     Convenience active compact index path
  --active-evidence-dir DIR  Convenience active evidence shard directory
  --inject-failure KIND   Rehearse partial_download|mismatched_boundary|before_activate|mixed_generation`);
    return;
  }

  if (args.check) {
    const receipt = loadLandPlaceRefreshReceipt(args.publicDir);
    const active = loadActiveLandPlaceGeneration(args.publicDir);
    if (!receipt && !active) {
      // Cold derived builds may run --check before the first activation on a
      // fresh tree; treat that as idle rather than failing the boundary.
      console.log("ok land-place-refresh: no receipt yet (idle)");
      return;
    }
    if (receipt && receipt.schema !== LAND_PLACE_REFRESH_RECEIPT_SCHEMA) {
      throw new Error(`unexpected refresh receipt schema: ${receipt.schema}`);
    }
    if (active) {
      const ids = [
        active.index?.generation?.id,
        active.evidence?.generation_id,
        active.reverse?.generation_id,
      ];
      if (ids.some((id) => id && id !== active.pointer.active_generation)) {
        throw new Error("active land place consumers disagree on generation id");
      }
    }
    console.log(
      `ok land-place-refresh ${receipt?.status || "active"}`
      + (active?.pointer?.active_generation ? ` active=${active.pointer.active_generation}` : ""),
    );
    return;
  }

  const result = runLandPlaceRefresh(args);
  const summary = {
    status: result.status,
    ok: result.ok,
    active_generation: result.active_generation,
    previous_active_generation: result.previous_active_generation || null,
    project_count: result.index?.project_count || result.receipt?.project_count || null,
    reasons: result.plan?.reasons || result.receipt?.plan?.reasons || [],
    failed_at: result.receipt?.failed_at || null,
    source_dates: result.receipt?.source_dates || null,
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
