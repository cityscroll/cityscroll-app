// /mcp endpoint: JSON-RPC shape, tool listing, D1-backed search, and the spend guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleMcp } from "../src/mcp.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
}

// Minimal D1 stand-in: returns canned rows for .all(), one row for .first().
function mockDb(rows) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return { results: rows }; },
        async first() { return rows[0] || null; },
        _sql: sql,
      };
    },
  };
}

function post(body, headers = {}) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
}

const ROW = {
  request_id: "20260701001", section: "Procurement", agency: "PARKS", type_of_notice: "Award",
  category: "Construction/Construction Services", short_title: "Playground Renovation",
  description: "Scope: renovate", contract_amount: 2500000, contract_amount_valid: 1,
  start_date: "2026-07-01", due_date: null, due_year: null, document_urls: "[]", n_documents: 0,
};

test("initialize + tools/list expose the four tools", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV() };
  const init = await (await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "initialize" }), env)).json();
  assert.equal(init.result.serverInfo.name, "crol-list");
  const list = await (await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env)).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ["search_notices", "get_notice", "preview_watch", "create_watch"]);
});

test("search_notices returns formatted mirror results", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV(), DB: mockDb([ROW]) };
  const res = await (await handleMcp(post({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "search_notices", arguments: { query: "playground", min_amount: 1000000 } },
  }), env)).json();
  const out = res.result.content[0].text;
  assert.ok(out.includes("Playground Renovation"));
  assert.ok(out.includes("RequestID 20260701001"));
});

test("search_notices route returns the BM25-ranked strict-filter sample", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_notices.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0010_notice_facts.sql", import.meta.url), "utf8"));
  const add = sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, short_title, description,
     contract_amount, contract_amount_valid, start_date, haystack, document_urls, n_documents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)`);
  add.run("rule", "Agency Rules", "Buildings", "Notice", "Sidewalk shed safety",
    "Pedestrian protection around construction scaffolding", null, 0, "2026-07-07",
    "sidewalk shed pedestrian protection construction scaffolding");
  add.run("award", "Procurement", "Buildings", "Award", "Scaffold contract",
    "Construction award", 2_500_000, 1, "2026-07-08", "construction scaffolding contract");
  sqlite.exec(readFileSync(new URL("../migrations/0016_notice_fts.sql", import.meta.url), "utf8"));

  const DB = {
    prepare(sql) {
      if (/FROM notice_attachments/.test(sql)) {
        return { bind() { return this; }, async all() { return { results: [] }; } };
      }
      const statement = sqlite.prepare(sql);
      let args = [];
      const wrapper = {
        bind(...values) { args = values; return wrapper; },
        async all() {
          const results = statement.all(...args);
          return { results, meta: { rows_read: results.length } };
        },
        async first() { return statement.get(...args) ?? null; },
      };
      return wrapper;
    },
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    const res = await (await handleMcp(post({
      jsonrpc: "2.0", id: 31, method: "tools/call",
      params: {
        name: "search_notices",
        arguments: { query: "pedestrian construction scaffolding", section: "Agency Rules", limit: 5 },
      },
    }), { SUBS: new MockKV(), NL_METER: new MockKV(), DB })).json();
    const out = res.result.content[0].text;
    assert.match(out, /Sidewalk shed safety/);
    assert.doesNotMatch(out, /Scaffold contract/);
    assert.ok(logs.some((line) => /"method":"fts5_bm25"/.test(line)));
    assert.ok(logs.every((line) => !line.includes("pedestrian construction scaffolding")));
  } finally {
    console.log = originalLog;
    sqlite.close();
  }
});

test("bearer token, when configured, is required", async () => {
  const env = { MCP_BEARER_TOKEN: "s3cret", SUBS: new MockKV(), NL_METER: new MockKV() };
  const denied = await handleMcp(post({ jsonrpc: "2.0", id: 4, method: "ping" }), env);
  assert.equal(denied.status, 401);
  const ok = await handleMcp(post({ jsonrpc: "2.0", id: 5, method: "ping" }, { authorization: "Bearer s3cret" }), env);
  assert.equal(ok.status, 200);
});

test("per-IP daily ceiling returns a JSON-RPC error with 429", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV(), MCP_MAX_PER_IP_DAY: "2" };
  await handleMcp(post({ jsonrpc: "2.0", id: 6, method: "ping" }), env);
  await handleMcp(post({ jsonrpc: "2.0", id: 7, method: "ping" }), env);
  const third = await handleMcp(post({ jsonrpc: "2.0", id: 8, method: "ping" }), env);
  assert.equal(third.status, 429);
});

test("create_watch without secrets fails closed as a tool error", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV() };
  const res = await (await handleMcp(post({
    jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name: "create_watch", arguments: { email: "a@b.co", lens: "money", request: "big awards" } },
  }), env)).json();
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /isn't configured/);
});

test("notifications (no id) get 202, unknown methods get -32601", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV() };
  const notif = await handleMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }), env);
  assert.equal(notif.status, 202);
  const unknown = await (await handleMcp(post({ jsonrpc: "2.0", id: 10, method: "nope" }), env)).json();
  assert.equal(unknown.error.code, -32601);
});
