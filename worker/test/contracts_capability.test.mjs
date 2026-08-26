import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";
import {
  CONTRACT_GET_CAPABILITY,
  CONTRACT_GET_CAPABILITY_REFERENCE,
  CONTRACTS_BROWSE_CAPABILITY,
  CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
  executeContractGet,
  executeContractsBrowse,
} from "../../capabilities/contracts.mjs";
import {
  CONTRACT_GET_HTTP_ADAPTER,
  CONTRACTS_BROWSE_HTTP_ADAPTER,
  handleContract,
  handleContractsBrowse,
  workerProcurementContracts,
} from "../src/contracts.mjs";
import { handleMcp } from "../src/mcp.mjs";

function sourceRecord(sourceSystem, sourceSystemId, snapshot) {
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `${sourceSystemId}-hash`,
    normalized_snapshot: JSON.stringify(snapshot),
    raw_snapshot: JSON.stringify(snapshot),
    ingested_at: "2026-08-18T19:46:32Z",
  };
}

const records = [
  sourceRecord("passport_public_contracts", "contract:84126P0001001:CTR-ONE", {
    ctr_id: "CTR-ONE", epin: "84126P0001001", contract_id: "CT-ONE", title: "Bridge inspection",
    vendor: "HNTB Corporation", agency: "Department of Design and Construction", current_amount: 1250000,
    status: "Registered", registration_date: "2026-07-20",
  }),
  sourceRecord("checkbook_contracts", "contract:registered:CT-ONE:HNTB:prime-vendor:2026-07-20", {
    id: "CT-ONE", pin: "84126P0001001", vendor: "HNTB Corporation", agency: "Department of Design and Construction",
    status: "registered", current: 1250000, registered: "2026-07-20",
  }),
  sourceRecord("passport_public_contracts", "contract:84126P0001001:CTR-TWO", {
    ctr_id: "CTR-TWO", epin: "84126P0001001", contract_id: "CT-TWO", title: "Bridge inspection",
    vendor: "HNTB Corporation", agency: "Department of Design and Construction", current_amount: 2500000,
    status: "Pending",
  }),
];

const model = buildSharedProcurementReadModel({
  sourceRecords: records,
  lifecycleRows: [{
    pin: "84126P0001001",
    timeline: [{
      stage: "award",
      status: "observed",
      source: "passport",
      detail: { contract_id: "CT-ONE", request_id: "REQ-ONE" },
    }],
  }],
  generatedAt: "2026-08-18T20:00:00Z",
  now: "2026-08-18T20:01:00Z",
});
const env = { PROCUREMENT_READ_MODEL: model };
const firstId = "procurement:contract:CTONE";

class MockKV {
  async get() { return null; }
  async put() {}
}

function post(body) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
    body: JSON.stringify(body),
  });
}

test("capability metadata declares bounded exact object and browse operations", () => {
  assert.equal(CONTRACT_GET_CAPABILITY.reference, CONTRACT_GET_CAPABILITY_REFERENCE);
  assert.equal(CONTRACTS_BROWSE_CAPABILITY.reference, CONTRACTS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(CONTRACT_GET_CAPABILITY.bounds.output.oneContract, true);
  assert.equal(CONTRACTS_BROWSE_CAPABILITY.bounds.output.maximumResults, 100);
  assert.equal(CONTRACTS_BROWSE_CAPABILITY.input.ordering, "canonical procurement_id ascending");
  assert.equal(CONTRACT_GET_HTTP_ADAPTER.capabilityReference, CONTRACT_GET_CAPABILITY_REFERENCE);
  assert.equal(CONTRACTS_BROWSE_HTTP_ADAPTER.capabilityReference, CONTRACTS_BROWSE_CAPABILITY_REFERENCE);
});

test("direct capability results preserve exact identity, provenance, coverage, freshness, amount validity, and lifecycle", async () => {
  const result = await executeContractGet(workerProcurementContracts(env).get, { procurementId: firstId });
  assert.equal(result.availability, "available");
  assert.equal(result.contract.procurement_id, firstId);
  assert.equal(result.contract.provenance.identity.exact, true);
  assert.deepEqual(result.contract.provenance.identity.prime_contract_ids, ["CTONE"]);
  assert.ok(result.contract.provenance.source_observations.every((entry) => entry.source_observation_ref));
  assert.equal(result.contract.coverage.state, "observed");
  assert.equal(result.contract.coverage.source_envelopes.passport_public_contracts.state, "observed");
  assert.equal(result.contract.coverage.source_envelopes.city_record.state, "not_published");
  assert.equal(result.contract.freshness.as_of, model.generated_at);
  assert.equal(result.contract.amount.value, 1250000);
  assert.equal(result.contract.amount.valid, true);
  assert.deepEqual(result.contract.lifecycle, model.rows.find((row) => row.procurement_id === firstId).lifecycle);
  assert.doesNotMatch(JSON.stringify(result), /raw_snapshot|normalized_snapshot|content_hash/);
});

test("browse keeps same-vendor and shared-PIN-family contract instruments separate", async () => {
  const result = await executeContractsBrowse(workerProcurementContracts(env).browse, { vendor: "HNTB", limit: 1 });
  assert.equal(result.availability, "complete");
  assert.equal(result.total_matches, 2);
  assert.equal(result.results.length, 1);
  assert.equal(result.pagination.truncated, true);
  const next = await executeContractsBrowse(workerProcurementContracts(env).browse, {
    vendor: "HNTB", limit: 1, cursor: result.pagination.next_cursor,
  });
  assert.deepEqual([...result.results, ...next.results].map((entry) => entry.procurement_id), [
    "procurement:contract:CTONE", "procurement:contract:CTTWO",
  ]);
});

test("HTTP and MCP adapters delegate to the same capability semantics", async () => {
  const direct = await executeContractGet(workerProcurementContracts(env).get, { procurementId: firstId });
  const http = await handleContract(new Request(`https://api.cityscroll.org/contract?id=${encodeURIComponent(firstId)}`), env);
  assert.equal(http.status, 200);
  assert.deepEqual(await http.json(), direct);

  const browse = await executeContractsBrowse(workerProcurementContracts(env).browse, { vendor: "HNTB", limit: 1 });
  const browseHttp = await handleContractsBrowse(new Request("https://api.cityscroll.org/contracts?vendor=HNTB&limit=1"), env);
  assert.equal(browseHttp.status, 200);
  assert.deepEqual(await browseHttp.json(), browse);

  const mcpGet = await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "get_contract", arguments: { procurement_id: firstId },
  } }), { ...env, SUBS: new MockKV() });
  assert.deepEqual((await mcpGet.json()).result.structuredContent, direct);
  const mcpBrowse = await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "browse_contracts", arguments: { vendor: "HNTB", limit: 1 },
  } }), { ...env, SUBS: new MockKV() });
  assert.deepEqual((await mcpBrowse.json()).result.structuredContent, browse);
});

test("missing objects retain not-yet-public state across capability and HTTP", async () => {
  const input = { procurementId: "procurement:contract:missing" };
  const direct = await executeContractGet(workerProcurementContracts(env).get, input);
  assert.deepEqual(direct, {
    capability_reference: CONTRACT_GET_CAPABILITY_REFERENCE,
    availability: "not_yet_public",
    contract: null,
    error: "not-found",
  });
  const response = await handleContract(new Request("https://api.cityscroll.org/contract?id=procurement%3Acontract%3Amissing"), env);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), direct);
});

test("adapter source remains delegated and cannot silently rebuild procurement identity", () => {
  const source = readFileSync(new URL("../src/contracts.mjs", import.meta.url), "utf8");
  const mcpSource = readFileSync(new URL("../src/mcp.mjs", import.meta.url), "utf8");
  assert.match(source, /executeContractGet/);
  assert.match(source, /executeContractsBrowse/);
  assert.match(mcpSource, /executeContractGet/);
  assert.match(mcpSource, /executeContractsBrowse/);
  assert.doesNotMatch(mcpSource, /identity_keys|prime_contract_ids|source_observation_refs/);
});
