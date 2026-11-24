import assert from "node:assert/strict";
import { test } from "node:test";
import { startPreviewRequest, startPreviewResponse, usesStartPreview } from "../src/start_preview.mjs";

test("preview expects only the opt-in cookie and refreshes document validators", () => {
  const request = new Request("https://cityscroll.org/browse/?q=Astoria", {
    headers: { Cookie: "unrelated=abc; cityscroll_start_preview=1", "If-None-Match": "older" },
  });
  assert.equal(usesStartPreview(request), true);
  assert.equal(usesStartPreview(new Request(request.url, { headers: { Cookie: "cityscroll_start_preview=10" } })), false);
  const preview = startPreviewRequest(request);
  assert.equal(preview.url, request.url);
  assert.equal(preview.headers.get("if-none-match"), null);
  assert.equal(request.headers.get("if-none-match"), "older");
});

test("only successful HTML gets the shared preview assets and a private cache policy", async () => {
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
