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

test("MCP setup puts connection prerequisites before exact task copying", async () => {
  const html = await readFile(introduction, "utf8");
  const fixture = JSON.parse(await readFile(new URL("../site/data/assistant_setup_sources.json", import.meta.url), "utf8"));
  const claudeWeb = fixture.sources.find((source) => source.id === "claude-web-remote-mcp");
  assert.ok(claudeWeb);
  assert.equal(claudeWeb.url, "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp");
  assert.equal(claudeWeb.observed_at, "2026-09-20");
  for (const token of [
    "Connect before copying a task",
    "Claude web",
    "Claude Code",
    "Generic Streamable HTTP",
    "https://api.cityscroll.org/mcp",
    "leave authentication blank",
    "enable CityScroll before copying or sending an exact task",
    "Customize → Connectors",
    "Connectors",
  ]) assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
  const prerequisite = html.indexOf("id=\"connect-first\"");
  const taskMount = html.indexOf("data-ai-context-mount");
  assert.ok(prerequisite >= 0 && taskMount > prerequisite);
  assert.match(html, new RegExp(claudeWeb.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
