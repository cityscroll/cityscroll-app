#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadSourceContracts } from "./source_contracts.mjs";
import {
  buildSourceHealthObservations,
  loadSourceHealthInputs,
  sourceHealthProjectionText,
} from "./source_health_observations.mjs";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const OUTPUT_PATH = fileURLToPath(
  new URL("../site/data/source_health_observations.json", import.meta.url),
);

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function generateSourceHealthObservations(options = {}) {
  const registry = options.registry || loadSourceContracts();
  const inputs = options.inputs || loadSourceHealthInputs(ROOT, registry, {
    externalScheduleStateDir:
      options.externalScheduleStateDir
      || process.env.CROL_EXTERNAL_SCHEDULE_STATE_DIR
      || null,
  });
  return buildSourceHealthObservations(registry, inputs);
}

export function checkSourceHealthObservations(options = {}) {
  const expected = sourceHealthProjectionText(generateSourceHealthObservations(options));
  let actual = null;
  try { actual = readFileSync(OUTPUT_PATH, "utf8"); } catch {}
  return actual === expected ? [] : ["site/data/source_health_observations.json is stale; rebuild it"];
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const externalScheduleStateDir = optionValue(argv, "--external-schedule-state-dir");
  const unknown = argv.filter((arg, index) => (
    !["--check", "--external-schedule-state-dir"].includes(arg)
    && argv[index - 1] !== "--external-schedule-state-dir"
  ));
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  const options = { externalScheduleStateDir };
  if (check) {
    const findings = checkSourceHealthObservations(options);
    if (findings.length) {
      for (const finding of findings) console.error(finding);
      process.exitCode = 1;
      return;
    }
    console.log("source health observations are current");
    return;
  }
  const projection = generateSourceHealthObservations(options);
  writeFileSync(OUTPUT_PATH, sourceHealthProjectionText(projection));
  console.log(`wrote ${projection.observations.length} source health observations`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
