-- Recipient-level delivery trust: the provider suppression authority and the
-- one-welcome-per-recipient claim ledger. Recipient identities are sha256 hex
-- digests of the normalized address; the address itself never lands in D1.

CREATE TABLE IF NOT EXISTS recipient_suppressions (
  recipient_hash     TEXT PRIMARY KEY,
  reason             TEXT NOT NULL,
  provenance         TEXT NOT NULL,
  suppressed_at      TEXT,
  first_seen_at      TEXT NOT NULL,
  lifted_at          TEXT,
  reconciliation_id  TEXT NOT NULL
);

-- Singleton reconciliation authority cursor (exactly one row, id = 1).
CREATE TABLE IF NOT EXISTS recipient_suppression_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  last_authority         TEXT NOT NULL,
  last_reconciliation_id TEXT NOT NULL,
  applied_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_welcome_deliveries (
  recipient_hash     TEXT PRIMARY KEY,
  idempotency_key    TEXT NOT NULL,
  state              TEXT NOT NULL
                     CHECK (state IN ('in-flight', 'accepted', 'rejected', 'indeterminate', 'suppressed', 'preexisting')),
  claim_token        TEXT,
  claim_expires_at   TEXT,
  first_attempted_at TEXT,
  last_attempted_at  TEXT,
  retry_until        TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  resolved_at        TEXT,
  provider_id        TEXT,
  error_reason       TEXT,
  provenance         TEXT
);
