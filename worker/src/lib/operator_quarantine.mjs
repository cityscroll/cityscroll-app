// Operator recipient holds: the operator-decided delivery quarantine
// (worker/migrations/0038, table operator_recipient_holds), read INDEPENDENTLY of
// the provider suppression authority. The provider reconciliation
// (recipient_suppression.mjs) never reads or writes this table, so a hold recorded
// here survives a provider refresh and a provider lift. The send boundary reads
// both facts together (deliveryHoldForRecipient) and refuses delivery when EITHER
// an unlifted hold here OR an active provider suppression holds.
//
// This module is READ-ONLY. The operator owns the write side: the holds were
// applied in production from the retained incident manifest with each row's
// original date, reason and provenance. The worker only consults them at the send
// boundary, and this change performs no backfill or apply.
//
// Privacy: recipient identities are sha256 hex digests of the normalized address;
// the address itself never appears here.

import { recipientHash } from "./recipient_suppression.mjs";

const SELECT_ONE = `SELECT recipient_hash, reason, provenance, held_at, lifted_at
  FROM operator_recipient_holds WHERE recipient_hash = ?`;

/** Read the operator fact. Required send reads propagate storage outages. */
export async function operatorQuarantineForRecipient(db, email, required = false) {
  if (!db?.prepare || !email) return null;
  try {
    const row = await db.prepare(SELECT_ONE).bind(await recipientHash(email)).first();
    if (!row || row.lifted_at) return null;
    return {
      reason: row.reason,
      provenance: row.provenance,
      held_at: row.held_at || null,
      // first_seen_at mirrors the provider-fact shape so the combined boundary can
      // read either fact's inception time without special-casing.
      first_seen_at: row.held_at || null,
    };
  } catch {
    if (required) throw new Error("Delivery hold lookup unavailable");
    return null;
  }
}
