#!/usr/bin/env node

// CS-10 · External live MCP canary.
//
// Crosses public DNS to the deployed production MCP endpoint using the pinned
// current MCP SDK client with its default (real) transport. It never overrides
// fetch, never imports handleMcp() or any other CityScroll Worker or capability
// module, and never opens a fixture environment — the moment it could reach the
// handler directly it would stop testing the deployment (see CS-06/CS-07's
// corrective finding in the capability-spine card). The "generated deployed
// inventory" it diffs tools/list against is the build-time catalog JSON
// (site/data/mcp_tool_catalog.json), read as plain data, not as a module.
//
// GET /health's stamped GIT_COMMIT_SHA is the repository's existing, documented
// route-parity mechanism (docs/release/cloudflare-native-builds.md) for telling
// which deployment answered a probe; this canary reuses it rather than inventing
// a second identity channel. Do not exercise create_watch or preview_watch here.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

import { EVIDENCE_CLASSES, EXECUTION_ENVIRONMENTS } from "../capabilities/evidence_classification.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(ROOT, "site/data/mcp_tool_catalog.json");
const DEFAULT_OUT = resolve(ROOT, ".artifacts/cs-10-live-remote-mcp-canary.json");

const DEFAULT_MCP_ENDPOINT = "https://api.cityscroll.org/mcp";
const DEFAULT_HEALTH_ENDPOINT = "https://api.cityscroll.org/health";
const CLIENT_PACKAGE_PATH = resolve(ROOT, "worker/node_modules/@modelcontextprotocol/sdk/package.json");

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
// Never a real MCP tool name: proves the deployed endpoint's unknown-tool path
// fails cleanly rather than partially matching a registered capability.
const INVALID_TOOL_NAME = "cs10_canary_deliberately_invalid_tool";
const STACK_TRACE_LEAK_PATTERN = /(?:\bat\s+\S+\s*\(|\/Users\/|\/home\/|node_modules\/|\.mjs:\d+:\d+|TypeError:|ReferenceError:)/;

// Two fixed, non-resident-typed bounded reads. Neither argument is a resident
// query string: `section` is a closed City Record vocabulary term and the
// meeting id is an exact opaque object key confirmed live at authoring time.
// Assertions below accept any well-formed availability state (available,
// not_yet_public, unavailable) so a future read-model refresh that drops this
// exact row cannot flake the canary — only a malformed envelope or a server
// exception fails it.
const STATIC_READ = {
  tool: "get_meeting",
  arguments: {
    meeting_id: "meeting:community_board:0n1p7v3lr9f46s4au90rbl58hl_R20210405T230000@google.com::2031-02-03",
  },
};
const DATABASE_READ = {
  tool: "search_notices",
  arguments: { section: "Public Hearings and Meetings", limit: 1 },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fail(message) {
  throw new Error(`CS-10 live MCP canary failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

/** Loads the build-time generated tool catalog as plain data — no capability or Worker module import. */
function loadGeneratedDeployedInventory() {
  assert(existsSync(CATALOG_PATH), `generated deployed inventory is missing: site/data/mcp_tool_catalog.json (run node tools/build_capability_topology.mjs)`);
  const catalog = readJson(CATALOG_PATH);
  assert(catalog?.schema === "cityscroll.mcp_tool_catalog.v1", "generated tool catalog schema drifted");
  return catalog;
}

/**
 * A commit hash reported by a live /health probe is, on its own, exactly the
 * self-reported case A6 warns against. This repository already has an
 * independent corroboration available with no extra credential: the reported
 * commit must be a real object this checkout's git history actually contains.
 * A hash that cannot be resolved is recorded honestly as unverifiable, never
 * silently accepted.
 */
function commitExistsInHistory(commitSha) {
  if (!COMMIT_SHA_PATTERN.test(commitSha || "")) return false;
  try {
    execFileSync("git", ["cat-file", "-e", `${commitSha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(healthEndpoint) {
  const startedAt = Date.now();
  const response = await fetch(healthEndpoint, { method: "GET" });
  const durationMs = Date.now() - startedAt;
  const body = await response.json().catch(() => null);
  return {
    response_status: response.status,
    cf_ray: response.headers.get("cf-ray"),
    duration_ms: durationMs,
    commit: typeof body?.commit === "string" ? body.commit : null,
    environment: typeof body?.environment === "string" ? body.environment : null,
    commit_verified_in_git_history: commitExistsInHistory(body?.commit),
  };
}

/** One plain, un-overridden fetch — independent of the SDK transport — proving the raw HTTP surface answers too. */
async function probeRawPing(mcpEndpoint) {
  const startedAt = Date.now();
  const response = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cs10-raw-ping", method: "ping" }),
  });
  const durationMs = Date.now() - startedAt;
  const body = await response.json().catch(() => null);
  return {
    response_status: response.status,
    cf_ray: response.headers.get("cf-ray"),
    duration_ms: durationMs,
    well_formed_jsonrpc_result: Boolean(body && body.jsonrpc === "2.0" && body.result && !body.error),
  };
}

function diffToolInventory(liveTools, catalog) {
  const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
  const catalogByName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const missingFromLive = [...catalogByName.keys()].filter((name) => !liveByName.has(name));
  const unexpectedOnLive = [...liveByName.keys()].filter((name) => !catalogByName.has(name));
  const driftedTools = [];
  for (const [name, catalogTool] of catalogByName) {
    const liveTool = liveByName.get(name);
    if (!liveTool) continue;
    const descriptionMatches = liveTool.description === catalogTool.description;
    const inputSchemaMatches = stableJson(liveTool.inputSchema) === stableJson(catalogTool.input_schema);
    if (!descriptionMatches || !inputSchemaMatches) {
      driftedTools.push({ name, description_matches: descriptionMatches, input_schema_matches: inputSchemaMatches });
    }
  }
  return {
    generated_tool_count: catalogByName.size,
    live_tool_count: liveByName.size,
    missing_from_live: missingFromLive,
    unexpected_on_live: unexpectedOnLive,
    drifted_tools: driftedTools,
    matches: missingFromLive.length === 0 && unexpectedOnLive.length === 0 && driftedTools.length === 0,
  };
}

function envelopeIsWellFormed(structuredContent, requiredKeys) {
  if (!structuredContent || typeof structuredContent !== "object") return false;
  return requiredKeys.every((key) => Object.hasOwn(structuredContent, key));
}

export async function runLiveMcpCanary({
  mcpEndpoint = process.env.CS10_MCP_ENDPOINT || DEFAULT_MCP_ENDPOINT,
  healthEndpoint = process.env.CS10_HEALTH_ENDPOINT || DEFAULT_HEALTH_ENDPOINT,
} = {}) {
  const observedAt = new Date().toISOString();
  const catalog = loadGeneratedDeployedInventory();
  const clientPackage = readJson(CLIENT_PACKAGE_PATH);

  const health = await probeHealth(healthEndpoint);
  const rawPing = await probeRawPing(mcpEndpoint);

  // No fetch override: the transport's default (real) fetch is used untouched.
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint));
  const client = new Client({ name: "cityscroll-cs10-live-canary", version: "1.0.0" });

  const calls = [];
  const timedCall = async (label, fn) => {
    const startedAt = Date.now();
    const result = await fn();
    calls.push({ label, duration_ms: Date.now() - startedAt });
    return result;
  };
  // A JSON-RPC-level error (e.g. a transient upstream D1 outage) throws from
  // the SDK client rather than returning an isError tool result. That is a
  // genuine, reportable live-endpoint condition, not a bug in this canary —
  // catch it so the run finishes with an honest failing receipt instead of
  // crashing the process.
  const safeTimedCall = async (label, fn) => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      calls.push({ label, duration_ms: Date.now() - startedAt });
      return { ok: true, result };
    } catch (error) {
      calls.push({ label, duration_ms: Date.now() - startedAt });
      return { ok: false, error: { message: String(error?.message || error), code: typeof error?.code === "number" ? error.code : null } };
    }
  };

  try {
    await timedCall("initialize", () => client.connect(transport));
    const serverVersion = client.getServerVersion();
    const negotiatedProtocolVersion = transport.protocolVersion;

    const pong = await timedCall("ping", () => client.ping());

    const listed = await timedCall("tools/list", () => client.listTools());
    const inventory = diffToolInventory(listed.tools, catalog);

    const staticCall = await safeTimedCall(`tools/call:${STATIC_READ.tool}`, () => (
      client.callTool({ name: STATIC_READ.tool, arguments: STATIC_READ.arguments })
    ));
    const databaseCall = await safeTimedCall(`tools/call:${DATABASE_READ.tool}`, () => (
      client.callTool({ name: DATABASE_READ.tool, arguments: DATABASE_READ.arguments })
    ));
    const invalidCall = await safeTimedCall("tools/call:invalid", () => (
      client.callTool({ name: INVALID_TOOL_NAME, arguments: {} })
    ));

    const catalogByName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
    const staticEnvelope = staticCall.ok ? staticCall.result.structuredContent : null;
    const databaseEnvelope = databaseCall.ok ? databaseCall.result.structuredContent : null;
    const invalidText = invalidCall.ok ? (invalidCall.result.content || []).map((block) => block.text || "").join(" ") : invalidCall.error.message;

    const receipt = {
      schema: "cityscroll.live_remote_mcp_canary_receipt.v1",
      card: "cs-10-live-remote-mcp-canary",
      evidence_class: "external_live_endpoint",
      execution_environment: "external-network-observed",
      evidence_notes: "Crosses public DNS to the deployed production MCP endpoint via the pinned MCP SDK client with its unmodified default transport. The deployed commit is read from the Worker's own GET /health payload (this repository's existing route-parity mechanism, docs/release/cloudflare-native-builds.md) and cross-checked against this checkout's git history; it is not independently attested via a Cloudflare control-plane API call in this run.",
      observed_at: observedAt,
      endpoint: { mcp: mcpEndpoint, health: healthEndpoint },
      client: {
        package: "@modelcontextprotocol/sdk",
        version: clientPackage.version,
        transport: "StreamableHTTPClientTransport",
        fetch_overridden: false,
      },
      network_observation: {
        transport: "public-internet",
        dns_resolved: true,
        response_status: rawPing.response_status,
        fetch_override: false,
        transport_intercepted: false,
      },
      protocol: {
        transport: "Streamable HTTP",
        negotiated_version: negotiatedProtocolVersion,
        endpoint: "POST /mcp",
        raw_ping: {
          response_status: rawPing.response_status,
          well_formed_jsonrpc_result: rawPing.well_formed_jsonrpc_result,
          duration_ms: rawPing.duration_ms,
        },
        sdk_ping: {
          well_formed_result: pong !== undefined && pong !== null && typeof pong === "object",
        },
      },
      server_identity: {
        name: serverVersion?.name ?? null,
        version: serverVersion?.version ?? null,
        cf_ray: health.cf_ray,
      },
      deployment: {
        commit: health.commit,
        commit_shape_valid: COMMIT_SHA_PATTERN.test(health.commit || ""),
        commit_verified_in_git_history: health.commit_verified_in_git_history,
        environment: health.environment,
        health_response_status: health.response_status,
      },
      tool_inventory_drift: inventory,
      reads: [
        {
          role: "static_read",
          tool: STATIC_READ.tool,
          capability_reference: catalogByName.get(STATIC_READ.tool)?.capability_reference ?? null,
          store_access: catalogByName.get(STATIC_READ.tool)?.store_access ?? null,
          availability: staticEnvelope?.availability ?? null,
          envelope_well_formed: staticCall.ok && envelopeIsWellFormed(staticEnvelope, ["capability_reference", "availability", "error"]),
          is_error: staticCall.ok ? Boolean(staticCall.result.isError) : true,
          rpc_error: staticCall.ok ? null : staticCall.error,
        },
        {
          role: "database_backed_read",
          tool: DATABASE_READ.tool,
          capability_reference: catalogByName.get(DATABASE_READ.tool)?.capability_reference ?? null,
          store_access: "worker-d1.notice-search",
          result_count: Array.isArray(databaseEnvelope?.results) ? databaseEnvelope.results.length : null,
          envelope_well_formed: databaseCall.ok && envelopeIsWellFormed(databaseEnvelope, ["terms_used", "total_matches", "retrieval", "results"]),
          is_error: databaseCall.ok ? Boolean(databaseCall.result.isError) : true,
          rpc_error: databaseCall.ok ? null : databaseCall.error,
        },
      ],
      invalid_call: {
        requested_tool: INVALID_TOOL_NAME,
        // A clean failure means the deployed Worker itself handled the unknown
        // tool name and returned an ordinary isError tool result. An RPC-level
        // exception here (unlike on the two real reads above, where an upstream
        // outage is a legitimate live condition) would mean the server raised
        // instead of handling an unknown tool name — a genuine A7 violation.
        is_error: invalidCall.ok ? Boolean(invalidCall.result.isError) : false,
        failed_via_rpc_exception: !invalidCall.ok,
        response_looks_like_a_leak: STACK_TRACE_LEAK_PATTERN.test(invalidText),
      },
      durations_ms: Object.fromEntries(calls.map(({ label, duration_ms: durationMs }) => [label, durationMs])),
      status: null, // filled below, once every gate is known
    };

    receipt.status = (
      receipt.protocol.negotiated_version != null
      && receipt.tool_inventory_drift.matches
      && receipt.reads.every((read) => read.envelope_well_formed && !read.is_error)
      && receipt.invalid_call.is_error
      && !receipt.invalid_call.failed_via_rpc_exception
      && !receipt.invalid_call.response_looks_like_a_leak
    ) ? "pass" : "fail";

    return receipt;
  } finally {
    await client.close().catch(() => {});
  }
}

function serialize(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function parseArgs(argv) {
  const args = { write: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--out") args.out = resolve(argv[++i] || "");
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const receipt = await runLiveMcpCanary();
    // Belt-and-braces: this receipt's own evidence_class/execution_environment
    // must stay within CS-09's closed vocabulary, whether or not it also
    // satisfies that module's stricter provider-attested rank.
    if (!EVIDENCE_CLASSES.includes(receipt.evidence_class) || !EXECUTION_ENVIRONMENTS.includes(receipt.execution_environment)) {
      throw new Error("receipt evidence_class/execution_environment fell outside the CS-09 closed vocabulary");
    }
    if (args.write) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, serialize(receipt), "utf8");
      process.stdout.write(`wrote live MCP canary receipt: ${args.out}\n`);
    } else {
      process.stdout.write(`${serialize(receipt)}`);
    }
    if (receipt.status !== "pass") {
      console.error("CS-10 live MCP canary detected drift or a live-endpoint failure; see receipt status/fields above.");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
