import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AI_ENDPOINT, renderEndpointControl } from "../site/ai_discovery.mjs";

const introduction = new URL("../site/use-with-ai/index.html", import.meta.url);

test("MCP introduction identifies the public product and endpoint", async () => {
  const html = await readFile(introduction, "utf8");
  assert.equal(AI_ENDPOINT, "https://api.cityscroll.org/mcp");
  assert.match(html, new RegExp(AI_ENDPOINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(renderEndpointControl(), /mcp-endpoint/);
  assert.match(html, /CityScroll publishes linked New York City records/);
});

test("MCP introduction explains browser recovery without promising sign-in", async () => {
  const html = await readFile(introduction, "utf8");
  assert.match(html, /browser GET cannot run tools|browser response/);
  assert.match(html, /no key is required and no account is needed/);
  assert.match(html, /\/api\.html#mcp/);
});
