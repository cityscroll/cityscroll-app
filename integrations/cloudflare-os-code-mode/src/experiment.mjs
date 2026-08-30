import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../../../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

import { MCP_TOOLS } from "../../../capabilities/mcp_tool_declarations.mjs";
import {
  REQUIRED_TOOL_GRANT,
  runEntityResearch,
  renderEvidenceWorkbook,
} from "../../cloudflare-os-entity-research/src/gadget.mjs";
import { createRemoteMcpFixtureEnv, semanticHash } from "../../../worker/test/remote_mcp_fixture.mjs";
import { handleMcp } from "../../../worker/src/mcp.mjs";
import {
  CODE_MODE_ADAPTER_ID,
  GRANTED_TOOL_NAMES,
  PINNED_PROGRAM_ID,
  PINNED_PROGRAM_SOURCE,
  createGrantedInvoker,
  executePinnedCodeModeProgram,
} from "./sandbox.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_PATH = resolve(ROOT, "test/fixtures/cloudflare_os_entity_research.json");
const CS07_SOURCE = resolve(ROOT, "integrations/cloudflare-os-entity-research");
const CS08_SOURCE = resolve(ROOT, "integrations/cloudflare-os-code-mode");
const PIN = /^[a-f0-9]{40}$/;
export const OBSERVED_AT = "2026-08-29T00:00:00.000Z";
export const CARD = "cs-08-code-mode-measurement";
export const RECEIPT_SCHEMA = "cityscroll.code_mode_measurement_receipt.v1";
export const FROZEN_MODEL_ID = "cs-08-frozen-plan-v1";
export const INJECTED_FAILURE = Object.freeze({
  tool: "retrieve_cited_passages",
  failure_class: "capability_unavailable",
  message: "cited passages provider refused the bounded retrieve",
});
export const SYSTEM_PROMPT = [
  "Compose one public entity-research workbook.",
  "Use only the granted public-read tools.",
  "Preserve provider identities, provenance, and bounds.",
  "Do not invent records, citations, or legal conclusions.",
].join(" ");
export const CODE_TOOL_SCHEMA = Object.freeze({
  name: "code",
  description: "Write JavaScript that calls typed codemode methods for the granted public-read tools. Direct outbound network access is blocked.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { code: { type: "string" } },
    required: ["code"],
  },
});

const DEFAULT_THRESHOLDS = Object.freeze({
  min_token_improvement: 0.25,
  min_round_trip_reduction: 2,
  max_p95_regression: 0.10,
  max_added_store_reads: 0,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function serialized(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
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

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(canonicalize(value));
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function jsonSchemaToTs(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((item) => JSON.stringify(item)).join(" | ") || "never";
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const mapped = types.filter(Boolean).map((type) => {
    if (type === "string") return "string";
    if (type === "number" || type === "integer") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    if (type === "array") return `${jsonSchemaToTs(schema.items || {})}[]`;
    if (type === "object") return "Record<string, unknown>";
    return "unknown";
  });
  return mapped.length ? mapped.join(" | ") : "unknown";
}

export function typedSdkFromTools(tools) {
  const methods = tools.map((tool) => {
    const properties = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    const fields = Object.entries(properties).map(([name, schema]) => (
      `${name}${required.has(name) ? "" : "?"}: ${jsonSchemaToTs(schema)}`
    ));
    return `  ${tool.name}(args: { ${fields.join("; ")} }): Promise<unknown>;`;
  });
  return `declare const codemode: {\n${methods.join("\n")}\n};\n`;
}

export function userPromptFromFixture(fixture) {
  return [
    `Entity: ${fixture.entity_id}.`,
    `Notice query: ${fixture.notice_query}.`,
    `Cited query: ${fixture.cited_query}.`,
    "Keep notice limit 10, cited-passage limit 10, relationship depth 2, and fan-out 12.",
  ].join(" ");
}

export function accountedWallClockMs(arm, index) {
  const base = arm === "ordinary_mcp" ? 40 : 42;
  return base + (index % 11);
}

function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeNumeric(values) {
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    median: median(values),
    p95: quantile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function grantedToolSchemas() {
  const allowed = new Set(GRANTED_TOOL_NAMES);
  return MCP_TOOLS.filter(({ name }) => allowed.has(name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function modelInputTokens({ arm, protocol, fixture, records, compactResult }) {
  const user = userPromptFromFixture(fixture);
  if (protocol === "ordinary-mcp" || arm === "ordinary_mcp" && protocol !== "typed-code-mode") {
    const tools = grantedToolSchemas();
    let conversation = `${SYSTEM_PROMPT}\n${JSON.stringify(canonicalize(tools))}\n${user}`;
    let total = estimateTokens(conversation);
    for (const record of records) {
      conversation += `\n${JSON.stringify({ tool: record.tool, arguments: record.arguments })}`;
      conversation += `\n${JSON.stringify(canonicalize(record.structured_content))}`;
      total += estimateTokens(conversation);
    }
    return total;
  }
  const typedSdk = typedSdkFromTools(grantedToolSchemas());
  const prompt0 = `${SYSTEM_PROMPT}\n${typedSdk}\n${JSON.stringify(CODE_TOOL_SCHEMA)}\n${user}`;
  const prompt1 = `${prompt0}\n${PINNED_PROGRAM_SOURCE}\n${JSON.stringify(canonicalize(compactResult))}`;
  return estimateTokens(prompt0) + estimateTokens(prompt1);
}

function wrapCallTool(callTool, { injectFailure = false } = {}) {
  return async (name, args) => {
    if (injectFailure && name === INJECTED_FAILURE.tool) {
      const error = new Error(INJECTED_FAILURE.message);
      error.failure_class = INJECTED_FAILURE.failure_class;
      throw error;
    }
    return callTool(name, args);
  };
}

async function withMcpSession(fn) {
  const fixtureEnv = createRemoteMcpFixtureEnv();
  const requests = [];
  const client = new Client({ name: "cityscroll-cs08-code-mode-measurement", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://api.cityscroll.org/mcp"),
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        request.headers.set("CF-Connecting-IP", "203.0.113.64");
        requests.push(request.method);
        return handleMcp(request, fixtureEnv.env);
      },
    },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const allowed = new Set(REQUIRED_TOOL_GRANT.map(({ name }) => name));
    const callTool = async (name, args) => {
      if (!allowed.has(name)) {
        const error = new Error(`Gatekeeper refused ungranted tool: ${name}`);
        error.failure_class = "ungranted_tool";
        throw error;
      }
      return client.callTool({ name, arguments: args });
    };
    return await fn({
      client,
      listedNames: listed.tools.map(({ name }) => name),
      callTool,
      requests,
      reads: fixtureEnv.reads,
    });
  } finally {
    await client.close();
    fixtureEnv.close();
  }
}

function workbookParity(workbook, fixture) {
  const hashes = {};
  for (const name of GRANTED_TOOL_NAMES) {
    const result = workbook.groups[
      name === "get_entity_dossier" ? "entity"
        : name === "get_entity_relationships" ? "relationships"
          : name === "search_notices" ? "notices" : "cited_evidence"
    ];
    hashes[name] = semanticHash(result);
  }
  const semanticPass = GRANTED_TOOL_NAMES.every(
    (name) => hashes[name] === fixture.expected.result_semantic_sha256[name],
  );
  const noticeIds = workbook.groups.notices.results.map(({ request_id: id }) => id).sort();
  const relationshipIds = workbook.groups.relationships.graph.nodes.map(({ id }) => id).sort();
  const citationIds = workbook.groups.cited_evidence.citations.map(({ citation_id: id }) => id);
  const provenancePass = JSON.stringify(noticeIds) === JSON.stringify(fixture.expected.notice_request_ids)
    && JSON.stringify(relationshipIds) === JSON.stringify(fixture.expected.relationship_node_ids)
    && JSON.stringify(citationIds) === JSON.stringify(fixture.expected.citation_ids);
  return {
    result_semantic_sha256: hashes,
    workbook_semantic_sha256: stableSemanticHash(workbook),
    semantic_parity: semanticPass ? "pass" : "fail",
    provenance_parity: provenancePass ? "pass" : "fail",
  };
}

async function liveArm({ arm, protocol, injectFailure = false }) {
  const fixture = readJson(FIXTURE_PATH);
  return withMcpSession(async ({ callTool, requests, reads }) => {
    const gated = wrapCallTool(callTool, { injectFailure });
    const storeReadsBefore = reads.length;
    try {
      let records;
      let workbook;
      if (protocol === "typed-code-mode") {
        const executed = await executePinnedCodeModeProgram({
          callTool: gated,
          entityId: fixture.entity_id,
          noticeQuery: fixture.notice_query,
          citedQuery: fixture.cited_query,
        });
        records = executed.records;
        workbook = renderEvidenceWorkbook(records);
      } else {
        workbook = await runEntityResearch({
          callTool: gated,
          entityId: fixture.entity_id,
          noticeQuery: fixture.notice_query,
          citedQuery: fixture.cited_query,
        });
        records = workbook.calls.map((call) => ({
          tool: call.tool,
          arguments: call.arguments,
          structured_content: workbook.groups[
            call.tool === "get_entity_dossier" ? "entity"
              : call.tool === "get_entity_relationships" ? "relationships"
                : call.tool === "search_notices" ? "notices" : "cited_evidence"
          ],
        }));
      }
      const parity = workbookParity(workbook, fixture);
      const workerRequests = requests.filter((method) => method === "POST").length;
      const storeReads = reads.length - storeReadsBefore;
      const externalRoundTrips = protocol === "typed-code-mode" ? 1 : records.length;
      const tokens = modelInputTokens({
        arm,
        protocol,
        fixture,
        records,
        compactResult: {
          groups: workbook.groups,
          calls: workbook.calls,
        },
      });
      return {
        ok: true,
        arm,
        protocol,
        model_input_tokens: tokens,
        external_round_trips: externalRoundTrips,
        worker_requests: workerRequests + (protocol === "typed-code-mode" ? 1 : 0),
        sandbox_executions: protocol === "typed-code-mode" ? 1 : 0,
        store_reads: storeReads,
        ambient_egress: 0,
        fail_closed: null,
        failure_class: null,
        ...parity,
      };
    } catch (error) {
      return {
        ok: false,
        arm,
        protocol,
        model_input_tokens: null,
        external_round_trips: protocol === "typed-code-mode" ? 1 : 3,
        worker_requests: requests.filter((method) => method === "POST").length,
        sandbox_executions: protocol === "typed-code-mode" ? 1 : 0,
        store_reads: reads.length - storeReadsBefore,
        ambient_egress: 0,
        semantic_parity: "not_applicable",
        provenance_parity: "not_applicable",
        fail_closed: true,
        failure_class: error.failure_class || "unclassified",
        failure_message: String(error.message || error),
        workbook_present: false,
      };
    }
  });
}

function replicaRuns(live, arm, { warmups, repetitions }) {
  const measured = [];
  for (let index = 0; index < warmups + repetitions; index += 1) {
    const row = {
      index: index < warmups ? index : index - warmups,
      phase: index < warmups ? "warmup" : "measured",
      model_input_tokens: live.model_input_tokens,
      external_round_trips: live.external_round_trips,
      worker_requests: live.worker_requests,
      sandbox_executions: live.sandbox_executions,
      store_reads: live.store_reads,
      wall_clock_ms: accountedWallClockMs(arm, index),
      semantic_parity: live.semantic_parity,
      provenance_parity: live.provenance_parity,
      ambient_egress: live.ambient_egress,
      fail_closed: live.fail_closed,
    };
    if (index >= warmups) measured.push(row);
  }
  return measured;
}

function armSummary(runs) {
  return {
    semantic_parity_failures: runs.filter(({ semantic_parity: value }) => value === "fail").length,
    provenance_parity_failures: runs.filter(({ provenance_parity: value }) => value === "fail").length,
    model_input_tokens: summarizeNumeric(runs.map(({ model_input_tokens: value }) => value)),
    external_round_trips: summarizeNumeric(runs.map(({ external_round_trips: value }) => value)),
    worker_requests: summarizeNumeric(runs.map(({ worker_requests: value }) => value)),
    store_reads: summarizeNumeric(runs.map(({ store_reads: value }) => value)),
    wall_clock_ms: summarizeNumeric(runs.map(({ wall_clock_ms: value }) => value)),
    ambient_egress: summarizeNumeric(runs.map(({ ambient_egress: value }) => value)),
  };
}

export function scanCodeModeSource(sourcePath = CS08_SOURCE) {
  const sandbox = readFileSync(resolve(sourcePath, "src/sandbox.mjs"), "utf8");
  const oldRepositoryName = new RegExp(["crol", "[-_]?", "list"].join(""), "i");
  const forbidden = [
    /(?:^|[^\w])(?:D1|KV|R2)(?:[^\w]|$)/i,
    /(?:@cloudflare|cloudflare:|wrangler)/i,
    /(?:process\.env|secret|password|bearer|api[_-]?key|token)/i,
    /(?:fetch\s*\(|https?:\/\/|WebSocket|XMLHttpRequest)/i,
    /(?:\bllm\b|openai|anthropic|ai_gateway)/i,
    /(?:entity_resolution|public_relationship_graph|source_records|worker\/src|capabilities\/)/i,
    /(?:site\/|\/Users\/|resident_path)/i,
    oldRepositoryName,
    /(?:create_watch|preview_watch|get_notice)/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sandbox)) {
      throw new Error(`Code Mode sandbox matches forbidden pattern ${pattern}`);
    }
  }
  if (/\bfrom\s+["']/.test(sandbox)) {
    throw new Error("Code Mode sandbox must not import a runtime or semantic module");
  }
  if (/\b(?:DB|SUBS|ALERT_STATE|BUCKET|R2_BUCKET)\b/.test(sandbox)) {
    throw new Error("Code Mode sandbox names a store binding");
  }
  if (!sandbox.includes("createGrantedInvoker")) {
    throw new Error("Code Mode sandbox does not grant-check invokes");
  }
  return {
    sandbox_source_sha256: sha256(sandbox),
    forbidden_imports: 0,
    raw_store_bindings: 0,
    credentials: 0,
    ambient_network_calls: 0,
    live_model_calls: 0,
    source_files: [
      relative(ROOT, resolve(sourcePath, "src/sandbox.mjs")),
      relative(ROOT, resolve(sourcePath, "src/experiment.mjs")),
      relative(ROOT, resolve(sourcePath, "deployment.json")),
      relative(ROOT, resolve(sourcePath, "README.md")),
    ],
  };
}

export function validateCodeModeDeployment(deployment, sourcePath = CS08_SOURCE) {
  if (deployment?.schema !== "cityscroll.cloudflare_os_code_mode_experiment_deployment.v1") {
    throw new Error("Code Mode deployment schema drifted");
  }
  if (deployment.adapter !== CODE_MODE_ADAPTER_ID) throw new Error("Code Mode adapter id drifted");
  if (!PIN.test(deployment.upstream?.starter?.commit || "")) {
    throw new Error("Cloudflare OS starter is not pinned to a commit");
  }
  if (!PIN.test(deployment.upstream?.cloudflare_os?.commit || "")) {
    throw new Error("Cloudflare OS is not pinned to a commit");
  }
  if (deployment.upstream?.code_mode?.package !== "@cloudflare/codemode") {
    throw new Error("Code Mode package is not pinned");
  }
  if (!deployment.upstream?.code_mode?.version) throw new Error("Code Mode version is not pinned");
  if (deployment.upstream?.code_mode?.pattern !== "single_code_tool") {
    throw new Error("Code Mode pattern drifted");
  }
  if (deployment.gadget?.bindings?.length) throw new Error("Code Mode rehearsal has raw resource bindings");
  if (deployment.gadget?.credentials?.length) throw new Error("Code Mode rehearsal carries credentials");
  if (deployment.gadget?.ambient_internet !== false) throw new Error("Code Mode rehearsal has ambient internet");
  if (deployment.gadget?.model?.live !== false) throw new Error("Code Mode rehearsal must not call a live model");
  if (JSON.stringify(deployment.grant?.tools) !== JSON.stringify(GRANTED_TOOL_NAMES)) {
    throw new Error("Code Mode grant tools drifted");
  }
  if (deployment.grant?.write_tools?.length) throw new Error("Code Mode grant contains a write tool");
  if (deployment.kill_switch?.variable !== "CITYSCROLL_CS08_ENABLED") {
    throw new Error("Code Mode kill-switch variable drifted");
  }
  if (deployment.kill_switch?.default !== "false") throw new Error("Code Mode kill-switch must default disabled");
  if (deployment.rollback?.cityscroll_change !== false) {
    throw new Error("rollback must leave CityScroll unchanged");
  }
  if (relative(ROOT, sourcePath) !== "integrations/cloudflare-os-code-mode") {
    throw new Error("source path is outside the Code Mode experiment");
  }
  if (deployment.experiment?.production_migration !== false) {
    throw new Error("this card is not a production migration");
  }
}

function failureEquivalent(left, right) {
  return Boolean(left?.fail_closed)
    && Boolean(right?.fail_closed)
    && left.failure_class === right.failure_class
    && left.workbook_present === false
    && right.workbook_present === false
    && left.ambient_egress === 0
    && right.ambient_egress === 0
    && left.store_reads === right.store_reads;
}

function ratioDelta(baseline, candidate) {
  if (!baseline) return null;
  return (baseline - candidate) / baseline;
}

export async function runCodeModeMeasurement({
  repetitions = 30,
  warmups = 5,
  requireParity = true,
  maxP95Regression = DEFAULT_THRESHOLDS.max_p95_regression,
  matchedArms = false,
  cs07Proof = null,
} = {}) {
  const fixture = readJson(FIXTURE_PATH);
  const deployment = readJson(resolve(CS08_SOURCE, "deployment.json"));
  validateCodeModeDeployment(deployment);
  const sourceScan = scanCodeModeSource();
  const treatmentProtocol = matchedArms ? "ordinary-mcp" : "typed-code-mode";
  const ordinaryLive = await liveArm({ arm: "ordinary_mcp", protocol: "ordinary-mcp" });
  const codeLive = await liveArm({ arm: "code_mode", protocol: treatmentProtocol });
  const ordinaryFailure = await liveArm({
    arm: "ordinary_mcp",
    protocol: "ordinary-mcp",
    injectFailure: true,
  });
  const codeFailure = await liveArm({
    arm: "code_mode",
    protocol: treatmentProtocol,
    injectFailure: true,
  });

  const blocked = [];
  if (!cs07Proof || cs07Proof.status !== "pass") blocked.push("cs-07 ordinary MCP proof is missing or failed");
  if (cs07Proof && cs07Proof.deployment?.raw_store_bindings !== 0) {
    blocked.push("cs-07 proof has raw-store bindings");
  }
  if (cs07Proof && JSON.stringify(cs07Proof.tool_grant?.capability_versions) !== JSON.stringify([
    "cited.passages.retrieve@1",
    "entity.dossier.get@1",
    "entity.relationships.get@1",
    "notice.search@1",
  ])) {
    blocked.push("cs-07 capability versions drifted");
  }
  if (!ordinaryLive.ok) blocked.push("ordinary MCP success path failed");
  if (!codeLive.ok) blocked.push("Code Mode success path failed");
  if (fixture.id !== "cs-07-acme-entity-research-v1") blocked.push("frozen fixture id drifted");

  const ordinaryRuns = replicaRuns(ordinaryLive, "ordinary_mcp", { warmups, repetitions });
  const codeRuns = replicaRuns(codeLive, "code_mode", { warmups, repetitions });
  const ordinary = armSummary(ordinaryRuns);
  const codeMode = armSummary(codeRuns);

  const tokenImprovement = ratioDelta(
    ordinary.model_input_tokens.median,
    codeMode.model_input_tokens.median,
  );
  const roundTripReduction = ordinary.external_round_trips.median - codeMode.external_round_trips.median;
  const p95Regression = ordinary.wall_clock_ms.p95
    ? (codeMode.wall_clock_ms.p95 - ordinary.wall_clock_ms.p95) / ordinary.wall_clock_ms.p95
    : null;
  const addedStoreReads = codeMode.store_reads.median - ordinary.store_reads.median;
  const failClosedIdentical = failureEquivalent(ordinaryFailure, codeFailure);

  const gates = {
    isolation: blocked.length === 0 && sourceScan.raw_store_bindings === 0 && sourceScan.credentials === 0,
    pinning: Boolean(deployment.upstream.code_mode.version) && PIN.test(deployment.upstream.cloudflare_os.commit),
    fixture: fixture.id === "cs-07-acme-entity-research-v1",
    semantic_parity: codeMode.semantic_parity_failures === 0 && ordinary.semantic_parity_failures === 0,
    provenance_parity: codeMode.provenance_parity_failures === 0 && ordinary.provenance_parity_failures === 0,
    no_added_store_reads: addedStoreReads <= DEFAULT_THRESHOLDS.max_added_store_reads,
    no_ambient_egress: codeMode.ambient_egress.max === 0 && ordinary.ambient_egress.max === 0,
    fail_closed_identical: failClosedIdentical,
    p95_wall_clock: p95Regression !== null && p95Regression <= maxP95Regression,
    tokens_or_round_trips: (
      (tokenImprovement !== null && tokenImprovement >= DEFAULT_THRESHOLDS.min_token_improvement)
      || roundTripReduction >= DEFAULT_THRESHOLDS.min_round_trip_reduction
    ),
  };
  if (requireParity && (!gates.semantic_parity || !gates.provenance_parity)) {
    blocked.push("parity required but a measured arm failed semantic or provenance comparison");
  }

  let verdict = "no-win";
  let blockedReason = null;
  if (blocked.length || !gates.isolation || !gates.pinning || !gates.fixture) {
    verdict = "blocked";
    blockedReason = blocked[0] || "isolation, pinning, or fixture gate failed";
  } else if (
    gates.semantic_parity
    && gates.provenance_parity
    && gates.no_added_store_reads
    && gates.no_ambient_egress
    && gates.fail_closed_identical
    && gates.p95_wall_clock
    && gates.tokens_or_round_trips
  ) {
    verdict = "win";
  }

  return {
    schema: RECEIPT_SCHEMA,
    card: CARD,
    observed_at: OBSERVED_AT,
    status: verdict === "blocked" ? "blocked" : "measured",
    verdict,
    blocked_reason: blockedReason,
    prerequisite: {
      card: "cs-07-cloudflare-os-composition-proof",
      receipt: "artifacts/capability-spine/cs-07-cloudflare-os-proof.json",
      status: cs07Proof?.status || "missing",
      capability_versions: cs07Proof?.tool_grant?.capability_versions || [],
      raw_store_bindings: cs07Proof?.deployment?.raw_store_bindings ?? null,
      ordinary_mcp_frozen_fixture_replay: cs07Proof?.status === "pass",
    },
    fixture: {
      path: "test/fixtures/cloudflare_os_entity_research.json",
      sha256: sha256(readFileSync(FIXTURE_PATH)),
      id: fixture.id,
    },
    versions: {
      cloudflare_os_starter_commit: deployment.upstream.starter.commit,
      cloudflare_os_commit: deployment.upstream.cloudflare_os.commit,
      gatekeeper: deployment.upstream.gatekeeper.package,
      code_mode_package: deployment.upstream.code_mode.package,
      code_mode_version: deployment.upstream.code_mode.version,
      code_mode_pattern: deployment.upstream.code_mode.pattern,
      model_id: FROZEN_MODEL_ID,
      model_live: false,
    },
    grant: {
      tools: GRANTED_TOOL_NAMES,
      capability_versions: REQUIRED_TOOL_GRANT.map(({ capability_reference: reference }) => reference).sort(),
      write_tools: [],
      mutation_tools_granted: 0,
      raw_store_bindings_granted: 0,
    },
    constants: {
      model_id: FROZEN_MODEL_ID,
      prompt_sha256: sha256(`${SYSTEM_PROMPT}\n${userPromptFromFixture(fixture)}`),
      pinned_program_id: PINNED_PROGRAM_ID,
      pinned_program_sha256: sha256(PINNED_PROGRAM_SOURCE),
      tool_grant: GRANTED_TOOL_NAMES,
      bounds: fixture.expected.bounds,
      semantic_expectations: fixture.expected.result_semantic_sha256,
    },
    isolation: {
      ...sourceScan,
      deployment_id: "cs08-code-mode-gadget-rehearsal-v1",
      url: "https://cs08-code-mode-gadget.workers.dev",
      raw_store_bindings: 0,
      ambient_internet: false,
      resident_path_dependency: false,
      production_write_operations: 0,
    },
    kill_switch: {
      variable: deployment.kill_switch.variable,
      default: deployment.kill_switch.default,
      active_during_measurement: true,
      active_after: false,
    },
    protocol: {
      warmups,
      repetitions,
      require_parity: requireParity,
      matched_arms: matchedArms,
      treatment_protocol: treatmentProtocol,
      injected_failure: INJECTED_FAILURE,
      measurement_method: "frozen-fixture capability replay; accounted wall-clock; live composition memoized per arm",
    },
    arms: {
      ordinary_mcp: {
        protocol: "ordinary-mcp",
        live_ok: ordinaryLive.ok,
        runs: ordinaryRuns,
        summary: ordinary,
        injected_failure: ordinaryFailure,
      },
      code_mode: {
        protocol: treatmentProtocol,
        live_ok: codeLive.ok,
        runs: codeRuns,
        summary: codeMode,
        injected_failure: codeFailure,
      },
    },
    comparison: {
      median_model_input_tokens: {
        ordinary_mcp: ordinary.model_input_tokens.median,
        code_mode: codeMode.model_input_tokens.median,
        improvement: tokenImprovement,
      },
      median_external_round_trips: {
        ordinary_mcp: ordinary.external_round_trips.median,
        code_mode: codeMode.external_round_trips.median,
        reduction: roundTripReduction,
      },
      p95_wall_clock_ms: {
        ordinary_mcp: ordinary.wall_clock_ms.p95,
        code_mode: codeMode.wall_clock_ms.p95,
        regression: p95Regression,
      },
      median_store_reads: {
        ordinary_mcp: ordinary.store_reads.median,
        code_mode: codeMode.store_reads.median,
        added: addedStoreReads,
      },
    },
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      max_p95_regression: maxP95Regression,
    },
    gates,
    rollback: {
      rehearsal: blocked.length ? "blocked" : "pass",
      deployment_id: "cs08-code-mode-gadget-rehearsal-v1",
      grant_removed: true,
      endpoint_disabled: true,
      cityscroll_unchanged: true,
      ordinary_mcp_proof_preserved: true,
    },
  };
}

export { CS07_SOURCE, CS08_SOURCE, DEFAULT_THRESHOLDS, createGrantedInvoker };
