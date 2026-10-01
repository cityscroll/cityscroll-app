#!/usr/bin/env node
/**
 * Register-style reader for the geography-navigation synthetic field-vitals aggregate.
 *
 * Distinguishes absent / unread / invalid. Refuses missing required per-cell fields
 * and names the missing field. Does not read or rewrite the resident observation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSyntheticAggregate } from "./lib/geography_navigation_field_vitals_synthetic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-synthetic-aggregate.json",
);

function parseArgs(argv) {
  const args = { path: DEFAULT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--path") args.path = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: node tools/read_geography_navigation_field_vitals_synthetic.mjs [--path <file>]\n`);
    return;
  }

  let raw;
  try {
    raw = readFileSync(args.path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      process.stdout.write(`${JSON.stringify({ ok: false, state: "absent", reason: "aggregate_absent", missing_field: null }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, state: "unread", reason: "aggregate_unread", missing_field: null }, null, 2)}\n`);
    process.exitCode = 3;
    return;
  }

  const result = readSyntheticAggregate(document);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main();
