-- Precomputed prior-cycle / near-match matches per notice (crol-list Phase 1a).
-- Moves the two live SODA calls that priorCycleAwards()/nearMatchCandidates() fired from the
-- browser (index.html) off the client and into the worker: each notice's {strict, near} match
-- set is computed once, cached here, and served by GET /priorcycle/<request_id>. Lazily filled
-- on a cache miss and pre-warmed on the daily cron for freshly-ingested Award notices.
--
-- Socrata (dg92-zbpx) stays the source of truth for the underlying award rows; this is a derived
-- cache keyed by the notice's own request_id. A stale entry is harmless — worst case the reader
-- sees a match set current as of computed_at; the cron re-warms fresh Award notices daily.

CREATE TABLE IF NOT EXISTS prior_cycle_matches (
  request_id  TEXT PRIMARY KEY,
  agency      TEXT,             -- the notice's agency_name (for an agency-scoped invalidation sweep later)
  matches     TEXT,             -- JSON: { "strict": [...rows], "near": [...{c, score, reasons}] }
  computed_at TEXT              -- ISO timestamp this entry was computed
);
CREATE INDEX IF NOT EXISTS idx_prior_cycle_agency ON prior_cycle_matches(agency);
