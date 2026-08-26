import test from "node:test";
import assert from "node:assert/strict";
import { handleNotice, prewarmNotices, workerNoticeGet } from "../src/notice.mjs";
import { executeNoticeGet } from "../../capabilities/notice_get.mjs";
import { handleMcp, mcpNoticeGetInput } from "../src/mcp.mjs";
import worker from "../src/worker.mjs";

const notice = {
  request_id: "20260807001",
  agency_name: "Department of Test",
  type_of_notice_description: "Solicitation",
  short_title: "Materialized notice",
  due_date: "2026-08-20T00:00:00.000",
};
const FIXTURE_NOW = Date.parse("2026-08-07T12:00:00.000Z");

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

function dbFor(record, events = []) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            first: async () => record,
            all: async () => ({
              results: sql.includes("civic_time_events")
                ? events.filter((event) => event.subject_ref === params[0])
                : [],
            }),
          };
        },
      };
    },
  };
}

function d1Record(overrides = {}) {
  return {
    request_id: notice.request_id,
    raw: JSON.stringify(notice),
    ingested_at: "2026-08-07T11:00:00.000Z",
    section: "Procurement",
    agency: notice.agency_name,
    type_of_notice: notice.type_of_notice_description,
    short_title: notice.short_title,
    ...overrides,
  };
}

function mcpGetPost(arguments_) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.21" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_notice", arguments: arguments_ },
    }),
  });
}

test("notice endpoint serves the materialized raw row without an upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected upstream fetch"); };
  try {
    const response = await handleNotice(
      new Request("https://api.cityscroll.org/notice?id=20260807001"),
      { DB: dbFor(d1Record()) },
      { nowMs: FIXTURE_NOW },
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

test("notice.get HTTP and MCP adapters preserve one direct provider result", async () => {
  const env = { DB: dbFor(d1Record()) };
  const input = { requestId: notice.request_id };
  const direct = await executeNoticeGet(workerNoticeGet(env), input);

  const mcpResponse = await handleMcp(mcpGetPost({ request_id: notice.request_id }), {
    ...env,
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
  });
  const mcpBody = await mcpResponse.json();
  assert.deepEqual(mcpBody.result.structuredContent, direct);

  const httpResponse = await handleNotice(
    new Request(`https://api.cityscroll.org/notice?id=${notice.request_id}`, {
      headers: { Accept: "application/json" },
    }),
    env,
    { skipCache: true },
  );
  const httpBody = await httpResponse.json();
  assert.equal(httpBody.ok, true);
  assert.deepEqual(httpBody.row, direct.notice);
  assert.equal(httpBody.source, direct.source);
  assert.equal(httpBody.generated_at, direct.generated_at);
  assert.equal(httpBody.stale, direct.stale);
  assert.deepEqual(mcpNoticeGetInput({ request_id: notice.request_id }), input);
});

test("notice read model exposes exact civic-time history with source-null clocks", async () => {
  const response = await handleNotice(
    new Request("https://api.cityscroll.org/notice?id=20260807001"),
    {
      DB: dbFor(d1Record(), [
        {
          event_id: "cte-1",
          subject_ref: "notice:20260807001",
          event_kind: "procurement.notice_published",
          valid_at: null,
          valid_from: null,
          valid_to: null,
          published_at: "2026-08-07",
          observed_at: null,
          processed_at: "2026-08-08T01:00:00.000Z",
          written_at: null,
          status: "occurred",
        },
        {
          event_id: "cte-other",
          subject_ref: "notice:other",
          event_kind: "procurement.notice_published",
          valid_at: "2026-01-01",
          published_at: null,
          processed_at: "2026-01-02T00:00:00.000Z",
        },
      ]),
    },
  );
  const body = await response.json();
  assert.equal(body.civic_time.state, "ok");
  assert.equal(body.civic_time.events.length, 1);
  assert.equal(body.civic_time.events[0].subject_ref, "notice:20260807001");
  assert.equal(body.civic_time.events[0].valid_at, null);
  assert.equal(body.civic_time.events[0].processed_at, "2026-08-08T01:00:00.000Z");
});

test("an old D1 row remains the last-known-good response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("refresh must not happen on a read"); };
  try {
    const response = await handleNotice(
      new Request("https://api.cityscroll.org/notice?id=20260807001"),
      { DB: dbFor(d1Record({ ingested_at: "2026-07-01T00:00:00.000Z" })) },
      { nowMs: FIXTURE_NOW },
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
