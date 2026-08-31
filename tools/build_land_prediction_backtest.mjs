#!/usr/bin/env node
/**
 * Materialize the LUP2-C7 stance backtest receipt from the frozen gold pack.
 *
 * Usage:
 *   node tools/build_land_prediction_backtest.mjs
 *   node tools/build_land_prediction_backtest.mjs --check
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../worker/src/lib/civic_time.mjs";
import {
  renderBacktestMarkdown,
  runLandPredictionBacktest,
  stableStringify,
} from "../worker/src/lib/land_prediction_backtest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GOLD_FIXTURE = "test/fixtures/land_prediction_backtest/gold.v1.json";
export const RECEIPT_JSON = "warehouse/fixtures/land-use-prediction-v2/stance_backtest.v1.json";
export const RECEIPT_MD = "docs/evidence/land-use-prediction-v2/stance-backtest.md";
export const PROOF_JSON = "warehouse/receipts/proof/lup2_c7_stance_backtest_latest.json";

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

export function buildLandPredictionBacktestFromRepo(root = ROOT) {
  const gold = JSON.parse(readFileSync(join(root, GOLD_FIXTURE), "utf8"));
  return runLandPredictionBacktest(gold);
}

function writeIfNeeded(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function proofReceiptFrom(receipt, jsonText) {
  return stableStringify({
    schema: "cityscroll.land_prediction_backtest.proof.v1",
    artifact: RECEIPT_JSON,
    report: RECEIPT_MD,
    version: receipt.version,
    generated_at: receipt.generated_at,
    sha256: sha256Hex(jsonText),
    split: receipt.split,
    kill_criterion: receipt.kill_criterion,
    promotion: receipt.promotion,
  });
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const receipt = buildLandPredictionBacktestFromRepo(ROOT);
  const json = stableStringify(receipt);
  const markdown = renderBacktestMarkdown(receipt);
  const proof = proofReceiptFrom(receipt, json);
  const jsonPath = join(ROOT, RECEIPT_JSON);
  const mdPath = join(ROOT, RECEIPT_MD);
  const proofPath = join(ROOT, PROOF_JSON);
  if (args.check) {
    const committedJson = readFileSync(jsonPath, "utf8");
    const committedMd = readFileSync(mdPath, "utf8");
    const committedProof = readFileSync(proofPath, "utf8");
    if (committedJson !== json || committedMd !== markdown || committedProof !== proof) {
      throw new Error("land-use prediction stance backtest receipt drifted from the frozen gold pack");
    }
    process.stdout.write("land-use prediction stance backtest check: ok\n");
    return;
  }
  writeIfNeeded(jsonPath, json);
  writeIfNeeded(mdPath, markdown);
  writeIfNeeded(proofPath, proof);
  process.stdout.write(`wrote ${RECEIPT_JSON}, ${RECEIPT_MD}, and ${PROOF_JSON}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
