import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMeetingOutcomesPageCoherent,
  assertMeetingOutcomesSourceFresh,
  fetchMeetingOutcomesRecords,
} from "../tools/build_meeting_outcomes_snapshot.mjs";
import { MAX_AGE_MS } from "../worker/src/lib/meeting_outcomes.mjs";

const FRESH_AT = "2026-10-23T09:36:10.172Z";
const OTHER_FRESH_AT = "2026-10-23T08:00:00.000Z";
const STALE_AT = "2026-10-16T08:02:43.838Z";
const NOW_MS = Date.parse("2026-10-23T10:00:00.000Z");

function page({ generated_at, stale = false, records = [], total = null, ok, schema_version = 4, offset = 0 } = {}) {
  const body = {
    generated_at,
    stale,
    schema_version,
    records,
    pagination: {
      limit: 100,
      offset,
      requested: 100,
      returned: records.length,
      total: total == null ? records.length : total,
    },
  };
  if (ok === false) body.ok = false;
  return body;
}

function multiPageFetch(pagesByOffset) {
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset") || 0);
    const body = pagesByOffset.get(offset);
    if (!body) throw new Error(`unexpected offset ${offset}`);
    return {
      ok: true,
      async json() {
        return body;
      },
    };
  };
}

test("assertMeetingOutcomesSourceFresh accepts a current Worker view", () => {
  const generatedAt = assertMeetingOutcomesSourceFresh(
    page({ generated_at: FRESH_AT, stale: false }),
    { nowMs: NOW_MS },
  );
  assert.equal(generatedAt, FRESH_AT);
});

test("assertMeetingOutcomesSourceFresh refuses an API-marked stale view (scheduled-refresh root cause)", () => {
  assert.throws(
    () => assertMeetingOutcomesSourceFresh(
      page({ generated_at: STALE_AT, stale: true }),
      { nowMs: NOW_MS },
    ),
    /source is stale/,
  );
});

test("assertMeetingOutcomesSourceFresh refuses an aged view even when stale flag is absent", () => {
  assert.ok(NOW_MS - Date.parse(STALE_AT) > MAX_AGE_MS);
  assert.throws(
    () => assertMeetingOutcomesSourceFresh(
      page({ generated_at: STALE_AT, stale: false }),
      { nowMs: NOW_MS },
    ),
    /source is stale/,
  );
});

test("assertMeetingOutcomesSourceFresh refuses a missing generated_at instead of fabricating now", () => {
  assert.throws(
    () => assertMeetingOutcomesSourceFresh(
      page({ generated_at: null, stale: false }),
      { nowMs: NOW_MS },
    ),
    /missing generated_at/,
  );
});

test("fetchMeetingOutcomesRecords fails closed before writing when the first page is stale", async () => {
  const fetches = [];
  await assert.rejects(
    () => fetchMeetingOutcomesRecords(async (url) => {
      fetches.push(url);
      return {
        ok: true,
        async json() {
          return page({
            generated_at: STALE_AT,
            stale: true,
            records: [{ request_id: "20261006004", join: { matched: false } }],
            total: 1,
          });
        },
      };
    }, { nowMs: NOW_MS }),
    /source is stale/,
  );
  assert.equal(fetches.length, 1);
});

test("fetchMeetingOutcomesRecords keeps the source generated_at on a fresh page", async () => {
  const row = { request_id: "20261006004", join: { matched: false } };
  const result = await fetchMeetingOutcomesRecords(async () => ({
    ok: true,
    async json() {
      return page({
        generated_at: FRESH_AT,
        stale: false,
        records: [row],
        total: 1,
      });
    },
  }), { nowMs: NOW_MS });
  assert.equal(result.generatedAt, FRESH_AT);
  assert.deepEqual(result.records, [row]);
});

test("assertMeetingOutcomesPageCoherent accepts the first fresh page and later same-generation pages", () => {
  const first = assertMeetingOutcomesPageCoherent(
    page({ generated_at: FRESH_AT, stale: false }),
    null,
    { nowMs: NOW_MS },
  );
  assert.deepEqual(first, { generatedAt: FRESH_AT, schemaVersion: 4 });
  const second = assertMeetingOutcomesPageCoherent(
    page({ generated_at: FRESH_AT, stale: false, offset: 100 }),
    first,
    { nowMs: NOW_MS },
  );
  assert.deepEqual(second, first);
});

test("fetchMeetingOutcomesRecords refuses a stale second page after a fresh first page", async () => {
  const row0 = { request_id: "20261006004", join: { matched: false } };
  const row1 = { request_id: "20261006005", join: { matched: false } };
  await assert.rejects(
    () => fetchMeetingOutcomesRecords(multiPageFetch(new Map([
      [0, page({ generated_at: FRESH_AT, stale: false, records: [row0], total: 2 })],
      [1, page({ generated_at: STALE_AT, stale: true, records: [row1], total: 2, offset: 1 })],
    ])), { nowMs: NOW_MS }),
    /source is stale/,
  );
});

test("fetchMeetingOutcomesRecords refuses a second page with a different generated_at", async () => {
  const row0 = { request_id: "20261006004", join: { matched: false } };
  const row1 = { request_id: "20261006005", join: { matched: false } };
  await assert.rejects(
    () => fetchMeetingOutcomesRecords(multiPageFetch(new Map([
      [0, page({ generated_at: FRESH_AT, stale: false, records: [row0], total: 2 })],
      [1, page({ generated_at: OTHER_FRESH_AT, stale: false, records: [row1], total: 2, offset: 1 })],
    ])), { nowMs: NOW_MS }),
    /mixed source generations/,
  );
});

test("fetchMeetingOutcomesRecords refuses a second page marked ok=false", async () => {
  const row0 = { request_id: "20261006004", join: { matched: false } };
  await assert.rejects(
    () => fetchMeetingOutcomesRecords(multiPageFetch(new Map([
      [0, page({ generated_at: FRESH_AT, stale: false, records: [row0], total: 2 })],
      [1, page({ generated_at: FRESH_AT, stale: false, records: [], total: 2, offset: 1, ok: false })],
    ])), { nowMs: NOW_MS }),
    /source unavailable/,
  );
});

test("fetchMeetingOutcomesRecords refuses a second page missing generated_at", async () => {
  const row0 = { request_id: "20261006004", join: { matched: false } };
  await assert.rejects(
    () => fetchMeetingOutcomesRecords(multiPageFetch(new Map([
      [0, page({ generated_at: FRESH_AT, stale: false, records: [row0], total: 2 })],
      [1, page({ generated_at: null, stale: false, records: [{ request_id: "x" }], total: 2, offset: 1 })],
    ])), { nowMs: NOW_MS }),
    /missing generated_at/,
  );
});

test("fetchMeetingOutcomesRecords accepts same-generation pagination across pages", async () => {
  const row0 = { request_id: "20261006004", join: { matched: false } };
  const row1 = { request_id: "20261006005", join: { matched: true } };
  const result = await fetchMeetingOutcomesRecords(multiPageFetch(new Map([
    [0, page({ generated_at: FRESH_AT, stale: false, records: [row0], total: 2 })],
    [1, page({ generated_at: FRESH_AT, stale: false, records: [row1], total: 2, offset: 1 })],
  ])), { nowMs: NOW_MS });
  assert.equal(result.generatedAt, FRESH_AT);
  assert.deepEqual(result.records, [row0, row1]);
});
