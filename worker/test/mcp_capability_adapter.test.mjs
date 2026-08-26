import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  handleMcp,
  MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS,
} from "../src/mcp.mjs";
import {
  CAPABILITY_TOOL_CASES,
  createRemoteMcpFixtureEnv,
  directCapabilityResults,
  semanticHash,
} from "./remote_mcp_fixture.mjs";

function post(body) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": "203.0.113.60",
    },
    body: JSON.stringify(body),
  });
}

test("the MCP policy boundary contains the registered public reads", () => {
  assert.deepEqual(
    MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map(({ name, capabilityReference }) => ({
      name,
      capabilityReference,
    })),
    CAPABILITY_TOOL_CASES.map(({ name, capabilityReference }) => ({ name, capabilityReference })),
  );
  assert.ok(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.every(({ operationClass }) => operationClass === "read"));
  assert.ok(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.every(({ annotations }) => (
    annotations.readOnlyHint === true
    && annotations.destructiveHint === false
    && annotations.idempotentHint === true
    && annotations.openWorldHint === false
  )));
});

test("MCP structured results preserve direct-provider semantics and declared bounds", async () => {
  const directFixture = createRemoteMcpFixtureEnv();
  const adapterFixture = createRemoteMcpFixtureEnv();
  try {
    const direct = await directCapabilityResults(directFixture.env);
    let id = 10;
    for (const toolCase of CAPABILITY_TOOL_CASES) {
      const response = await handleMcp(post({
        jsonrpc: "2.0",
        id: id += 1,
        method: "tools/call",
        params: { name: toolCase.name, arguments: toolCase.arguments },
      }), adapterFixture.env);
      const body = await response.json();
      assert.equal(body.error, undefined, toolCase.name);
      assert.equal(body.result.isError, undefined, toolCase.name);
      assert.equal(
        semanticHash(body.result.structuredContent),
        semanticHash(direct.get(toolCase.name)),
        `${toolCase.name} must preserve the direct-provider semantic hash`,
      );
    }
    assert.deepEqual(adapterFixture.reads.map(({ capability_reference: reference }) => reference), [
      "notice.search@1",
      "notice.get@1",
      "notice.search@1",
      "notice.get@1",
      "entity.dossier.get@1",
      "entity.relationships.get@1",
    ]);
  } finally {
    directFixture.close();
    adapterFixture.close();
  }
});

test("semantic capabilities stay independent from MCP and Cloudflare runtime packages", () => {
  for (const path of [
    "../../capabilities/notice_search.mjs",
    "../../capabilities/entity_dossier.mjs",
    "../../capabilities/entity_relationships.mjs",
    "../../capabilities/cited_passages.mjs",
    "../../capabilities/federated_search.mjs",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:modelcontextprotocol|cloudflare\/agents|agents\/mcp)/i, path);
  }
});
