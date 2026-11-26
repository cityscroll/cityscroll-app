// Enrollment abuse instrumentation (worker/migrations/0039). Every signup
// decision — on /subscribe, /subscribe-pack, the shared account sign-in, and any
// product-intake consumer that routes through the same boundary — records a
// bounded private receipt and feeds two protections:
//
//   1. Per-route accepted-volume ceiling and a transactional-mail budget. When a
//      route crosses its ceiling (or the mail budget is exhausted) the route is
//      placed under temporary containment with an explicit expiry, and an
//      operational alert is raised through the repository's ops alert routing.
//   2. An inline containment gate the enrollment boundary consults before
//      accepting a request, so distributed synthetic traffic — many actors, one
//      route — is contained even though no single actor trips the per-actor rate
//      limit. Containment self-expires and never bans an address or a network.
//
// Privacy: the receipt is keyed by a rotating pseudonymous key (HMAC of the actor
// under a per-window salt from the server secret). No raw IP, no address, and no
// stable identifier is stored, and only counts and buckets leave the worker.

// Declared ceilings. Production-sensible defaults; override per environment. The
// operator tunes ENROLLMENT_ACCEPTED_BUDGET and TRANSACTIONAL_MAIL_BUDGET from the
// observed baseline (see the runbook); these are starting points, not policy.
export const DEFAULT_ENROLLMENT_ACCEPTED_BUDGET = 150; // accepted signups / route / rotation window
export const DEFAULT_TRANSACTIONAL_MAIL_BUDGET = 300;  // welcome sends / rotation window (all routes)
export const DEFAULT_CONTAINMENT_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CONTAINMENT_ALL_ROUTES = "*all*";

const ROUTE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

function intEnv(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function enrollmentAcceptedBudget(env) {
  return intEnv(env, "ENROLLMENT_ACCEPTED_BUDGET", DEFAULT_ENROLLMENT_ACCEPTED_BUDGET);
}
export function transactionalMailBudget(env) {
  return intEnv(env, "TRANSACTIONAL_MAIL_BUDGET", DEFAULT_TRANSACTIONAL_MAIL_BUDGET);
}
export function containmentTtlMs(env) {
  return intEnv(env, "ENROLLMENT_CONTAINMENT_TTL_MS", DEFAULT_CONTAINMENT_TTL_MS);
}

function rotationWindow(now) {
  return new Date(now).toISOString().slice(0, 10); // UTC day
}
function timeBucket(now) {
  return new Date(now).toISOString().slice(0, 13); // UTC hour
}
function normalizeRoute(route) {
  const value = String(route || "").trim().toLowerCase();
  return ROUTE_RE.test(value) ? value : "unknown";
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(message) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A rotating pseudonymous key for one actor (IP string or address). It is an HMAC
 * under a per-window salt, truncated to 128 bits: the same actor maps to one key
 * within a rotation window and to a different, uncorrelatable key in the next, and
 * the key cannot be reversed to the actor without the server secret. A missing
 * actor yields a non-identifying window bucket; a missing secret degrades to a
 * plain per-window digest (only reached in an unconfigured local deploy).
 */
export async function rotatingActorKey(env, actor, now = new Date()) {
  const window = rotationWindow(now);
  const normalized = String(actor || "").trim().toLowerCase();
  if (!normalized) return `k:anon:${window}`;
  const secret = env?.SIGNUP_RECEIPT_SECRET || env?.TOKEN_SECRET || "";
  const digest = secret
    ? await hmacHex(secret, `${window}:${normalized}`)
    : await sha256Hex(`${window}:${normalized}`);
  return `k:${digest.slice(0, 32)}`;
}

/**
 * Record one bounded signup-decision receipt. Degrades silently without a DB
 * binding so instrumentation never breaks signup. Old receipts are pruned to the
 * retention window on each write, keeping the store bounded.
 */
export async function recordSignupDecision(env, {
  route, actor, challenge = "unknown", rateDecision = "allowed",
  accepted = false, welcomeOutcome = null, now = new Date(),
} = {}) {
  const db = env?.DB;
  if (!db?.prepare) return { ok: false, reason: "db-unavailable" };
  const normalizedRoute = normalizeRoute(route);
  const bucket = timeBucket(now);
  const window = rotationWindow(now);
  try {
    const pseudoKey = await rotatingActorKey(env, actor, now);
    await db.prepare(`INSERT INTO signup_decision_receipts
        (pseudo_key, route, bucket, rotation_window, challenge, rate_decision, accepted, welcome_outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(pseudoKey, normalizedRoute, bucket, window,
        String(challenge).slice(0, 40), String(rateDecision).slice(0, 40),
        accepted ? 1 : 0, welcomeOutcome ? String(welcomeOutcome).slice(0, 40) : null,
        now.toISOString())
      .run();
    const cutoff = new Date(now.getTime() - DEFAULT_RECEIPT_RETENTION_MS).toISOString();
    await db.prepare(`DELETE FROM signup_decision_receipts WHERE created_at < ?`).bind(cutoff).run();
    return { ok: true, route: normalizedRoute, bucket, rotation_window: window };
  } catch (error) {
    return { ok: false, reason: "receipt-write-failed", detail: String(error?.message || error).slice(0, 200) };
  }
}

async function activeContainmentRow(db, route, now) {
  const row = await db.prepare(`SELECT route, armed_at, expires_at, reason, rotation_window, observed_count, budget
    FROM enrollment_containment WHERE route = ?`).bind(route).first();
  if (!row) return null;
  if (Date.parse(row.expires_at || "") <= now.getTime()) return null;
  return row;
}

/**
 * Is this route currently contained? Checks the route itself and the global
 * all-routes sentinel (armed by a transactional-mail-budget breach). Returns the
 * active containment row (count/budget/expiry — no actor data) or null.
 */
export async function routeContainmentActive(env, route, now = new Date()) {
  const db = env?.DB;
  if (!db?.prepare) return null;
  const normalizedRoute = normalizeRoute(route);
  try {
    return (await activeContainmentRow(db, normalizedRoute, now))
      || (await activeContainmentRow(db, CONTAINMENT_ALL_ROUTES, now));
  } catch {
    return null;
  }
}

async function armContainment(db, { route, reason, window, observedCount, budget, ttlMs, now }) {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  await db.prepare(`INSERT INTO enrollment_containment
      (route, armed_at, expires_at, reason, rotation_window, observed_count, budget)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(route) DO UPDATE SET
      armed_at = excluded.armed_at, expires_at = excluded.expires_at, reason = excluded.reason,
      rotation_window = excluded.rotation_window, observed_count = excluded.observed_count,
      budget = excluded.budget`)
    .bind(route, now.toISOString(), expiresAt, reason, window, observedCount, budget)
    .run();
  return { route, armed_at: now.toISOString(), expires_at: expiresAt, reason, observed_count: observedCount, budget };
}

/** Inject point for the ops alert emitter, so tests capture inputs without the watchdog graph. */
async function defaultEmitOpsAlert(env, input) {
  const { emitOpsAlertOnce } = await import("../reliability_watchdogs.mjs");
  return emitOpsAlertOnce(env, input);
}

/**
 * The enrollment boundary's pre-accept gate. When the route is contained, records
 * a contained decision receipt and returns { contained: true, containment }. The
 * caller then refuses the request (a bounded, retryable refusal — never a ban).
 */
export async function enrollmentContainmentGate(env, { route, actor, challenge = "verified", now = new Date() } = {}) {
  const containment = await routeContainmentActive(env, route, now);
  if (!containment) return { contained: false };
  await recordSignupDecision(env, {
    route, actor, challenge, rateDecision: "contained", accepted: false, now,
  });
  return {
    contained: true,
    containment: {
      route: containment.route,
      expires_at: containment.expires_at,
      reason: containment.reason,
      observed_count: containment.observed_count,
      budget: containment.budget,
    },
  };
}

/**
 * Observe an accepted enrollment: record the decision, then evaluate the route's
 * accepted volume and the transactional-mail budget for the window. Crossing a
 * ceiling arms temporary containment (durable) and raises a desk-routed ops alert
 * (best-effort). Returns a counts-only summary; never throws into the signup path.
 */
export async function observeAcceptedEnrollment(env, {
  route, actor, challenge = "verified", rateDecision = "allowed", welcomeOutcome = null, now = new Date(),
} = {}, { emitAlert = defaultEmitOpsAlert } = {}) {
  const normalizedRoute = normalizeRoute(route);
  const window = rotationWindow(now);
  const summary = {
    route: normalizedRoute, rotation_window: window,
    route_count: 0, route_budget: enrollmentAcceptedBudget(env), route_over: false,
    mail_count: 0, mail_budget: transactionalMailBudget(env), mail_over: false,
    contained: [],
  };
  await recordSignupDecision(env, {
    route: normalizedRoute, actor, challenge, rateDecision, accepted: true, welcomeOutcome, now,
  });
  const db = env?.DB;
  if (!db?.prepare) return summary;
  const ttlMs = containmentTtlMs(env);
  try {
    const routeRow = await db.prepare(`SELECT COUNT(*) AS n FROM signup_decision_receipts
      WHERE route = ? AND rotation_window = ? AND accepted = 1`).bind(normalizedRoute, window).first();
    summary.route_count = Number(routeRow?.n) || 0;
    const mailRow = await db.prepare(`SELECT COUNT(*) AS n FROM signup_decision_receipts
      WHERE rotation_window = ? AND welcome_outcome = 'sent'`).bind(window).first();
    summary.mail_count = Number(mailRow?.n) || 0;

    if (summary.route_count >= summary.route_budget) {
      summary.route_over = true;
      const containment = await armContainment(db, {
        route: normalizedRoute, reason: "accepted-volume-over-budget", window,
        observedCount: summary.route_count, budget: summary.route_budget, ttlMs, now,
      });
      summary.contained.push(containment);
      await safeAlert(emitAlert, env, {
        guard: "enrollment-accepted-volume",
        stage: normalizedRoute,
        fingerprint: `enrollment-accepted-volume:${normalizedRoute}:${window}`,
        subject: `CityScroll enrollment accepted-volume ceiling reached: ${normalizedRoute}`,
        findings: [`accepted signups on route ${normalizedRoute} reached ${summary.route_count} in window ${window} (ceiling ${summary.route_budget}); route placed under temporary containment until ${containment.expires_at}`],
        first_seen: now.toISOString(),
        last_seen: now.toISOString(),
        now,
      });
    }
    if (summary.mail_count >= summary.mail_budget) {
      summary.mail_over = true;
      const containment = await armContainment(db, {
        route: CONTAINMENT_ALL_ROUTES, reason: "transactional-mail-budget-exhausted", window,
        observedCount: summary.mail_count, budget: summary.mail_budget, ttlMs, now,
      });
      summary.contained.push(containment);
      await safeAlert(emitAlert, env, {
        guard: "transactional-mail-budget",
        stage: "welcome-mail",
        fingerprint: `transactional-mail-budget:${window}`,
        subject: "CityScroll transactional-mail budget exhausted",
        findings: [`welcome sends reached ${summary.mail_count} in window ${window} (budget ${summary.mail_budget}); all enrollment routes placed under temporary containment until ${containment.expires_at}`],
        first_seen: now.toISOString(),
        last_seen: now.toISOString(),
        now,
      });
    }
  } catch {
    // Instrumentation is best-effort; a counting or alert failure never breaks signup.
  }
  return summary;
}

async function safeAlert(emitAlert, env, input) {
  try { await emitAlert(env, input); } catch { /* alert is best-effort */ }
}
