-- D1 mirror of City Record notices (schema adapted from Dev Doshi's crol-alert).
-- Socrata (dg92-zbpx) stays the source of truth; this is a daily-ingest cache.
-- The raw source row is kept per notice so a Socrata field rename is recoverable.

CREATE TABLE IF NOT EXISTS notices (
  request_id           TEXT PRIMARY KEY,
  section              TEXT,
  agency               TEXT,
  type_of_notice       TEXT,
  category             TEXT,
  short_title          TEXT,
  selection_method     TEXT,
  special_case_reason  TEXT,            -- non-null => non-competitive ("special case")
  pin                  TEXT,
  vendor_name          TEXT,
  description          TEXT,            -- additional_description_1
  other_info           TEXT,            -- other_info_1
  printout             TEXT,            -- printout_1
  contract_amount      REAL,            -- cleaned: stripped $ and commas
  contract_amount_valid INTEGER,        -- 1 if >0 and <1e10 (else data-entry error; EDA: max legit ≈ $6.68B)
  start_date           TEXT,            -- ISO yyyy-mm-dd (publication date)
  due_date             TEXT,            -- ISO datetime or NULL
  due_year             INTEGER,         -- year of due_date (>=2090 => rolling placeholder)
  event_date           TEXT,
  event_building       TEXT,
  event_addr1          TEXT,
  event_city           TEXT,
  event_state          TEXT,
  event_zip            TEXT,
  document_urls        TEXT,            -- JSON array of cleaned http(s) URLs
  n_documents          INTEGER DEFAULT 0,
  haystack             TEXT,            -- lowercased title+desc+printout+other_info+agency
  raw                  TEXT,            -- raw source row JSON (resilience)
  ingested_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_section ON notices(section);
CREATE INDEX IF NOT EXISTS idx_notices_start   ON notices(start_date);
CREATE INDEX IF NOT EXISTS idx_notices_due     ON notices(due_date);
CREATE INDEX IF NOT EXISTS idx_notices_amount  ON notices(contract_amount);

-- Key/value state for the ingest cursor (and future worker-side state).
CREATE TABLE IF NOT EXISTS ingest_state (
  k TEXT PRIMARY KEY,
  v TEXT
);
