import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleFollowing } from "../src/following.mjs";
import { useProcurementDigestSnapshot } from "../src/lib/compile.mjs";
import { TEXT_QUERY_EVAL_STATUS } from "../src/lib/watch_text_query_procurement.mjs";
import { previewGenerationMatches } from "../../site/watch_text_query_ui.mjs";

const CLOCK = "2026-09-09";
const titleSnapshot = JSON.parse(readFileSync(
  new URL("../../test/fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));
const ddc = JSON.parse(readFileSync(
  new URL("../../warehouse/fixtures/procurement-project-context/city-record-ddc-notices.json", import.meta.url),
  "utf8",
));
const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

const awardRows = titleSnapshot.rows.filter((row) => row.type_of_notice_description === "Award" && row.short_title);
const E2_IDS = ["20260709018", "20260713010", "20260713036"];
const E3_IDS = ["20260709018", "20260713010", "20260713024", "20260713036"];

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
    INSERT OR REPLACE INTO notices (
      request_id, agency, type_of_notice, category, short_title, description,
      vendor_name, pin, contract_amount, contract_amount_valid, start_date, due_date, haystack
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      "2026-12-31",
      `${title} ${description}`.toLowerCase(),
    );
  }
  sqlite.exec("COMMIT");
}

function makeEnv(rows) {
  const sqlite = new DatabaseSync(":memory:");
  noticesSchema(sqlite);
  seedNotices(sqlite, rows);
  sqlite.exec(migration);
  return { DB: d1(sqlite), GIT_COMMIT_SHA: "test" };
}

async function preview(env, search) {
  const restore = useProcurementDigestSnapshot({ rows: [] });
  try {
    return handleFollowing(new Request(`https://cityscroll.org/following/${search}`), env, {}, {
      todayISO: CLOCK,
      fetchImpl: async () => { throw new Error("publisher fetch is forbidden"); },
    });
  } finally {
    restore();
  }
}

test("A1: award-title preview for software excluding maintenance is E2, then E3", async () => {
  const env = makeEnv(awardRows);
  const e2 = await preview(env, "?lens=money&tq_i0=software&tq_x0=maintenance&type=award");
  assert.equal(e2.status, 200);
  const e2Html = await e2.text();
  for (const id of E2_IDS) assert.match(e2Html, new RegExp(`data-preview-id="${id}"`));
  assert.doesNotMatch(e2Html, /data-preview-id="20260723004"/);
  assert.match(e2Html, /data-excluded-id="20260723004"/);
  assert.match(e2Html, /Match more precisely|data-following-precise/);
  assert.doesNotMatch(e2Html, /JSON|predicate/);

  const e3 = await preview(env, "?lens=money&tq_mode=any&tq_i0=software&tq_i1=consulting&tq_x0=maintenance&type=award");
  const e3Html = await e3.text();
  for (const id of E3_IDS) assert.match(e3Html, new RegExp(`data-preview-id="${id}"`));
});

test("A2: keyword-only money preview stays on the simple path and does not subscribe", async () => {
  const env = makeEnv(awardRows);
  const res = await preview(env, "?lens=money&q=software&type=award");
  const html = await res.text();
  assert.match(html, /name="q"/);
  assert.match(html, /data-following-preview-form/);
  assert.match(html, /data-following-subscribe-form/);
  assert.doesNotMatch(html, /action="https:\/\/api\.cityscroll\.org\/subscribe"[^>]+data-following-preview/);
});

test("A3: DDC Greenway exclusion names maintenance vehicles; phrase restores it", async () => {
  const env = makeEnv(ddc.rows);
  const broad = await preview(env, "?lens=money&tq_i0=design+build&tq_i0p=1&tq_x0=maintenance&type=solicitation");
  const broadHtml = await broad.text();
  assert.match(broadHtml, /Left-out records/);
  assert.match(broadHtml, /20250305016/);
  assert.match(broadHtml, /maintenance vehicles/i);
  assert.doesNotMatch(broadHtml, /maintenance-services contract/i);

  const tight = await preview(env, "?lens=money&tq_i0=design+build&tq_i0p=1&tq_x0=maintenance+services&tq_x0p=1&type=solicitation");
  const tightHtml = await tight.text();
  assert.match(tightHtml, /20250305016/);
  assert.doesNotMatch(tightHtml, /data-excluded-id="20250305016"/);
});

test("A4: unavailable materialization preserves terms; stale generation is ignored", async () => {
  const res = await preview({ GIT_COMMIT_SHA: "test" }, "?lens=money&tq_i0=software&tq_x0=maintenance&preview_seq=4");
  const html = await res.text();
  assert.match(html, /Your wording is still here/);
  assert.match(html, /Retry preview|data-following-preview-retry/);
  assert.match(html, /tq_i0" value="software"|name="tq_i0" value="software"/);
  assert.doesNotMatch(html, /No matches now — still watch for new/);
  assert.equal(previewGenerationMatches(5, 4), false);
  assert.equal(TEXT_QUERY_EVAL_STATUS.unavailable, "unavailable");
});

test("A5/A6: preview items keep original titles and a return/edit path", async () => {
  const env = makeEnv(awardRows);
  const res = await preview(env, "?lens=money&tq_i0=software&tq_x0=maintenance&type=award&edit=sub:precise");
  const html = await res.text();
  const solar = awardRows.find((row) => row.request_id === "20260713036");
  assert.ok(solar?.short_title);
  assert.match(html, new RegExp(solar.short_title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Save changes/);
  assert.match(html, /data-following-cancel-edit/);
  assert.match(html, /following-record-link/);
});
