import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import {
  PAYROLL_TITLE_ALLOWED_FIELDS,
  payrollTitlePiiFindings,
  payrollTitleRows,
} from "../site/payroll_title_mart.mjs";
import {
  boardIdFromPayrollPublisherName,
  buildCommunityBoardPayrollStaffCount,
  measureCommunityBoardPayrollIdentity,
  payrollIdentityServeContractFindings,
  resolveCommunityBoardPayrollIdentity,
  validateCommunityBoardPayrollStaffCount,
} from "../site/community_board_payroll_identity.mjs";
import {
  resolveCommunityBoardFinancialIdentity,
  validateCommunityBoardFinancialIdentity,
} from "../site/community_board_financial_identity.mjs";

const registry = JSON.parse(readFileSync("site/data/community_board_financial_identity_crosswalk.json", "utf8"));
const identityReceipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_financial_identity_latest.json", "utf8"));
const inventory = JSON.parse(readFileSync("warehouse/fixtures/community-board-payroll/fy2025_identity_inventory.json", "utf8"));
const titleMart = JSON.parse(readFileSync("site/data/payroll_title_warehouse_lookup.json", "utf8"));
const sourceContract = JSON.parse(readFileSync("site/data/source_contracts.json", "utf8"));

test("exact payroll_number bindings cover all 59 boards without employee fields", () => {
  const receipt = measureCommunityBoardPayrollIdentity(registry, inventory, {
    generatedAt: "2026-08-29T00:00:00.000Z",
    reviewedAt: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(receipt.measurement.accepted_binding_count, 59);
  assert.equal(receipt.measurement.reviewed_precision, 1);
  assert.deepEqual(receipt.unmatched_identities, []);
  assert.deepEqual(receipt.ambiguous_identities, []);
  assert.deepEqual(receipt.boards_with_no_observed_identity.citywide_payroll, []);
  assert.deepEqual(receipt.boards_with_zero_active_rows.citywide_payroll, ["queens-cb-12"]);
  assert.equal(receipt.hard_rules.employee_rows_never_served, true);
  assert.equal(payrollIdentityServeContractFindings(receipt).length, 0);
  assert.ok(receipt.bindings.every((binding) => !("last_name" in binding) && !("first_name" in binding)));
  assert.equal(JSON.stringify(receipt.bindings).includes("DOE"), false);
});

test("positive exact bindings: Brooklyn 15, Bronx 3, Staten Island COMMUNITY BD #1", () => {
  assert.equal(
    resolveCommunityBoardPayrollIdentity(registry, inventory.identities, "485"),
    "brooklyn-cb-15",
  );
  assert.equal(
    resolveCommunityBoardPayrollIdentity(registry, inventory.identities, "383"),
    "bronx-cb-03",
  );
  assert.equal(boardIdFromPayrollPublisherName("STATEN ISLAND COMMUNITY BD #1"), "staten-island-cb-01");
  assert.equal(
    resolveCommunityBoardPayrollIdentity(registry, inventory.identities, "491"),
    "staten-island-cb-01",
  );
  assert.equal(
    resolveCommunityBoardFinancialIdentity(registry, "expense_budget", "491"),
    "staten-island-cb-01",
  );
});

test("negative: missing identity, name-only, generic label, and unknown code abstain", () => {
  assert.equal(resolveCommunityBoardPayrollIdentity(registry, inventory.identities, "999"), null);
  assert.equal(resolveCommunityBoardPayrollIdentity(registry, inventory.identities, null), null);
  assert.equal(boardIdFromPayrollPublisherName("COMMUNITY BOARDS"), null);
  assert.equal(
    resolveCommunityBoardPayrollIdentity(
      registry,
      [{ payroll_number: null, agency_name: "BROOKLYN COMMUNITY BOARD #15" }],
      null,
    ),
    null,
  );
  assert.equal(
    resolveCommunityBoardPayrollIdentity(
      registry,
      [{ payroll_number: "999", agency_name: "UNKNOWN COMMUNITY BOARD #99" }],
      "999",
    ),
    null,
  );
});

test("ambiguous shared payroll_number stays unresolved", () => {
  const clash = [
    { payroll_number: "485", agency_name: "BROOKLYN COMMUNITY BOARD #15" },
    { payroll_number: "485", agency_name: "BROOKLYN COMMUNITY BOARD #16" },
  ];
  assert.equal(resolveCommunityBoardPayrollIdentity(registry, clash, "485"), null);
  const measured = measureCommunityBoardPayrollIdentity(registry, { identities: clash });
  assert.equal(measured.accepted_bindings.citywide_payroll, 0);
  assert.equal(measured.ambiguous_identities.length, 1);
  assert.equal(measured.measurement.no_ambiguous_accepted_bindings, false);
});

test("no cross-board inheritance and geography is not identity", () => {
  assert.equal(
    resolveCommunityBoardPayrollIdentity(registry, inventory.identities, "485"),
    "brooklyn-cb-15",
  );
  assert.notEqual(
    resolveCommunityBoardPayrollIdentity(registry, inventory.identities, "485"),
    "brooklyn-cb-16",
  );
  const manhattan = inventory.identities.find((row) => row.payroll_number === "341");
  assert.equal(
    resolveCommunityBoardPayrollIdentity(registry, [manhattan], "341", {
      work_location_borough: "BROOKLYN",
    }),
    "manhattan-cb-01",
  );
  assert.equal(boardIdFromPayrollPublisherName("BROOKLYN"), null);
});

test("source-contract check: employee rows are never served", () => {
  const citywide = sourceContract.contracts.find((row) => row.id === "citywide-payroll");
  assert.ok(citywide, "citywide-payroll source contract is registered");
  assert.match(citywide.product_freshness, /Individual employee rows are never served/);
  assert.deepEqual(titleMart.pii.employee_rows, false);
  assert.deepEqual(titleMart.pii.allowed_fields, [...PAYROLL_TITLE_ALLOWED_FIELDS]);
  assert.equal(payrollTitlePiiFindings(titleMart).length, 0);
  for (const row of payrollTitleRows(titleMart).slice(0, 5)) {
    assert.deepEqual(Object.keys(row).sort(), ["avg", "mn", "mx", "n", "title_description"]);
  }
  assert.equal("agency_name" in (titleMart.rows[0] || {}), false);
  assert.equal("payroll_number" in (titleMart.rows[0] || {}), false);
  const employee = inventory.negatives.employee_row;
  assert.ok(payrollIdentityServeContractFindings({ identities: [employee] }).some((finding) => /last_name/.test(finding)));
});

test("CB-MONEY-00 financial identity is unchanged and still exact-only", () => {
  assert.deepEqual(validateCommunityBoardFinancialIdentity(registry, identityReceipt), { ok: true, errors: [] });
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "citywide_payroll", "485"), null);
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "expense_budget", "MANHATTAN COMMUNITY BOARD #6"), null);
  assert.equal(resolveAgencyIdentity("Brooklyn Community Board #15").canonical_name, "Community Boards");
});

test("per-board payroll dollars and titles are not semantically justified under k-suppression", () => {
  const receipt = measureCommunityBoardPayrollIdentity(registry, inventory, {
    generatedAt: "2026-08-29T00:00:00.000Z",
  });
  assert.ok(receipt.measurement.max_active_rows < receipt.measurement.k_suppression_threshold);
  assert.equal(receipt.measurement.boards_at_or_above_k_suppression, 0);
  assert.equal(receipt.aggregate_semantics.staff_count.justified, true);
  assert.equal(receipt.aggregate_semantics.title_mix.justified, false);
  assert.equal(receipt.aggregate_semantics.payroll_measures.justified, false);
});

test("staff-count artifact publishes ACTIVE rows only and withholds dollars and titles", () => {
  const { model, receipt } = buildCommunityBoardPayrollStaffCount(registry, inventory, {
    generatedAt: "2026-08-29T20:00:00.000Z",
    reviewedAt: "2026-08-29T20:00:00.000Z",
  });
  assert.deepEqual(validateCommunityBoardPayrollStaffCount(model, receipt), { ok: true, errors: [] });
  assert.equal(model.rows.length, 59);
  assert.equal(model.withheld.payroll_measures, true);
  assert.equal(model.withheld.title_mix, true);
  assert.equal(model.withheld.employee_rows, true);
  const brooklyn15 = model.rows.find((row) => row.board_id === "brooklyn-cb-15");
  const brooklyn16 = model.rows.find((row) => row.board_id === "brooklyn-cb-16");
  const staten1 = model.rows.find((row) => row.board_id === "staten-island-cb-01");
  const queens12 = model.rows.find((row) => row.board_id === "queens-cb-12");
  assert.equal(brooklyn15.source_native_board_key, "485");
  assert.notEqual(brooklyn15.source_native_board_key, brooklyn16.source_native_board_key);
  assert.equal(staten1.publisher_identity, "STATEN ISLAND COMMUNITY BD #1");
  assert.equal(queens12.active_row_count, 0);
  assert.ok(queens12.published_row_count > 0);
  assert.equal(payrollIdentityServeContractFindings(model).length, 0);
  const served = JSON.parse(readFileSync("site/data/community_board_payroll_staff_count.json", "utf8"));
  const committedReceipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_payroll_identity_latest.json", "utf8"));
  assert.deepEqual(validateCommunityBoardPayrollStaffCount(served, committedReceipt), { ok: true, errors: [] });
  assert.equal(JSON.stringify(served.rows).includes("DISTRICT MANAGER"), false);
  assert.equal(JSON.stringify(served.rows).includes("regular_gross_paid"), false);
  assert.equal(JSON.stringify(served.rows).includes("DOE"), false);
});
