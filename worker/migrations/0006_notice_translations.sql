-- Informal notice translations (original-first, on-demand, invariant-checked).
-- English City Record text remains the official record. Translations are aids only:
-- computed once per (request_id, lang), cached here, served from GET /translate/<id>?lang=.
-- source_hash invalidates a row when the underlying notice text changes. A failed
-- invariant check is never stored — the next request may recompute.

CREATE TABLE IF NOT EXISTS notice_translations (
  request_id   TEXT NOT NULL,
  lang         TEXT NOT NULL,
  source_hash  TEXT NOT NULL,   -- sha of the English fields that were translated
  payload      TEXT NOT NULL,   -- JSON: { title, description, model, invariants_ok }
  computed_at  TEXT NOT NULL,   -- ISO timestamp
  PRIMARY KEY (request_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_notice_translations_lang ON notice_translations(lang);
