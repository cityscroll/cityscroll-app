// Transport-neutral public contract for the resolved Land decision path.
// The provider lives in worker/src/land_projects.mjs; procedure topology stays
// owned by the resident Land resolution modules.

export const LAND_DECISION_PATH_GET_CAPABILITY_ID = "land.decision_path.get";
export const LAND_DECISION_PATH_GET_CAPABILITY_VERSION = "1.0.0";
export const LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE = "land.decision_path.get@1";
export const LAND_DECISION_PATH_GET_PROVIDER_ID = "worker-static.land-decision-path.get";
export const LAND_DECISION_PATH_GET_LIMITS = Object.freeze({
  projectIdMaximumLength: 32,
  maximum: 1,
});

export const LAND_DECISION_PATH_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const LAND_DECISION_PATH_RESOLUTIONS = Object.freeze(["uniform", "mixed", "unknown"]);
export const LAND_DECISION_PATH_STATES = Object.freeze(["known", "unknown", "absent", "present"]);
export const LAND_DECISION_PATH_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "observed and normative Land decision-path view",
  }),
  Object.freeze({
    id: "text-summary",
    mediaType: "text/plain",
    projection: "bounded Land decision-path summary",
  }),
]);

const PRIVATE_FIELD_NAMES = new Set([
  "raw_snapshot", "content_hash", "resolution_run_id", "review_status",
]);
const INPUT_FIELDS = new Set(["projectId"]);

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
    identity: "decision_path.project_id (exact publisher ZAP project identity)",
    sourceIdentity: "evidence[].source_id",
    observationClock: "observed.current_phase and observed.events source times",
    identityAuthority: "site/land_decision_path.mjs buildLandDecisionPathView",
  },
  freshness: {
    owner: "shared Land ZAP read model",
    projection: "committed warehouse materialized_at plus per-source generated_at",
  },
};

export const LAND_DECISION_PATH_GET_CAPABILITY = deepFreeze({
  id: LAND_DECISION_PATH_GET_CAPABILITY_ID,
  version: LAND_DECISION_PATH_GET_CAPABILITY_VERSION,
  reference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
  ...COMMON,
  bounds: { input: LAND_DECISION_PATH_GET_LIMITS, output: { oneProject: true } },
  input: {
    schema: "cityscroll.capability.land_decision_path_get.input.v1",
    identity: "exact publisher ZAP project_id",
    limits: LAND_DECISION_PATH_GET_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.land_decision_path_get.output.v1",
    fields: ["capability_reference", "availability", "project_id", "decision_path", "error"],
    availability: LAND_DECISION_PATH_AVAILABILITY,
    resolutions: LAND_DECISION_PATH_RESOLUTIONS,
    representations: LAND_DECISION_PATH_REPRESENTATIONS,
    privateFieldsForbidden: [...PRIVATE_FIELD_NAMES],
    layerContract: {
      observed: ["observed_current_phase", "observed_events", "observed.gaps"],
      normative: ["normative_current_stage", "current_actors", "expected_next_transition", "parallel_review_groups", "normative_stages"],
      groupedProjection: { observed: ["current_phase", "events", "gaps"], normative: ["current_stage", "current_actors", "expected_next_transition", "parallel_review_groups", "stages"] },
      rule: "observed events never appear under normative keys and normative stages never appear under observed keys",
    },
  },
  examples: [
    {
      input: { projectId: "2024Q0356" },
      output: { availability: "available", procedureResolution: "uniform", parallelReviewGroups: 1 },
    },
    {
      input: { projectId: "not-a-real-project" },
      output: { availability: "not_yet_public", error: "not-found" },
    },
  ],
  provider: {
    id: LAND_DECISION_PATH_GET_PROVIDER_ID,
    module: "worker/src/land_projects.mjs",
    export: "workerLandProjects",
    store: "precomputed shared Land ZAP read model",
    readModel: "the same resident Land phase spine and reviewed procedure profile used by the detail interface",
  },
  adapters: [
    {
      id: "worker-http.land-decision-path-get@1",
      module: "worker/src/land_projects.mjs",
      kind: "http-route",
      route: "GET /land-decision-path",
      surface: "Land project decision path",
      representations: LAND_DECISION_PATH_REPRESENTATIONS,
    },
    {
      id: "mcp.get_land_decision_path@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_land_decision_path",
      route: "POST /mcp",
      surface: "MCP",
      representations: LAND_DECISION_PATH_REPRESENTATIONS,
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

export function validateLandDecisionPathGetInput(input) {
  assertObject(input, "land.decision_path.get");
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) throw new TypeError(`land.decision_path.get does not accept field: ${field}`);
  }
  boundedString(input.projectId, "projectId", LAND_DECISION_PATH_GET_LIMITS.projectIdMaximumLength, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(input.projectId.trim())) {
    throw new TypeError("projectId must be an exact publisher ZAP project id");
  }
  return input;
}

function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (PRIVATE_FIELD_NAMES.has(field)) throw new TypeError(`Land decision path exposes private field: ${path}.${field}`);
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}

function assertLayer(value, expected, path) {
  if (!value || typeof value !== "object" || value.layer !== expected) {
    throw new TypeError(`${path} must be explicitly ${expected}`);
  }
}

function assertDecisionPath(path) {
  if (!path || typeof path !== "object" || Array.isArray(path)) throw new TypeError("decision_path is required");
  if (path.schema !== "cityscroll.land_decision_path_view.v1") throw new TypeError("decision_path schema drifted");
  if (!path.procedure || !LAND_DECISION_PATH_RESOLUTIONS.includes(path.procedure.resolution)) {
    throw new TypeError("decision_path procedure resolution is invalid");
  }
  if (!path.observed || !path.normative || !path.evidence) throw new TypeError("decision_path layers are required");
  for (const field of ["observed_current_phase", "observed_events", "normative_current_stage", "current_actors", "expected_next_transition", "parallel_review_groups", "normative_stages"]) {
    if (!Object.hasOwn(path, field)) throw new TypeError(`decision_path field is required: ${field}`);
  }
  if (!Array.isArray(path.observed.events) || !Array.isArray(path.observed.gaps)) throw new TypeError("observed decision-path fields are invalid");
  for (const event of path.observed.events) {
    assertLayer(event, "observed", "observed.events[]");
    if (event.stage_id || event.role || event.effect) throw new TypeError("observed event contains normative stage fields");
  }
  if (!Array.isArray(path.observed_events)) throw new TypeError("observed_events must be an array");
  for (const event of path.observed_events) {
    assertLayer(event, "observed", "observed_events[]");
    if (event.stage_id || event.role || event.effect) throw new TypeError("observed_events contains normative stage fields");
  }
  if (Object.hasOwn(path.observed, "stages") || Object.hasOwn(path.observed, "current_stage")) {
    throw new TypeError("normative stage appeared under observed decision-path keys");
  }
  if (Object.hasOwn(path.normative, "events") || Object.hasOwn(path.normative, "observed_events")) {
    throw new TypeError("observed event appeared under normative decision-path keys");
  }
  if (!Array.isArray(path.normative.stages) || !Array.isArray(path.normative.current_actors)
      || !Array.isArray(path.normative.parallel_review_groups)) {
    throw new TypeError("normative decision-path fields are invalid");
  }
  assertLayer(path.normative.current_stage, "normative", "normative.current_stage");
  assertLayer(path.observed_current_phase, "observed", "observed_current_phase");
  assertLayer(path.normative_current_stage, "normative", "normative_current_stage");
  for (const stage of path.normative.stages) assertLayer(stage, "normative", "normative.stages[]");
  for (const stage of path.normative_stages) assertLayer(stage, "normative", "normative_stages[]");
  for (const actor of path.normative.current_actors) assertLayer(actor, "normative", "normative.current_actors[]");
  for (const actor of path.current_actors) assertLayer(actor, "normative", "current_actors[]");
  for (const group of path.normative.parallel_review_groups) {
    if (!Array.isArray(group.stages) || group.stages.length < 2) throw new TypeError("parallel review group must retain concurrent stages");
    for (const stage of group.stages) assertLayer(stage, "normative", "normative.parallel_review_groups[].stages[]");
  }
  if (!Array.isArray(path.parallel_review_groups)) throw new TypeError("parallel_review_groups must be an array");
  for (const group of path.parallel_review_groups) {
    if (!Array.isArray(group.stages) || group.stages.length < 2) throw new TypeError("parallel_review_groups must retain concurrent stages");
    for (const stage of group.stages) assertLayer(stage, "normative", "parallel_review_groups[].stages[]");
  }
  const transition = path.normative.expected_next_transition;
  if (transition) {
    assertLayer(transition, "normative", "normative.expected_next_transition");
    if (!Array.isArray(transition.stages)) throw new TypeError("expected transition stages are required");
    for (const stage of transition.stages) assertLayer(stage, "normative", "normative.expected_next_transition.stages[]");
  }
  if (path.expected_next_transition) {
    assertLayer(path.expected_next_transition, "normative", "expected_next_transition");
    if (!Array.isArray(path.expected_next_transition.stages)) throw new TypeError("expected_next_transition stages are required");
    for (const stage of path.expected_next_transition.stages) assertLayer(stage, "normative", "expected_next_transition.stages[]");
  }
  if (!Array.isArray(path.evidence)) throw new TypeError("decision_path evidence is required");
  assertNoPrivateFields(path);
  return path;
}

export function validateLandDecisionPathGetOutput(result, input) {
  validateLandDecisionPathGetInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("land.decision_path.get provider must return an object");
  if (result.capability_reference !== LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE) throw new TypeError("land.decision_path.get capability reference drifted");
  if (!LAND_DECISION_PATH_AVAILABILITY.includes(result.availability)) throw new TypeError("land.decision_path.get availability is invalid");
  if (result.availability === "available") {
    if (result.project_id !== input.projectId.trim()) throw new TypeError("land.decision_path.get returned a different canonical id");
    assertDecisionPath(result.decision_path);
    if (result.error !== null) throw new TypeError("available decision path cannot carry an error");
  } else {
    if (result.project_id !== null || result.decision_path !== null) throw new TypeError("unavailable decision path cannot carry a project");
    if (!((result.availability === "not_yet_public" && result.error === "not-found")
      || (result.availability === "unavailable" && result.error === "unavailable"))) {
      throw new TypeError("land.decision_path.get availability error is inconsistent");
    }
  }
  assertNoPrivateFields(result);
  return result;
}

export async function executeLandDecisionPathGet(provider, input) {
  validateLandDecisionPathGetInput(input);
  if (!provider || provider.capabilityReference !== LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE
      || provider.providerId !== LAND_DECISION_PATH_GET_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("land.decision_path.get requires the registered explicit provider");
  }
  return validateLandDecisionPathGetOutput(await provider.execute(input), input);
}
