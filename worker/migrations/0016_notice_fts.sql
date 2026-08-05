-- Rebuildable ranked lexical index for the D1 notices mirror.
--
-- D1 exports cannot include virtual tables. Before export, drop notices_fts and its
-- triggers; after import, execute this file to recreate and backfill the index.
-- Re-running the file is safe: the FTS5 rebuild command replaces index contents.

CREATE VIRTUAL TABLE IF NOT EXISTS notices_fts USING fts5(
  haystack,
  content='notices',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS notices_fts_insert AFTER INSERT ON notices BEGIN
  INSERT INTO notices_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
END;

CREATE TRIGGER IF NOT EXISTS notices_fts_delete AFTER DELETE ON notices BEGIN
  INSERT INTO notices_fts(notices_fts, rowid, haystack)
  VALUES ('delete', old.rowid, old.haystack);
END;

CREATE TRIGGER IF NOT EXISTS notices_fts_update AFTER UPDATE OF haystack ON notices
WHEN old.haystack IS NOT new.haystack BEGIN
  INSERT INTO notices_fts(notices_fts, rowid, haystack)
  VALUES ('delete', old.rowid, old.haystack);
  INSERT INTO notices_fts(rowid, haystack) VALUES (new.rowid, new.haystack);
END;

INSERT INTO notices_fts(notices_fts) VALUES ('rebuild');
