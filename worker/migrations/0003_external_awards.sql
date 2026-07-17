-- Precomputed NYCHA exact-PIN award matches per notice (crol-list: awards published elsewhere).
-- Public authorities post solicitations in the City Record but file awards elsewhere. NYCHA's
-- awards live in Checkbook NYC's Contracts_NYCHA domain and join to a City Record solicitation by
-- exact PIN. This caches the ranked match set per notice, computed once (ONE Checkbook request per
-- notice — the WAF blocks per-PIN fan-out) and served by GET /externalaward. Same derived-cache
-- shape as prior_cycle_matches: Checkbook stays the source of truth; a stale entry is harmless.
--
-- ABO (fuzzy) sources are cached in KV per source, not here — they're agency-wide, not per-notice.

CREATE TABLE IF NOT EXISTS external_award_matches (
  request_id  TEXT PRIMARY KEY,
  agency      TEXT,             -- the notice's agency_name (for an agency-scoped invalidation sweep later)
  matches     TEXT,             -- JSON: { "matches": [...ranked exact-PIN agreements] }
  computed_at TEXT              -- ISO timestamp this entry was computed
);
CREATE INDEX IF NOT EXISTS idx_external_award_agency ON external_award_matches(agency);
