import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CAPABILITY_DISCOVERY_MATRIX, renderAskWithAiLink } from "../site/ai_discovery.mjs";

const root = new URL("../site/", import.meta.url);

test("the public discovery projection covers the declared utility families", () => {
  const names = CAPABILITY_DISCOVERY_MATRIX.map(([name]) => name);
  for (const name of ["MCP", "Follow", "Calendar", "Feeds", "Saved searches", "Collection/export", "Evidence", "As-of", "Comparative analysis"]) assert.ok(names.includes(name), name);
});

test("shared and standalone public surfaces link to the static introduction", async () => {
  const pages = ["index.html", "about.html", "api.html", "stats.html", "guide/index.html", "use-with-ai/index.html"];
  for (const page of pages) {
    const html = await readFile(new URL(page, root), "utf8");
    assert.match(html, /use-with-ai\//, page);
  }
  const escaped = renderAskWithAiLink({ href: "/use-with-ai/?q=a&amp;b=1", translate: () => "<Ask>" });
  assert.match(escaped, /&lt;Ask&gt;/);
  assert.match(escaped, /use-with-ai\/\?q=a&amp;amp;b=1/);
});

test("introduction keeps primary recovery and copy fallback visible", async () => {
  const html = await readFile(new URL("use-with-ai/index.html", root), "utf8");
  for (const token of ["mcp-endpoint", "data-copy-endpoint", "Claude Code", "contract lookup", "decision-path tools", "CT107120258801626", "2024Q0356", "/api.html#mcp", "no account"]) assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
});
