-- Carry-forward digest intent and per-occasion delivery receipts.
--
-- The item identity is deliberately independent of the mutable SUBS filter.  Keep
-- delivered rows as tombstones: pruning them without a separately proven retention
-- rule could re-owe a source item that reappears in a later observation.

CREATE TABLE IF NOT EXISTS digest_outbox_items (
  watch_id            TEXT NOT NULL,
  subscriber_id       TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  lens                TEXT NOT NULL,
  item_kind           TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  source_observed_at  TEXT NOT NULL,
  first_owed_at       TEXT NOT NULL,
  owed_origin         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'owed'
                      CHECK (status IN ('owed', 'delivered', 'cancelled')),
  delivered_at        TEXT,
  delivery_id         TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TEXT,
  last_error          TEXT,
  PRIMARY KEY (watch_id, item_id),
  CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_digest_outbox_owed_subscriber
  ON digest_outbox_items(subscriber_id, status, first_owed_at, watch_id, item_id);

CREATE TABLE IF NOT EXISTS digest_outbox_deliveries (
  subscriber_id       TEXT NOT NULL,
  scheduled_day       TEXT NOT NULL,
  delivery_id         TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL
                      CHECK (status IN ('reserved', 'sent', 'partial_error', 'failed')),
  reserved_at         TEXT NOT NULL,
  sent_at             TEXT,
  provider_message_id TEXT,
  eligible_count      INTEGER NOT NULL DEFAULT 0,
  delivered_count     INTEGER NOT NULL DEFAULT 0,
  error_json          TEXT,
  PRIMARY KEY (subscriber_id, scheduled_day)
);
