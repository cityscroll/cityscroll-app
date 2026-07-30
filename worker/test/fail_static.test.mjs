// Characterization tests for health-gated fail-static serving.
// Field case: 2026-07-30 GitHub Pages CNAME 301 loop — origin "deploy succeeded"
// green while cityscroll.org hit ERR_TOO_MANY_REDIRECTS. That class of failure
// must flip to fail-static and must not advance the last-known-good pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_MAX_ATTEMPTS,
  SERVE_HEADER,
  SERVE_MODE_FAIL_STATIC,
  SERVE_MODE_ORIGIN,
  LKG_STATE_KEY,
  assessOriginHealth,
  applyHealthToState,
  defaultLkgState,
  isCanaryPath,
  probeOriginHealth,
  readLkgState,
  versionIdForBody,
  withServeMode,
} from "../src/lib/fail_static.mjs";
import { handleMirror } from "../src/mirror.mjs";
import fixtures from "./fixtures/fail_static_health.json" with { type: "json" };

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      if (opts?.type === "json") {
        if (typeof v === "object") return v;
        try { return JSON.parse(v); } catch { return null; }
      }
      return typeof v === "string" ? v : JSON.stringify(v);
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function originResponse({ status, location, body }) {
  const headers = {};
  if (location) headers.location = location;
  if (body != null && status === 200) headers["Content-Type"] = "text/html; charset=utf-8";
  return new Response(body == null ? null : body, { status, headers });
}

// ---- pure assessor: class boundaries ----------------------------------------

test("assessOriginHealth: field case 2026-07-30 CNAME redirect loop is redirect_loop", () => {
  const fc = fixtures.field_case;
  const res = originResponse({
    status: fc.originStatus,
    location: fc.originLocation,
    body: null,
  });
  const h = assessOriginHealth(res, {
    requestUrl: `https://crol-list.org${fc.requestPath}`,
    isCanary: true,
  });
  assert.equal(h.ok, false);
  assert.equal(h.class, fc.expectedClass);
  assert.match(h.reason, /redirect/i);
});

for (const v of fixtures.variants) {
  test(`assessOriginHealth: variant ${v.id} → ${v.expectedClass}`, () => {
    const res = originResponse({
      status: v.originStatus,
      location: v.originLocation,
      body: v.body,
    });
    const h = assessOriginHealth(res, {
      bodyText: v.body,
      requestUrl: `https://crol-list.org${v.requestPath}`,
      isCanary: isCanaryPath(v.requestPath),
    });
    assert.equal(h.ok, false, v.id);
    assert.equal(h.class, v.expectedClass, v.id);
  });
}

test("assessOriginHealth: healthy index is ok", () => {
  const h = assessOriginHealth(
    originResponse({ status: 200, body: fixtures.healthy.body }),
    { bodyText: fixtures.healthy.body, isCanary: true },
  );
  assert.equal(h.ok, true);
  assert.equal(h.class, null);
});

test("assessOriginHealth: non-canary 404 is not a site outage", () => {
  const h = assessOriginHealth(
    originResponse({ status: 404, body: "not found" }),
    { bodyText: "not found", isCanary: false },
  );
  assert.equal(h.ok, true);
});

// ---- pin state: flip, flip-back, promotion gating ---------------------------

test("applyHealthToState: unhealthy does not promote and flips to fail-static", async () => {
  const healthyBody = fixtures.healthy.body;
  const versionId = await versionIdForBody(healthyBody);
  const withPin = {
    ...defaultLkgState(),
    mode: SERVE_MODE_ORIGIN,
    lkg: { versionId, promotedAt: "2026-07-29T00:00:00.000Z", canaryPath: "/" },
  };
  const result = applyHealthToState(withPin, {
    ok: false,
    class: "redirect_loop",
    reason: "origin 301 redirect loop",
    attempts: HEALTH_MAX_ATTEMPTS,
    versionId: "should-not-land",
  }, { now: "2026-07-30T12:00:00.000Z" });

  assert.equal(result.promoted, false);
  assert.equal(result.flipped, true);
  assert.equal(result.to, SERVE_MODE_FAIL_STATIC);
  assert.equal(result.state.mode, SERVE_MODE_FAIL_STATIC);
  assert.equal(result.state.lkg.versionId, versionId, "pin must stay frozen on failure");
  assert.equal(result.state.lastFlip.from, SERVE_MODE_ORIGIN);
  assert.equal(result.state.lastFlip.to, SERVE_MODE_FAIL_STATIC);
});

test("applyHealthToState: recovery flips back and promotes a new version id", async () => {
  const oldId = await versionIdForBody("old good");
  const newBody = fixtures.healthy.body;
  const newId = await versionIdForBody(newBody);
  const failStatic = {
    ...defaultLkgState(),
    mode: SERVE_MODE_FAIL_STATIC,
    lkg: { versionId: oldId, promotedAt: "2026-07-29T00:00:00.000Z", canaryPath: "/" },
  };
  const result = applyHealthToState(failStatic, {
    ok: true,
    attempts: 1,
    versionId: newId,
    canaryPath: "/",
    bodyText: newBody,
  }, { now: "2026-07-30T18:00:00.000Z" });

  assert.equal(result.flipped, true);
  assert.equal(result.from, SERVE_MODE_FAIL_STATIC);
  assert.equal(result.to, SERVE_MODE_ORIGIN);
  assert.equal(result.promoted, true);
  assert.equal(result.state.mode, SERVE_MODE_ORIGIN);
  assert.equal(result.state.lkg.versionId, newId);
  assert.equal(result.state.lkg.promotedAt, "2026-07-30T18:00:00.000Z");
});

test("applyHealthToState: healthy origin with same version id does not re-promote", async () => {
  const id = await versionIdForBody(fixtures.healthy.body);
  const state = {
    ...defaultLkgState(),
    mode: SERVE_MODE_ORIGIN,
    lkg: { versionId: id, promotedAt: "2026-07-29T00:00:00.000Z", canaryPath: "/" },
  };
  const result = applyHealthToState(state, {
    ok: true,
    versionId: id,
    attempts: 1,
  });
  assert.equal(result.promoted, false);
  assert.equal(result.flipped, false);
  assert.equal(result.state.lkg.promotedAt, "2026-07-29T00:00:00.000Z");
});

// ---- bounded retries (network blip vs stable failure) -----------------------

test("probeOriginHealth: a single network blip then success does not fail the probe", async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    if (n === 1) throw new Error("transient connect reset");
    return originResponse({ status: 200, body: fixtures.healthy.body });
  };
  const result = await probeOriginHealth({
    fetch,
    originBase: "https://crol-list.org",
    canaryPath: "/",
    maxAttempts: HEALTH_MAX_ATTEMPTS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.ok(result.versionId);
});

test("probeOriginHealth: stable redirect loop exhausts retries and stays unhealthy", async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    return originResponse({
      status: fixtures.field_case.originStatus,
      location: fixtures.field_case.originLocation,
      body: null,
    });
  };
  const result = await probeOriginHealth({
    fetch,
    originBase: "https://crol-list.org",
    canaryPath: "/",
    maxAttempts: HEALTH_MAX_ATTEMPTS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.class, "redirect_loop");
  assert.equal(result.attempts, HEALTH_MAX_ATTEMPTS);
  assert.equal(n, HEALTH_MAX_ATTEMPTS);
});

// ---- handleMirror integration -----------------------------------------------

test("handleMirror: field case 2026-07-30 flips to fail-static, serves LKG, freezes pin", async () => {
  const goodBody = fixtures.healthy.body;
  const versionId = await versionIdForBody(goodBody);
  const kv = memoryKv({
    [LKG_STATE_KEY]: JSON.stringify({
      version: 1,
      mode: SERVE_MODE_ORIGIN,
      lkg: { versionId, promotedAt: "2026-07-29T00:00:00.000Z", canaryPath: "/" },
    }),
    "mirror:lkg:body:/index.html": JSON.stringify({
      body: goodBody,
      contentType: "text/html; charset=utf-8",
      storedAt: "2026-07-29T00:00:00.000Z",
    }),
  });

  const originalFetch = globalThis.fetch;
  let originHits = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://crol-list.org")) {
      originHits += 1;
      return originResponse({
        status: fixtures.field_case.originStatus,
        location: fixtures.field_case.originLocation,
        body: null,
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  try {
    const res = await handleMirror(
      new Request("https://cityscroll.org/"),
      { ALERT_STATE: kv },
      { now: "2026-07-30T12:00:00.000Z" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_FAIL_STATIC);
    assert.equal(await res.text(), goodBody);
    assert.ok(originHits >= HEALTH_MAX_ATTEMPTS, "bounded retries before flip");

    const state = await readLkgState(kv);
    assert.equal(state.mode, SERVE_MODE_FAIL_STATIC);
    assert.equal(state.lkg.versionId, versionId, "promotion must not advance on failure");
    assert.equal(state.lastFlip?.to, SERVE_MODE_FAIL_STATIC);
    assert.match(state.lastHealth?.class || "", /redirect_loop/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: recovery from fail-static resumes origin and advances promotion", async () => {
  const oldBody = "<html>old lkg</html>";
  const newBody = fixtures.healthy.body;
  const oldId = await versionIdForBody(oldBody);
  const newId = await versionIdForBody(newBody);
  const kv = memoryKv({
    [LKG_STATE_KEY]: JSON.stringify({
      version: 1,
      mode: SERVE_MODE_FAIL_STATIC,
      lkg: { versionId: oldId, promotedAt: "2026-07-29T00:00:00.000Z", canaryPath: "/" },
    }),
    "mirror:lkg:body:/index.html": JSON.stringify({
      body: oldBody,
      contentType: "text/html; charset=utf-8",
    }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://crol-list.org")) {
      return originResponse({ status: 200, body: newBody });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const res = await handleMirror(
      new Request("https://cityscroll.org/"),
      { ALERT_STATE: kv },
      { now: "2026-07-30T18:00:00.000Z" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_ORIGIN);
    assert.equal(await res.text(), newBody);

    const state = await readLkgState(kv);
    assert.equal(state.mode, SERVE_MODE_ORIGIN);
    assert.equal(state.lkg.versionId, newId);
    assert.equal(state.lkg.promotedAt, "2026-07-30T18:00:00.000Z");
    assert.equal(state.lastFlip?.from, SERVE_MODE_FAIL_STATIC);
    assert.equal(state.lastFlip?.to, SERVE_MODE_ORIGIN);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: healthy origin serves with mode header and pins LKG on first success", async () => {
  const body = fixtures.healthy.body;
  const kv = memoryKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://crol-list.org")) {
      return originResponse({ status: 200, body });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const res = await handleMirror(
      new Request("https://cityscroll.org/"),
      { ALERT_STATE: kv },
      { now: "2026-07-30T10:00:00.000Z" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_ORIGIN);
    assert.equal(await res.text(), body);
    const state = await readLkgState(kv);
    assert.equal(state.mode, SERVE_MODE_ORIGIN);
    assert.ok(state.lkg?.versionId);
    assert.equal(state.lkg.promotedAt, "2026-07-30T10:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMirror: non-200 canary variants flip without promoting", async () => {
  for (const v of fixtures.variants.filter((x) => x.expectedClass === "non_200" || x.expectedClass === "empty_body" || x.expectedClass === "error_page")) {
    const goodBody = fixtures.healthy.body;
    const versionId = await versionIdForBody(goodBody);
    const kv = memoryKv({
      [LKG_STATE_KEY]: JSON.stringify({
        version: 1,
        mode: SERVE_MODE_ORIGIN,
        lkg: { versionId, promotedAt: "2026-07-29T00:00:00.000Z", canaryPath: "/" },
      }),
      "mirror:lkg:body:/index.html": JSON.stringify({
        body: goodBody,
        contentType: "text/html; charset=utf-8",
      }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith("https://crol-list.org")) {
        return originResponse({
          status: v.originStatus,
          location: v.originLocation,
          body: v.body,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const res = await handleMirror(
        new Request(`https://cityscroll.org${v.requestPath}`),
        { ALERT_STATE: kv },
      );
      assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_FAIL_STATIC, v.id);
      assert.equal(await res.text(), goodBody, v.id);
      const state = await readLkgState(kv);
      assert.equal(state.lkg.versionId, versionId, v.id);
      assert.equal(state.mode, SERVE_MODE_FAIL_STATIC, v.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("withServeMode: stamps the observable mode header", () => {
  const res = withServeMode(new Response("x", { status: 200 }), SERVE_MODE_FAIL_STATIC);
  assert.equal(res.headers.get(SERVE_HEADER), SERVE_MODE_FAIL_STATIC);
});
