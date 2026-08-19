#!/usr/bin/env node

import { createHash } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_PATH = join(ROOT, "docs/evidence/rum-collector-foundation/overhead.json");
const ASSET_PATHS = Object.freeze([
  "site/rum_bootstrap.mjs",
  "site/rum_collector.mjs",
  "site/vendor/web-vitals-6.0.1.mjs",
]);

function assetEvidence(path) {
  const bytes = readFileSync(join(ROOT, path));
  return {
    path,
    raw_bytes: bytes.byteLength,
    gzip_bytes: gzipSync(bytes, { level: 9 }).byteLength,
    brotli_bytes: brotliCompressSync(bytes).byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function siteRuntimeSources(directory = join(ROOT, "site")) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "data" && entry.name !== "vendor") found.push(...siteRuntimeSources(path));
    } else if (/\.(?:html|js|mjs)$/.test(entry.name) && !ASSET_PATHS.some((asset) => join(ROOT, asset) === path)) {
      found.push(path);
    }
  }
  return found;
}

export function buildRumCollectorOverheadEvidence() {
  const assets = ASSET_PATHS.map(assetEvidence);
  const productionReferences = siteRuntimeSources().filter((path) => (
    readFileSync(path, "utf8").includes("rum_bootstrap.mjs")
  ));
  const transportSource = ASSET_PATHS.slice(0, 2)
    .map((path) => readFileSync(join(ROOT, path), "utf8"))
    .join("\n");
  return {
    schema: "cityscroll.rum_collector_overhead.v1",
    collector_version: "rum-browser-v1",
    library: {
      name: "web-vitals",
      version: "6.0.1",
      build: "standard",
      self_hosted: true,
    },
    assets: {
      files: assets,
      total_raw_bytes: assets.reduce((sum, asset) => sum + asset.raw_bytes, 0),
      total_gzip_bytes: assets.reduce((sum, asset) => sum + asset.gzip_bytes, 0),
      total_brotli_bytes: assets.reduce((sum, asset) => sum + asset.brotli_bytes, 0),
    },
    production_default: {
      collector_requested: productionReferences.length > 0,
      production_reference_count: productionReferences.length,
      network_write_implementation: /sendBeacon|performance-events|method\s*:\s*["']POST["']/.test(transportSource),
    },
    scheduling: {
      after_load: /addEventListener(?:\?\.)?\("load"/.test(transportSource),
      idle_task: /requestIdleCallback/.test(transportSource),
    },
    interpretation: "The complete test-only payload is measured for future activation. Production requests zero collector bytes because no production runtime source loads the bootstrap.",
  };
}

export function loadRumCollectorOverheadEvidence() {
  return JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const measured = render(buildRumCollectorOverheadEvidence());
  if (process.argv.includes("--check")) {
    if (!existsSync(EVIDENCE_PATH) || readFileSync(EVIDENCE_PATH, "utf8") !== measured) {
      console.error("RUM collector overhead evidence is stale; run with --write");
      process.exitCode = 1;
    }
    return;
  }
  if (!process.argv.includes("--write")) {
    process.stdout.write(measured);
    return;
  }
  writeFileSync(EVIDENCE_PATH, measured);
  console.log(`wrote ${EVIDENCE_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
