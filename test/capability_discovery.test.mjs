import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CAPABILITY_DISCOVERY_MATRIX, renderAskWithAiLink } from "../site/ai_discovery.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const root = new URL("../site/", import.meta.url);
const CAPTURE_MANIFEST = new URL("../docs/evidence/assistant-setup/capture-manifest.json", import.meta.url);
const ROUTE_SOURCES = Object.freeze({
  "/": "index.html",
  "/use-with-ai/": "use-with-ai/index.html",
  "/api.html#mcp": "api.html",
});

function digest(html) {
  return createHash("sha256").update(html).digest("hex");
}

function assertionHolds(route, html) {
  if (route === "/") {
    assert.match(html, /home-topic-form/);
    assert.match(html, /use-with-ai\//);
    assert.match(html, /Ask with AI/);
    assert.ok(html.indexOf("home-topic-form") < html.indexOf("Ask with AI"), "Ask with AI stays after primary search");
    return;
  }
  if (route === "/use-with-ai/") {
    for (const token of [
      "mcp-endpoint",
      "data-copy-endpoint",
      "id=\"connect\"",
      "id=\"claude\"",
      "id=\"other\"",
      "id=\"try\"",
      "id=\"next\"",
      "CT107120258801626",
      "2024Q0356",
      "/api.html#mcp",
      "no account",
    ]) {
      assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
    }
    return;
  }
  if (route === "/api.html#mcp") {
    assert.match(html, /id="mcp"/);
    assert.match(html, /use-with-ai\//);
    return;
  }
  assert.fail(`unexpected capture route: ${route}`);
}

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

test("A6: retained capture manifest anchors each route render by sha256 at both viewports", async () => {
  const manifest = JSON.parse(await readFile(CAPTURE_MANIFEST, "utf8"));
  await withPinnedClock(manifest.capture_clock, async () => {
    assert.equal(manifest.schema, "cityscroll.assistant_setup_capture_manifest.v1");
    assert.equal(manifest.image_binaries_committed, false);
    assert.equal(manifest.captures.length, 6);
    const viewports = new Set(manifest.captures.map((capture) => capture.viewport));
    assert.deepEqual([...viewports].sort(), ["1440x1000", "390x844"]);
    const routes = new Set(manifest.captures.map((capture) => capture.route));
    assert.deepEqual([...routes].sort(), ["/", "/api.html#mcp", "/use-with-ai/"]);

    for (const capture of manifest.captures) {
      assert.match(capture.sha256, /^[a-f0-9]{64}$/, capture.route);
      assert.notEqual(capture.sha256, "local-headless-capture", capture.route);
      assert.equal(capture.revision, manifest.revision, capture.route);
      assert.equal(capture.data_vintage, manifest.data_vintage, capture.route);
      assert.ok(capture.assertion.length > 20, capture.route);

      const source = ROUTE_SOURCES[capture.route];
      assert.ok(source, capture.route);
      const html = await readFile(new URL(source, root), "utf8");
      assert.equal(capture.sha256, digest(html), `${capture.route} ${capture.viewport}`);
      assertionHolds(capture.route, html);
    }

    const translated = renderAskWithAiLink({ translate: (value) => (value === "Ask with AI" ? "Preguntar con IA" : value) });
    assert.match(translated, /Preguntar con IA/);
    assert.doesNotMatch(translated, /Ask with AI/);
  });
});
