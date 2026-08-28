#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadSourceContracts } from "./source_contracts.mjs";
import {
  buildSourceVintageObservations,
  loadSourceVintageInputs,
  sourceVintageProjectionText,
} from "./source_vintage_observations.mjs";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const OUTPUT_PATH = fileURLToPath(
  new URL("../site/data/source_vintage_observations.json", import.meta.url),
);

export function generateSourceVintageObservations(options = {}) {
  const registry = options.registry || loadSourceContracts();
  const inputs = options.inputs || loadSourceVintageInputs(ROOT, registry, options);
  return buildSourceVintageObservations(registry, inputs);
}

export function checkSourceVintageObservations(options = {}) {
  const expected = sourceVintageProjectionText(generateSourceVintageObservations(options));
  let actual = null;
  try { actual = readFileSync(OUTPUT_PATH, "utf8"); } catch {}
  return actual === expected ? [] : ["site/data/source_vintage_observations.json is stale; rebuild it"];
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  if (check) {
    const findings = checkSourceVintageObservations();
    if (findings.length) {
      for (const finding of findings) console.error(finding);
      process.exitCode = 1;
      return;
    }
    console.log("source vintage observations are current");
    return;
  }
  const projection = generateSourceVintageObservations();
  writeFileSync(OUTPUT_PATH, sourceVintageProjectionText(projection));
  console.log(`wrote ${projection.observations.length} source vintage observations`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
