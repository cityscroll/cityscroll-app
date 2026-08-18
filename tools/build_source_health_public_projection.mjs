#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionText,
} from "../site/source_health_public_projection.mjs";

export const CONTRACTS_PATH = fileURLToPath(
  new URL("../site/data/source_contracts.json", import.meta.url),
);
export const OBSERVATIONS_PATH = fileURLToPath(
  new URL("../site/data/source_health_observations.json", import.meta.url),
);
export const OUTPUT_PATH = fileURLToPath(
  new URL("../site/data/source_health_public.json", import.meta.url),
);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function generatePublicSourceHealthProjection(options = {}) {
  const registry = options.registry || readJson(CONTRACTS_PATH);
  const observations = options.observations || readJson(OBSERVATIONS_PATH);
  return buildPublicSourceHealthProjection(registry, observations);
}

export function checkPublicSourceHealthProjection(options = {}) {
  const expected = publicSourceHealthProjectionText(generatePublicSourceHealthProjection(options));
  let actual = null;
  try { actual = readFileSync(OUTPUT_PATH, "utf8"); } catch {}
  return actual === expected ? [] : ["site/data/source_health_public.json is stale; rebuild it"];
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  if (check) {
    const findings = checkPublicSourceHealthProjection();
    if (findings.length) {
      for (const finding of findings) console.error(finding);
      process.exitCode = 1;
      return;
    }
    console.log("public source health projection is current");
    return;
  }
  const projection = generatePublicSourceHealthProjection();
  writeFileSync(OUTPUT_PATH, publicSourceHealthProjectionText(projection));
  console.log(`wrote ${projection.source_count} public source health rows`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
