#!/usr/bin/env node
// Delivery half of the served-artifact freshness guard.
//
// Reads the findings the comparison wrote to a file and posts one owner alert.
// Every argument here is a short flag or a path: the findings text itself is
// only ever read from the file and written into the request body, so a large
// finding cannot refuse the delivery command.
//
// Exit status is the delivery outcome, not the freshness outcome. A refused
// delivery exits non-zero and prints the finding text, so a broken alert rail
// can never be mistaken for a clean run or for an absent finding.

import { appendFileSync } from "node:fs";

import {
  DELIVERY_ACCEPTED,
  DELIVERY_NOT_ATTEMPTED,
  buildDeliveryReceipt,
  buildOpsAlertPayload,
  deliverOpsAlert,
  findingsFromText,
  OPS_ALERT_ENDPOINT,
  readFindingsFile,
  summarizeDelivery,
  writeDeliveryReceipt,
} from "./ops_alert_delivery.mjs";

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}

function githubOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `${name}=${value}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const findingsPath = argument(argv, "--findings-file");
  if (!findingsPath) throw new Error("--findings-file is required");
  const receiptPath = argument(argv, "--receipt", ".artifacts/ops-alert-delivery-receipt.json");
  const markerPath = argument(argv, "--marker", ".artifacts/ops-alert-sent-marker.json");
  const guard = argument(argv, "--guard", "served-artifact-freshness");
  const stage = argument(argv, "--stage", "served_artifact_freshness");
  const endpoint = argument(argv, "--endpoint", env.OPS_ALERT_ENDPOINT || OPS_ALERT_ENDPOINT);
  const observedAt = argument(argv, "--observed-at", new Date().toISOString());
  const sourceRevision = argument(argv, "--source-revision", env.GITHUB_SHA || null);
  const workflow = argument(argv, "--workflow", env.GITHUB_WORKFLOW || null);
  const runId = argument(argv, "--run-id", env.GITHUB_RUN_ID || null);
  const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
  const repository = env.GITHUB_REPOSITORY || "";
  const defaultRunUrl = runId && repository ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;
  const workflowRunUrl = argument(argv, "--run-url", defaultRunUrl);
  const receiptUrl = argument(argv, "--receipt-url", workflowRunUrl ? `${workflowRunUrl}#artifacts` : null);

  const findingsText = readFindingsFile(findingsPath);
  const findings = findingsFromText(findingsText);
  const findingPresent = argument(argv, "--finding", findings.length ? "true" : "false") === "true";

  let delivery = null;
  if (findingPresent) {
    delivery = await deliverOpsAlert({
      payload: buildOpsAlertPayload({
        findingsText, guard, stage, workflow, sourceRevision, workflowRunUrl, receiptUrl, observedAt,
      }),
      endpoint,
      adminKey: env.CITYSCROLL_ADMIN_KEY || "",
      markerPath,
    });
  }

  const receipt = buildDeliveryReceipt({
    guard, stage, findingPresent, findings, delivery,
    sourceRevision, workflow, runId, workflowRunUrl, receiptUrl, observedAt,
  });
  writeDeliveryReceipt(receipt, receiptPath);
  githubOutput("delivery_outcome", receipt.delivery_outcome);
  githubOutput("finding_present", String(receipt.finding_present));

  process.stdout.write(`${summarizeDelivery(receipt)}\n`);
  if (!findingPresent) return 0;
  if (receipt.delivery_outcome === DELIVERY_ACCEPTED) return 0;

  // A delivery fault is its own failure, and it carries the finding it failed
  // to deliver so the finding is never lost with the delivery.
  const label = receipt.delivery_outcome === DELIVERY_NOT_ATTEMPTED ? "not attempted" : "refused";
  console.error(`owner alert ${label}: ${receipt.reason}`);
  if (delivery?.response_status) console.error(`endpoint response status: ${delivery.response_status}`);
  console.error("undelivered freshness finding:");
  for (const finding of findings) console.error(`  ${finding}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
