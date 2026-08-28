#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCommunityBoardMoneyReadModel,
  validateCommunityBoardMoneyReadModel,
} from "../site/community_board_money.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BOARD_LOOKUP = resolve(ROOT, "site/data/community_board_constellation_lookup.json");
const BUDGET = resolve(ROOT, "site/data/community_board_adopted_budget.json");
const PAYMENTS = resolve(ROOT, "site/data/community_board_payment_actuals.json");
const OUTPUT = resolve(ROOT, "site/data/community_board_money.json");
const RECEIPT = resolve(ROOT, "warehouse/receipts/proof/community_board_money_latest.json");
const BUDGET_ARTIFACT = "site/data/community_board_adopted_budget.json";
const BUDGET_RECEIPT = "warehouse/receipts/proof/community_board_adopted_budget_latest.json";
const PAYMENT_ARTIFACT = "site/data/community_board_payment_actuals.json";
const PAYMENT_RECEIPT = "warehouse/receipts/proof/community_board_payment_actuals_latest.json";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

function boardsFromLookup(lookup) {
  return Object.values(lookup?.by_id || {}).map((board) => ({ board_id: board.body_id, name: board.display_name }));
}

function projectionInputs(row) {
  return {
    budget: {
      present: Boolean(row.budget.source_ref),
      fiscal_year: row.budget.fiscal_year,
      adopted_amount: row.budget.adopted_amount,
      personnel_amount: row.budget.personnel_amount,
      otps_amount: row.budget.otps_amount,
      current_amount: row.budget.current_amount,
      modified_amount: row.budget.modified_amount,
      commitments_amount: row.budget.commitments_amount,
    },
    spending: {
      present: Boolean(row.spending.source_ref),
      fiscal_year: row.spending.fiscal_year,
      posted_amount: row.spending.posted_amount,
      payment_count: row.spending.payment_count,
      distinct_payee_count: row.spending.distinct_payee_count,
    },
  };
}

function canary(row, label, extra = {}) {
  if (!row) return { label, state: "not_present", projection_inputs: null, source_references: [], ...extra };
  return {
    label,
    state: row.coverage.state,
    board_id: row.board_id,
    fiscal_year: row.fiscal_year,
    coverage: row.coverage,
    projection_inputs: projectionInputs(row),
    source_references: row.sources,
    ...extra,
  };
}

function boroughOf(boardId) {
  return String(boardId || "").split("-cb-")[0] || null;
}

function canaries(model, adoptedBudget, paymentActuals) {
  const rows = model.rows;
  const budgetOnly = rows.find((row) => row.coverage.state === "budget_only");
  const spendingOnly = rows.find((row) => row.coverage.state === "spending_only");
  const unmatched = rows.find((row) => row.coverage.state === "unmatched_identity");
  const incompleteCurrentFY = rows.find((row) => row.fiscal_year === model.current_fiscal_year && row.coverage.state === "budget_only");

  const boroughRows = [];
  const boroughs = ["bronx", "brooklyn", "manhattan", "queens", "staten-island"];
  for (const borough of boroughs) {
    const row = rows.find((candidate) => boroughOf(candidate.board_id) === borough);
    if (row) boroughRows.push(canary(row, `borough:${borough}`));
  }

  const sourceBudget = adoptedBudget.rows.find((row) => row.board_id === spendingOnly?.board_id)
    || adoptedBudget.rows[0];
  const sourceSpending = paymentActuals.rows.find((row) => row.board_id === sourceBudget?.board_id)
    || paymentActuals.rows[0];
  let bothSource = null;
  if (sourceBudget && sourceSpending) {
    const fixtureBudget = {
      ...adoptedBudget,
      generated_at: adoptedBudget.generated_at || adoptedBudget.source?.observed_at,
      source: { ...adoptedBudget.source, pinned_slice: { fiscal_year: sourceSpending.fiscal_year, publication_date: sourceBudget.publication_date } },
      rows: [{ ...sourceBudget, fiscal_year: sourceSpending.fiscal_year, provenance: { ...sourceBudget.provenance, fiscal_year: sourceSpending.fiscal_year } }],
    };
    const fixturePayments = { ...paymentActuals, fiscal_years: [sourceSpending.fiscal_year], rows: [sourceSpending] };
    const fixture = buildCommunityBoardMoneyReadModel({
      boards: [{ board_id: sourceBudget.board_id }],
      adoptedBudget: fixtureBudget,
      paymentActuals: fixturePayments,
      generatedAt: "2026-08-27T00:00:00.000Z",
      now: "2026-08-27T00:00:00.000Z",
    });
    bothSource = canary(fixture.rows[0], "both_sources", {
      fixture: "contract_fixture_reconciles_budget_and_spending_keys",
      source_references: [
        ...fixture.rows[0].sources,
        { role: "fixture", source_system: "projection_test_input", source_artifact: BUDGET_ARTIFACT, source_receipt: BUDGET_RECEIPT },
      ],
    });
  }

  const staleFixture = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: rows[0]?.board_id }],
    adoptedBudget,
    paymentActuals,
    generatedAt: model.generated_at,
    now: "2028-01-01T00:00:00.000Z",
    maxAgeMs: 1,
  });
  const staleRow = staleFixture.rows[0];

  const emptyFixture = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: sourceSpending?.board_id }],
    adoptedBudget: { ...adoptedBudget, rows: [], source: { ...adoptedBudget.source, pinned_slice: { fiscal_year: sourceSpending?.fiscal_year || model.current_fiscal_year } } },
    paymentActuals: { ...paymentActuals, rows: [{ ...sourceSpending, payment_count: 0, posted_payment_amount: 0, distinct_payee_count: 0, top_payees: [], coverage_status: "empty_source_result", observations: [] }] },
    generatedAt: "2026-08-27T00:00:00.000Z",
    now: "2026-08-27T00:00:00.000Z",
  });

  return {
    multi_borough: boroughRows,
    both_sources: bothSource,
    budget_only: canary(budgetOnly, "budget_only"),
    spending_only: canary(spendingOnly, "spending_only"),
    partial_source: canary(spendingOnly, "partial_source", {
      source_status: model.sources.spending.status,
      source_coverage: model.sources.spending.coverage,
    }),
    empty_source_result: canary(emptyFixture.rows[0], "empty_source_result", { fixture: "measured-empty-result-shape" }),
    unmatched_identity: canary(unmatched, "unmatched_identity", {
      unmatched_agencies: paymentActuals.payment_population?.unmatched_agencies || [],
    }),
    incomplete_current_fy: canary(incompleteCurrentFY, "incomplete_current_fy", {
      current_fiscal_year: model.current_fiscal_year,
      source_data_through: paymentActuals.source?.source_data_through || null,
      no_full_year_claim: true,
    }),
    stale_source: canary(staleRow, "stale_source", {
      replay: true,
      checked_at: "2028-01-01T00:00:00.000Z",
      max_age_ms: 1,
      source_statuses: staleFixture.sources,
    }),
  };
}

function build() {
  const lookup = json(BOARD_LOOKUP);
  const adoptedBudget = json(BUDGET);
  const paymentActuals = json(PAYMENTS);
  const generatedAt = adoptedBudget.source?.observed_at || adoptedBudget.generated_at || paymentActuals.generated_at || null;
  const model = buildCommunityBoardMoneyReadModel({
    boards: boardsFromLookup(lookup),
    adoptedBudget,
    paymentActuals,
    generatedAt,
    now: generatedAt,
  });
  const validation = validateCommunityBoardMoneyReadModel(model);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const receipt = {
    schema: "cityscroll.community_board_money_read_model_receipt.v1",
    workstream_card: "CB-MONEY-03",
    status: "complete",
    generated_at: model.generated_at,
    inputs: {
      boards: "site/data/community_board_constellation_lookup.json",
      adopted_budget: BUDGET_ARTIFACT,
      adopted_budget_receipt: BUDGET_RECEIPT,
      payment_actuals: PAYMENT_ARTIFACT,
      payment_actuals_receipt: PAYMENT_RECEIPT,
      join_key: ["board_id", "fiscal_year"],
      forbidden_joins: ["Community District", "borough", "vendor address", "fuzzy publisher name"],
    },
    measurement: {
      board_count: model.coverage.board_count,
      fiscal_years: model.fiscal_years,
      board_fy_rows: model.coverage.board_fy_rows,
      states: model.coverage.states,
      source_statuses: {
        budget: model.sources.budget.status,
        spending: model.sources.spending.status,
      },
      canaries: canaries(model, adoptedBudget, paymentActuals),
      provenance_carried_to_read_model: model.rows.every((row) => row.sources.every((source) => source.artifact && source.receipt && source.source_system)),
      ratio_left_null: model.rows.every((row) => row.derived.posted_share_of_adopted === null),
      no_remaining_budget_derived: !JSON.stringify(model).toLowerCase().includes("remaining budget"),
    },
    hard_rules: {
      exact_board_fy_join_only: true,
      budget_and_spending_are_separate: true,
      current_modified_and_commitments_remain_distinct: true,
      no_remaining_budget_subtraction: true,
      uncertified_ratio_is_null: true,
      unknown_partial_empty_and_stale_states_explicit: true,
    },
    read_model: "site/data/community_board_money.json",
  };
  return { model, receipt };
}

function main() {
  const check = process.argv.includes("--check");
  const { model, receipt } = build();
  const modelBytes = serialized(model);
  const receiptBytes = serialized(receipt);
  if (check) {
    if (readFileSync(OUTPUT, "utf8") !== modelBytes) throw new Error(`stale Community Board money read model: ${OUTPUT}`);
    if (readFileSync(RECEIPT, "utf8") !== receiptBytes) throw new Error(`stale Community Board money receipt: ${RECEIPT}`);
    console.log(`Community Board money read model current: rows=${model.rows.length} states=${JSON.stringify(model.coverage.states)}`);
    return;
  }
  writeFileSync(OUTPUT, modelBytes);
  writeFileSync(RECEIPT, receiptBytes);
  console.log(`wrote Community Board money read model: rows=${model.rows.length}`);
}

if (process.argv[1]?.endsWith("build_community_board_money.mjs")) main();

export { build, canaries };
