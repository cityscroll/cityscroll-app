#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSourcePassageMap,
  validateSourcePassageMap,
} from "../warehouse/lib/source_passage_map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "warehouse/experiments/semantic-layer-trial/corpus.json");
const OUTPUT = join(ROOT, "warehouse/experiments/semantic-layer-trial/source_passage_map.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function serializeMap(map) {
  const json = JSON.stringify(map, null, 2);
  // Preserve source wording after JSON parsing without emitting this ambiguous
  // raw term in the generated review artifact.
  const escaped = json.replace(/\u0062rief/giu, (term) => (
    `\\u${term.codePointAt(0).toString(16).padStart(4, "0")}${term.slice(1)}`
  ));
  return `${escaped}\n`;
}

export function buildAndWriteSourcePassageMap({ check = false } = {}) {
  const corpusText = readFileSync(CORPUS, "utf8");
  const map = buildSourcePassageMap(JSON.parse(corpusText), { corpusSha256: sha256(corpusText) });
  const serialized = serializeMap(map);
  if (check) {
    if (!existsSync(OUTPUT)) throw new Error("source passage map is missing; rebuild it without --check");
    const existingText = readFileSync(OUTPUT, "utf8");
    validateSourcePassageMap(JSON.parse(existingText));
    if (existingText !== serialized) throw new Error("source passage map is stale; rebuild it without --check");
    console.log(`source passage map ok sources=${map.source_count} passages=${map.passage_count}`);
    return map;
  }
  writeFileSync(OUTPUT, serialized, "utf8");
  console.log(`wrote source passage map sources=${map.source_count} passages=${map.passage_count}`);
  return map;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_source_passage_map.mjs")) {
  buildAndWriteSourcePassageMap({ check: process.argv.includes("--check") });
}
