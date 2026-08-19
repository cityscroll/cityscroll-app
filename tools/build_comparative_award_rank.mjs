#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAwardRankComparativeReadModel } from "../site/comparative_award_rank.mjs";

const AWARDS = new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url);
const SOURCE_CONTRACTS = new URL("../site/data/source_contracts.json", import.meta.url);
const OUTPUT = new URL("../site/data/comparative_award_rank_receipts.json", import.meta.url);
const PILOT_SUBJECT_IDS = Object.freeze(["20240119104"]);

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

export function buildComparativeAwardRankArtifact(lookup, sourceContracts) {
  const sourceContract = (Array.isArray(sourceContracts?.contracts) ? sourceContracts.contracts : [])
    .find((contract) => contract.id === "ocp-recent-contract-awards") || null;
  return buildAwardRankComparativeReadModel(lookup, {
    sourceContract,
    sourceContractsSchemaVersion: sourceContracts?.schema_version,
    subjectIds: PILOT_SUBJECT_IDS,
    windowStart: "2024-01-01",
  });
}

export function writeComparativeAwardRankArtifact({ check = false } = {}) {
  const artifact = buildComparativeAwardRankArtifact(json(AWARDS), json(SOURCE_CONTRACTS));
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const stale = !existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== serialized;
  if (check && stale) {
    console.error(`stale comparative award-rank artifact: ${fileURLToPath(OUTPUT)}`);
    process.exitCode = 1;
    return;
  }
  if (!check && stale) writeFileSync(OUTPUT, serialized);
  console.log(stale
    ? `wrote comparative award-rank artifact (${artifact.facts.length} facts)`
    : `comparative award-rank artifact current (${artifact.facts.length} facts)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeComparativeAwardRankArtifact({ check: process.argv.includes("--check") });
}
