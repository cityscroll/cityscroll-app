import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ingestNotices } from "../src/ingest.mjs";

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async run() { stmt.run(...args); return { success: true }; },
            async first() { return stmt.get(...args) ?? null; },
          };
        },
        async run() { stmt.run(); return { success: true }; },
        async first() { return stmt.get() ?? null; },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

const fixture = [
  { request_id: "20260731001", section_name: "Procurement", type_of_notice_description: "Award", vendor_name: "Sinergia Inc", start_date: "2026-07-31T00:00:00.000" },
  { request_id: "20260731002", section_name: "Procurement", type_of_notice_description: "Award", vendor_name: "Sinergia Incorporated", start_date: "2026-07-31T00:00:00.000" },
  { request_id: "20260731003", section_name: "Procurement", type_of_notice_description: "Award", vendor_name: "Acme Construction LLC", start_date: "2026-07-31T00:00:00.000" },
];

test("production shadow ingest accumulates source and entity rows idempotently", async () => {
  const db = new DatabaseSync(":memory:");
  for (const migration of ["0001_notices.sql", "0008_source_records.sql", "0009_entity_link.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const DB = d1FromSqlite(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture);
  const env = {
    DB,
    CITY_RECORD_SOURCE_RECORD_DUAL_WRITE: "true",
    ENTITY_LINK_DUAL_WRITE: "true",
  };

  try {
    await ingestNotices(env);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entity_link").get().n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM canonical_entity").get().n, 2);

    db.prepare("UPDATE ingest_state SET v = ? WHERE k = ?").run("2026-01-01", "ingest_cursor");
    await ingestNotices(env);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_records").get().n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entity_link").get().n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resolution_run").get().n, 2);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
