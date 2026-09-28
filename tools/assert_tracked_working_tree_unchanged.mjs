#!/usr/bin/env node
/**
 * Snapshot or compare tracked-path `git status --porcelain` so a suite step
 * cannot rewrite committed files and leave the tree dirty.
 *
 *   node tools/assert_tracked_working_tree_unchanged.mjs --write-baseline PATH
 *   node tools/assert_tracked_working_tree_unchanged.mjs --baseline PATH
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  assertTrackedWorkingTreeUnchanged,
  trackedWorkingTreePorcelain,
} from "../test/helpers/tracked_working_tree.mjs";

function usage() {
  process.stderr.write(
    "Usage: node tools/assert_tracked_working_tree_unchanged.mjs (--write-baseline PATH | --baseline PATH)\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let writeBaseline = null;
  let baseline = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--write-baseline") {
      writeBaseline = argv[++index];
      continue;
    }
    if (token === "--baseline") {
      baseline = argv[++index];
      continue;
    }
    usage();
  }
  if (Boolean(writeBaseline) === Boolean(baseline)) usage();
  return { writeBaseline, baseline };
}

const args = parseArgs(process.argv.slice(2));

try {
  if (args.writeBaseline) {
    mkdirSync(dirname(args.writeBaseline), { recursive: true });
    const porcelain = trackedWorkingTreePorcelain();
    writeFileSync(args.writeBaseline, porcelain ? `${porcelain}\n` : "");
    process.stdout.write(`tracked working tree baseline written\n`);
    process.exit(0);
  }

  const before = readFileSync(args.baseline, "utf8");
  assertTrackedWorkingTreeUnchanged(before);
  process.stdout.write("tracked working tree unchanged\n");
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}
