import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCommunityBoardMoneyReadModel,
  buildCommunityBoardMoneyCardView,
  renderCommunityBoardMoneyCard,
  moneyReadModelSourceStatus,
  validateCommunityBoardMoneyReadModel,
} from "../site/community_board_money.mjs";

const boards = [
  { board_id: "bronx-cb-01" },
  { board_id: "manhattan-cb-06" },
  { board_id: "queens-cb-14" },
];

const budget = {
  schema: "cityscroll.community_board_adopted_budget.v1",
  generated_at: "2026-08-27T00:00:00Z",
  source: { source_system: "expense_budget", dataset_id: "mwzb-yiwb", source_vintage: "2026-07-08", observed_at: "2026-08-27T00:00:00Z", pinned_slice: { fiscal_year: 2026, publication_date: "20260630" } },
  coverage: { accepted_board_facts: 2, unmatched_rows: 1 },
  rows: [
    { board_id: "bronx-cb-01", fiscal_year: 2026, adopted_amount: 420000, personnel_amount: 300000, otps_amount: 120000, source_system: "expense_budget", source_native_key: "381", source_native_key_field: "agency_number", source_vintage: "2026-07-08", observed_at: "2026-08-27T00:00:00Z", binding_status: "accepted", publication_date: "20260630", aggregation: { input_rows: 20 }, provenance: { dataset_id: "mwzb-yiwb", source_url: "https://data.cityofnewyork.us/d/mwzb-yiwb", source_vintage: "2026-07-08", observed_at: "2026-08-27T00:00:00Z" } },
    { board_id: "manhattan-cb-06", fiscal_year: 2027, adopted_amount: 430000, personnel_amount: 310000, otps_amount: 120000, source_system: "expense_budget", source_native_key: "346", source_native_key_field: "agency_number", source_vintage: "2026-07-08", observed_at: "2026-08-27T00:00:00Z", binding_status: "accepted", publication_date: "20260630", aggregation: { input_rows: 20 }, provenance: { dataset_id: "mwzb-yiwb", source_url: "https://data.cityofnewyork.us/d/mwzb-yiwb", source_vintage: "2026-07-08", observed_at: "2026-08-27T00:00:00Z" } },
  ],
};

const payments = {
  schema: "cityscroll.community_board_payment_actuals.v1",
  generated_at: "2026-08-27T00:00:00Z",
  source: { source_system: "checkbook_payment_population", source_contract: "cityscroll.checkbook.payments.fiscal_year.v1", endpoint: "https://www.checkbooknyc.com/api", source_vintage: { payment_issue_date_through: "2026-06-30" }, source_data_through: "2026-06-30" },
  fiscal_years: [2026],
  coverage: { status: "partial_board_identity_coverage", board_states: { observed: 1, empty: 1, identity_unobserved: 1 } },
  payment_population: { unmatched_agencies: [{ agency: "Unknown Board", candidate_rows: 1 }] },
  rows: [
    { board_id: "bronx-cb-01", fiscal_year: 2026, posted_payment_amount: 311000, payment_count: 84, distinct_payee_count: 12, top_payees: [], source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "posted_through_source_vintage", observations: [{ source_observation_ref: "checkbook_payment_population:one" }] },
    { board_id: "manhattan-cb-06", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, top_payees: [], source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "empty_source_result", observations: [] },
    { board_id: "queens-cb-14", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, top_payees: [], source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "identity_unobserved", observations: [] },
  ],
};

test("joins budget and posted spending only on exact board/FY and leaves uncertified ratio null", () => {
  const model = buildCommunityBoardMoneyReadModel({ boards, adoptedBudget: budget, paymentActuals: payments, generatedAt: "2026-08-27T00:00:00Z", now: "2026-08-27T00:00:00Z" });
  const both = model.rows.find((row) => row.board_id === "bronx-cb-01" && row.fiscal_year === 2026);
  assert.equal(both.coverage.state, "both_sources");
  assert.equal(both.budget.adopted_amount, 420000);
  assert.equal(both.spending.posted_amount, 311000);
  assert.equal(both.derived.posted_share_of_adopted, null);
  assert.equal(both.budget.current_amount, null);
  assert.equal(both.budget.modified_amount, null);
  assert.equal(both.budget.commitments_amount, null);
  assert.equal(JSON.stringify(model).includes("remaining"), false);
  assert.equal(validateCommunityBoardMoneyReadModel(model).ok, true);
});

test("keeps budget-only, spending-only, empty, unmatched, and stale states honest", () => {
  const model = buildCommunityBoardMoneyReadModel({ boards, adoptedBudget: budget, paymentActuals: payments, generatedAt: "2026-08-27T00:00:00Z", now: "2026-08-27T00:00:00Z" });
  const budgetOnly = model.rows.find((row) => row.board_id === "manhattan-cb-06" && row.fiscal_year === 2027);
  assert.equal(budgetOnly.coverage.state, "budget_only");
  assert.equal(budgetOnly.spending.posted_amount, null);
  const spendingOnly = model.rows.find((row) => row.board_id === "queens-cb-14" && row.fiscal_year === 2026);
  assert.equal(spendingOnly.coverage.state, "unmatched_identity");
  assert.equal(spendingOnly.spending.payment_count, null);
  const empty = model.rows.find((row) => row.board_id === "manhattan-cb-06" && row.fiscal_year === 2026);
  assert.equal(empty.coverage.state, "empty_source_result");
  assert.equal(empty.coverage.spending, "empty_source_result");
  assert.equal(empty.spending.posted_amount, 0);

  const stale = buildCommunityBoardMoneyReadModel({ boards: boards.slice(0, 1), adoptedBudget: budget, paymentActuals: payments, generatedAt: "2026-08-27T00:00:00Z", now: "2028-01-01T00:00:00Z", maxAgeMs: 1 });
  assert.equal(moneyReadModelSourceStatus(stale, "budget"), "stale");
  assert.equal(stale.rows[0].coverage.budget, "stale");
  assert.equal(stale.rows[0].budget.adopted_amount, 420000);
  assert.equal(validateCommunityBoardMoneyReadModel(stale).ok, true);
});

test("committed read model and measurement receipt carry all required coverage evidence", () => {
  const model = JSON.parse(readFileSync("site/data/community_board_money.json", "utf8"));
  const receipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_money_latest.json", "utf8"));
  assert.equal(validateCommunityBoardMoneyReadModel(model).ok, true);
  assert.equal(model.coverage.board_count, 59);
  assert.ok(receipt.measurement.canaries.multi_borough.length >= 3);
  assert.equal(receipt.measurement.canaries.both_sources.state, "both_sources");
  assert.equal(receipt.measurement.canaries.budget_only.state, "budget_only");
  assert.equal(receipt.measurement.canaries.spending_only.state, "spending_only");
  assert.equal(receipt.measurement.canaries.unmatched_identity.state, "unmatched_identity");
  assert.equal(receipt.measurement.canaries.incomplete_current_fy.no_full_year_claim, true);
  assert.equal(receipt.measurement.canaries.stale_source.replay, true);
  assert.equal(receipt.measurement.provenance_carried_to_read_model, true);
  assert.equal(receipt.measurement.ratio_left_null, true);
});

test("resident card renders same-FY facts, top payees, provenance, and the institutional boundary", () => {
  const model = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "bronx-cb-01" }],
    adoptedBudget: {
      ...budget,
      source: { ...budget.source, pinned_slice: { fiscal_year: 2026, publication_date: "20260630" } },
      rows: [{ ...budget.rows[0], fiscal_year: 2026, provenance: { ...budget.rows[0].provenance, fiscal_year: 2026 } }],
    },
    paymentActuals: {
      ...payments,
      rows: [{ ...payments.rows[0], top_payees: [{ payee_name: "Example Vendor", posted_payment_amount: 82000 }] }],
    },
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  const card = buildCommunityBoardMoneyCardView(model, "bronx-cb-01");
  const html = renderCommunityBoardMoneyCard(card);
  assert.equal(card.state, "both_sources");
  assert.match(html, /Budget &amp; spending <span>FY2026<\/span>/);
  assert.match(html, /Adopted budget/);
  assert.match(html, /Payments posted through June 30, 2026/);
  assert.match(html, /Example Vendor/);
  assert.match(html, /NYC Expense Budget/);
  assert.match(html, /Checkbook NYC/);
  assert.match(html, /Community District spending is a separate measure/);
  assert.doesNotMatch(html, /not spending inside its Community District/);
  assert.doesNotMatch(html, /remaining|progress|View payments/i);
});

test("resident card preserves separate fiscal years and does not manufacture a ratio", () => {
  const model = JSON.parse(readFileSync("site/data/community_board_money.json", "utf8"));
  const card = buildCommunityBoardMoneyCardView(model, "bronx-cb-01");
  const html = renderCommunityBoardMoneyCard(card);
  assert.equal(card.state, "separate_fiscal_years");
  assert.deepEqual(card.fiscal_years, [2027, 2026]);
  assert.match(html, /Available fiscal facts/);
  assert.match(html, /FY2027/);
  assert.match(html, /FY2026/);
  assert.match(html, /different fiscal years/);
  assert.doesNotMatch(html, /%|remaining budget|progress/i);
});

test("resident card uses explicit unavailable copy for budget-only, unmatched, empty, and stale states", () => {
  const budgetOnlyModel = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "bronx-cb-01" }],
    adoptedBudget: budget,
    paymentActuals: null,
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  assert.equal(buildCommunityBoardMoneyCardView(budgetOnlyModel, "bronx-cb-01").state, "budget_only");
  assert.match(renderCommunityBoardMoneyCard(buildCommunityBoardMoneyCardView(budgetOnlyModel, "bronx-cb-01")), /Payments are unavailable from the current source/);

  const emptyModel = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "bronx-cb-01" }],
    adoptedBudget: null,
    paymentActuals: {
      ...payments,
      rows: [{ ...payments.rows[0], posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, coverage_status: "empty_source_result", top_payees: [] }],
    },
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  const emptyCard = buildCommunityBoardMoneyCardView(emptyModel, "bronx-cb-01");
  assert.equal(emptyCard.state, "empty_source_result");
  assert.match(renderCommunityBoardMoneyCard(emptyCard), /No posted payments were returned/);
  assert.doesNotMatch(renderCommunityBoardMoneyCard(emptyCard), /\$0/);

  const unmatchedCard = buildCommunityBoardMoneyCardView(buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "bronx-cb-01" }],
    adoptedBudget: null,
    paymentActuals: { ...payments, rows: [{ ...payments.rows[0], coverage_status: "identity_unobserved" }] },
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  }), "bronx-cb-01");
  assert.equal(unmatchedCard.state, "unmatched_identity");
  assert.match(renderCommunityBoardMoneyCard(unmatchedCard), /does not establish an accepted exact financial identity/);

  const staleCard = buildCommunityBoardMoneyCardView(buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "bronx-cb-01" }],
    adoptedBudget: budget,
    paymentActuals: payments,
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2028-01-01T00:00:00Z",
    maxAgeMs: 1,
  }), "bronx-cb-01");
  assert.equal(staleCard.state, "stale_source");
  assert.match(renderCommunityBoardMoneyCard(staleCard), /need a fresh check/);
});
