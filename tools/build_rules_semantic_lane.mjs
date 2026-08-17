#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRulesSemanticLane } from "../site/rules_semantic_lane.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/data/rules_semantic_lane.json");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

export function buildRulesSemanticLaneArtifact() {
  return buildRulesSemanticLane({
    corpusManifest: readJson("warehouse/manifests/semantic_retrieval_corpus_manifest.json"),
    passageMap: readJson("warehouse/experiments/semantic-layer-trial/source_passage_map.json"),
    retrievalReview: readJson("warehouse/experiments/semantic-layer-trial/receipts/retrieval_review.json"),
    rulesSnapshot: readJson("site/data/rules_domain_observations.json"),
  });
}

export function buildAndWriteRulesSemanticLane({ check = false } = {}) {
  const serialized = `${JSON.stringify(buildRulesSemanticLaneArtifact(), null, 2)}\n`;
  if (check) {
    if (!existsSync(OUTPUT)) throw new Error("Rules semantic lane artifact is missing; rebuild it without --check");
    if (readFileSync(OUTPUT, "utf8") !== serialized) throw new Error("Rules semantic lane artifact is stale; rebuild it without --check");
    console.log("Rules semantic lane artifact ok");
    return;
  }
  writeFileSync(OUTPUT, serialized);
  console.log("wrote Rules semantic lane artifact");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_rules_semantic_lane.mjs")) {
  buildAndWriteRulesSemanticLane({ check: process.argv.includes("--check") });
}
