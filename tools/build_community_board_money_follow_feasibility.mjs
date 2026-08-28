#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  measureCommunityBoardMoneyFollowFeasibility,
  validateCommunityBoardMoneyFollowFeasibility,
} from "../site/community_board_money_follow_feasibility.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "site/data/community_board_payment_actuals.json");
const OUTPUT = join(ROOT, "warehouse/receipts/proof/community_board_money_follow_feasibility_latest.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function build() {
  const paymentArtifact = readJson(INPUT);
  const receipt = measureCommunityBoardMoneyFollowFeasibility(paymentArtifact);
  const validation = validateCommunityBoardMoneyFollowFeasibility(receipt);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return receipt;
}

function main() {
  const receipt = build();
  const bytes = serialized(receipt);
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== bytes) throw new Error(`stale CB-MONEY-07 receipt: ${OUTPUT}`);
    console.log(`checked CB-MONEY-07 across ${receipt.sample.sampled_board_count} boards and ${receipt.sample.board_month_window.length} source months`);
    return;
  }
  writeFileSync(OUTPUT, bytes);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
