import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../worker/src/mcp.mjs";

test("MCP initialize identifies the public product without changing tools", async () => {
  const request = new Request("https://api.cityscroll.org/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), headers: { "content-type": "application/json" } });
  const response = await handleMcp(request, { SUBS: new Map() });
  const body = await response.json();
  assert.equal(body.result.serverInfo.name, "CityScroll");
  assert.match(body.result.instructions, /CityScroll publishes/);
});

test("browser GET provides recovery while tools-only POST semantics remain explicit", async () => {
  const response = await handleMcp(new Request("https://api.cityscroll.org/mcp"), { SUBS: new Map() });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.match(await response.text(), /tools-only/);
  assert.match(await handleMcp(new Request("https://api.cityscroll.org/mcp", { method: "OPTIONS" }), { SUBS: new Map() }).then(r => r.text()), /tools-only/);
});
