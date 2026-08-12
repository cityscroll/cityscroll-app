// cityscroll.org / www.cityscroll.org parallel-serving domain: handleMirror normally
// reverse-proxies crol-list.org (the GitHub Pages origin) byte-for-byte, with a stamped
// Cloudflare Pages failover when that origin redirects back to the mirror. It must never
// leak the incoming Host header upstream (GitHub Pages virtual-hosts by Host and 404s
// otherwise).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleMirror } from "../src/mirror.mjs";
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
      if (calls.length === 1) {
        return new Response(null, { status: originStatus, headers: { location: originLocation } });
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
      const req = new Request(`https://cityscroll.org${requestPath}`);
      const res = await handleMirror(req);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, `https://crol-list.org${requestPath}`);
      assert.equal(calls[0].opts.redirect, "manual");
      assert.equal(calls[1].url, expectedFallbackUrl);
      assert.equal(calls[1].opts.redirect, "manual");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(res.headers.get("location"), null);
      assert.equal(await res.text(), "<html>from fallback</html>");
      assert.equal(res.headers.get("content-security-policy"), null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("handleMirror: follows same-origin Pages pretty-URL redirects on the stamped fallback", async () => {
  // Cloudflare Pages returns 308 /about.html → /about; the mirror must not hand that
  // Location to the browser (it would re-enter the Worker without a body).
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return Response.redirect("https://cityscroll.org/about.html", 301);
    }
    if (url === "https://cityscroll.pages.dev/about.html") {
      return new Response(null, { status: 308, headers: { location: "/about" } });
    }
    if (url === "https://cityscroll.pages.dev/about") {
      return new Response('<html><script src="i18n.js?v=c4609cdfa552"></script>about</html>', {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  try {
    const res = await handleMirror(new Request("https://cityscroll.org/about.html"));
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, "https://cityscroll.pages.dev/about.html");
    assert.equal(calls[2].url, "https://cityscroll.pages.dev/about");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("location"), null);
    const body = await res.text();
    assert.match(body, /i18n\.js\?v=c4609cdfa552/);
    assert.doesNotMatch(body, /__I18N_ASSET_VERSION__/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: falls back to stamped Pages artifact when the Pages origin redirects back to CityScroll", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return Response.redirect("https://cityscroll.org/about.html?x=1", 301);
    }
    // Stamped build artifact (not source) — must not carry unsubstituted tokens.
    return new Response('<html><script src="i18n.js?v=c4609cdfa552"></script></html>', {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  };
  try {
    const res = await handleMirror(new Request("https://cityscroll.org/about.html?x=1"));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://crol-list.org/about.html?x=1");
    assert.equal(calls[0].opts.redirect, "manual");
    assert.equal(
      calls[1].url,
      "https://cityscroll.pages.dev/about.html?x=1",
    );
    assert.equal(calls[1].opts.redirect, "manual");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const body = await res.text();
    assert.match(body, /i18n\.js\?v=c4609cdfa552/);
    assert.doesNotMatch(body, /__I18N_ASSET_VERSION__/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("field case: site-root restructure must not serve unsubstituted __I18N_ASSET_VERSION__ via mirror fallback", () => {
  // Symptom (2026-07-30): live homepage shipped src="i18n.js?v=__I18N_ASSET_VERSION__"
  // because the mirror failover used raw GitHub source after the site/ move.
  const source = readFileSync(new URL("../src/mirror.mjs", import.meta.url), "utf8");
  assert.match(source, /SITE_FALLBACK_ORIGIN = "https:\/\/cityscroll\.pages\.dev\/"/);
  assert.doesNotMatch(
    source,
    /SITE_FALLBACK_ORIGIN = "https:\/\/raw\.githubusercontent\.com\/cityscroll\/crol-list\/main\/site\/"/,
  );
});

test("handleMirror: keeps public repository documentation on the root-source seam", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return Response.redirect("https://cityscroll.org/docs/architecture.md", 301);
    }
    return new Response("# Architecture", { status: 200 });
  };
  try {
    const res = await handleMirror(new Request("https://cityscroll.org/docs/architecture.md"));
    assert.equal(
      calls[1],
      "https://raw.githubusercontent.com/cityscroll/cityscroll-app/main/docs/architecture.md",
    );
    assert.equal(await res.text(), "# Architecture");
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
