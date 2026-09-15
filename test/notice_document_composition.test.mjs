import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import edgeWorker from "../site/pages_edge.mjs";
import { renderNoticeRouteChrome } from "../site/notice_document_composition.mjs";

const shell = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

class FixtureHTMLRewriter {
  constructor(response) { this.response = response; this.handlers = []; }
  on(selector, handlers) { this.handlers.push({ selector, handlers }); return this; }
  async transform(response = this.response) {
    let html = await response.text();
    for (const { selector, handlers } of this.handlers) {
      if (selector === "body") {
        html = html.replace(/<body([^>]*)>/i, (_match, attrs) => {
          const element = {
            setAttribute(name, value) { attrs = `${attrs} ${name}="${value}"`; },
          };
          handlers.element(element);
          return `<body${attrs}>`;
        });
      } else if (selector === "#notice-route-chrome") {
        html = html.replace(/<div id="notice-route-chrome"[^>]*><\/div>/i, (match) => {
          const element = {
            content: "",
            setInnerContent(value) { element.content = value; },
            removeAttribute() { match = match.replace(/ hidden/, ""); },
          };
          handlers.element(element);
          return match.replace(/><\/div>$/, `>${element.content}</div>`);
        });
      } else if (selector === "#noticeview") {
        html = html.replace(/<div id="noticeview"[^>]*>.*?<\/div>/is, (match) => {
          const element = { content: "", setInnerContent(value) { element.content = value; } };
          handlers.element(element);
          return match.replace(/>.*<\/div>$/is, `>${element.content}</div>`);
        });
      }
    }
    return new Response(html, { status: response.status, headers: response.headers });
  }
}

function environment() {
  return {
    ASSETS: { fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(shell, { headers: { "Content-Type": "text/html" } });
      if (path.endsWith("notice_mandate_backlinks_lookup.json")) return new Response("{}");
      if (path.endsWith("meeting_outcomes_snapshot.json")) return new Response("{}");
      return new Response("", { status: 404 });
    } },
  };
}

test("notice route composition uses the shared mast and removes homepage promotion from the reading path", async () => {
  assert.match(renderNoticeRouteChrome(), /render|document-mast|notice-document-mast/);
  const priorRewriter = globalThis.HTMLRewriter;
  const priorFetch = globalThis.fetch;
  globalThis.HTMLRewriter = FixtureHTMLRewriter;
  globalThis.fetch = async (request) => {
    const url = new URL(request.url || request);
    if (url.hostname === "api.cityscroll.org") {
      return new Response(JSON.stringify({ row: {
        request_id: "20260915001",
        short_title: "A readable public notice",
        type_of_notice_description: "Public Hearings",
        agency_name: "Example Agency",
        start_date: "2026-09-15",
      }, civic_time: null }));
    }
    throw new Error(`unexpected request ${url}`);
  };
  try {
    const response = await edgeWorker.fetch(new Request("https://cityscroll.org/notices/20260915001/"), environment());
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /class="notice-route"/);
    assert.match(html, /class="document-mast notice-document-mast"/);
    assert.match(html, /data-edge-rendered="notice"/);
    assert.match(html, /<h2 class="rolename"[^>]*>A readable public notice<\/h2>/);
    assert.match(html, /notice-route \.masthead \.wrap>:not\(#langSwitcher\)\{display:none!important\}/);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.HTMLRewriter = priorRewriter;
  }
});

test("the client route exposes one main notice heading while keeping the language binding movable", () => {
  const core = readFileSync(new URL("../site/app/core.mjs", import.meta.url), "utf8");
  assert.match(core, /applyNoticeRouteState\?\.\(name === "notice"\)/);
  assert.match(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"), /id="langSwitcher"/);
  assert.match(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"), /id="notice-route-chrome"/);
});
