import assert from "node:assert/strict";
import test from "node:test";

import {
  isContractPinShaped,
  normalizeCheckbookContractRows,
} from "../warehouse/lib/checkbook_contracts.mjs";

// Checkbook publishes a contract PIN of ten characters or more for a contract
// it can identify; every PIN that exactly matches a PASSPort or City Record
// record is between ten and seventeen alphanumeric characters. For contracts it
// cannot identify it publishes a short numeric code in the same field. Those
// codes repeat across unrelated contracts, so carrying one as a key makes
// separate procurements look like one.
test("a short numeric code is not a contract PIN", () => {
  for (const pin of ["00223G0001001", "84120P8912KXLR001", "07121P0125009", "26026N0011051"]) {
    assert.equal(isContractPinShaped(pin), true, pin);
  }
  for (const pin of ["24", "11", "09", "1234", "97", "", null, undefined]) {
    assert.equal(isContractPinShaped(pin), false, String(pin));
  }
});

function slice(contractId, pin) {
  return {
    prime_contract_id: contractId,
    contract_id: contractId,
    pin,
    vendor: `VENDOR ${contractId}`,
    prime_vendor: `VENDOR ${contractId}`,
    agency: "Department of Education",
    vendorRecordType: "Prime Vendor",
    registered: "2026-01-05",
    start: "2026-01-05",
    end: "2027-06-30",
    current: 1000,
    original: 1000,
    spent: 0,
    fiscal_year: "2026",
    status: "registered",
  };
}

test("an unusable identifier is not carried as a contract key", () => {
  const normalized = normalizeCheckbookContractRows([
    slice("CT100000000000001", "00223G0001001"),
    slice("CT100000000000002", "24"),
    slice("CT100000000000003", "24"),
  ]);
  const byId = new Map(normalized.rows.map((row) => [row.contract_id, row]));

  const identified = byId.get("CT100000000000001");
  assert.equal(identified.pin, "00223G0001001", "a real PIN is kept");
  assert.equal(identified.exact_key_status.pin, "exact");

  // Both of these arrived carrying the same short code. Neither keeps it, so
  // they cannot be read as one procurement, and each still has its contract id.
  for (const contractId of ["CT100000000000002", "CT100000000000003"]) {
    const row = byId.get(contractId);
    assert.equal(row.pin, null, `${contractId} drops the unusable identifier`);
    assert.equal(row.exact_key_status.pin, "unusable", contractId);
    assert.equal(row.exact_key_status.contract_id, "exact", `${contractId} keeps its contract id`);
  }
});
