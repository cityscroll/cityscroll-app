-- D1 read models for the large Worker-side search and OCP artifacts.
-- Data is refreshed by tools/build_worker_d1_read_models.mjs during deployment.

CREATE TABLE IF NOT EXISTS keyword_search_families (
  family_id TEXT PRIMARY KEY,
  source TEXT,
  as_of TEXT,
  source_row_count INTEGER NOT NULL,
  indexed_count INTEGER NOT NULL,
  coverage_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_search_documents (
  document_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES keyword_search_families(family_id),
  ordinal INTEGER NOT NULL,
  object_ref TEXT,
  source_observation_refs_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  search_text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keyword_search_documents_family_ordinal
  ON keyword_search_documents(family_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_keyword_search_documents_family_object
  ON keyword_search_documents(family_id, object_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS keyword_search_fts USING fts5(
  document_id UNINDEXED,
  family_id UNINDEXED,
  search_text,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS ocp_awards_warehouse (
  row_key TEXT PRIMARY KEY,
  request_id TEXT,
  start_date TEXT,
  agency_name TEXT,
  type_of_notice_description TEXT,
  short_title TEXT,
  pin TEXT,
  contract_amount TEXT,
  vendor_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_ocp_awards_warehouse_request_id
  ON ocp_awards_warehouse(request_id);
CREATE INDEX IF NOT EXISTS idx_ocp_awards_warehouse_pin
  ON ocp_awards_warehouse(pin);
