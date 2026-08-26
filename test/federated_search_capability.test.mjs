import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FEDERATED_SEARCH_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_COVERAGE_STATES,
  FEDERATED_SEARCH_LIMITS,
  executeFederatedSearch,
  validateFederatedSearchInput,
} from "../capabilities/federated_search.mjs";
import { federateUniversalSearch } from "../site/universal_search_federator.mjs";
import { handleSearch } from "../worker/src/search.mjs";
import { handleMcp } from "../worker/src/mcp.mjs";

function document() {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: "agency:id:parks-and-recreation",
    object_type: "agency",
    domain: "people",
    canonical_href: "/agencies/parks-and-recreation/",
    title: "Department of Parks and Recreation",
    summary: "Public agency profile.",
    search_text: "Department of Parks and Recreation parks",
    source_family: "agency_constellation",
    source_observation_refs: ["agency:parks-and-recreation"],
    process_role: null,
    classification: { method: "fixture", basis: "fixture" },
    provenance: { producer: "fixture.agency-search.v1" },
  };
}

function provider() {
  const lenses = Object.fromEntries(FEDERATED_SEARCH_CAPABILITY.input.lenses.map((lens) => [lens, {
    async search() {
      const matched = lens === "agencies";
      return {
        candidates: matched ? [{
          document: document(),
          local_score: 1,
          match_fields: [{
            field: "title",
            matched_term: "parks",
            source_observation_ref: "agency:parks-and-recreation",
          }],
        }] : [],
        coverage: {
          state: matched ? "matched" : "empty",
          indexed_count: matched ? 1 : 0,
          as_of: "2026-08-26T00:00:00Z",
          source: `fixture.${lens}`,
          method: "fixture_v1",
        },
      };
    },
  }]));
  return {
    capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    providerId: FEDERATED_SEARCH_CAPABILITY.provider.id,
    execute(input) {
      return federateUniversalSearch({ query: input.query, lenses, limit: input.limit });
    },
  };
}

function mcpPost(body) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.70" },
    body: JSON.stringify(body),
  });
}

test("search.federated@1 declares the closed lenses, coverage states, and bounds", () => {
  assert.deepEqual(FEDERATED_SEARCH_CAPABILITY.input.lenses, [
    "notices", "people", "agencies", "vendors", "committees",
    "community_boards", "exams", "parcels", "land", "meetings",
  ]);
  assert.deepEqual(FEDERATED_SEARCH_CAPABILITY.output.coverageStates, FEDERATED_SEARCH_COVERAGE_STATES);
  assert.deepEqual(FEDERATED_SEARCH_CAPABILITY.bounds.input, FEDERATED_SEARCH_LIMITS);
  assert.equal(FEDERATED_SEARCH_CAPABILITY.bounds.output.maximumResults, 100);
  assert.equal(FEDERATED_SEARCH_CAPABILITY.bounds.output.maximumCardsPerLane, 8);
  assert.ok(Object.isFrozen(FEDERATED_SEARCH_CAPABILITY));
});

test("HTTP and MCP adapters delegate to the same capability provider result", async () => {
  const explicit = provider();
  const direct = await executeFederatedSearch(explicit, { query: "parks", limit: 10 });
  const http = await handleSearch(
    new Request("https://api.cityscroll.org/search?q=parks"),
    {},
    { federatedProvider: explicit },
  );
  const httpBody = await http.json();
  assert.deepEqual(httpBody.federated, direct);
  assert.equal(httpBody.capability_reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);

  const mcp = await handleMcp(
    mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_federated", arguments: { query: "parks", limit: 10 } },
    }),
    { SUBS: { async get() { return null; }, async put() {} } },
    { federatedProvider: explicit },
  );
  const mcpBody = await mcp.json();
  assert.deepEqual(mcpBody.result.structuredContent, direct);
});

test("the adapter seams do not reconstruct federation semantics", () => {
  const httpSource = readFileSync(new URL("../worker/src/search.mjs", import.meta.url), "utf8");
  const mcpSource = readFileSync(new URL("../worker/src/mcp.mjs", import.meta.url), "utf8");
  const httpAdapter = httpSource.slice(httpSource.indexOf("export async function handleSearch"));
  const mcpAdapter = mcpSource.slice(mcpSource.indexOf("async function callTool"));
  assert.match(httpAdapter, /executeFederatedSearch\(/);
  assert.doesNotMatch(httpAdapter, /federateUniversalSearch\(/);
  assert.match(mcpAdapter, /executeFederatedSearch\(/);
  assert.doesNotMatch(mcpAdapter, /federateUniversalSearch\(/);
});

test("the capability rejects arbitrary query fields and over-bound requests", () => {
  assert.throws(() => validateFederatedSearchInput({ query: "parks", where: "raw SQL" }), /arbitrary field/);
  assert.throws(() => validateFederatedSearchInput({ query: "x".repeat(241) }), /240 characters/);
  assert.throws(() => validateFederatedSearchInput({ query: "parks", limit: 101 }), /1 through 100/);
});

test("the MCP adapter rejects arbitrary query fields instead of silently widening the contract", async () => {
  const response = await handleMcp(
    mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_federated", arguments: { query: "parks", where: "raw SQL" } },
    }),
    { SUBS: { async get() { return null; }, async put() {} } },
  );
  const body = await response.json();
  assert.equal(body.error.code, -32603);
  assert.match(body.error.message, /arbitrary field/);
});
