// MCP usage observation schema, collector, and private statistics fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  MCP_USAGE_COVERAGE_GAPS,
  MCP_USAGE_OBSERVATION_FIELDS,
  MCP_USAGE_OBSERVATION_SCHEMA,
  MCP_USAGE_TAXONOMY_VERSION,
  fingerprintToolCatalog,
  mcpUsageDataPoint,
  mcpUsageObservation,
  parseMcpUsageDataPoint,
  toolCallObservationFromTelemetry,
} from "../../capabilities/mcp_usage_observation.mjs";
import { machineClientTelemetry } from "../../capabilities/machine_client_profile.mjs";
import {
  buildMcpUsageSnapshot,
  deploymentIdentityFromEnv,
  emitMcpUsageObservation,
  mcpUsageCollectionStatus,
  mcpUsageIngestEnabled,
  readMcpUsageAnalytics,
  resolveMcpObservationClass,
} from "../src/lib/mcp_usage.mjs";
import { handleMcp } from "../src/mcp.mjs";
import { handlePrivateStats } from "../src/stats.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
}

function analyticsBinding(points) {
  return {
    writeDataPoint(point) {
      points.push(point);
    },
  };
}

function post(body, headers = {}, url = "https://api.cityscroll.org/mcp") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function signDevToken(secret, nowMs = Date.now()) {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", secret)
    .update(`crol-analytics-dev-exclusion\n${timestamp}`)
    .digest("base64url");
  return `v1.${timestamp}.${signature}`;
}

const SECRET = "x".repeat(32);
const SENTINEL = "SECRET-sentinel-must-never-persist";
const MARKER = "MARKER-high-cardinality-tool-name-abcdef0123456789";

test("observation schema is closed and drops high-cardinality and secret-shaped inputs", () => {
  const row = mcpUsageObservation({
    method: "tools/call",
    tool: MARKER,
    outcome: "success",
    observation_class: "production",
    deployment_identity: "not-a-sha",
    client_family: "Totally Novel Client With Secrets " + SENTINEL,
    client_version: SENTINEL,
    protocol_version: "nope",
    catalog_fingerprint: SENTINEL,
    profile_id: "not-a-real-profile",
    capability_reference: "notice.search@1",
    availability: "invented-availability",
    duration_ms: 12.7,
    result_count: 3,
    error_class: "none",
    prompt: SENTINEL,
    arguments: { q: SENTINEL },
    ip: "203.0.113.9",
    user_agent: "Mozilla/" + SENTINEL,
    exception: new Error(SENTINEL),
  });

  assert.deepEqual(Object.keys(row).sort(), [...MCP_USAGE_OBSERVATION_FIELDS].sort());
  assert.equal(row.schema, MCP_USAGE_OBSERVATION_SCHEMA);
  assert.equal(row.taxonomy_version, MCP_USAGE_TAXONOMY_VERSION);
  assert.equal(row.tool, "unknown");
  assert.equal(row.client_family, "other");
  assert.equal(row.client_version, "unknown");
  assert.equal(row.protocol_version, "unknown");
  assert.equal(row.catalog_fingerprint, "none");
  assert.equal(row.profile_id, "unknown");
  assert.equal(row.availability, "other");
  assert.equal(row.duration_ms, 13);
  assert.equal(row.deployment_identity, "unknown");

  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(SENTINEL));
  assert.ok(!serialized.includes(MARKER));
  assert.ok(!serialized.includes("203.0.113.9"));
  assert.ok(!serialized.includes("Mozilla"));
  assert.ok(!serialized.includes("prompt"));
  assert.ok(!("prompt" in row));
  assert.ok(!("arguments" in row));
  assert.ok(!("ip" in row));
  assert.ok(!("user_agent" in row));
  assert.ok(!("exception" in row));
});

test("registered tools and empty success keep their closed outcomes", () => {
  assert.equal(mcpUsageObservation({ method: "tools/call", tool: "search_notices", outcome: "empty_success" }).tool, "search_notices");
  assert.equal(mcpUsageObservation({ method: "tools/call", tool: "search_notices", outcome: "empty_success" }).outcome, "empty_success");
});

test("six-field telemetry adapter preserves the closed profile contract", () => {
  const telemetry = machineClientTelemetry({
    profileId: "public-research-read",
    capabilityReference: "notice.search@1",
    availability: "empty",
    durationMs: 40,
    count: 0,
    errorClass: "none",
  });
  const observation = toolCallObservationFromTelemetry(telemetry, {
    tool: "search_notices",
    observation_class: "production",
    deployment_identity: "a".repeat(40),
    emptySuccess: true,
  });
  assert.equal(observation.outcome, "empty_success");
  assert.equal(observation.profile_id, "public-research-read");
  assert.equal(observation.tool, "search_notices");
  assert.equal(observation.duration_ms, 40);
  assert.equal(observation.error_class, "none");
});

test("catalog fingerprint is deterministic over name, description, and schema", async () => {
  const tools = [
    { name: "b", description: "second", inputSchema: { type: "object" } },
    { name: "a", description: "first", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  ];
  const first = await fingerprintToolCatalog(tools);
  const second = await fingerprintToolCatalog([...tools].reverse());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{16}$/);
  const changed = await fingerprintToolCatalog([
    { name: "a", description: "first changed", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "b", description: "second", inputSchema: { type: "object" } },
  ]);
  assert.notEqual(first, changed);
});

test("missing binding is unconfigured, never zero traffic; kill switch disables writes", () => {
  assert.equal(mcpUsageCollectionStatus({}).status, "unconfigured");
  assert.equal(mcpUsageCollectionStatus({ USAGE_ANALYTICS: {} }).status, "unconfigured");
  const points = [];
  const env = {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: "production",
    MCP_USAGE_INGEST_ENABLED: "false",
  };
  assert.equal(mcpUsageIngestEnabled(env), false);
  assert.equal(mcpUsageCollectionStatus(env).status, "disabled");
  const result = emitMcpUsageObservation(env, {
    method: "ping",
    outcome: "success",
    observation_class: "production",
  });
  assert.equal(result.ok, false);
  assert.equal(points.length, 0);
});

test("collector writes one Analytics Engine point and survives a broken sink", () => {
  const points = [];
  const env = {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: "production",
    GIT_COMMIT_SHA: "b".repeat(40),
  };
  const ok = emitMcpUsageObservation(env, {
    method: "initialize",
    outcome: "success",
    observation_class: "production",
    deployment_identity: env.GIT_COMMIT_SHA,
    client_family: "claude",
    protocol_version: "2025-06-18",
  });
  assert.equal(ok.ok, true);
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[0], MCP_USAGE_OBSERVATION_SCHEMA);
  assert.equal(points[0].blobs[5], MCP_USAGE_TAXONOMY_VERSION);
  assert.equal(points[0].indexes[0], "mcp_usage");

  const broken = {
    USAGE_ANALYTICS: {
      writeDataPoint() { throw new Error(SENTINEL); },
    },
    ANALYTICS_ENVIRONMENT: "production",
  };
  const failed = emitMcpUsageObservation(broken, { method: "ping", outcome: "success" });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "write_failed");
});

test("data point round-trip keeps closed fields only", () => {
  const observation = mcpUsageObservation({
    method: "tools/call",
    tool: "get_notice",
    outcome: "success",
    observation_class: "canary",
    deployment_identity: "c".repeat(40),
    duration_ms: 9,
    result_count: 1,
  });
  const point = mcpUsageDataPoint(observation);
  const parsed = parseMcpUsageDataPoint(point.blobs, point.doubles);
  assert.equal(parsed.method, "tools/call");
  assert.equal(parsed.tool, "get_notice");
  assert.equal(parsed.outcome, "success");
  assert.equal(parsed.observation_class, "canary");
  assert.equal(parsed.duration_ms, 9);
  assert.equal(parsed.result_count, 1);
});

test("trusted developer exclusion and marked canary/probe classes resolve; spoofed developer does not", async () => {
  const nowMs = Date.now();
  const env = { ANALYTICS_ENVIRONMENT: "production", ANALYTICS_DEV_KEY: SECRET };
  const valid = await resolveMcpObservationClass(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "X-CROL-Analytics-Dev": signDevToken(SECRET, nowMs) }),
    env,
    nowMs,
  );
  assert.equal(valid, "developer");

  const spoofed = await resolveMcpObservationClass(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "X-CROL-Analytics-Dev": "v1.1.not-a-real-signature" }),
    env,
    nowMs,
  );
  assert.equal(spoofed, "production");

  const canary = await resolveMcpObservationClass(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "https://api.cityscroll.org/mcp?observation_class=canary"),
    env,
    nowMs,
  );
  assert.equal(canary, "canary");

  const probe = await resolveMcpObservationClass(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "X-CityScroll-MCP-Observation-Class": "probe" }),
    env,
    nowMs,
  );
  assert.equal(probe, "probe");
});

test("handleMcp records one observation per supported outcome through the real handler", async () => {
  const points = [];
  const env = {
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: "production",
    GIT_COMMIT_SHA: "d".repeat(40),
    MCP_MAX_PER_IP_DAY: "100",
  };

  // initialize
  assert.equal((await handleMcp(post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "1.2.3" } },
  }), env)).status, 200);

  // tools/list
  assert.equal((await handleMcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env)).status, 200);

  // malformed JSON
  assert.equal((await handleMcp(post("{not-json", {}), env)).status, 400);

  // unsupported method
  assert.equal((await handleMcp(post({ jsonrpc: "2.0", id: 3, method: "resources/list" }), env)).status, 200);

  // unknown tool (anonymous path returns application_error via toolError)
  const unknown = await handleMcp(post({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: MARKER, arguments: { q: SENTINEL } },
  }), env);
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).result?.isError, true);

  // application error on a registered tool with missing required input
  assert.equal((await handleMcp(post({
    jsonrpc: "2.0", id: 41, method: "tools/call",
    params: { name: "get_notice", arguments: {} },
  }), env)).status, 200);

  // unauthorized (endpoint-wide bearer required, wrong token)
  const authEnv = {
    ...env,
    SUBS: new MockKV(),
    USAGE_ANALYTICS: analyticsBinding(points),
    MCP_BEARER_TOKEN: "endpoint-secret",
  };
  assert.equal((await handleMcp(post(
    { jsonrpc: "2.0", id: 5, method: "ping" },
    { authorization: "Bearer wrong-token" },
  ), authEnv)).status, 401);

  // quota refusal (anonymous meter already used by earlier posts on same IP with cap 2;
  // prior successful posts also consume the meter — force with a tiny cap env clone)
  const quotaEnv = {
    ...env,
    SUBS: new MockKV(),
    USAGE_ANALYTICS: analyticsBinding(points),
    MCP_MAX_PER_IP_DAY: "1",
  };
  assert.equal((await handleMcp(post({ jsonrpc: "2.0", id: 6, method: "ping" }), quotaEnv)).status, 200);
  assert.equal((await handleMcp(post({ jsonrpc: "2.0", id: 7, method: "ping" }), quotaEnv)).status, 429);

  // method not allowed
  const getReq = new Request("https://api.cityscroll.org/mcp", { method: "GET" });
  assert.equal((await handleMcp(getReq, env)).status, 405);

  // notification ack
  assert.equal((await handleMcp(post({ jsonrpc: "2.0", method: "notifications/initialized" }), env)).status, 202);

  // broken sink must not change MCP success
  const brokenEnv = {
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
    USAGE_ANALYTICS: { writeDataPoint() { throw new Error(SENTINEL); } },
    ANALYTICS_ENVIRONMENT: "production",
  };
  const ping = await handleMcp(post({ jsonrpc: "2.0", id: 8, method: "ping" }), brokenEnv);
  assert.equal(ping.status, 200);

  // spoofed canary label is recorded as canary (operator marking) and never invents unique users
  const canaryPoints = [];
  const canaryEnv = {
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
    USAGE_ANALYTICS: analyticsBinding(canaryPoints),
    ANALYTICS_ENVIRONMENT: "production",
  };
  await handleMcp(post(
    { jsonrpc: "2.0", id: 9, method: "ping" },
    {},
    "https://api.cityscroll.org/mcp?observation_class=canary",
  ), canaryEnv);
  assert.equal(canaryPoints[0].blobs[4], "canary");

  const blobText = JSON.stringify(points);
  assert.ok(!blobText.includes(SENTINEL));
  assert.ok(!blobText.includes(MARKER));
  assert.ok(!blobText.includes("endpoint-secret"));
  assert.ok(!blobText.includes("203.0.113.9"));

  const methods = points.map((point) => point.blobs[1]);
  for (const expected of [
    "initialize", "tools/list", "parse_error", "unsupported_method",
    "tools/call", "unauthorized", "quota_refusal", "method_not_allowed", "notification",
  ]) {
    assert.ok(methods.includes(expected), `missing observation for ${expected}: ${methods.join(",")}`);
  }
  assert.ok(MCP_USAGE_COVERAGE_GAPS.length >= 3);
});

test("thrown tool errors record thrown_error without exception text", async () => {
  const points = [];
  const env = {
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: "production",
  };
  const res = await handleMcp(
    post({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "search_federated", arguments: { query: "parks" } },
    }),
    env,
    {
      federatedProvider: {
        async search() { throw new Error(SENTINEL + " stack"); },
      },
    },
  );
  const body = await res.json();
  assert.equal(body.error?.code, -32603);
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[1], "tools/call");
  assert.equal(points[0].blobs[2], "search_federated");
  assert.equal(points[0].blobs[3], "thrown_error");
  assert.ok(!JSON.stringify(points).includes(SENTINEL));
  assert.ok(!JSON.stringify(points).includes("stack"));
});

test("private stats expose MCP usage fold with production separated from canary", async () => {
  const now = new Date("2026-09-16T18:00:00Z");
  const rows = [
    {
      day: "2026-09-16",
      method: "tools/call",
      tool: "search_notices",
      outcome: "success",
      observation_class: "production",
      deployment_identity: "e".repeat(40),
      count: 4,
      duration_total_ms: 400,
      duration_samples: 4,
      last_timestamp: "2026-09-16 17:00:00",
    },
    {
      day: "2026-09-16",
      method: "tools/call",
      tool: "search_notices",
      outcome: "success",
      observation_class: "canary",
      deployment_identity: "e".repeat(40),
      count: 2,
      duration_total_ms: 100,
      duration_samples: 2,
      last_timestamp: "2026-09-16 17:05:00",
    },
    {
      day: "2026-09-10",
      method: "initialize",
      tool: "none",
      outcome: "success",
      observation_class: "production",
      count: 1,
      duration_total_ms: 5,
      duration_samples: 1,
      last_timestamp: "2026-09-10 12:00:00",
    },
  ];
  const folded = buildMcpUsageSnapshot(rows, { now, measuredSince: "2026-09-16" });
  assert.equal(folded.production.tool_calls_last7d, 4);
  assert.equal(folded.production.requests_last30d, 5);
  assert.equal(folded.by_observation_class.canary.tool_calls_last7d, 2);
  assert.equal(folded.production.by_tool_last30d.search_notices, 4);
  assert.equal(folded.by_observation_class.canary.by_tool_last30d.search_notices, 2);
  assert.ok(folded.sample_semantics.units.unique_people.includes("Not measured"));
  assert.equal(folded.last_observation_at, "2026-09-16 17:05:00");

  const res = await handlePrivateStats(
    new Request("https://api.cityscroll.org/admin/stats"),
    {
      ALERT_STATE: new MockKV(),
      NL_METER: new MockKV(),
      SUBS: new MockKV(),
    },
    {
      now,
      fetchImpl: async () => {
        throw new Error("no network in offline test");
      },
    },
  );
  const body = await res.json();
  assert.equal(body.mcp_usage.schema, "cityscroll.mcp_usage_stats.v1");
  assert.equal(body.mcp_usage.available, false);
  assert.ok(["unconfigured", "unavailable"].includes(body.mcp_usage.collection.status));
  assert.ok(!JSON.stringify(body.mcp_usage).includes(SENTINEL));
});

test("readMcpUsageAnalytics reports not-configured without inventing zeros as traffic", async () => {
  const snap = await readMcpUsageAnalytics({});
  assert.equal(snap.available, false);
  assert.equal(snap.collection.status, "unconfigured");
  assert.equal(snap.unavailable_reason, "not-configured");
  assert.equal(snap.production.requests_last7d, 0);
});

test("deployment identity stays unknown unless a full commit sha is configured", () => {
  assert.equal(deploymentIdentityFromEnv({}), "unknown");
  assert.equal(deploymentIdentityFromEnv({ GIT_COMMIT_SHA: "abc" }), "unknown");
  assert.equal(deploymentIdentityFromEnv({ GIT_COMMIT_SHA: "f".repeat(40) }), "f".repeat(40));
});
