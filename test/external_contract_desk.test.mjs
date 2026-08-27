import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CONTRACTS_ANALYSIS_PATH,
  buildContractDeskReport,
  formatContractDeskReport,
} from "../examples/external-contract-desk/index.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/external_contract_desk_analysis.json", import.meta.url), "utf8"));
const catalog = JSON.parse(readFileSync(new URL("../site/data/api_capability_catalog.json", import.meta.url), "utf8"));

function fixtureFetch(url) {
  const parsed = new URL(url);
  assert.equal(parsed.pathname, CONTRACTS_ANALYSIS_PATH);
  const measure = parsed.searchParams.get("measure");
  const payload = fixture[measure];
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

test("independent contract desk composes two documented public responses", async () => {
  const report = await buildContractDeskReport({
    agency: "Agency A",
    apiOrigin: "https://api.cityscroll.org",
    limit: 10,
    fetchImpl: fixtureFetch,
  });

  assert.equal(report.schema, "cityscroll.external_contract_desk_report.v1");
  assert.equal(report.availability, "complete");
  assert.equal(report.fact, "registered_contract");
  assert.equal(report.measure.denominator_value, 300);
  assert.equal(report.measure.denominator_contract_count, 2);
  assert.equal(report.coverage.matched_contract_count, 1);
  assert.deepEqual(report.vendors.map(({ label, registered_value, contract_count, contract_ids }) => ({ label, registered_value, contract_count, contract_ids })), [
    { label: "Vendor B", registered_value: 200, contract_count: 1, contract_ids: ["CT-B"] },
    { label: "Vendor A", registered_value: 100, contract_count: 1, contract_ids: ["CT-A"] },
  ]);
  assert.equal(report.vendors[0].registered_value_share, 2 / 3);
  assert.match(report.vendors[0].site_drill_through, /cityscroll\.org\/browse\/contracts/);
  assert.equal(report.parity.group_identity_agrees, true);
  assert.match(report.known_gaps[0], /not actual payments or spending/);

  const text = formatContractDeskReport(report);
  assert.match(text, /Vendor B — \$200 \(66\.7%; 1 contract\)/);
  assert.match(text, /not actual payments or spending/);
});

test("the consumer's source is bounded to documented public HTTP paths", () => {
  const source = readFileSync(new URL("../examples/external-contract-desk/index.mjs", import.meta.url), "utf8");
  assert.match(source, /https:\/\/api\.cityscroll\.org/);
  assert.match(source, /\/contracts\/analysis/);
  assert.doesNotMatch(source, /(?:\.\.\/){2}(?:site|worker|capabilities)\//);
  assert.doesNotMatch(source, /analytics_registered_contracts|shared_procurement_read_model|readFileSync/);
});

test("the public catalog documents the operation this consumer calls", () => {
  const operation = catalog.operations.find(({ reference }) => reference === "contracts.analysis@1");
  assert.ok(operation, "contracts analysis must remain in the public capability catalog");
  const http = operation.transports.find(({ kind }) => kind === "http-route");
  assert.equal(http.route, "GET /contracts/analysis");
  assert.ok(http.representations.some(({ id, mediaType }) => id === "json" && mediaType === "application/json"));
});

test("a public empty response stays an honest empty report", async () => {
  const report = await buildContractDeskReport({
    agency: "No Such Agency",
    fetchImpl: async () => new Response(JSON.stringify({
      capability_reference: "contracts.analysis@1",
      availability: "empty",
      groups: [],
      denominator: { value: 0, unit: "USD", contract_count: 0 },
      coverage: { statement: "none" },
      freshness: { as_of: "2026-08-18T20:00:00Z" },
    }), { status: 200 }),
  });
  assert.equal(report.availability, "empty");
  assert.deepEqual(report.vendors, []);
  assert.match(formatContractDeskReport(report), /No public registered-contract rows/);
});

test("a documented unavailable response stays an honest unavailable report", async () => {
  const report = await buildContractDeskReport({
    agency: "Agency A",
    fetchImpl: async () => new Response(JSON.stringify({
      capability_reference: "contracts.analysis@1",
      availability: "unavailable",
      groups: null,
      error: "unavailable",
    }), { status: 503 }),
  });
  assert.equal(report.availability, "unavailable");
  assert.deepEqual(report.vendors, []);
  assert.match(formatContractDeskReport(report), /no claims were made/);
});
