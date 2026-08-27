import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { executeContractsAnalysis } from "../capabilities/contracts_analysis.mjs";
import { createContractsAnalysisProvider } from "../capabilities/contracts_analysis_provider.mjs";
import {
  filterAnalyticalContracts,
  groupAnalyticalContracts,
} from "../site/analytical_projection.mjs";

const projection = {
  schema: "cityscroll.analytical_projection.v1",
  generated_at: "2026-08-18T20:00:00Z",
  snapshot_date: "2026-08-18",
  population_definition: "Normalized Checkbook NYC registered expense contracts; one row per exact prime_contract_id.",
  rows: [
    { prime_contract_id: "CT-A", agency: "Agency A", prime_vendor: "Vendor A", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 100, original_registered_amount: 90, registration_lag_days: -1, registration_timing: "early_on_time", city_record_match: "exact" },
    { prime_contract_id: "CT-B", agency: "Agency A", prime_vendor: "Vendor B", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 200, original_registered_amount: 180, registration_lag_days: 2, registration_timing: "retroactive", city_record_match: "none" },
    { prime_contract_id: "CT-C", agency: "Agency B", prime_vendor: null, registration_fiscal_year: 2026, contract_amount_band: "$100,000–$999,999", current_registered_amount: 300, original_registered_amount: 270, registration_lag_days: null, registration_timing: null, city_record_match: "cannot_evaluate_missing_pin" },
  ],
};

test("Contracts Overview UI projection is equivalent to the public capability", async () => {
  const filters = { agency: "Agency A", registration_fiscal_year: 2027 };
  const uiGroups = groupAnalyticalContracts(filterAnalyticalContracts(projection.rows, filters), {
    groupBy: "vendor",
    measure: "current",
    topN: 10,
  });
  const capability = await executeContractsAnalysis(createContractsAnalysisProvider(projection), {
    agency: filters.agency,
    fiscalYear: filters.registration_fiscal_year,
    groupBy: "vendor",
    measure: "current",
    limit: 10,
  });
  assert.deepEqual(
    capability.groups.map((group) => [group.label, group.value, group.contract_count, group.contract_ids]),
    uiGroups.shown_groups.map((group) => [group.label, group.sum_current_registered_amount, group.contract_count, group.contract_ids]),
  );
  assert.equal(capability.denominator.value, 300);
  assert.equal(capability.denominator.contract_count, 2);
  assert.match(capability.groups[0].drill_through.href, /ap_agency=Agency\+A/);
});

test("Contracts Overview binds the UI to the capability provider and keeps static delivery", () => {
  const source = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
  assert.match(source, /createContractsAnalysisProvider/);
  assert.match(source, /executeContractsAnalysis/);
  assert.match(source, /capabilityResult\.groups/);
  assert.match(source, /ANALYTICAL_PROJECTION_URL/);
});
