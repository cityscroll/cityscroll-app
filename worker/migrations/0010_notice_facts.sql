-- Evidence-carrying facts parsed from explicitly labeled City Record prose.
-- Canonical source columns remain authoritative; these facts preserve provenance
-- and support bounded fallbacks when a publisher leaves the source column empty.
ALTER TABLE notices ADD COLUMN structured_facts TEXT;
