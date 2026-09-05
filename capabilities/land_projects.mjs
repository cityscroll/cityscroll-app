// Transport-neutral public capabilities for Land (ZAP) projects. Identity,
// procedure resolution, and exact-action evidence remain owned by the existing
// LDP-29 resolution modules and the resident Land filter vocabulary; this file
// only states the public contract and validates provider output against it.

export const LAND_PROJECT_GET_CAPABILITY_ID = "land.project.get";
export const LAND_PROJECT_GET_CAPABILITY_VERSION = "1.0.0";
export const LAND_PROJECT_GET_CAPABILITY_REFERENCE = "land.project.get@1";
export const LAND_PROJECT_GET_PROVIDER_ID = "worker-static.land-project.get";
export const LAND_PROJECT_GET_LIMITS = Object.freeze({
  projectIdMaximumLength: 32,
  maximum: 1,
});

export const LAND_PROJECTS_BROWSE_CAPABILITY_ID = "land.projects.browse";
export const LAND_PROJECTS_BROWSE_CAPABILITY_VERSION = "1.0.0";
export const LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE = "land.projects.browse@1";
export const LAND_PROJECTS_BROWSE_PROVIDER_ID = "worker-static.land-projects.browse";
export const LAND_PROJECTS_BROWSE_LIMITS = Object.freeze({
  filterMaximumLength: 240,
  cursorMaximumLength: 320,
  minimum: 1,
  maximum: 100,
  default: 25,
});

export const LAND_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;
export const LAND_PROJECT_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const LAND_PROJECTS_BROWSE_AVAILABILITY = Object.freeze([
  "complete",
  "empty",
  "unavailable",
]);
export const LAND_PROJECTS_BROWSE_CORPUS = Object.freeze(["live", "historical"]);
export const LAND_PROJECT_PROCEDURE_RESOLUTIONS = Object.freeze(["uniform", "mixed", "unknown"]);

// Mirrors of the resident Land filter vocabulary's closed option ids
// (site/land_procedure_facet.mjs LAND_PROCEDURE_OPTIONS, site/land_status_facets.mjs
// LAND_STAGE_OPTIONS/LAND_FAMILY_OPTIONS, site/land_regulatory_effect.mjs
// LAND_REGULATORY_EFFECT_OPTIONS). Duplicated rather than imported so this
// transport-neutral capability file carries no site/ dependency; a repository
// test (test/land_project_capabilities.test.mjs) asserts these never drift
// from the resident source of truth.
export const LAND_PROCEDURE_FILTER_VALUES = Object.freeze(["review", "ulurp", "elurp", "non_ulurp"]);
export const LAND_FAMILY_FILTER_VALUES = Object.freeze([
  "any", "acquisition", "disposition", "certification", "renewal", "major_concession",
  "legal_document", "rezoning", "special_permit", "authorization", "site_selection",
  "mapping", "demapping", "urban_renewal", "landmark", "follow_up", "office_space",
  "bid", "franchise_consent", "housing_plan", "pops", "landfill",
]);
export const LAND_STAGE_FILTER_VALUES = Object.freeze([
  "any", "active", "public_review", "pre_certification", "community_board",
  "borough_president", "cpc", "city_council", "completed",
]);
export const LAND_REGULATORY_EFFECT_FILTER_VALUES = Object.freeze([
  "any", "upzone", "downzone", "mixed", "no_density_change",
]);

export const LAND_PROJECT_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "public Land project object or bounded browse envelope",
  }),
  Object.freeze({
    id: "text-summary",
    mediaType: "text/plain",
    projection: "bounded public Land project summary",
  }),
]);

const GET_INPUT_FIELDS = new Set(["projectId"]);
const BROWSE_INPUT_FIELDS = new Set([
  "status", "stage", "procedure", "family", "regulatoryEffect",
  "borough", "communityDistrict", "councilDistrict", "query",
  "corpus", "limit", "cursor",
]);
const PRIVATE_FIELD_NAMES = new Set([
  "raw_snapshot", "content_hash", "resolution_run_id", "review_status",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const COMMON = {
  owner: "land",
  operation: "read",
  authority: { class: "public-read", sideEffect: "none", approval: "none" },
  cost: { class: "bounded-static-read-model", machineFanOut: "low" },
  provenance: {
    identity: "project.project_id (exact publisher ZAP project identity)",
    sourceIdentity: "project.source_observations[].source_system",
    observationClock: "project.freshness.as_of plus source_observations[].generated_at",
    identityAuthority: "site/land_action_procedure_resolution.mjs resolveLandActionProcedures",
  },
  freshness: {
    owner: "shared Land ZAP read model",
    projection: "committed warehouse materialized_at plus per-source generated_at",
  },
};

export const LAND_PROJECT_GET_CAPABILITY = deepFreeze({
  id: LAND_PROJECT_GET_CAPABILITY_ID,
  version: LAND_PROJECT_GET_CAPABILITY_VERSION,
  reference: LAND_PROJECT_GET_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: { input: LAND_PROJECT_GET_LIMITS, output: { oneProject: true } },
  input: {
    schema: "cityscroll.capability.land_project_get.input.v1",
    identity: "exact publisher ZAP project_id",
    limits: LAND_PROJECT_GET_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.land_project_get.output.v1",
    fields: ["capability_reference", "availability", "project", "error"],
    availability: LAND_PROJECT_AVAILABILITY,
    representations: LAND_PROJECT_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
  },
  examples: [
    {
      input: { projectId: "2024Q0356" },
      output: { availability: "available", exactIdentity: true, procedureResolution: "preserved when resolvable" },
    },
    {
      input: { projectId: "not-a-real-project" },
      output: { availability: "not_yet_public", error: "not-found" },
    },
  ],
  provider: {
    id: LAND_PROJECT_GET_PROVIDER_ID,
    module: "worker/src/land_projects.mjs",
    export: "workerLandProjects",
    store: "precomputed shared Land ZAP read model",
    readModel: "warehouse-materialized ZAP projects, overlaid with exact materialized ZAP outcome evidence",
  },
  adapters: [
    {
      id: "worker-http.land-project-get@1",
      module: "worker/src/land_projects.mjs",
      kind: "http-route",
      route: "GET /land-project",
      surface: "Land project detail",
      representations: LAND_PROJECT_REPRESENTATIONS,
    },
    {
      id: "mcp.get_land_project@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_land_project",
      route: "POST /mcp",
      surface: "MCP",
      representations: LAND_PROJECT_REPRESENTATIONS,
    },
  ],
});

export const LAND_PROJECTS_BROWSE_CAPABILITY = deepFreeze({
  id: LAND_PROJECTS_BROWSE_CAPABILITY_ID,
  version: LAND_PROJECTS_BROWSE_CAPABILITY_VERSION,
  reference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: {
    input: LAND_PROJECTS_BROWSE_LIMITS,
    output: { maximumResults: LAND_PROJECTS_BROWSE_LIMITS.maximum },
  },
  input: {
    schema: "cityscroll.capability.land_projects_browse.input.v1",
    identity: "one result per exact canonical project_id",
    filters: {
      status: "resident Land status vocabulary (site/land_filter_parity.mjs LAND_FILTER_DIMENSIONS); defaults to every status, never active-only",
      stage: `resident Land review-stage facet (${LAND_STAGE_FILTER_VALUES.join(", ")})`,
      procedure: `ULURP/ELURP/Non-ULURP review-procedure facet (${LAND_PROCEDURE_FILTER_VALUES.join(", ")})`,
      family: `closed action-family facet (${LAND_FAMILY_FILTER_VALUES.join(", ")})`,
      regulatoryEffect: `closed regulatory-effect facet (${LAND_REGULATORY_EFFECT_FILTER_VALUES.join(", ")})`,
      borough: "exact borough name",
      communityDistrict: "borough-lettered community district",
      councilDistrict: "council district 1-51",
      query: "case-insensitive free text over the row",
      corpus: "'live' reads the current committed complete warehouse; 'historical' reads the frozen expedited-procedure regression corpus",
    },
    ordering: "same ordering as the resident Land query (site/resident_snapshot_queries.mjs filterLandSnapshot)",
    pagination: "opaque cursor after the last canonical project_id",
    limits: LAND_PROJECTS_BROWSE_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.land_projects_browse.output.v1",
    fields: ["capability_reference", "availability", "results", "total_matches", "pagination", "coverage", "freshness", "error"],
    availability: LAND_PROJECTS_BROWSE_AVAILABILITY,
    representations: LAND_PROJECT_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
  },
  examples: [
    {
      input: { procedure: "elurp", corpus: "historical" },
      output: { availability: "complete", oneRowPer: "exact project_id", fixedPopulation: "the frozen four-project expedited corpus" },
    },
    {
      input: { procedure: "elurp", limit: 25 },
      output: { availability: "complete", pagination: "cursor when more rows remain", fixedPopulation: "none — reflects the current committed warehouse" },
    },
  ],
  provider: {
    id: LAND_PROJECTS_BROWSE_PROVIDER_ID,
    module: "worker/src/land_projects.mjs",
    export: "workerLandProjects",
    store: "precomputed shared Land ZAP read model",
    readModel: "complete warehouse-materialized ZAP projects (every publisher status, not an active-only slice)",
  },
  adapters: [
    {
      id: "worker-http.land-projects-browse@1",
      module: "worker/src/land_projects.mjs",
      kind: "http-route",
      route: "GET /land-projects",
      surface: "Land projects browse",
      representations: LAND_PROJECT_REPRESENTATIONS,
    },
    {
      id: "mcp.browse_land_projects@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "browse_land_projects",
      route: "POST /mcp",
      surface: "MCP",
      representations: LAND_PROJECT_REPRESENTATIONS,
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

export function validateLandProjectGetInput(input) {
  assertObject(input, "land.project.get");
  for (const field of Object.keys(input)) {
    if (!GET_INPUT_FIELDS.has(field)) throw new TypeError(`land.project.get does not accept field: ${field}`);
  }
  boundedString(input.projectId, "projectId", LAND_PROJECT_GET_LIMITS.projectIdMaximumLength, { required: true });
  if (!LAND_PROJECT_ID_PATTERN.test(input.projectId.trim())) {
    throw new TypeError("projectId must be an exact publisher ZAP project id");
  }
  return input;
}

export function validateLandProjectsBrowseInput(input) {
  assertObject(input, "land.projects.browse");
  for (const field of Object.keys(input)) {
    if (!BROWSE_INPUT_FIELDS.has(field)) throw new TypeError(`land.projects.browse does not accept field: ${field}`);
  }
  for (const field of ["status", "stage", "procedure", "family", "regulatoryEffect", "borough", "communityDistrict", "councilDistrict", "query", "cursor"]) {
    boundedString(input[field], field, field === "cursor" ? LAND_PROJECTS_BROWSE_LIMITS.cursorMaximumLength : LAND_PROJECTS_BROWSE_LIMITS.filterMaximumLength);
  }
  if (input.corpus !== undefined && input.corpus !== null && !LAND_PROJECTS_BROWSE_CORPUS.includes(input.corpus)) {
    throw new TypeError(`corpus must be one of: ${LAND_PROJECTS_BROWSE_CORPUS.join(", ")}`);
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit)
      || input.limit < LAND_PROJECTS_BROWSE_LIMITS.minimum || input.limit > LAND_PROJECTS_BROWSE_LIMITS.maximum)) {
    throw new TypeError(`limit must be an integer from ${LAND_PROJECTS_BROWSE_LIMITS.minimum} through ${LAND_PROJECTS_BROWSE_LIMITS.maximum}`);
  }
  return input;
}

function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(field)) throw new TypeError(`Land project capability exposes private field: ${path}.${field}`);
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}

function assertProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)
      || typeof project.project_id !== "string"
      || !LAND_PROJECT_ID_PATTERN.test(project.project_id)
      || project.canonical_id !== `land:project:${project.project_id}`
      || typeof project.deep_link !== "string"
      || !project.deep_link.startsWith("https://cityscroll.org/browse/zoning/#land/")) {
    throw new TypeError("available Land project has incomplete exact identity or deep link");
  }
  if (!project.procedure || !Array.isArray(project.procedure.actions)) {
    throw new TypeError("available Land project requires procedure.actions");
  }
  if (!LAND_PROJECT_PROCEDURE_RESOLUTIONS.includes(project.procedure.resolution)) {
    throw new TypeError("available Land project has an invalid procedure resolution");
  }
  if (!Array.isArray(project.conflicts)) {
    throw new TypeError("available Land project requires a conflicts array");
  }
  if (!Array.isArray(project.source_observations) || !project.source_observations.length) {
    throw new TypeError("available Land project requires source provenance");
  }
  if (!project.coverage || typeof project.coverage !== "object"
      || !project.freshness || typeof project.freshness.as_of !== "string") {
    throw new TypeError("available Land project requires coverage and freshness");
  }
  assertNoPrivateFields(project);
  return project;
}

export function validateLandProjectGetOutput(result, input) {
  validateLandProjectGetInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("land.project.get provider must return an object");
  if (result.capability_reference !== LAND_PROJECT_GET_CAPABILITY_REFERENCE) throw new TypeError("land.project.get capability reference drifted");
  if (!LAND_PROJECT_AVAILABILITY.includes(result.availability)) throw new TypeError("land.project.get availability is invalid");
  if (result.availability === "available") {
    assertProject(result.project);
    if (result.project.project_id !== input.projectId.trim()) throw new TypeError("land.project.get returned a different canonical id");
    if (result.error !== null) throw new TypeError("available land.project.get output cannot carry an error");
  } else {
    if (result.project !== null) throw new TypeError("non-available land.project.get output cannot carry a project");
    if (!((result.availability === "not_yet_public" && result.error === "not-found")
      || (result.availability === "unavailable" && result.error === "unavailable"))) {
      throw new TypeError("land.project.get availability error is inconsistent");
    }
  }
  assertNoPrivateFields(result);
  return result;
}

function assertBrowseResult(result) {
  if (!Array.isArray(result.results) || result.results.length > LAND_PROJECTS_BROWSE_LIMITS.maximum) {
    throw new TypeError("land.projects.browse results exceed the declared bound");
  }
  const ids = new Set();
  for (const project of result.results) {
    assertProject(project);
    if (ids.has(project.project_id)) throw new TypeError("land.projects.browse returned duplicate canonical ids");
    ids.add(project.project_id);
  }
  if (!Number.isInteger(result.total_matches) || result.total_matches < result.results.length) {
    throw new TypeError("land.projects.browse total_matches is invalid");
  }
  const page = result.pagination;
  if (!page || page.limit < LAND_PROJECTS_BROWSE_LIMITS.minimum || page.limit > LAND_PROJECTS_BROWSE_LIMITS.maximum
      || page.returned !== result.results.length || typeof page.truncated !== "boolean"
      || (page.next_cursor !== null && typeof page.next_cursor !== "string")) {
    throw new TypeError("land.projects.browse pagination is invalid");
  }
  if (!result.coverage || !result.freshness || typeof result.freshness.as_of !== "string") {
    throw new TypeError("land.projects.browse coverage and freshness are required");
  }
  assertNoPrivateFields(result);
  return result;
}

export function validateLandProjectsBrowseOutput(result, input) {
  validateLandProjectsBrowseInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("land.projects.browse provider must return an object");
  if (result.capability_reference !== LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE) throw new TypeError("land.projects.browse capability reference drifted");
  if (!LAND_PROJECTS_BROWSE_AVAILABILITY.includes(result.availability)) throw new TypeError("land.projects.browse availability is invalid");
  if (result.availability === "unavailable") {
    if (result.results !== null || result.error !== "unavailable") throw new TypeError("unavailable land.projects.browse output is inconsistent");
  } else {
    assertBrowseResult(result);
    if (result.availability === "complete" && result.results.length === 0) throw new TypeError("empty browse result must use empty availability");
    if (result.availability === "empty" && result.results.length !== 0) throw new TypeError("non-empty browse result must use complete availability");
    if (result.error !== null) throw new TypeError("available land.projects.browse output cannot carry an error");
  }
  return result;
}

export async function executeLandProjectGet(provider, input) {
  validateLandProjectGetInput(input);
  if (!provider || provider.capabilityReference !== LAND_PROJECT_GET_CAPABILITY_REFERENCE
      || provider.providerId !== LAND_PROJECT_GET_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("land.project.get requires the registered explicit provider");
  }
  return validateLandProjectGetOutput(await provider.execute(input), input);
}

export async function executeLandProjectsBrowse(provider, input) {
  validateLandProjectsBrowseInput(input);
  if (!provider || provider.capabilityReference !== LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE
      || provider.providerId !== LAND_PROJECTS_BROWSE_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("land.projects.browse requires the registered explicit provider");
  }
  return validateLandProjectsBrowseOutput(await provider.execute(input), input);
}
