-- D1 cannot export a database while it contains an FTS5 virtual table.
-- Run this immediately before export, then replay migrations/0016_notice_fts.sql
-- on both the live database and the imported database.

DROP TRIGGER IF EXISTS notices_fts_insert;
DROP TRIGGER IF EXISTS notices_fts_delete;
DROP TRIGGER IF EXISTS notices_fts_update;
DROP TABLE IF EXISTS notices_fts;
