-- Common CityScroll account: one verified-email identity, shared across the civic
-- reader and the procurement product, with server-side revocable sessions.
--
-- These tables are additive and inert until the account flow is enabled
-- (CITYSCROLL_ACCOUNTS_ENABLED, default off). Legacy pins-scoped signed sessions
-- are unaffected: they never appear in these tables and keep their own lifetime.
--
-- Scope of this identity authority: a principal is a normalized verified email
-- mapped to the engine's existing opaque actor id (lib/meter.mjs opaqueActorId).
-- No supplier, legal entity, password, or private product content lives here.
PRAGMA foreign_keys=ON;

-- One row per verified email. `owner` is the opaque actor id ("a:" + sha256(email)).
CREATE TABLE IF NOT EXISTS cityscroll_principals (
  owner TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Server-side sessions. Only the hash of the opaque session token is stored, so a
-- database read never recovers a live cookie. `scopes` is a canonical JSON array of
-- the audiences the session may authorize (e.g. ["civic","procurement"]).
CREATE TABLE IF NOT EXISTS cityscroll_sessions (
  token_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES cityscroll_principals(owner) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  scopes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cityscroll_sessions_owner ON cityscroll_sessions(owner);
CREATE INDEX IF NOT EXISTS cityscroll_sessions_expiry ON cityscroll_sessions(expires_at);

-- One-use login challenges. The challenge token hash is the delivery intent; the
-- intent_hash binds the challenge to the same-browser login-intent cookie. A link is
-- consumable only once, only after delivery, only before expiry, only with the
-- matching intent.
CREATE TABLE IF NOT EXISTS cityscroll_login_challenges (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS cityscroll_login_challenges_expiry ON cityscroll_login_challenges(expires_at);

-- Atomic per-window counters for login rate limiting (per normalized-email hash,
-- per IP, and a global new-login-send bucket). Windows self-prune on cleanup.
CREATE TABLE IF NOT EXISTS cityscroll_auth_counters (
  bucket TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject_hash, window_start)
);
