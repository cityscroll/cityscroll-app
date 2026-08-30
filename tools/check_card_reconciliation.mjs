#!/usr/bin/env node

import { resolve } from "node:path";

import {
  DEFAULT_CARD_RECONCILIATION_RECEIPT,
  buildCardReconciliationReceipt,
  checkCommittedFixtures,
  evaluateCardReconciliationFromPaths,
  writeCardReconciliationReceipt,
} from "./card_reconciliation_guard.mjs";

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function main(argv = process.argv.slice(2)) {
  const observedAt = argument(argv, "--observed-at", "2026-08-30T00:00:00.000Z");
  if (argv.includes("--check") && !argv.includes("--source-cards")) {
    const result = checkCommittedFixtures({
      rootDir: process.cwd(),
      now: observedAt,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "PASS") {
      for (const finding of result.findings) console.error(`card reconciliation: ${finding}`);
      process.exitCode = 1;
    }
    return;
  }

  const sourceCardsPath = argument(argv, "--source-cards");
  const projectionsPath = argument(argv, "--projections");
  const generatedBoardPath = argument(argv, "--generated-board");
  const outputPath = argument(argv, "--output", DEFAULT_CARD_RECONCILIATION_RECEIPT);
  const sourceCommitSha = argument(argv, "--source-commit", process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || null);
  const result = evaluateCardReconciliationFromPaths({
    sourceCardsPath,
    projectionsPath,
    generatedBoardPath,
    projectionPath: argument(argv, "--projection-path"),
  });
  const receipt = buildCardReconciliationReceipt({
    result,
    sourceCommitSha,
    observedAt,
  });
  writeCardReconciliationReceipt(receipt, resolve(outputPath));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== "PASS") {
    for (const finding of receipt.findings) console.error(`card reconciliation: ${finding}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
