#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_REGISTRY,
  validateCapabilityRegistry,
} from "../capabilities/registry.mjs";
import {
  MCP_CITED_PASSAGES_ADAPTER,
  MCP_CONTRACT_GET_ADAPTER,
  MCP_CONTRACTS_ANALYSIS_ADAPTER,
  MCP_CONTRACTS_BROWSE_ADAPTER,
  MCP_ENTITY_DOSSIER_ADAPTER,
  MCP_ENTITY_RELATIONSHIPS_ADAPTER,
  MCP_FEDERATED_SEARCH_ADAPTER,
  MCP_NOTICE_GET_ADAPTER,
  MCP_NOTICE_SEARCH_ADAPTER,
  MCP_ORGANIZATIONS_BROWSE_ADAPTER,
  MCP_PEOPLE_GET_ADAPTER,
  MCP_MEETING_GET_ADAPTER,
  MCP_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../capabilities/mcp_tool_declarations.mjs";
import { SEARCH_FEDERATED_ADAPTER, SEARCH_NOTICE_ADAPTER } from "../worker/src/search.mjs";
import { ENTITY_DOSSIER_HTTP_ADAPTER } from "../worker/src/entity_dossier.mjs";
import { ENTITY_RELATIONSHIPS_HTTP_ADAPTER } from "../worker/src/public_relationship_graph.mjs";
import { NOTICE_GET_HTTP_ADAPTER } from "../worker/src/notice.mjs";
import { HTTP_CITED_PASSAGES_ADAPTER } from "../worker/src/cited_retrieval.mjs";
import { CONTRACT_GET_HTTP_ADAPTER, CONTRACTS_ANALYSIS_HTTP_ADAPTER, CONTRACTS_BROWSE_HTTP_ADAPTER } from "../worker/src/contracts.mjs";
import { PEOPLE_GET_HTTP_ADAPTER, ORGANIZATIONS_BROWSE_HTTP_ADAPTER } from "../worker/src/people_organizations.mjs";
import { MEETING_GET_HTTP_ADAPTER } from "../worker/src/hearings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOPOLOGY_PATH = join(ROOT, "architecture/generated/capability-topology.json");
const MCP_CATALOG_PATH = join(ROOT, "site/data/mcp_tool_catalog.json");
const API_CATALOG_PATH = join(ROOT, "site/data/api_capability_catalog.json");
const API_HTML_PATH = join(ROOT, "site/api.html");
const I18N_PATH = join(ROOT, "site/i18n.js");
const ARCHITECTURE_PATH = join(ROOT, "docs/architecture.md");
export const MCP_CATALOG_MARKER_START = "<!-- BEGIN GENERATED MCP TOOL CATALOG -->";
export const MCP_CATALOG_MARKER_END = "<!-- END GENERATED MCP TOOL CATALOG -->";
export const API_CATALOG_MARKER_START = "<!-- BEGIN GENERATED API CAPABILITY CATALOG -->";
export const API_CATALOG_MARKER_END = "<!-- END GENERATED API CAPABILITY CATALOG -->";

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bindingByName() {
  return new Map(MCP_TOOL_BINDINGS.map((binding) => [binding.name, binding]));
}

export function validateRuntimeTopology() {
  validateCapabilityRegistry(CAPABILITY_REGISTRY);
  const capabilityReferences = new Set(CAPABILITY_REGISTRY.map(({ reference }) => reference));
  const registeredAdapters = new Map(CAPABILITY_REGISTRY.flatMap((capability) => (
    capability.adapters.map((adapter) => [adapter.id, { capability, adapter }])
  )));
  const runtimeAdapters = [
    SEARCH_FEDERATED_ADAPTER,
    SEARCH_NOTICE_ADAPTER,
    MCP_NOTICE_SEARCH_ADAPTER,
    MCP_FEDERATED_SEARCH_ADAPTER,
    NOTICE_GET_HTTP_ADAPTER,
    MCP_NOTICE_GET_ADAPTER,
    ENTITY_DOSSIER_HTTP_ADAPTER,
    MCP_ENTITY_DOSSIER_ADAPTER,
    ENTITY_RELATIONSHIPS_HTTP_ADAPTER,
    HTTP_CITED_PASSAGES_ADAPTER,
    MCP_ENTITY_RELATIONSHIPS_ADAPTER,
    MCP_CITED_PASSAGES_ADAPTER,
    CONTRACT_GET_HTTP_ADAPTER,
    CONTRACTS_BROWSE_HTTP_ADAPTER,
    CONTRACTS_ANALYSIS_HTTP_ADAPTER,
    MCP_CONTRACT_GET_ADAPTER,
    MCP_CONTRACTS_BROWSE_ADAPTER,
    MCP_CONTRACTS_ANALYSIS_ADAPTER,
    PEOPLE_GET_HTTP_ADAPTER,
    ORGANIZATIONS_BROWSE_HTTP_ADAPTER,
    MCP_PEOPLE_GET_ADAPTER,
    MCP_ORGANIZATIONS_BROWSE_ADAPTER,
    MEETING_GET_HTTP_ADAPTER,
    MCP_MEETING_GET_ADAPTER,
  ];
  for (const runtimeAdapter of runtimeAdapters) {
    const registered = registeredAdapters.get(runtimeAdapter.id);
    if (!registered) throw new Error(`runtime adapter is not registered: ${runtimeAdapter.id}`);
    if (runtimeAdapter.capabilityReference !== registered.capability.reference) {
      throw new Error(`runtime adapter capability drift: ${runtimeAdapter.id}`);
    }
    if (runtimeAdapter.providerId !== registered.capability.provider.id) {
      throw new Error(`runtime adapter provider drift: ${runtimeAdapter.id}`);
    }
  }

  for (const capability of CAPABILITY_REGISTRY) {
    const adapters = capability.adapters;
    if (!adapters.some(({ kind }) => kind.startsWith("http"))
        || !adapters.some(({ kind }) => kind === "mcp-tool")) {
      throw new Error(`capability lacks authoritative HTTP and MCP adapters: ${capability.reference}`);
    }
    if (!Array.isArray(capability.examples) || capability.examples.length < 2) {
      throw new Error(`capability examples are required: ${capability.reference}`);
    }
    if (!capability.bounds || typeof capability.bounds !== "object") {
      throw new Error(`capability bounds are required: ${capability.reference}`);
    }
  }

  const toolNames = MCP_TOOLS.map(({ name }) => name);
  if (new Set(toolNames).size !== toolNames.length) throw new Error("MCP tool names must be unique");
  const bindings = bindingByName();
  if (bindings.size !== MCP_TOOL_BINDINGS.length) throw new Error("MCP tool bindings must be unique");
  if (toolNames.length !== bindings.size || toolNames.some((name) => !bindings.has(name))) {
    throw new Error("every MCP tool must have exactly one capability, contract, or scoped pilot binding");
  }
  for (const binding of MCP_TOOL_BINDINGS) {
    if (!["read", "mutation"].includes(binding.operationClass)) {
      throw new Error(`invalid MCP operation class: ${binding.name}`);
    }
    if (!binding.schemaReference) throw new Error(`MCP schema reference is required: ${binding.name}`);
    if (binding.capabilityReference) {
      if (!capabilityReferences.has(binding.capabilityReference)) {
        throw new Error(`MCP tool references an unknown capability: ${binding.name}`);
      }
      if (!binding.adapterId || !registeredAdapters.has(binding.adapterId)) {
        throw new Error(`MCP capability tool references an unknown adapter: ${binding.name}`);
      }
    } else if (!binding.contractReference && !binding.pilotException) {
      throw new Error(`MCP tool lacks a contract or scoped pilot exception: ${binding.name}`);
    }
    if (binding.pilotException && binding.operationClass === "read"
        && /^(?:search|get|retrieve)_/.test(binding.name)) {
      throw new Error(`equivalent read operation retains an inline pilot exception: ${binding.name}`);
    }
  }
  return true;
}

export function buildMcpToolCatalog() {
  validateRuntimeTopology();
  const bindings = bindingByName();
  const capabilities = new Map(CAPABILITY_REGISTRY.map((capability) => [capability.reference, capability]));
  return {
    schema: "cityscroll.mcp_tool_catalog.v1",
    generated_from: "worker/src/mcp.mjs + capabilities/registry.mjs",
    endpoint: "POST https://api.cityscroll.org/mcp",
    registered_capability_references: CAPABILITY_REGISTRY.map(({ reference }) => reference),
    tools: MCP_TOOLS.map((tool) => {
      const binding = bindings.get(tool.name);
      return {
        name: tool.name,
        operation_class: binding.operationClass,
        authority_class: binding.authorityClass || null,
        description: tool.description,
        schema_reference: binding.schemaReference,
        capability_reference: binding.capabilityReference || null,
        input_schema: tool.inputSchema || null,
        output_schema: tool.outputSchema || null,
        bounds: capabilities.get(binding.capabilityReference)?.bounds || binding.bounds || null,
        examples: capabilities.get(binding.capabilityReference)?.examples || null,
        annotations: tool.annotations || null,
        store_access: binding.storeAccess || null,
      };
    }),
  };
}

function operationTitle(capability) {
  return capability.id
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .join(" ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function capabilityDescription(capability, toolsByCapability) {
  const tool = toolsByCapability.get(capability.reference);
  return tool?.description || `${operationTitle(capability)} public capability.`;
}

export function buildApiCapabilityCatalog(registry = CAPABILITY_REGISTRY) {
  validateCapabilityRegistry(registry);
  const toolsByCapability = new Map(
    MCP_TOOL_BINDINGS
      .filter(({ capabilityReference }) => capabilityReference)
      .map((binding) => [binding.capabilityReference, MCP_TOOLS.find(({ name }) => name === binding.name)])
      .filter(([, tool]) => tool),
  );
  return {
    schema: "cityscroll.api_capability_catalog.v1",
    generated_from: "capabilities/registry.mjs + capabilities/mcp_tool_declarations.mjs",
    endpoint: "https://api.cityscroll.org",
    operations: registry.map((capability) => ({
      reference: capability.reference,
      id: capability.id,
      version: capability.version,
      title: operationTitle(capability),
      description: capabilityDescription(capability, toolsByCapability),
      owner: capability.owner,
      operation: capability.operation,
      authority: capability.authority,
      cost: capability.cost,
      input_schema: capability.input.schema,
      input_contract: capability.input,
      output_schema: capability.output.schema,
      output_contract: capability.output,
      bounds: capability.bounds,
      examples: capability.examples,
      provenance: capability.provenance,
      freshness: capability.freshness,
      provider: capability.provider,
      transports: capability.adapters,
    })),
  };
}

export function buildCapabilityTopology() {
  validateRuntimeTopology();
  const capabilities = new Map(CAPABILITY_REGISTRY.map((capability) => [capability.reference, capability]));
  return {
    schema: "cityscroll.capability_topology.v1",
    generated_from: "capabilities/registry.mjs",
    capabilities: CAPABILITY_REGISTRY.map((capability) => ({
      reference: capability.reference,
      id: capability.id,
      version: capability.version,
      owner: capability.owner,
      operation: capability.operation,
      authority: capability.authority,
      cost: capability.cost,
      input_schema: capability.input.schema,
      output_schema: capability.output.schema,
      bounds: capability.bounds,
      examples: capability.examples,
      availability: capability.output.availability,
      provenance: capability.provenance,
      freshness: capability.freshness,
      provider: capability.provider,
      adapters: capability.adapters,
    })),
    mcp: {
      route: "POST /mcp",
      catalog: relative(ROOT, MCP_CATALOG_PATH),
      tools: MCP_TOOL_BINDINGS.map((binding) => ({
        name: binding.name,
        operation_class: binding.operationClass,
        authority_class: binding.authorityClass || null,
        schema_reference: binding.schemaReference,
        capability_reference: binding.capabilityReference || null,
        adapter_id: binding.adapterId || null,
        contract_reference: binding.contractReference || null,
        pilot_exception: binding.pilotException || null,
        bounds: capabilities.get(binding.capabilityReference)?.bounds || binding.bounds || null,
        examples: capabilities.get(binding.capabilityReference)?.examples || null,
        annotations: binding.annotations || null,
        store_access: binding.storeAccess || null,
      })),
    },
  };
}

export function renderMcpCatalogHtml(catalog = buildMcpToolCatalog()) {
  const items = catalog.tools.map((tool) => (
    `  <li><code>${escapeHtml(tool.name)}</code> <span aria-hidden="true">·</span> ${escapeHtml(tool.operation_class)} — ${escapeHtml(tool.description.replace(/; ([a-z])/g, (_, letter) => `. ${letter.toUpperCase()}`))}</li>`
  )).join("\n");
  return `${MCP_CATALOG_MARKER_START}
<div class="src" aria-label="MCP tool catalog">
<p><strong>Available tools</strong> (generated from the runtime declarations):</p>
<ul>
${items}
</ul>
<p>Machine-readable inventory: <a href="data/mcp_tool_catalog.json"><code>JSON catalog</code></a>.</p>
</div>
${MCP_CATALOG_MARKER_END}`;
}

export function renderApiCapabilityCatalogHtml(catalog = buildApiCapabilityCatalog()) {
  const catalogJson = JSON.stringify(catalog, null, 2).replaceAll("<", "\\u003c");
  return `${API_CATALOG_MARKER_START}
<section aria-labelledby="generated-capability-catalog">
<h2 id="generated-capability-catalog">Capability API contracts</h2>
<p class="src">This list uses the runtime registry. The JSON catalog has schemas, limits, examples, source, freshness, and delivery details.</p>
<p class="src">See the <a href="data/api_capability_catalog.json"><code>JSON catalog</code></a> for contracts. HTTP, feeds, bulk exports, and model tools use separate paths.</p>
<script type="application/json" id="api-capability-catalog">${catalogJson}</script>
</section>
${API_CATALOG_MARKER_END}`;
}

export function replaceGeneratedMcpCatalog(html, rendered = renderMcpCatalogHtml()) {
  const start = html.indexOf(MCP_CATALOG_MARKER_START);
  const end = html.indexOf(MCP_CATALOG_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("site/api.html is missing the generated MCP catalog markers");
  }
  const suffix = end + MCP_CATALOG_MARKER_END.length;
  return `${html.slice(0, start)}${rendered}${html.slice(suffix)}`;
}

export function replaceGeneratedApiCatalog(html, rendered = renderApiCapabilityCatalogHtml()) {
  const start = html.indexOf(API_CATALOG_MARKER_START);
  const end = html.indexOf(API_CATALOG_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("site/api.html is missing the generated API capability catalog markers");
  }
  const suffix = end + API_CATALOG_MARKER_END.length;
  return `${html.slice(0, start)}${rendered}${html.slice(suffix)}`;
}

export function validateApiDocumentation(apiHtml, catalog = buildApiCapabilityCatalog()) {
  const start = apiHtml.indexOf(API_CATALOG_MARKER_START);
  const end = apiHtml.indexOf(API_CATALOG_MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("site/api.html is missing the generated API capability catalog markers");
  }
  const suffix = end + API_CATALOG_MARKER_END.length;
  const actual = apiHtml.slice(start, suffix);
  const expected = renderApiCapabilityCatalogHtml(catalog);
  if (actual !== expected) {
    throw new Error("site/api.html capability catalog is undocumented or stale");
  }
  return true;
}

export function checkGeneratedFile(path, expected) {
  if (!existsSync(path)) throw new Error(`${relative(ROOT, path)} is missing; rebuild capability topology`);
  const actual = readFileSync(path, "utf8");
  if (actual !== expected) throw new Error(`${relative(ROOT, path)} is stale; rebuild capability topology`);
}

function validateDocumentationReferences(apiHtml, i18n, architecture) {
  const englishMcpStart = i18n.indexOf("api_p_mcp_html:");
  const englishMcpEnd = i18n.indexOf("api_h_upstream:", englishMcpStart);
  const englishMcp = i18n.slice(englishMcpStart, englishMcpEnd);
  if (!englishMcp.includes("generated catalog")) {
    throw new Error("site/i18n.js must use catalog-independent generated-inventory prose");
  }
  for (const { name } of MCP_TOOLS) {
    if (englishMcp.includes(name)) throw new Error(`site/i18n.js hand-copies MCP tool name: ${name}`);
  }
  if (!apiHtml.includes("data/mcp_tool_catalog.json")) {
    throw new Error("site/api.html must link the generated MCP catalog");
  }
  if (!apiHtml.includes("data/api_capability_catalog.json")) {
    throw new Error("site/api.html must link the generated API capability catalog");
  }
  if (!architecture.includes("site/data/mcp_tool_catalog.json")) {
    throw new Error("docs/architecture.md must reference the generated MCP catalog");
  }
  if (!architecture.includes("site/data/api_capability_catalog.json")) {
    throw new Error("docs/architecture.md must reference the generated API capability catalog");
  }
  if (/double[- ]opt[- ]in/i.test(architecture)) {
    throw new Error("docs/architecture.md still describes the retired double-opt-in flow");
  }
}

export function buildOutputs() {
  const topology = serialize(buildCapabilityTopology());
  const catalog = serialize(buildMcpToolCatalog());
  const apiCapabilityCatalog = serialize(buildApiCapabilityCatalog());
  const apiHtml = readFileSync(API_HTML_PATH, "utf8");
  const renderedMcpHtml = replaceGeneratedMcpCatalog(apiHtml);
  const renderedApiHtml = replaceGeneratedApiCatalog(renderedMcpHtml);
  validateApiDocumentation(renderedApiHtml, JSON.parse(apiCapabilityCatalog));
  return { topology, catalog, apiCapabilityCatalog, renderedApiHtml };
}

export function writeOrCheckCapabilityTopology({ check = false } = {}) {
  const outputs = buildOutputs();
  const i18n = readFileSync(I18N_PATH, "utf8");
  const architecture = readFileSync(ARCHITECTURE_PATH, "utf8");
  validateDocumentationReferences(outputs.renderedApiHtml, i18n, architecture);
  if (check) {
    checkGeneratedFile(TOPOLOGY_PATH, outputs.topology);
    checkGeneratedFile(MCP_CATALOG_PATH, outputs.catalog);
    checkGeneratedFile(API_CATALOG_PATH, outputs.apiCapabilityCatalog);
    checkGeneratedFile(API_HTML_PATH, outputs.renderedApiHtml);
    return outputs;
  }
  mkdirSync(dirname(TOPOLOGY_PATH), { recursive: true });
  mkdirSync(dirname(MCP_CATALOG_PATH), { recursive: true });
  mkdirSync(dirname(API_CATALOG_PATH), { recursive: true });
  writeFileSync(TOPOLOGY_PATH, outputs.topology, "utf8");
  writeFileSync(MCP_CATALOG_PATH, outputs.catalog, "utf8");
  writeFileSync(API_CATALOG_PATH, outputs.apiCapabilityCatalog, "utf8");
  writeFileSync(API_HTML_PATH, outputs.renderedApiHtml, "utf8");
  return outputs;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stdout = process.argv.includes("--stdout");
  try {
    if (stdout) process.stdout.write(serialize(buildCapabilityTopology()));
    if (check) {
      writeOrCheckCapabilityTopology({ check: true });
      if (!stdout) process.stdout.write("capability topology, API catalog, and MCP catalog are current\n");
    } else if (!stdout) {
      writeOrCheckCapabilityTopology();
      process.stdout.write("wrote capability topology, API catalog, and MCP catalog\n");
    }
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
