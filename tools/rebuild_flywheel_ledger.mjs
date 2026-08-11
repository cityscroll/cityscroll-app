#!/usr/bin/env node
// Fold the per-card multi-flywheel ledger and optionally write a full aggregate.
//
//   node tools/rebuild_flywheel_ledger.mjs           # print card_count + sample
//   node tools/rebuild_flywheel_ledger.mjs --check   # verify store loads
//   node tools/rebuild_flywheel_ledger.mjs --write-aggregate  # full ledger.json dump

import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
  loadLedgerStore,
  writeLedgerStore,
  LEDGER_STORAGE_VERSION,
} from "../ontology/ledger_store.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = join(ROOT, "ontology/queue/ledger.json");

function parseArgs(argv) {
  const args = {
    ledger: DEFAULT_LEDGER,
    check: false,
    writeAggregate: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ledger") args.ledger = resolve(argv[++i]);
    else if (a === "--check") args.check = true;
    else if (a === "--write-aggregate") args.writeAggregate = true;
    else if (a === "--json") args.json = true;
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
  node tools/rebuild_flywheel_ledger.mjs [--ledger path] [--check] [--write-aggregate] [--json]`);
    return;
  }
  const ledger = loadLedgerStore(args.ledger);
  const n = Object.keys(ledger.cards || {}).length;
  if (n < 1 && args.check) {
    console.error("rebuild_flywheel_ledger --check: expected at least one card");
    process.exitCode = 1;
    return;
  }
  if (args.writeAggregate) {
    writeLedgerStore(args.ledger, ledger, {
      dirtyIds: [],
      writeAggregate: true,
      writePointer: false,
    });
    console.error(`wrote full aggregate projection cards=${n}`);
  } else if (!args.json) {
    // Refresh thin pointer so card_count stays honest after manual entry edits.
    writeLedgerStore(args.ledger, ledger, {
      dirtyIds: [],
      writeAggregate: false,
      writePointer: true,
    });
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  } else {
    console.log(
      `flywheel ledger storage=${LEDGER_STORAGE_VERSION} cards=${n} updated_at=${ledger.updated_at}`,
    );
  }
}

main();
