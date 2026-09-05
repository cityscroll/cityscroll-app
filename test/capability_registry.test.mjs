import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_REGISTRY,
  validateCapabilityRegistry,
} from "../capabilities/registry.mjs";
import {
  MCP_CITED_PASSAGES_ADAPTER,
  MCP_FEDERATED_SEARCH_ADAPTER,
  MCP_CONTRACT_GET_ADAPTER,
  MCP_CONTRACTS_ANALYSIS_ADAPTER,
  MCP_CONTRACTS_BROWSE_ADAPTER,
  MCP_LAND_PROJECT_GET_ADAPTER,
  MCP_LAND_PROJECTS_BROWSE_ADAPTER,
  MCP_NOTICE_GET_ADAPTER,
  MCP_NOTICE_SEARCH_ADAPTER,
  MCP_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../capabilities/mcp_tool_declarations.mjs";
import {
  FEDERATED_SEARCH_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
} from "../capabilities/federated_search.mjs";
import {
  NOTICE_GET_CAPABILITY,
  NOTICE_GET_CAPABILITY_REFERENCE,
} from "../capabilities/notice_get.mjs";
import {
  NOTICE_SEARCH_CAPABILITY,
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
} from "../capabilities/notice_search.mjs";
import {
  ENTITY_DOSSIER_CAPABILITY,
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
} from "../capabilities/entity_dossier.mjs";
import {
  ENTITY_RELATIONSHIPS_CAPABILITY,
  ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
} from "../capabilities/entity_relationships.mjs";
import {
  CITED_PASSAGES_CAPABILITY,
  CITED_PASSAGES_CAPABILITY_REFERENCE,
} from "../capabilities/cited_passages.mjs";
import {
  CONTRACT_GET_CAPABILITY,
  CONTRACT_GET_CAPABILITY_REFERENCE,
  CONTRACTS_BROWSE_CAPABILITY,
  CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
} from "../capabilities/contracts.mjs";
import { CONTRACTS_ANALYSIS_CAPABILITY, CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE } from "../capabilities/contracts_analysis.mjs";
import { MEETING_GET_CAPABILITY, MEETING_GET_CAPABILITY_REFERENCE } from "../capabilities/meetings.mjs";
import {
  LAND_PROJECT_GET_CAPABILITY,
  LAND_PROJECT_GET_CAPABILITY_REFERENCE,
  LAND_PROJECTS_BROWSE_CAPABILITY,
  LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
} from "../capabilities/land_projects.mjs";
import { workerD1NoticeSearch } from "../worker/src/lib/notices.mjs";
import { NOTICE_GET_HTTP_ADAPTER, workerNoticeGet } from "../worker/src/notice.mjs";
import { HTTP_CITED_PASSAGES_ADAPTER } from "../worker/src/cited_retrieval.mjs";
import { CONTRACT_GET_HTTP_ADAPTER, CONTRACTS_BROWSE_HTTP_ADAPTER } from "../worker/src/contracts.mjs";
import { SEARCH_NOTICE_ADAPTER } from "../worker/src/search.mjs";
import { SEARCH_FEDERATED_ADAPTER, workerFederatedSearch } from "../worker/src/search.mjs";
import {
  ENTITY_DOSSIER_HTTP_ADAPTER,
  workerD1EntityDossier,
} from "../worker/src/entity_dossier.mjs";
import {
  ENTITY_RELATIONSHIPS_HTTP_ADAPTER,
  workerD1EntityRelationships,
} from "../worker/src/public_relationship_graph.mjs";
import { workerCitedPassages } from "../worker/src/cited_retrieval.mjs";
import {
  LAND_PROJECT_GET_HTTP_ADAPTER,
  LAND_PROJECTS_BROWSE_HTTP_ADAPTER,
  workerLandProjects,
} from "../worker/src/land_projects.mjs";
import {
  buildCapabilityTopology,
  buildApiCapabilityCatalog,
  buildMcpToolCatalog,
  checkGeneratedFile,
  validateApiDocumentation,
  renderMcpCatalogHtml,
  renderApiCapabilityCatalogHtml,
  validateRuntimeTopology,
} from "../tools/build_capability_topology.mjs";

const ROOT = new URL("../", import.meta.url);
const TOPOLOGY = new URL("../architecture/generated/capability-topology.json", import.meta.url);
const CATALOG = new URL("../site/data/mcp_tool_catalog.json", import.meta.url);
const API_CATALOG = new URL("../site/data/api_capability_catalog.json", import.meta.url);

test("the registry is frozen, versioned, owned, and contains the federated search capability", () => {
  assert.equal(validateCapabilityRegistry(CAPABILITY_REGISTRY), CAPABILITY_REGISTRY);
  assert.equal(CAPABILITY_REGISTRY.length, 14);
  assert.equal(CAPABILITY_REGISTRY[0], NOTICE_SEARCH_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[1], NOTICE_GET_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[2], ENTITY_DOSSIER_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[3], ENTITY_RELATIONSHIPS_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[4], CITED_PASSAGES_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[5], FEDERATED_SEARCH_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[6], CONTRACT_GET_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[7], CONTRACTS_BROWSE_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[8], CONTRACTS_ANALYSIS_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[9].reference, "people.get@1");
  assert.equal(CAPABILITY_REGISTRY[10].reference, "organizations.browse@1");
  assert.equal(CAPABILITY_REGISTRY[11], MEETING_GET_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[12], LAND_PROJECT_GET_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[13], LAND_PROJECTS_BROWSE_CAPABILITY);
  assert.equal(NOTICE_SEARCH_CAPABILITY.reference, "notice.search@1");
  assert.equal(NOTICE_SEARCH_CAPABILITY.version, "1.0.0");
  assert.equal(NOTICE_SEARCH_CAPABILITY.owner, "notices");
  assert.equal(NOTICE_GET_CAPABILITY.reference, NOTICE_GET_CAPABILITY_REFERENCE);
  assert.equal(NOTICE_GET_CAPABILITY.version, "1.0.0");
  assert.equal(NOTICE_GET_CAPABILITY.owner, "notices");
  assert.equal(ENTITY_DOSSIER_CAPABILITY.reference, "entity.dossier.get@1");
  assert.equal(ENTITY_DOSSIER_CAPABILITY.version, "1.0.0");
  assert.equal(ENTITY_DOSSIER_CAPABILITY.owner, "entity-resolution");
  assert.equal(ENTITY_RELATIONSHIPS_CAPABILITY.reference, "entity.relationships.get@1");
  assert.equal(ENTITY_RELATIONSHIPS_CAPABILITY.version, "1.0.0");
  assert.equal(ENTITY_RELATIONSHIPS_CAPABILITY.owner, "entity-resolution");
  assert.equal(CITED_PASSAGES_CAPABILITY.reference, "cited.passages.retrieve@1");
  assert.equal(CITED_PASSAGES_CAPABILITY.version, "1.0.0");
  assert.equal(CITED_PASSAGES_CAPABILITY.owner, "semantic-retrieval");
  assert.equal(FEDERATED_SEARCH_CAPABILITY.reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(FEDERATED_SEARCH_CAPABILITY.version, "1.1.0");
  assert.equal(FEDERATED_SEARCH_CAPABILITY.owner, "universal-search");
  assert.equal(CONTRACT_GET_CAPABILITY.reference, CONTRACT_GET_CAPABILITY_REFERENCE);
  assert.equal(CONTRACTS_BROWSE_CAPABILITY.reference, CONTRACTS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(CONTRACT_GET_CAPABILITY.owner, "procurement");
  assert.equal(CONTRACTS_BROWSE_CAPABILITY.owner, "procurement");
  assert.equal(CONTRACTS_ANALYSIS_CAPABILITY.reference, CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE);
  assert.equal(CONTRACTS_ANALYSIS_CAPABILITY.owner, "procurement");
  assert.equal(MEETING_GET_CAPABILITY.reference, MEETING_GET_CAPABILITY_REFERENCE);
  assert.equal(MEETING_GET_CAPABILITY.owner, "meetings");
  assert.equal(LAND_PROJECT_GET_CAPABILITY.reference, LAND_PROJECT_GET_CAPABILITY_REFERENCE);
  assert.equal(LAND_PROJECTS_BROWSE_CAPABILITY.reference, LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(LAND_PROJECT_GET_CAPABILITY.owner, "land");
  assert.equal(LAND_PROJECTS_BROWSE_CAPABILITY.owner, "land");
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY));
  assert.ok(Object.isFrozen(NOTICE_SEARCH_CAPABILITY));
  assert.ok(Object.isFrozen(NOTICE_SEARCH_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(ENTITY_DOSSIER_CAPABILITY));
  assert.ok(Object.isFrozen(ENTITY_DOSSIER_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(ENTITY_RELATIONSHIPS_CAPABILITY));
  assert.ok(Object.isFrozen(ENTITY_RELATIONSHIPS_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(CITED_PASSAGES_CAPABILITY));
  assert.ok(Object.isFrozen(CITED_PASSAGES_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(FEDERATED_SEARCH_CAPABILITY));
  assert.ok(Object.isFrozen(FEDERATED_SEARCH_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(CONTRACT_GET_CAPABILITY));
  assert.ok(Object.isFrozen(CONTRACT_GET_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(CONTRACTS_BROWSE_CAPABILITY));
  assert.ok(Object.isFrozen(CONTRACTS_BROWSE_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(CONTRACTS_ANALYSIS_CAPABILITY));
  assert.ok(Object.isFrozen(CONTRACTS_ANALYSIS_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(LAND_PROJECT_GET_CAPABILITY));
  assert.ok(Object.isFrozen(LAND_PROJECT_GET_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(LAND_PROJECTS_BROWSE_CAPABILITY));
  assert.ok(Object.isFrozen(LAND_PROJECTS_BROWSE_CAPABILITY.adapters));
});

test("Land project retrieval has one authoritative provider and HTTP/MCP adapters", () => {
  const providers = [LAND_PROJECT_GET_CAPABILITY, LAND_PROJECTS_BROWSE_CAPABILITY];
  const adapters = [
    LAND_PROJECT_GET_HTTP_ADAPTER, MCP_LAND_PROJECT_GET_ADAPTER,
    LAND_PROJECTS_BROWSE_HTTP_ADAPTER, MCP_LAND_PROJECTS_BROWSE_ADAPTER,
  ];
  assert.deepEqual(adapters.map(({ id, capabilityReference, providerId }) => ({ id, capabilityReference, providerId })), [
    { id: LAND_PROJECT_GET_CAPABILITY.adapters[0].id, capabilityReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, providerId: LAND_PROJECT_GET_CAPABILITY.provider.id },
    { id: LAND_PROJECT_GET_CAPABILITY.adapters[1].id, capabilityReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, providerId: LAND_PROJECT_GET_CAPABILITY.provider.id },
    { id: LAND_PROJECTS_BROWSE_CAPABILITY.adapters[0].id, capabilityReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE, providerId: LAND_PROJECTS_BROWSE_CAPABILITY.provider.id },
    { id: LAND_PROJECTS_BROWSE_CAPABILITY.adapters[1].id, capabilityReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE, providerId: LAND_PROJECTS_BROWSE_CAPABILITY.provider.id },
  ]);
  assert.ok(providers.every((capability) => capability.adapters.length === 2));
  const provider = workerLandProjects({});
  assert.equal(provider.get.capabilityReference, LAND_PROJECT_GET_CAPABILITY_REFERENCE);
  assert.equal(provider.get.providerId, LAND_PROJECT_GET_CAPABILITY.provider.id);
  assert.equal(provider.browse.capabilityReference, LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(provider.browse.providerId, LAND_PROJECTS_BROWSE_CAPABILITY.provider.id);
  assert.equal(validateRuntimeTopology(), true);
});

test("federated search provider and HTTP/MCP adapters reference one capability", () => {
  const provider = workerFederatedSearch({});
  assert.equal(provider.capabilityReference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, FEDERATED_SEARCH_CAPABILITY.provider.id);
  assert.deepEqual(
    [SEARCH_FEDERATED_ADAPTER, MCP_FEDERATED_SEARCH_ADAPTER].map((adapter) => ({
      id: adapter.id,
      capabilityReference: adapter.capabilityReference,
      providerId: adapter.providerId,
    })),
    FEDERATED_SEARCH_CAPABILITY.adapters.map((adapter) => ({
      id: adapter.id,
      capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
      providerId: FEDERATED_SEARCH_CAPABILITY.provider.id,
    })),
  );
});

test("provider and both real adapters explicitly reference notice.search@1", () => {
  const provider = workerD1NoticeSearch({});
  assert.equal(provider.capabilityReference, NOTICE_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, NOTICE_SEARCH_CAPABILITY.provider.id);
  assert.deepEqual(
    [SEARCH_NOTICE_ADAPTER, MCP_NOTICE_SEARCH_ADAPTER].map((adapter) => ({
      id: adapter.id,
      capabilityReference: adapter.capabilityReference,
      providerId: adapter.providerId,
    })),
    NOTICE_SEARCH_CAPABILITY.adapters.map((adapter) => ({
      id: adapter.id,
      capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
      providerId: NOTICE_SEARCH_CAPABILITY.provider.id,
    })),
  );
  assert.equal(validateRuntimeTopology(), true);
});

test("provider and multi-representation HTTP adapter reference entity.dossier.get@1", () => {
  const provider = workerD1EntityDossier({});
  assert.equal(provider.capabilityReference, ENTITY_DOSSIER_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, ENTITY_DOSSIER_CAPABILITY.provider.id);
  assert.deepEqual(
    {
      id: ENTITY_DOSSIER_HTTP_ADAPTER.id,
      capabilityReference: ENTITY_DOSSIER_HTTP_ADAPTER.capabilityReference,
      providerId: ENTITY_DOSSIER_HTTP_ADAPTER.providerId,
      representations: ENTITY_DOSSIER_HTTP_ADAPTER.representations,
    },
    {
      id: ENTITY_DOSSIER_CAPABILITY.adapters[0].id,
      capabilityReference: ENTITY_DOSSIER_CAPABILITY_REFERENCE,
      providerId: ENTITY_DOSSIER_CAPABILITY.provider.id,
      representations: ENTITY_DOSSIER_CAPABILITY.adapters[0].representations,
    },
  );
  assert.equal(validateRuntimeTopology(), true);
});

test("provider and multi-representation HTTP adapter reference entity.relationships.get@1", () => {
  const provider = workerD1EntityRelationships({});
  assert.equal(provider.capabilityReference, ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, ENTITY_RELATIONSHIPS_CAPABILITY.provider.id);
  assert.deepEqual(
    {
      id: ENTITY_RELATIONSHIPS_HTTP_ADAPTER.id,
      capabilityReference: ENTITY_RELATIONSHIPS_HTTP_ADAPTER.capabilityReference,
      providerId: ENTITY_RELATIONSHIPS_HTTP_ADAPTER.providerId,
      representations: ENTITY_RELATIONSHIPS_HTTP_ADAPTER.representations,
    },
    {
      id: ENTITY_RELATIONSHIPS_CAPABILITY.adapters[0].id,
      capabilityReference: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
      providerId: ENTITY_RELATIONSHIPS_CAPABILITY.provider.id,
      representations: ENTITY_RELATIONSHIPS_CAPABILITY.adapters[0].representations,
    },
  );
  assert.equal(validateRuntimeTopology(), true);
});

test("provider and MCP adapter explicitly reference cited.passages.retrieve@1", () => {
  const provider = workerCitedPassages();
  assert.equal(provider.capabilityReference, CITED_PASSAGES_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, CITED_PASSAGES_CAPABILITY.provider.id);
  assert.deepEqual({
    id: MCP_CITED_PASSAGES_ADAPTER.id,
    capabilityReference: MCP_CITED_PASSAGES_ADAPTER.capabilityReference,
    providerId: MCP_CITED_PASSAGES_ADAPTER.providerId,
    representations: MCP_CITED_PASSAGES_ADAPTER.representations,
  }, {
      id: CITED_PASSAGES_CAPABILITY.adapters[1].id,
      capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
      providerId: CITED_PASSAGES_CAPABILITY.provider.id,
      representations: CITED_PASSAGES_CAPABILITY.adapters[1].representations,
  });
  assert.equal(HTTP_CITED_PASSAGES_ADAPTER.capabilityReference, CITED_PASSAGES_CAPABILITY_REFERENCE);
  assert.equal(HTTP_CITED_PASSAGES_ADAPTER.providerId, CITED_PASSAGES_CAPABILITY.provider.id);
  assert.equal(HTTP_CITED_PASSAGES_ADAPTER.id, CITED_PASSAGES_CAPABILITY.adapters[0].id);
  assert.equal(validateRuntimeTopology(), true);
});

test("notice retrieval has one authoritative provider and HTTP/MCP adapters", () => {
  const provider = workerNoticeGet({});
  assert.equal(provider.capabilityReference, NOTICE_GET_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, NOTICE_GET_CAPABILITY.provider.id);
  assert.equal(NOTICE_GET_HTTP_ADAPTER.id, NOTICE_GET_CAPABILITY.adapters[0].id);
  assert.equal(MCP_NOTICE_GET_ADAPTER.id, NOTICE_GET_CAPABILITY.adapters[1].id);
  assert.equal(validateRuntimeTopology(), true);
});

test("Contracts retrieval has one authoritative provider and HTTP/MCP adapters", () => {
  const providers = [CONTRACT_GET_CAPABILITY, CONTRACTS_BROWSE_CAPABILITY];
  const adapters = [CONTRACT_GET_HTTP_ADAPTER, MCP_CONTRACT_GET_ADAPTER, CONTRACTS_BROWSE_HTTP_ADAPTER, MCP_CONTRACTS_BROWSE_ADAPTER];
  assert.deepEqual(adapters.map(({ id, capabilityReference, providerId }) => ({ id, capabilityReference, providerId })), [
    { id: CONTRACT_GET_CAPABILITY.adapters[0].id, capabilityReference: CONTRACT_GET_CAPABILITY_REFERENCE, providerId: CONTRACT_GET_CAPABILITY.provider.id },
    { id: CONTRACT_GET_CAPABILITY.adapters[1].id, capabilityReference: CONTRACT_GET_CAPABILITY_REFERENCE, providerId: CONTRACT_GET_CAPABILITY.provider.id },
    { id: CONTRACTS_BROWSE_CAPABILITY.adapters[0].id, capabilityReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE, providerId: CONTRACTS_BROWSE_CAPABILITY.provider.id },
    { id: CONTRACTS_BROWSE_CAPABILITY.adapters[1].id, capabilityReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE, providerId: CONTRACTS_BROWSE_CAPABILITY.provider.id },
  ]);
  assert.ok(providers.every((capability) => capability.adapters.length === 2));
  assert.equal(validateRuntimeTopology(), true);
});

test("Contracts analysis provider and MCP adapter reference one capability", () => {
  assert.equal(MCP_CONTRACTS_ANALYSIS_ADAPTER.capabilityReference, CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE);
  assert.equal(MCP_CONTRACTS_ANALYSIS_ADAPTER.providerId, CONTRACTS_ANALYSIS_CAPABILITY.provider.id);
  assert.equal(MCP_CONTRACTS_ANALYSIS_ADAPTER.id, CONTRACTS_ANALYSIS_CAPABILITY.adapters[1].id);
  assert.equal(validateRuntimeTopology(), true);
});

test("every MCP tool has a capability, existing contract, or scoped pilot exception", () => {
  assert.deepEqual(MCP_TOOL_BINDINGS.map(({ name }) => name), MCP_TOOLS.map(({ name }) => name));
  const search = MCP_TOOL_BINDINGS.find(({ name }) => name === "search_notices");
  assert.equal(search.capabilityReference, NOTICE_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(search.adapterId, MCP_NOTICE_SEARCH_ADAPTER.id);
  const cited = MCP_TOOL_BINDINGS.find(({ name }) => name === "retrieve_cited_passages");
  assert.equal(cited.capabilityReference, CITED_PASSAGES_CAPABILITY_REFERENCE);
  assert.equal(cited.adapterId, MCP_CITED_PASSAGES_ADAPTER.id);
  const exceptions = MCP_TOOL_BINDINGS.filter(({ pilotException }) => pilotException);
  assert.deepEqual(exceptions.map(({ name }) => name), ["preview_watch", "create_watch"]);
  assert.equal(exceptions.find(({ name }) => name === "create_watch").operationClass, "mutation");
});

test("core capability files contain no runtime or transport dependencies", () => {
  for (const path of [
    "capabilities/notice_search.mjs",
    "capabilities/notice_get.mjs",
    "capabilities/entity_dossier.mjs",
    "capabilities/entity_relationships.mjs",
    "capabilities/cited_passages.mjs",
    "capabilities/federated_search.mjs",
    "capabilities/contracts.mjs",
    "capabilities/contracts_analysis.mjs",
    "capabilities/land_projects.mjs",
    "capabilities/registry.mjs",
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:mcp|worker\/src|cloudflare)[^"']*["']/i, path);
    assert.doesNotMatch(source, /\b(?:Request|Response)\s*\(/, path);
  }
});

test("topology and public MCP catalog are deterministic and committed", () => {
  const first = JSON.stringify(buildCapabilityTopology());
  const second = JSON.stringify(buildCapabilityTopology());
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(readFileSync(TOPOLOGY, "utf8")), buildCapabilityTopology());
  assert.deepEqual(JSON.parse(readFileSync(CATALOG, "utf8")), buildMcpToolCatalog());
  assert.deepEqual(JSON.parse(readFileSync(API_CATALOG, "utf8")), buildApiCapabilityCatalog());
  assert.deepEqual(buildApiCapabilityCatalog().operations.map(({ reference }) => reference), CAPABILITY_REGISTRY.map(({ reference }) => reference));
  const catalog = buildMcpToolCatalog();
  assert.deepEqual(catalog.registered_capability_references, [
    "notice.search@1",
    "notice.get@1",
    "entity.dossier.get@1",
    "entity.relationships.get@1",
    "cited.passages.retrieve@1",
    "search.federated@1",
    "contract.get@1",
    "contracts.browse@1",
    "contracts.analysis@1",
    "people.get@1",
    "organizations.browse@1",
    "meeting.get@1",
    "land.project.get@1",
    "land.projects.browse@1",
  ]);
  assert.deepEqual(catalog.tools.map(({ name }) => name), [
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
    "preview_watch",
    "create_watch",
  ]);
  assert.equal(catalog.tools[0].input_schema.type, "object");
  const renderedApi = renderApiCapabilityCatalogHtml(buildApiCapabilityCatalog());
  const embeddedCatalog = renderedApi.match(/<script type="application\/json" id="api-capability-catalog">([\s\S]*)<\/script>/);
  assert.ok(embeddedCatalog, "generated API page must embed its machine-readable catalog");
  assert.deepEqual(JSON.parse(embeddedCatalog[1]), buildApiCapabilityCatalog());
  assert.equal(renderMcpCatalogHtml(catalog).match(/<li>/g).length, 16);
});

test("an undocumented capability operation fails the generated documentation check", () => {
  const catalog = buildApiCapabilityCatalog();
  const apiHtml = readFileSync(new URL("../site/api.html", import.meta.url), "utf8");
  const undocumented = apiHtml.replace(catalog.operations[0].reference, "deliberately-undocumented");
  assert.throws(() => validateApiDocumentation(undocumented, catalog), /undocumented or stale/);
});

test("the deterministic CLI check passes and --stdout is stable", () => {
  const command = fileURLToPath(new URL("../tools/build_capability_topology.mjs", import.meta.url));
  const checked = spawnSync(process.execPath, [command, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const one = spawnSync(process.execPath, [command, "--stdout"], { cwd: ROOT, encoding: "utf8" });
  const two = spawnSync(process.execPath, [command, "--stdout"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(one.stdout, two.stdout);
  assert.deepEqual(JSON.parse(one.stdout), buildCapabilityTopology());
});

test("the drift primitive fails closed on generated divergence", () => {
  const directory = mkdtempSync(join(tmpdir(), "crol-capability-drift-"));
  const path = join(directory, "generated.json");
  try {
    writeFileSync(path, "stale\n", "utf8");
    assert.throws(() => checkGeneratedFile(path, "current\n"), /is stale/);
    writeFileSync(path, "current\n", "utf8");
    assert.doesNotThrow(() => checkGeneratedFile(path, "current\n"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
