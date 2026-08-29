#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  RELEASE_STATUS,
  RELEASE_SURFACE_RECEIPT_SCHEMA,
  RELEASE_SURFACE_STAGES,
  writeReleaseSurfaceReceipt,
} from "./release_surface_reconciliation.mjs";

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

const argv = process.argv.slice(2);
const receiptPath = argument(argv, "--receipt");
const stage = argument(argv, "--stage");
const status = argument(argv, "--status");
const deploymentUrl = argument(argv, "--deployment-url");
const deploymentId = argument(argv, "--deployment-id");
const providerStatus = argument(argv, "--provider-status");
const sourceCommitSha = argument(argv, "--source-commit");
const manifestPath = argument(argv, "--manifest");
const evidencePath = argument(argv, "--evidence-file");
const reason = argument(argv, "--reason");
const requiredStage = argument(argv, "--required-stage");
if (!receiptPath || !stage || !RELEASE_STATUS.includes(status)) {
  throw new Error("Usage: node tools/update_release_surface_receipt.mjs --receipt FILE --stage STAGE --status PASS|FAIL|UNKNOWN [--deployment-url URL]");
}
if (requiredStage && !RELEASE_SURFACE_STAGES.includes(requiredStage)) {
  throw new Error("unknown required release-surface stage: " + requiredStage);
}

const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
if (receipt.schema !== RELEASE_SURFACE_RECEIPT_SCHEMA) throw new Error("invalid release-surface receipt schema");
if (!Object.hasOwn(receipt.stages || {}, stage)) throw new Error("unknown release-surface stage: " + stage);

let evidence = {};
if (evidencePath) evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (deploymentUrl) evidence = { ...evidence, deployment_url: deploymentUrl };
if (deploymentId) evidence = { ...evidence, deployment_id: deploymentId };
if (providerStatus) evidence = { ...evidence, provider_status: providerStatus };
if (sourceCommitSha) evidence = { ...evidence, source_commit_sha: sourceCommitSha };
if (manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  evidence = {
    ...evidence,
    artifact_hash: manifest.artifact_hash || null,
    manifest_source_commit_sha: manifest.source_commit_sha || null,
  };
}
const oldEvidence = receipt.stages[stage]?.evidence || {};
const findings = reason ? [reason] : (status === "PASS" ? [] : [stage + " is " + status]);
receipt.stages[stage] = {
  status,
  reason: reason || (status === "PASS" ? "evidence reconciled" : stage + " is " + status),
  findings,
  evidence: { ...oldEvidence, ...evidence },
};

const required = new Set(receipt.required_stages || []);
if (requiredStage) required.add(requiredStage);
receipt.required_stages = [...required];
const requiredRows = [...required].map((name) => receipt.stages[name]).filter(Boolean);
receipt.status = requiredRows.some((row) => row.status === "FAIL")
  ? "FAIL"
  : requiredRows.some((row) => row.status === "UNKNOWN")
    ? "UNKNOWN"
    : "PASS";
receipt.findings = requiredRows.flatMap((row) => row.findings || []);
receipt.reason = receipt.findings[0] || (receipt.status === "PASS"
  ? "all required release-surface evidence matched"
  : "required release-surface evidence was not reconciled");
receipt.updated_at = new Date().toISOString();
writeReleaseSurfaceReceipt(receipt, receiptPath);
process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
