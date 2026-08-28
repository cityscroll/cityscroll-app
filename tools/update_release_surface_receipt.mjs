#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  RELEASE_STATUS,
  RELEASE_SURFACE_RECEIPT_SCHEMA,
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
const requiredStage = argument(argv, "--required-stage");
if (!receiptPath || !stage || !RELEASE_STATUS.includes(status)) {
  throw new Error("Usage: node tools/update_release_surface_receipt.mjs --receipt FILE --stage STAGE --status PASS|FAIL|UNKNOWN [--deployment-url URL]");
}
if (requiredStage && ![
  "generation_output",
  "card_reconciliation",
  "generated_evidence_freshness",
  "served_artifact_freshness",
  "pages_deployment",
  "worker_release",
  "data_publication",
  "live_smoke",
  "watchdog",
].includes(requiredStage)) throw new Error(`unknown required release-surface stage: ${requiredStage}`);

const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
if (receipt.schema !== RELEASE_SURFACE_RECEIPT_SCHEMA) throw new Error("invalid release-surface receipt schema");
if (!Object.hasOwn(receipt.stages || {}, stage)) throw new Error(`unknown release-surface stage: ${stage}`);

receipt.stages[stage] = {
  status,
  findings: status === "PASS" ? [] : [`${stage} is ${status}`],
  evidence: deploymentUrl ? { deployment_url: deploymentUrl } : {},
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
receipt.updated_at = new Date().toISOString();
writeReleaseSurfaceReceipt(receipt, receiptPath);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
