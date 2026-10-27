// Recipient-level provider suppression: the durable record of addresses the mail
// provider refuses to deliver to, and the reconciliation that keeps that record
// current. Send boundaries call suppressionForRecipient() before any subscriber
// mail; reconcileRecipientSuppressions() folds a complete provider suppression
// export into recipient_suppressions with an idempotent dry-run/apply receipt.
//
// Privacy: recipient identities are sha256 hex digests of the normalized address.
// Receipts carry counts only — never addresses — so they are safe for shared logs.

import { isValidEmail, normalizeEmail } from "./subscriptions.mjs";

export const SUPPRESSION_PROVENANCE_PROVIDER = "provider-suppression-list";

const SELECT_ONE = `SELECT recipient_hash, reason, provenance, suppressed_at, first_seen_at,
  lifted_at, reconciliation_id FROM recipient_suppressions WHERE recipient_hash = ?`;
const SELECT_ALL_BY_PROVENANCE = `SELECT recipient_hash, reason, provenance, suppressed_at,
  first_seen_at, lifted_at, reconciliation_id FROM recipient_suppressions WHERE provenance = ?`;
const SELECT_STATE = `SELECT id, last_authority, last_reconciliation_id, applied_at
  FROM recipient_suppression_state WHERE id = 1`;

export async function recipientHash(email) {
  const data = new TextEncoder().encode(normalizeEmail(email));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize one provider suppression entry; null when the entry is unusable. */
export function normalizeSuppressionEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const email = normalizeEmail(raw.email ?? raw.recipient ?? raw.address);
  if (!isValidEmail(email)) return null;
  const reason = String(raw.reason || raw.cause || "suppressed").trim().slice(0, 200) || "suppressed";
  const suppressedAt = Date.parse(raw.suppressed_at ?? raw.created_at ?? raw.updated_at ?? "");
  return {
    email,
    reason,
    suppressed_at: Number.isFinite(suppressedAt) ? new Date(suppressedAt).toISOString() : null,
  };
}

/**
 * The active suppression row for one address, or null. A missing binding or a
 * read failure degrades to null (send proceeds) — the caller that cannot
 * tolerate an unknown answer (the welcome claim) fails closed on its own D1
 * write and never reaches the provider.
 */
export async function suppressionForRecipient(db, email) {
  if (!db?.prepare || !email) return null;
  try {
    const row = await db.prepare(SELECT_ONE).bind(await recipientHash(email)).first();
    if (!row || row.lifted_at) return null;
    return {
      reason: row.reason,
      provenance: row.provenance,
      suppressed_at: row.suppressed_at || null,
      first_seen_at: row.first_seen_at,
    };
  } catch {
    return null;
  }
}

async function readAuthorityState(db) {
  try {
    return await db.prepare(SELECT_STATE).bind().first();
  } catch {
    return null;
  }
}

async function digestHex(value) {
  const data = new TextEncoder().encode(String(value));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reconcile a COMPLETE provider suppression export into recipient_suppressions.
 *
 * - providerPages: an async iterable (or array) of pages, each `{ entries: [...] }`.
 *   Iteration must cover the entire list; any page failure aborts the run with
 *   status "provider-error" and apply performs no writes (all-or-nothing).
 * - authority: the provider snapshot's monotonic token (an ISO timestamp or
 *   cursor). An authority older than the last applied one is refused as
 *   "stale-authority"; the same authority carrying different content is refused
 *   as "authority-conflict"; an identical re-run is an idempotent no-op.
 * - Existing rows from other provenance are preserved untouched; provider rows
 *   absent from the new snapshot are stamped lifted_at, never deleted.
 *
 * The receipt is deterministic for a given (authority, content) pair, so a
 * repeated reconciliation returns the same reconciliation_id.
 */
export async function reconcileRecipientSuppressions(db, providerPages, {
  mode = "dry-run",
  authority = null,
  provenance = SUPPRESSION_PROVENANCE_PROVIDER,
  now = new Date(),
} = {}) {
  const at = now.toISOString();
  const receipt = {
    schema: "cityscroll.recipient-suppression-reconciliation.v1",
    reconciliation_id: null,
    mode: mode === "apply" ? "apply" : "dry-run",
    authority: authority ? String(authority) : null,
    status: "ok",
    pages_read: 0,
    fetched: 0,
    invalid: 0,
    added: 0,
    updated: 0,
    reinstated: 0,
    unchanged: 0,
    lifted: 0,
    preserved: 0,
    applied: false,
    at,
  };
  if (!db?.prepare) return { ...receipt, status: "db-unavailable" };
  if (!receipt.authority) return { ...receipt, status: "authority-required" };

  // 1. Collect the entire export first — a partial provider read never applies.
  const normalized = new Map();
  try {
    for await (const page of providerPages || []) {
      const entries = Array.isArray(page?.entries) ? page.entries : [];
      for (const raw of entries) {
        receipt.fetched += 1;
        const entry = normalizeSuppressionEntry(raw);
        if (!entry) { receipt.invalid += 1; continue; }
        normalized.set(await recipientHash(entry.email), entry);
      }
      receipt.pages_read += 1;
    }
  } catch (error) {
    return { ...receipt, status: "provider-error", error: String(error?.message || error).slice(0, 200) };
  }

  const contentHash = await digestHex([...normalized.keys()].sort().join("\n"));
  receipt.reconciliation_id = `recon:${(await digestHex(`${receipt.authority}\n${contentHash}`)).slice(0, 16)}`;

  // 2. Authority ordering: refuse to regress or to reinterpret a seen epoch.
  const state = await readAuthorityState(db);
  if (state?.last_authority) {
    if (receipt.authority < state.last_authority) {
      return { ...receipt, status: "stale-authority", last_authority: state.last_authority };
    }
    if (receipt.authority === state.last_authority
      && state.last_reconciliation_id !== receipt.reconciliation_id) {
      return { ...receipt, status: "authority-conflict", last_authority: state.last_authority };
    }
  }

  // 3. Diff against the current durable record.
  let existingRows = [];
  try {
    const result = await db.prepare(SELECT_ALL_BY_PROVENANCE).bind(provenance).all();
    existingRows = Array.isArray(result?.results) ? result.results : [];
  } catch (error) {
    return { ...receipt, status: "db-read-failed", error: String(error?.message || error).slice(0, 200) };
  }
  const existingByHash = new Map(existingRows.map((row) => [row.recipient_hash, row]));
  try {
    const preservedRow = await db.prepare(`SELECT COUNT(*) AS n FROM recipient_suppressions
      WHERE provenance != ? AND lifted_at IS NULL`).bind(provenance).first();
    receipt.preserved = Number(preservedRow?.n) || 0;
  } catch { receipt.preserved = 0; }

  const added = [];
  const updated = [];
  const reinstated = [];
  for (const [hash, entry] of normalized) {
    const existing = existingByHash.get(hash);
    if (!existing) {
      added.push([hash, entry]);
    } else if (existing.lifted_at) {
      reinstated.push([hash, entry]);
    } else if (existing.reason !== entry.reason
      || (existing.suppressed_at || null) !== entry.suppressed_at) {
      updated.push([hash, entry]);
    } else {
      receipt.unchanged += 1;
    }
  }
  const lifted = existingRows.filter((row) => !row.lifted_at && !normalized.has(row.recipient_hash));
  receipt.added = added.length;
  receipt.updated = updated.length;
  receipt.reinstated = reinstated.length;
  receipt.lifted = lifted.length;

  const idempotentReplay = state?.last_reconciliation_id === receipt.reconciliation_id
    && receipt.added === 0 && receipt.updated === 0 && receipt.reinstated === 0 && receipt.lifted === 0;
  receipt.idempotent_replay = idempotentReplay;

  if (receipt.mode !== "apply") return receipt;

  // 4. Apply: targeted upserts and lifts, then advance the authority cursor.
  try {
    for (const [hash, entry] of [...added, ...reinstated]) {
      await db.prepare(`INSERT INTO recipient_suppressions
          (recipient_hash, reason, provenance, suppressed_at, first_seen_at, lifted_at, reconciliation_id)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(recipient_hash) DO UPDATE SET
          reason = excluded.reason, provenance = excluded.provenance,
          suppressed_at = excluded.suppressed_at, lifted_at = NULL,
          reconciliation_id = excluded.reconciliation_id`)
        .bind(hash, entry.reason, provenance, entry.suppressed_at, at, receipt.reconciliation_id)
        .run();
    }
    for (const [hash, entry] of updated) {
      await db.prepare(`UPDATE recipient_suppressions
          SET reason = ?, suppressed_at = ?, reconciliation_id = ?
        WHERE recipient_hash = ? AND lifted_at IS NULL`)
        .bind(entry.reason, entry.suppressed_at, receipt.reconciliation_id, hash)
        .run();
    }
    for (const row of lifted) {
      await db.prepare(`UPDATE recipient_suppressions
          SET lifted_at = ?, reconciliation_id = ?
        WHERE recipient_hash = ? AND lifted_at IS NULL`)
        .bind(at, receipt.reconciliation_id, row.recipient_hash)
        .run();
    }
    await db.prepare(`INSERT INTO recipient_suppression_state
        (id, last_authority, last_reconciliation_id, applied_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_authority = excluded.last_authority,
        last_reconciliation_id = excluded.last_reconciliation_id,
        applied_at = excluded.applied_at`)
      .bind(receipt.authority, receipt.reconciliation_id, at)
      .run();
  } catch (error) {
    return { ...receipt, status: "db-apply-failed", error: String(error?.message || error).slice(0, 200) };
  }
  receipt.applied = true;
  return receipt;
}
