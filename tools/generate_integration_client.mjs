#!/usr/bin/env node

// Generate the public integration contract from the capability registry and
// the already-published MCP JSON Schemas. The generated package deliberately
// contains no provider, storage, or route implementation details.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY, validateCapabilityRegistry } from "../capabilities/registry.mjs";
import { MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS, MCP_TOOLS } from "../capabilities/mcp_tool_declarations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const GENERATED_CLIENT_ROOT = join(ROOT, "integrations/generated-client");
const SCHEMA_ROOT = join(GENERATED_CLIENT_ROOT, "schemas");
const RECIPE_ROOT = join(GENERATED_CLIENT_ROOT, "recipes");
const EVALUATION_ROOT = join(GENERATED_CLIENT_ROOT, "evaluation");

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pascalCase(value) {
  return value.split(/[_-]/u).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

export function methodName(id) {
  return id.split(".").map(pascalCase).join("").replace(/^./u, (letter) => letter.toLowerCase());
}

function snakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/-/gu, "_").toLowerCase();
}

function snakeCaseKeys(value) {
  if (Array.isArray(value)) return value.map(snakeCaseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [snakeCase(key), snakeCaseKeys(child)]));
}

function schemaType(schema) {
  if (Array.isArray(schema?.type)) return schema.type.find((type) => type !== "null") || schema.type[0];
  return schema?.type;
}

const EXAMPLE_VALUES = Object.freeze({
  query: "public hearing",
  request_id: "20260807001",
  entity_id: "vendor:example",
  procurement_id: "procurement:contract:20211201861",
  meeting_id: "meeting:city_record:20260810053",
  project_id: "2024Q0356",
  group_by: "agency",
  measure: "current",
  source_family: "city_record_notice",
  body_id: "community-board-01",
});

function sampleFromSchema(schema, propertyName = "value") {
  if (schema?.const !== undefined) return schema.const;
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema?.anyOf) && schema.anyOf.length) return sampleFromSchema(schema.anyOf[0], propertyName);
  if (Array.isArray(schema?.oneOf) && schema.oneOf.length) return sampleFromSchema(schema.oneOf[0], propertyName);
  if (EXAMPLE_VALUES[propertyName] !== undefined) return EXAMPLE_VALUES[propertyName];
  switch (schemaType(schema)) {
    case "object": return {};
    case "array": return [];
    case "integer": return schema.minimum ?? 1;
    case "number": return schema.minimum ?? 1;
    case "boolean": return false;
    case "null": return null;
    case "string": return schema.format === "date" ? "2026-01-01" : "example";
    default: return null;
  }
}

function adaptExampleInput(capability, inputSchema) {
  const example = snakeCaseKeys(capability.examples?.[0]?.input || {});
  if (!example.query && example.term_groups && inputSchema.properties?.query) example.query = example.term_groups.flat().join(" ") || "public hearing";
  if (!example.source_family && example.filters?.source_family && inputSchema.properties?.source_family) example.source_family = example.filters.source_family;
  delete example.term_groups;
  delete example.filters;
  const input = {};
  for (const [key, schema] of Object.entries(inputSchema.properties || {})) {
    if (example[key] !== undefined) input[key] = example[key];
    else if (inputSchema.required?.includes(key)) input[key] = sampleFromSchema(schema, key);
  }
  if (!Object.keys(input).length && inputSchema.properties?.query) input.query = "public hearing";
  return input;
}

function capabilityLinkFields(schema, prefix = "") {
  if (!schema || typeof schema !== "object") return [];
  const fields = [];
  for (const [key, child] of Object.entries(schema.properties || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/(?:canonical|href|url|link)/iu.test(key)) fields.push(path);
    fields.push(...capabilityLinkFields(child, path));
  }
  if (schema.items) fields.push(...capabilityLinkFields(schema.items, `${prefix}[]`));
  for (const branch of [...(schema.anyOf || []), ...(schema.oneOf || [])]) fields.push(...capabilityLinkFields(branch, prefix));
  return fields;
}

function availabilityStates(capability, outputSchema) {
  return capability.output?.availability || outputSchema.properties?.availability?.enum || [];
}

function publicToolByCapability() {
  const tools = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
  const bindings = new Map(MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS.map((binding) => [binding.capabilityReference, binding]));
  const result = new Map();
  for (const capability of CAPABILITY_REGISTRY) {
    const binding = bindings.get(capability.reference);
    if (!binding) throw new Error(`public capability has no tool declaration: ${capability.reference}`);
    const tool = tools.get(binding.name);
    if (!tool) throw new Error(`public capability has no declared tool: ${capability.reference}`);
    result.set(capability.reference, { binding, tool });
  }
  return result;
}

function operationFor(capability, { binding, tool }) {
  const inputSchema = tool.inputSchema || { type: "object", additionalProperties: false, properties: {} };
  const outputSchema = tool.outputSchema || { type: "object" };
  const linkFields = [...new Set(capabilityLinkFields(outputSchema))].sort();
  return {
    reference: capability.reference,
    id: capability.id,
    version: capability.version,
    family: capability.owner,
    method: methodName(capability.id),
    tool: binding.name,
    input_schema: inputSchema,
    output_schema: outputSchema,
    input_schema_file: `schemas/${capability.id.replaceAll(".", "_")}.input.schema.json`,
    output_schema_file: `schemas/${capability.id.replaceAll(".", "_")}.output.schema.json`,
    bounds: capability.bounds,
    availability: availabilityStates(capability, outputSchema),
    canonical_link_fields: linkFields,
    canonical_link_policy: "Validated responses are returned without projection; canonical links remain in their public response fields.",
  };
}

function familyRecipe(operation, capability) {
  return {
    schema: "cityscroll.integration_recipe.v1",
    id: `${capability.owner}.capability-recipe`,
    family: capability.owner,
    capability_reference: capability.reference,
    method: operation.method,
    input: adaptExampleInput(capability, operation.input_schema),
    bounded_output: capability.examples?.[0]?.output || {},
    output_schema: operation.output_schema_file,
    availability: operation.availability,
    canonical_link_fields: operation.canonical_link_fields,
    canonical_link_policy: operation.canonical_link_policy,
    evidence_class: "local_contract",
  };
}

const CLIENT_RUNTIME_LINES = [
  "const SCHEMAS = new Map([",
  "__SCHEMA_ENTRIES__",
  "]);",
  "const OPERATIONS = new Map(manifest.capabilities.map((operation) => [operation.reference, operation]));",
  "",
  "export class IntegrationClientError extends Error {",
  "  constructor(message, details = {}) {",
  "    super(message);",
  "    this.name = \"IntegrationClientError\";",
  "    Object.assign(this, details);",
  "  }",
  "}",
  "",
  "function isObject(value) { return value !== null && typeof value === \"object\" && !Array.isArray(value); }",
  "function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }",
  "function validateType(value, type) {",
  "  if (type === \"null\") return value === null;",
  "  if (type === \"object\") return isObject(value);",
  "  if (type === \"array\") return Array.isArray(value);",
  "  if (type === \"integer\") return Number.isInteger(value);",
  "  if (type === \"number\") return typeof value === \"number\" && Number.isFinite(value);",
  "  return typeof value === type;",
  "}",
  "",
  "export function validateJsonSchema(value, schema, path = \"$\") {",
  "  if (schema?.anyOf && !schema.anyOf.some((branch) => { try { validateJsonSchema(value, branch, path); return true; } catch { return false; } })) throw new IntegrationClientError(path + \" does not match any allowed schema\");",
  "  if (schema?.oneOf && schema.oneOf.filter((branch) => { try { validateJsonSchema(value, branch, path); return true; } catch { return false; } }).length !== 1) throw new IntegrationClientError(path + \" does not match exactly one allowed schema\");",
  "  if (schema?.const !== undefined && !sameValue(value, schema.const)) throw new IntegrationClientError(path + \" must equal the declared constant\");",
  "  if (schema?.enum && !schema.enum.some((entry) => sameValue(value, entry))) throw new IntegrationClientError(path + \" must be one of the declared values\");",
  "  const types = Array.isArray(schema?.type) ? schema.type : (schema?.type ? [schema.type] : []);",
  "  if (types.length && !types.some((type) => validateType(value, type))) throw new IntegrationClientError(path + \" has the wrong type\");",
  "  if (typeof value === \"string\") {",
  "    if (schema.minLength !== undefined && value.length < schema.minLength) throw new IntegrationClientError(path + \" is shorter than the declared bound\");",
  "    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new IntegrationClientError(path + \" is longer than the declared bound\");",
  "    if (schema.format === \"date\" && !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) throw new IntegrationClientError(path + \" is not a calendar date\");",
  "  }",
  "  if (typeof value === \"number\") {",
  "    if (schema.minimum !== undefined && value < schema.minimum) throw new IntegrationClientError(path + \" is below the declared bound\");",
  "    if (schema.maximum !== undefined && value > schema.maximum) throw new IntegrationClientError(path + \" exceeds the declared bound\");",
  "  }",
  "  if (Array.isArray(value)) {",
  "    if (schema.minItems !== undefined && value.length < schema.minItems) throw new IntegrationClientError(path + \" has too few items\");",
  "    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new IntegrationClientError(path + \" has too many items\");",
  "    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) throw new IntegrationClientError(path + \" must contain unique items\");",
  "    if (schema.items) value.forEach((entry, index) => validateJsonSchema(entry, schema.items, path + \"[\" + index + \"]\"));",
  "  }",
  "  if (isObject(value)) {",
  "    for (const field of schema.required || []) if (!(field in value)) throw new IntegrationClientError(path + \".\" + field + \" is required\");",
  "    if (schema.additionalProperties === false) for (const field of Object.keys(value)) if (!schema.properties || !(field in schema.properties)) throw new IntegrationClientError(path + \".\" + field + \" is not a declared property\");",
  "    for (const [field, child] of Object.entries(schema.properties || {})) if (field in value) validateJsonSchema(value[field], child, path + \".\" + field);",
  "  }",
  "  return value;",
  "}",
  "",
  "function resultPayload(result) {",
  "  if (result && result.structuredContent !== undefined) return result.structuredContent;",
  "  if (result?.result?.structuredContent !== undefined) return result.result.structuredContent;",
  "  return result?.result ?? result;",
  "}",
  "",
  "export function createMcpHttpTransport({ baseUrl = \"https://api.cityscroll.org\", fetchImpl = globalThis.fetch, headers = {} } = {}) {",
  "  if (typeof fetchImpl !== \"function\") throw new TypeError(\"a fetch implementation is required\");",
  "  const endpoint = new URL(\"/mcp\", baseUrl).toString();",
  "  let requestId = 0;",
  "  return Object.freeze({",
  "    async call({ toolName, input }) {",
  "      const response = await fetchImpl(endpoint, {",
  "        method: \"POST\",",
  "        headers: { \"content-type\": \"application/json\", accept: \"application/json, text/event-stream\", ...headers },",
  "        body: JSON.stringify({ jsonrpc: \"2.0\", id: ++requestId, method: \"tools/call\", params: { name: toolName, arguments: input } }),",
  "      });",
  "      const body = await response.json();",
  "      if (!response.ok) throw new IntegrationClientError(\"integration request failed\", { status: response.status, body });",
  "      if (body?.error || body?.result?.isError) throw new IntegrationClientError(\"integration response reported an error\", { body });",
  "      return resultPayload(body);",
  "    },",
  "  });",
  "}",
  "",
  "export class IntegrationClient {",
  "  #transport;",
  "  constructor({ transport, ...httpOptions } = {}) {",
  "    this.#transport = transport || createMcpHttpTransport(httpOptions);",
  "    if (!this.#transport || typeof this.#transport.call !== \"function\") throw new TypeError(\"transport.call is required\");",
  "  }",
  "",
  "__METHODS__",
  "",
  "  async #invoke(reference, input) {",
  "    const operation = OPERATIONS.get(reference);",
  "    const schemas = SCHEMAS.get(reference);",
  "    validateJsonSchema(input, schemas.input, reference + \" input\");",
  "    const result = await this.#transport.call({ capabilityReference: reference, toolName: operation.tool, input });",
  "    validateJsonSchema(result, schemas.output, reference + \" output\");",
  "    return result;",
  "  }",
  "}",
  "",
  "export function createIntegrationClient(options) { return new IntegrationClient(options); }",
  "export const CAPABILITY_METHODS = Object.freeze(manifest.capabilities.map(({ reference, method }) => ({ reference, method })));",
  "export const CAPABILITY_MANIFEST = manifest;",
];

function renderClient(operations) {
  const imports = operations.map((operation, index) => `import schema${index}Input from "./${operation.input_schema_file}" with { type: "json" };\nimport schema${index}Output from "./${operation.output_schema_file}" with { type: "json" };`).join("\n");
  const schemaEntries = operations.map((operation, index) => `  [${JSON.stringify(operation.reference)}, { input: schema${index}Input, output: schema${index}Output }],`).join("\n");
  const methods = operations.map((operation) => `  async ${operation.method}(input) {\n    return this.#invoke(${JSON.stringify(operation.reference)}, input);\n  }`).join("\n\n");
  const runtime = CLIENT_RUNTIME_LINES.join("\n").replace("__SCHEMA_ENTRIES__", schemaEntries).replace("__METHODS__", methods);
  return `// Generated from the public capability registry.\n${imports}\nimport manifest from "./manifest.json" with { type: "json" };\n\n${runtime}\n`;
}

function renderLandWorkflow() {
  return `import { createIntegrationClient } from "../index.mjs";\n\nexport async function runExpeditedLandProjectWorkflow(client = createIntegrationClient(), { projectId = "2024Q0356", corpus = "historical" } = {}) {\n  const browseInput = { procedure: "elurp", corpus, limit: 25 };\n  const browse = await client.landProjectsBrowse(browseInput);\n  const selectedProjectId = projectId || browse.results?.[0]?.project_id || null;\n  if (!selectedProjectId) return { recipe: "land-expedited-project-workflow", availability: browse.availability, steps: [{ capability_reference: "land.projects.browse@1", input: browseInput, output: browse }] };\n  const getInput = { project_id: selectedProjectId };\n  const pathInput = { project_id: selectedProjectId };\n  const project = await client.landProjectGet(getInput);\n  const decisionPath = await client.landDecisionPathGet(pathInput);\n  return { recipe: "land-expedited-project-workflow", availability: [browse.availability, project.availability, decisionPath.availability], steps: [{ capability_reference: "land.projects.browse@1", input: browseInput, output: browse }, { capability_reference: "land.project.get@1", input: getInput, output: project }, { capability_reference: "land.decision_path.get@1", input: pathInput, output: decisionPath }] };\n}\n`;
}

function renderUnsupportedQuestion() {
  return `export function unsupportedQuestion() {\n  return { gap: "civic.outcome.prediction", nearest: ["land.project.get@1", "land.decision_path.get@1"] };\n}\n`;
}

function questionForFamily(family) {
  return {
    notices: "Which public notices match a bounded resident question?",
    "entity-resolution": "What published information is available for an exact civic entity?",
    "semantic-retrieval": "Which source passages support a resident's terms?",
    "universal-search": "Which registered public lenses match a resident's search?",
    procurement: "Which public contract records or bounded summaries answer this question?",
    "people-organizations": "Which published people or organization rows match this question?",
    meetings: "What is published about this exact civic meeting?",
    land: "Which public land projects and review facts match this question?",
  }[family] || `Which public records answer this ${family} question?`;
}

function renderEvaluation(operations, familyRecipes) {
  const familyRows = familyRecipes.map((recipe) => ({ id: `${recipe.family}-question`, question: questionForFamily(recipe.family), answer: { recipe_id: recipe.id, methods: [recipe.method], capability_references: [recipe.capability_reference] } }));
  const landReferences = operations.filter(({ family }) => family === "land").map(({ reference }) => reference);
  return {
    schema: "cityscroll.integration_evaluation_corpus.v1",
    evidence_class: "local_contract",
    generated_from: "capabilities/registry.mjs",
    questions: [
      ...familyRows,
      { id: "expedited-land-project-workflow", question: "How can a resident browse an expedited land project, inspect it, and follow its decision path?", answer: { recipe_id: "land-expedited-project-workflow", methods: ["landProjectsBrowse", "landProjectGet", "landDecisionPathGet"], capability_references: landReferences } },
      { id: "unsupported-outcome-prediction", question: "What outcome will a public decision definitely produce?", answer: { gap: "civic.outcome.prediction", nearest: ["land.project.get@1", "land.decision_path.get@1"] } },
    ],
  };
}

function collectFiles(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? collectFiles(join(directory, entry.name), path) : [path];
  });
}

export function buildGeneratedOutputs() {
  validateCapabilityRegistry(CAPABILITY_REGISTRY);
  const toolMap = publicToolByCapability();
  if (toolMap.size !== CAPABILITY_REGISTRY.length) throw new Error("generated client capability set is incomplete");
  const operations = CAPABILITY_REGISTRY.map((capability) => operationFor(capability, toolMap.get(capability.reference)));
  const manifest = {
    schema: "cityscroll.integration_client_manifest.v1",
    generated_from: "capabilities/registry.mjs + capabilities/mcp_tool_declarations.mjs",
    transport: { protocol: "MCP Streamable HTTP", endpoint: "/mcp", method: "POST" },
    evidence: { contract: "local_contract", protocol_interop: "local_protocol_interop", external_live_endpoint: false, deployed_runtime: false },
    capabilities: operations.map(({ input_schema, output_schema, ...operation }) => operation),
  };
  const familyByOwner = new Map();
  for (const capability of CAPABILITY_REGISTRY) {
    if (!familyByOwner.has(capability.owner)) {
      const operation = operations.find(({ reference }) => reference === capability.reference);
      familyByOwner.set(capability.owner, familyRecipe(operation, capability));
    }
  }
  const familyRecipes = [...familyByOwner.values()].sort((left, right) => left.family.localeCompare(right.family));
  const capabilityRecipes = CAPABILITY_REGISTRY.map((capability) => familyRecipe(operations.find(({ reference }) => reference === capability.reference), capability));
  const recipeIndex = {
    schema: "cityscroll.integration_recipe_index.v1",
    generated_from: "capabilities/registry.mjs + capabilities/mcp_tool_declarations.mjs",
    evidence_class: "local_contract",
    family_recipes: familyRecipes,
    capability_recipes: capabilityRecipes,
    unsupported_question: { gap: "civic.outcome.prediction", nearest: ["land.project.get@1", "land.decision_path.get@1"] },
  };
  const files = new Map();
  files.set("index.mjs", renderClient(operations));
  files.set("manifest.json", serialize(manifest));
  for (const operation of operations) {
    files.set(operation.input_schema_file, serialize(operation.input_schema));
    files.set(operation.output_schema_file, serialize(operation.output_schema));
  }
  files.set("recipes/index.json", serialize(recipeIndex));
  files.set("recipes/land-expedited-project-workflow.json", serialize({ schema: "cityscroll.integration_recipe.v1", id: "land-expedited-project-workflow", family: "land", question: "How can a resident browse an expedited land project, inspect it, and follow its decision path?", steps: [{ method: "landProjectsBrowse", capability_reference: "land.projects.browse@1", input: { procedure: "elurp", corpus: "historical", limit: 25 }, output_schema: "schemas/land_projects_browse.output.schema.json", availability: ["complete", "empty", "unavailable"] }, { method: "landProjectGet", capability_reference: "land.project.get@1", input: { project_id: "2024Q0356" }, output_schema: "schemas/land_project_get.output.schema.json", availability: ["available", "not_yet_public", "unavailable"] }, { method: "landDecisionPathGet", capability_reference: "land.decision_path.get@1", input: { project_id: "2024Q0356" }, output_schema: "schemas/land_decision_path_get.output.schema.json", availability: ["available", "not_yet_public", "unavailable"] }], canonical_link_policy: "Each step returns its validated public response unchanged, including any canonical links.", evidence_class: "local_contract" }));
  files.set("recipes/land-expedited-project-workflow.mjs", renderLandWorkflow());
  files.set("recipes/unsupported-question.json", serialize({ schema: "cityscroll.integration_recipe_gap.v1", id: "unsupported-outcome-prediction", question: "What outcome will a public decision definitely produce?", gap: "civic.outcome.prediction", nearest: ["land.project.get@1", "land.decision_path.get@1"], evidence_class: "local_contract" }));
  files.set("recipes/unsupported-question.mjs", renderUnsupportedQuestion());
  files.set("evaluation/corpus.json", serialize(renderEvaluation(operations, familyRecipes)));
  return files;
}

export function writeOrCheckGeneratedClient({ check = false } = {}) {
  const files = buildGeneratedOutputs();
  const expectedPaths = [...files.keys()].sort();
  if (check) {
    const actualPaths = collectFiles(GENERATED_CLIENT_ROOT).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`generated integration client file set is stale (expected ${expectedPaths.join(", ")})`);
    for (const path of expectedPaths) {
      const target = join(GENERATED_CLIENT_ROOT, path);
      if (readFileSync(target, "utf8") !== files.get(path)) throw new Error(`${relative(ROOT, target)} is stale; regenerate the integration client`);
    }
    return files;
  }
  mkdirSync(SCHEMA_ROOT, { recursive: true });
  mkdirSync(RECIPE_ROOT, { recursive: true });
  mkdirSync(EVALUATION_ROOT, { recursive: true });
  for (const path of collectFiles(GENERATED_CLIENT_ROOT)) if (!files.has(path)) rmSync(join(GENERATED_CLIENT_ROOT, path));
  for (const [path, content] of files) {
    const target = join(GENERATED_CLIENT_ROOT, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return files;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    writeOrCheckGeneratedClient({ check: process.argv.includes("--check") });
    process.stdout.write(`${process.argv.includes("--check") ? "generated integration client is current" : "wrote generated integration client"}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
