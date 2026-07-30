// cityscroll.org / www.cityscroll.org parallel-serving domain: handleMirror normally
// reverse-proxies crol-list.org (the GitHub Pages origin) byte-for-byte, with a public
// source failover when that origin redirects back to the mirror. It must never leak the
// incoming Host header upstream (GitHub Pages virtual-hosts by Host and 404s otherwise).
// Health-gated fail-static promotion and flip coverage lives in fail_static.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMirror } from "../src/mirror.mjs";
import { SERVE_HEADER, SERVE_MODE_ORIGIN, SERVE_MODE_FAIL_STATIC } from "../src/lib/fail_static.mjs";
import loopRedirectFixtures from "./fixtures/mirror_redirect_regressions.json" with { type: "json" };

test("handleMirror: proxies GET to crol-list.org with the same path and query, dropping Host", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl, capturedHeaders, capturedRedirect;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    capturedRedirect = opts.redirect;
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
    assert.equal(capturedRedirect, "manual", "the origin request must never auto-follow a redirect back to this Worker");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_ORIGIN);
    assert.equal(await res.text(), "<html>hi</html>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const { requestPath, originStatus = 301, originLocation, expectedFallbackUrl } of loopRedirectFixtures.cases) {
  test(`handleMirror: never leaks canonical-origin ${originStatus} redirect for ${requestPath}`, async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      if (String(url).startsWith("https://crol-list.org")) {
        return new Response(null, { status: originStatus, headers: { location: originLocation } });
      }
      // Public source seam after health-gated flip.
      return new Response("<html>from fallback</html>", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    };
    try {
      const req = new Request(`https://cityscroll.org${requestPath}`);
      const res = await handleMirror(req);
      assert.ok(calls.length >= 2, "origin probe plus public-source failover");
      assert.equal(calls[0].url, `https://crol-list.org${requestPath}`);
      assert.equal(calls[0].opts.redirect, "manual");
      const fallbackCall = calls.find((c) => String(c.url).startsWith("https://raw.githubusercontent.com/"));
      assert.ok(fallbackCall, "must hit the public source seam");
      assert.equal(fallbackCall.url, expectedFallbackUrl);
      assert.equal(fallbackCall.opts.redirect, "manual");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_FAIL_STATIC);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(res.headers.get("location"), null);
      assert.equal(await res.text(), "<html>from fallback</html>");
      assert.equal(res.headers.get("content-security-policy"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("handleMirror: falls back to public GitHub source when the Pages origin redirects back to CityScroll", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).startsWith("https://crol-list.org")) {
      return Response.redirect("https://cityscroll.org/about.html?x=1", 301);
    }
    return new Response("<html>from fallback</html>", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  };
  try {
    const res = await handleMirror(new Request("https://cityscroll.org/about.html?x=1"));
    assert.ok(calls.some((c) => c.url === "https://crol-list.org/about.html?x=1"));
    assert.ok(calls[0].opts.redirect === "manual");
    assert.ok(
      calls.some((c) => c.url === "https://raw.githubusercontent.com/cityscroll/crol-list/main/about.html?x=1"),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_FAIL_STATIC);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("content-security-policy"), null);
    assert.equal(await res.text(), "<html>from fallback</html>");
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
    assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_ORIGIN);
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
