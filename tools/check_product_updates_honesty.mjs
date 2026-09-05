#!/usr/bin/env node

// Check a product-update batch, assembled outside this repository from the
// public candidate-updates artifact, against that same artifact and the
// public demo manifest. Prints a deterministic receipt and exits non-zero
// whenever the batch is not deliverable — see site/product_updates_honesty.mjs
// for what "deliverable" requires.
//
// Usage:
//   node tools/check_product_updates_honesty.mjs <batch.json>
//     [--artifact=path/to/product-updates.json]
//     [--demo-manifest=path/to/demo-links.json]

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkBatchHonesty, serializeHonestyReceipt } from "../site/product_updates_honesty.mjs";

export const DEFAULT_ARTIFACT_URL = new URL("../site/product-updates.json", import.meta.url);
export const DEFAULT_DEMO_MANIFEST_URL = new URL("../site/demo/demo-links.json", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) {
      flags[match[1]] = match[2];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export function runCheck(argv) {
  const { positional, flags } = parseArgs(argv);
  const batchPath = positional[0] || flags.batch;
  if (!batchPath) {
    throw new Error("usage: check_product_updates_honesty.mjs <batch.json> [--artifact=path] [--demo-manifest=path]");
  }
  const artifactPath = flags.artifact || fileURLToPath(DEFAULT_ARTIFACT_URL);
  const demoManifestPath = flags["demo-manifest"] || fileURLToPath(DEFAULT_DEMO_MANIFEST_URL);
  const batch = readJson(batchPath);
  const artifact = readJson(artifactPath);
  const demoManifest = readJson(demoManifestPath);
  return checkBatchHonesty({ artifact, demoManifest, batch });
}

function main(argv = process.argv.slice(2)) {
  let receipt;
  try {
    receipt = runCheck(argv);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
    return;
  }
  console.log(serializeHonestyReceipt(receipt));
  if (!receipt.deliverable) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
