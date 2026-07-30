// GET|POST /session — magic-link recognition + session cookie.
// GET|POST /session/logout — drop the session cookie.
//
// Email digests carry a pins-scoped signed token (optin-token). Clicking through
// exchanges it for an HttpOnly Secure SameSite=Lax cookie. Scope is READ + pins
// only; unsubscribe/confirm keep their own purpose tokens.
//
// Invalid / expired / rate-limited tokens degrade silently to anonymous
// (redirect without cookie, or JSON { ok:true, recognized:false }) — no scary errors.

import { signToken, verifyToken } from "optin-token";
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { overActorLimit } from "./lib/meter.mjs";
import {
  EMAIL_SESSION_TTL_SECONDS,
  SESSION_COOKIE_TTL_SECONDS,
  MAX_SESSION_ATTEMPTS_PER_IP_DAY,
  isPinsSessionPayload,
  sessionPayload,
  sessionCookieHeader,
  readSessionCookie,
  safeNextUrl,
} from "./lib/session.mjs";

const CORS_OPTS = {
  methods: "GET, POST, OPTIONS",
  headers: "Content-Type",
  credentials: true,
};

function sessionCors(origin, env) {
  return corsHeaders(origin, env, CORS_OPTS);
}

export async function handleSession(req, env, pathname) {
  const origin = req.headers.get("origin") || "";
  const cors = sessionCors(origin, env);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (pathname === "/session/logout") {
    return handleLogout(req, cors);
  }

  if (pathname !== "/session") {
    return json({ ok: false, reason: "not-found" }, 404, cors);
  }

  // GET without token: report whether the cookie is a recognized pins session.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const tokenParam = url.searchParams.get("token") || url.searchParams.get("s") || "";
    if (tokenParam) {
      return exchangeAndRedirect(req, env, tokenParam, url.searchParams.get("next"), cors);
    }
    return statusFromCookie(req, env, cors);
  }

  if (req.method === "POST") {
    // Credentialed CORS: require an allowed Origin (browsers always send one).
    if (origin && !isAllowedRequestOrigin(origin, env)) {
      return json({ ok: true, recognized: false }, 200, cors);
    }
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const token = String(body.token || body.s || "");
    if (!token) {
      // Logout alias or empty body → just report status.
      if (body.logout) return handleLogout(req, cors);
      return statusFromCookie(req, env, cors);
    }
    return exchangeJson(req, env, token, cors);
  }

  return json({ ok: false, reason: "method" }, 405, cors);
}

async function statusFromCookie(req, env, cors) {
  const email = await emailFromRequest(req, env);
  return json({ ok: true, recognized: !!email }, 200, cors);
}

async function handleLogout(req, cors) {
  const headers = {
    ...cors,
    "Content-Type": "application/json",
    "Set-Cookie": sessionCookieHeader("", { clear: true }),
    "Cache-Control": "no-store",
  };
  if (req.method === "GET") {
    // GET logout used from the banner; prefer a soft landing on the site.
    const next = safeNextUrl(new URL(req.url).searchParams.get("next"));
    headers["Location"] = next;
    return new Response(null, { status: 302, headers });
  }
  return new Response(JSON.stringify({ ok: true, recognized: false }), { status: 200, headers });
}

async function exchangeAndRedirect(req, env, token, nextRaw, cors) {
  const next = safeNextUrl(nextRaw);
  const headers = { "Cache-Control": "no-store", Location: next };
  // Always redirect; only attach a cookie when the token is valid.
  const exchanged = await tryExchange(req, env, token);
  if (exchanged.cookie) headers["Set-Cookie"] = exchanged.cookie;
  return new Response(null, { status: 302, headers });
}

async function exchangeJson(req, env, token, cors) {
  const exchanged = await tryExchange(req, env, token);
  const headers = {
    ...cors,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (exchanged.cookie) headers["Set-Cookie"] = exchanged.cookie;
  return new Response(
    JSON.stringify({ ok: true, recognized: !!exchanged.cookie }),
    { status: 200, headers },
  );
}

/**
 * Verify a pins-scoped email token (or an already-issued session token) and mint
 * a fresh session cookie. Rate-limits by IP. Never throws; failures → no cookie.
 */
async function tryExchange(req, env, token) {
  if (!env.TOKEN_SECRET || !token) return { cookie: null };
  const ip = req.headers.get("CF-Connecting-IP") || "";
  if (ip && env.SUBS && await overActorLimit(env.SUBS, "session", ip, MAX_SESSION_ATTEMPTS_PER_IP_DAY)) {
    return { cookie: null };
  }
  const res = await verifyToken(env.TOKEN_SECRET, token);
  if (!res.valid || !isPinsSessionPayload(res.payload)) return { cookie: null };
  // Re-issue a bounded session cookie (independent of the email-link expiry window).
  const cookieTok = await signToken(
    env.TOKEN_SECRET,
    sessionPayload(res.payload.e),
    { ttlSeconds: SESSION_COOKIE_TTL_SECONDS },
  );
  return { cookie: sessionCookieHeader(cookieTok), email: res.payload.e };
}

/** Resolve the subscriber email from the session cookie, or null. */
export async function emailFromRequest(req, env) {
  if (!env.TOKEN_SECRET) return null;
  const raw = readSessionCookie(req.headers.get("cookie") || "");
  if (!raw) return null;
  const res = await verifyToken(env.TOKEN_SECRET, raw);
  if (!res.valid || !isPinsSessionPayload(res.payload)) return null;
  return res.payload.e;
}

/** Sign a pins-scoped email-link token for digests (caller embeds in URLs). */
export async function issueEmailSessionToken(env, email, { now } = {}) {
  if (!env.TOKEN_SECRET || !email) return null;
  return signToken(
    env.TOKEN_SECRET,
    sessionPayload(email),
    { ttlSeconds: EMAIL_SESSION_TTL_SECONDS, now },
  );
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
