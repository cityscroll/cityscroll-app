// Generated from the public capability registry.
import schema0Input from "./schemas/notice_search.input.schema.json" with { type: "json" };
import schema0Output from "./schemas/notice_search.output.schema.json" with { type: "json" };
import schema1Input from "./schemas/notice_get.input.schema.json" with { type: "json" };
import schema1Output from "./schemas/notice_get.output.schema.json" with { type: "json" };
import schema2Input from "./schemas/entity_dossier_get.input.schema.json" with { type: "json" };
import schema2Output from "./schemas/entity_dossier_get.output.schema.json" with { type: "json" };
import schema3Input from "./schemas/entity_relationships_get.input.schema.json" with { type: "json" };
import schema3Output from "./schemas/entity_relationships_get.output.schema.json" with { type: "json" };
import schema4Input from "./schemas/cited_passages_retrieve.input.schema.json" with { type: "json" };
import schema4Output from "./schemas/cited_passages_retrieve.output.schema.json" with { type: "json" };
import schema5Input from "./schemas/search_federated.input.schema.json" with { type: "json" };
import schema5Output from "./schemas/search_federated.output.schema.json" with { type: "json" };
import schema6Input from "./schemas/contract_get.input.schema.json" with { type: "json" };
import schema6Output from "./schemas/contract_get.output.schema.json" with { type: "json" };
import schema7Input from "./schemas/contracts_browse.input.schema.json" with { type: "json" };
import schema7Output from "./schemas/contracts_browse.output.schema.json" with { type: "json" };
import schema8Input from "./schemas/contracts_analysis.input.schema.json" with { type: "json" };
import schema8Output from "./schemas/contracts_analysis.output.schema.json" with { type: "json" };
import schema9Input from "./schemas/people_get.input.schema.json" with { type: "json" };
import schema9Output from "./schemas/people_get.output.schema.json" with { type: "json" };
import schema10Input from "./schemas/organizations_browse.input.schema.json" with { type: "json" };
import schema10Output from "./schemas/organizations_browse.output.schema.json" with { type: "json" };
import schema11Input from "./schemas/meeting_get.input.schema.json" with { type: "json" };
import schema11Output from "./schemas/meeting_get.output.schema.json" with { type: "json" };
import schema12Input from "./schemas/land_project_get.input.schema.json" with { type: "json" };
import schema12Output from "./schemas/land_project_get.output.schema.json" with { type: "json" };
import schema13Input from "./schemas/land_projects_browse.input.schema.json" with { type: "json" };
import schema13Output from "./schemas/land_projects_browse.output.schema.json" with { type: "json" };
import schema14Input from "./schemas/land_decision_path_get.input.schema.json" with { type: "json" };
import schema14Output from "./schemas/land_decision_path_get.output.schema.json" with { type: "json" };
import manifest from "./manifest.json" with { type: "json" };

const SCHEMAS = new Map([
  ["notice.search@1", { input: schema0Input, output: schema0Output }],
  ["notice.get@1", { input: schema1Input, output: schema1Output }],
  ["entity.dossier.get@1", { input: schema2Input, output: schema2Output }],
  ["entity.relationships.get@1", { input: schema3Input, output: schema3Output }],
  ["cited.passages.retrieve@1", { input: schema4Input, output: schema4Output }],
  ["search.federated@1", { input: schema5Input, output: schema5Output }],
  ["contract.get@1", { input: schema6Input, output: schema6Output }],
  ["contracts.browse@1", { input: schema7Input, output: schema7Output }],
  ["contracts.analysis@1", { input: schema8Input, output: schema8Output }],
  ["people.get@1", { input: schema9Input, output: schema9Output }],
  ["organizations.browse@1", { input: schema10Input, output: schema10Output }],
  ["meeting.get@1", { input: schema11Input, output: schema11Output }],
  ["land.project.get@1", { input: schema12Input, output: schema12Output }],
  ["land.projects.browse@1", { input: schema13Input, output: schema13Output }],
  ["land.decision_path.get@1", { input: schema14Input, output: schema14Output }],
]);
const OPERATIONS = new Map(manifest.capabilities.map((operation) => [operation.reference, operation]));

export class IntegrationClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IntegrationClientError";
    Object.assign(this, details);
  }
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function validateType(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function validateJsonSchema(value, schema, path = "$") {
  if (schema?.anyOf && !schema.anyOf.some((branch) => { try { validateJsonSchema(value, branch, path); return true; } catch { return false; } })) throw new IntegrationClientError(path + " does not match any allowed schema");
  if (schema?.oneOf && schema.oneOf.filter((branch) => { try { validateJsonSchema(value, branch, path); return true; } catch { return false; } }).length !== 1) throw new IntegrationClientError(path + " does not match exactly one allowed schema");
  if (schema?.const !== undefined && !sameValue(value, schema.const)) throw new IntegrationClientError(path + " must equal the declared constant");
  if (schema?.enum && !schema.enum.some((entry) => sameValue(value, entry))) throw new IntegrationClientError(path + " must be one of the declared values");
  const types = Array.isArray(schema?.type) ? schema.type : (schema?.type ? [schema.type] : []);
  if (types.length && !types.some((type) => validateType(value, type))) throw new IntegrationClientError(path + " has the wrong type");
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new IntegrationClientError(path + " is shorter than the declared bound");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new IntegrationClientError(path + " is longer than the declared bound");
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IntegrationClientError(path + " is not a calendar date");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new IntegrationClientError(path + " is below the declared bound");
    if (schema.maximum !== undefined && value > schema.maximum) throw new IntegrationClientError(path + " exceeds the declared bound");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new IntegrationClientError(path + " has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new IntegrationClientError(path + " has too many items");
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) throw new IntegrationClientError(path + " must contain unique items");
    if (schema.items) value.forEach((entry, index) => validateJsonSchema(entry, schema.items, path + "[" + index + "]"));
  }
  if (isObject(value)) {
    for (const field of schema.required || []) if (!(field in value)) throw new IntegrationClientError(path + "." + field + " is required");
    if (schema.additionalProperties === false) for (const field of Object.keys(value)) if (!schema.properties || !(field in schema.properties)) throw new IntegrationClientError(path + "." + field + " is not a declared property");
    for (const [field, child] of Object.entries(schema.properties || {})) if (field in value) validateJsonSchema(value[field], child, path + "." + field);
  }
  return value;
}

function resultPayload(result) {
  if (result && result.structuredContent !== undefined) return result.structuredContent;
  if (result?.result?.structuredContent !== undefined) return result.result.structuredContent;
  return result?.result ?? result;
}

export function createMcpHttpTransport({ baseUrl = "https://api.cityscroll.org", fetchImpl = globalThis.fetch, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");
  const endpoint = new URL("/mcp", baseUrl).toString();
  let requestId = 0;
  return Object.freeze({
    async call({ toolName, input }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name: toolName, arguments: input } }),
      });
      const body = await response.json();
      if (!response.ok) throw new IntegrationClientError("integration request failed", { status: response.status, body });
      if (body?.error || body?.result?.isError) throw new IntegrationClientError("integration response reported an error", { body });
      return resultPayload(body);
    },
  });
}

export class IntegrationClient {
  #transport;
  constructor({ transport, ...httpOptions } = {}) {
    this.#transport = transport || createMcpHttpTransport(httpOptions);
    if (!this.#transport || typeof this.#transport.call !== "function") throw new TypeError("transport.call is required");
  }

  async noticeSearch(input) {
    return this.#invoke("notice.search@1", input);
  }

  async noticeGet(input) {
    return this.#invoke("notice.get@1", input);
  }

  async entityDossierGet(input) {
    return this.#invoke("entity.dossier.get@1", input);
  }

  async entityRelationshipsGet(input) {
    return this.#invoke("entity.relationships.get@1", input);
  }

  async citedPassagesRetrieve(input) {
    return this.#invoke("cited.passages.retrieve@1", input);
  }

  async searchFederated(input) {
    return this.#invoke("search.federated@1", input);
  }

  async contractGet(input) {
    return this.#invoke("contract.get@1", input);
  }

  async contractsBrowse(input) {
    return this.#invoke("contracts.browse@1", input);
  }

  async contractsAnalysis(input) {
    return this.#invoke("contracts.analysis@1", input);
  }

  async peopleGet(input) {
    return this.#invoke("people.get@1", input);
  }

  async organizationsBrowse(input) {
    return this.#invoke("organizations.browse@1", input);
  }

  async meetingGet(input) {
    return this.#invoke("meeting.get@1", input);
  }

  async landProjectGet(input) {
    return this.#invoke("land.project.get@1", input);
  }

  async landProjectsBrowse(input) {
    return this.#invoke("land.projects.browse@1", input);
  }

  async landDecisionPathGet(input) {
    return this.#invoke("land.decision_path.get@1", input);
  }

  async #invoke(reference, input) {
    const operation = OPERATIONS.get(reference);
    const schemas = SCHEMAS.get(reference);
    validateJsonSchema(input, schemas.input, reference + " input");
    const result = await this.#transport.call({ capabilityReference: reference, toolName: operation.tool, input });
    validateJsonSchema(result, schemas.output, reference + " output");
    return result;
  }
}

export function createIntegrationClient(options) { return new IntegrationClient(options); }
export const CAPABILITY_METHODS = Object.freeze(manifest.capabilities.map(({ reference, method }) => ({ reference, method })));
export const CAPABILITY_MANIFEST = manifest;
