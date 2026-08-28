import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  resolveAgencyIdentity,
} from "../site/agency_identity.mjs";
import {
  resolveCommunityBoardFinancialIdentity,
  validateCommunityBoardFinancialIdentity,
} from "../site/community_board_financial_identity.mjs";

const registry = JSON.parse(readFileSync("site/data/community_board_financial_identity_crosswalk.json", "utf8"));
const receipt = JSON.parse(readFileSync("warehouse/receipts/proof/community_board_financial_identity_latest.json", "utf8"));

test("CB-MONEY-00 reviewed artifact covers the 59 existing Community Board identities", () => {
  const validation = validateCommunityBoardFinancialIdentity(registry, receipt);
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(registry.boards.length, 59);
  assert.equal(new Set(registry.boards.map((board) => board.board_id)).size, 59);
  assert.equal(receipt.measurement.reviewed_precision, 1);
  assert.deepEqual(receipt.ambiguous_identities, []);
  assert.deepEqual(receipt.unmatched_identities, []);
});

test("publisher code resolves source-scoped identities and unknown keys abstain", () => {
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "expense_budget", "485"), "brooklyn-cb-15");
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "checkbook_spending", "485"), "brooklyn-cb-15");
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "checkbook_contracts", "383"), "bronx-cb-03");
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "checkbook_spending", "383"), null);
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "checkbook_spending", "unknown"), null);
  assert.equal(resolveCommunityBoardFinancialIdentity(registry, "expense_budget", "MANHATTAN COMMUNITY BOARD #6"), null);
});

test("the generic Community Boards agency grouping remains unchanged", () => {
  assert.equal(resolveAgencyIdentity("Brooklyn Community Board #15").canonical_name, "Community Boards");
  assert.equal(resolveAgencyIdentity("Manhattan Community Board #6").canonical_name, "Community Boards");
});
