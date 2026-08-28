import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  measureCommunityBoardMoneyFollowFeasibility,
  validateCommunityBoardMoneyFollowFeasibility,
} from "../site/community_board_money_follow_feasibility.mjs";

const observation = (transaction_id, issue_date, check_amount, payee_name) => ({
  transaction_id: `checkbook_payment_population:${transaction_id}`,
  issue_date,
  check_amount,
  payee_name,
});

test("measures exact retained board payment deltas into bounded monthly digest groups", () => {
  const receipt = measureCommunityBoardMoneyFollowFeasibility({
    schema: "cityscroll.community_board_payment_actuals.v1",
    version: 1,
    generated_at: "2026-08-27T00:00:00.000Z",
    fiscal_years: [2026],
    source: {
      source_system: "checkbook_payment_population",
      source_contract: "cityscroll.checkbook.payments.fiscal_year.v1",
      source_vintage: { observed_at: null, payment_issue_date_through: "2026-06-30" },
      source_data_through: "2026-06-30",
    },
    payment_population: { candidate_rows: 4, duplicate_rows_suppressed: 1 },
    rows: [
      {
        board_id: "manhattan-cb-06",
        coverage_status: "posted_through_source_vintage",
        observations: [
          observation("one", "2026-01-02", 3000, "PAYEE A"),
          observation("two", "2026-01-20", 2500, "PAYEE B"),
          observation("one", "2026-01-02", 3000, "PAYEE A"),
          observation("three", "2026-02-01", 10, "PAYEE C"),
        ],
      },
      { board_id: "bronx-cb-03", coverage_status: "identity_unobserved", observations: [] },
    ],
  });
  assert.equal(receipt.status, "stop_without_shipping_follow_feature");
  assert.deepEqual(receipt.sample.sampled_board_ids, ["manhattan-cb-06"]);
  assert.equal(receipt.stable_payment_deltas.within_snapshot.retained_unique_payment_count, 3);
  assert.equal(receipt.stable_payment_deltas.within_snapshot.duplicate_observation_ids_suppressed, 1);
  assert.equal(receipt.stable_payment_deltas.cross_refresh.status, "unavailable");
  assert.equal(receipt.measurement.board_months.length, 2);
  assert.deepEqual(receipt.measurement.board_months[0], {
    board_id: "manhattan-cb-06",
    month: "2026-01",
    payment_count: 2,
    posted_payment_amount: 5500,
    distinct_payee_count: 2,
    largest_new_payee: { payee_name: "PAYEE A", posted_payment_amount: 3000, payment_count: 1 },
    meaningful_activity: true,
    source_observation_count: 2,
  });
  assert.equal(receipt.candidate_digest.raw_every_payment_alerts, "rejected");
  assert.equal(receipt.candidate_digest.maximum_digest_occasions_per_board_month, 1);
  assert.equal(receipt.existing_watch_action_seam.procurement_lifecycle_changed, false);
  assert.equal(validateCommunityBoardMoneyFollowFeasibility(receipt).ok, true);
});

test("committed CB-MONEY-07 receipt is source-bounded and does not ship a follow feature", () => {
  const receipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_money_follow_feasibility_latest.json", "utf8"));
  assert.equal(validateCommunityBoardMoneyFollowFeasibility(receipt).ok, true);
  assert.equal(receipt.sample.sampled_board_count, 58);
  assert.equal(receipt.measurement.retained_payment_count, 2961);
  assert.equal(receipt.measurement.board_months.length, 553);
  assert.equal(receipt.source.source_data_through, "2026-06-30");
  assert.equal(receipt.stable_payment_deltas.cross_refresh.status, "unavailable");
  assert.equal(receipt.decision.follow_feature_shipped, false);
  assert.match(receipt.candidate_digest.example_shape, /Largest new payee/);
  assert.doesNotMatch(JSON.stringify(receipt), /alert every payment|every small payment/i);
});
