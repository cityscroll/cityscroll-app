#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { freshnessFindings } from "./artifact_manifest.mjs";
import { checkServedArtifactFreshness } from "./check_served_artifact_freshness.mjs";
import {
  buildReleaseSurfaceReceipt,
  evaluateGeneratedEvidenceFreshness,
  evaluateGenerationReceipt,
  evaluateServedArtifactFreshness,
  reconcileCardProjection,
  sha256Text,
  writeReleaseSurfaceReceipt,
} from "./release_surface_reconciliation.mjs";

const DEFAULT_OUTPUT = ".artifacts/release-surface-receipt.json";

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function json(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function loadReceipt(path) {
  try {
    const text = readFileSync(resolve(path), "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !parsed.source_hash) {
      return {
        ...parsed,
        source_contract_id: parsed.source_contract_id || parsed.schema || null,
        status: parsed.status || "succeeded",
        source_hash: sha256Text(text),
      };
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requiredStages(argv) {
  const value = argument(argv, "--required-stages", "generation_output,card_reconciliation,generated_evidence_freshness,served_artifact_freshness");
  return value.split(",").map((stage) => stage.trim()).filter(Boolean);
}

async function main(argv = process.argv.slice(2)) {
  const generationPath = argument(argv, "--generation-receipt", ".artifacts/generation-output-receipt.json");
  const outputPath = argument(argv, "--output", DEFAULT_OUTPUT);
  const sourceCommitSha = argument(argv, "--source-commit", process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || null);
  const expectedManifestPath = argument(argv, "--expected-manifest");
  const expectedManifest = expectedManifestPath ? json(expectedManifestPath) : undefined;
  const stages = {
    generation_output: evaluateGenerationReceipt(json(generationPath), {
      sourceCommitSha,
      expectedManifest,
    }),
  };

  const sourceCardsPath = argument(argv, "--source-cards");
  const generatedBoardPath = argument(argv, "--generated-board");
  stages.card_reconciliation = reconcileCardProjection({
    sourceCards: sourceCardsPath ? json(sourceCardsPath) : undefined,
    generatedBoard: generatedBoardPath ? json(generatedBoardPath) : undefined,
  });

  const sourceReceiptPath = argument(argv, "--source-receipt");
  if (sourceReceiptPath) {
    const sourceContractPath = argument(argv, "--source-contract");
    const sourceHash = argument(argv, "--source-hash");
    const maxAgeDays = Number(argument(argv, "--max-age-days"));
    const sourceReceipt = loadReceipt(sourceReceiptPath);
    const sourceContract = sourceContractPath
      ? json(sourceContractPath)
      : Number.isFinite(maxAgeDays) && maxAgeDays > 0
        ? {
          id: sourceReceipt?.source_contract_id || sourceReceipt?.schema || "generated-evidence",
          freshness_contract: { max_stale_days: maxAgeDays },
        }
        : undefined;
    stages.generated_evidence_freshness = evaluateGeneratedEvidenceFreshness({
      sourceReceipt,
      sourceContract,
      expectedSourceHash: sourceHash || sourceReceipt?.source_hash,
      expectedReceiptHash: expectedManifest?.source_receipt?.sha256,
    });
  } else {
    stages.generated_evidence_freshness = {
      status: "UNKNOWN",
      findings: ["generated evidence source receipt was not supplied"],
      evidence: {},
    };
  }

  const liveManifestPath = argument(argv, "--live-manifest");
  const liveOrigin = argument(argv, "--live-origin");
  if (liveManifestPath && expectedManifestPath) {
    stages.served_artifact_freshness = evaluateServedArtifactFreshness({
      liveManifest: json(liveManifestPath),
      expectedManifest,
      freshnessFindings,
    });
  } else if (liveOrigin && expectedManifestPath) {
    const result = await checkServedArtifactFreshness({
      origin: liveOrigin,
      expectedManifest,
    });
    stages.served_artifact_freshness = evaluateServedArtifactFreshness({
      liveManifest: result.live,
      expectedManifest,
      freshnessFindings: () => result.findings,
    });
  } else {
    stages.served_artifact_freshness = {
      status: "UNKNOWN",
      findings: ["served artifact manifest was not supplied"],
      evidence: {},
    };
  }

  const receipt = buildReleaseSurfaceReceipt({ sourceCommitSha, stages, requiredStages: requiredStages(argv) });
  writeReleaseSurfaceReceipt(receipt, outputPath);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== "PASS") {
    for (const finding of receipt.findings) console.error(`release surface reconciliation: ${finding}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
