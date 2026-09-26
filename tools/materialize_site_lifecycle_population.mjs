#!/usr/bin/env node
/**
 * Scheduled caller for parcel-history population.
 *
 *   node tools/materialize_site_lifecycle_population.mjs \
 *     --inputs warehouse/fixtures/site-lifecycle-population/kingsbridge_caller_inputs.json \
 *     --output-dir /tmp/site-lifecycle-population \
 *     --population-receipt warehouse/receipts/proof/site_lifecycle_population_latest.json
 *
 * Production mode refuses fixture-only invented identifiers. The population
 * receipt records an open scheduled-observation slot for the first post-deploy
 * cycle read-back.
 */

import { resolve } from "node:path";
import {
  readSiteLifecycleCallerInputs,
  runSiteLifecyclePopulationCaller,
} from "./lib/site_lifecycle_population.mjs";

function parseArgs(argv) {
  const args = {
    inputsPath: null,
    outputDir: null,
    membershipReceiptPath: null,
    populationReceiptPath: null,
    shardSize: undefined,
    mode: "production",
    generatedAt: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--inputs") args.inputsPath = resolve(argv[++i]);
    else if (arg === "--output-dir") args.outputDir = resolve(argv[++i]);
    else if (arg === "--membership-receipt") args.membershipReceiptPath = resolve(argv[++i]);
    else if (arg === "--population-receipt") args.populationReceiptPath = resolve(argv[++i]);
    else if (arg === "--shard-size") args.shardSize = Number(argv[++i]);
    else if (arg === "--mode") args.mode = String(argv[++i] || "production");
    else if (arg === "--generated-at") args.generatedAt = String(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.inputsPath || !args.outputDir || !args.populationReceiptPath) {
  console.log(`Usage: node tools/materialize_site_lifecycle_population.mjs --inputs <json> --output-dir <dir> --population-receipt <json> [--membership-receipt <json>] [--shard-size N] [--mode production|fixture]`);
  process.exit(args.help ? 0 : 2);
}

const inputs = readSiteLifecycleCallerInputs(args.inputsPath);
const result = runSiteLifecyclePopulationCaller({
  inputs,
  callerInputsPath: args.inputsPath,
  mode: args.mode,
  outputDir: args.outputDir,
  membershipReceiptPath: args.membershipReceiptPath,
  populationReceiptPath: args.populationReceiptPath,
  shardSize: args.shardSize,
  generatedAt: args.generatedAt,
});

console.log(JSON.stringify({
  status: result.receipt.status,
  mode: result.receipt.mode,
  generation: result.receipt.generation,
  counts: result.receipt.counts,
  shards: result.receipt.shards,
  population_receipt: args.populationReceiptPath,
  output_dir: args.outputDir,
}, null, 2));
