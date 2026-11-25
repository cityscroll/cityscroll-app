import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.mjs";
import { startPreviewRequest, startPreviewResponse, usesStartPreview } from "../../site/start/response.mjs";
import pagesEdge from "../../site/_worker.js";

const ctx = { waitUntil() {}, passThroughOnException() {} };

class HeadRewriter {
  on(selector, handler) {
    assert.equal(selector, "head");
    handler.element({ append: html => { this.assets = html; } });
    return this;
  }
  transform(response) {
    const assets = this.assets;
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode((await response.text()).replace("</head>", assets + "</head>")));
        controller.close();
      },
    });
    return new Response(stream, response);
  }
}

test("preview expects the enabled cookie and refreshes document validators", () => {
  const request = new Request("https://cityscroll.org/browse/?q=Astoria", {
    headers: { Cookie: "unrelated=abc; cityscroll_start_preview=1", "If-None-Match": "older" },
  });
  assert.equal(usesStartPreview(request), true);
  assert.equal(usesStartPreview(new Request(request.url, { headers: { Cookie: "cityscroll_start_preview=0" } })), false);
  assert.equal(usesStartPreview(new Request(request.url, { headers: { Cookie: "cityscroll_start_preview=10" } })), false);
  const preview = startPreviewRequest(request);
  assert.equal(preview.url, request.url);
  assert.equal(preview.headers.get("if-none-match"), null);
  assert.equal(request.headers.get("if-none-match"), "older");
});

test("only successful HTML gets the shared preview assets and a private cache policy", async () => {
  const source = new Response("<html><head></head><body>Records</body></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public", ETag: "public-page" },
  });
  const preview = startPreviewResponse(source, HeadRewriter);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal(preview.headers.get("etag"), null);
  const html = await preview.text();
  assert.match(html, /<script type="module" src="\/start\/preview\.mjs"><\/script>/);
  assert.match(html, /<body>Records<\/body>/);
  const json = Response.json({ items: [] });
  const missing = new Response("missing", { status: 404, headers: { "Content-Type": "text/html" } });
  assert.equal(startPreviewResponse(json, HeadRewriter), json);
  assert.equal(startPreviewResponse(missing, HeadRewriter), missing);
});

test("Worker preview handling is bounded to dynamic documents and the root redirect", async () => {
  const cookie = { Cookie: "cityscroll_start_preview=1", Accept: "text/html" };
  const redirect = await worker.fetch(new Request("https://cityscroll.org/", { headers: cookie }), {}, ctx);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/start/");

  const priorRewriter = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = HeadRewriter;
  try {
    const following = await worker.fetch(new Request("https://cityscroll.org/following", { headers: cookie }), {}, ctx);
    assert.equal(following.status, 200);
    assert.equal(following.headers.get("cache-control"), "private, no-store");
    assert.match(await following.text(), /src="\/start\/preview\.mjs"/);
  } finally {
    globalThis.HTMLRewriter = priorRewriter;
  }

  const priorFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url, options };
    return new Response("<html><head></head><body>Browse remains public</body></html>", {
      headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=60", ETag: "browse-public" },
    });
  };
  try {
    const browse = await worker.fetch(new Request("https://cityscroll.org/browse/?q=parks", {
      headers: { ...cookie, "If-None-Match": "browse-public" },
    }), {}, ctx);
    const upstream = new URL(forwarded.url);
    assert.equal(upstream.pathname + upstream.search, "/browse/?q=parks");
    assert.equal(forwarded.options.headers.get("if-none-match"), "browse-public");
    assert.equal(browse.headers.get("cache-control"), "public, max-age=60");
    assert.equal(browse.headers.get("etag"), "browse-public");
    assert.doesNotMatch(await browse.text(), /start\/preview\.mjs/);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("the Pages edge preserves the canonical Browse page and adds navigation only on opt-in", async t => {
  const priorRewriter = globalThis.HTMLRewriter;
  globalThis.HTMLRewriter = HeadRewriter;
  t.after(() => { globalThis.HTMLRewriter = priorRewriter; });

  const requests = [];
  const document = "<html><head></head><body>Browse civic records</body></html>";
  const env = { ASSETS: { fetch(request) {
    requests.push(request);
    return new Response(document, {
      headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=0", ETag: "public" },
    });
  } } };
  const url = "https://cityscroll.org/browse/";
  const regular = await pagesEdge.fetch(new Request(url, { headers: { "If-None-Match": "public" } }), env);
  const preview = await pagesEdge.fetch(new Request(url, {
    headers: { Cookie: "cityscroll_start_preview=1", "If-None-Match": "public" },
  }), env);
  assert.equal(requests[0].headers.get("if-none-match"), "public");
  assert.equal(requests[1].headers.get("if-none-match"), null);
  assert.equal(await regular.text(), document);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  const html = await preview.text();
  assert.match(html, /src="\/start\/preview\.mjs"/);
  assert.match(html, /Browse civic records/);
});
