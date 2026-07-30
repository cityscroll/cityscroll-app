-- PASSPort Public contracts + RFx edge materialization (flagship ingest).
-- Machine dumps: dataJs/contractData.js and dataJs/rfxData.js on the public portal.
-- Joined to City Record PINs via strict EPIN↔PIN strategies (see worker/src/lib/passport_join.mjs).
-- Rebuilt daily on the scheduled worker; lifecycle reads join from these tables (no live client fetch).

CREATE TABLE IF NOT EXISTS passport_contracts (
  epin            TEXT NOT NULL,
  epin_norm       TEXT NOT NULL,
  ctr_id          TEXT,
  contract_id     TEXT,
  title           TEXT,
  agency          TEXT,
  vendor          TEXT,
  status          TEXT,
  procurement_method TEXT,
  contract_type   TEXT,
  award_amount    REAL,
  current_amount  REAL,
  paid_amount     REAL,
  start_date      TEXT,
  end_date        TEXT,
  registration_date TEXT,
  payload         TEXT,
  ingested_at     TEXT NOT NULL,
  PRIMARY KEY (epin_norm, ctr_id)
);
CREATE INDEX IF NOT EXISTS idx_passport_contracts_epin ON passport_contracts(epin_norm);
CREATE INDEX IF NOT EXISTS idx_passport_contracts_status ON passport_contracts(status);

CREATE TABLE IF NOT EXISTS passport_rfx (
  epin            TEXT NOT NULL,
  epin_norm       TEXT NOT NULL,
  rfp_id          TEXT,
  procurement_name TEXT,
  agency          TEXT,
  rfx_status      TEXT,
  release_date    TEXT,
  due_date        TEXT,
  procurement_method TEXT,
  main_commodity  TEXT,
  industry        TEXT,
  payload         TEXT,
  ingested_at     TEXT NOT NULL,
  PRIMARY KEY (epin_norm, rfp_id)
);
CREATE INDEX IF NOT EXISTS idx_passport_rfx_epin ON passport_rfx(epin_norm);

CREATE TABLE IF NOT EXISTS passport_ingest_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
