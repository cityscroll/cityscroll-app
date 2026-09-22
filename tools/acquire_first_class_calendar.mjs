#!/usr/bin/env node

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureGovernmentSourceBytes } from "../site/government_observation_refresh.mjs";

export async function acquireFirstClassCalendar({ sourceId, capturePath, receiptPath, asOf, fetchImpl } = {}) {
  if (!sourceId || !capturePath || !receiptPath) {
    throw new Error("sourceId, capturePath, and receiptPath are required");
  }
  const capture = await captureGovernmentSourceBytes(sourceId, { asOf, fetchImpl });
  mkdirSync(dirname(capturePath), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  const captureTemp = `${capturePath}.tmp`;
  const receiptTemp = `${receiptPath}.tmp`;
  writeFileSync(captureTemp, capture.bytes);
  writeFileSync(receiptTemp, `${JSON.stringify(capture.receipt, null, 2)}\n`);
  renameSync(captureTemp, capturePath);
  renameSync(receiptTemp, receiptPath);
  return capture.receipt;
}

async function main(argv = process.argv.slice(2)) {
  const [sourceId, capturePath, receiptPath] = argv;
  if (!sourceId || !capturePath || !receiptPath) {
    throw new Error("usage: acquire_first_class_calendar.mjs <source-id> <capture-path> <receipt-path>");
  }
  const receipt = await acquireFirstClassCalendar({
    sourceId,
    capturePath: resolve(capturePath),
    receiptPath: resolve(receiptPath),
  });
  console.log(`captured ${sourceId}: ${receipt.bytes} bytes at ${receipt.observed_at}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
