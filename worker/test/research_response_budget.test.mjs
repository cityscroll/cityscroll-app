import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp } from "../src/mcp.mjs";
import { CAPABILITY_TOOL_CASES, createRemoteMcpFixtureEnv } from "./remote_mcp_fixture.mjs";
import { MACHINE_CLIENT_PROFILES } from "../../capabilities/machine_client_profile.mjs";
import { buildMcpToolCatalog } from "../../tools/build_capability_topology.mjs";
import { boundResearchToolResult, researchResponseBytes, RESEARCH_RESPONSE_MAX_BYTES } from "../../capabilities/research_response_limits.mjs";
import { analyzeContractsProjection } from "../../site/contracts_analysis_projection.mjs";
import { executeContractsAnalysis } from "../../capabilities/contracts_analysis.mjs";
import { executeContractsBrowse } from "../../capabilities/contracts.mjs";
import { workerContractsAnalysis, workerContractsBrowse, mcpContractsBrowseInput, handleContractsAnalysis } from "../src/contracts.mjs";

async function call(env, name, args) {
  const response = await handleMcp(new Request("https://api.cityscroll.org/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

const catalog = buildMcpToolCatalog();
const cases = [...CAPABILITY_TOOL_CASES, { name: "list_capability_gaps", arguments: {} }];
assert.deepEqual(cases.map((item) => item.name).sort(), [...MACHINE_CLIENT_PROFILES[0].allowlist].sort(), "every research catalog read needs a size case");
for (const item of cases) test(`${item.name}: actual MCP response fits the documented byte budget`, async () => {
  const fixture = createRemoteMcpFixtureEnv();
  try {
    const tool = catalog.tools.find((tool) => tool.name === item.name);
    assert.equal(tool.research_response.maximum_bytes, RESEARCH_RESPONSE_MAX_BYTES);
    const args = { ...item.arguments };
    if (tool.input_schema.properties.limit?.maximum) args.limit = tool.input_schema.properties.limit.maximum;
    if (item.name === "browse_contracts") delete args.vendor;
    if (item.name === "browse_organizations") { delete args.query; delete args.kind; }
    const result = await call(fixture.env, item.name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.ok(researchResponseBytes(result) < RESEARCH_RESPONSE_MAX_BYTES, `${item.name}: ${researchResponseBytes(result)} bytes`);
  } finally { fixture.close(); }
});

// Maximum-limit, unfiltered agency analysis is the expensive shape. Include
// multiple fiscal years, many groups, unresolved records and multibyte labels.
const projection = {
  schema: "cityscroll.analytical_projection.v1", generated_at: "2026-09-09T06:33:01.880Z", snapshot_date: "2026-09-09",
  rows: Array.from({ length: 69 }, (_, group) => Array.from({ length: group === 11 ? 3599 : 400 }, (_, index) => ({
    prime_contract_id: `CT-${group}-${index}`, agency: group === 68 ? null : `Agency ${group} é`, prime_vendor: `Vendor ${index % 3}`,
    registration_fiscal_year: index % 2 ? 2026 : 2027, current_registered_amount: 1000 + group, original_registered_amount: 800,
    contract_amount_band: "Under $100,000", registration_timing: index % 2 ? "retroactive" : "early_on_time", city_record_match: index % 2 ? "exact" : "none",
  }))).flat(),
};

for (const sampleLimit of [10, 50]) test(`all-years agency analysis, limit 100 and sample ${sampleLimit}: byte paging preserves every group`, async () => {
  const fixture = createRemoteMcpFixtureEnv();
  fixture.env.ANALYTICAL_PROJECTION = projection;
  try {
    const labels = new Set();
    let cursor;
    do {
      const result = await call(fixture.env, "analyze_contracts", { group_by: "agency", measure: "current", limit: 100, sample_limit: sampleLimit, ...(cursor ? { cursor } : {}) });
      assert.equal(result.isError, undefined);
      assert.ok(researchResponseBytes(result) < RESEARCH_RESPONSE_MAX_BYTES);
      const body = result.structuredContent;
      assert.equal(body.denominator.contract_count, projection.rows.length);
      for (const group of body.groups) {
        assert.ok(!labels.has(group.label)); labels.add(group.label);
        assert.equal(group.contract_sample.length, sampleLimit);
        assert.equal(group.contract_ids, undefined);
        assert.equal(group.contract_procurement_ids, undefined);
        const page = await executeContractsBrowse(workerContractsBrowse(fixture.env), mcpContractsBrowseInput(group.browse.arguments));
        assert.equal(page.total_matches, group.contract_count);
      }
      cursor = body.filters.pagination.next_cursor;
    } while (cursor);
    assert.equal(labels.size, 69);
  } finally { fixture.close(); }
});

test("registered browse enumerates the exact group including unknowns and every filter", async () => {
  const env = { ANALYTICAL_PROJECTION: projection };
  for (const groupBy of ["agency", "vendor", "registration_fiscal_year", "amount_band"]) {
    const input = { groupBy, fiscalYear: 2026, vendor: "Vendor 1", retroactive: true, cityRecordMatch: "exact", minAmount: 1068, maxAmount: 1068 };
    const result = await executeContractsAnalysis(workerContractsAnalysis(env), input);
    for (const group of result.groups) {
      const input = { ...mcpContractsBrowseInput(group.browse.arguments), limit: 7 };
      const ids = new Set();
      do {
        const page = await executeContractsBrowse(workerContractsBrowse(env), input);
        assert.equal(page.total_matches, group.contract_count);
        for (const item of page.results) { assert.ok(!ids.has(item.id)); ids.add(item.id); }
        input.cursor = page.pagination.next_cursor;
      } while (input.cursor);
      assert.equal(ids.size, group.contract_count);
      assert.ok([...ids].every((id) => id.startsWith("CT-68-")));
    }
  }
});

test("legacy full identifiers are HTTP-only; invalid sample sizes are rejected", async () => {
  const env = { ANALYTICAL_PROJECTION: projection };
  const full = await handleContractsAnalysis(new Request("https://api.cityscroll.org/contracts/analysis?identifiers=full"), env);
  const body = await full.json();
  assert.equal(body.groups[0].contract_ids.length, body.groups[0].contract_count);
  const invalid = await handleContractsAnalysis(new Request("https://api.cityscroll.org/contracts/analysis?sample_limit=51"), env);
  assert.equal(invalid.status, 400);
  assert.equal(catalog.tools.find((tool) => tool.name === "analyze_contracts").input_schema.properties.identifiers, undefined);
});

test("other identifier arrays have counts, bounded samples and lossless replay continuations", () => {
  const ids = Array.from({ length: 1821 }, (_, index) => `identifier-${index}`);
  const original = { content: [{ type: "text", text: "Contract evidence" }], structuredContent: { provenance: { prime_contract_ids: ids, source_observation_refs: ids.slice(0, 15) } } };
  const found = [];
  let args = {};
  do {
    const result = boundResearchToolResult(original, { tool: "get_contract", arguments: args });
    assert.ok(researchResponseBytes(result) < RESEARCH_RESPONSE_MAX_BYTES);
    const pages = JSON.parse(result.content.at(-1).text.split("(JSON Pointer paths): ")[1]);
    const page = pages.find((page) => page.path === "/provenance/prime_contract_ids");
    assert.equal(page.count, ids.length);
    found.push(...result.structuredContent.provenance.prime_contract_ids);
    args = page.next?.arguments;
  } while (args);
  assert.deepEqual(found, ids);
  assert.equal(original.structuredContent.provenance.prime_contract_ids.length, 1821);
});

test("byte accounting includes multibyte text and explicit overflow never presents partial civic facts", () => {
  const result = boundResearchToolResult({ content: [{ type: "text", text: "é".repeat(RESEARCH_RESPONSE_MAX_BYTES) }], structuredContent: { facts: [1, 2] } }, { tool: "get_notice" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.ok(researchResponseBytes(result) < RESEARCH_RESPONSE_MAX_BYTES);
});


test("MCP replays a paginated organization identifier array and never forwards full analysis identifiers", async () => {
  const fixture = createRemoteMcpFixtureEnv();
  try {
    fixture.env.PEOPLE_ORGANIZATIONS_READ_MODEL = structuredClone(fixture.env.PEOPLE_ORGANIZATIONS_READ_MODEL);
    const row = fixture.env.PEOPLE_ORGANIZATIONS_READ_MODEL.rows.find((row) => row.kind === "vendor");
    assert.ok(row);
    row.agency_ids = Array.from({ length: 73 }, (_, index) => `agency:id:fixture-${index}`);
    let args = { entity_id: row.id, identifier_limit: 50 };
    const found = [];
    do {
      const result = await call(fixture.env, "get_person_or_organization", args);
      assert.equal(result.isError, undefined);
      found.push(...result.structuredContent.person_or_organization.agency_ids);
      const pages = JSON.parse(result.content.at(-1).text.split("(JSON Pointer paths): ")[1]);
      args = pages.find((page) => page.path === "/person_or_organization/agency_ids").next?.arguments;
    } while (args);
    assert.deepEqual(found, row.agency_ids);
    const bounded = await call(fixture.env, "analyze_contracts", { identifiers: "full" });
    assert.equal(bounded.structuredContent.groups[0].contract_ids, undefined);
  } finally { fixture.close(); }
});


test("a cursor beyond the final group cannot claim an empty contract population", () => {
  assert.throws(() => analyzeContractsProjection(projection, { groupBy: "agency", cursor: "groups:69" }), /invalid group cursor/);
});
