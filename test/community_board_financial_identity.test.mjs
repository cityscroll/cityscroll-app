import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("the receipt is source-complete and the landed financial read models use its exact bindings", () => {
  const budget = JSON.parse(readFileSync("site/data/community_board_adopted_budget.json", "utf8"));
  const payments = JSON.parse(readFileSync("site/data/community_board_payment_actuals.json", "utf8"));
  const expectedHash = createHash("sha256").update(`${JSON.stringify(registry, null, 2)}\n`).digest("hex");
  assert.equal(receipt.artifact_sha256, expectedHash);
  for (const source of ["expense_budget", "checkbook_contracts", "checkbook_spending"]) {
    assert.equal(receipt.sources[source].source_system, source);
    assert.ok(receipt.sources[source].source_vintage);
    assert.ok(Array.isArray(receipt.sources[source].identities));
    assert.equal(receipt.accepted_bindings[source], registry.bindings.filter((binding) => binding.source_system === source).length);
  }
  for (const row of budget.rows) {
    assert.equal(resolveCommunityBoardFinancialIdentity(registry, "expense_budget", row.source_native_key), row.board_id);
  }
  for (const row of payments.rows) {
    for (const observation of row.observations) {
      assert.equal(resolveCommunityBoardFinancialIdentity(
        registry,
        "checkbook_spending",
        observation.identity.source_native_board_key,
      ), row.board_id);
      assert.equal(observation.identity.publisher_identity, registry.bindings.find((binding) =>
        binding.source_system === "checkbook_spending"
          && binding.source_native_board_key === observation.identity.source_native_board_key)?.publisher_identity);
    }
  }
});

test("the validator rejects an incomplete or downgraded receipt", () => {
  const incomplete = structuredClone(receipt);
  delete incomplete.sources.checkbook_spending.source_vintage;
  assert.equal(validateCommunityBoardFinancialIdentity(registry, incomplete).ok, false);

  const ambiguous = structuredClone(receipt);
  ambiguous.ambiguous_identities = [{ source_system: "checkbook_spending", source_native_board_key: "485" }];
  assert.equal(validateCommunityBoardFinancialIdentity(registry, ambiguous).ok, false);
});
