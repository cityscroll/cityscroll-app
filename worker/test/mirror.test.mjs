// cityscroll.org / www.cityscroll.org parallel-serving domain: handleMirror reverse-proxies
// to crol-list.org (the GitHub Pages origin) byte-for-byte, and must never leak the
// incoming Host header upstream (GitHub Pages virtual-hosts by Host and 404s on a domain
// it doesn't know about).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMirror } from "../src/mirror.mjs";

test("handleMirror: proxies GET to crol-list.org with the same path and query, dropping Host", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl, capturedHeaders;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return new Response("<html>hi</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  };
  try {
    const req = new Request("https://cityscroll.org/about.html?x=1", {
      headers: { "Accept": "text/html", "If-None-Match": '"abc"', "Host": "cityscroll.org" },
    });
    const res = await handleMirror(req);
    assert.equal(capturedUrl, "https://crol-list.org/about.html?x=1");
    assert.equal(capturedHeaders.get("host"), null, "must not forward the incoming Host header upstream");
    assert.equal(capturedHeaders.get("if-none-match"), '"abc"');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<html>hi</html>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: www.cityscroll.org also proxies to crol-list.org", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return new Response("ok", { status: 200 });
  };
  try {
    await handleMirror(new Request("https://www.cityscroll.org/"));
    assert.equal(capturedUrl, "https://crol-list.org/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: relays a non-200 origin status (e.g. 404) as-is", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const res = await handleMirror(new Request("https://cityscroll.org/nope"));
    assert.equal(res.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: rejects non-GET/HEAD methods without contacting the origin", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("ok"); };
  try {
    const res = await handleMirror(new Request("https://cityscroll.org/", { method: "POST" }));
    assert.equal(res.status, 405);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
