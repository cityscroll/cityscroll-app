// Common CityScroll account HTTP surface (engine-owned).
//
//   POST /account/v1/login   { email, operationId, turnstileToken } -> 202 (generic)
//   POST /account/v1/confirm { token }                              -> 200 session info
//   GET  /account/v1/me                                             -> 200 status
//   POST /account/v1/logout  { allSessions? }                       -> 204
//
// Plus authorizeIdentity(env, args): the introspection-only authorization the
// procurement product reaches through its CITYSCROLL_IDENTITY service binding.
// That binding exposes authorize only; login/confirm/logout are public-auth
// handlers here and are not product RPC methods, and nothing in this module can
// reach an admin handler.
//
// The whole surface is inert until CITYSCROLL_ACCOUNTS_ENABLED is set to "true".
// While off, every route 404s exactly as before the feature existed, so no
// user-visible sign-in appears and existing routing is unchanged.

import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { verifySignupTurnstile } from "./lib/signup_turnstile.mjs";
import { sendTransactionalEmail } from "./lib/transactional_mail.mjs";
import {
  readSessionCookies,
  sessionCookieHeader,
  canIssueSharedSessionCookie,
} from "./lib/session.mjs";
import { normalizeEmail, isValidEmail } from "./lib/subscriptions.mjs";
import {
  AccountStore,
  ContractError,
  COMMON_SCOPES,
  SESSION_ABSOLUTE_SECONDS,
  authorizeForProduct,
  csrfTokenFor,
  maskEmail,
  newIntentSecret,
  sha256Hex,
} from "./lib/account.mjs";

const ALLOWED_ORIGIN = "https://cityscroll.org";
const CONFIRM_URL = "https://cityscroll.org/account/confirm";
const LOGIN_INTENT_COOKIE = "cs_login_intent";
const MAX_LOGIN_BODY_BYTES = 4096;
const MAX_LOGIN_SEND_RETRIES = 2;

const CORS_OPTS = { methods: "GET, POST, OPTIONS", headers: "Content-Type", credentials: true };

/** The account flow is a deliberate, default-off switch; production stays gated. */
export function accountsEnabled(env) {
  return env?.CITYSCROLL_ACCOUNTS_ENABLED === "true";
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function store(env) {
  return new AccountStore(env.DB);
}

function json(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function intentCookieHeader(secret, { clear = false } = {}) {
  const base = `${LOGIN_INTENT_COOKIE}=${clear ? "" : secret}; HttpOnly; Secure; SameSite=Lax; Path=/account; Domain=cityscroll.org`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=900`;
}

function readIntentCookie(req) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === LOGIN_INTENT_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

function sessionTokenFromRequest(req) {
  const values = readSessionCookies(req.headers.get("cookie") || "") || [];
  return values.find((v) => v.startsWith("v3.")) || null;
}

function loginEmailHtml(confirmUrl) {
  // Dedicated transactional sign-in template: no unsubscribe/watch enrollment.
  const safe = confirmUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return [
    "<p>Use this link to finish signing in to your CityScroll account.</p>",
    `<p><a href="${safe}">Continue to CityScroll</a></p>`,
    "<p>Open it in the same browser where you asked to sign in. The link works once and expires in 10 minutes.</p>",
    "<p>If you did not request this, you can ignore this email.</p>",
  ].join("");
}

export async function handleAccount(req, env, pathname) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, CORS_OPTS);
  if (!accountsEnabled(env)) {
    // Feature off: behave exactly as if the route did not exist.
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!env.DB?.prepare) return json({ ok: false, reason: "unavailable" }, 503, cors);

  try {
    if (pathname === "/account/v1/login" && req.method === "POST") return await handleLogin(req, env, cors);
    if (pathname === "/account/v1/confirm" && req.method === "POST") return await handleConfirm(req, env, cors);
    if (pathname === "/account/v1/me" && req.method === "GET") return await handleMe(req, env, cors);
    if (pathname === "/account/v1/logout" && req.method === "POST") return await handleLogout(req, env, cors);
  } catch (err) {
    if (err instanceof ContractError) return json({ ok: false, reason: err.reason }, err.status, cors);
    // Fail closed: a backing-service error never leaks internals and never signs anyone in.
    return json({ ok: false, reason: "unavailable" }, 503, cors);
  }
  return json({ ok: false, reason: "not-found" }, 404, cors);
}

async function handleLogin(req, env, cors) {
  // Strict Origin for the anonymous login-intent. Browsers always send Origin.
  if (origin_ok(req) === false) return json({ ok: false, reason: "origin" }, 403, cors);

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_LOGIN_BODY_BYTES) {
    return json({ ok: false, reason: "too-large" }, 413, cors);
  }
  let body = {};
  try { body = JSON.parse(raw); } catch { body = {}; }

  const email = normalizeEmail(body.email);
  // Generic 202 regardless of validity/existence, so account existence never leaks.
  if (!isValidEmail(email)) return generic202(cors);

  const turnstile = await verifySignupTurnstile(req, env, body);
  if (!turnstile.ok) return json({ ok: false, reason: turnstile.reason }, turnstile.status || 403, cors);

  const db = store(env);
  const now = nowSeconds();
  const emailHash = await sha256Hex(email);
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const rate = await db.loginRateAllowed({ emailHash, ip, now });
  if (!rate.allowed) return json({ ok: false, reason: "rate-limited" }, 429, cors);

  const intentSecret = newIntentSecret();
  const challengeToken = await db.createChallenge(email, intentSecret, now);
  const confirmUrl = `${CONFIRM_URL}#token=${encodeURIComponent(challengeToken)}`;
  const idempotencyKey = `cityscroll-login/${await sha256Hex(challengeToken)}`;

  try {
    await sendLoginMail(env, email, confirmUrl, idempotencyKey);
    await db.markDelivered(challengeToken);
  } catch (err) {
    // Provider/config failure fails closed. The raw token only ever lived in
    // request memory; the unmarked challenge simply expires and a fresh request
    // recovers. Never claim delivery from a non-acceptance.
    if (err?.deliveryStatus === "rejected") return json({ ok: false, reason: "provider" }, 503, cors);
    return json({ ok: false, reason: "provider" }, 503, cors);
  }

  return generic202(cors, intentCookieHeader(intentSecret));
}

async function sendLoginMail(env, email, confirmUrl, idempotencyKey) {
  if (!env.RESEND_API_KEY) {
    const error = new Error("mail-not-configured");
    error.deliveryStatus = "rejected";
    throw error;
  }
  // At most two attempts within the challenge window; the same idempotency key
  // makes a retry safe (the provider dedupes for ~24h).
  let lastError;
  for (let attempt = 0; attempt < MAX_LOGIN_SEND_RETRIES; attempt++) {
    try {
      return await sendTransactionalEmail(env, {
        to: email,
        subject: "Finish signing in to CityScroll",
        html: loginEmailHtml(confirmUrl),
        idempotencyKey,
      });
    } catch (err) {
      lastError = err;
      if (err?.deliveryStatus !== "indeterminate") throw err; // rejected: do not retry
    }
  }
  throw lastError;
}

async function handleConfirm(req, env, cors) {
  if (origin_ok(req) === false) return json({ ok: false, reason: "origin" }, 403, cors);
  if (!canIssueSharedSessionCookie(req.url)) return json({ ok: false, reason: "issuer" }, 400, cors);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const token = String(body.token || "");
  const intentSecret = readIntentCookie(req);
  if (!token || !intentSecret) return json({ ok: false, reason: "link-invalid-expired-or-used" }, 401, cors);

  const db = store(env);
  const now = nowSeconds();
  const owner = await db.consume(token, intentSecret, now); // throws ContractError 401 on failure
  const { token: sessionToken, csrf, expiresAt } = await db.issueSession(owner, { now, scopes: COMMON_SCOPES });

  const headers = new Headers({ ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookieHeader(sessionToken, { maxAge: SESSION_ABSOLUTE_SECONDS }));
  headers.append("Set-Cookie", intentCookieHeader("", { clear: true }));
  return new Response(
    JSON.stringify({ authenticated: true, subject: owner, scopes: COMMON_SCOPES, csrfToken: csrf, expiresAt: expiresAt * 1000 }),
    { status: 200, headers },
  );
}

async function handleMe(req, env, cors) {
  const token = sessionTokenFromRequest(req);
  if (!token) return json({ authenticated: false }, 200, cors);
  const db = store(env);
  const now = nowSeconds();
  try {
    const resolved = await db.authenticate(token, { now, audience: "civic" });
    const email = await db.principalEmail(resolved.owner);
    return json(
      {
        authenticated: true,
        subject: resolved.owner,
        maskedEmail: maskEmail(email || ""),
        scopes: resolved.scopes,
        csrfToken: await csrfTokenFor(token),
        expiresAt: resolved.expiresAt * 1000,
      },
      200,
      cors,
    );
  } catch {
    return json({ authenticated: false }, 200, cors);
  }
}

async function handleLogout(req, env, cors) {
  const token = sessionTokenFromRequest(req);
  const headers = new Headers({ ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookieHeader("", { clear: true }));
  headers.append("Set-Cookie", sessionCookieHeader("", { clear: true, domain: null }));
  if (token) {
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const db = store(env);
    const now = nowSeconds();
    if (body.allSessions === true) {
      // Signing out everywhere mutates other sessions: require a fresh, same-origin,
      // CSRF-checked common session first.
      try {
        const resolved = await db.authenticate(token, {
          csrf: req.headers.get("x-csrf-token"),
          origin: req.headers.get("origin"),
          mutation: true,
          now,
          audience: "civic",
        });
        await db.logoutAll(resolved.owner);
      } catch (err) {
        if (err instanceof ContractError) return json({ ok: false, reason: err.reason }, err.status, cors);
        throw err;
      }
    } else {
      await db.logout(token);
    }
  }
  return new Response(null, { status: 204, headers });
}

function origin_ok(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin navigations may omit Origin
  return origin === ALLOWED_ORIGIN;
}

function generic202(cors, setCookie = null) {
  const headers = new Headers({ ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(JSON.stringify({ ok: true, status: "check-your-email" }), { status: 202, headers });
}

/**
 * Introspection-only authorization for the procurement product. The product
 * service binding exposes exactly this: it never reaches login/confirm/logout or
 * any admin handler, and a failure returns only { authenticated: false }.
 */
export async function authorizeIdentity(env, { cookie, csrfToken, origin, method, audience = "procurement" } = {}) {
  if (!accountsEnabled(env) || !env.DB?.prepare) return { authenticated: false };
  const values = readSessionCookies(cookie || "") || [];
  const token = values.find((v) => v.startsWith("v3.")) || null;
  if (!token) return { authenticated: false };
  return authorizeForProduct(store(env), { token, csrfToken, origin, method, now: nowSeconds(), audience });
}
