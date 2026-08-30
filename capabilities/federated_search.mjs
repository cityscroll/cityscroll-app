// Transport-neutral contract for bounded cross-lens SearchDocument federation.
// The provider owns collection retrieval and the federator owns normalization,
// admission, ranking, deduplication, and coverage semantics.

export const FEDERATED_SEARCH_CAPABILITY_ID = "search.federated";
export const FEDERATED_SEARCH_CAPABILITY_VERSION = "1.1.0";
export const FEDERATED_SEARCH_CAPABILITY_REFERENCE = "search.federated@1";
export const FEDERATED_SEARCH_PROVIDER_ID = "worker-federated-search";
export const FEDERATED_SEARCH_SCHEMA = "cityscroll.universal_search_federator.v1";
export const FEDERATED_SEARCH_RESULT_SCHEMA = "cityscroll.universal_search_result.v1";
export const FEDERATED_SEARCH_COVERAGE_SCHEMA = "cityscroll.universal_search_coverage.v1";
export const FEDERATED_SEARCH_SCOPE_SCHEMA = "cityscroll.capability.search_federated.scope.v1";
export const FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA = "cityscroll.universal_search_requested_scope.v1";

export const FEDERATED_SEARCH_LENS_IDS = Object.freeze([
  "notices",
  "people",
  "agencies",
  "vendors",
  "committees",
  "community_boards",
  "exams",
  "parcels",
  "land",
  "meetings",
]);

export const FEDERATED_SEARCH_COVERAGE_STATES = Object.freeze([
  "matched",
  "empty",
  "partial",
  "stale",
  "not_indexed",
  "provider_unavailable",
  "out_of_scope",
]);

export const FEDERATED_SEARCH_REQUESTED_COVERAGE_STATES = Object.freeze([
  "matched",
  "empty",
  "partial",
  "stale",
  "not_indexed",
  "provider_unavailable",
]);

export const FEDERATED_SEARCH_LIMITS = Object.freeze({
  queryMaximumLength: 240,
  defaultResults: 40,
  maximumResults: 100,
  maximumCards: 8,
});

export const FEDERATED_SEARCH_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema", "query", "ranking_policy", "results", "coverage", "requested_scope"],
  properties: {
    schema: { type: "string", const: FEDERATED_SEARCH_SCHEMA },
    query: {
      type: "object",
      additionalProperties: false,
      required: ["normalized", "tokens"],
      properties: {
        normalized: { type: "string", maxLength: FEDERATED_SEARCH_LIMITS.queryMaximumLength },
        tokens: { type: "array", items: { type: "string" } },
      },
    },
    ranking_policy: { type: "object" },
    results: { type: "array", maxItems: FEDERATED_SEARCH_LIMITS.maximumResults, items: { type: "object" } },
    coverage: { type: "object" },
    requested_scope: { type: "object" },
  },
});

export const FEDERATED_SEARCH_INPUT_FIELDS = Object.freeze(["query", "limit", "scope"]);
const INPUT_FIELDS = new Set(FEDERATED_SEARCH_INPUT_FIELDS);
const SCOPE_FIELDS = new Set(["schema", "lenses"]);
const COVERAGE_STATE_SET = new Set(FEDERATED_SEARCH_COVERAGE_STATES);
const REQUESTED_COVERAGE_STATE_SET = new Set(FEDERATED_SEARCH_REQUESTED_COVERAGE_STATES);
const LENS_SET = new Set(FEDERATED_SEARCH_LENS_IDS);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const FEDERATED_SEARCH_CAPABILITY = deepFreeze({
  id: FEDERATED_SEARCH_CAPABILITY_ID,
  version: FEDERATED_SEARCH_CAPABILITY_VERSION,
  reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  owner: "universal-search",
  operation: "read",
  authority: {
    class: "public-read",
    sideEffect: "none",
    approval: "none",
    semantics: "bounded SearchDocument federation; no raw store or query language",
  },
  cost: {
    class: "bounded-multi-lens-read",
    machineFanOut: "registered-lenses-only",
  },
  bounds: {
    input: FEDERATED_SEARCH_LIMITS,
    output: {
      maximumResults: FEDERATED_SEARCH_LIMITS.maximumResults,
      maximumCardsPerLane: FEDERATED_SEARCH_LIMITS.maximumCards,
    },
  },
  input: {
    schema: "cityscroll.capability.search_federated.input.v1",
    query: "bounded resident search text; no arbitrary filter or store query",
    scope: {
      schema: FEDERATED_SEARCH_SCOPE_SCHEMA,
      omitted: "legacy all-registered-lens federation, including auxiliary legal-code recall",
      lenses: FEDERATED_SEARCH_LENS_IDS,
      mapping: "closed allowlist of registered federation lenses; presentation lanes and store queries are rejected",
    },
    lenses: FEDERATED_SEARCH_LENS_IDS,
    limits: FEDERATED_SEARCH_LIMITS,
  },
  output: {
    schema: FEDERATED_SEARCH_SCHEMA,
    resultSchema: FEDERATED_SEARCH_RESULT_SCHEMA,
    coverageSchema: FEDERATED_SEARCH_COVERAGE_SCHEMA,
    requestedScopeSchema: FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA,
    fields: ["schema", "query", "ranking_policy", "results", "coverage", "requested_scope"],
    coverageStates: FEDERATED_SEARCH_COVERAGE_STATES,
    requestedCoverageStates: FEDERATED_SEARCH_REQUESTED_COVERAGE_STATES,
    availability: FEDERATED_SEARCH_COVERAGE_STATES,
    coverageSemantics: {
      matched: "one or more admitted documents were observed",
      empty: "the participating indexed lens observed zero matches",
      partial: "the lens participated using the available portion of its registered source index",
      stale: "the lens result is retained with an out-of-date source clock",
      not_indexed: "the lens has no registered served index for this request",
      provider_unavailable: "the registered lens provider failed; absence is not an empty result",
      out_of_scope: "the lens was not in the requested allowlist and was not queried",
    },
    representations: [
      { id: "structured-content", mediaType: "application/json", projection: "federated result envelope" },
      { id: "http-search", mediaType: "application/json", projection: "existing /search lane projection" },
    ],
  },
  provenance: {
    objectIdentity: "results[].object_ref",
    sourceObservations: "results[].source_observation_refs and results[].edge_provenance.matches[]",
    matchEvidence: "results[].match_fields",
    exactSourceRoute: "results[].canonical_href",
    coverageByLens: "coverage.by_lens[].state and coverage.by_lens[].source",
    requestedScope: "requested_scope.lenses and requested_scope.by_lens[].state",
  },
  freshness: {
    owner: "registered lens read models",
    projection: "per-lens as_of and coverage state are retained; incomplete coverage is not collapsed",
  },
  ranking: {
    policy: "cityscroll.cross_lens_rank.v1",
    localCalibration: "reciprocal_rank_within_lens",
    tieBreak: ["calibrated_score_desc", "entity_type_asc", "stable_key_asc", "lens_asc"],
  },
  examples: [
    {
      input: { query: "parks", limit: 10 },
      output: { coverageStates: FEDERATED_SEARCH_COVERAGE_STATES, maximumResults: 10, maximumCardsPerLane: 8, requestedScope: "all_registered_lenses" },
    },
    {
      input: { query: "parks", limit: 10, scope: { schema: FEDERATED_SEARCH_SCOPE_SCHEMA, lenses: ["agencies"] } },
      output: { requestedLenses: ["agencies"], unrequestedState: "out_of_scope", maximumResults: 10 },
    },
    {
      input: { query: "public hearing", limit: 100 },
      output: { registeredLenses: FEDERATED_SEARCH_LENS_IDS, maximumResults: 100, provenance: "source-observation refs retained" },
    },
  ],
  provider: {
    id: FEDERATED_SEARCH_PROVIDER_ID,
    module: "worker/src/search.mjs",
    export: "workerFederatedSearch",
    store: "registered public lens read models",
    readModel: "SearchDocument producers plus universal search federator",
  },
  adapters: [
    {
      id: "worker-http.search.federated@1",
      module: "worker/src/search.mjs",
      kind: "http-route",
      route: "GET /search",
      surface: "Universal search",
    },
    {
      id: "mcp.search_federated@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "search_federated",
      route: "POST /mcp",
      surface: "MCP",
    },
  ],
});

export function normalizeFederatedSearchScope(scope) {
  if (scope == null) {
    return {
      schema: FEDERATED_SEARCH_SCOPE_SCHEMA,
      omitted: true,
      lenses: [...FEDERATED_SEARCH_LENS_IDS],
    };
  }
  if (scope?.schema === FEDERATED_SEARCH_SCOPE_SCHEMA
      && typeof scope.omitted === "boolean"
      && Array.isArray(scope.lenses)
      && Object.keys(scope).every((field) => field === "schema" || field === "omitted" || field === "lenses")) {
    const lenses = normalizeFederatedSearchScope({ schema: scope.schema, lenses: scope.lenses }).lenses;
    if (scope.omitted && (lenses.length !== FEDERATED_SEARCH_LENS_IDS.length
        || lenses.some((lens, index) => lens !== FEDERATED_SEARCH_LENS_IDS[index]))) {
      throw new TypeError("search.federated omitted scope must request every registered lens");
    }
    return { schema: FEDERATED_SEARCH_SCOPE_SCHEMA, omitted: scope.omitted, lenses };
  }
  if (typeof scope === "string") {
    return normalizeFederatedSearchScope({ lenses: [scope] });
  }
  if (Array.isArray(scope)) {
    return normalizeFederatedSearchScope({ lenses: scope });
  }
  if (typeof scope !== "object") {
    throw new TypeError("search.federated scope must be a closed registered-lens allowlist");
  }
  for (const field of Object.keys(scope)) {
    if (!SCOPE_FIELDS.has(field)) {
      throw new TypeError(`search.federated does not accept arbitrary scope field: ${field}`);
    }
  }
  if (scope.schema != null && scope.schema !== FEDERATED_SEARCH_SCOPE_SCHEMA) {
    throw new TypeError("search.federated scope schema is not registered");
  }
  if (!Array.isArray(scope.lenses) || !scope.lenses.length) {
    throw new TypeError("search.federated scope.lenses must be a non-empty registered-lens allowlist");
  }
  const seen = new Set();
  for (const lens of scope.lenses) {
    if (typeof lens !== "string" || !LENS_SET.has(lens)) {
      throw new TypeError(`search.federated does not accept unknown or unregistered lens: ${lens}`);
    }
    seen.add(lens);
  }
  return {
    schema: FEDERATED_SEARCH_SCOPE_SCHEMA,
    omitted: false,
    lenses: FEDERATED_SEARCH_LENS_IDS.filter((lens) => seen.has(lens)),
  };
}

export function buildFederatedRequestedScope(scope, coverageByLens) {
  const normalized = scope?.schema === FEDERATED_SEARCH_SCOPE_SCHEMA && Array.isArray(scope.lenses)
    ? scope
    : normalizeFederatedSearchScope(scope);
  const requested = new Set(normalized.lenses);
  return {
    schema: FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA,
    omitted: normalized.omitted === true,
    mode: normalized.omitted ? "all_registered_lenses" : "allowlisted",
    lenses: [...normalized.lenses],
    by_lens: Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => [
      lens,
      {
        requested: requested.has(lens),
        state: coverageByLens?.[lens]?.state,
      },
    ])),
  };
}

export function validateFederatedSearchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("search.federated input must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) throw new TypeError(`search.federated does not accept arbitrary field: ${field}`);
  }
  if (typeof input.query !== "string" || !input.query.trim()
      || input.query.length > FEDERATED_SEARCH_LIMITS.queryMaximumLength) {
    throw new TypeError("query must be a non-empty string of 240 characters or fewer");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit)
      || input.limit < 1 || input.limit > FEDERATED_SEARCH_LIMITS.maximumResults)) {
    throw new TypeError("limit must be a whole number from 1 through 100");
  }
  return {
    query: input.query,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    scope: normalizeFederatedSearchScope(input.scope),
  };
}

function validateCoverage(coverage) {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new TypeError("search.federated coverage is required");
  }
  if (!coverage.by_lens || typeof coverage.by_lens !== "object") {
    throw new TypeError("search.federated coverage.by_lens is required");
  }
  if (Object.keys(coverage.by_lens).length !== FEDERATED_SEARCH_LENS_IDS.length
      || Object.keys(coverage.by_lens).some((lens) => !LENS_SET.has(lens))) {
    throw new TypeError("search.federated coverage must enumerate registered lenses");
  }
  for (const lens of FEDERATED_SEARCH_LENS_IDS) {
    const row = coverage.by_lens[lens];
    if (!row || row.lens !== lens || !COVERAGE_STATE_SET.has(row.state)) {
      throw new TypeError(`search.federated coverage row is missing for ${lens}`);
    }
  }
}

function validateRequestedScope(requestedScope, coverage) {
  if (!requestedScope || typeof requestedScope !== "object" || Array.isArray(requestedScope)
      || requestedScope.schema !== FEDERATED_SEARCH_REQUESTED_SCOPE_SCHEMA
      || typeof requestedScope.omitted !== "boolean"
      || (requestedScope.mode !== "all_registered_lenses" && requestedScope.mode !== "allowlisted")
      || !Array.isArray(requestedScope.lenses)
      || !requestedScope.lenses.length
      || requestedScope.lenses.some((lens) => !LENS_SET.has(lens))
      || !requestedScope.by_lens || typeof requestedScope.by_lens !== "object") {
    throw new TypeError("search.federated requested_scope receipt is required");
  }
  if (requestedScope.omitted) {
    if (requestedScope.mode !== "all_registered_lenses"
        || requestedScope.lenses.length !== FEDERATED_SEARCH_LENS_IDS.length
        || requestedScope.lenses.some((lens, index) => lens !== FEDERATED_SEARCH_LENS_IDS[index])) {
      throw new TypeError("search.federated omitted scope must request every registered lens");
    }
  } else if (requestedScope.mode !== "allowlisted") {
    throw new TypeError("search.federated allowlisted scope must use the closed registered-lens mode");
  }
  const requested = new Set(requestedScope.lenses);
  if (Object.keys(requestedScope.by_lens).length !== FEDERATED_SEARCH_LENS_IDS.length) {
    throw new TypeError("search.federated requested_scope must enumerate registered lenses");
  }
  for (const lens of FEDERATED_SEARCH_LENS_IDS) {
    const row = requestedScope.by_lens[lens];
    const coverageRow = coverage.by_lens[lens];
    if (!row || row.requested !== requested.has(lens) || row.state !== coverageRow.state) {
      throw new TypeError(`search.federated requested_scope row is missing for ${lens}`);
    }
    if (row.requested) {
      if (!REQUESTED_COVERAGE_STATE_SET.has(row.state)) {
        throw new TypeError(`search.federated requested lens ${lens} collapsed coverage state ${row.state}`);
      }
    } else if (row.state !== "out_of_scope") {
      throw new TypeError(`search.federated unrequested lens ${lens} must report out_of_scope`);
    }
  }
}

function validateResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
      || result.result_schema !== FEDERATED_SEARCH_RESULT_SCHEMA
      || typeof result.object_ref !== "string" || !result.object_ref
      || typeof result.object_type !== "string" || !result.canonical_href
      || typeof result.canonical_href !== "string"
      || !Array.isArray(result.source_observation_refs)
      || !result.source_observation_refs.length
      || !result.source_observation_refs.every((ref) => typeof ref === "string" && ref)
      || typeof result.provenance?.producer !== "string" || !result.provenance.producer
      || !Array.isArray(result.match_fields) || !result.match_fields.length) {
    throw new TypeError("search.federated result must retain typed identity, evidence, and provenance");
  }
}

export function validateFederatedSearchOutput(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
      || result.schema !== FEDERATED_SEARCH_SCHEMA
      || !result.query || typeof result.query.normalized !== "string"
      || result.query.normalized.length > FEDERATED_SEARCH_LIMITS.queryMaximumLength
      || !Array.isArray(result.query.tokens)
      || !Array.isArray(result.results)
      || result.results.length > FEDERATED_SEARCH_LIMITS.maximumResults) {
    throw new TypeError("search.federated provider returned an invalid bounded envelope");
  }
  validateCoverage(result.coverage);
  validateRequestedScope(result.requested_scope, result.coverage);
  result.results.forEach(validateResult);
  return result;
}

/** Execute the one registered provider; adapters must not call a lens or store directly. */
export async function executeFederatedSearch(provider, input) {
  const normalized = validateFederatedSearchInput(input);
  if (!provider
      || provider.capabilityReference !== FEDERATED_SEARCH_CAPABILITY_REFERENCE
      || provider.providerId !== FEDERATED_SEARCH_PROVIDER_ID
      || typeof provider.execute !== "function") {
    throw new TypeError("search.federated requires the registered explicit provider");
  }
  return validateFederatedSearchOutput(await provider.execute({
    query: normalized.query,
    limit: normalized.limit ?? FEDERATED_SEARCH_LIMITS.defaultResults,
    scope: normalized.scope,
  }));
}
