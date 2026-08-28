import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  componentSemanticCheck,
  materializeCommunityBoardAdoptedBudget,
  sourceRowFingerprint,
  validateCommunityBoardAdoptedBudget,
} from "../site/community_board_adopted_budget.mjs";

const registry = JSON.parse(readFileSync("site/data/community_board_financial_identity_crosswalk.json", "utf8"));
const identityReceipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_financial_identity_latest.json", "utf8"));

const row = (overrides = {}) => ({
  fiscal_year: "2027",
  publication_date: "20260630",
  agency_number: "485",
  agency_name: "BROOKLYN COMMUNITY BOARD #15",
  unit_appropriation_number: "001",
  unit_appropriation_name: "PERSONAL SERVICES",
  budget_code_number: "1000",
  budget_code_name: "CONVERSION NAME",
  object_class_number: "01",
  object_class_name: "FULL TIME SALARIED",
  object_code: "001",
  object_code_name: "FULL YEAR POSITIONS",
  responsibility_center_code: "1000",
  responsibility_center_name: "BROOKLYN COMMUNITY BOARD #15",
  personal_service_other_than_personal_service_indicator: "P",
  adopted_budget_amount: "224219",
  ...overrides,
});

test("adopted budget materialization uses exact identity and suppresses duplicate rows", () => {
  const rows = [
    row(),
    row({
      unit_appropriation_number: "002",
      unit_appropriation_name: "OTHER THAN PERSONAL SERVICES",
      object_class_number: "10",
      object_class_name: "SUPPLIES AND MATERIALS",
      object_code: "100",
      object_code_name: "SUPPLIES + MATERIALS - GENERAL",
      personal_service_other_than_personal_service_indicator: "O",
      adopted_budget_amount: "46186",
    }),
    row(),
    row({ agency_number: "999", agency_name: "UNKNOWN COMMUNITY BOARD", adopted_budget_amount: "10" }),
  ];
  const materialized = materializeCommunityBoardAdoptedBudget({
    rows,
    registry,
    identityReceipt,
    fiscalYear: 2027,
    publicationDate: "20260630",
    sourceVintage: "2026-07-08",
    observedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.equal(materialized.rows.length, 1);
  assert.equal(materialized.rows[0].board_id, "brooklyn-cb-15");
  assert.equal(materialized.rows[0].adopted_amount, 270405);
  assert.equal(materialized.rows[0].personnel_amount, 224219);
  assert.equal(materialized.rows[0].otps_amount, 46186);
  assert.equal(materialized.coverage.duplicate_rows_suppressed, 1);
  assert.equal(materialized.unmatched_rows.length, 1);
  assert.equal(materialized.unmatched_rows[0].reason, "no_accepted_cb_money_00_binding");
  assert.equal(materialized.rows[0].binding_status, "accepted");
  assert.equal(materialized.rows[0].provenance.fiscal_year, 2027);
  assert.equal(validateCommunityBoardAdoptedBudget(materialized).ok, true);
});

test("components publish only when indicator and appropriation semantics reconcile", () => {
  assert.equal(componentSemanticCheck([row(), row({
    unit_appropriation_number: "002",
    unit_appropriation_name: "OTHER THAN PERSONAL SERVICES",
    personal_service_other_than_personal_service_indicator: "O",
    adopted_budget_amount: "46186",
  })]).status, "verified");
  assert.equal(componentSemanticCheck([row({ unit_appropriation_name: "CURRENT MODIFIED BUDGET" })]).status, "unsupported");
});

test("row fingerprint ignores volatile Socrata metadata but includes source facts", () => {
  assert.equal(sourceRowFingerprint({ ...row(), ":id": "one" }), sourceRowFingerprint({ ...row(), ":id": "two" }));
  assert.notEqual(sourceRowFingerprint(row()), sourceRowFingerprint(row({ adopted_budget_amount: "224220" })));
});

test("committed artifact has explicit adopted-budget provenance and receipt", () => {
  const readModel = JSON.parse(readFileSync("site/data/community_board_adopted_budget.json", "utf8"));
  const receipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_adopted_budget_latest.json", "utf8"));
  assert.equal(validateCommunityBoardAdoptedBudget(readModel).ok, true);
  assert.equal(readModel.terminology, "adopted budget");
  assert.equal(readModel.source.pinned_slice.fiscal_year, 2027);
  assert.equal(readModel.rows.length, 59);
  assert.equal(receipt.measurement.provenance_carried_to_read_model, true);
  assert.equal(receipt.measurement.unmatched_rows_reported, true);
});
