import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { handleMcp } from "../src/mcp.mjs";
import { buildRemoteMcpEvidenceReceipt } from "../scripts/build_remote_mcp_evidence.mjs";
import {
  CAPABILITY_TOOL_CASES,
  createRemoteMcpFixtureEnv,
  directCapabilityResults,
  semanticHash,
} from "./remote_mcp_fixture.mjs";

test("current Streamable HTTP client initializes, discovers, and calls all public capabilities", async () => {
  const directFixture = createRemoteMcpFixtureEnv();
  const remoteFixture = createRemoteMcpFixtureEnv();
  const requests = [];
  const calls = [];
  const client = new Client({ name: "cityscroll-cs06-proof", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://api.cityscroll.org/mcp"),
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("CF-Connecting-IP", "203.0.113.61");
        requests.push(request.method);
        return handleMcp(request, remoteFixture.env);
      },
    },
  );

  try {
    const direct = await directCapabilityResults(directFixture.env);
    await client.connect(transport);
    assert.equal(transport.protocolVersion, "2025-06-18");
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(listed.tools.length, 17);
    assert.ok(byName.has("get_land_decision_path"), "the Land decision path must be discoverable");
    for (const toolCase of CAPABILITY_TOOL_CASES) {
      const tool = byName.get(toolCase.name);
      assert.ok(tool, `${toolCase.name} must be discoverable`);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      const result = await client.callTool({
        name: toolCase.name,
        arguments: toolCase.arguments,
      });
      calls.push(toolCase.name);
      assert.equal(
        semanticHash(result.structuredContent),
        semanticHash(direct.get(toolCase.name)),
        `${toolCase.name} current-client result must match its direct provider`,
      );
    }
    assert.deepEqual(calls, CAPABILITY_TOOL_CASES.map(({ name }) => name));
    assert.deepEqual(remoteFixture.reads.map(({ capability_reference: reference }) => reference), [
      "notice.search@1",
      "notice.get@1",
      "notice.search@1",
      "notice.get@1",
      "entity.dossier.get@1",
      "entity.relationships.get@1",
    ]);
    assert.equal(requests.filter((method) => method === "POST").length, 18);
  } finally {
    await client.close();
    directFixture.close();
    remoteFixture.close();
  }
});

test("the committed interoperability receipt is reproducible with the pinned client", async () => {
  const committed = JSON.parse(readFileSync(
    new URL("../../artifacts/capability-spine/remote-mcp.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(await buildRemoteMcpEvidenceReceipt(), committed);
});
