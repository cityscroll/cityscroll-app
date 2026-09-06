#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runCodeModeMeasurement,
  serialized,
} from "../integrations/cloudflare-os-code-mode/src/experiment.mjs";
import {
  buildCloudflareOsProof,
  verifyCloudflareOsProof,
} from "./verify_cloudflare_os_proof.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RECEIPT = resolve(ROOT, "artifacts/capability-spine/code-mode.json");
const CS07_RECEIPT = resolve(ROOT, "artifacts/capability-spine/cloudflare-os-proof.json");
const CS07_SOURCE = resolve(ROOT, "integrations/cloudflare-os-entity-research");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  const args = {
    receipt: DEFAULT_RECEIPT,
    repetitions: 30,
    warmups: 5,
    requireParity: true,
    maxP95Regression: 0.10,
    write: false,
    matchedArms: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--receipt") args.receipt = resolve(argv[++i] || "");
    else if (flag === "--repetitions") args.repetitions = Number(argv[++i]);
    else if (flag === "--warmups") args.warmups = Number(argv[++i]);
    else if (flag === "--require-parity") args.requireParity = true;
    else if (flag === "--max-p95-regression") args.maxP95Regression = Number(argv[++i]);
    else if (flag === "--write") args.write = true;
    else if (flag === "--matched-arms") args.matchedArms = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!Number.isInteger(args.repetitions) || args.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  if (!Number.isInteger(args.warmups) || args.warmups < 0) {
    throw new Error("--warmups must be a non-negative integer");
  }
  if (!Number.isFinite(args.maxP95Regression) || args.maxP95Regression < 0) {
    throw new Error("--max-p95-regression must be a non-negative number");
  }
  return args;
}

export async function buildCodeModeMeasurementReceipt(options = {}) {
  const cs07Proof = await buildCloudflareOsProof({ source: CS07_SOURCE });
  await verifyCloudflareOsProof({ receiptPath: CS07_RECEIPT, source: CS07_SOURCE });
  return runCodeModeMeasurement({
    repetitions: options.repetitions ?? 30,
    warmups: options.warmups ?? 5,
    requireParity: options.requireParity ?? true,
    maxP95Regression: options.maxP95Regression ?? 0.10,
    matchedArms: options.matchedArms ?? false,
    cs07Proof,
  });
}

export async function verifyCodeModeMeasurementReceipt({
  receiptPath = DEFAULT_RECEIPT,
  repetitions = 30,
  warmups = 5,
  requireParity = true,
  maxP95Regression = 0.10,
} = {}) {
  const expected = await buildCodeModeMeasurementReceipt({
    repetitions,
    warmups,
    requireParity,
    maxP95Regression,
  });
  if (!existsSync(receiptPath)) {
    throw new Error(`Code Mode measurement receipt is missing: ${receiptPath}`);
  }
  const actual = readJson(receiptPath);
  if (serialized(actual) !== serialized(expected)) {
    throw new Error("committed Code Mode measurement receipt is stale or incomplete");
  }
  if (expected.verdict === "blocked") {
    throw new Error(`Code Mode measurement is blocked: ${expected.blocked_reason}`);
  }
  return expected;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const receipt = await buildCodeModeMeasurementReceipt({
      repetitions: args.repetitions,
      warmups: args.warmups,
      requireParity: args.requireParity,
      maxP95Regression: args.maxP95Regression,
      matchedArms: args.matchedArms,
    });
    if (args.write) {
      writeFileSync(args.receipt, serialized(receipt), "utf8");
      process.stdout.write(`wrote Code Mode measurement receipt: ${relative(ROOT, args.receipt)}\n`);
      process.stdout.write(`verdict: ${receipt.verdict}\n`);
    } else {
      if (!existsSync(args.receipt)) {
        throw new Error(`Code Mode measurement receipt is missing: ${args.receipt}`);
      }
      const actual = readJson(args.receipt);
      if (serialized(actual) !== serialized(receipt)) {
        throw new Error("committed Code Mode measurement receipt is stale or incomplete");
      }
      if (receipt.verdict === "blocked") {
        throw new Error(`Code Mode measurement is blocked: ${receipt.blocked_reason}`);
      }
      process.stdout.write(`Code Mode measurement verified: ${relative(ROOT, args.receipt)}\n`);
      process.stdout.write(`verdict: ${receipt.verdict}\n`);
    }
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
