import test from "node:test";
import assert from "node:assert/strict";
import { handleNotice, prewarmNotices } from "../src/notice.mjs";
import worker from "../src/worker.mjs";

const notice = {
  request_id: "20260807001",
  agency_name: "Department of Test",
  type_of_notice_description: "Solicitation",
  short_title: "Materialized notice",
  due_date: "2026-08-20T00:00:00.000",
};

function dbFor(record) {
  return {
    prepare() {
      return { bind() { return { first: async () => record }; } };
    },
  };
}

function d1Record(overrides = {}) {
  return {
    request_id: notice.request_id,
    raw: JSON.stringify(notice),
    ingested_at: new Date().toISOString(),
    section: "Procurement",
    agency: notice.agency_name,
    type_of_notice: notice.type_of_notice_description,
    short_title: notice.short_title,
    ...overrides,
  };
}

test("notice endpoint serves the materialized raw row without an upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected upstream fetch"); };
  try {
    const response = await handleNotice(
      new Request("https://api.cityscroll.org/notice?id=20260807001"),
      { DB: dbFor(d1Record()) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, "materialized");
    assert.equal(body.row.short_title, notice.short_title);
    assert.equal(body.stale, false);
    assert.match(response.headers.get("Cache-Control"), /s-maxage=86400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the public Worker route dispatches to the notice read model", async () => {
  const response = await worker.fetch(
    new Request("https://api.cityscroll.org/notice?id=20260807001"),
    { DB: dbFor(d1Record()) },
    {},
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "materialized");
});

test("an old D1 row remains the last-known-good response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("refresh must not happen on a read"); };
  try {
    const response = await handleNotice(
      new Request("https://api.cityscroll.org/notice?id=20260807001"),
      { DB: dbFor(d1Record({ ingested_at: "2026-07-01T00:00:00.000Z" })) },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "materialized");
    assert.equal(body.stale, true);
    assert.equal(body.row.request_id, notice.request_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a read-model miss uses the public source as an exceptional fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /data\.cityofnewyork\.us\/resource\/dg92-zbpx\.json/);
    return new Response(JSON.stringify([notice]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await handleNotice(
      new Request("https://api.cityscroll.org/notice?id=20260807001"),
      { DB: dbFor(null) },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "public-source-fallback");
    assert.equal(body.row.request_id, notice.request_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prewarm is bounded and fails soft when the edge cache is unavailable", async () => {
  const result = await prewarmNotices({ DB: dbFor(d1Record()) }, [notice.request_id, notice.request_id]);
  assert.equal(result.requested, 1);
  assert.equal(result.warmed, 0);
  assert.equal(result.skipped, "no-edge-cache");
});

test("prewarm writes a materialized row to the edge cache", async () => {
  const previousCaches = globalThis.caches;
  const puts = [];
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async (request, response) => puts.push({ request, response }),
    },
  };
  try {
    const result = await prewarmNotices({ DB: dbFor(d1Record()) }, [notice.request_id]);
    assert.deepEqual(result, { requested: 1, warmed: 1, failed: 0 });
    assert.equal(puts.length, 1);
    assert.equal((await puts[0].response.json()).source, "materialized");
  } finally {
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  }
});
