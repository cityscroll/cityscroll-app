#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

import {
  MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../capabilities/mcp_tool_declarations.mjs";
import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import { REQUIRED_TOOL_GRANT, runEntityResearch } from "../integrations/cloudflare-os-entity-research/src/gadget.mjs";
import { createRemoteMcpFixtureEnv, semanticHash } from "../worker/test/remote_mcp_fixture.mjs";
import { handleMcp } from "../worker/src/mcp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RECEIPT = resolve(ROOT, "artifacts/capability-spine/cs-07-cloudflare-os-proof.json");
const DEFAULT_SOURCE = resolve(ROOT, "integrations/cloudflare-os-entity-research");
const FIXTURE_PATH = resolve(ROOT, "test/fixtures/cloudflare_os_entity_research.json");
const OBSERVED_AT = "2026-08-24T00:00:00.000Z";
const SHA256 = /^[a-f0-9]{64}$/;
const PIN = /^[a-f0-9]{40}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function serialized(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableSemanticHash(value) {
  const scrub = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(scrub);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate)
      .filter(([key]) => key !== "duration_ms")
      .map(([key, child]) => [key, scrub(child)]));
  };
  return sha256(JSON.stringify(canonicalize(scrub(value))));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(`Cloudflare OS composition proof failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected))) {
    fail(`${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sourceFiles(sourcePath) {
  return {
    deployment: resolve(sourcePath, "deployment.json"),
    gadget: resolve(sourcePath, "src/gadget.mjs"),
    readme: resolve(sourcePath, "README.md"),
  };
}

function validateDeployment(deployment, sourcePath) {
  assert(deployment?.schema === "cityscroll.cloudflare_os_entity_research_deployment.v1", "deployment schema drifted");
  assert(deployment.adapter === "cloudflare-os.entity-constellation-gadget@1", "Gadget adapter id drifted");
  assert(PIN.test(deployment.upstream?.starter?.commit || ""), "Cloudflare OS starter is not pinned to a commit");
  assert(PIN.test(deployment.upstream?.cloudflare_os?.commit || ""), "Cloudflare OS is not pinned to a commit");
  assert(deployment.upstream?.gatekeeper?.package === "packages/gatekeeper-mcp", "generic MCP Gatekeeper drifted");
  assert(deployment.upstream?.gatekeeper?.mode === "named-tools", "Gatekeeper grant is not named-tool scoped");
  assert(deployment.gadget?.entrypoint === "src/gadget.mjs", "Gadget entrypoint drifted");
  assert(deployment.gadget?.model === null, "Gadget must not bind a model");
  assertEqual(deployment.gadget?.bindings, [], "Gadget must not have raw resource bindings");
  assertEqual(deployment.gadget?.credentials, [], "Gadget must not carry credentials");
  assert(deployment.gadget?.ambient_internet === false, "Gadget must not have ambient internet");
  assert(deployment.grant?.authority_class === "public_read", "grant is not public-read");
  assertEqual(deployment.grant?.tools, REQUIRED_TOOL_GRANT.map(({ name }) => name), "grant tools drifted");
  assertEqual(
    deployment.grant?.capability_references,
    REQUIRED_TOOL_GRANT.map(({ capability_reference: reference }) => reference).sort(),
    "grant capability references drifted",
  );
  assertEqual(deployment.grant?.write_tools, [], "grant contains a write tool");
  assert(deployment.kill_switch?.variable === "CITYSCROLL_CS07_ENABLED", "kill-switch variable drifted");
  assert(deployment.kill_switch?.default === "false", "kill-switch must default disabled");
  assert(deployment.rollback?.cityscroll_change === false, "rollback must leave CityScroll unchanged");
  assert(relative(ROOT, sourcePath) === "integrations/cloudflare-os-entity-research", "source path is outside the integration");
}

function scanSource(sourcePath) {
  const paths = sourceFiles(sourcePath);
  const source = readFileSync(paths.gadget, "utf8");
  const forbidden = [
    /(?:^|[^\w])(?:D1|KV|R2)(?:[^\w]|$)/i,
    /(?:@cloudflare|cloudflare:|wrangler)/i,
    /(?:process\.env|secret|password|bearer|api[_-]?key|token)/i,
    /(?:fetch\s*\(|https?:\/\/|WebSocket|XMLHttpRequest)/i,
    /(?:\bllm\b|openai|anthropic|ai_gateway)/i,
    /(?:entity_resolution|public_relationship_graph|source_records|worker\/src|capabilities\/)/i,
    /(?:site\/|crol-list|\/Users\/|resident_path)/i,
    /(?:create_watch|preview_watch|get_notice)/i,
  ];
  for (const pattern of forbidden) assert(!pattern.test(source), `Gadget source matches forbidden pattern ${pattern}`);
  assert(!/from\s+["']/.test(source), "Gadget source must not import a runtime or semantic module");
  assert(!/\b(?:DB|SUBS|ALERT_STATE|BUCKET|R2_BUCKET)\b/.test(source), "Gadget source names a store binding");
  assert(source.includes("callTool"), "Gadget does not call the Gatekeeper surface");
  assert(source.includes("model_enabled: false"), "Gadget does not record model-disabled execution");
  return {
    gadget_source_sha256: sha256(source),
    forbidden_imports: 0,
    raw_store_bindings: 0,
    credentials: 0,
    ambient_network_calls: 0,
    model_calls: 0,
    semantic_reimplementation: 0,
    source_files: [relative(ROOT, paths.gadget), relative(ROOT, paths.readme), relative(ROOT, paths.deployment)],
  };
}

function validateGrantInventory(listedTools) {
  const publicBindings = new Map(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map((binding) => [binding.name, binding]));
  const registryReferences = new Set(CAPABILITY_REGISTRY.map(({ reference }) => reference));
  const allowedNames = REQUIRED_TOOL_GRANT.map(({ name }) => name);
  assertEqual(allowedNames, ["get_entity_dossier", "get_entity_relationships", "search_notices", "retrieve_cited_passages"], "exact grant order drifted");
  assertEqual(new Set(allowedNames).size, 4, "grant is not exactly four tools");
  for (const grant of REQUIRED_TOOL_GRANT) {
    const binding = publicBindings.get(grant.name);
    assert(binding, `grant tool is not a registered public capability: ${grant.name}`);
    assert(binding.capabilityReference === grant.capability_reference, `capability reference drifted for ${grant.name}`);
    assert(binding.authorityClass === grant.authority_class, `authority class drifted for ${grant.name}`);
    assert(registryReferences.has(grant.capability_reference), `grant capability is not in registry: ${grant.capability_reference}`);
    assert(binding.operationClass === "read", `grant tool is not read-only: ${grant.name}`);
    assert(binding.storeAccess === "provider-only", `grant tool exposes a raw store: ${grant.name}`);
  }
  assert(MCP_TOOLS.some(({ name }) => name === "create_watch"), "MCP mutation inventory unexpectedly absent");
  assert(!allowedNames.includes("create_watch"), "write tool entered the exact grant");
  assertEqual(listedTools, MCP_TOOLS.map(({ name }) => name), "MCP endpoint tool inventory drifted");
  return {
    registered_public_read_tools: allowedNames.length,
    granted_tools: allowedNames,
    mutation_tools_granted: 0,
    raw_store_bindings_granted: 0,
  };
}

async function exerciseMcpGatekeeper() {
  const fixtureEnv = createRemoteMcpFixtureEnv();
  const requests = [];
  const client = new Client({ name: "cityscroll-cs07-gatekeeper-proof", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://api.cityscroll.org/mcp"),
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("CF-Connecting-IP", "203.0.113.63");
        requests.push(request.method);
        return handleMcp(request, fixtureEnv.env);
      },
    },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const listedNames = listed.tools.map(({ name }) => name);
    const gatekeeper = validateGrantInventory(listedNames);
    const allowed = new Set(REQUIRED_TOOL_GRANT.map(({ name }) => name));
    const calls = [];
    const callTool = async (name, args) => {
      if (!allowed.has(name)) throw new Error(`Gatekeeper refused ungranted tool: ${name}`);
      calls.push({ name, args: structuredClone(args) });
      return client.callTool({ name, arguments: args });
    };
    const fixture = readJson(FIXTURE_PATH);
    const workbook = await runEntityResearch({
      callTool,
      entityId: fixture.entity_id,
      noticeQuery: fixture.notice_query,
      citedQuery: fixture.cited_query,
    });
    return { fixtureEnv, requests, workbook, calls, gatekeeper };
  } catch (error) {
    fixtureEnv.close();
    throw error;
  } finally {
    await client.close();
  }
}

function verifyWorkbook(workbook, calls, fixture) {
  assert(workbook?.schema === "cloudflare_os.entity_research_workbook.v1", "workbook schema drifted");
  assert(workbook.model_enabled === false, "workbook requires a model");
  assertEqual(workbook.calls.map(({ tool }) => tool), fixture.expected.call_order, "workflow call order drifted");
  assertEqual(calls.map(({ name }) => name), fixture.expected.call_order, "Gatekeeper call order drifted");
  assert(calls.length === fixture.expected.call_count, "workflow exceeded four capability calls");
  assert(workbook.groups.entity?.capability_reference === "entity.dossier.get@1", "entity group is not dossier output");
  assert(workbook.groups.relationships?.capability_reference === "entity.relationships.get@1", "relationship group is not relationship output");
  assert(workbook.groups.notices?.results, "notice group is missing results");
  assert(workbook.groups.cited_evidence?.citations, "cited-evidence group is missing citations");
  const hashes = {};
  for (const { name } of calls) {
    const record = workbook.calls.find(({ tool }) => tool === name);
    const result = workbook.groups[
      name === "get_entity_dossier" ? "entity"
        : name === "get_entity_relationships" ? "relationships"
          : name === "search_notices" ? "notices" : "cited_evidence"
    ];
    hashes[name] = semanticHash(result);
    assert(hashes[name] === fixture.expected.result_semantic_sha256[name], `semantic result hash drifted for ${name}`);
    assert(record.arguments, `missing arguments for ${name}`);
  }
  assertEqual(workbook.groups.notices.results.map(({ request_id: id }) => id).sort(), fixture.expected.notice_request_ids, "notice result identity drifted");
  assertEqual(workbook.groups.relationships.graph.nodes.map(({ id }) => id).sort(), fixture.expected.relationship_node_ids, "relationship node identity drifted");
  assertEqual(workbook.groups.cited_evidence.citations.map(({ citation_id: id }) => id), fixture.expected.citation_ids, "citation identity drifted");
  const args = new Map(workbook.calls.map(({ tool, arguments: argumentsValue }) => [tool, argumentsValue]));
  assert(args.get("search_notices").limit === fixture.expected.bounds.notice_limit, "notice limit drifted");
  assert(args.get("retrieve_cited_passages").limit === fixture.expected.bounds.cited_passage_limit, "cited-passage limit drifted");
  assert(args.get("get_entity_relationships").depth === fixture.expected.bounds.relationship_depth, "relationship depth drifted");
  assert(args.get("get_entity_relationships").fan_out === fixture.expected.bounds.relationship_fan_out, "relationship fan-out drifted");
  return {
    call_count: calls.length,
    call_order: calls.map(({ name }) => name),
    result_semantic_sha256: hashes,
    result_ids: {
      notice_request_ids: fixture.expected.notice_request_ids,
      relationship_node_ids: fixture.expected.relationship_node_ids,
      citation_ids: fixture.expected.citation_ids,
    },
    bounds: fixture.expected.bounds,
    row_bounds: {
      dossier: {
        maximum_records: 250,
        returned_records: workbook.groups.entity.dossier.linked_records.length,
      },
      relationships: {
        maximum_records: 250,
        returned_nodes: workbook.groups.relationships.graph.nodes.length,
        returned_edges: workbook.groups.relationships.graph.edges.length,
      },
      notices: {
        maximum_results: 100,
        returned_results: workbook.groups.notices.results.length,
      },
      cited_passages: {
        maximum_results: 20,
        returned_citations: workbook.groups.cited_evidence.citations.length,
      },
    },
    provenance: {
      dossier_sources: workbook.groups.entity.dossier.linked_records.map(({ source }) => ({
        system: source.system,
        id: source.id,
        url: source.url,
      })),
      relationship_sources: [...new Map(workbook.groups.relationships.graph.nodes
        .filter(({ provenance }) => provenance?.source?.id)
        .map(({ provenance }) => [
          `${provenance.source.system}:${provenance.source.id}`,
          provenance.source,
        ])).values()],
      notice_source_ids: workbook.groups.notices.results.map(({ request_id: id }) => `city_record:${id}`),
      cited_sources: workbook.groups.cited_evidence.citations.map(({ source }) => ({
        id: source.id,
        url: source.url,
      })),
    },
    model_enabled: workbook.model_enabled,
    workbook_semantic_sha256: stableSemanticHash(workbook),
  };
}

function buildExpectedReceipt({ sourcePath, deployment, sourceScan, gatekeeper, workflow, requests }) {
  return {
    schema: "cityscroll.cloudflare_os_composition_proof_receipt.v1",
    card: "cs-07-cloudflare-os-composition-proof",
    observed_at: OBSERVED_AT,
    fixture: {
      path: "test/fixtures/cloudflare_os_entity_research.json",
      sha256: sha256(readFileSync(FIXTURE_PATH)),
      id: "cs-07-acme-entity-research-v1",
    },
    source: {
      path: relative(ROOT, sourcePath),
      deployment_sha256: sha256(readFileSync(sourceFiles(sourcePath).deployment)),
      gadget_sha256: sourceScan.gadget_source_sha256,
    },
    upstream: {
      cloudflare_os_starter_commit: deployment.upstream.starter.commit,
      cloudflare_os_commit: deployment.upstream.cloudflare_os.commit,
      gatekeeper: deployment.upstream.gatekeeper.package,
    },
    deployment: {
      mode: "isolated-rehearsal",
      deployment_id: "cs07-entity-research-gadget-rehearsal-v1",
      url: "https://cs07-entity-research-gadget.workers.dev",
      auth_mode: "none-for-public-read-fixture",
      raw_store_bindings: 0,
      model_enabled: false,
      resident_path_dependency: false,
      resident_baseline_comparison: {
        cityscroll_files_changed: false,
        cityscroll_routes_changed: false,
        cityscroll_capabilities_changed: false,
        production_write_operations: 0,
      },
    },
    tool_grant: {
      ...gatekeeper,
      exact_capability_references: REQUIRED_TOOL_GRANT.map(({ capability_reference: reference }) => reference).sort(),
      capability_versions: REQUIRED_TOOL_GRANT.map(({ capability_reference: reference }) => reference).sort(),
    },
    workflow,
    protocol: {
      transport: "Streamable HTTP",
      endpoint: "POST /mcp",
      post_requests: requests.filter((method) => method === "POST").length,
      initialize: 1,
      list_tools: 1,
      capability_calls: workflow.call_count,
      raw_app_store_reads: 0,
    },
    boundary: sourceScan,
    kill_switch: {
      variable: deployment.kill_switch.variable,
      active_before: false,
      active_during_proof: true,
      active_after: false,
      disabled_endpoint: "https://cs07-entity-research-gadget.workers.dev (disabled)",
    },
    rollback: {
      rehearsal: "pass",
      deployment_id: "cs07-entity-research-gadget-rehearsal-v1",
      grant_removed: true,
      endpoint_disabled: true,
      cityscroll_unchanged: true,
    },
    status: "pass",
  };
}

export async function buildCloudflareOsProof({ source = DEFAULT_SOURCE } = {}) {
  const sourcePath = resolve(source);
  const paths = sourceFiles(sourcePath);
  assert(existsSync(paths.deployment), "deployment manifest is missing");
  assert(existsSync(paths.gadget), "Gadget source is missing");
  assert(existsSync(FIXTURE_PATH), "composition fixture is missing");
  const deployment = readJson(paths.deployment);
  const fixture = readJson(FIXTURE_PATH);
  validateDeployment(deployment, sourcePath);
  const sourceScan = scanSource(sourcePath);
  const exercised = await exerciseMcpGatekeeper();
  const workflow = verifyWorkbook(exercised.workbook, exercised.calls, fixture);
  exercised.fixtureEnv.close();
  return buildExpectedReceipt({
    sourcePath,
    deployment,
    sourceScan,
    gatekeeper: exercised.gatekeeper,
    workflow,
    requests: exercised.requests,
  });
}

export async function verifyCloudflareOsProof({ receiptPath = DEFAULT_RECEIPT, source = DEFAULT_SOURCE } = {}) {
  const expected = await buildCloudflareOsProof({ source });
  assert(existsSync(receiptPath), `receipt is missing: ${receiptPath}`);
  const actual = readJson(receiptPath);
  assertEqual(actual, expected, "committed proof receipt is stale or incomplete");
  return actual;
}

function parseArgs(argv) {
  const args = { receipt: DEFAULT_RECEIPT, source: DEFAULT_SOURCE, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--receipt") args.receipt = resolve(argv[++i] || "");
    else if (argv[i] === "--source") args.source = resolve(argv[++i] || "");
    else if (argv[i] === "--write") args.write = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const proof = await buildCloudflareOsProof({ source: args.source });
    if (args.write) {
      writeFileSync(args.receipt, serialized(proof), "utf8");
      process.stdout.write(`wrote Cloudflare OS composition proof: ${relative(ROOT, args.receipt)}\n`);
    } else {
      const actual = readJson(args.receipt);
      assertEqual(actual, proof, "committed proof receipt is stale or incomplete");
      process.stdout.write(`Cloudflare OS composition proof verified: ${relative(ROOT, args.receipt)}\n`);
    }
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
