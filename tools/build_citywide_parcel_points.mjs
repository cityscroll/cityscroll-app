#!/usr/bin/env node
/**
 * Materialize the citywide BBL → parcel-point generation under
 * site/data/parcel-geography as deterministic 256-way BBL shards.
 *
 * Build-time only. Resident reads use the committed shards; MapPLUTO / PLUTO /
 * ArcGIS stay on this offline path — never the resident hot path, and never
 * one request per street address.
 *
 * Acquisition prefers one retained PLUTO CSV (hashed and fully accounted). The
 * fallback enumerates the official ArcGIS object IDs once and fetches exact
 * object-ID batches of at most 1000 with bounded retries and transfer-limit
 * checks. The generation is built and verified in staging first; a truncated
 * batch, a duplicate conflicting BBL point, or a failed page refuses
 * activation and leaves the previous valid generation in place.
 *
 * Usage:
 *   node tools/build_citywide_parcel_points.mjs [--from-pluto-csv PATH | --from-arcgis]
 *   node tools/build_citywide_parcel_points.mjs --check
 *   node tools/build_citywide_parcel_points.mjs --out DIR ...   (tests / rehearsal)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  MAPPLUTO_QUERY,
} from "./lib/mappluto_acquisition.mjs";
import {
  PAD_ONLY_UNMATCHED_FILE,
  buildParcelGeographyGeneration,
  collectPadReferencedBbls,
  ingestArcgisObjectBatches,
  ingestPlutoCsv,
  newIngestState,
  renderParcelShard,
  verifyParcelGeographyGeneration,
} from "./lib/citywide_parcel_points.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, "site", "data", "parcel-geography");
const DEFAULT_PAD_INDEX = path.join(ROOT, "site", "data", "address-index");
const STAGING_DIRNAME = ".staging";
const MANIFEST_FILE = "manifest.json";
const MAPPLUTO_PUBLISHER = "NYC Department of City Planning MapPLUTO/PLUTO";
const DEFAULT_PLUTO_CANDIDATES = [
  process.env.CROL_PLUTO_CSV,
  path.join(ROOT, "warehouse", "raw", "mappluto", "pluto_latest.csv"),
  path.join(os.homedir(), "dev", "nyc-neighborhood-warehouse", "raw_data", "pluto", "pluto_latest.csv"),
].filter(Boolean);

function parseArgs(argv) {
  const out = {
    check: false,
    fromArcgis: false,
    fromPlutoCsv: null,
    out: DEFAULT_OUT,
    padIndex: DEFAULT_PAD_INDEX,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") out.check = true;
    else if (arg === "--from-arcgis") out.fromArcgis = true;
    else if (arg === "--from-pluto-csv") out.fromPlutoCsv = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--pad-index") out.padIndex = argv[++i];
    else if (arg === "--min-parcels") out.minParcels = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.fromArcgis && out.fromPlutoCsv) {
    throw new Error("Cannot combine --from-arcgis and --from-pluto-csv");
  }
  return out;
}

function resolvePlutoCsv(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`PLUTO CSV not found: ${explicit}`);
    return explicit;
  }
  for (const candidate of DEFAULT_PLUTO_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function displaySourcePath(csvPath) {
  return path.isAbsolute(csvPath) && csvPath.startsWith(ROOT)
    ? path.relative(ROOT, csvPath)
    : "external:pluto_latest.csv";
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

/**
 * Build (or verify with options.check) a citywide parcel-point generation.
 * Exported for replay tests; the CLI is a thin wrapper.
 */
async function runBuild(options = {}) {
  const outDir = path.resolve(options.outDir || DEFAULT_OUT);
  if (options.check) {
    const manifest = await verifyParcelGeographyGeneration(outDir, { minParcels: options.minParcels });
    return { manifest, activated: false };
  }
  const padIndexDir = path.resolve(options.padIndexDir || DEFAULT_PAD_INDEX);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const state = newIngestState();
  let source;
  let mode;
  let objectAccounting = null;

  if (options.fromArcgis) {
    mode = "mappluto_arcgis_batch";
    const acquired = await ingestArcgisObjectBatches(state, {
      fetchImpl: options.fetchImpl,
      endpoint: MAPPLUTO_QUERY,
    });
    objectAccounting = acquired.objectAccounting;
    source = {
      kind: "arcgis_batch",
      endpoint: MAPPLUTO_QUERY,
      publisher: "NYC Department of City Planning MapPLUTO FeatureServer",
      sha256: acquired.sha256,
      object_ids: acquired.objectAccounting.object_ids_enumerated,
    };
  } else {
    mode = "mappluto_pluto_csv";
    const csvPath = resolvePlutoCsv(options.fromPlutoCsv);
    if (!csvPath) {
      throw new Error(
        "No PLUTO CSV found. Pass --from-pluto-csv PATH, set CROL_PLUTO_CSV, or use --from-arcgis",
      );
    }
    const { sha256 } = await ingestPlutoCsv(csvPath, state);
    source = {
      kind: "pluto_csv",
      path: displaySourcePath(csvPath),
      publisher: MAPPLUTO_PUBLISHER,
      sha256,
    };
  }

  const padBbls = await collectPadReferencedBbls(padIndexDir);
  const build = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Math.round(performance.now() - started),
  };
  const { manifest, shards, padOnlyUnmatched } = buildParcelGeographyGeneration({
    state,
    padBbls,
    source,
    mode,
    objectAccounting,
    generatedAt: build.completed_at,
    build,
  });

  // Stage the full generation, verify it, and only then activate. Any
  // acquisition or validation failure above never touched outDir; a failure
  // below leaves no staging behind, never a half-active generation.
  const stagingDir = path.join(outDir, STAGING_DIRNAME);
  try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    let shardBytesMin = Number.POSITIVE_INFINITY;
    let shardBytesMax = 0;
    let shardBytesTotal = 0;
    for (const [key, shard] of shards) {
      const rendered = renderParcelShard(shard);
      const bytes = Buffer.byteLength(rendered);
      await atomicWrite(path.join(stagingDir, `${key}.json`), rendered);
      manifest.shards[key] = { file: `./${key}.json`, parcels: Object.keys(shard.parcels).length, bytes, sha256: null };
      shardBytesMin = Math.min(shardBytesMin, bytes);
      shardBytesMax = Math.max(shardBytesMax, bytes);
      shardBytesTotal += bytes;
    }
    for (const key of Object.keys(manifest.shards)) {
      const content = await readFile(path.join(stagingDir, `${key}.json`));
      manifest.shards[key].sha256 = createHash("sha256").update(content).digest("hex");
    }
    if (padOnlyUnmatched.length) {
      await atomicWrite(
        path.join(stagingDir, PAD_ONLY_UNMATCHED_FILE),
        `${JSON.stringify(padOnlyUnmatched)}\n`,
      );
    }
    await atomicWrite(path.join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyParcelGeographyGeneration(stagingDir, { minParcels: options.minParcels });

    // Activate: move verified files into place, manifest last. A previous
    // generation's pad-only list is removed when the new generation has none,
    // so no stale file can contradict the activated manifest.
    mkdirSync(outDir, { recursive: true });
    const entries = [...shards.keys()].map((key) => `${key}.json`);
    if (padOnlyUnmatched.length) entries.push(PAD_ONLY_UNMATCHED_FILE);
    else rmSync(path.join(outDir, PAD_ONLY_UNMATCHED_FILE), { force: true });
    entries.push(MANIFEST_FILE);
    for (const name of entries) {
      await rename(path.join(stagingDir, name), path.join(outDir, name));
    }
    rmSync(stagingDir, { recursive: true, force: true });
    await verifyParcelGeographyGeneration(outDir, { minParcels: options.minParcels });

    return {
      manifest,
      activated: true,
      shardBytes: { min: shardBytesMin, max: shardBytesMax, total: shardBytesTotal },
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.check) {
    const { manifest } = await runBuild({ check: true, outDir: args.out, minParcels: args.minParcels });
    const coverage = manifest.coverage;
    console.log(
      `ok parcel-geography ${manifest.coordinate_vintage}: ` +
        `retained=${coverage.retained_parcels.toLocaleString()} ` +
        `publisher_rows=${coverage.publisher_rows.toLocaleString()} ` +
        `pad_only_unmatched=${coverage.pad_only_unmatched.toLocaleString()} ` +
        `shards=${manifest.shard_count}`,
    );
    return;
  }
  const result = await runBuild({
    fromArcgis: args.fromArcgis,
    fromPlutoCsv: args.fromPlutoCsv,
    outDir: args.out,
    padIndexDir: args.padIndex,
    minParcels: args.minParcels,
  });
  const coverage = result.manifest.coverage;
  const mb = (value) => `${(value / 1024 / 1024).toFixed(1)}MiB`;
  console.log(
    `activated parcel-geography ${result.manifest.coordinate_vintage} ` +
      `mode=${result.manifest.mode} ` +
      `denominator=${coverage.publisher_rows.toLocaleString()} ` +
      `retained=${coverage.retained_parcels.toLocaleString()} ` +
      `excluded=${JSON.stringify(coverage.excluded_rows)} ` +
      `pad_referenced=${coverage.pad_referenced_bbls.toLocaleString()} ` +
      `pad_only_unmatched=${coverage.pad_only_unmatched.toLocaleString()} ` +
      `shard_bytes=${mb(result.shardBytes.min)}..${mb(result.shardBytes.max)}/${mb(result.shardBytes.total)} ` +
      `build_ms=${result.manifest.build.duration_ms}`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { runBuild, verifyParcelGeographyGeneration };
