#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureGovernmentSourceBytes } from "../site/government_observation_refresh.mjs";

function loadPreviousCapture(capturePath, receiptPath) {
  if (!existsSync(capturePath) || !existsSync(receiptPath)) return null;
  try {
    const bytes = new Uint8Array(readFileSync(capturePath));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!bytes.byteLength || !receipt || typeof receipt !== "object") return null;
    return { bytes, receipt };
  } catch {
    return null;
  }
}

export async function acquireFirstClassCalendar({
  sourceId,
  capturePath,
  receiptPath,
  asOf,
  fetchImpl,
  previous = undefined,
} = {}) {
  if (!sourceId || !capturePath || !receiptPath) {
    throw new Error("sourceId, capturePath, and receiptPath are required");
  }
  const retained = previous === undefined
    ? loadPreviousCapture(capturePath, receiptPath)
    : previous;
  mkdirSync(dirname(capturePath), { recursive: true });
  mkdirSync(dirname(receiptPath), { recursive: true });
  try {
    const capture = await captureGovernmentSourceBytes(sourceId, {
      asOf,
      fetchImpl,
      previous: retained || null,
    });
    const captureTemp = `${capturePath}.tmp`;
    const receiptTemp = `${receiptPath}.tmp`;
    writeFileSync(captureTemp, capture.bytes);
    writeFileSync(receiptTemp, `${JSON.stringify(capture.receipt, null, 2)}\n`);
    renameSync(captureTemp, capturePath);
    renameSync(receiptTemp, receiptPath);
    try {
      // Prefer owner-only modes for ignored acquisition scratch.
      writeFileSync(capturePath, capture.bytes, { mode: 0o600 });
    } catch {
      // Some platforms ignore mode on rewrite; the rename already landed bytes.
    }
    return capture.receipt;
  } catch (error) {
    if (retained?.bytes?.byteLength) {
      // Keep last-good bytes and receipt on disk; surface the failure.
      error.lastGoodPreserved = true;
    }
    throw error;
  }
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
