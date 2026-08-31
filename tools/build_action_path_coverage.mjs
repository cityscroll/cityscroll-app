#!/usr/bin/env node
/**
 * Materialize the CAP-8 Action Path coverage receipt from retained fixtures.
 *
 * Usage:
 *   node tools/build_action_path_coverage.mjs
 *   node tools/build_action_path_coverage.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_JSON,
  COVERAGE_MD,
  assembleActionPathCoverageReceipt,
  assertActionPathCoverageReceipt,
  renderActionPathCoverageMarkdown,
  stableStringify,
} from "./lib/action_path_coverage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export function buildActionPathCoverageFromRepo(root = ROOT) {
  const receipt = assembleActionPathCoverageReceipt(root);
  assertActionPathCoverageReceipt(receipt);
  return receipt;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const receipt = buildActionPathCoverageFromRepo(ROOT);
  const jsonPath = path.join(ROOT, COVERAGE_JSON);
  const mdPath = path.join(ROOT, COVERAGE_MD);
  const json = stableStringify(receipt);
  const markdown = renderActionPathCoverageMarkdown(receipt);
  if (args.check) {
    const committedJson = readFileSync(jsonPath, "utf8");
    const committedMd = readFileSync(mdPath, "utf8");
    if (committedJson !== json || committedMd !== markdown) {
      throw new Error("Action Path coverage receipt drifted from retained evidence");
    }
    process.stdout.write("action-path coverage check: ok\n");
    return;
  }
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  process.stdout.write(`wrote ${COVERAGE_JSON} and ${COVERAGE_MD}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
