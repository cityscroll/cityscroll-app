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
  const asOf = options.asOf || inputs.asOf || process.env.DESK_PUBLICATION_OBSERVATION_AT || null;
  return buildSourceHealthObservations(registry, asOf ? { ...inputs, asOf } : inputs);
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
  const asOf = optionValue(argv, "--as-of");
  const unknown = argv.filter((arg, index) => (
    !["--check", "--external-schedule-state-dir", "--as-of"].includes(arg)
    && !["--external-schedule-state-dir", "--as-of"].includes(argv[index - 1])
  ));
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  if (argv.includes("--as-of") && (!asOf || !Number.isFinite(Date.parse(asOf)))) {
    throw new Error("--as-of requires a valid ISO timestamp");
  }
  const options = { externalScheduleStateDir, asOf };
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
