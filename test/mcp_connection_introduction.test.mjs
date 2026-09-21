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

test("A5: the public interface keeps the stable MCP heading and recovery semantics", async () => {
  const api = await readFile(new URL("../site/api.html", import.meta.url), "utf8");
  assert.match(api, /<[^>]+id="mcp"[^>]*>/);
  assert.match(api, /MCP/);
  assert.match(api, /href="\/use-with-ai\/"/);
  const intro = await readFile(introduction, "utf8");
  assert.match(intro, /tools-only/);
  assert.match(intro, /POST/);
  assert.match(intro, /browser[^.]*cannot run tools/i);
  assert.doesNotMatch(intro, /href="https:\/\/api\.cityscroll\.org\/mcp"[^>]*(?:target|window\.open)/i);
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

test("A3: three setup tasks bind to declared tools, exact public records, and generic-client instructions", async () => {
  const html = await readFile(introduction, "utf8");
  const fixture = JSON.parse(await readFile(new URL("../site/data/assistant_setup_sources.json", import.meta.url), "utf8"));
  const taskSection = html.match(/<section aria-labelledby="try">[\s\S]*?<\/section>/)?.[0] || "";
  const examples = taskSection.match(/<ol>[\s\S]*?<\/ol>/)?.[0] || "";
  const bindingDisclosure = taskSection.match(/<details>[\s\S]*?<\/details>/)?.[0] || "";
  assert.equal((examples.match(/<li>/g) || []).length, 3);
  assert.doesNotMatch(examples, /<code>/, "visible tasks stay client-neutral");
  for (const tool of ["search_notices", "get_notice", "get_contract", "get_land_project", "get_land_decision_path"]) {
    assert.match(bindingDisclosure, new RegExp(`<code>${tool}</code>`), tool);
  }
  for (const recordId of ["20260824035", "CT107120258801626", "2024Q0356"]) {
    assert.match(taskSection, new RegExp(recordId), recordId);
  }
  assert.match(html, /Generic Streamable HTTP/);
  assert.match(html, /leave authentication blank/);

  const officialHosts = new Set(["support.claude.com", "code.claude.com", "modelcontextprotocol.io"]);
  assert.equal(fixture.sources.length, 3);
  for (const source of fixture.sources) {
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.ok(officialHosts.has(url.hostname), source.id);
    assert.ok(source.claims.length > 0, source.id);
    assert.match(html, new RegExp(source.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), source.id);
  }
});
