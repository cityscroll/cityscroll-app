#!/usr/bin/env node
/**
 * Materialize parcel memberships onto the committed citywide parcel-point
 * generation under site/data/parcel-geography.
 *
 * Build-time only. Each parcel shard gains typed memberships against the
 * registered full-fidelity borough, community-district, Council-district,
 * NTA2020 and police-precinct polygons, with per-layer status, independent
 * vintages, and full-polygon provenance. The exact point-in-polygon
 * predicate decides every match behind a bbox candidate index; boundary
 * matches are retained; simplified display geometry is refused.
 *
 * Layer-content changes recompute only the changed layer's values: when a
 * layer's artifact digest and the input point digest are unchanged, the
 * previous stored values are carried over verbatim. Points and the point
 * build receipt are never rewritten. A refused or failed build leaves the
 * previous valid generation in place.
 *
 * Usage:
 *   node tools/build_parcel_memberships.mjs
 *   node tools/build_parcel_memberships.mjs --check
 *   node tools/build_parcel_memberships.mjs --parcel-dir DIR --out DIR   (tests / rehearsal)
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  PARCEL_MEMBERSHIP_LAYERS,
  PARCEL_MEMBERSHIP_MANIFEST_SCHEMA,
  parcelShardMembershipFindings,
} from "../site/parcel_geography.mjs";
import { validateCivicGeographyRegistry } from "../site/civic_geography_registry.mjs";
import {
  PAD_ONLY_UNMATCHED_FILE,
  verifyParcelGeographyGeneration,
} from "./lib/citywide_parcel_points.mjs";
import {
  SimplifiedGeometryRefusalError,
  loadMembershipLayer,
  materializeParcelMemberships,
} from "./lib/parcel_membership_materialization.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PARCEL_DIR = path.join(ROOT, "site", "data", "parcel-geography");
const DEFAULT_REGISTRY = path.join(ROOT, "site", "data", "geography", "layer_registry.json");
const STAGING_DIRNAME = ".staging";
const MANIFEST_FILE = "manifest.json";

function parseArgs(argv) {
  const out = {
    check: false,
    parcelDir: DEFAULT_PARCEL_DIR,
    out: null,
    registry: DEFAULT_REGISTRY,
    minParcels: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") out.check = true;
    else if (arg === "--parcel-dir") out.parcelDir = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--layer-registry") out.registry = argv[++i];
    else if (arg === "--min-parcels") out.minParcels = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

async function readGeneration(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
  const shardDocs = new Map();
  for (const key of Object.keys(manifest.shards || {})) {
    const descriptor = manifest.shards[key];
    const shardPath = path.join(dir, path.basename(descriptor.file || `${key}.json`));
    shardDocs.set(key, JSON.parse(await readFile(shardPath, "utf8")));
  }
  return { manifest, shardDocs };
}

async function loadRegistryLayers(registryPath, root) {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const registryErrors = validateCivicGeographyRegistry(registry);
  if (registryErrors.length) {
    throw new Error(`geography layer registry invalid: ${registryErrors.join("; ")}`);
  }
  const rows = new Map(registry.layers.map((row) => [row.type, row]));
  const layers = new Map();
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    layers.set(type, await loadMembershipLayer(rows.get(type), root, readFile));
  }
  return { registry, layers };
}

/** Verify a directory's membership generation against the current registry. */
async function verifyMembershipGeneration(dir, { registryPath, minParcels, allowUnavailableLayers = false } = {}) {
  const { manifest, shardDocs } = await readGeneration(dir);
  await verifyParcelGeographyGeneration(dir, { minParcels });
  const block = manifest.membership;
  const findings = [];
  if (block?.schema !== PARCEL_MEMBERSHIP_MANIFEST_SCHEMA) {
    throw new Error("parcel-geography manifest has no membership generation to verify");
  }
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const rows = new Map(registry.layers.map((row) => [row.type, row]));
  const retained = Number(manifest.coverage?.retained_parcels);
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const layer = block.layers?.[type];
    if (!layer) {
      findings.push(`membership manifest layer ${type} missing`);
      continue;
    }
    if (layer.status !== "resolved") {
      if (allowUnavailableLayers) {
        const counts = layer.counts || {};
        if (Number(counts.parcels) !== retained || Number(counts.source_unavailable) !== retained) {
          findings.push(`membership layer ${type} unavailable counts do not account for the retained population`);
        }
        continue;
      }
      findings.push(`membership layer ${type} is ${layer.status}; the committed generation must resolve every registered layer`);
      continue;
    }
    if (layer.geometry_fidelity !== "full") {
      findings.push(`membership layer ${type} provenance is not full fidelity`);
    }
    if (layer.artifact_path !== rows.get(type)?.artifacts?.full?.path) {
      findings.push(`membership layer ${type} artifact ${layer.artifact_path} is not the registry's current full artifact`);
      continue;
    }
    const bytes = await readFile(path.join(ROOT, layer.artifact_path));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== layer.sha256) {
      findings.push(`membership layer ${type} provenance digest does not match the current artifact bytes`);
      continue;
    }
    const counts = layer.counts || {};
    const sum = Number(counts.matched) + Number(counts.not_covered) + Number(counts.ambiguous_boundary);
    if (Number(counts.parcels) !== retained || sum !== retained) {
      findings.push(`membership layer ${type} counts do not account for the retained population`);
    }
    const doc = JSON.parse(bytes.toString("utf8"));
    if (doc.geometry_fidelity !== "full") {
      findings.push(`membership layer ${type} current artifact is not full fidelity`);
    }
  }
  if (Number(block.resolved_parcels) !== retained) {
    findings.push(`membership resolved_parcels ${block.resolved_parcels} != retained ${retained}`);
  }
  const build = block.build;
  if (!build || !(Number(build.duration_ms) >= 0) || !(Number(build.resolve_ms) >= 0) || !(Number(build.index_ms) >= 0)) {
    findings.push("membership build timing receipt missing");
  }
  for (const [key, shard] of shardDocs) {
    const shardFindings = parcelShardMembershipFindings(shard);
    for (const finding of shardFindings) findings.push(`shard ${key}: ${finding}`);
    for (const type of PARCEL_MEMBERSHIP_LAYERS) {
      const headerLayer = shard.memberships?.layers?.[type];
      const manifestLayer = block.layers?.[type];
      if (!headerLayer || !manifestLayer) continue;
      if (headerLayer.sha256 !== manifestLayer.sha256 || headerLayer.vintage !== manifestLayer.vintage) {
        findings.push(`shard ${key}: ${type} provenance differs from the manifest`);
      }
    }
  }
  if (findings.length) throw new Error(findings.join("; "));
  return manifest;
}

/**
 * Build (or verify with options.check) the parcel membership generation.
 * Exported for replay tests; the CLI is a thin wrapper.
 */
async function runMembershipBuild(options = {}) {
  const parcelDir = path.resolve(options.parcelDir || DEFAULT_PARCEL_DIR);
  const outDir = path.resolve(options.outDir || options.parcelDir || DEFAULT_PARCEL_DIR);
  const registryPath = path.resolve(options.registryPath || DEFAULT_REGISTRY);
  const minParcels = options.minParcels;
  const allowUnavailableLayers = Boolean(options.allowUnavailableLayers);
  if (options.check) {
    const manifest = await verifyMembershipGeneration(parcelDir, { registryPath, minParcels, allowUnavailableLayers });
    return { manifest, activated: false };
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { manifest: inputManifest, shardDocs } = await readGeneration(parcelDir);
  const { layers } = await loadRegistryLayers(registryPath, ROOT);
  const { shards, membership } = await materializeParcelMemberships({
    manifest: inputManifest,
    shardDocs,
    layers,
    impl: options.impl,
    timing: options.timing,
  });
  // Finalize the measured receipt now that materialization has finished; a
  // pinned timing (replay tests) always wins over the wall clock.
  membership.build = {
    started_at: options.timing?.startedAt || startedAt,
    completed_at: options.timing?.completedAt || new Date().toISOString(),
    duration_ms: Number.isFinite(options.timing?.durationMs)
      ? options.timing.durationMs
      : Math.round(performance.now() - started),
    index_ms: membership.build.index_ms,
    resolve_ms: membership.build.resolve_ms,
  };

  const manifest = JSON.parse(JSON.stringify(inputManifest));
  manifest.membership = membership;

  const stagingDir = path.join(outDir, STAGING_DIRNAME);
  try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    for (const [key, shard] of shards) {
      const rendered = `${JSON.stringify(shard)}\n`;
      const bytes = Buffer.byteLength(rendered);
      const sha256 = createHash("sha256").update(rendered).digest("hex");
      await atomicWrite(path.join(stagingDir, `${key}.json`), rendered);
      manifest.shards[key] = { file: `./${key}.json`, parcels: Object.keys(shard.parcels).length, bytes, sha256 };
    }
    // The PAD-only unmatched list belongs to the point generation; carry it
    // forward unchanged so staged and activated verifications both see the
    // complete generation the manifest describes.
    const entries = [...shards.keys()].map((key) => `${key}.json`);
    const padOnlyCount = Number(inputManifest.coverage?.pad_only_unmatched || 0);
    if (padOnlyCount > 0) {
      const padOnlyBytes = await readFile(path.join(parcelDir, PAD_ONLY_UNMATCHED_FILE));
      await atomicWrite(path.join(stagingDir, PAD_ONLY_UNMATCHED_FILE), padOnlyBytes);
      entries.push(PAD_ONLY_UNMATCHED_FILE);
    } else {
      rmSync(path.join(outDir, PAD_ONLY_UNMATCHED_FILE), { force: true });
    }
    await atomicWrite(path.join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    // Stage verification: full point-generation gate plus the membership
    // generation gate, both against the staged tree, before activation.
    await verifyParcelGeographyGeneration(stagingDir, { minParcels });
    await verifyMembershipGeneration(stagingDir, { registryPath, minParcels, allowUnavailableLayers });

    mkdirSync(outDir, { recursive: true });
    entries.push(MANIFEST_FILE);
    for (const name of entries) {
      await rename(path.join(stagingDir, name), path.join(outDir, name));
    }
    rmSync(stagingDir, { recursive: true, force: true });
    await verifyParcelGeographyGeneration(outDir, { minParcels });
    await verifyMembershipGeneration(outDir, { registryPath, minParcels, allowUnavailableLayers });
    return { manifest, activated: true };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.check) {
    const { manifest } = await runMembershipBuild({ check: true, parcelDir: args.parcelDir, registryPath: args.registry, minParcels: args.minParcels });
    const coverage = manifest.coverage;
    const layerSummary = PARCEL_MEMBERSHIP_LAYERS.map((type) => {
      const layer = manifest.membership.layers[type];
      return `${type}=${layer.status === "resolved" ? layer.vintage : layer.status}`;
    }).join(" ");
    console.log(
      `ok parcel-memberships ${manifest.coordinate_vintage}: ` +
        `parcels=${coverage.retained_parcels.toLocaleString()} ` +
        `${layerSummary}`,
    );
    return;
  }
  const result = await runMembershipBuild({
    parcelDir: args.parcelDir,
    outDir: args.out,
    registryPath: args.registry,
    minParcels: args.minParcels,
  });
  const block = result.manifest.membership;
  const layerSummary = PARCEL_MEMBERSHIP_LAYERS.map((type) => {
    const layer = block.layers[type];
    return `${type}:${layer.computation || layer.status}`;
  }).join(" ");
  console.log(
    `activated parcel-memberships over ${block.resolved_parcels.toLocaleString()} parcels ` +
      `${layerSummary} build_ms=${block.build.duration_ms} ` +
      `(index_ms=${block.build.index_ms} resolve_ms=${block.build.resolve_ms})`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof SimplifiedGeometryRefusalError ? error.message : error?.stack || error);
    process.exitCode = 1;
  });
}

export { runMembershipBuild, verifyMembershipGeneration };
