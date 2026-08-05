import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  buildFtsMatch,
  buildRankedNoticesQuery,
  noticeSearchTerms,
  searchNotices,
} from "../src/lib/notices.mjs";

const NOTICE_SCHEMA = readFileSync(new URL("../migrations/0001_notices.sql", import.meta.url), "utf8");
const FACTS_SCHEMA = readFileSync(new URL("../migrations/0010_notice_facts.sql", import.meta.url), "utf8");
const FTS_SCHEMA = readFileSync(new URL("../migrations/0016_notice_fts.sql", import.meta.url), "utf8");

function d1FromSqlite(sqlite, { meta = true } = {}) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      const wrapper = {
        bind(...values) { args = values; return wrapper; },
        async run() { statement.run(...args); return { success: true }; },
        async all() {
          const results = statement.all(...args);
          return { results, ...(meta ? { meta: { rows_read: results.length } } : {}) };
        },
        async first() { return statement.get(...args) ?? null; },
      };
      return wrapper;
    },
  };
}

function database({ fts = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(NOTICE_SCHEMA);
  sqlite.exec(FACTS_SCHEMA);
  if (fts) sqlite.exec(FTS_SCHEMA);
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

function insert(sqlite, row) {
  sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, category, short_title,
     contract_amount, contract_amount_valid, start_date, due_date, due_year,
     special_case_reason, haystack, document_urls, n_documents, structured_facts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, '{}')`)
    .run(
      row.request_id, row.section, row.agency, row.type_of_notice, row.category,
      row.short_title, row.contract_amount, row.contract_amount_valid,
      row.start_date, row.due_date, row.due_year, row.special_case_reason,
      row.haystack,
    );
}

const ROWS = [
  {
    request_id: "rule", section: "Agency Rules", agency: "Buildings",
    type_of_notice: "Notice", category: "Safety", short_title: "Sidewalk sheds",
    contract_amount: null, contract_amount_valid: 0, start_date: "2026-07-07",
    due_date: "2026-09-01 10:00:00", due_year: 2026, special_case_reason: null,
    haystack: "rules keeping pedestrians safe around construction scaffolding sidewalk sheds",
  },
  {
    request_id: "award", section: "Procurement", agency: "Parks and Recreation",
    type_of_notice: "Award", category: "Construction", short_title: "Park construction",
    contract_amount: 2_500_000, contract_amount_valid: 1, start_date: "2026-07-08",
    due_date: null, due_year: null, special_case_reason: null,
    haystack: "construction scaffolding contract park renovation",
  },
  {
    request_id: "corrupt", section: "Procurement", agency: "Parks and Recreation",
    type_of_notice: "Award", category: "Construction", short_title: "Bad amount",
    contract_amount: 96_000_000_000_000, contract_amount_valid: 0, start_date: "2026-07-09",
    due_date: "2099-01-01 00:00:00", due_year: 2099, special_case_reason: "sole source",
    haystack: "construction scaffolding contract",
  },
];

test("FTS query keeps AND-of-ORs semantics and treats operators as literals", () => {
  assert.deepEqual(
    buildFtsMatch([["public rules", "scaffolding"], ["Parks OR Buildings"]]),
    {
      match: '("scaffolding") AND ("parks" OR "buildings")',
      terms: ["scaffolding", "parks", "buildings"],
    },
  );
});

test("route query input is bounded before shared FTS normalization", () => {
  assert.equal(noticeSearchTerms("one ".repeat(30)).length, 24);
  assert.ok(noticeSearchTerms("x".repeat(600))[0].length <= 500);
});

test("ranked SQL applies every strict filter before BM25 ordering and limit", () => {
  const query = buildRankedNoticesQuery({
    termGroups: [["construction", "scaffolding"]],
    section: "Procurement", agency: "Parks", category: "Construction",
    noticeType: "Award", minAmount: 1000, maxAmount: 3_000_000,
    excludeSpecialCase: true, excludeRollingDeadlines: true,
    openOnly: true, dueBefore: "2026-12-31", sinceDate: "2026-01-01",
    today: "2026-08-01", limit: 5,
  });
  for (const predicate of [
    "n.section = ?", "lower(n.agency) LIKE ?", "n.category = ?",
    "n.type_of_notice = ?", "n.contract_amount_valid = 1",
    "n.contract_amount >= ?", "n.contract_amount <= ?",
    "n.special_case_reason IS NULL", "n.due_year IS NOT NULL AND n.due_year < ?",
    "n.due_date >= ?", "n.due_date <= ?", "n.start_date >= ?",
    "notices_fts MATCH ?",
  ]) assert.ok(query.sql.includes(predicate), predicate);
  assert.ok(query.sql.indexOf("WHERE") < query.sql.indexOf("ORDER BY _score"));
  assert.ok(query.sql.indexOf("ORDER BY _score") < query.sql.indexOf("LIMIT 5"));
});

test("FTS backfill and incremental refresh are idempotent", () => {
  const { sqlite } = database({ fts: false });
  insert(sqlite, ROWS[0]);
  sqlite.exec(FTS_SCHEMA);
  sqlite.exec(FTS_SCHEMA);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM notices_fts WHERE notices_fts MATCH 'scaffolding'").get().n, 1);

  sqlite.prepare("UPDATE notices SET haystack = ? WHERE request_id = ?")
    .run("elevator escalator safety", "rule");
  sqlite.prepare("UPDATE notices SET haystack = ? WHERE request_id = ?")
    .run("elevator escalator safety", "rule");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM notices_fts WHERE notices_fts MATCH 'scaffolding'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM notices_fts WHERE notices_fts MATCH 'elevator'").get().n, 1);
  sqlite.close();
});

test("ranked search applies strict filters and reports bounded D1 telemetry", async () => {
  const { sqlite, DB } = database();
  for (const row of ROWS) insert(sqlite, row);
  const result = await searchNotices(DB, {
    termGroups: [["construction", "scaffolding"]],
    section: "Procurement", agency: "Parks", noticeType: "Award",
    minAmount: 1_000_000, maxAmount: 3_000_000,
    excludeSpecialCase: true, limit: 5,
  });
  assert.deepEqual(result.results.map((row) => row.request_id), ["award"]);
  assert.equal(result.retrieval.method, "fts5_bm25");
  assert.equal(result.retrieval.fallback_reason, null);
  assert.equal(result.retrieval.rows_read, 1);
  sqlite.close();
});

test("only an unavailable FTS index activates the legacy fallback", async () => {
  const { sqlite, DB } = database({ fts: false });
  insert(sqlite, ROWS[0]);
  const result = await searchNotices(DB, { termGroups: [["scaffolding"]], limit: 5 });
  assert.equal(result.retrieval.method, "legacy_like_fallback");
  assert.equal(result.retrieval.fallback_reason, "fts_index_unavailable");
  assert.deepEqual(result.results.map((row) => row.request_id), ["rule"]);
  sqlite.close();

  const broken = { prepare() { throw new Error("database is locked"); } };
  await assert.rejects(() => searchNotices(broken, { termGroups: [["scaffolding"]] }), /database is locked/);
});

test("export/import rehearsal recreates the virtual table with equivalent ranking", () => {
  const source = database();
  for (const row of ROWS) insert(source.sqlite, row);
  const query = buildRankedNoticesQuery({ termGroups: [["construction", "scaffolding"]], limit: 5 });
  const before = source.sqlite.prepare(query.sql).all(...query.params).map((row) => row.request_id);

  // D1's documented export workaround omits virtual tables. Rehearse importing
  // ordinary notice rows, then replay the idempotent FTS migration.
  const restored = database({ fts: false });
  for (const row of source.sqlite.prepare("SELECT * FROM notices ORDER BY request_id").all()) insert(restored.sqlite, row);
  restored.sqlite.exec(FTS_SCHEMA);
  const after = restored.sqlite.prepare(query.sql).all(...query.params).map((row) => row.request_id);
  assert.deepEqual(after, before);
  source.sqlite.close();
  restored.sqlite.close();
});
