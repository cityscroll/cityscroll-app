// /mcp endpoint: JSON-RPC shape, tool listing, D1-backed search, and the spend guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  handleMcp,
  MCP_CITED_PASSAGES_ADAPTER,
  MCP_NOTICE_SEARCH_ADAPTER,
  MCP_TOOL_BINDINGS,
} from "../src/mcp.mjs";

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

test("initialize + tools/list expose retrieval and action tools", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV() };
  const init = await (await handleMcp(post({ jsonrpc: "2.0", id: 1, method: "initialize" }), env)).json();
  assert.equal(init.result.serverInfo.name, "crol-list");
  const list = await (await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env)).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), [
    "search_federated",
    "search_notices",
    "get_notice",
    "get_entity_dossier",
    "get_entity_relationships",
    "retrieve_cited_passages",
    "get_contract",
    "browse_contracts",
    "analyze_contracts",
    "get_person_or_organization",
    "browse_organizations",
    "get_meeting",
    "get_land_project",
    "browse_land_projects",
    "get_land_decision_path",
    "preview_watch",
    "create_watch",
  ]);
  const cited = list.result.tools.find(({ name }) => name === "retrieve_cited_passages");
  assert.equal(cited.outputSchema.properties.schema.const, "cityscroll.semantic_retrieval.cited_passage_response.v1");
  const search = list.result.tools.find(({ name }) => name === "search_notices");
  assert.deepEqual(search.inputSchema, {
    type: "object", additionalProperties: false,
    properties: {
      query: { type: "string", description: "Keyword terms, space-separated (e.g. 'affordable housing')." },
      section: { type: "string", description: "Exact section, e.g. 'Procurement', 'Public Hearings and Meetings', 'Agency Rules'." },
      agency: { type: "string", description: "Agency name substring." },
      min_amount: { type: "number", description: "Minimum contract amount in dollars (Award notices only carry amounts)." },
      max_amount: { type: "number", description: "Maximum contract amount in dollars." },
      open_only: { type: "boolean", description: "Only notices whose due date hasn't passed." },
      exclude_rolling: { type: "boolean", description: "Drop pre-qualified-list placeholders (year-2090 'deadlines')." },
      limit: { type: "number", description: "Max results (default 15, cap 100)." },
    },
  });
  assert.equal(
    MCP_TOOL_BINDINGS.find(({ name }) => name === "search_notices").capabilityReference,
    "notice.search@1",
  );
  assert.equal(MCP_NOTICE_SEARCH_ADAPTER.capabilityReference, "notice.search@1");
  assert.equal(MCP_CITED_PASSAGES_ADAPTER.capabilityReference, "cited.passages.retrieve@1");
  assert.equal(
    MCP_TOOL_BINDINGS.find(({ name }) => name === "retrieve_cited_passages").capabilityReference,
    "cited.passages.retrieve@1",
  );
});

test("get_meeting delegates to the shared read-model capability and fails closed", async () => {
  const meeting = {
    object_type: "meeting",
    meeting_id: "meeting:city_record:mcp-fixture-1",
    source_system: "city_record",
    source_record_id: "mcp-fixture-1",
    title: "MCP meeting fixture",
    source_receipt: { schema: "cityscroll.meeting_source_receipt.v1", status: "ok", observed_at: "2026-08-15T12:00:00Z" },
    source_record: { source_system: "city_record", identifier: "mcp-fixture-1", receipt: { status: "ok" } },
  };
  const env = {
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
    ALERT_STATE: new MockKV(),
  };
  await env.ALERT_STATE.put("hearings:location:v1", JSON.stringify({
    schema: "cityscroll.shared_meeting_read_model.v1",
    version: 1,
    generated_at: "2026-08-15T12:00:00Z",
    freshness: { generated_at: "2026-08-15T12:00:00Z", checked_at: "2026-08-15T12:01:00Z" },
    sources: { city_record: { status: "available", row_count: 1 } },
    rows: [meeting],
  }));
  const success = await (await handleMcp(post({
    jsonrpc: "2.0", id: 24, method: "tools/call",
    params: { name: "get_meeting", arguments: { meeting_id: meeting.meeting_id } },
  }), env)).json();
  assert.equal(success.result.structuredContent.capability_reference, "meeting.get@1");
  assert.equal(success.result.structuredContent.meeting.meeting_id, meeting.meeting_id);
  assert.equal(success.result.structuredContent.coverage.state, "observed");
  assert.equal(success.result.structuredContent.freshness.as_of, "2026-08-15T12:00:00Z");

  const missing = await (await handleMcp(post({
    jsonrpc: "2.0", id: 25, method: "tools/call",
    params: { name: "get_meeting", arguments: { meeting_id: "meeting:city_record:missing" } },
  }), env)).json();
  assert.equal(missing.result.structuredContent.availability, "not_yet_public");
  assert.equal(missing.result.structuredContent.error, "not-found");
});

test("retrieve_cited_passages returns source-only structured citations", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV() };
  const response = await (await handleMcp(post({
    jsonrpc: "2.0", id: 21, method: "tools/call",
    params: {
      name: "retrieve_cited_passages",
      arguments: { query: "energy conservation", source_family: "city_record_notice", limit: 3 },
    },
  }), env)).json();

  assert.match(response.result.content[0].text, /1 source passage\./);
  assert.equal(
    response.result.structuredContent.schema,
    "cityscroll.semantic_retrieval.cited_passage_response.v1",
  );
  assert.equal(response.result.structuredContent.query, "energy conservation");
  assert.equal(response.result.structuredContent.retrieval.method, "lexical_fallback_v1");
  assert.equal(response.result.structuredContent.citations.length, 1);
  assert.ok(response.result.structuredContent.citations.every(({ exact_join_evidence: evidence }) => (
    evidence.state === "matched"
  )));
  assert.doesNotMatch(
    JSON.stringify(response.result.structuredContent),
    /(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship)/i,
  );
});

test("retrieve_cited_passages rejects invalid scope and respects the candidate kill switch", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV() };
  const invalid = await (await handleMcp(post({
    jsonrpc: "2.0", id: 22, method: "tools/call",
    params: {
      name: "retrieve_cited_passages",
      arguments: { query: "energy", source_family: "invented_source" },
    },
  }), env)).json();
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /not part of the cited retrieval corpus/);

  const disabled = await (await handleMcp(post({
    jsonrpc: "2.0", id: 23, method: "tools/call",
    params: { name: "retrieve_cited_passages", arguments: { query: "energy" } },
  }), { ...env, SEMANTIC_CANDIDATES_ENABLED: "false" })).json();
  assert.equal(disabled.result.isError, true);
  assert.match(disabled.result.content[0].text, /unavailable right now/);
  assert.equal(disabled.result.structuredContent, undefined);
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

// CS-11 · Scoped machine-client profiles, exercised through the endpoint itself.
// The profile contract lives in test/machine_client_profile.test.mjs; these cover the
// wiring: filtered discovery, enforced calls, and the profile-keyed quota bucket.

const PROFILE_BINDING = "MCP_CLIENT_PUBLIC_RESEARCH_TOKEN";
const PROFILE_SECRET = "EXAMPLE-ONLY-not-a-real-credential";

test("an authenticated profile discovers only its granted tools", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV(), [PROFILE_BINDING]: PROFILE_SECRET };
  const listed = await (await handleMcp(post(
    { jsonrpc: "2.0", id: 20, method: "tools/list" },
    { authorization: `Bearer ${PROFILE_SECRET}` },
  ), env)).json();
  const names = listed.result.tools.map((t) => t.name);
  assert.ok(names.includes("search_notices"), "granted reads stay discoverable");
  assert.ok(!names.includes("preview_watch"), "watch preview is not discoverable");
  assert.ok(!names.includes("create_watch"), "watch creation is not discoverable");
});

test("an anonymous caller still sees the full inventory", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV(), [PROFILE_BINDING]: PROFILE_SECRET };
  const listed = await (await handleMcp(post({ jsonrpc: "2.0", id: 21, method: "tools/list" }), env)).json();
  const names = listed.result.tools.map((t) => t.name);
  assert.ok(names.includes("create_watch"), "anonymous compatibility is unchanged");
});

test("an ungranted call is refused by identity, not by its arguments", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV(), [PROFILE_BINDING]: PROFILE_SECRET };
  const call = (headers) => post({
    jsonrpc: "2.0", id: 22, method: "tools/call",
    params: { name: "create_watch", arguments: { lens: "money", request: "big awards" } },
  }, headers);

  // The SAME payload, two identities. Anonymous reaches the tool and gets the tool's
  // own error; the profile never reaches it. That is what proves the refusal comes from
  // the grant rather than from argument validation.
  const anonymous = await (await handleMcp(call({}), env)).json();
  assert.equal(anonymous.result.isError, true);
  assert.match(anonymous.result.content[0].text, /isn't configured/);

  const named = await (await handleMcp(call({ authorization: `Bearer ${PROFILE_SECRET}` }), env)).json();
  assert.equal(named.result.isError, true);
  // Refusal is indistinguishable from an unknown tool: no discovery oracle for the
  // withheld inventory.
  assert.match(named.result.content[0].text, /Unknown tool/);
  assert.doesNotMatch(named.result.content[0].text, /isn't configured/);
});

test("a revoked profile credential fails closed rather than falling back to anonymous", async () => {
  const env = { SUBS: new MockKV(), NL_METER: new MockKV(), [PROFILE_BINDING]: PROFILE_SECRET };
  const res = await handleMcp(post(
    { jsonrpc: "2.0", id: 23, method: "ping" },
    { authorization: "Bearer rotated-away" },
  ), env);
  assert.equal(res.status, 401);
});

test("profile quota is keyed by profile, not by the connecting address", async () => {
  const env = {
    SUBS: new MockKV(), NL_METER: new MockKV(),
    MCP_MAX_PER_IP_DAY: "1", [PROFILE_BINDING]: PROFILE_SECRET,
  };
  const named = (ip) => post(
    { jsonrpc: "2.0", id: 24, method: "ping" },
    { authorization: `Bearer ${PROFILE_SECRET}`, "CF-Connecting-IP": ip },
  );
  // Two different addresses on one profile: the tiny per-address cap must not apply,
  // because the profile meters on its own id with its own much larger limit.
  assert.equal((await handleMcp(named("203.0.113.9"), env)).status, 200);
  assert.equal((await handleMcp(named("198.51.100.4"), env)).status, 200);
  assert.equal((await handleMcp(named("203.0.113.9"), env)).status, 200);

  // An anonymous caller on that same address still hits the per-address ceiling, so the
  // two buckets are provably separate.
  await handleMcp(post({ jsonrpc: "2.0", id: 25, method: "ping" }), env);
  const anonymous = await handleMcp(post({ jsonrpc: "2.0", id: 26, method: "ping" }), env);
  assert.equal(anonymous.status, 429);
});

test("profile telemetry is emitted content-free", async () => {
  const records = [];
  const env = {
    SUBS: new MockKV(), NL_METER: new MockKV(), [PROFILE_BINDING]: PROFILE_SECRET,
    MACHINE_CLIENT_TELEMETRY: { write: (record) => records.push(record) },
  };
  // A distinctive marker in the request: if any of it reaches the sink, the record is
  // carrying caller content it must never hold.
  const marker = "MARKER-request-content-must-not-be-recorded";
  await handleMcp(post({
    jsonrpc: "2.0", id: 27, method: "tools/call",
    params: { name: "create_watch", arguments: { lens: "money", request: marker } },
  }, { authorization: `Bearer ${PROFILE_SECRET}` }), env);

  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.profile_id, "public-research-read");
  assert.equal(record.error_class, "not_granted");
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(PROFILE_SECRET), "no credential in telemetry");
  assert.ok(!serialized.includes(marker), "no request content in telemetry");
  assert.ok(!serialized.includes("money"), "no argument values in telemetry");
});
