#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNoticeContextReadinessEvidence } from "../site/notice_context_readiness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Fixture-only deterministic builder. Production field evidence is refreshed by
// tools/capture_field_rum_evidence.mjs from the deployed Worker read model.
const INPUT = join(ROOT, "test/fixtures/notice-context-readiness/read-back-input.json");
export function build() {
  return buildNoticeContextReadinessEvidence(JSON.parse(readFileSync(INPUT, "utf8")));
}

function main() {
  if (!process.argv.includes("--fixture")) {
    throw new Error("fixture-only builder; use tools/capture_field_rum_evidence.mjs for production field evidence");
  }
  const evidence = build();
  console.log(`validated deterministic fixture evidence: ${evidence.primary.slo_state}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
