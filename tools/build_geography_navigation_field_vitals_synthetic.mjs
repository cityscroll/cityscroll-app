#!/usr/bin/env node
/**
 * Build or validate the geography-navigation synthetic field-vitals aggregate.
 *
 *   node tools/build_geography_navigation_field_vitals_synthetic.mjs
 *   node tools/build_geography_navigation_field_vitals_synthetic.mjs --check
 *   node tools/build_geography_navigation_field_vitals_synthetic.mjs --from-slot slot.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyProbeSlot,
  emptySyntheticAggregate,
  readSyntheticAggregate,
} from "./lib/geography_navigation_field_vitals_synthetic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(
  ROOT,
  "docs/evidence/geography-navigation-release/field-vitals-synthetic-aggregate.json",
);

function parseArgs(argv) {
  const args = { check: false, fromSlot: null, init: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--init") args.init = true;
    else if (arg === "--from-slot") args.fromSlot = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: node tools/build_geography_navigation_field_vitals_synthetic.mjs [--check] [--init] [--from-slot <path>]\n`);
    return;
  }

  if (args.init) {
    const document = emptySyntheticAggregate();
    writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`wrote ${OUT_PATH}\n`);
    return;
  }

  if (args.check) {
    const document = loadJson(OUT_PATH);
    const read = readSyntheticAggregate(document);
    if (!read.ok) {
      throw new Error(`synthetic aggregate check failed: ${read.reason} missing_field=${read.missing_field}`);
    }
    process.stdout.write(`ok ${OUT_PATH}\n`);
    return;
  }

  if (args.fromSlot) {
    let aggregate;
    try {
      aggregate = loadJson(OUT_PATH);
    } catch {
      aggregate = emptySyntheticAggregate();
    }
    const slot = loadJson(args.fromSlot);
    const next = applyProbeSlot(aggregate, slot);
    const read = readSyntheticAggregate(next);
    if (!read.ok) {
      throw new Error(`synthetic aggregate invalid after slot: ${read.reason} missing_field=${read.missing_field}`);
    }
    writeFileSync(OUT_PATH, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`wrote ${OUT_PATH} delivery.at=${next.delivery.at}\n`);
    return;
  }

  // Default: ensure a valid empty/current aggregate exists.
  let document;
  try {
    document = loadJson(OUT_PATH);
  } catch {
    document = emptySyntheticAggregate();
  }
  const read = readSyntheticAggregate(document);
  if (!read.ok) {
    throw new Error(`synthetic aggregate invalid: ${read.reason} missing_field=${read.missing_field}`);
  }
  writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`wrote ${OUT_PATH}\n`);
}

main();
