#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildPublishedStorySignalReadModel } from "../site/comparative_signal_admission.mjs";

const COMPARATIVE_FACTS = new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url);
const OUTPUT = new URL("../site/data/comparative_story_signals.json", import.meta.url);

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

export function buildComparativeStorySignalArtifact(readModel) {
  return buildPublishedStorySignalReadModel(readModel?.facts);
}

export function writeComparativeStorySignalArtifact({ check = false } = {}) {
  const artifact = buildComparativeStorySignalArtifact(json(COMPARATIVE_FACTS));
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const stale = !existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== serialized;
  if (check && stale) {
    console.error(`stale comparative story-signal artifact: ${fileURLToPath(OUTPUT)}`);
    process.exitCode = 1;
    return;
  }
  if (!check && stale) writeFileSync(OUTPUT, serialized);
  console.log(stale
    ? `wrote comparative story-signal artifact (${artifact.signals.length} signals)`
    : `comparative story-signal artifact current (${artifact.signals.length} signals)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeComparativeStorySignalArtifact({ check: process.argv.includes("--check") });
}
