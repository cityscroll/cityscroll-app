import assert from "node:assert/strict";
import test from "node:test";

import {
  FEDERATED_SEARCH_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  executeFederatedSearch,
} from "../../capabilities/federated_search.mjs";
import { federateUniversalSearch } from "../../site/universal_search_federator.mjs";
import { handleMcp } from "../src/mcp.mjs";

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
      return federateUniversalSearch({
        query: input.query,
        lenses,
        limit: input.limit,
        scope: input.scope,
      });
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

test("MCP adapter delegates to the same capability provider result", async () => {
  const explicit = provider();
  const direct = await executeFederatedSearch(explicit, { query: "parks", limit: 10 });
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
  const body = await mcp.json();
  assert.deepEqual(body.result.structuredContent, direct);
});

test("MCP adapter preserves scoped federation through the same capability envelope", async () => {
  const explicit = provider();
  const direct = await executeFederatedSearch(explicit, {
    query: "parks",
    limit: 10,
    scope: { lenses: ["agencies"] },
  });
  const mcp = await handleMcp(
    mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_federated", arguments: { query: "parks", limit: 10, scope: { lenses: ["agencies"] } } },
    }),
    { SUBS: { async get() { return null; }, async put() {} } },
    { federatedProvider: explicit },
  );
  const body = await mcp.json();
  assert.deepEqual(body.result.structuredContent, direct);
  assert.equal(direct.requested_scope.omitted, false);
  assert.equal(direct.coverage.by_lens.notices.state, "out_of_scope");
});

test("MCP adapter rejects arbitrary query fields instead of silently widening the contract", async () => {
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
