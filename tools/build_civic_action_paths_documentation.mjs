#!/usr/bin/env node
/**
 * Materialize the CAP-9 Civic Action Path documentation receipt.
 *
 * Usage:
 *   node tools/build_civic_action_paths_documentation.mjs
 *   node tools/build_civic_action_paths_documentation.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOCUMENTATION_JSON,
  DOCUMENTATION_MD,
  assembleCivicActionPathsDocumentationReceipt,
  assertCivicActionPathsDocumentationReceipt,
  renderCivicActionPathsDocumentationMarkdown,
  stableStringify,
} from "./lib/civic_action_paths_documentation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export function buildCivicActionPathsDocumentationFromRepo(root = ROOT) {
  const receipt = assembleCivicActionPathsDocumentationReceipt(root);
  assertCivicActionPathsDocumentationReceipt(receipt, root);
  return receipt;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const receipt = buildCivicActionPathsDocumentationFromRepo(ROOT);
  const jsonPath = path.join(ROOT, DOCUMENTATION_JSON);
  const mdPath = path.join(ROOT, DOCUMENTATION_MD);
  const json = stableStringify(receipt);
  const markdown = renderCivicActionPathsDocumentationMarkdown(receipt);
  if (args.check) {
    const committedJson = readFileSync(jsonPath, "utf8");
    const committedMd = readFileSync(mdPath, "utf8");
    if (committedJson !== json || committedMd !== markdown) {
      throw new Error("Civic Action Path documentation receipt drifted from retained evidence");
    }
    process.stdout.write("civic-action-paths documentation check: ok\n");
    return;
  }
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, markdown);
  process.stdout.write(`wrote ${DOCUMENTATION_JSON} and ${DOCUMENTATION_MD}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
