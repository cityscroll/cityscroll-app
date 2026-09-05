import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CAPABILITY_MANIFEST,
  CAPABILITY_METHODS,
  IntegrationClient,
  createIntegrationClient,
} from "../integrations/generated-client/index.mjs";
import { runExpeditedLandProjectWorkflow } from "../integrations/generated-client/recipes/land-expedited-project-workflow.mjs";
import { unsupportedQuestion } from "../integrations/generated-client/recipes/unsupported-question.mjs";
import { CAPABILITY_REGISTRY } from "../capabilities/registry.mjs";
import { MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS } from "../capabilities/mcp_tool_declarations.mjs";
import { buildApiCapabilityCatalog } from "../tools/build_capability_topology.mjs";

const ROOT = new URL("..", import.meta.url);
const CLIENT_ROOT = new URL("../integrations/generated-client/", import.meta.url);
const GENERATOR = new URL("../tools/generate_integration_client.mjs", import.meta.url);

function snapshotTree(root, prefix = "") {
  return readdirSync(new URL(prefix, root), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return snapshotTree(root, `${relativePath}/`);
    return [[relativePath, readFileSync(new URL(relativePath, root))]];
  }).sort(([left], [right]) => left.localeCompare(right));
}

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function refs(rows) {
  return rows.map(({ reference }) => reference).sort();
}

function landOutput(reference, availability = "available") {
  if (reference === "land.projects.browse@1") {
    return { capability_reference: reference, availability: "complete", results: [{ project_id: "2024Q0356" }], total_matches: 1, pagination: null, coverage: null, freshness: null, error: null };
  }
  if (reference === "land.project.get@1") {
    return { capability_reference: reference, availability, project: { project_id: "2024Q0356", canonical_href: "https://cityscroll.org/land.html#project-2024Q0356" }, error: null };
  }
  return { capability_reference: reference, availability, project_id: "2024Q0356", decision_path: { canonical_href: "https://cityscroll.org/land.html#project-2024Q0356" }, error: null };
}

function transportForLand(calls) {
  return {
    async call(request) {
      calls.push(request);
      return landOutput(request.capabilityReference);
    },
  };
}

test("generated methods cover every registered public capability", () => {
  assert.deepEqual(refs(CAPABILITY_MANIFEST.capabilities), refs(CAPABILITY_REGISTRY));
  assert.equal(CAPABILITY_METHODS.length, CAPABILITY_REGISTRY.length);
  for (const operation of CAPABILITY_MANIFEST.capabilities) {
    assert.equal(typeof IntegrationClient.prototype[operation.method], "function", operation.method);
    assert.ok(operation.input_schema_file.endsWith(".input.schema.json"));
    assert.ok(operation.output_schema_file.endsWith(".output.schema.json"));
  }
});

test("registry, public tool declarations, catalog, and documentation agree", () => {
  const catalog = buildApiCapabilityCatalog();
  const html = read("site/api.html");
  const embedded = html.match(/<script type="application\/json" id="api-capability-catalog">([\s\S]*?)<\/script>/u);
  assert.ok(embedded, "site/api.html must embed the generated catalog");
  const documentedCatalog = JSON.parse(embedded[1]);
  assert.deepEqual(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map(({ capabilityReference }) => capabilityReference).sort(), refs(CAPABILITY_REGISTRY));
  assert.deepEqual(refs(catalog.operations), refs(CAPABILITY_REGISTRY));
  assert.deepEqual(refs(documentedCatalog.operations), refs(CAPABILITY_REGISTRY));
  assert.deepEqual(refs(CAPABILITY_MANIFEST.capabilities), refs(CAPABILITY_REGISTRY));
});

test("recipes carry exact inputs, bounded outputs, availability, and link preservation", () => {
  const recipes = JSON.parse(read("integrations/generated-client/recipes/index.json"));
  const families = new Set(CAPABILITY_REGISTRY.map(({ owner }) => owner));
  assert.deepEqual(new Set(recipes.family_recipes.map(({ family }) => family)), families);
  for (const recipe of [...recipes.family_recipes, ...recipes.capability_recipes]) {
    assert.ok(recipe.input && typeof recipe.input === "object");
    assert.ok(recipe.bounded_output && typeof recipe.bounded_output === "object");
    assert.ok(Array.isArray(recipe.availability));
    assert.equal(recipe.canonical_link_policy.includes("returned without projection"), true);
    assert.equal(recipe.evidence_class, "local_contract");
  }
  const land = JSON.parse(read("integrations/generated-client/recipes/land-expedited-project-workflow.json"));
  assert.deepEqual(land.steps.map(({ method }) => method), ["landProjectsBrowse", "landProjectGet", "landDecisionPathGet"]);
  assert.deepEqual(land.steps.map(({ input }) => input), [
    { procedure: "elurp", corpus: "historical", limit: 25 },
    { project_id: "2024Q0356" },
    { project_id: "2024Q0356" },
  ]);
  assert.ok(land.steps.every(({ availability }) => availability.length > 0));
});

test("the expedited Land workflow uses only generated methods and preserves public links", async () => {
  const calls = [];
  const client = createIntegrationClient({ transport: transportForLand(calls) });
  const result = await runExpeditedLandProjectWorkflow(client);
  assert.deepEqual(calls.map(({ capabilityReference }) => capabilityReference), [
    "land.projects.browse@1",
    "land.project.get@1",
    "land.decision_path.get@1",
  ]);
  assert.equal(result.steps[1].output.project.canonical_href, "https://cityscroll.org/land.html#project-2024Q0356");
  assert.equal(result.steps[2].output.decision_path.canonical_href, "https://cityscroll.org/land.html#project-2024Q0356");
});

test("a fresh consumer maps resident questions to Land methods or an explicit gap", () => {
  const corpus = JSON.parse(read("integrations/generated-client/evaluation/corpus.json"));
  const landQuestion = corpus.questions.find(({ id }) => id === "expedited-land-project-workflow");
  assert.deepEqual(landQuestion.answer.methods, ["landProjectsBrowse", "landProjectGet", "landDecisionPathGet"]);
  assert.deepEqual(unsupportedQuestion(), { gap: "civic.outcome.prediction", nearest: ["land.project.get@1", "land.decision_path.get@1"] });
  const corpusText = read("integrations/generated-client/evaluation/corpus.json");
  const generatedText = readdirSync(new URL("../integrations/generated-client/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(new URL("../integrations/generated-client/", import.meta.url).pathname, entry.name), "utf8"))
    .join("\n");
  for (const forbidden of ["worker/src/", "GET /land-project", "GET /land-decision-path", "raw-storage", "graph query", "arbitrary route"]) {
    assert.equal(corpusText.includes(forbidden), false, forbidden);
    assert.equal(generatedText.includes(forbidden), false, forbidden);
  }
});

test("the bounded client rejects undeclared input and has no arbitrary query or route export", async () => {
  const client = createIntegrationClient({ transport: { call: async () => landOutput("land.project.get@1") } });
  await assert.rejects(() => client.landProjectGet({ project_id: "2024Q0356", route: "/anything" }), /not a declared property/);
  const exports = Object.keys(await import("../integrations/generated-client/index.mjs"));
  for (const forbidden of ["query", "route", "rawStorage", "graphQuery"]) assert.equal(exports.includes(forbidden), false, forbidden);
});

test("the HTTP transport is fixed to the public MCP endpoint", async () => {
  const seen = [];
  const response = landOutput("land.project.get@1");
  const client = createIntegrationClient({
    baseUrl: "https://api.cityscroll.org",
    fetchImpl: async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, status: 200, async json() { return { jsonrpc: "2.0", id: 1, result: { structuredContent: response } }; } };
    },
  });
  await client.landProjectGet({ project_id: "2024Q0356" });
  assert.equal(seen[0].url, "https://api.cityscroll.org/mcp");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(seen[0].body.params, { name: "get_land_project", arguments: { project_id: "2024Q0356" } });
});

test("generated evidence is limited to local contract and protocol interop", () => {
  assert.deepEqual(CAPABILITY_MANIFEST.evidence, {
    contract: "local_contract",
    protocol_interop: "local_protocol_interop",
    external_live_endpoint: false,
    deployed_runtime: false,
  });
});

test("generator check mode leaves the committed package byte-identical", () => {
  const before = snapshotTree(CLIENT_ROOT);
  execFileSync(process.execPath, [GENERATOR.pathname, "--check"], { cwd: ROOT, encoding: "utf8" });
  const after = snapshotTree(CLIENT_ROOT);
  assert.deepEqual(after, before);
});
