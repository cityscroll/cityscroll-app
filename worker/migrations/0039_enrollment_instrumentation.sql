-- Enrollment abuse instrumentation. Both tables are privacy-bounded: no raw IP,
-- no address, and no stable identifier is ever stored. A signup decision is keyed
-- by a rotating pseudonymous key (an HMAC of the actor under a per-window salt
-- derived from a server secret), so the same actor collapses to one key within a
-- rotation window and to a DIFFERENT key across windows, and the key cannot be
-- reversed without the secret. Only counts and buckets ever leave the worker.
--
--   signup_decision_receipts — one bounded receipt per signup decision linking the
--     route, time bucket, challenge and rate decision, and welcome outcome.
--   enrollment_containment — per-route temporary containment with an explicit
--     expiry, armed when accepted volume on a route (or the transactional-mail
--     budget) crosses its declared ceiling. Containment is a bounded, self-expiring
--     refusal of further accepts on a route; it is never an address or network ban.

CREATE TABLE IF NOT EXISTS signup_decision_receipts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudo_key       TEXT NOT NULL,
  route            TEXT NOT NULL,
  bucket           TEXT NOT NULL,
  rotation_window  TEXT NOT NULL,
  challenge        TEXT NOT NULL,
  rate_decision    TEXT NOT NULL,
  accepted         INTEGER NOT NULL,
  welcome_outcome  TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signup_decision_route_window
  ON signup_decision_receipts (route, rotation_window, accepted);
CREATE INDEX IF NOT EXISTS idx_signup_decision_window_outcome
  ON signup_decision_receipts (rotation_window, welcome_outcome);
CREATE INDEX IF NOT EXISTS idx_signup_decision_created_at
  ON signup_decision_receipts (created_at);

CREATE TABLE IF NOT EXISTS enrollment_containment (
  route            TEXT PRIMARY KEY,
  armed_at         TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  reason           TEXT NOT NULL,
  rotation_window  TEXT NOT NULL,
  observed_count   INTEGER NOT NULL,
  budget           INTEGER NOT NULL
);
