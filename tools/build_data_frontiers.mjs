#!/usr/bin/env node
// Rebuild (or --check) the data-frontiers markdown projection from per-entry records.
//
//   node tools/build_data_frontiers.mjs
//   node tools/build_data_frontiers.mjs --check
//   node tools/build_data_frontiers.mjs --migrate   # one-shot: split existing .md

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFrontiersProjection,
  migrateFrontiersFromMarkdown,
} from "./lib/data_frontiers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { check: false, migrate: false, edition: "2026-08", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--migrate") args.migrate = true;
    else if (a === "--edition") args.edition = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(`Usage:
  node tools/build_data_frontiers.mjs [--edition 2026-08]
  node tools/build_data_frontiers.mjs --check
  node tools/build_data_frontiers.mjs --migrate`);
    return;
  }
  if (args.migrate) {
    const result = migrateFrontiersFromMarkdown(ROOT, args.edition);
    // Rebuild projection so it matches (should be identity on first migrate).
    const built = buildFrontiersProjection(ROOT, args.edition);
    console.log(
      `migrated edition=${args.edition} entries=${result.entries.length} projection=${built.paths.projectionPath}`,
    );
    return;
  }
  try {
    const result = buildFrontiersProjection(ROOT, args.edition, { check: args.check });
    console.log(
      `data-frontiers ${args.check ? "check ok" : "built"} edition=${args.edition} entries=${result.entries.length}`,
    );
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
