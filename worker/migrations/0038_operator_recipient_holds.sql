-- Operator recipient holds: the operator-decided delivery quarantine, recorded
-- INDEPENDENTLY of the provider suppression authority in recipient_suppressions
-- (worker/migrations/0036). The provider reconciliation never reads or writes this
-- table, so an operator hold survives a provider suppression refresh and a
-- provider lift. The send boundary (deliveryHoldForRecipient) reads both facts and
-- refuses delivery when EITHER an unlifted hold here OR an active provider
-- suppression holds; the private Desk read model unions the same two authorities.
--
-- This table already exists in production D1, applied by the operator from the
-- retained incident manifest with each row's original date, reason and provenance
-- (presumptive-spam-quarantine). This migration formalizes that schema in the
-- repository; CREATE TABLE IF NOT EXISTS makes applying it against the existing
-- production table a no-op, and no backfill or apply is performed from this change.
-- recipient_hash is the sha256 hex digest of the normalized address; the address
-- never lands in D1.

CREATE TABLE IF NOT EXISTS operator_recipient_holds (
  recipient_hash TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'presumptive-spam-quarantine'),
  provenance TEXT NOT NULL,
  held_at TEXT NOT NULL,
  lifted_at TEXT
);
