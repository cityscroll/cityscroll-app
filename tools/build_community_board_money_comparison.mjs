#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCommunityBoardMoneyComparisons,
  validateCommunityBoardMoneyComparison,
} from "../site/community_board_money_comparison.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MONEY = join(ROOT, "site/data/community_board_money.json");
const REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const OUTPUT = join(ROOT, "site/data/community_board_money_comparison.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/community_board_money_comparison_latest.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function build() {
  const money = readJson(MONEY);
  const registry = readJson(REGISTRY);
  const boards = (registry.sources || [])
    .filter((row) => row.body_type === "community_board")
    .map((row) => ({ body_id: row.body_id, name: row.name, borough: row.borough, district: row.district }));
  const projections = buildCommunityBoardMoneyComparisons(money, boards);
  for (const comparison of Object.values(projections.comparisons)) {
    const validation = validateCommunityBoardMoneyComparison(comparison);
    if (!validation.ok) throw new Error(validation.errors.join("; "));
  }
  const artifact = {
    schema: "cityscroll.community_board_money_comparisons.v1",
    version: 1,
    default_key: projections.default_key,
    available_keys: projections.available_keys,
    read_model: {
      schema: money.schema,
      version: money.version,
      generated_at: money.generated_at,
      checked_at: money.checked_at,
      artifact: "site/data/community_board_money.json",
      receipt: "warehouse/receipts/proof/community_board_money_latest.json",
    },
    comparisons: projections.comparisons,
  };
  const receipt = {
    schema: "cityscroll.community_board_money_comparison_receipt.v1",
    workstream_card: "CB-MONEY-05",
    status: "complete",
    generated_at: money.generated_at,
    retained_read_model: {
      artifact: "site/data/community_board_money.json",
      receipt: "warehouse/receipts/proof/community_board_money_latest.json",
      schema: money.schema,
      version: money.version,
      generated_at: money.generated_at,
      checked_at: money.checked_at,
      fiscal_years: money.fiscal_years,
    },
    measurement: {
      board_count: boards.length,
      comparison_keys: projections.available_keys,
      rows_per_comparison: Object.fromEntries(Object.entries(projections.comparisons).map(([key, comparison]) => [key, comparison.rows.length])),
      source_as_of_boundaries: Object.fromEntries(Object.entries(projections.comparisons).map(([key, comparison]) => [key, comparison.boundaries])),
      row_retained_vintages_and_fiscal_years: Object.fromEntries(projections.comparisons.latest.rows.map((row) => [row.board_id, {
        budget_fiscal_year: row.budget.fiscal_year,
        budget_source_vintage: row.budget.source_vintage,
        spending_fiscal_year: row.spending.fiscal_year,
        spending_source_vintage: row.spending.source_vintage,
        read_model_row_keys: row.read_model_row_keys,
      }])),
      explicit_exclusions_or_partial_states: Object.fromEntries(Object.entries(projections.comparisons).map(([key, comparison]) => [key, comparison.rows.filter((row) => row.exclusions.length > 0).map((row) => ({ board_id: row.board_id, exclusions: row.exclusions, states: row.states }))])),
      row_to_dossier_links: Object.fromEntries(projections.comparisons.latest.rows.map((row) => [row.board_id, row.dossier_href])),
      map_layer_parity: {
        source: "comparison rows; map metric projection is computed from the same row values",
        metrics: ["adopted_budget", "posted_amount", "payment_count", "payee_count"],
        separate_projection: true,
        second_aggregation_path: false,
      },
      no_mixed_implicit_fiscal_year_ranking: true,
      ratio_certification: "not applicable; no ratio is exposed",
      per_capita_spending: "not included",
    },
  };
  return { artifact, receipt };
}

function main() {
  const check = process.argv.includes("--check");
  const { artifact, receipt } = build();
  const artifactBytes = serialized(artifact);
  const receiptBytes = serialized(receipt);
  if (check) {
    if (readFileSync(OUTPUT, "utf8") !== artifactBytes) throw new Error(`stale Community Board money comparison: ${OUTPUT}`);
    if (readFileSync(RECEIPT, "utf8") !== receiptBytes) throw new Error(`stale Community Board money comparison receipt: ${RECEIPT}`);
    console.log(`checked ${artifact.comparisons.latest.rows.length} boards across ${artifact.available_keys.length} comparison views`);
    return;
  }
  writeFileSync(OUTPUT, artifactBytes);
  writeFileSync(RECEIPT, receiptBytes);
  console.log(`wrote ${OUTPUT} and ${RECEIPT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
