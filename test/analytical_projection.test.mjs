import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  REGISTERED_CONTRACT_PROJECTION,
  UNKNOWN_DIMENSION_LABEL,
  assertSupportedProjection,
} from "../site/analytical_projection_contract.mjs";
import {
  analyticalDrillThroughHref,
  contractAmountBand,
  filterAnalyticalContracts,
  groupAnalyticalContracts,
  normalizeAnalyticalContractRow,
  registrationFiscalYear,
} from "../site/analytical_projection.mjs";
import { normalizeCheckbookContractRows } from "../warehouse/lib/checkbook_contracts.mjs";

describe("registered contract analytical projection contract", () => {
  it("declares reader labels, source fields, and the registration-year guard", () => {
    assert.equal(REGISTERED_CONTRACT_PROJECTION.fact, "registered_contract");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.measures.sum_current_registered_amount.reader_label, "Current registered contract value");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.measures.sum_original_registered_amount.reader_label, "Original registered contract value");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.dimensions.registration_fiscal_year.source_field, "prime_contract_registration_date");
    assert.match(REGISTERED_CONTRACT_PROJECTION.guards.join(" "), /source_fiscal_years.*provenance/i);
    assert.throws(() => assertSupportedProjection({ fact: "payment", measure: "sum_current_registered_amount" }), /Unsupported analytical fact/);
    assert.throws(() => assertSupportedProjection({ measure: "sum_current_registered_amount", dimension: "industry" }), /Unsupported dimension/);
  });

  it("derives NYC registration fiscal years and versioned amount bands", () => {
    assert.equal(registrationFiscalYear("2025-06-30"), 2025);
    assert.equal(registrationFiscalYear("2025-07-01"), 2026);
    assert.equal(registrationFiscalYear("not-a-date"), null);
    assert.equal(contractAmountBand(0), "Under $100,000");
    assert.equal(contractAmountBand(100000), "$100,000–$999,999");
    assert.equal(contractAmountBand(1000000), "$1 million–$9.99 million");
    assert.equal(contractAmountBand(null), null);
  });

  it("keeps null dimensions honest and aggregates each contract once", () => {
    const collapsed = normalizeCheckbookContractRows([
      { id: "CT-1", vendorRecordType: "Prime Vendor", agency: "Agency A", vendor: "Vendor A", current: 100, original: 90, registered: "2025-08-01", sourceFiscalYears: ["2025"] },
      { id: "CT-1", vendorRecordType: "Sub Vendor", agency: "Agency A", vendor: "Vendor A", current: 0, original: 0, registered: "2025-08-01", sourceFiscalYears: ["2026"] },
      { id: "CT-2", vendorRecordType: "Prime Vendor", agency: "Agency B", vendor: "Vendor B", current: 200, original: 180, registered: "2025-08-02", sourceFiscalYears: ["2026"] },
    ]);
    assert.equal(collapsed.rows.length, 2);
    assert.equal(collapsed.counts.duplicate_slices_collapsed, 1);
    const rows = collapsed.rows.map(normalizeAnalyticalContractRow);
    rows.find((row) => row.prime_contract_id === "CT-2").agency = null;
    const grouped = groupAnalyticalContracts(rows, { groupBy: "agency", measure: "current" });
    assert.equal(grouped.groups.find((group) => group.label === UNKNOWN_DIMENSION_LABEL).sum_current_registered_amount, 200);
    assert.equal(grouped.groups.reduce((sum, group) => sum + group.contract_count, 0), 2);
    const agencyA = grouped.groups.find((group) => group.label === "Agency A");
    assert.deepEqual(
      { count: agencyA.contract_count, sum_original: agencyA.sum_original_registered_amount, sum_current: agencyA.sum_current_registered_amount },
      { count: 1, sum_original: 90, sum_current: 100 },
    );
  });

  it("filters and emits an exact ordinary Contracts drill-through scope", () => {
    const rows = [
      normalizeAnalyticalContractRow({ id: "CT-A", agency: "Agency A", vendor: "Vendor A", current: 100, original: 90, registered: "2025-08-01" }),
      normalizeAnalyticalContractRow({ id: "CT-B", agency: "Agency B", vendor: "Vendor A", current: 200, original: 180, registered: "2026-08-01" }),
    ];
    const filtered = filterAnalyticalContracts(rows, { agency: "Agency A", registration_fiscal_year: 2027 });
    assert.equal(filtered.length, 0);
    const href = analyticalDrillThroughHref({ agency: "Agency A", prime_vendor: "Vendor A", registration_fiscal_year: 2026, min_amount: 1000 });
    assert.equal(href, "/browse/contracts/?mode=award&ap_agency=Agency+A&ap_vendor=Vendor+A&ap_fy=2026&ap_min=1000");
  });
});

describe("committed analytical population artifact", () => {
  it("is a distinct-contract population artifact with an auditable receipt", () => {
    const projection = JSON.parse(readFileSync("site/data/analytics_registered_contracts.json", "utf8"));
    const receipt = JSON.parse(readFileSync("warehouse/receipts/proof/analytics_registered_contracts_population_latest.json", "utf8"));
    const ids = new Set(projection.rows.map((row) => row.prime_contract_id));
    assert.equal(projection.schema, "cityscroll.analytics_registered_contracts.v1");
    assert.equal(ids.size, projection.rows.length);
    assert.equal(ids.size, receipt.population.distinct_prime_contract_ids);
    assert.equal(receipt.materialization.table, "analytics_registered_contracts");
    assert.equal(receipt.materialization.request_time_database_queries, false);
    assert.ok(receipt.dimension_profile.agency.distinct_count > 0);
    assert.ok(receipt.dimension_profile.prime_vendor.distinct_count > 0);
  });
});
