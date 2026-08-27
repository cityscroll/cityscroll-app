// Transport-neutral public capability over the materialized People and
// organizations read model. The provider owns the existing row projection;
// this contract only bounds inputs and validates public identity/coverage.

export const PEOPLE_GET_CAPABILITY_ID = "people.get";
export const PEOPLE_GET_CAPABILITY_VERSION = "1.0.0";
export const PEOPLE_GET_CAPABILITY_REFERENCE = "people.get@1";
export const PEOPLE_GET_PROVIDER_ID = "worker-static.people-organizations.get";
export const PEOPLE_GET_LIMITS = Object.freeze({ entityIdMaximumLength: 320, maximum: 1 });

export const ORGANIZATIONS_BROWSE_CAPABILITY_ID = "organizations.browse";
export const ORGANIZATIONS_BROWSE_CAPABILITY_VERSION = "1.0.0";
export const ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE = "organizations.browse@1";
export const ORGANIZATIONS_BROWSE_PROVIDER_ID = "worker-static.people-organizations.browse";
export const ORGANIZATIONS_BROWSE_LIMITS = Object.freeze({
  queryMaximumLength: 240,
  kindMaximumLength: 80,
  cursorMaximumLength: 320,
  minimum: 1,
  maximum: 100,
  default: 25,
});

export const PEOPLE_ORGANIZATION_ROW_KINDS = Object.freeze([
  "official", "exact-person-appointment", "notice-only-hire", "agency", "vendor", "committee", "community-board",
]);
export const PEOPLE_RELATION_STATES = Object.freeze(["published", "empty", "unknown"]);
export const PEOPLE_GET_AVAILABILITY = Object.freeze(["available", "not_yet_public", "unavailable"]);
export const ORGANIZATIONS_BROWSE_AVAILABILITY = Object.freeze(["complete", "empty", "unavailable"]);
export const PEOPLE_REPRESENTATIONS = Object.freeze([
  Object.freeze({ id: "json", mediaType: "application/json", projection: "typed public people or organization row" }),
  Object.freeze({ id: "text-summary", mediaType: "text/plain", projection: "bounded public row summary" }),
]);

const GET_FIELDS = new Set(["entityId"]);
const BROWSE_FIELDS = new Set(["query", "kind", "limit", "cursor"]);
const PRIVATE_FIELDS = new Set(["raw_snapshot", "normalized_snapshot", "content_hash", "evidence_json", "resolution_run_id"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const COMMON = {
  owner: "people-organizations",
  operation: "read",
  authority: { class: "public-read", sideEffect: "none", approval: "none" },
  cost: { class: "bounded-static-read-model", machineFanOut: "low" },
  provenance: {
    identity: "row.id from site/people_organizations_read_model.mjs; display names never mint identity",
    sourceIdentity: "row.source_record_id when the source publishes one; otherwise the source-specific identity fields are retained",
    observationClock: "read-model generated_at",
    identityAuthority: "site/people_organizations_read_model.mjs exact row construction",
  },
  freshness: { owner: "people and organizations read model", projection: "read-model generated_at" },
  presentationOnly: { omittedFields: ["search_text"], reason: "search_text is an index projection used only to apply the bounded query filter" },
};

export const PEOPLE_GET_CAPABILITY = deepFreeze({
  id: PEOPLE_GET_CAPABILITY_ID,
  version: PEOPLE_GET_CAPABILITY_VERSION,
  reference: PEOPLE_GET_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: { input: PEOPLE_GET_LIMITS, output: { oneRow: true } },
  input: { schema: "cityscroll.capability.people_get.input.v1", identity: "exact canonical people/organization row id", limits: PEOPLE_GET_LIMITS },
  output: { schema: "cityscroll.capability.people_get.output.v1", fields: ["capability_reference", "availability", "person_or_organization", "error"], availability: PEOPLE_GET_AVAILABILITY, representations: PEOPLE_REPRESENTATIONS, privateFieldsForbidden: [...PRIVATE_FIELDS], presentationOnlyOmitted: ["search_text"] },
  examples: [
    { input: { entityId: "official:example" }, output: { availability: "available", exactIdentity: true } },
    { input: { entityId: "agency:id:not-published" }, output: { availability: "not_yet_public", error: "not-found" } },
  ],
  provider: { id: PEOPLE_GET_PROVIDER_ID, module: "worker/src/people_organizations.mjs", export: "workerPeopleOrganizations", store: "precomputed people and organizations read model", readModel: "typed People + organizations rows" },
  adapters: [
    { id: "worker-http.people-get@1", module: "worker/src/people_organizations.mjs", kind: "http-route", route: "GET /people-organizations?id=", surface: "People and organizations", representations: PEOPLE_REPRESENTATIONS },
    { id: "mcp.get_person_or_organization@1", module: "worker/src/mcp.mjs", kind: "mcp-tool", tool: "get_person_or_organization", route: "POST /mcp", surface: "MCP", representations: PEOPLE_REPRESENTATIONS },
  ],
});

export const ORGANIZATIONS_BROWSE_CAPABILITY = deepFreeze({
  id: ORGANIZATIONS_BROWSE_CAPABILITY_ID,
  version: ORGANIZATIONS_BROWSE_CAPABILITY_VERSION,
  reference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: { input: ORGANIZATIONS_BROWSE_LIMITS, output: { maximumResults: ORGANIZATIONS_BROWSE_LIMITS.maximum } },
  input: {
    schema: "cityscroll.capability.organizations_browse.input.v1",
    filters: { query: "case-insensitive token match over the existing read-model search_text projection", kind: "exact row kind from the closed vocabulary" },
    ordering: "row kind order, then label, then exact row id (the existing read-model order)",
    pagination: "opaque cursor after the last exact row id",
    limits: ORGANIZATIONS_BROWSE_LIMITS,
  },
  output: { schema: "cityscroll.capability.organizations_browse.output.v1", fields: ["capability_reference", "availability", "results", "total_matches", "pagination", "coverage", "freshness", "error"], availability: ORGANIZATIONS_BROWSE_AVAILABILITY, representations: PEOPLE_REPRESENTATIONS, privateFieldsForbidden: [...PRIVATE_FIELDS], presentationOnlyOmitted: ["search_text"] },
  examples: [
    { input: { kind: "agency", limit: 10 }, output: { availability: "complete", maximumResults: 10, oneRowPer: "exact read-model row id" } },
    { input: { query: "community board", limit: 25 }, output: { availability: "complete", pagination: "cursor when more rows remain" } },
  ],
  provider: { id: ORGANIZATIONS_BROWSE_PROVIDER_ID, module: "worker/src/people_organizations.mjs", export: "workerPeopleOrganizations", store: "precomputed people and organizations read model", readModel: "typed People + organizations rows" },
  adapters: [
    { id: "worker-http.organizations-browse@1", module: "worker/src/people_organizations.mjs", kind: "http-route", route: "GET /people-organizations", surface: "People and organizations browse", representations: PEOPLE_REPRESENTATIONS },
    { id: "mcp.browse_organizations@1", module: "worker/src/mcp.mjs", kind: "mcp-tool", tool: "browse_organizations", route: "POST /mcp", surface: "MCP", representations: PEOPLE_REPRESENTATIONS },
  ],
});

function assertObject(input, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} input must be an object`);
}
function boundedString(value, field, maximum, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError(`${field} is required`);
    return;
  }
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) throw new TypeError(`${field} must be a bounded string`);
}
function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(field)) throw new TypeError(`people capability exposes private field: ${path}.${field}`);
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}
function assertRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)
      || !PEOPLE_ORGANIZATION_ROW_KINDS.includes(row.kind)
      || typeof row.id !== "string" || !row.id.trim()
      || typeof row.label !== "string" || !row.label.trim()
      || !PEOPLE_RELATION_STATES.includes(row.relation_state)) throw new TypeError("people row has incomplete typed identity");
  assertNoPrivateFields(row);
  return row;
}

export function validatePeopleGetInput(input) {
  assertObject(input, "people.get");
  for (const field of Object.keys(input)) if (!GET_FIELDS.has(field)) throw new TypeError(`people.get does not accept field: ${field}`);
  boundedString(input.entityId, "entityId", PEOPLE_GET_LIMITS.entityIdMaximumLength, true);
  if (!input.entityId.trim().includes(":")) throw new TypeError("entityId must be an exact canonical row id");
  return input;
}
export function validateOrganizationsBrowseInput(input) {
  assertObject(input, "organizations.browse");
  for (const field of Object.keys(input)) if (!BROWSE_FIELDS.has(field)) throw new TypeError(`organizations.browse does not accept field: ${field}`);
  boundedString(input.query, "query", ORGANIZATIONS_BROWSE_LIMITS.queryMaximumLength);
  boundedString(input.kind, "kind", ORGANIZATIONS_BROWSE_LIMITS.kindMaximumLength);
  boundedString(input.cursor, "cursor", ORGANIZATIONS_BROWSE_LIMITS.cursorMaximumLength);
  if (input.kind !== undefined && input.kind !== null && !PEOPLE_ORGANIZATION_ROW_KINDS.includes(input.kind)) throw new TypeError("kind is not a supported people/organization row kind");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < ORGANIZATIONS_BROWSE_LIMITS.minimum || input.limit > ORGANIZATIONS_BROWSE_LIMITS.maximum)) throw new TypeError(`limit must be an integer from ${ORGANIZATIONS_BROWSE_LIMITS.minimum} through ${ORGANIZATIONS_BROWSE_LIMITS.maximum}`);
  return input;
}

export function validatePeopleGetOutput(result, input) {
  validatePeopleGetInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result) || result.capability_reference !== PEOPLE_GET_CAPABILITY_REFERENCE || !PEOPLE_GET_AVAILABILITY.includes(result.availability)) throw new TypeError("people.get output is invalid");
  if (result.availability === "available") {
    assertRow(result.person_or_organization);
    if (result.person_or_organization.id !== input.entityId.trim() || result.error !== null) throw new TypeError("people.get returned inconsistent identity or error");
  } else if (result.person_or_organization !== null || result.error !== (result.availability === "not_yet_public" ? "not-found" : "unavailable")) throw new TypeError("people.get unavailable output is inconsistent");
  assertNoPrivateFields(result);
  return result;
}
function assertBrowseEnvelope(result) {
  if (!Array.isArray(result.results) || result.results.length > ORGANIZATIONS_BROWSE_LIMITS.maximum || result.results.some((row) => !assertRow(row))) throw new TypeError("organizations.browse results are invalid");
  if (!Number.isInteger(result.total_matches) || result.total_matches < result.results.length) throw new TypeError("organizations.browse total_matches is invalid");
  const page = result.pagination;
  if (!page || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > ORGANIZATIONS_BROWSE_LIMITS.maximum || page.returned !== result.results.length || typeof page.truncated !== "boolean" || (page.next_cursor !== null && typeof page.next_cursor !== "string")) throw new TypeError("organizations.browse pagination is invalid");
  if (!result.coverage || typeof result.coverage.state !== "string" || !result.freshness || typeof result.freshness.as_of !== "string") throw new TypeError("organizations.browse coverage and freshness are required");
}
export function validateOrganizationsBrowseOutput(result, input) {
  validateOrganizationsBrowseInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result) || result.capability_reference !== ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE || !ORGANIZATIONS_BROWSE_AVAILABILITY.includes(result.availability)) throw new TypeError("organizations.browse output is invalid");
  if (result.availability === "unavailable") {
    if (result.results !== null || result.error !== "unavailable") throw new TypeError("unavailable organizations.browse output is inconsistent");
  } else {
    assertBrowseEnvelope(result);
    if ((result.availability === "complete") !== (result.results.length > 0) || result.error !== null) throw new TypeError("organizations.browse availability is inconsistent");
  }
  assertNoPrivateFields(result);
  return result;
}
export async function executePeopleGet(provider, input) {
  validatePeopleGetInput(input);
  if (!provider || provider.capabilityReference !== PEOPLE_GET_CAPABILITY_REFERENCE || provider.providerId !== PEOPLE_GET_PROVIDER_ID || typeof provider.execute !== "function") throw new TypeError("people.get requires the registered explicit provider");
  return validatePeopleGetOutput(await provider.execute(input), input);
}
export async function executeOrganizationsBrowse(provider, input) {
  validateOrganizationsBrowseInput(input);
  if (!provider || provider.capabilityReference !== ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE || provider.providerId !== ORGANIZATIONS_BROWSE_PROVIDER_ID || typeof provider.execute !== "function") throw new TypeError("organizations.browse requires the registered explicit provider");
  return validateOrganizationsBrowseOutput(await provider.execute(input), input);
}
