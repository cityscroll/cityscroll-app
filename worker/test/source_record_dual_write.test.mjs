// Dedicated regression tests for er-02 immutable dual-write on City Record ingest.
//
//   node --test test/source_record_dual_write.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSourceRecordHash, ingestNotices } from "../src/ingest.mjs";

function withMockedFetch(rows, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return Response.json(rows);
  };
  return Promise.resolve().then(fn).finally(() => {
    globalThis.fetch = original;
  });
}

function fakeDb() {
  const notices = new Map();
  const sourceRecords = [];
  const state = { ingest_cursor: "2026-06-01" };
  function findSourceRecordMatch(key) {
    return sourceRecords.find((row) => row.source_system === key[0]
      && row.source_system_id === key[1]
      && row.content_hash === key[2]);
  }

  return {
    notices,
    sourceRecords,
    state,
    prepare(sql) {
      const query = String(sql);
      const makeBound = (args = []) => ({
        _sql: query,
        _args: [...args],
        async run() {
          if (/SELECT v FROM ingest_state/.test(query)) {
            return null;
          }
          if (/INSERT OR REPLACE INTO notices/.test(query)) {
            const args = this._args;
            const row = {
              request_id: args[0],
              section: args[1],
              agency: args[2],
              type_of_notice: args[3],
              category: args[4],
              short_title: args[5],
              selection_method: args[6],
              special_case_reason: args[7],
              pin: args[8],
              vendor_name: args[9],
              description: args[10],
              other_info: args[11],
              printout: args[12],
              contract_amount: args[13],
              contract_amount_valid: args[14],
              start_date: args[15],
              due_date: args[16],
              due_year: args[17],
              event_date: args[18],
              event_building: args[19],
              event_addr1: args[20],
              event_city: args[21],
              event_state: args[22],
              event_zip: args[23],
              document_urls: args[24],
              n_documents: args[25],
              haystack: args[26],
              raw: args[27],
              ingested_at: args[28],
            };
            notices.set(row.request_id, row);
            return { success: true };
          }
          if (/INSERT OR IGNORE INTO source_records/.test(query)) {
            const key = [this._args[0], this._args[1], this._args[2]];
            if (!findSourceRecordMatch(key)) {
              sourceRecords.push({
                source_system: this._args[0],
                source_system_id: this._args[1],
                content_hash: this._args[2],
                raw_snapshot: this._args[3],
                normalized_snapshot: this._args[4],
                ingested_at: this._args[5],
              });
            }
            return { success: true };
          }
          if (/INSERT OR REPLACE INTO ingest_state/.test(query)) {
            state.ingest_cursor = this._args[1];
            return { success: true };
          }
          return { success: true };
        },
        async first() {
          if (/SELECT v FROM ingest_state/.test(query)) {
            const key = this._args[0];
            return Object.hasOwn(state, key) ? { v: state[key] } : null;
          }
          return null;
        },
        async all() { return { results: [] }; },
      });
      return {
        bind: (...args) => makeBound(args),
        _sql: query,
        _args: [],
        first: () => makeBound().first(),
        run: () => makeBound().run(),
        all: () => makeBound().all(),
      };
    },
    async batch(stmts) {
      for (const stmt of stmts) {
        await stmt.run();
      }
      return [];
    },
  };
}

const FIXTURE = [
  {
    request_id: "20260701001",
    section_name: "Procurement",
    agency_name: "Department of Parks and Recreation",
    type_of_notice_description: "Award",
    category_description: "Construction/Construction Services",
    short_title: "Playground Renovation",
    additional_description_1: "Scope: renovate playground",
    pin: "8462026PLAY",
    contract_amount: "$2,500,000",
    start_date: "2026-07-01T00:00:00.000",
    due_date: "2026-07-15T00:00:00.000",
  },
  {
    request_id: "20260702002",
    section_name: "Procurement",
    agency_name: "Department of Transportation",
    type_of_notice_description: "Solicitation",
    category_description: "Transportation",
    short_title: "Bridge Repair",
    additional_description_1: "Steel beam replacement and lane control",
    pin: "8462026BRDG",
    contract_amount: "$8,000,000",
    start_date: "2026-07-02T00:00:00.000",
    due_date: "2026-07-20T00:00:00.000",
  },
];

test("ingest with dual-write flag OFF keeps existing notices-only mirror behavior", async () => {
  const DB = fakeDb();
  await withMockedFetch(FIXTURE, async () => {
    const result = await ingestNotices({ DB });
    assert.equal(result.fetched, 2);
    assert.equal(result.upserted, 2);
    assert.equal(DB.notices.size, 2);
    assert.equal(DB.sourceRecords.length, 0);
    assert.ok(result.awardRequestIds.includes("20260701001"));
    assert.equal(result.nychaRequestIds.length, 0);
  });
});

test("ingest with dual-write flag ON writes one immutable source record per fixture row", async () => {
  const DB = fakeDb();
  await withMockedFetch(FIXTURE, async () => {
    const result = await ingestNotices({
      DB,
      CITY_RECORD_SOURCE_RECORD_DUAL_WRITE: "true",
    });
    assert.equal(result.fetched, 2);
    assert.equal(result.upserted, 2);
    assert.equal(DB.notices.size, 2);
    assert.equal(DB.sourceRecords.length, 2);
    assert.ok(DB.sourceRecords.every((row) => row.source_system === "city_record"));
    const expectedHashes = await Promise.all(FIXTURE.map((row) => computeSourceRecordHash(row)));
    const observedHashes = DB.sourceRecords.map((row) => row.content_hash).sort();
    assert.deepEqual(observedHashes, expectedHashes.sort());
  });
});

test("dual-write hash is stable across repeat ingest runs", async () => {
  const DB = fakeDb();
  await withMockedFetch(FIXTURE, async () => {
    await ingestNotices({
      DB,
      CITY_RECORD_SOURCE_RECORD_DUAL_WRITE: "true",
    });
    assert.equal(DB.sourceRecords.length, 2);
    const firstRunHashes = DB.sourceRecords.map((row) => row.content_hash).sort();

    DB.state.ingest_cursor = "2026-01-01"; // force a second synthetic backfill pass
    await ingestNotices({
      DB,
      CITY_RECORD_SOURCE_RECORD_DUAL_WRITE: "true",
    });

    assert.equal(DB.sourceRecords.length, 2);
    const secondRunHashes = DB.sourceRecords.map((row) => row.content_hash).sort();
    assert.deepEqual(secondRunHashes, firstRunHashes);
  });
});
