import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  executeNoticeSearch,
  NOTICE_SEARCH_AVAILABILITY,
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  noticeSearchAvailability,
} from "../../capabilities/notice_search.mjs";
import {
  MCP_NOTICE_SEARCH_ADAPTER,
  formatMcpNoticeSearchResult,
  handleMcp,
  mcpNoticeSearchInput,
} from "../src/mcp.mjs";
import {
  SEARCH_NOTICE_ADAPTER,
  noticeSearchInputFromKeywordResolution,
} from "../src/search.mjs";
import { workerD1NoticeSearch } from "../src/lib/notices.mjs";
import worker from "../src/worker.mjs";

const NOTICE_SCHEMA = readFileSync(new URL("../migrations/0001_notices.sql", import.meta.url), "utf8");
const FACTS_SCHEMA = readFileSync(new URL("../migrations/0010_notice_facts.sql", import.meta.url), "utf8");
const FTS_SCHEMA = readFileSync(new URL("../migrations/0016_notice_fts.sql", import.meta.url), "utf8");

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

function database({ fts = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(NOTICE_SCHEMA);
  sqlite.exec(FACTS_SCHEMA);
  if (fts) sqlite.exec(FTS_SCHEMA);
  const statement = sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, category, short_title, description,
     start_date, haystack, document_urls, n_documents, structured_facts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, '{}')`);
  statement.run(
    "20260818001",
    "Agency Rules",
    "Buildings",
    "Notice",
    "Safety",
    "Sidewalk shed safety",
    "Pedestrian protection around construction scaffolding.",
    "2026-08-18",
    "sidewalk shed safety pedestrian protection construction scaffolding",
  );
  return {
    sqlite,
    DB: {
      prepare(sql) {
        if (/FROM notice_attachments/.test(sql)) {
          return { bind() { return this; }, async all() { return { results: [] }; } };
        }
        const prepared = sqlite.prepare(sql);
        let args = [];
        const wrapper = {
          bind(...values) { args = values; return wrapper; },
          async all() {
            const results = prepared.all(...args);
            return { results, meta: { rows_read: results.length } };
          },
          async first() { return prepared.get(...args) ?? null; },
        };
        return wrapper;
      },
    },
  };
}

function mcpPost(arguments_) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_notices", arguments: arguments_ },
    }),
  });
}

test("notice.search@1 invokes the D1 provider directly with provenance and no private haystack", async () => {
  const { sqlite, DB } = database();
  try {
    const result = await executeNoticeSearch(workerD1NoticeSearch(DB), {
      termGroups: [["construction", "scaffolding"]],
      section: "Agency Rules",
      limit: 5,
    });
    assert.equal(noticeSearchAvailability(result), "complete");
    assert.deepEqual(result.results.map(({ request_id }) => request_id), ["20260818001"]);
    assert.equal(result.results[0].match_provenance, "description");
    assert.equal(Object.hasOwn(result.results[0], "_haystack"), false);
    assert.deepEqual({
      method: result.retrieval.method,
      fallback_reason: result.retrieval.fallback_reason,
      rows_read: result.retrieval.rows_read,
      result_count: result.retrieval.result_count,
    }, {
      method: "fts5_bm25",
      fallback_reason: null,
      rows_read: 1,
      result_count: 1,
    });
  } finally {
    sqlite.close();
  }
});

test("the contract validates without cloning or widening the provider result", async () => {
  const result = {
    terms_used: [],
    total_matches: 0,
    retrieval: {
      method: "legacy_like",
      fallback_reason: null,
      duration_ms: 0,
      rows_read: 0,
      result_count: 0,
    },
    results: [],
  };
  const provider = {
    capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
    providerId: "worker-d1.notice-search",
    async execute() { return result; },
  };
  assert.equal(await executeNoticeSearch(provider, { termGroups: [], limit: 1 }), result);
  assert.equal(noticeSearchAvailability(result), "empty");
  assert.deepEqual(NOTICE_SEARCH_AVAILABILITY, ["complete", "empty", "unavailable"]);
});

test("canonical bounds and the exact FTS-unavailable fallback remain enforced", async () => {
  assert.equal(mcpNoticeSearchInput({ query: "rules", limit: 1000 }).limit, 100);
  await assert.rejects(
    () => executeNoticeSearch(workerD1NoticeSearch({}), { termGroups: [], limit: 101 }),
    /limit must be an integer from 1 through 100/,
  );
  const { sqlite, DB } = database({ fts: false });
  try {
    const result = await executeNoticeSearch(workerD1NoticeSearch(DB), {
      termGroups: [["scaffolding"]],
      limit: 5,
    });
    assert.equal(result.retrieval.method, "legacy_like_fallback");
    assert.equal(result.retrieval.fallback_reason, "fts_index_unavailable");
  } finally {
    sqlite.close();
  }
});

test("HTTP notice lane and MCP tool declare the same provider and preserve adapter meaning", async () => {
  assert.deepEqual({
    capability: SEARCH_NOTICE_ADAPTER.capabilityReference,
    provider: SEARCH_NOTICE_ADAPTER.providerId,
  }, {
    capability: MCP_NOTICE_SEARCH_ADAPTER.capabilityReference,
    provider: MCP_NOTICE_SEARCH_ADAPTER.providerId,
  });
  assert.deepEqual(
    noticeSearchInputFromKeywordResolution({
      retrieval_groups: [["scaffolding"]],
      structured_filters: { agency: null },
    }),
    { termGroups: [["scaffolding"]], agency: null, limit: 100 },
  );

  const { sqlite, DB } = database();
  const env = { DB, SUBS: new MockKV(), NL_METER: new MockKV() };
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    const direct = await executeNoticeSearch(workerD1NoticeSearch(DB), {
      termGroups: [["scaffolding"]],
      limit: 100,
    });
    const mcp = await (await handleMcp(mcpPost({ query: "scaffolding" }), env)).json();
    const http = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=scaffolding", {
        headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
      }),
      env,
      {},
    );
    const httpBody = await http.json();
    const directIds = direct.results.map(({ request_id }) => request_id);
    assert.deepEqual(directIds, ["20260818001"]);
    assert.match(mcp.result.content[0].text, /RequestID 20260818001/);
    assert.ok(httpBody.results.some(({ object_ref }) => object_ref === "notice:20260818001"));
    assert.equal(httpBody.schema, "cityscroll.keyword_search_response.v1");
    assert.equal(http.headers.get("Cache-Control"), "public, max-age=60, stale-while-revalidate=300");
    assert.ok(logs.some((line) => /"route":"mcp.search_notices"/.test(line)));
    assert.ok(logs.some((line) => /"route":"search"/.test(line)));
    assert.ok(logs.every((line) => !line.includes("scaffolding")));
  } finally {
    console.log = originalLog;
    sqlite.close();
  }
});

test("MCP text formatting remains byte-compatible", () => {
  const result = {
    results: [{
      request_id: "20260818001",
      date: "2026-08-18",
      agency: "Buildings",
      title: "Sidewalk shed safety",
      section: "Agency Rules",
      notice_type: "Notice",
      category: "Safety",
      contract_amount_display: null,
      vendor: null,
      due_date: null,
      deadline_note: null,
      snippet: "Pedestrian protection around construction scaffolding.",
    }],
  };
  assert.equal(formatMcpNoticeSearchResult(result), [
    "1. 2026-08-18 · Buildings · Sidewalk shed safety",
    "   Agency Rules · Notice · Safety",
    "   Pedestrian protection around construction scaffolding.",
    "   RequestID 20260818001 · https://cityscroll.org/notices/20260818001",
  ].join("\n"));
});
