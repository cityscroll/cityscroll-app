#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { CAPABILITY_REGISTRY } from "../../capabilities/registry.mjs";
import {
  MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../../capabilities/mcp_tool_declarations.mjs";
import { handleMcp } from "../src/mcp.mjs";
import {
  CAPABILITY_TOOL_CASES,
  createRemoteMcpFixtureEnv,
  directCapabilityResults,
  semanticHash,
} from "../test/remote_mcp_fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = resolve(ROOT, "artifacts/capability-spine/cs-06-remote-mcp.json");
const FIXTURE_PATH = resolve(ROOT, "test/fixtures/capability_semantic_scout.json");
const CLIENT_PACKAGE_PATH = resolve(ROOT, "worker/node_modules/@modelcontextprotocol/sdk/package.json");
const PROTOCOL_VERSION = "2025-06-18";
const OBSERVED_AT = "2026-08-19T00:00:00.000Z";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function serialize(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function capabilityByReference() {
  return new Map(CAPABILITY_REGISTRY.map((capability) => [capability.reference, capability]));
}

function countImports(paths, expression) {
  return paths.reduce((total, path) => (
    total + (readFileSync(resolve(ROOT, path), "utf8").match(expression) || []).length
  ), 0);
}

export async function buildRemoteMcpEvidenceReceipt() {
  const directFixture = createRemoteMcpFixtureEnv();
  const remoteFixture = createRemoteMcpFixtureEnv();
  const requests = [];
  const clientPackage = JSON.parse(readFileSync(CLIENT_PACKAGE_PATH, "utf8"));
  const client = new Client({ name: "cityscroll-cs06-proof", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://api.cityscroll.org/mcp"),
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("CF-Connecting-IP", "203.0.113.62");
        requests.push(request.method);
        return handleMcp(request, remoteFixture.env);
      },
    },
  );

  try {
    const direct = await directCapabilityResults(directFixture.env);
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const bindings = new Map(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map((binding) => [binding.name, binding]));
    const registry = capabilityByReference();
    const toolEvidence = [];
    for (const toolCase of CAPABILITY_TOOL_CASES) {
      const result = await client.callTool({ name: toolCase.name, arguments: toolCase.arguments });
      const binding = bindings.get(toolCase.name);
      const capability = registry.get(toolCase.capabilityReference);
      const directHash = semanticHash(direct.get(toolCase.name));
      const adapterHash = semanticHash(result.structuredContent);
      const reads = remoteFixture.reads.filter(({ capability_reference: reference }) => (
        reference === toolCase.capabilityReference
      ));
      toolEvidence.push({
        name: toolCase.name,
        capability_reference: toolCase.capabilityReference,
        adapter_id: binding.adapterId,
        provider_id: capability.provider.id,
        authority_class: binding.authorityClass,
        operation_class: binding.operationClass,
        annotations: tools.get(toolCase.name)?.annotations,
        bounds: binding.bounds,
        store_access: binding.storeAccess,
        calls: 1,
        store_read_operations: reads.length,
        store_rows_read: reads.reduce((total, read) => total + read.rows_read, 0),
        direct_semantic_sha256: directHash,
        adapter_semantic_sha256: adapterHash,
        parity: directHash === adapterHash ? "pass" : "fail",
      });
    }
    const publicNames = new Set(CAPABILITY_TOOL_CASES.map(({ name }) => name));
    const receipt = {
      schema: "cityscroll.remote_mcp_public_adapter_receipt.v1",
      card: "cs-06-remote-mcp-public-adapter",
      evidence_class: "local_protocol_interop",
      execution_environment: "node-intercepted-transport-fixture",
      evidence_notes: "Exercises the current MCP SDK client against handleMcp() with the client transport's fetch overridden to dispatch in-process. It proves protocol and semantic parity, not that a deployed https://api.cityscroll.org/mcp endpoint is reachable.",
      observed_at: OBSERVED_AT,
      fixture_sha256: sha256(readFileSync(FIXTURE_PATH)),
      protocol: {
        transport: "Streamable HTTP",
        negotiated_version: transport.protocolVersion,
        endpoint: "POST /mcp",
        stateless: true,
        authentication: "optional bearer; public-read proof uses none",
      },
      client: {
        package: "@modelcontextprotocol/sdk",
        version: clientPackage.version,
        transport: "StreamableHTTPClientTransport",
      },
      public_tool_inventory: toolEvidence,
      request_counts: {
        initialize: 1,
        list_tools: 1,
        capability_calls: toolEvidence.reduce((total, tool) => total + tool.calls, 0),
        post_requests: requests.filter((method) => method === "POST").length,
        optional_get_probe: requests.filter((method) => method === "GET").length,
      },
      policy_boundary: {
        registered_public_tools: toolEvidence.length,
        mutation_capabilities: toolEvidence.filter(({ operation_class: operation }) => operation !== "read").length,
        raw_store_bindings_exposed: toolEvidence.filter(({ store_access: access }) => access !== "provider-only").length,
        unregistered_public_tools: MCP_TOOLS.filter(({ name }) => (
          publicNames.has(name) && !bindings.has(name)
        )).length,
      },
      layers: {
        semantic_core: "capabilities/*.mjs plus explicit providers; transport-neutral",
        adapter_policy: "worker/src/mcp.mjs plus capabilities/mcp_tool_declarations.mjs",
        cloudflare_os_runtime: "downstream and not built by cs-06",
      },
      source_scan: {
        core_transport_imports: countImports(
          [
            "capabilities/notice_search.mjs",
            "capabilities/notice_get.mjs",
            "capabilities/entity_dossier.mjs",
            "capabilities/entity_relationships.mjs",
            "capabilities/cited_passages.mjs",
            "capabilities/federated_search.mjs",
          ],
          /from\s+["'][^"']*(?:modelcontextprotocol|agents\/mcp|mcp\.mjs)["']/gi,
        ),
        core_cloudflare_agents_imports: countImports(
          [
            "capabilities/notice_search.mjs",
            "capabilities/notice_get.mjs",
            "capabilities/entity_dossier.mjs",
            "capabilities/entity_relationships.mjs",
            "capabilities/cited_passages.mjs",
            "capabilities/federated_search.mjs",
          ],
          /from\s+["'][^"']*(?:@cloudflare|cloudflare\/agents|agents\/)[^"']*["']/gi,
        ),
        adapter_cloudflare_os_imports: countImports(
          ["worker/src/mcp.mjs", "capabilities/mcp_tool_declarations.mjs"],
          /from\s+["'][^"']*(?:cloudflare-os|gatekeeper-mcp)[^"']*["']/gi,
        ),
      },
      status: toolEvidence.length === CAPABILITY_TOOL_CASES.length
        && toolEvidence.every(({ parity }) => parity === "pass")
        ? "pass"
        : "fail",
    };
    return receipt;
  } finally {
    await client.close();
    directFixture.close();
    remoteFixture.close();
  }
}

export async function writeOrCheckRemoteMcpEvidence({ out = DEFAULT_OUT, check = false } = {}) {
  const serialized = serialize(await buildRemoteMcpEvidenceReceipt());
  if (check) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== serialized) {
      throw new Error(`${out} is stale; rebuild the remote MCP evidence receipt`);
    }
    process.stdout.write(`remote MCP evidence receipt is current: ${out}\n`);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serialized, "utf8");
    process.stdout.write(`wrote remote MCP evidence receipt: ${out}\n`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const check = process.argv.includes("--check");
    const outIndex = process.argv.indexOf("--out");
    const out = outIndex === -1 ? DEFAULT_OUT : resolve(process.argv[outIndex + 1] || "");
    await writeOrCheckRemoteMcpEvidence({ out, check });
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
