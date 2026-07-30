// /mirror — serves the canonical cityscroll.org and www.cityscroll.org hosts by
// reverse-proxying the static site from crol-list.org, its GitHub Pages origin.
// Origin redirects are handled manually so a redirect back to this Worker cannot
// become a recursive subrequest loop. If the direct-visitor redirect catches the
// subrequest, the public repository source is the independent failover seam.
//
// GitHub Pages virtual-hosts by the Host header, so the request to the origin must NOT
// carry the incoming Host (cityscroll.org) — that would 404 on a domain GitHub doesn't
// know about. Only a small, safe header allowlist is forwarded; everything else is dropped.
//
// Health-gated fail-static: a last-known-good pin in ALERT_STATE is promoted only after
// the origin passes a post-deploy health check. When the origin fails (redirect loop,
// non-200, empty body, error page) after bounded retries, the edge serves the pinned
// snapshot and freezes promotion so visitors never see a broken deploy.

import {
  SERVE_MODE_FAIL_STATIC,
  SERVE_MODE_ORIGIN,
  HEALTH_MAX_ATTEMPTS,
  applyHealthToState,
  assessOriginHealth,
  isCanaryPath,
  lkgBodyKey,
  probeOriginHealth,
  readLkgBody,
  readLkgState,
  versionIdForBody,
  withServeMode,
  writeLkgBody,
  writeLkgState,
} from "./lib/fail_static.mjs";

const ORIGIN = "https://crol-list.org";
const FALLBACK_ORIGIN = "https://raw.githubusercontent.com/cityscroll/crol-list/main/";
const FORWARD_REQUEST_HEADERS = ["accept", "accept-language", "if-none-match", "if-modified-since", "user-agent"];
const MIRROR_HOSTS = new Set([
  "cityscroll.org",
  "www.cityscroll.org",
  "crol-list.org",
]);
const FALLBACK_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json"],
  [".xml", "application/xml; charset=utf-8"],
]);

function redirectedToMirror(response) {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const target = new URL(location, ORIGIN);
    return MIRROR_HOSTS.has(target.hostname) ? target : null;
  } catch {
    return null;
  }
}

function fallbackUrl(target) {
  let pathname = target.pathname;
  if (pathname.endsWith("/")) pathname += "index.html";
  const url = new URL(pathname.replace(/^\/+/, ""), FALLBACK_ORIGIN);
  url.search = target.search;
  return url;
}

function fallbackContentType(pathname) {
  const dot = pathname.lastIndexOf(".");
  return dot === -1 ? null : FALLBACK_CONTENT_TYPES.get(pathname.slice(dot).toLowerCase()) || null;
}

function relay(response, fallbackPathname = null) {
  if (fallbackPathname === null) return new Response(response.body, response);

  const headers = new Headers(response.headers);
  const contentType = fallbackContentType(fallbackPathname);
  if (contentType) headers.set("Content-Type", contentType);
  if (contentType?.startsWith("text/html")) {
    // raw.githubusercontent.com marks source files as sandboxed plain text.
    headers.delete("Content-Security-Policy");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function forwardHeaders(request) {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function logServeEvent(event) {
  // Workers log ingestion picks this up; the response header is the visitor-visible signal.
  try {
    console.log("mirror-serve:", JSON.stringify(event));
  } catch {
    /* ignore */
  }
}

async function servePinnedLkg(request, env, incoming, fetchImpl) {
  const kv = env?.ALERT_STATE;
  const pathKey = incoming.pathname.endsWith("/")
    ? `${incoming.pathname}index.html`
    : incoming.pathname;

  const snap = await readLkgBody(kv, pathKey);
  if (snap?.body != null) {
    return new Response(snap.body, {
      status: 200,
      headers: {
        "Content-Type": snap.contentType || "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // No path snapshot: public source seam at the last-known-good tree (main pin).
  // This is the same precompute-first static seam the redirect-loop failover uses —
  // not a live app-data fetch.
  const target = new URL(incoming.pathname + incoming.search, ORIGIN);
  const fallback = fallbackUrl(target);
  try {
    const fallbackResponse = await fetchImpl(fallback.toString(), {
      method: request.method,
      headers: forwardHeaders(request),
      redirect: "manual",
    });
    if (fallbackResponse.ok) {
      return relay(fallbackResponse, fallback.pathname);
    }
  } catch {
    /* fall through to 503 */
  }

  return new Response("Site temporarily unavailable (fail-static; no last-known-good snapshot).", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function persistHealth(env, stateBefore, health, opts) {
  const applied = applyHealthToState(stateBefore, health, { now: opts.now });
  await writeLkgState(env?.ALERT_STATE, applied.state);

  if (applied.promoted && health.ok && health.bodyText != null) {
    await writeLkgBody(
      env?.ALERT_STATE,
      health.canaryPath || "/",
      health.bodyText,
      "text/html; charset=utf-8",
    );
    // Also store under /index.html so directory and file canaries share one snapshot.
    if ((health.canaryPath || "/") === "/") {
      await writeLkgBody(
        env?.ALERT_STATE,
        "/index.html",
        health.bodyText,
        "text/html; charset=utf-8",
      );
    }
  }

  if (applied.flipped) {
    logServeEvent({
      event: "mode_flip",
      from: applied.from,
      to: applied.to,
      reason: health.reason || health.class,
      attempts: health.attempts,
      lkg: applied.state.lkg?.versionId || null,
    });
  } else if (applied.promoted) {
    logServeEvent({
      event: "promote",
      versionId: applied.state.lkg?.versionId || null,
      canaryPath: health.canaryPath || "/",
    });
  }

  return applied;
}

/**
 * @param {Request} request
 * @param {{ ALERT_STATE?: KVNamespace }} [env]
 * @param {{ now?: string|Date, fetch?: typeof fetch }} [opts]
 */
export async function handleMirror(request, env = {}, opts = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain", "Allow": "GET, HEAD" } });
  }

  const fetchImpl = opts.fetch || globalThis.fetch;
  const incoming = new URL(request.url);
  const headers = forwardHeaders(request);
  const fetchOptions = { method: request.method, headers, redirect: "manual" };
  const kv = env?.ALERT_STATE;
  const stateBefore = await readLkgState(kv);
  const pathIsCanary = isCanaryPath(incoming.pathname);

  // When already fail-static, probe for recovery with bounded retries, then either
  // flip back + serve origin, or keep serving the pin.
  if (stateBefore.mode === SERVE_MODE_FAIL_STATIC) {
    const health = await probeOriginHealth({
      fetch: fetchImpl,
      originBase: ORIGIN,
      canaryPath: pathIsCanary ? (incoming.pathname === "/" ? "/" : incoming.pathname) : "/",
      headers,
      maxAttempts: HEALTH_MAX_ATTEMPTS,
      method: request.method === "HEAD" ? "GET" : request.method,
    });

    if (health.ok) {
      await persistHealth(env, stateBefore, health, opts);
      // Re-fetch the requested path from the recovered origin (canary body may differ).
      const originUrl = new URL(incoming.pathname + incoming.search, ORIGIN);
      const originResponse = await fetchImpl(originUrl.toString(), fetchOptions);
      const mirrorRedirect = redirectedToMirror(originResponse);
      if (mirrorRedirect) {
        // Recovered canary but this path still loops — keep fail-static for the response
        // without advancing a second flip cycle; serve pin.
        const pinned = await servePinnedLkg(request, env, incoming, fetchImpl);
        logServeEvent({ event: "serve", mode: SERVE_MODE_FAIL_STATIC, path: incoming.pathname, reason: "path_redirect_after_recovery" });
        return withServeMode(pinned, SERVE_MODE_FAIL_STATIC);
      }
      // Opportunistically snapshot HTML for this path.
      if (originResponse.ok && (originResponse.headers.get("content-type") || "").includes("text/html")) {
        try {
          const bodyText = await originResponse.clone().text();
          await writeLkgBody(kv, incoming.pathname, bodyText, originResponse.headers.get("content-type"));
        } catch { /* ignore */ }
      }
      logServeEvent({ event: "serve", mode: SERVE_MODE_ORIGIN, path: incoming.pathname, reason: "recovered" });
      return withServeMode(relay(originResponse), SERVE_MODE_ORIGIN);
    }

    await persistHealth(env, stateBefore, health, opts);
    const pinned = await servePinnedLkg(request, env, incoming, fetchImpl);
    logServeEvent({
      event: "serve",
      mode: SERVE_MODE_FAIL_STATIC,
      path: incoming.pathname,
      reason: health.reason || health.class,
    });
    return withServeMode(pinned, SERVE_MODE_FAIL_STATIC);
  }

  // Origin mode: fetch the requested path. Site-breaking failures run a bounded
  // canary probe before flipping the pin (network-blip absorption).
  const originUrl = new URL(incoming.pathname + incoming.search, ORIGIN);
  let originResponse;
  try {
    originResponse = await fetchImpl(originUrl.toString(), fetchOptions);
  } catch (err) {
    // Treat as site-breaking; run full probe with retries.
    const health = await probeOriginHealth({
      fetch: fetchImpl,
      originBase: ORIGIN,
      canaryPath: "/",
      headers,
      maxAttempts: HEALTH_MAX_ATTEMPTS,
    });
    if (health.ok) {
      await persistHealth(env, stateBefore, health, opts);
      const retry = await fetchImpl(originUrl.toString(), fetchOptions);
      return withServeMode(relay(retry), SERVE_MODE_ORIGIN);
    }
    await persistHealth(env, stateBefore, {
      ...health,
      reason: health.reason || `origin fetch error: ${String(err?.message || err)}`,
    }, opts);
    const pinned = await servePinnedLkg(request, env, incoming, fetchImpl);
    return withServeMode(pinned, SERVE_MODE_FAIL_STATIC);
  }

  const mirrorRedirect = redirectedToMirror(originResponse);
  if (mirrorRedirect) {
    // Existing public-source failover for the response path, plus health-gated pin flip.
    const health = await probeOriginHealth({
      fetch: fetchImpl,
      originBase: ORIGIN,
      canaryPath: "/",
      headers,
      maxAttempts: Math.max(1, HEALTH_MAX_ATTEMPTS - 1), // already spent one origin hit
    });
    // The first hit already failed with a loop; if probe somehow succeeds, serve origin path.
    if (health.ok) {
      await persistHealth(env, stateBefore, health, opts);
      const retry = await fetchImpl(originUrl.toString(), fetchOptions);
      if (!redirectedToMirror(retry)) {
        return withServeMode(relay(retry), SERVE_MODE_ORIGIN);
      }
    } else {
      await persistHealth(env, stateBefore, {
        ok: false,
        class: "redirect_loop",
        reason: health.reason || `origin redirect to ${mirrorRedirect.hostname}`,
        attempts: (health.attempts || 0) + 1,
      }, opts);
    }

    // Prefer pinned LKG snapshot when present; otherwise the public source seam.
    const snap = await readLkgBody(kv, incoming.pathname.endsWith("/") ? `${incoming.pathname}index.html` : incoming.pathname);
    if (snap?.body != null) {
      const pinned = new Response(snap.body, {
        status: 200,
        headers: {
          "Content-Type": snap.contentType || "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
      logServeEvent({ event: "serve", mode: SERVE_MODE_FAIL_STATIC, path: incoming.pathname, reason: "redirect_loop" });
      return withServeMode(pinned, SERVE_MODE_FAIL_STATIC);
    }

    const fallback = fallbackUrl(mirrorRedirect);
    const fallbackResponse = await fetchImpl(fallback.toString(), fetchOptions);
    logServeEvent({ event: "serve", mode: SERVE_MODE_FAIL_STATIC, path: incoming.pathname, reason: "redirect_loop_public_source" });
    return withServeMode(relay(fallbackResponse, fallback.pathname), SERVE_MODE_FAIL_STATIC);
  }

  // Assess this response. Canary paths drive promotion / site-wide flip.
  let bodyText = null;
  const contentType = originResponse.headers.get("content-type") || "";
  const shouldReadBody = originResponse.status === 200 && (
    pathIsCanary || contentType.includes("text/html")
  );
  if (shouldReadBody && request.method !== "HEAD") {
    try { bodyText = await originResponse.clone().text(); } catch { bodyText = null; }
  }

  const assessed = assessOriginHealth(originResponse, {
    bodyText,
    requestUrl: originUrl.toString(),
    isCanary: pathIsCanary,
  });

  if (!assessed.ok && (pathIsCanary || assessed.class === "redirect_loop" || assessed.class === "error_page")) {
    // Bounded retries before flipping: re-probe the canary.
    const health = await probeOriginHealth({
      fetch: fetchImpl,
      originBase: ORIGIN,
      canaryPath: "/",
      headers,
      maxAttempts: HEALTH_MAX_ATTEMPTS,
    });
    if (health.ok) {
      await persistHealth(env, stateBefore, health, opts);
      // First response was a blip or path-local issue; if canary is fine, re-fetch path.
      const retry = await fetchImpl(originUrl.toString(), fetchOptions);
      if (!redirectedToMirror(retry)) {
        logServeEvent({ event: "serve", mode: SERVE_MODE_ORIGIN, path: incoming.pathname, reason: "blip_recovered" });
        return withServeMode(relay(retry), SERVE_MODE_ORIGIN);
      }
    }
    await persistHealth(env, stateBefore, {
      ok: false,
      class: health.ok ? assessed.class : (health.class || assessed.class),
      reason: health.ok ? assessed.reason : (health.reason || assessed.reason),
      attempts: health.attempts || HEALTH_MAX_ATTEMPTS,
    }, opts);
    const pinned = await servePinnedLkg(request, env, incoming, fetchImpl);
    logServeEvent({
      event: "serve",
      mode: SERVE_MODE_FAIL_STATIC,
      path: incoming.pathname,
      reason: assessed.reason || assessed.class,
    });
    return withServeMode(pinned, SERVE_MODE_FAIL_STATIC);
  }

  // Healthy (or non-canary 404 etc.): promote when canary is healthy.
  if (pathIsCanary && assessed.ok && bodyText != null) {
    const versionId = await versionIdForBody(bodyText);
    await persistHealth(env, stateBefore, {
      ok: true,
      attempts: 1,
      versionId,
      canaryPath: incoming.pathname || "/",
      bodyText,
    }, opts);
    // Opportunistic path snapshot for fail-static coverage.
    await writeLkgBody(kv, incoming.pathname, bodyText, contentType || "text/html; charset=utf-8");
    if (incoming.pathname === "/") {
      await writeLkgBody(kv, "/index.html", bodyText, contentType || "text/html; charset=utf-8");
    }
  } else if (assessed.ok && bodyText != null && contentType.includes("text/html")) {
    // Keep non-canary HTML snapshots fresh while origin is healthy (does not move the pin).
    await writeLkgBody(kv, incoming.pathname, bodyText, contentType);
  }

  logServeEvent({ event: "serve", mode: SERVE_MODE_ORIGIN, path: incoming.pathname });
  return withServeMode(relay(originResponse), SERVE_MODE_ORIGIN);
}

// Re-export for tests that import mirror helpers indirectly.
export { lkgBodyKey };
