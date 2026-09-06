#!/usr/bin/env node
// Run summary for the served-artifact freshness guard.
//
// States, in one place: whether a finding was present, and whether its owner
// alert was accepted, refused, or never attempted. A finding keeps the run red
// whether or not its alert got through, and a delivery that never got through
// is reported as a delivery fault carrying the finding rather than as silence.

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DELIVERY_ACCEPTED, summarizeDelivery } from "./ops_alert_delivery.mjs";

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    return null;
  }
}

function emit(lines) {
  const text = `${lines.join("\n")}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text, "utf8");
}

export function main(argv = process.argv.slice(2)) {
  const receiptPath = argument(argv, "--receipt", ".artifacts/ops-alert-delivery-receipt.json");
  const receipt = readReceipt(receiptPath);
  if (!receipt) {
    // The comparison never reached its own outcome. Whatever failed before it
    // is already red on its own account; this step does not add a second cause.
    emit([
      "### Served artifact freshness",
      "",
      "Finding present: not determined — the comparison did not complete.",
      "Delivery: not attempted.",
    ]);
    return 0;
  }
  const lines = [
    "### Served artifact freshness",
    "",
    summarizeDelivery(receipt),
    "",
    `Guard: ${receipt.guard}. Stage: ${receipt.stage}. Source revision: ${receipt.source_revision || "unknown"}. Run: ${receipt.run_id || "unknown"}.`,
  ];
  if (receipt.finding_present) {
    lines.push("", "Finding:", "");
    for (const finding of (receipt.findings || []).slice(0, 20)) lines.push(`- ${finding}`);
  }
  emit(lines);
  if (!receipt.finding_present) return 0;
  if (receipt.delivery_outcome !== DELIVERY_ACCEPTED) {
    console.error(`owner alert was not accepted: ${receipt.reason}`);
    return 1;
  }
  console.error(`served artifact freshness finding delivered to the site owner: ${receipt.findings?.[0] || "finding"}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
