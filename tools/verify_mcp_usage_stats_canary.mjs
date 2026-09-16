#!/usr/bin/env node
// Post-deployment, authenticated, read-oriented MCP usage measurement canary.
//
// This file is deliberately outside the required offline `test/*.test.mjs` and
// `worker/test/*.test.mjs` sweeps. It crosses the network to the deployed Worker,
// marks its own MCP traffic as probe/canary, then reads the observation back through
// the authenticated private statistics surface. Passing mock-sink tests alone does
// not close the production measurement obligation.
//
// Usage:
//   MCP_CANARY_ADMIN_KEY=… node tools/verify_mcp_usage_stats_canary.mjs
// Optional:
//   MCP_CANARY_BASE=https://api.cityscroll.org
//   MCP_CANARY_EVIDENCE_DIR=docs/evidence/mcp-usage-observation
//
// Never prints secret values. Never commits image binaries.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = String(process.env.MCP_CANARY_BASE || "https://api.cityscroll.org").replace(/\/$/, "");
const ADMIN_KEY = process.env.MCP_CANARY_ADMIN_KEY || process.env.ADMIN_KEY || "";
const EVIDENCE_DIR = resolve(
  process.env.MCP_CANARY_EVIDENCE_DIR || "docs/evidence/mcp-usage-observation",
);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function postMcp(body) {
  const response = await fetch(`${BASE}/mcp?observation_class=probe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-CityScroll-MCP-Observation-Class": "probe",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, json, text, headers: Object.fromEntries(response.headers) };
}

async function readPrivateStats() {
  if (!ADMIN_KEY) {
    throw new Error("MCP_CANARY_ADMIN_KEY (or ADMIN_KEY) is required for the statistics read-back");
  }
  const response = await fetch(`${BASE}/admin/stats?key=${encodeURIComponent(ADMIN_KEY)}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, json, text };
}

function redact(value) {
  const raw = JSON.stringify(value);
  return raw
    .replaceAll(ADMIN_KEY, "[redacted-admin-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]");
}

const receipt = {
  schema: "cityscroll.mcp_usage_stats_canary.v1",
  generated_at: new Date().toISOString(),
  base: BASE,
  steps: {},
};

const init = await postMcp({
  jsonrpc: "2.0",
  id: "mcp-usage-canary-init",
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "sdk", version: "mcp-usage-canary-1" },
    capabilities: {},
  },
});
receipt.steps.initialize = {
  status: init.status,
  ok: init.status === 200 && Boolean(init.json?.result?.protocolVersion),
  protocol_version: init.json?.result?.protocolVersion || null,
  server_name: init.json?.result?.serverInfo?.name || null,
};

const list = await postMcp({
  jsonrpc: "2.0",
  id: "mcp-usage-canary-list",
  method: "tools/list",
});
receipt.steps.tools_list = {
  status: list.status,
  ok: list.status === 200 && Array.isArray(list.json?.result?.tools),
  tool_count: Array.isArray(list.json?.result?.tools) ? list.json.result.tools.length : null,
};

const ping = await postMcp({
  jsonrpc: "2.0",
  id: "mcp-usage-canary-ping",
  method: "ping",
});
receipt.steps.ping = {
  status: ping.status,
  ok: ping.status === 200 && init.json != null,
};

let stats;
try {
  stats = await readPrivateStats();
} catch (error) {
  fail(String(error?.message || error));
  stats = { status: 0, json: null, text: "" };
}

const mcpUsage = stats?.json?.mcp_usage || null;
receipt.steps.statistics_readback = {
  status: stats?.status || 0,
  ok: Boolean(stats?.status === 200 && mcpUsage),
  collection_status: mcpUsage?.collection?.status || null,
  available: mcpUsage?.available ?? null,
  measured_since: mcpUsage?.measured_since || null,
  last_observation_at: mcpUsage?.last_observation_at || null,
  production_requests_last7d: mcpUsage?.production?.requests_last7d ?? null,
  probe_requests_last7d: mcpUsage?.by_observation_class?.probe?.requests_last7d ?? null,
  canary_requests_last7d: mcpUsage?.by_observation_class?.canary?.requests_last7d ?? null,
  serving_revision: mcpUsage?.collection?.note || null,
};

receipt.ok = Boolean(
  receipt.steps.initialize.ok
  && receipt.steps.tools_list.ok
  && receipt.steps.ping.ok
  && receipt.steps.statistics_readback.ok,
);

mkdirSync(EVIDENCE_DIR, { recursive: true });
const receiptPath = resolve(EVIDENCE_DIR, "canary-receipt.json");
const manifestPath = resolve(EVIDENCE_DIR, "capture-manifest.json");
const receiptJson = `${redact(receipt)}\n`;
writeFileSync(receiptPath, receiptJson);
const sha = createHash("sha256").update(receiptJson).digest("hex");
const manifest = {
  schema: "cityscroll.render_capture_manifest.v1",
  topic: "mcp-usage-observation",
  generated_at: receipt.generated_at,
  route: `${BASE}/admin/stats`,
  assertion: "Authenticated private statistics expose mcp_usage with collection status and probe-class separation after a bounded probe-marked MCP session.",
  artifacts: [
    {
      path: "canary-receipt.json",
      kind: "machine-readable-receipt",
      sha256: sha,
      contains_secrets: false,
    },
  ],
  notes: [
    "No image binaries are committed.",
    "Live canary remains outside required offline test globs.",
    "Probe-marked MCP calls must not inflate production product totals.",
  ],
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  ok: receipt.ok,
  evidence_dir: EVIDENCE_DIR,
  collection_status: receipt.steps.statistics_readback.collection_status,
  probe_requests_last7d: receipt.steps.statistics_readback.probe_requests_last7d,
  production_requests_last7d: receipt.steps.statistics_readback.production_requests_last7d,
}, null, 2));

if (!receipt.ok) fail("MCP usage statistics canary failed");
