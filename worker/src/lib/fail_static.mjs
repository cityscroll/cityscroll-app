// Fail-static / health-gated auto-rollback for the CityScroll site mirror.
//
// The mirror pins a last-known-good (LKG) snapshot in KV. When the GitHub Pages
// origin fails a health check (redirect loop, non-200, empty body, error page),
// the edge serves the pinned LKG instead of the broken origin. Promotion of the
// pin advances only after a healthy post-deploy check — that is the blue-green
// promotion step. Public visitors never see a broken deploy at the edge.

export const LKG_STATE_KEY = "mirror:lkg:v1";
export const LKG_BODY_KEY_PREFIX = "mirror:lkg:body:";
export const SERVE_HEADER = "X-CityScroll-Serve";
export const SERVE_MODE_ORIGIN = "origin";
export const SERVE_MODE_FAIL_STATIC = "fail-static";

/** Bounded retries before a health probe declares the origin unhealthy. */
export const HEALTH_MAX_ATTEMPTS = 3;

/** Paths whose health stands in for the whole origin (post-deploy canaries). */
export const CANARY_PATHS = new Set(["/", "/index.html"]);

const ERROR_BODY_MARKERS = [
  /there isn't a github pages site here/i,
  /repository not found/i,
  /<!doctype html>[\s\S]{0,400}<h1>\s*404\s*<\/h1>/i,
  /file not found/i,
  /pages site is currently being built/i,
];

/**
 * Classify an origin response as healthy or not.
 * @param {Response|null} response
 * @param {{ bodyText?: string|null, requestUrl?: string|URL|null, isCanary?: boolean }} [opts]
 * @returns {{ ok: boolean, class: string|null, reason: string|null }}
 */
export function assessOriginHealth(response, opts = {}) {
  if (!response) {
    return { ok: false, class: "network", reason: "origin fetch returned no response" };
  }

  const status = response.status;
  if (status >= 300 && status < 400) {
    const location = response.headers?.get?.("location") || response.headers?.get?.("Location");
    if (isRedirectLoopLocation(location, opts.requestUrl)) {
      return {
        ok: false,
        class: "redirect_loop",
        reason: `origin ${status} redirect loop via ${location || "(missing location)"}`,
      };
    }
    // Non-loop redirects on a canary are still origin failure for static hosting:
    // GitHub Pages should serve the document, not bounce the edge.
    if (opts.isCanary !== false) {
      return {
        ok: false,
        class: "redirect_loop",
        reason: `origin ${status} redirect on canary path: ${location || "(missing location)"}`,
      };
    }
  }

  if (status === 304) {
    return { ok: true, class: null, reason: null };
  }

  if (status !== 200) {
    // A 404 on a non-canary path is a normal missing asset, not a site outage.
    if (status === 404 && opts.isCanary === false) {
      return { ok: true, class: null, reason: null };
    }
    return {
      ok: false,
      class: "non_200",
      reason: `origin status ${status}`,
    };
  }

  const bodyText = opts.bodyText == null ? null : String(opts.bodyText);
  if (bodyText !== null && bodyText.trim().length === 0) {
    return { ok: false, class: "empty_body", reason: "origin returned empty body" };
  }

  if (bodyText !== null && looksLikeErrorPage(bodyText)) {
    return { ok: false, class: "error_page", reason: "origin body looks like an error page" };
  }

  return { ok: true, class: null, reason: null };
}

export function isCanaryPath(pathname) {
  if (!pathname) return false;
  return CANARY_PATHS.has(pathname) || pathname === "";
}

export function isRedirectLoopLocation(location, requestUrl) {
  if (!location) return false;
  try {
    const base = requestUrl ? new URL(requestUrl) : new URL("https://crol-list.org/");
    const target = new URL(location, base);
    const mirrorHosts = new Set([
      "cityscroll.org",
      "www.cityscroll.org",
      "crol-list.org",
      "www.crol-list.org",
    ]);
    if (mirrorHosts.has(target.hostname)) return true;
    // Same-host bounce (classic CNAME / Pages loop).
    if (target.hostname === base.hostname) return true;
    return false;
  } catch {
    return false;
  }
}

export function looksLikeErrorPage(bodyText) {
  if (!bodyText) return false;
  const sample = bodyText.slice(0, 4000);
  return ERROR_BODY_MARKERS.some((re) => re.test(sample));
}

/**
 * Default LKG pin state when KV is empty.
 * @returns {object}
 */
export function defaultLkgState() {
  return {
    version: 1,
    mode: SERVE_MODE_ORIGIN,
    lkg: null,
    lastHealth: null,
    lastFlip: null,
  };
}

/**
 * @param {object|null|undefined} raw
 * @returns {object}
 */
export function normalizeLkgState(raw) {
  if (!raw || typeof raw !== "object") return defaultLkgState();
  const mode = raw.mode === SERVE_MODE_FAIL_STATIC ? SERVE_MODE_FAIL_STATIC : SERVE_MODE_ORIGIN;
  return {
    version: 1,
    mode,
    lkg: raw.lkg && typeof raw.lkg === "object" ? raw.lkg : null,
    lastHealth: raw.lastHealth && typeof raw.lastHealth === "object" ? raw.lastHealth : null,
    lastFlip: raw.lastFlip && typeof raw.lastFlip === "object" ? raw.lastFlip : null,
  };
}

/**
 * Apply a completed health probe to pin state.
 * Promotion advances only on healthy probes; fail-static flips on unhealthy.
 *
 * @param {object} state
 * @param {{ ok: boolean, class?: string|null, reason?: string|null, attempts?: number, versionId?: string|null, canaryPath?: string, bodyText?: string|null }} health
 * @param {{ now?: string|Date }} [opts]
 * @returns {{ state: object, flipped: boolean, promoted: boolean, from: string|null, to: string|null }}
 */
export function applyHealthToState(state, health, opts = {}) {
  const prev = normalizeLkgState(state);
  const now = toIso(opts.now);
  const next = {
    ...prev,
    lastHealth: {
      ok: !!health.ok,
      class: health.class || null,
      reason: health.reason || null,
      attempts: health.attempts || 1,
      checkedAt: now,
    },
  };

  let flipped = false;
  let promoted = false;
  let from = null;
  let to = null;

  if (health.ok) {
    if (prev.mode === SERVE_MODE_FAIL_STATIC) {
      from = SERVE_MODE_FAIL_STATIC;
      to = SERVE_MODE_ORIGIN;
      next.mode = SERVE_MODE_ORIGIN;
      next.lastFlip = { at: now, from, to, reason: "origin recovered" };
      flipped = true;
    } else {
      next.mode = SERVE_MODE_ORIGIN;
    }

    // Blue-green promotion: advance the pin only after a healthy check.
    if (health.versionId) {
      const prevId = prev.lkg?.versionId || null;
      if (prevId !== health.versionId) {
        next.lkg = {
          versionId: health.versionId,
          promotedAt: now,
          canaryPath: health.canaryPath || "/",
        };
        promoted = true;
      } else if (!prev.lkg) {
        next.lkg = {
          versionId: health.versionId,
          promotedAt: now,
          canaryPath: health.canaryPath || "/",
        };
        promoted = true;
      } else {
        next.lkg = prev.lkg;
      }
    } else if (prev.lkg) {
      next.lkg = prev.lkg;
    }
  } else {
    // Unhealthy: never promote. Flip to fail-static when we have something to serve
    // or even without a pin (caller will use the public source seam).
    if (prev.mode !== SERVE_MODE_FAIL_STATIC) {
      from = prev.mode;
      to = SERVE_MODE_FAIL_STATIC;
      next.mode = SERVE_MODE_FAIL_STATIC;
      next.lastFlip = {
        at: now,
        from,
        to,
        reason: health.reason || health.class || "origin unhealthy",
      };
      flipped = true;
    } else {
      next.mode = SERVE_MODE_FAIL_STATIC;
    }
    // Keep the previous pin frozen.
    next.lkg = prev.lkg;
  }

  return { state: next, flipped, promoted, from, to };
}

/**
 * Content-addressed version id for a healthy canary body.
 * @param {string} bodyText
 * @returns {Promise<string>}
 */
export async function versionIdForBody(bodyText) {
  const data = new TextEncoder().encode(String(bodyText || ""));
  // SubtleCrypto is available in Workers and modern Node.
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return hex(new Uint8Array(digest)).slice(0, 16);
  }
  // Deterministic fallback for exotic runtimes without subtle.
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function lkgBodyKey(pathname) {
  let path = pathname || "/";
  if (path.endsWith("/")) path += "index.html";
  if (path === "") path = "/index.html";
  return `${LKG_BODY_KEY_PREFIX}${path}`;
}

export function withServeMode(response, mode) {
  const headers = new Headers(response.headers);
  headers.set(SERVE_HEADER, mode);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Run a bounded health probe against the origin canary.
 * Distinguishes a network blip (retry succeeds) from a stable origin failure.
 *
 * @param {{ fetch: Function, originBase: string, canaryPath?: string, headers?: HeadersInit, maxAttempts?: number, method?: string }} opts
 */
export async function probeOriginHealth(opts) {
  const maxAttempts = opts.maxAttempts ?? HEALTH_MAX_ATTEMPTS;
  const canaryPath = opts.canaryPath || "/";
  const method = opts.method || "GET";
  const originUrl = new URL(canaryPath, opts.originBase).toString();
  let last = { ok: false, class: "network", reason: "no attempts", attempts: 0, bodyText: null, response: null };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response = null;
    let bodyText = null;
    try {
      response = await opts.fetch(originUrl, {
        method,
        headers: opts.headers,
        redirect: "manual",
      });
      // Read body for empty/error detection; clone so callers can still use the response.
      if (response && method !== "HEAD") {
        bodyText = await response.clone().text();
      }
    } catch (err) {
      last = {
        ok: false,
        class: "network",
        reason: `origin fetch error: ${String(err?.message || err)}`,
        attempts: attempt,
        bodyText: null,
        response: null,
      };
      continue;
    }

    const assessed = assessOriginHealth(response, {
      bodyText,
      requestUrl: originUrl,
      isCanary: true,
    });
    last = {
      ...assessed,
      attempts: attempt,
      bodyText,
      response,
      canaryPath,
    };
    if (assessed.ok) {
      if (bodyText != null) {
        last.versionId = await versionIdForBody(bodyText);
      }
      return last;
    }
  }

  return last;
}

/**
 * @param {{ get?: Function }|null|undefined} kv
 * @returns {Promise<object>}
 */
export async function readLkgState(kv) {
  if (!kv?.get) return defaultLkgState();
  try {
    let raw;
    try {
      raw = await kv.get(LKG_STATE_KEY, { type: "json" });
    } catch {
      raw = await kv.get(LKG_STATE_KEY);
    }
    if (raw == null) {
      raw = await kv.get(LKG_STATE_KEY);
    }
    if (raw == null) return defaultLkgState();
    if (typeof raw === "object") return normalizeLkgState(raw);
    return normalizeLkgState(JSON.parse(String(raw)));
  } catch {
    return defaultLkgState();
  }
}

export async function writeLkgState(kv, state) {
  if (!kv?.put) return;
  try {
    await kv.put(LKG_STATE_KEY, JSON.stringify(normalizeLkgState(state)));
  } catch {
    /* fail-soft: serving continues even if pin persistence fails */
  }
}

export async function writeLkgBody(kv, pathname, bodyText, contentType) {
  if (!kv?.put || bodyText == null) return;
  const key = lkgBodyKey(pathname);
  try {
    await kv.put(key, JSON.stringify({
      body: bodyText,
      contentType: contentType || "text/html; charset=utf-8",
      storedAt: new Date().toISOString(),
    }));
  } catch {
    /* fail-soft */
  }
}

export async function readLkgBody(kv, pathname) {
  if (!kv?.get) return null;
  try {
    const raw = await kv.get(lkgBodyKey(pathname));
    if (!raw) return null;
    if (typeof raw === "object" && raw.body != null) return raw;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.body === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function toIso(now) {
  if (!now) return new Date().toISOString();
  if (now instanceof Date) return now.toISOString();
  return String(now);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
