#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AWARD_SOURCE_REGISTRY } from "../external_awards.js";
import {
  DOC_PATH,
  README_PATH,
  awardCoverage,
  loadSourceContracts,
  renderReadmeSourceBlock,
  renderSourceDocument,
  replaceReadmeSourceBlock,
  validateSourceContracts,
} from "./source_contracts.mjs";

export function generatedSourceFiles() {
  const registry = loadSourceContracts();
  const errors = validateSourceContracts(registry);
  if (errors.length) throw new Error(errors.join("\n"));
  const coverage = awardCoverage(AWARD_SOURCE_REGISTRY);
  const block = renderReadmeSourceBlock(registry, coverage);
  return {
    [DOC_PATH]: renderSourceDocument(registry, coverage),
    [README_PATH]: replaceReadmeSourceBlock(readFileSync(README_PATH, "utf8"), block),
  };
}

export function checkGeneratedSourceFiles() {
  const mismatches = [];
  for (const [path, expected] of Object.entries(generatedSourceFiles())) {
    let actual = "";
    try { actual = readFileSync(path, "utf8"); } catch { /* missing output */ }
    if (actual !== expected) mismatches.push(path);
  }
  return mismatches;
}

function main() {
  const check = process.argv.includes("--check");
  const files = generatedSourceFiles();
  if (check) {
    const mismatches = checkGeneratedSourceFiles();
    if (mismatches.length) {
      for (const path of mismatches) console.error(`out of date: ${path}`);
      process.exitCode = 1;
      return;
    }
    console.log(`source docs current (${Object.keys(files).length} files)`);
    return;
  }
  for (const [path, contents] of Object.entries(files)) writeFileSync(path, contents);
  console.log(`generated ${Object.keys(files).length} source docs`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
