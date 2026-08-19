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
  MCP_NOTICE_SEARCH_ADAPTER,
  MCP_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../capabilities/mcp_tool_declarations.mjs";
import {
  NOTICE_SEARCH_CAPABILITY,
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
} from "../capabilities/notice_search.mjs";
import {
  ENTITY_DOSSIER_CAPABILITY,
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
} from "../capabilities/entity_dossier.mjs";
import { workerD1NoticeSearch } from "../worker/src/lib/notices.mjs";
import { SEARCH_NOTICE_ADAPTER } from "../worker/src/search.mjs";
import {
  ENTITY_DOSSIER_HTTP_ADAPTER,
  workerD1EntityDossier,
} from "../worker/src/entity_dossier.mjs";
import {
  buildCapabilityTopology,
  buildMcpToolCatalog,
  checkGeneratedFile,
  renderMcpCatalogHtml,
  validateRuntimeTopology,
} from "../tools/build_capability_topology.mjs";

const ROOT = new URL("../", import.meta.url);
const TOPOLOGY = new URL("../architecture/generated/capability-topology.json", import.meta.url);
const CATALOG = new URL("../site/data/mcp_tool_catalog.json", import.meta.url);

test("the registry is frozen, versioned, owned, and contains the two ladder capabilities", () => {
  assert.equal(validateCapabilityRegistry(CAPABILITY_REGISTRY), CAPABILITY_REGISTRY);
  assert.equal(CAPABILITY_REGISTRY.length, 2);
  assert.equal(CAPABILITY_REGISTRY[0], NOTICE_SEARCH_CAPABILITY);
  assert.equal(CAPABILITY_REGISTRY[1], ENTITY_DOSSIER_CAPABILITY);
  assert.equal(NOTICE_SEARCH_CAPABILITY.reference, "notice.search@1");
  assert.equal(NOTICE_SEARCH_CAPABILITY.version, "1.0.0");
  assert.equal(NOTICE_SEARCH_CAPABILITY.owner, "notices");
  assert.equal(ENTITY_DOSSIER_CAPABILITY.reference, "entity.dossier.get@1");
  assert.equal(ENTITY_DOSSIER_CAPABILITY.version, "1.0.0");
  assert.equal(ENTITY_DOSSIER_CAPABILITY.owner, "entity-resolution");
  assert.ok(Object.isFrozen(CAPABILITY_REGISTRY));
  assert.ok(Object.isFrozen(NOTICE_SEARCH_CAPABILITY));
  assert.ok(Object.isFrozen(NOTICE_SEARCH_CAPABILITY.adapters));
  assert.ok(Object.isFrozen(ENTITY_DOSSIER_CAPABILITY));
  assert.ok(Object.isFrozen(ENTITY_DOSSIER_CAPABILITY.adapters));
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

test("every MCP tool has a capability, existing contract, or scoped pilot exception", () => {
  assert.deepEqual(MCP_TOOL_BINDINGS.map(({ name }) => name), MCP_TOOLS.map(({ name }) => name));
  const search = MCP_TOOL_BINDINGS.find(({ name }) => name === "search_notices");
  assert.equal(search.capabilityReference, NOTICE_SEARCH_CAPABILITY_REFERENCE);
  assert.equal(search.adapterId, MCP_NOTICE_SEARCH_ADAPTER.id);
  const cited = MCP_TOOL_BINDINGS.find(({ name }) => name === "retrieve_cited_passages");
  assert.equal(cited.contractReference, "cityscroll.semantic_retrieval.cited_passage_response.v1");
  const exceptions = MCP_TOOL_BINDINGS.filter(({ pilotException }) => pilotException);
  assert.deepEqual(exceptions.map(({ name }) => name), ["get_notice", "preview_watch", "create_watch"]);
  assert.equal(exceptions.find(({ name }) => name === "create_watch").operationClass, "mutation");
});

test("core capability files contain no runtime or transport dependencies", () => {
  for (const path of [
    "capabilities/notice_search.mjs",
    "capabilities/entity_dossier.mjs",
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
  const catalog = buildMcpToolCatalog();
  assert.deepEqual(catalog.registered_capability_references, [
    "notice.search@1",
    "entity.dossier.get@1",
  ]);
  assert.deepEqual(catalog.tools.map(({ name }) => name), [
    "search_notices",
    "get_notice",
    "retrieve_cited_passages",
    "preview_watch",
    "create_watch",
  ]);
  assert.equal(renderMcpCatalogHtml(catalog).match(/<li>/g).length, 5);
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
