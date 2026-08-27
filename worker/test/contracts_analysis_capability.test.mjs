import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CONTRACTS_ANALYSIS_CAPABILITY,
  CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  executeContractsAnalysis,
} from "../../capabilities/contracts_analysis.mjs";
import {
  CONTRACTS_ANALYSIS_HTTP_ADAPTER,
  handleContractsAnalysis,
  workerContractsAnalysis,
} from "../src/contracts.mjs";
import { handleMcp } from "../src/mcp.mjs";

const projection = {
  schema: "cityscroll.analytical_projection.v1",
  generated_at: "2026-08-18T20:00:00Z",
  snapshot_date: "2026-08-18",
  population_definition: "Normalized Checkbook NYC registered expense contracts; one row per exact prime_contract_id.",
  source_population: { normalized_unique_contracts: 3, source_tag: "checkbook-contracts" },
  rows: [
    { prime_contract_id: "CT-A", agency: "Agency A", prime_vendor: "Vendor A", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 100, original_registered_amount: 90, city_record_match: "exact" },
    { prime_contract_id: "CT-B", agency: "Agency A", prime_vendor: "Vendor B", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 200, original_registered_amount: 180, city_record_match: "none" },
    { prime_contract_id: "CT-C", agency: "Agency B", prime_vendor: null, registration_fiscal_year: 2026, contract_amount_band: "$100,000–$999,999", current_registered_amount: 300, original_registered_amount: 270, city_record_match: "cannot_evaluate_missing_pin" },
  ],
};
const env = { ANALYTICAL_PROJECTION: projection };

function post(body) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
    body: JSON.stringify(body),
  });
}

test("Contracts analysis declares the bounded registered-contract fact", () => {
  assert.equal(CONTRACTS_ANALYSIS_CAPABILITY.reference, CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE);
  assert.deepEqual(CONTRACTS_ANALYSIS_CAPABILITY.input.groupings, ["agency", "vendor", "registration_fiscal_year", "amount_band"]);
  assert.deepEqual(CONTRACTS_ANALYSIS_CAPABILITY.input.measures, ["current", "original", "count"]);
  assert.equal(CONTRACTS_ANALYSIS_HTTP_ADAPTER.capabilityReference, CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE);
});

test("the provider returns ranked groups with explicit measure, denominator, coverage, and drill-through", async () => {
  const result = await executeContractsAnalysis(workerContractsAnalysis(env), { groupBy: "agency", measure: "current", limit: 10 });
  assert.equal(result.availability, "complete");
  assert.equal(result.measure.id, "sum_current_registered_amount");
  assert.equal(result.measure.unit, "USD");
  assert.equal(result.measure.fact, "registered_contract");
  assert.equal(result.measure.not_payment, true);
  assert.equal(result.denominator.value, 600);
  assert.equal(result.denominator.contract_count, 3);
  assert.match(result.denominator.definition, /not payments/);
  assert.equal(result.groups[0].label, "Agency A");
  assert.deepEqual(result.groups[0].contract_ids, ["CT-A", "CT-B"]);
  assert.match(result.groups[0].drill_through.href, /ap_agency=Agency\+A/);
  assert.equal(result.coverage.matched_contract_count, 1);
  assert.equal(result.coverage.missing_pin_contract_count, 1);
  assert.match(result.population.included, /3 exact registered-contract rows/);
  assert.ok(result.population.excluded.some((entry) => /payment transactions/.test(entry)));
});

test("count analysis preserves vendor grouping and the exact contributing IDs", async () => {
  const result = await executeContractsAnalysis(workerContractsAnalysis(env), {
    groupBy: "vendor", measure: "count", agency: "Agency A",
  });
  assert.equal(result.measure.unit, "contracts");
  assert.equal(result.denominator.value, 2);
  assert.deepEqual(result.groups.map((group) => [group.label, group.value, group.contract_ids]), [
    ["Vendor A", 1, ["CT-A"]],
    ["Vendor B", 1, ["CT-B"]],
  ]);
});

test("HTTP and MCP adapters delegate without reconstructing the analysis", async () => {
  const input = { groupBy: "vendor", measure: "current", agency: "Agency A", limit: 10 };
  const direct = await executeContractsAnalysis(workerContractsAnalysis(env), input);
  const http = await handleContractsAnalysis(new Request("https://api.cityscroll.org/contracts/analysis?group_by=vendor&measure=current&agency=Agency%20A&limit=10"), env);
  assert.equal(http.status, 200);
  assert.deepEqual(await http.json(), direct);
  const mcp = await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "analyze_contracts", arguments: { group_by: "vendor", measure: "current", agency: "Agency A", limit: 10 },
  } }), env);
  assert.deepEqual((await mcp.json()).result.structuredContent, direct);

  const source = readFileSync(new URL("../src/contracts.mjs", import.meta.url), "utf8");
  const mcpSource = readFileSync(new URL("../src/mcp.mjs", import.meta.url), "utf8");
  assert.match(source, /executeContractsAnalysis/);
  assert.match(mcpSource, /executeContractsAnalysis/);
  assert.doesNotMatch(mcpSource, /groupAnalyticalContracts|filterAnalyticalContracts/);
});
