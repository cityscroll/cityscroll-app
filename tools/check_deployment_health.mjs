#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertWorkflowEmitsBoundary,
  buildDeploymentHealthReceipt,
  classifyEvidence,
  defaultNativeBuildsPath,
  evaluateDeploymentHealthReceipt,
  guardsFromGenerationReceipt,
  loadDeclaredProductionBoundaries,
  readJson,
  reconcileDeploymentHealth,
  writeJson,
} from "./deployment_health_receipt.mjs";

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function argumentsAll(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function jsonOrNull(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseGuard(text) {
  const separator = text.indexOf(":");
  if (separator <= 0) throw new Error(`invalid --guard ${text}; expected name:STATUS`);
  return { name: text.slice(0, separator), status: text.slice(separator + 1) };
}

function checkContract({ rootDir = process.cwd() } = {}) {
  const findings = [];
  const config = readJson(resolve(rootDir, "docs/release/cloudflare-native-builds.json"));
  try {
    loadDeclaredProductionBoundaries(config);
  } catch (error) {
    findings.push(String(error.message || error));
  }
  const pagesWorkflow = readFileSync(resolve(rootDir, ".github/workflows/deploy-cloudflare-pages.yml"), "utf8");
  const workerWorkflow = readFileSync(resolve(rootDir, ".github/workflows/deploy-worker.yml"), "utf8");
  const watchdogWorkflow = readFileSync(resolve(rootDir, ".github/workflows/reliability-watchdogs.yml"), "utf8");
  findings.push(...assertWorkflowEmitsBoundary(pagesWorkflow, "cloudflare-pages"));
  findings.push(...assertWorkflowEmitsBoundary(workerWorkflow, "cloudflare-worker"));
  if (watchdogWorkflow.includes("check_deployment_health.mjs") || watchdogWorkflow.includes("deployment-health-receipt")) {
    findings.push("runtime watchdog workflow must not emit deployment-health receipts");
  }
  if (pagesWorkflow.includes("--boundary cloudflare-worker") || workerWorkflow.includes("--boundary cloudflare-pages")) {
    findings.push("a production pipeline must not emit the sibling boundary receipt");
  }
  return findings;
}

function writeFromArgv(argv) {
  const generationPath = argument(argv, "--generation-receipt");
  const coveragePath = argument(argv, "--trigger-coverage");
  const generationReceipt = generationPath ? jsonOrNull(generationPath) : null;
  const coverage = coveragePath ? jsonOrNull(coveragePath) : null;
  const guards = argumentsAll(argv, "--guard").map(parseGuard);
  if (generationPath) guards.push(...guardsFromGenerationReceipt(generationReceipt));
  if (coveragePath) {
    const classified = classifyEvidence(coverage);
    if (classified.kind === "runtime-watchdog") {
      throw new Error("runtime watchdog receipt cannot be used as Worker trigger coverage");
    }
    guards.push({
      name: "worker_trigger_coverage",
      status: coverage?.status === "PASS" || coverage?.status === "passed" ? "PASS" : coverage?.status,
      findings: !coverage
        ? ["Worker trigger coverage evidence is missing"]
        : Array.isArray(coverage.missing_paths) && coverage.missing_paths.length
          ? coverage.missing_paths.map((path) => `missing ${path}`)
          : [],
    });
  }
  const receipt = buildDeploymentHealthReceipt({
    boundary: argument(argv, "--boundary"),
    pipeline: argument(argv, "--pipeline"),
    mergedSourceSha: argument(argv, "--merged-source-sha"),
    deployedCommitSha: argument(argv, "--deployed-commit-sha") || argument(argv, "--merged-source-sha"),
    artifactType: argument(argv, "--artifact-type"),
    artifactValue: argument(argv, "--artifact-value"),
    deploymentId: argument(argv, "--deployment-id"),
    deploymentUrl: argument(argv, "--deployment-url"),
    providerStatus: argument(argv, "--provider-status"),
    guardResults: guards,
    workflowRunUrl: argument(argv, "--workflow-run-url"),
  });
  const output = argument(argv, "--output");
  if (output) writeJson(output, receipt);
  return receipt;
}

function reconcileFromArgv(argv) {
  const view = reconcileDeploymentHealth({
    mergedSourceSha: argument(argv, "--merged-source-sha"),
    receipts: argumentsAll(argv, "--receipt").map((path) => jsonOrNull(path)),
  });
  const output = argument(argv, "--output");
  if (output) writeJson(output, view);
  return view;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--check") && !argv.includes("--write") && !argv.includes("--reconcile")) {
    const findings = checkContract();
    if (findings.length) {
      for (const finding of findings) console.error(`deployment health: ${finding}`);
      process.exitCode = 1;
      return;
    }
    loadDeclaredProductionBoundaries(readJson(defaultNativeBuildsPath()));
    process.stdout.write("Deployment health contract OK: Cloudflare Pages and Cloudflare Worker\n");
    return;
  }

  if (argv.includes("--write")) {
    const receipt = writeFromArgv(argv);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (argv.includes("--fail-on-receipt-error") && receipt.status !== "PASS") process.exitCode = 1;
    return;
  }

  if (argv.includes("--reconcile")) {
    const view = reconcileFromArgv(argv);
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    if (view.status !== "COMPLETE") {
      for (const finding of view.findings) console.error(`deployment health: ${finding}`);
      process.exitCode = 1;
    }
    return;
  }

  if (argv.includes("--evaluate")) {
    const receipt = jsonOrNull(argument(argv, "--receipt"));
    const evaluated = evaluateDeploymentHealthReceipt(receipt, {
      expectedMergedSourceSha: argument(argv, "--merged-source-sha"),
    });
    process.stdout.write(`${JSON.stringify(evaluated, null, 2)}\n`);
    if (!evaluated.verifiable) process.exitCode = 1;
    return;
  }

  throw new Error("Usage: node tools/check_deployment_health.mjs --check | --write ... | --reconcile ...");
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
