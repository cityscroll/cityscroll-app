// Common CityScroll account: engine-side identity and revocable sessions.
//
// A principal is one verified email, normalized with lib/subscriptions.mjs
// normalizeEmail and mapped to the engine's opaque actor id (lib/meter.mjs
// opaqueActorId). A session is server-side and revocable: only the hash of the
// opaque cookie token is stored, so a database read never recovers a live cookie.
//
// This module is the single identity authority. It grants civic + procurement
// *consumer* scopes only. It creates no supplier, legal entity, or password, and
// copies no private product content. Legacy pins-scoped signed sessions are a
// separate, narrower authority (see lib/session.mjs) and never enter this store.
//
// Ported from the accepted offline contract proof: time is handled in whole
// seconds here (the HTTP adapter converts epoch milliseconds at the boundary),
// matching the frozen reference semantics.

import { normalizeEmail } from "./subscriptions.mjs";
import { opaqueActorId } from "./meter.mjs";

export const SESSION_ABSOLUTE_SECONDS = 14 * 24 * 3600; // 14-day absolute lifetime
export const SESSION_INACTIVITY_SECONDS = 7 * 24 * 3600; // 7-day inactivity window
export const CHALLENGE_TTL_SECONDS = 600; // one-use login link valid 10 minutes
export const CSRF_SALT = "cityscroll-csrf:";

// Common account scopes. A legacy pins token authorizes civic reads only and can
// never be reinterpreted as procurement authority.
export const COMMON_SCOPES = Object.freeze(["civic", "procurement"]);
export const CIVIC_ONLY_SCOPES = Object.freeze(["civic"]);
export const AUDIENCES = Object.freeze(["civic", "procurement"]);

// Opaque session cookie format: a v3 prefix lets civic readers distinguish a
// DB-backed common session from a legacy signed pins token by inspection alone.
export const SESSION_TOKEN_PREFIX = "v3.";

/** Structured contract failure. `status` is the HTTP status; `reason` is a stable slug. */
export class ContractError extends Error {
  constructor(status, reason) {
    super(reason);
    this.name = "ContractError";
    this.status = status;
    this.reason = reason;
  }
}

function require(ok, status, reason) {
  if (!ok) throw new ContractError(status, reason);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafe(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical JSON: recursively sorted object keys, preserved array order, UTF-8,
 * no non-finite numbers. Used for scope serialization and any stable hashing.
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ContractError(400, "nonfinite-number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
}

/** A new opaque session cookie value (256-bit), carrying the v3 prefix. */
export function newSessionToken() {
  return SESSION_TOKEN_PREFIX + randomUrlSafe(32);
}

/** A new one-use login link token (256-bit). */
export function newChallengeToken() {
  return randomUrlSafe(32);
}

/** A new same-browser login-intent secret (256-bit). */
export function newIntentSecret() {
  return randomUrlSafe(32);
}

/** True when a cookie value is shaped like a v3 common-session token. */
export function isCommonSessionToken(value) {
  return typeof value === "string" && value.startsWith(SESSION_TOKEN_PREFIX);
}

/**
 * The per-session CSRF token returned to an authenticated same-origin browser.
 * Deterministic from the raw session token, so it is reproducible after a reload
 * without rotation. The session row stores only the hash of this value.
 */
export function csrfTokenFor(rawToken) {
  return sha256Hex(CSRF_SALT + String(rawToken));
}

/** The opaque owner id for a verified email ("a:" + sha256(normalized email)). */
export function ownerForEmail(email) {
  return opaqueActorId(normalizeEmail(email));
}

/** Mask an email for display: keep first char of the local part and the domain. */
export function maskEmail(email) {
  const e = normalizeEmail(email);
  const at = e.indexOf("@");
  if (at <= 0) return "";
  const local = e.slice(0, at);
  const domain = e.slice(at);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
}

function floorDiv(n, d) {
  return Math.floor(n / d);
}

// Rate-limit buckets: 3 login sends/hour and 10/day per normalized-email hash,
// 20/day per IP, and a global cap of 20 new login sends/day.
const RATE_LIMITS = [
  { bucket: "email-hour", window: 3600, max: 3 },
  { bucket: "email-day", window: 86400, max: 10 },
  { bucket: "ip-day", window: 86400, max: 20 },
  { bucket: "global-day", window: 86400, max: 20 },
];

/**
 * Engine identity store over a D1-like async database (prepare/bind/run/first/all).
 * Methods throw ContractError on contract violations, mirroring the accepted proof.
 */
export class AccountStore {
  constructor(db) {
    this.db = db;
  }

  async createPrincipal(email, now) {
    const normalized = normalizeEmail(email);
    const owner = await ownerForEmail(normalized);
    await this.db
      .prepare("INSERT OR IGNORE INTO cityscroll_principals(owner, email, created_at) VALUES(?,?,?)")
      .bind(owner, normalized, now)
      .run();
    return owner;
  }

  async principalEmail(owner) {
    const row = await this.db
      .prepare("SELECT email FROM cityscroll_principals WHERE owner=?")
      .bind(owner)
      .first();
    return row?.email || null;
  }

  /** Issue a server-side session. Returns the raw cookie token and the CSRF token. */
  async issueSession(owner, { now, scopes = COMMON_SCOPES } = {}) {
    const token = newSessionToken();
    const csrf = await csrfTokenFor(token);
    await this.db
      .prepare(
        "INSERT INTO cityscroll_sessions(token_hash, owner, csrf_hash, issued_at, expires_at, last_seen, revoked, scopes) VALUES(?,?,?,?,?,?,0,?)",
      )
      .bind(
        await sha256Hex(token),
        owner,
        await sha256Hex(csrf),
        now,
        now + SESSION_ABSOLUTE_SECONDS,
        now,
        canonicalJSON([...scopes]),
      )
      .run();
    return { token, csrf, expiresAt: now + SESSION_ABSOLUTE_SECONDS };
  }

  /**
   * Validate a session for an audience. Throws ContractError otherwise. Every call
   * reads the database and the revoked flag — there is no per-request cache. On a
   * mutation, a matching Origin and CSRF token are also required.
   */
  async authenticate(token, { csrf = null, origin = null, mutation = false, now, audience = "procurement" } = {}) {
    const row = await this.db
      .prepare("SELECT * FROM cityscroll_sessions WHERE token_hash=?")
      .bind(await sha256Hex(token))
      .first();
    require(
      row != null && !row.revoked && now < row.expires_at && now - row.last_seen < SESSION_INACTIVITY_SECONDS,
      401,
      "sign-in-required",
    );
    let scopes;
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      scopes = [];
    }
    require(Array.isArray(scopes) && scopes.includes(audience), 403, "fresh-common-sign-in-required");
    if (mutation) {
      require(
        origin === "https://cityscroll.org" && !!csrf && (await sha256Hex(csrf)) === row.csrf_hash,
        403,
        "csrf",
      );
    }
    await this.db
      .prepare("UPDATE cityscroll_sessions SET last_seen=? WHERE token_hash=?")
      .bind(now, await sha256Hex(token))
      .run();
    return { owner: row.owner, scopes, expiresAt: row.expires_at, csrfHash: row.csrf_hash };
  }

  /** Revoke a single session. Idempotent. */
  async logout(token) {
    await this.db
      .prepare("UPDATE cityscroll_sessions SET revoked=1 WHERE token_hash=?")
      .bind(await sha256Hex(token))
      .run();
  }

  /** Revoke every session for an owner (explicit "sign out everywhere"). */
  async logoutAll(owner) {
    await this.db
      .prepare("UPDATE cityscroll_sessions SET revoked=1 WHERE owner=? AND revoked=0")
      .bind(owner)
      .run();
  }

  /**
   * Resolve a verified email for a civic reader from a v3 session token, or null.
   * Never throws; a legacy pins token (no v3 prefix) is left to the caller's
   * signed-token fallback.
   */
  async resolveCivicEmail(token, now) {
    if (!isCommonSessionToken(token)) return null;
    try {
      const resolved = await this.authenticate(token, { now, audience: "civic" });
      return await this.principalEmail(resolved.owner);
    } catch {
      return null;
    }
  }

  /** Create a one-use login challenge bound to the same-browser intent secret. */
  async createChallenge(email, intentSecret, now) {
    const token = newChallengeToken();
    await this.db
      .prepare(
        "INSERT INTO cityscroll_login_challenges(token_hash, email, intent_hash, expires_at, delivered, consumed_at) VALUES(?,?,?,?,0,NULL)",
      )
      .bind(await sha256Hex(token), normalizeEmail(email), await sha256Hex(intentSecret), now + CHALLENGE_TTL_SECONDS)
      .run();
    return token;
  }

  /** Mark a challenge as delivered only after the provider accepts it. */
  async markDelivered(token) {
    await this.db
      .prepare("UPDATE cityscroll_login_challenges SET delivered=1 WHERE token_hash=?")
      .bind(await sha256Hex(token))
      .run();
  }

  /**
   * Atomically consume a delivered, unexpired, same-intent, never-used challenge.
   * A second use, a GET-only (undelivered) link, a wrong intent, or an expired link
   * all fail closed. Returns the owner and creates the principal on first login.
   */
  async consume(token, intentSecret, now) {
    const row = await this.db
      .prepare(
        "UPDATE cityscroll_login_challenges SET consumed_at=? WHERE token_hash=? AND intent_hash=? AND delivered=1 AND expires_at>? AND consumed_at IS NULL RETURNING email",
      )
      .bind(now, await sha256Hex(token), await sha256Hex(intentSecret), now)
      .first();
    require(row != null, 401, "link-invalid-expired-or-used");
    return this.createPrincipal(row.email, now);
  }

  /**
   * Record a login-send attempt against every rate bucket and report whether it is
   * within limits. Buckets are atomic per-window counters; exceeding any one fails
   * the request (the caller returns a generic 429 without revealing which bucket).
   */
  async loginRateAllowed({ emailHash, ip, now }) {
    let allowed = true;
    const subjects = {
      "email-hour": emailHash,
      "email-day": emailHash,
      "ip-day": ip ? await sha256Hex(ip) : null,
      "global-day": "all",
    };
    for (const limit of RATE_LIMITS) {
      const subject = subjects[limit.bucket];
      if (subject == null) continue;
      const windowStart = floorDiv(now, limit.window) * limit.window;
      const row = await this.db
        .prepare(
          "INSERT INTO cityscroll_auth_counters(bucket, subject_hash, window_start, count) VALUES(?,?,?,1) " +
            "ON CONFLICT(bucket, subject_hash, window_start) DO UPDATE SET count=count+1 RETURNING count",
        )
        .bind(limit.bucket, subject, windowStart)
        .first();
      if ((row?.count ?? 0) > limit.max) allowed = false;
    }
    return { allowed };
  }

  /** Prune expired challenges, old revoked/expired sessions, and stale counters. */
  async prune(now) {
    await this.db
      .prepare("DELETE FROM cityscroll_login_challenges WHERE expires_at < ?")
      .bind(now - 24 * 3600)
      .run();
    await this.db
      .prepare("DELETE FROM cityscroll_sessions WHERE (revoked=1 OR expires_at < ?)")
      .bind(now - 30 * 24 * 3600)
      .run();
    await this.db
      .prepare("DELETE FROM cityscroll_auth_counters WHERE window_start < ?")
      .bind(now - 48 * 3600)
      .run();
  }
}

/**
 * Introspection-only authorization for the procurement product. Never throws and
 * never returns an email or session secret: on any failure it reports only
 * `authenticated: false`. This is the sole surface the product service binding uses.
 */
export async function authorizeForProduct(store, { token, csrfToken = null, origin = null, method = "GET", now, audience = "procurement" } = {}) {
  const mutation = String(method || "GET").toUpperCase() !== "GET";
  try {
    const resolved = await store.authenticate(token, { csrf: csrfToken, origin, mutation, now, audience });
    return {
      authenticated: true,
      subject: resolved.owner,
      csrfToken: await csrfTokenFor(token),
      expiresAt: resolved.expiresAt,
    };
  } catch {
    return { authenticated: false };
  }
}
