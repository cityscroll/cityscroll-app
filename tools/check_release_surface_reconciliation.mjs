#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { freshnessFindings } from "./artifact_manifest.mjs";
import { checkServedArtifactFreshness } from "./check_served_artifact_freshness.mjs";
import {
  buildReleaseSurfaceReceipt,
  evaluateAlertDelivery,
  evaluateDataPublication,
  evaluateGeneratedEvidenceFreshness,
  evaluateGenerationReceipt,
  evaluateLiveProbe,
  evaluateMonitorState,
  evaluatePagesDeployment,
  evaluateServedArtifactFreshness,
  evaluateWorkerRelease,
  evaluateWorkerStartup,
  evaluateWorkerTriggerCoverage,
  reconcileCardProjection,
  sha256Text,
  writeReleaseSurfaceReceipt,
} from "./release_surface_reconciliation.mjs";
import { verifyWorkerTriggerCoverage } from "./worker_trigger_coverage.mjs";

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
  const value = argument(argv, "--required-stages", "generation_output,card_reconciliation,generated_evidence_freshness,served_artifact_freshness,pages_deployment,worker_trigger_coverage,worker_startup,worker_release,data_publication,live_smoke,watchdog,scheduler,alert_delivery");
  return value.split(",").map((stage) => stage.trim()).filter(Boolean);
}

async function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes("--check");
  const evidenceFlags = [
    "--generation-receipt", "--expected-manifest", "--source-receipt", "--live-manifest",
    "--live-origin", "--pages-evidence", "--worker-evidence", "--publication-evidence",
    "--monitor-evidence", "--live-probe", "--alert-evidence", "--startup-report",
    "--startup-ms", "--source-cards", "--generated-board",
  ];
  if (checkOnly && !evidenceFlags.some((flag) => argv.includes(flag))) {
    const coverage = verifyWorkerTriggerCoverage({ rootDir: process.cwd() });
    if (coverage.status !== "PASS") {
      throw new Error(coverage.reason);
    }
    process.stdout.write("Release surface reconciliation contract OK\n");
    return;
  }
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

  const pagesEvidencePath = argument(argv, "--pages-evidence");
  stages.pages_deployment = pagesEvidencePath
    ? evaluatePagesDeployment(json(pagesEvidencePath))
    : { status: "UNKNOWN", findings: ["Pages deployment evidence was not supplied"], evidence: {} };

  const coveragePath = argument(argv, "--worker-coverage");
  const coverage = coveragePath
    ? json(coveragePath)
    : verifyWorkerTriggerCoverage({ rootDir: process.cwd() });
  stages.worker_trigger_coverage = evaluateWorkerTriggerCoverage(coverage);

  const startupReportPath = argument(argv, "--startup-report");
  const startupReport = startupReportPath ? readFileSync(resolve(startupReportPath), "utf8") : undefined;
  stages.worker_startup = evaluateWorkerStartup({
    startupMs: argument(argv, "--startup-ms"),
    startupReport,
  });

  const workerEvidencePath = argument(argv, "--worker-evidence");
  stages.worker_release = workerEvidencePath
    ? evaluateWorkerRelease(json(workerEvidencePath))
    : { status: "UNKNOWN", findings: ["Worker provider/build evidence was not supplied"], evidence: {} };

  const publicationPath = argument(argv, "--publication-evidence");
  stages.data_publication = publicationPath
    ? evaluateDataPublication(json(publicationPath))
    : { status: "UNKNOWN", findings: ["data publication evidence was not supplied"], evidence: {} };

  const monitorPath = argument(argv, "--monitor-evidence");
  const monitorEvidence = monitorPath ? json(monitorPath) : {};
  stages.watchdog = evaluateMonitorState({ watchdog: monitorEvidence.watchdog });
  stages.scheduler = evaluateMonitorState({ scheduler: monitorEvidence.scheduler });

  const liveProbePath = argument(argv, "--live-probe");
  stages.live_smoke = liveProbePath
    ? evaluateLiveProbe(json(liveProbePath))
    : { status: "UNKNOWN", findings: ["live probe evidence was not supplied"], evidence: {} };

  const alertPath = argument(argv, "--alert-evidence");
  stages.alert_delivery = alertPath
    ? evaluateAlertDelivery(json(alertPath))
    : { status: "UNKNOWN", findings: ["alert-delivery evidence was not supplied"], evidence: {} };

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
