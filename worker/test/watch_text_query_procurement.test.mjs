import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { processAccountRollup, processOneSub } from "../src/alerts.mjs";
import { compileSub, useProcurementDigestSnapshot } from "../src/lib/compile.mjs";
import { compileSub_d1, toDigestRow } from "../src/lib/compile_d1.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { buildNoticesQuery } from "../src/lib/notices.mjs";
import {
  evaluateD1NoticeTextQuery,
  evaluateMoneyTextQueryWatch,
  PRECISE_PROCUREMENT_ADAPTER,
  TEXT_QUERY_EVAL_STATUS,
} from "../src/lib/watch_text_query_procurement.mjs";
import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";
import { matchProcurementDigestRows } from "../../site/procurement_digest_compile.mjs";
import {
  evaluateNoticeRecords,
  projectProcurementNoticeFields,
} from "../../site/watch_text_query_eval.mjs";
import { matchesTextQuery } from "../../site/watch_text_query.mjs";

const CLOCK = "2026-09-09";
const NOW = new Date("2026-09-09T13:00:00.000Z");
const CROL_NEGATIVE_ID = "procurement:contract:CT101520271400806";

const titleSnapshot = JSON.parse(readFileSync(
  new URL("../../test/fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));
const ddc = JSON.parse(readFileSync(
  new URL("../../warehouse/fixtures/procurement-project-context/city-record-ddc-notices.json", import.meta.url),
  "utf8",
));
const cohort = JSON.parse(readFileSync(
  new URL("../../test/fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

const titledRows = titleSnapshot.rows.filter((row) => row.short_title);
const awardRows = titledRows.filter((row) => row.type_of_notice_description === "Award");
const ddcRows = ddc.rows;
const model = buildSharedProcurementReadModel({
  sourceRecords: cohort.source_records,
  generatedAt: cohort.generated_at,
});

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

const E2 = expr([[term("software")]], [term("maintenance")]);
const E3 = expr([[term("software"), term("consulting")]], [term("maintenance")]);
const E4 = expr([[term("software")], [term("consulting")]]);
const E5 = expr([[phrase("construction management")]]);
const E10 = expr([[term("services")]], [term("construction"), term("consulting")]);
const DESIGN_BUILD = expr([[phrase("design build")]]);
const DESIGN_BUILD_EX_MAINT = expr([[phrase("design build")]], [term("maintenance")]);
const DESIGN_BUILD_EX_MAINT_SERVICES = expr([[phrase("design build")]], [phrase("maintenance services")]);

function kv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            all() { return { results: statement.all(...params) }; },
            first() { return statement.get(...params) || null; },
          };
        },
      };
    },
    async batch(statements) { return statements.map((statement) => statement.run()); },
  };
}

function noticesSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      request_id TEXT PRIMARY KEY,
      section TEXT,
      agency TEXT,
      type_of_notice TEXT,
      category TEXT,
      short_title TEXT,
      description TEXT,
      vendor_name TEXT,
      pin TEXT,
      contract_amount REAL,
      contract_amount_valid INTEGER,
      start_date TEXT,
      due_date TEXT,
      haystack TEXT
    );
    CREATE TABLE IF NOT EXISTS ingest_state (k TEXT PRIMARY KEY, v TEXT);
  `);
}

function seedNotices(sqlite, rows) {
  const insert = sqlite.prepare(`
    INSERT INTO notices (
      request_id, agency, type_of_notice, category, short_title, description,
      vendor_name, pin, contract_amount, contract_amount_valid, start_date, haystack
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  sqlite.exec("BEGIN");
  for (const row of rows) {
    const title = row.short_title || "";
    const description = row.additional_description_1 || row.description || "";
    const start = String(row.start_date || "").slice(0, 10);
    insert.run(
      row.request_id,
      row.agency_name || row.agency || null,
      row.type_of_notice_description || row.type_of_notice || null,
      row.category_description || row.category || null,
      title,
      description,
      row.vendor_name || null,
      row.pin || null,
      row.contract_amount == null ? null : Number(row.contract_amount),
      1,
      start,
      `${title} ${description}`.toLowerCase(),
    );
  }
  sqlite.exec("COMMIT");
}

function makeNoticeDb(rows) {
  const sqlite = new DatabaseSync(":memory:");
  noticesSchema(sqlite);
  seedNotices(sqlite, rows);
  sqlite.exec(migration);
  return { sqlite, DB: d1(sqlite) };
}

function watch(filter, extra = {}) {
  return {
    key: extra.key || "sub:precise",
    email: extra.email || "owed@example.com",
    lens: "money",
    filter: sanitize("money", filter),
    freq: "daily",
    channel: "email",
    lang: "en",
    subscriber_id: extra.subscriber_id || "subscriber:test",
    watch_id: extra.watch_id || "watch:precise",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function runCtx() {
  let sends = 0;
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    today: CLOCK,
    now: NOW,
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": sends, daily: sends }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => { sends++; },
    capturePreviews: true,
  };
}

function env(DB, ALERT_STATE = kv()) {
  return {
    DB,
    ALERT_STATE,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
  };
}

async function withFetch(fn) {
  const original = globalThis.fetch;
  const soda = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      soda.push(target);
      throw new Error(`publisher fetch is not allowed on precise evaluation: ${target}`);
    }
    return { ok: true, json: async () => [] };
  };
  try {
    return await fn(soda);
  } finally {
    globalThis.fetch = original;
  }
}

function idsOf(rows) {
  return rows.map((row) => row.request_id || row.procurement_id || row.digest_id).sort();
}

test("A1 E2/E3/E4: server evaluator on the frozen award-title projection", async () => {
  const { sqlite, DB } = makeNoticeDb(awardRows);
  const subE2 = watch({ text_query: E2, noticeType: "award" });
  const e2 = await evaluateMoneyTextQueryWatch({
    db: DB, sub: subE2, todayISO: CLOCK, clock: CLOCK, snapshot: { rows: [] },
  });
  assert.equal(e2.status, TEXT_QUERY_EVAL_STATUS.complete);
  assert.equal(e2.soda, false);
  assert.equal(e2.fts, false);
  assert.equal(e2.publisher_fetch, false);
  assert.deepEqual(idsOf(e2.rows), ["20260709018", "20260713010", "20260713036"]);

  const e3 = await evaluateMoneyTextQueryWatch({
    db: DB,
    sub: watch({ text_query: E3, noticeType: "award" }),
    todayISO: CLOCK,
    clock: CLOCK,
    snapshot: { rows: [] },
  });
  assert.deepEqual(idsOf(e3.rows), ["20260709018", "20260713010", "20260713024", "20260713036"]);

  const e4 = await evaluateMoneyTextQueryWatch({
    db: DB,
    sub: watch({ text_query: E4, noticeType: "award" }),
    todayISO: CLOCK,
    clock: CLOCK,
    snapshot: { rows: [] },
  });
  assert.deepEqual(idsOf(e4.rows), []);
  sqlite.close();
});

test("A5 E5 phrase IDs; construction-only and management-only controls fail", async () => {
  const evaluated = evaluateNoticeRecords(titledRows, { expression: E5, limit: 25, clock: CLOCK });
  assert.deepEqual(idsOf(evaluated.rows), [
    "20260710009", "20260714009", "20260715010", "20260727024", "20260728022",
  ]);
  const { sqlite, DB } = makeNoticeDb(titledRows);
  const d1Eval = await evaluateD1NoticeTextQuery(DB, {
    opts: { orderBy: "start_date", stablePaging: true },
    expression: E5,
    limit: 25,
    clock: CLOCK,
  });
  assert.deepEqual(idsOf(d1Eval.rows), idsOf(evaluated.rows));
  assert.equal(d1Eval.retrieval, "legacy_like");
  assert.equal(
    matchesTextQuery(["General Construction Job Order Contract"], E5),
    false,
  );
  assert.equal(
    matchesTextQuery(["Citywide Program Management Office"], E5),
    false,
  );
  sqlite.close();
});

test("A5 E8: maintenance-vehicles passage is the exclusion reason; phrase stays in one field", async () => {
  const four = ddcRows.filter((row) => [
    "20250109025", "20250305016", "20250902007", "20260601039",
  ].includes(row.request_id));
  const { sqlite, DB } = makeNoticeDb(four);
  const included = await evaluateD1NoticeTextQuery(DB, {
    opts: { orderBy: "start_date", stablePaging: true },
    expression: DESIGN_BUILD,
    limit: 25,
    clock: CLOCK,
  });
  assert.deepEqual(idsOf(included.rows), ["20250109025", "20250305016", "20250902007", "20260601039"]);

  const broad = evaluateNoticeRecords(four, { expression: DESIGN_BUILD_EX_MAINT, clock: CLOCK });
  assert.deepEqual(idsOf(broad.rows), ["20250109025", "20250902007", "20260601039"]);
  const greenway = four.find((row) => row.request_id === "20250305016");
  const decision = evaluateNoticeRecords([greenway], { expression: DESIGN_BUILD_EX_MAINT, clock: CLOCK });
  assert.equal(decision.rows.length, 0);
  const explained = projectProcurementNoticeFields(greenway);
  const { explainTextQuery } = await import("../../site/watch_text_query.mjs");
  const evidence = explainTextQuery(explained, DESIGN_BUILD_EX_MAINT);
  assert.equal(evidence.match, false);
  assert.equal(evidence.exclusion.field, "description");
  assert.match(evidence.exclusion.passage, /Parks maintenance vehicles/i);
  assert.equal(evidence.exclusion.atom.value, "maintenance");

  const precise = evaluateNoticeRecords(four, { expression: DESIGN_BUILD_EX_MAINT_SERVICES, clock: CLOCK });
  assert.deepEqual(idsOf(precise.rows), ["20250109025", "20250305016", "20250902007", "20260601039"]);
  assert.equal(
    matchesTextQuery(["East Side Design", "Build for Greenway"], DESIGN_BUILD),
    false,
    "phrase cannot span title and description",
  );
  sqlite.close();
});

test("A3 E10: filter before the limit recovers the three starved identities", async () => {
  const services = titledRows
    .filter((row) => matchesTextQuery([row.short_title], expr([[term("services")]])))
    .sort((left, right) => {
      const byDate = String(right.start_date || "").slice(0, 10).localeCompare(String(left.start_date || "").slice(0, 10));
      if (byDate) return byDate;
      return String(left.request_id).localeCompare(String(right.request_id));
    });
  assert.equal(services.length, 69);
  const naive = evaluateNoticeRecords(services.slice(0, 25), { expression: E10, limit: 25, clock: CLOCK });
  assert.equal(naive.rows.length, 22);

  const { sqlite, DB } = makeNoticeDb(titledRows);
  const { sql, params } = buildNoticesQuery({
    termGroups: [["services"]],
    orderBy: "start_date",
    stablePaging: true,
    limit: 25,
  });
  const firstPage = sqlite.prepare(sql).all(...params).map(toDigestRow);
  const afterLimit = firstPage.filter((row) => matchesTextQuery(
    projectProcurementNoticeFields(row).map((field) => field.value),
    E10,
  ));
  const starved = new Set(["20260724019", "20260724020", "20260722008"]);
  assert.equal(
    afterLimit.some((row) => starved.has(row.request_id)),
    false,
    "a provider limit applied before exclusions hides the recovered identities",
  );
  assert.ok(afterLimit.length < 25, "a provider limit applied before exclusions starves the set");

  const evaluated = await evaluateD1NoticeTextQuery(DB, {
    opts: { orderBy: "start_date", stablePaging: true },
    expression: E10,
    limit: 25,
    clock: CLOCK,
  });
  assert.equal(evaluated.rows.length, 25);
  assert.equal(evaluated.status, TEXT_QUERY_EVAL_STATUS.complete);
  const recovered = ["20260724019", "20260724020", "20260722008"];
  for (const id of recovered) {
    assert.ok(evaluated.rows.some((row) => row.request_id === id), `recovered ${id}`);
  }
  sqlite.close();
});

test("A4 bounded exhaustion, resume, missing materialization, FTS-absent LIKE path", async () => {
  const { sqlite, DB } = makeNoticeDb(titledRows);
  const exhausted = await evaluateD1NoticeTextQuery(DB, {
    opts: { orderBy: "start_date", stablePaging: true },
    expression: E10,
    limit: 25,
    scanBudget: 20,
    pageSize: 10,
    clock: CLOCK,
  });
  assert.equal(exhausted.status, TEXT_QUERY_EVAL_STATUS.incomplete);
  assert.ok(exhausted.continuation);
  assert.ok(exhausted.rows.length < 25);
  const seen = new Set(exhausted.markSeenIds);
  assert.equal(seen.has("20260722008"), false, "unscanned candidates are not marked seen");

  const resumed = await evaluateD1NoticeTextQuery(DB, {
    opts: { orderBy: "start_date", stablePaging: true },
    expression: E10,
    limit: 25,
    scanBudget: 500,
    cursor: exhausted.continuation,
    clock: CLOCK,
  });
  const overlap = resumed.markSeenIds.filter((id) => seen.has(id));
  assert.deepEqual(overlap, []);

  const missing = await evaluateMoneyTextQueryWatch({
    db: null,
    snapshot: null,
    sub: watch({ text_query: E2, noticeType: "award" }),
    todayISO: CLOCK,
    clock: CLOCK,
  });
  assert.equal(missing.status, TEXT_QUERY_EVAL_STATUS.unavailable);
  assert.equal(missing.reason, "missing_materialization");
  assert.deepEqual(missing.rows, []);

  const likePath = await evaluateD1NoticeTextQuery(DB, {
    opts: { orderBy: "start_date", stablePaging: true },
    expression: E5,
    limit: 25,
    clock: CLOCK,
  });
  assert.equal(likePath.retrieval, "legacy_like", "digest evaluation uses buildNoticesQuery, not FTS");
  assert.equal(likePath.rows.length, 5);
  sqlite.close();
});

test("A2 golden-cohort: request_id vs procurement_id; exclusion is not bypassed; no duplicate", async () => {
  const restore = useProcurementDigestSnapshot(model);
  try {
    const exact = matchProcurementDigestRows(model, {
      procurement_id: CROL_NEGATIVE_ID,
      noticeType: "award",
      text_query: expr([[term("legal")]], [term("services")]),
    }, { lens: "money" });
    assert.deepEqual(exact, [], "exact-id early-return must not skip an admitted exclusion");

    const matching = matchProcurementDigestRows(model, {
      procurement_id: CROL_NEGATIVE_ID,
      noticeType: "award",
      text_query: expr([[term("legal")]]),
    }, { lens: "money" });
    assert.equal(matching.length, 1);
    assert.equal(matching[0].procurement_id, CROL_NEGATIVE_ID);
    assert.equal(matching[0].request_id, undefined);

    const { sqlite, DB } = makeNoticeDb([{
      request_id: "20260623008",
      start_date: "2026-06-29",
      type_of_notice_description: "Award",
      short_title: "Bridge inspection",
      additional_description_1: "Notice evidence retained for the registered contract.",
      agency_name: "Department of Transportation",
    }]);
    const evaluated = await evaluateMoneyTextQueryWatch({
      db: DB,
      snapshot: model,
      sub: watch({ text_query: expr([[term("legal")]]), noticeType: "award" }),
      todayISO: CLOCK,
      clock: CLOCK,
    });
    const legal = evaluated.rows.filter((row) => (row.digest_id || row.procurement_id) === CROL_NEGATIVE_ID);
    assert.equal(legal.length, 1);
    assert.equal(legal[0].procurement_id, CROL_NEGATIVE_ID);
    assert.equal(legal[0].request_id, undefined);
    sqlite.close();
  } finally {
    restore();
  }
});

test("A6 single-watch and rollup handlers use the shared evaluator; SODA is unused", async () => {
  const { sqlite, DB } = makeNoticeDb(awardRows);
  const restore = useProcurementDigestSnapshot(model);
  const sub = watch({ text_query: E2, noticeType: "award" });
  try {
    await withFetch(async (soda) => {
      const single = await processOneSub(env(DB), sub, runCtx());
      assert.equal(soda.length, 0, "precise evaluation must not hit the scheduled SODA fallback");
      assert.notEqual(single.skipped, "text-query-unavailable");
      assert.ok(single.sent || single.new >= 0);
      assert.ok((single.noticeIds || []).includes("20260709018"));
      assert.equal((single.noticeIds || []).includes("20260723004"), false, "SolarWinds excluded");

      const rollup = await processAccountRollup(env(DB, kv()), [watch({
        text_query: E2,
        noticeType: "award",
      }, { key: "sub:precise-rollup", watch_id: "watch:precise-rollup" })], runCtx());
      assert.equal(soda.length, 0);
      assert.ok(rollup);
    });

    const compiled = compileSub(sub, CLOCK);
    assert.equal(compiled.soda, false);
    assert.equal(compiled.url, null);
    const d1Compiled = compileSub_d1(sub, CLOCK);
    assert.equal(d1Compiled.opts.termGroups, undefined);
  } finally {
    restore();
    sqlite.close();
  }
});

test("A6 records the legacy SODA fallback as unused for v1 evaluation", async () => {
  const sub = watch({ text_query: E2, noticeType: "award" });
  const compiled = compileSub(sub, CLOCK);
  assert.equal(compiled.soda, false);
  assert.equal(compiled.url, null, "legacy SODA money compile is not the v1 path");
  const legacy = compileSub({
    lens: "money",
    filter: sanitize("money", { keywords: ["software"], noticeType: "award" }),
  }, CLOCK);
  assert.ok(legacy.url, "legacy keyword watches still use the scheduled SODA descriptor");
  assert.equal(legacy.params?.$q, "software");
});
