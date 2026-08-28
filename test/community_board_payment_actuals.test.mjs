import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCommunityBoardPaymentActuals,
  paymentObservationRef,
  resolveCommunityBoardPaymentIdentity,
  validateCommunityBoardPaymentActuals,
} from "../site/community_board_payment_actuals.mjs";

const registry = {
  schema: "cityscroll.community_board_financial_identity.v1",
  bindings: [
    {
      source_system: "checkbook_spending",
      source_native_key_field: "agency_code",
      source_native_board_key: "346",
      publisher_identity: "Manhattan Community Board # 6",
      board_id: "manhattan-cb-06",
      binding_status: "accepted",
    },
  ],
};

const source = {
  endpoint: "https://www.checkbooknyc.com/api",
  source_receipt: "warehouse/receipts/proof/checkbook_payment_population_latest.json",
  source_vintage: { observed_at: "2026-08-11T00:00:00.000Z", payment_issue_date_through: "2026-06-30" },
  observed_at: "2026-08-11T00:00:00.000Z",
};

test("resolves payment identity from the accepted Checkbook Spending binding only", () => {
  assert.equal(resolveCommunityBoardPaymentIdentity(registry, { agency: "Manhattan Community Board # 6" }).board_id, "manhattan-cb-06");
  assert.equal(resolveCommunityBoardPaymentIdentity(registry, { agency: "Manhattan Community Board # 60" }), null);
});

test("materializes exact board/FY actuals with inspectable observations and deduplication", () => {
  const duplicate = {
    transaction_id: "checkbook_payment_population:tx-1",
    fiscal_year: 2026,
    issue_date: "2026-01-10",
    agency: "Manhattan Community Board # 6",
    payee_name: "Payee A",
    contract_id: "CT-1",
    check_amount: 100,
    document_id: "doc-1",
  };
  const second = { ...duplicate, transaction_id: "checkbook_payment_population:tx-2", check_amount: 25, payee_name: "Payee B", document_id: "doc-2" };
  const result = buildCommunityBoardPaymentActuals({
    boards: [{ board_id: "manhattan-cb-06" }, { board_id: "bronx-cb-03" }],
    identityRegistry: registry,
    payments: [duplicate, duplicate, second],
    source,
    fiscalYears: [2026],
    generatedAt: "2026-08-27T00:00:00.000Z",
  });
  const row = result.rows.find((item) => item.board_id === "manhattan-cb-06");
  assert.equal(row.posted_payment_amount, 125);
  assert.equal(row.payment_count, 2);
  assert.equal(row.distinct_payee_count, 2);
  assert.equal(row.distinct_contract_count, 1);
  assert.equal(row.observations.length, 2);
  assert.equal(row.observations[0].source_observation_ref, paymentObservationRef(duplicate));
  assert.equal(result.payment_population.duplicate_rows_suppressed, 1);
  assert.equal(result.rows.find((item) => item.board_id === "bronx-cb-03").coverage_status, "identity_unobserved");
  assert.equal(result.through_date_copy, "Payments posted through August 27, 2026");
  assert.equal(validateCommunityBoardPaymentActuals(result).ok, true);
});

test("committed artifact has all board/FY coverage states and no FY2027 completion language", () => {
  const value = JSON.parse(readFileSync("site/data/community_board_payment_actuals.json", "utf8"));
  assert.equal(value.schema, "cityscroll.community_board_payment_actuals.v1");
  assert.equal(value.rows.length, 59);
  assert.equal(value.through_date_copy, "Payments posted through August 27, 2026");
  assert.ok(value.rows.some((row) => row.payment_count > 0));
  assert.ok(value.rows.some((row) => row.coverage_status === "identity_unobserved"));
  assert.ok(!JSON.stringify(value).includes("FY2027 spending"));
  assert.equal(validateCommunityBoardPaymentActuals(value).ok, true);
});
