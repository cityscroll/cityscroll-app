#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNoticePrimaryReadinessEvidence } from "../site/notice_primary_readiness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "test/fixtures/notice-primary-readiness/read-back-input.json");
const OUTPUT = join(ROOT, "docs/evidence/notice-primary-readiness/read-back.json");
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function build() {
  return buildNoticePrimaryReadinessEvidence(JSON.parse(readFileSync(INPUT, "utf8")));
}

function main() {
  const evidence = build();
  const bytes = serialized(evidence);
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== bytes) {
      throw new Error(`stale notice primary readiness evidence: ${OUTPUT}`);
    }
    console.log(`checked notice primary readiness evidence: ${evidence.comparison.state}`);
    return;
  }
  writeFileSync(OUTPUT, bytes);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
