-- Precomputed contract lifecycle per notice (PROC-001: Checkbook contract lifecycle).
-- Joins a City Record solicitation/award notice to Checkbook NYC pending, registered, and
-- spending records. Each notice's assembled lifecycle timeline is computed once (Checkbook
-- XML API calls per PIN) and cached here, served by GET /contract-lifecycle. Same derived-cache
-- shape as prior_cycle_matches and external_award_matches: Checkbook stays the source of truth;
-- a stale entry is harmless.
--
-- Lazily filled on a cache miss and pre-warmed on the daily cron for freshly-ingested
-- Award notices (bounded, NOT a full backfill).

CREATE TABLE IF NOT EXISTS contract_lifecycle (
  request_id  TEXT PRIMARY KEY,
  agency      TEXT,
  lifecycle   TEXT,             -- JSON: { pin, pin_strategy, timeline: [...], amendments: [...], ok }
  computed_at TEXT              -- ISO timestamp this entry was computed
);
CREATE INDEX IF NOT EXISTS idx_contract_lifecycle_agency ON contract_lifecycle(agency);
