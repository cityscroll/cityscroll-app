import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SOURCE_SCHEMA = readFileSync(new URL("../../migrations/0008_source_records.sql", import.meta.url), "utf8");
const JOURNAL_SCHEMA = readFileSync(new URL("../../migrations/0027_matter_observation_journal.sql", import.meta.url), "utf8");
const REFRESH_SCHEMA = readFileSync(new URL("../../migrations/0028_matter_exact_refresh.sql", import.meta.url), "utf8");

export function d1FromSqlite(db, { failNextBatch = false } = {}) {
  const state = { failNextBatch };
  return {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql);
          const args = values;
          return {
            bind(...next) { return d1FromSqlite(db).prepare(sql).bind(...next); },
            async run() {
              if (args.length) statement.run(...args);
              else statement.run();
              return { success: true };
            },
            async all() {
              const rows = args.length ? statement.all(...args) : statement.all();
              return { results: rows };
            },
            async first() {
              const row = args.length ? statement.get(...args) : statement.get();
              return row ?? null;
            },
          };
        },
        async run() { db.prepare(sql).run(); return { success: true }; },
        async all() { return { results: db.prepare(sql).all() }; },
        async first() { return db.prepare(sql).get() ?? null; },
      };
    },
    async batch(statements) {
      if (state.failNextBatch) {
        state.failNextBatch = false;
        throw new Error("injected-transaction-failure");
      }
      db.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
}

export function matterJournalDatabase({ journal = true, observations = true, refresh = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (observations) sqlite.exec(SOURCE_SCHEMA);
  if (journal) sqlite.exec(JOURNAL_SCHEMA);
  if (refresh) sqlite.exec(REFRESH_SCHEMA);
  return { sqlite, DB: d1FromSqlite(sqlite) };
}
