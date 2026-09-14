import assert from "node:assert/strict";
import test from "node:test";
import { buildProcurementSourceLookupReceipt } from "../site/procurement_source_lookup_receipt.mjs";

const obs = (system, id, snapshot) => ({ source_system: system, source_system_id: id, source_observation_ref: `${system}:${id}`, snapshot });

test("exact Checkbook analytical evidence is retained without changing identity", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:CT107120258801626", identity_keys: { contract_ids: ["CT107120258801626"], epins: ["84124P0003001"] } },
    observations: [obs("passport_public_contracts", "contract:84124P0003001:CT107120258801626", { contract_id: "CT107120258801626", epin: "84124P0003001" })],
    materializations: { analytics_registered_contracts: { status: "available", snapshot_date: "2026-09-09", generated_at: "2026-09-09T06:33:01Z", rows: [{ prime_contract_id: "CT107120258801626", pin: "84124P0003001" }] } },
    generatedAt: "2026-09-14T00:00:00Z",
  });
  const checkbook = receipt.sources.find((row) => row.source_system === "checkbook_contracts");
  assert.equal(checkbook.state, "corroborated");
  assert.deepEqual(checkbook.matched_analytical_row_refs, ["checkbook_contracts:row:CT107120258801626"]);
  assert.equal(checkbook.snapshot_vintage, "2026-09-09");
});

test("unavailable sources and ordinary NYC ABO objects stay unresolved or inapplicable", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:DHS-1", identity_keys: { contract_ids: ["DHS-1"] } },
    observations: [obs("passport_public_contracts", "dhs", { contract_id: "DHS-1", agency: "Department of Homeless Services" })],
    materializations: { checkbook_spending: { status: "unavailable", generated_at: "2026-09-14T00:00:00Z" } },
    generatedAt: "2026-09-14T00:00:00Z",
  });
  assert.equal(receipt.sources.find((row) => row.source_system === "checkbook_spending").state, "unavailable");
  assert.equal(receipt.sources.find((row) => row.source_system === "nys_abo_awards").applicability, "not-applicable");
  assert.equal(receipt.sources.find((row) => row.source_system === "nys_abo_awards").state, "not-applicable");
  assert.equal(receipt.sources.find((row) => row.source_system === "nys_abo_awards").lookup_as_of, undefined);
});

test("multiple exact candidates are ambiguous and retain all references", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:CT-1", identity_keys: { contract_ids: ["CT-1"] } },
    observations: [obs("checkbook_contracts", "a", { contract_id: "CT-1" }), obs("checkbook_contracts", "b", { contract_id: "CT-1" })],
    generatedAt: "2026-09-14T00:00:00Z",
  });
  const checkbook = receipt.sources.find((row) => row.source_system === "checkbook_contracts");
  assert.equal(checkbook.state, "ambiguous");
  assert.deepEqual(checkbook.matched_source_observation_refs, ["checkbook_contracts:a", "checkbook_contracts:b"]);
});
