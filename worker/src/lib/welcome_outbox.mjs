// One-welcome-per-recipient claim ledger. The D1 row keyed by the recipient's
// address digest is the only welcome gate: enrollment never decides "should we
// send" from a KV read-then-write, so repeated or concurrent requests through
// any channel (web, inbound email, MCP, monitor packs) produce at most one
// welcome delivery. Retries after a provider failure re-claim the SAME row with
// the SAME idempotency key, so the provider's dedupe window backs the ledger.
//
// State machine: in-flight → accepted | rejected | indeterminate. Rejected and
// indeterminate rows may be re-claimed until retry_until (the provider idempotency
// window minus a safety margin); afterwards the row is durable evidence and no
// further send is attempted. 'suppressed' and 'preexisting' are terminal states
// written without any provider call.

import { normalizeEmail } from "./subscriptions.mjs";
import { recipientHash } from "./recipient_suppression.mjs";

const CLAIM_TTL_MS = 60 * 1000;
const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_SAFETY_MARGIN_MS = 15 * 60 * 1000;
const RETRY_WINDOW_MS = IDEMPOTENCY_MS - IDEMPOTENCY_SAFETY_MARGIN_MS;

const SELECT = `SELECT recipient_hash, idempotency_key, state, claim_token, claim_expires_at,
  first_attempted_at, last_attempted_at, retry_until, attempt_count, resolved_at,
  provider_id, error_reason, provenance FROM ops_welcome_deliveries WHERE recipient_hash = ?`;

function token() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

/** Stable per-recipient provider idempotency key: identical across every retry. */
export async function welcomeIdempotencyKey(email) {
  return `welcome:${await recipientHash(email)}`;
}

async function read(db, hash) {
  return db.prepare(SELECT).bind(hash).first();
}

function boundedRetryUntil(firstAttemptedAt) {
  const first = Date.parse(firstAttemptedAt || "");
  if (!Number.isFinite(first)) return null;
  return new Date(first + RETRY_WINDOW_MS).toISOString();
}

/**
 * Atomically claim the right to send this recipient's one welcome. Returns
 * { ok, owned, claimToken, idempotencyKey, row }. owned === true means the
 * caller holds the claim and MUST complete it (completeWelcomeDelivery) after
 * the provider attempt. owned === false means a welcome was already sent, is
 * in flight, or is durably closed — send nothing.
 */
export async function claimWelcomeDelivery(db, { email, now = new Date() } = {}) {
  if (!db?.prepare) return { ok: false, reason: "welcome-ledger-unavailable", owned: false, row: null };
  const hash = await recipientHash(email);
  const idempotencyKey = `welcome:${hash}`;
  const claimToken = token();
  const at = now.toISOString();
  const retryUntil = boundedRetryUntil(at);
  const expires = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  try {
    let result = await db.prepare(`INSERT INTO ops_welcome_deliveries
        (recipient_hash, idempotency_key, state, claim_token, claim_expires_at,
         first_attempted_at, last_attempted_at, retry_until, attempt_count)
      VALUES (?, ?, 'in-flight', ?, ?, ?, ?, ?, 1)
      ON CONFLICT(recipient_hash) DO NOTHING`)
      .bind(hash, idempotencyKey, claimToken, expires, at, at, retryUntil)
      .run();
    if (changes(result) > 0) {
      return { ok: true, owned: true, claimToken, idempotencyKey, row: await read(db, hash) };
    }
    const existing = await read(db, hash);
    if (!existing) return { ok: false, reason: "welcome-ledger-read-failed", owned: false, row: null };
    // Terminal states never send again.
    if (["accepted", "suppressed", "preexisting"].includes(existing.state)) {
      return { ok: true, owned: false, idempotencyKey, row: existing };
    }
    // The provider dedupe window is gone: the durable state stands, no resend.
    if (Date.parse(existing.retry_until || "") <= now.getTime()) {
      return { ok: true, owned: false, idempotencyKey, row: existing };
    }
    // Re-claim a rejected row, an indeterminate row, or an abandoned in-flight
    // claim. The conditional WHERE makes exactly one concurrent claimant win.
    const existingClaimExpiry = Date.parse(existing.claim_expires_at || "");
    const claimable = existing.state === "rejected"
      || existing.state === "indeterminate"
      || !Number.isFinite(existingClaimExpiry)
      || existingClaimExpiry <= now.getTime();
    if (!claimable) {
      return { ok: true, owned: false, idempotencyKey, row: existing };
    }
    result = await db.prepare(`UPDATE ops_welcome_deliveries
        SET state = 'in-flight', claim_token = ?, claim_expires_at = ?, last_attempted_at = ?,
            attempt_count = attempt_count + 1, resolved_at = NULL, provider_id = NULL, error_reason = NULL
      WHERE recipient_hash = ? AND state = ? AND retry_until > ?
        AND (state IN ('rejected', 'indeterminate') OR claim_expires_at IS NULL OR claim_expires_at <= ?)
        AND (claim_token IS ?)`)
      .bind(claimToken, expires, at, hash, existing.state, at, at, existing.claim_token)
      .run();
    const row = await read(db, hash);
    return {
      ok: Boolean(row),
      reason: row ? null : "welcome-ledger-read-failed",
      owned: changes(result) > 0 && row?.claim_token === claimToken,
      claimToken,
      idempotencyKey,
      row,
    };
  } catch (error) {
    return { ok: false, reason: "welcome-ledger-unavailable", detail: String(error?.message || error), owned: false, row: null };
  }
}

/** Complete an owned claim. Only the row's current claim_token may resolve it. */
export async function completeWelcomeDelivery(db, { email, claimToken, state, now = new Date(), providerId = null, errorReason = null } = {}) {
  if (!db?.prepare || !["accepted", "rejected", "indeterminate", "suppressed"].includes(state)) {
    return { ok: false, row: null };
  }
  const hash = await recipientHash(email);
  const at = now.toISOString();
  try {
    await db.prepare(`UPDATE ops_welcome_deliveries
        SET state = ?, claim_token = NULL, claim_expires_at = NULL, resolved_at = ?,
            provider_id = ?, error_reason = ?
      WHERE recipient_hash = ? AND state = 'in-flight' AND claim_token = ?`)
      .bind(state, state === "indeterminate" ? null : at, providerId, errorReason, hash, claimToken)
      .run();
    const row = await read(db, hash);
    return { ok: Boolean(row), row };
  } catch {
    return { ok: false, row: null };
  }
}

/**
 * Record that a known-suppressed recipient's welcome was never attempted.
 * Idempotent: an existing row of any state is authoritative and untouched.
 */
export async function markWelcomeSuppressed(db, { email, reason = null, now = new Date() } = {}) {
  if (!db?.prepare) return false;
  const hash = await recipientHash(email);
  try {
    const result = await db.prepare(`INSERT INTO ops_welcome_deliveries
        (recipient_hash, idempotency_key, state, attempt_count, resolved_at, error_reason, provenance)
      VALUES (?, ?, 'suppressed', 0, ?, ?, 'provider-suppression')
      ON CONFLICT(recipient_hash) DO NOTHING`)
      .bind(hash, `welcome:${hash}`, now.toISOString(), String(reason || "suppressed").slice(0, 200))
      .run();
    return changes(result) >= 0;
  } catch {
    return false;
  }
}

/**
 * Fold the pre-ledger roster into the claim table so existing subscribers never
 * receive a welcome after the ledger ships. Records 'preexisting' rows only —
 * this function has no provider access and sends no mail by construction.
 * mode "dry-run" reports counts without writing.
 */
export async function migrateExistingRosterWelcomeClaims(db, emails, {
  mode = "dry-run",
  now = new Date(),
} = {}) {
  const receipt = {
    schema: "cityscroll.welcome-roster-migration.v1",
    mode: mode === "apply" ? "apply" : "dry-run",
    considered: 0,
    already_recorded: 0,
    recorded: 0,
    invalid: 0,
    applied: false,
    at: now.toISOString(),
  };
  if (!db?.prepare) return { ...receipt, status: "welcome-ledger-unavailable" };
  for (const raw of Array.isArray(emails) ? emails : []) {
    const email = normalizeEmail(raw);
    if (!email || !email.includes("@")) { receipt.invalid += 1; continue; }
    receipt.considered += 1;
    const hash = await recipientHash(email);
    try {
      const existing = await read(db, hash);
      if (existing) { receipt.already_recorded += 1; continue; }
      if (receipt.mode === "apply") {
        await db.prepare(`INSERT INTO ops_welcome_deliveries
            (recipient_hash, idempotency_key, state, attempt_count, resolved_at, provenance)
          VALUES (?, ?, 'preexisting', 0, ?, 'roster-migration')
          ON CONFLICT(recipient_hash) DO NOTHING`)
          .bind(hash, `welcome:${hash}`, receipt.at)
          .run();
      }
      receipt.recorded += 1;
    } catch (error) {
      return { ...receipt, status: "welcome-ledger-failed", error: String(error?.message || error).slice(0, 200) };
    }
  }
  receipt.applied = receipt.mode === "apply";
  return receipt;
}
