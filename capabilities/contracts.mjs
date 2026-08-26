// Transport-neutral public capabilities for the observation-fed procurement object.
// Identity, browse fields, and source evidence remain owned by the existing
// shared procurement read model and its exact-identity materializers.

export const CONTRACT_GET_CAPABILITY_ID = "contract.get";
export const CONTRACT_GET_CAPABILITY_VERSION = "1.0.0";
export const CONTRACT_GET_CAPABILITY_REFERENCE = "contract.get@1";
export const CONTRACT_GET_PROVIDER_ID = "worker-static.procurement-contract.get";
export const CONTRACT_GET_LIMITS = Object.freeze({
  procurementIdMaximumLength: 320,
  maximum: 1,
});

export const CONTRACTS_BROWSE_CAPABILITY_ID = "contracts.browse";
export const CONTRACTS_BROWSE_CAPABILITY_VERSION = "1.0.0";
export const CONTRACTS_BROWSE_CAPABILITY_REFERENCE = "contracts.browse@1";
export const CONTRACTS_BROWSE_PROVIDER_ID = "worker-static.procurement-contracts.browse";
export const CONTRACTS_BROWSE_LIMITS = Object.freeze({
  filterMaximumLength: 240,
  cursorMaximumLength: 320,
  minimum: 1,
  maximum: 100,
  default: 25,
});

export const CONTRACT_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const CONTRACTS_BROWSE_AVAILABILITY = Object.freeze([
  "complete",
  "empty",
  "unavailable",
]);
export const CONTRACT_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "public procurement object or bounded browse envelope",
  }),
  Object.freeze({
    id: "text-summary",
    mediaType: "text/plain",
    projection: "bounded public procurement summary",
  }),
]);

const GET_INPUT_FIELDS = new Set(["procurementId"]);
const BROWSE_INPUT_FIELDS = new Set([
  "query", "agency", "vendor", "stage", "sourceSystem", "minAmount", "maxAmount", "limit", "cursor",
]);
const PRIVATE_FIELD_NAMES = new Set([
  "raw_snapshot", "normalized_snapshot", "content_hash", "evidence_json", "resolution_run_id", "review_status",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const COMMON = {
  owner: "procurement",
  operation: "read",
  authority: { class: "public-read", sideEffect: "none", approval: "none" },
  cost: { class: "bounded-static-read-model", machineFanOut: "low" },
  provenance: {
    identity: "contract.procurement_id (materialized from exact publisher identifiers)",
    sourceIdentity: "contract.provenance.source_observations[].source_observation_ref",
    observationClock: "contract.freshness.as_of plus source_observations[].ingested_at",
    identityAuthority: "site/procurement_object_contract.mjs exact identity gate",
  },
  freshness: {
    owner: "shared procurement read model",
    projection: "read-model generated_at, checked_at, and source envelopes",
  },
};

export const CONTRACT_GET_CAPABILITY = deepFreeze({
  id: CONTRACT_GET_CAPABILITY_ID,
  version: CONTRACT_GET_CAPABILITY_VERSION,
  reference: CONTRACT_GET_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: { input: CONTRACT_GET_LIMITS, output: { oneContract: true } },
  input: {
    schema: "cityscroll.capability.contract_get.input.v1",
    identity: "exact canonical procurement_id",
    limits: CONTRACT_GET_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.contract_get.output.v1",
    fields: ["capability_reference", "availability", "contract", "error"],
    availability: CONTRACT_AVAILABILITY,
    representations: CONTRACT_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
  },
  examples: [
    {
      input: { procurementId: "procurement:contract:20211201861" },
      output: { availability: "available", exactIdentity: true, lifecycle: "preserved when present" },
    },
    {
      input: { procurementId: "procurement:contract:not-published" },
      output: { availability: "not_yet_public", error: "not-found" },
    },
  ],
  provider: {
    id: CONTRACT_GET_PROVIDER_ID,
    module: "worker/src/contracts.mjs",
    export: "workerProcurementContracts",
    store: "precomputed shared procurement read model",
    readModel: "observation-fed procurement objects",
  },
  adapters: [
    {
      id: "worker-http.contract-get@1",
      module: "worker/src/contracts.mjs",
      kind: "http-route",
      route: "GET /contract",
      surface: "Contract detail",
      representations: CONTRACT_REPRESENTATIONS,
    },
    {
      id: "mcp.get_contract@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_contract",
      route: "POST /mcp",
      surface: "MCP",
      representations: CONTRACT_REPRESENTATIONS,
    },
  ],
});

export const CONTRACTS_BROWSE_CAPABILITY = deepFreeze({
  id: CONTRACTS_BROWSE_CAPABILITY_ID,
  version: CONTRACTS_BROWSE_CAPABILITY_VERSION,
  reference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: {
    input: CONTRACTS_BROWSE_LIMITS,
    output: { maximumResults: CONTRACTS_BROWSE_LIMITS.maximum },
  },
  input: {
    schema: "cityscroll.capability.contracts_browse.input.v1",
    identity: "one result per exact canonical procurement_id",
    filters: {
      query: "case-insensitive token match over the existing Contracts browse projection",
      agency: "case-insensitive substring",
      vendor: "case-insensitive substring",
      stage: "exact stage value",
      sourceSystem: "exact source-system value",
      minAmount: "inclusive valid public amount floor",
      maxAmount: "inclusive valid public amount ceiling",
    },
    ordering: "canonical procurement_id ascending",
    pagination: "opaque cursor after the last canonical procurement_id",
    limits: CONTRACTS_BROWSE_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.contracts_browse.output.v1",
    fields: ["capability_reference", "availability", "results", "total_matches", "pagination", "coverage", "freshness", "error"],
    availability: CONTRACTS_BROWSE_AVAILABILITY,
    representations: CONTRACT_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
  },
  examples: [
    {
      input: { agency: "design and construction", stage: "award", limit: 10 },
      output: { availability: "complete", maximumResults: 10, oneRowPer: "exact procurement_id" },
    },
    {
      input: { sourceSystem: "passport_public_contracts", limit: 25 },
      output: { availability: "complete", pagination: "cursor when more rows remain" },
    },
  ],
  provider: {
    id: CONTRACTS_BROWSE_PROVIDER_ID,
    module: "worker/src/contracts.mjs",
    export: "workerProcurementContracts",
    store: "precomputed shared procurement read model",
    readModel: "observation-fed procurement objects",
  },
  adapters: [
    {
      id: "worker-http.contracts-browse@1",
      module: "worker/src/contracts.mjs",
      kind: "http-route",
      route: "GET /contracts",
      surface: "Contracts browse",
      representations: CONTRACT_REPRESENTATIONS,
    },
    {
      id: "mcp.browse_contracts@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "browse_contracts",
      route: "POST /mcp",
      surface: "MCP",
      representations: CONTRACT_REPRESENTATIONS,
    },
  ],
});

function assertObject(input, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${name} input must be an object`);
  }
}

function boundedString(value, field, maximum, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError(`${field} is required`);
    return;
  }
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) {
    throw new TypeError(`${field} must be a bounded string`);
  }
}

export function validateContractGetInput(input) {
  assertObject(input, "contract.get");
  for (const field of Object.keys(input)) {
    if (!GET_INPUT_FIELDS.has(field)) throw new TypeError(`contract.get does not accept field: ${field}`);
  }
  boundedString(input.procurementId, "procurementId", CONTRACT_GET_LIMITS.procurementIdMaximumLength, { required: true });
  if (!input.procurementId.trim().startsWith("procurement:")) {
    throw new TypeError("procurementId must be an exact canonical procurement id");
  }
  return input;
}

export function validateContractsBrowseInput(input) {
  assertObject(input, "contracts.browse");
  for (const field of Object.keys(input)) {
    if (!BROWSE_INPUT_FIELDS.has(field)) throw new TypeError(`contracts.browse does not accept field: ${field}`);
  }
  for (const field of ["query", "agency", "vendor", "stage", "sourceSystem", "cursor"]) {
    boundedString(input[field], field, field === "cursor" ? CONTRACTS_BROWSE_LIMITS.cursorMaximumLength : CONTRACTS_BROWSE_LIMITS.filterMaximumLength);
  }
  for (const field of ["minAmount", "maxAmount"]) {
    if (input[field] !== undefined && input[field] !== null
        && (typeof input[field] !== "number" || !Number.isFinite(input[field]))) {
      throw new TypeError(`${field} must be a finite number`);
    }
  }
  if (input.minAmount !== undefined && input.maxAmount !== undefined
      && input.minAmount !== null && input.maxAmount !== null && input.minAmount > input.maxAmount) {
    throw new TypeError("minAmount must not exceed maxAmount");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit)
      || input.limit < CONTRACTS_BROWSE_LIMITS.minimum || input.limit > CONTRACTS_BROWSE_LIMITS.maximum)) {
    throw new TypeError(`limit must be an integer from ${CONTRACTS_BROWSE_LIMITS.minimum} through ${CONTRACTS_BROWSE_LIMITS.maximum}`);
  }
  return input;
}

function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(field)) throw new TypeError(`procurement capability exposes private field: ${path}.${field}`);
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}

function assertContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)
      || contract.object_type !== "procurement"
      || typeof contract.procurement_id !== "string"
      || contract.canonical_id !== contract.procurement_id
      || !contract.procurement_id.startsWith("procurement:")
      || !contract.provenance?.identity?.exact) {
    throw new TypeError("available procurement contract has incomplete exact identity");
  }
  if (!Array.isArray(contract.provenance.source_observations)
      || !contract.provenance.source_observations.length) {
    throw new TypeError("available procurement contract requires source provenance");
  }
  if (!contract.coverage || typeof contract.coverage.state !== "string"
      || !contract.freshness || typeof contract.freshness.as_of !== "string") {
    throw new TypeError("available procurement contract requires coverage and freshness");
  }
  if (!contract.amount || typeof contract.amount.valid !== "boolean") {
    throw new TypeError("available procurement contract requires amount validity");
  }
  assertNoPrivateFields(contract);
  return contract;
}

export function validateContractGetOutput(result, input) {
  validateContractGetInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("contract.get provider must return an object");
  if (result.capability_reference !== CONTRACT_GET_CAPABILITY_REFERENCE) throw new TypeError("contract.get capability reference drifted");
  if (!CONTRACT_AVAILABILITY.includes(result.availability)) throw new TypeError("contract.get availability is invalid");
  if (result.availability === "available") {
    assertContract(result.contract);
    if (result.contract.procurement_id !== input.procurementId.trim()) throw new TypeError("contract.get returned a different canonical id");
    if (result.error !== null) throw new TypeError("available contract.get output cannot carry an error");
  } else {
    if (result.contract !== null) throw new TypeError("non-available contract.get output cannot carry a contract");
    if (!((result.availability === "not_yet_public" && result.error === "not-found")
      || (result.availability === "unavailable" && result.error === "unavailable"))) {
      throw new TypeError("contract.get availability error is inconsistent");
    }
  }
  assertNoPrivateFields(result);
  return result;
}

function assertBrowseResult(result) {
  if (!Array.isArray(result.results) || result.results.length > CONTRACTS_BROWSE_LIMITS.maximum) {
    throw new TypeError("contracts.browse results exceed the declared bound");
  }
  const ids = new Set();
  for (const contract of result.results) {
    assertContract(contract);
    if (ids.has(contract.procurement_id)) throw new TypeError("contracts.browse returned duplicate canonical ids");
    ids.add(contract.procurement_id);
  }
  if (!Number.isInteger(result.total_matches) || result.total_matches < result.results.length) {
    throw new TypeError("contracts.browse total_matches is invalid");
  }
  const page = result.pagination;
  if (!page || page.limit < CONTRACTS_BROWSE_LIMITS.minimum || page.limit > CONTRACTS_BROWSE_LIMITS.maximum
      || page.returned !== result.results.length || typeof page.truncated !== "boolean"
      || (page.next_cursor !== null && typeof page.next_cursor !== "string")) {
    throw new TypeError("contracts.browse pagination is invalid");
  }
  if (!result.coverage || !result.freshness || typeof result.freshness.as_of !== "string") {
    throw new TypeError("contracts.browse coverage and freshness are required");
  }
  assertNoPrivateFields(result);
  return result;
}

export function validateContractsBrowseOutput(result, input) {
  validateContractsBrowseInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("contracts.browse provider must return an object");
  if (result.capability_reference !== CONTRACTS_BROWSE_CAPABILITY_REFERENCE) throw new TypeError("contracts.browse capability reference drifted");
  if (!CONTRACTS_BROWSE_AVAILABILITY.includes(result.availability)) throw new TypeError("contracts.browse availability is invalid");
  if (result.availability === "unavailable") {
    if (result.results !== null || result.error !== "unavailable") throw new TypeError("unavailable contracts.browse output is inconsistent");
  } else {
    assertBrowseResult(result);
    if (result.availability === "complete" && result.results.length === 0) throw new TypeError("empty browse result must use empty availability");
    if (result.availability === "empty" && result.results.length !== 0) throw new TypeError("non-empty browse result must use complete availability");
    if (result.error !== null) throw new TypeError("available contracts.browse output cannot carry an error");
  }
  return result;
}

export async function executeContractGet(provider, input) {
  validateContractGetInput(input);
  if (!provider || provider.capabilityReference !== CONTRACT_GET_CAPABILITY_REFERENCE
      || provider.providerId !== CONTRACT_GET_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("contract.get requires the registered explicit provider");
  }
  return validateContractGetOutput(await provider.execute(input), input);
}

export async function executeContractsBrowse(provider, input) {
  validateContractsBrowseInput(input);
  if (!provider || provider.capabilityReference !== CONTRACTS_BROWSE_CAPABILITY_REFERENCE
      || provider.providerId !== CONTRACTS_BROWSE_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("contracts.browse requires the registered explicit provider");
  }
  return validateContractsBrowseOutput(await provider.execute(input), input);
}
