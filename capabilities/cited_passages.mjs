// Transport-neutral contract for bounded, evidence-only cited passage retrieval.
// The existing cited-retrieval projector remains the source of response bytes;
// adapters may only map input and accompany that response with transport copy.

export const CITED_PASSAGES_CAPABILITY_ID = "cited.passages.retrieve";
export const CITED_PASSAGES_CAPABILITY_VERSION = "1.0.0";
export const CITED_PASSAGES_CAPABILITY_REFERENCE = "cited.passages.retrieve@1";
export const CITED_PASSAGES_PROVIDER_ID = "worker-semantic.cited-passages";
export const CITED_PASSAGES_RESPONSE_SCHEMA = "cityscroll.semantic_retrieval.cited_passage_response.v1";
export const CITED_PASSAGES_CONTRACT_VERSION = 1;
export const CITED_PASSAGES_EXACT_JOIN_METHOD = "candidate_source_passage_manifest_exact_id_v1";
export const CITED_PASSAGES_LIMITS = Object.freeze({
  queryMaximumLength: 240,
  bodyIdMaximumLength: 120,
  defaultResults: 10,
  maximumResults: 20,
});
export const CITED_PASSAGES_SOURCE_FAMILIES = Object.freeze([
  "attachment_text",
  "city_record_notice",
  "community_board_minutes",
]);
export const CITED_PASSAGES_AVAILABILITY = Object.freeze([
  "partial",
  "complete",
  "unknown",
]);
export const CITED_PASSAGES_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "structured-content",
    mediaType: "application/json",
    projection: "byte-identical cited passage response",
  }),
  Object.freeze({
    id: "text-summary",
    mediaType: "text/plain",
    projection: "meaning-compatible bounded result count",
  }),
]);

const INPUT_FIELDS = new Set(["query", "filters", "limit"]);
const FILTER_FIELDS = new Set(["source_family", "body_id", "published_from", "published_to"]);
const COVERAGE_STATES = new Set(CITED_PASSAGES_AVAILABILITY);
const FRESHNESS_STATES = new Set(["observed", "stale", "unknown"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CITED_PASSAGES_CAPABILITY = deepFreeze({
  id: CITED_PASSAGES_CAPABILITY_ID,
  version: CITED_PASSAGES_CAPABILITY_VERSION,
  reference: CITED_PASSAGES_CAPABILITY_REFERENCE,
  owner: "semantic-retrieval",
  operation: "read",
  authority: {
    class: "public-read",
    sideEffect: "none",
    approval: "none",
    semantics: "retrieval evidence only; no answer or inferred civic relationship",
  },
  cost: {
    class: "bounded-committed-corpus-read",
    machineFanOut: "low",
  },
  bounds: {
    input: CITED_PASSAGES_LIMITS,
    output: { maximumCitations: CITED_PASSAGES_LIMITS.maximumResults },
  },
  input: {
    schema: "cityscroll.capability.cited_passages_retrieve.input.v1",
    query: "resident search terms plus closed structured scope",
    sourceFamilies: CITED_PASSAGES_SOURCE_FAMILIES,
    limits: CITED_PASSAGES_LIMITS,
  },
  output: {
    schema: CITED_PASSAGES_RESPONSE_SCHEMA,
    contractVersion: CITED_PASSAGES_CONTRACT_VERSION,
    fields: ["schema", "contract_version", "query", "retrieval", "hard_scope", "coverage", "citations"],
    availability: CITED_PASSAGES_AVAILABILITY,
    representations: CITED_PASSAGES_REPRESENTATIONS,
    forbiddenSemantics: ["answer", "synthesis", "action", "legal_conclusion", "graph_edge", "relationship", "score"],
  },
  provenance: {
    citationIdentity: "citations[].citation_id",
    sourceIdentity: "citations[].source.id + citations[].source.url",
    passageIdentity: "citations[].passage.id",
    exactJoinEvidence: "citations[].exact_join_evidence",
    corpusReceipt: "retrieval.corpus.manifest_sha256 + retrieval.corpus.content_sha256",
    passageMapReceipt: "retrieval.index.version + retrieval.index.corpus_sha256",
  },
  freshness: {
    owner: "committed semantic retrieval corpus manifest and source-passage map",
    projection: "citation freshness plus corpus and passage-map observation clocks",
  },
  examples: [
    {
      input: { query: "energy conservation", filters: { source_family: "city_record_notice" }, limit: 5 },
      output: { availability: "partial", maximumCitations: 5, exactJoin: "matched-or-unknown" },
    },
    {
      input: { query: "public hearing", limit: 10 },
      output: { availability: "complete-or-partial-or-unknown", maximumCitations: 10, exactJoin: "matched-or-unknown" },
    },
  ],
  provider: {
    id: CITED_PASSAGES_PROVIDER_ID,
    module: "worker/src/cited_retrieval.mjs",
    export: "workerCitedPassages",
    store: "committed semantic retrieval corpus",
    readModel: "typed candidates joined exactly to source passages and corpus manifest records",
  },
  adapters: [
    {
      id: "worker-http.retrieve-cited-passages@1",
      module: "worker/src/cited_retrieval.mjs",
      kind: "http-route",
      route: "GET /cited-passages",
      surface: "Cited passage retrieval",
      representations: CITED_PASSAGES_REPRESENTATIONS,
    },
    {
      id: "mcp.retrieve_cited_passages@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "retrieve_cited_passages",
      route: "POST /mcp",
      surface: "MCP",
      representations: CITED_PASSAGES_REPRESENTATIONS,
    },
  ],
});

function validDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizedRequest(input) {
  const query = input.query
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CITED_PASSAGES_LIMITS.queryMaximumLength);
  const filters = Object.fromEntries(Object.entries({
    source_family: input.filters?.source_family || null,
    body_id: input.filters?.body_id || null,
    published_from: input.filters?.published_from || null,
    published_to: input.filters?.published_to || null,
  }).filter(([, value]) => value != null));
  return { query, filters };
}

export function validateCitedPassagesInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("cited.passages.retrieve input must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      throw new TypeError(`cited.passages.retrieve does not accept arbitrary field: ${field}`);
    }
  }
  if (typeof input.query !== "string" || !input.query.trim()
      || input.query.length > CITED_PASSAGES_LIMITS.queryMaximumLength) {
    throw new TypeError("query must be a non-empty bounded string");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit)
      || input.limit < 1 || input.limit > CITED_PASSAGES_LIMITS.maximumResults)) {
    throw new TypeError("limit must be a whole number from 1 through 20");
  }
  const filters = input.filters ?? {};
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new TypeError("filters must be an object");
  }
  for (const field of Object.keys(filters)) {
    if (!FILTER_FIELDS.has(field)) {
      throw new TypeError(`cited.passages.retrieve does not accept arbitrary filter: ${field}`);
    }
  }
  if (filters.source_family !== undefined && filters.source_family !== null
      && !CITED_PASSAGES_SOURCE_FAMILIES.includes(filters.source_family)) {
    throw new TypeError("source_family is not part of the cited retrieval corpus");
  }
  if (filters.body_id !== undefined && filters.body_id !== null
      && (typeof filters.body_id !== "string"
        || filters.body_id.length > CITED_PASSAGES_LIMITS.bodyIdMaximumLength)) {
    throw new TypeError("body_id must be 120 characters or fewer");
  }
  for (const field of ["published_from", "published_to"]) {
    const value = filters[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || !validDate(value))) {
      throw new TypeError(`${field} must be a date`);
    }
  }
  if (filters.published_from && filters.published_to
      && filters.published_from > filters.published_to) {
    throw new TypeError("published_from must not be after published_to");
  }
  return input;
}

function assertNoForbiddenSemantics(value, path = "output") {
  if (!value || typeof value !== "object") return;
  const forbidden = /(?:^|_)(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship|score|cosine|confidence)(?:$|_)/i;
  for (const [field, child] of Object.entries(value)) {
    if (forbidden.test(field)) {
      throw new TypeError(`cited.passages output exposes forbidden semantics: ${path}.${field}`);
    }
    assertNoForbiddenSemantics(child, `${path}.${field}`);
  }
}

function validateCitation(citation) {
  if (!citation?.citation_id || citation.citation_id !== citation.passage?.id
      || !citation.source?.id || !CITED_PASSAGES_SOURCE_FAMILIES.includes(citation.source.family)
      || !citation.source?.native_id || !/^https?:\/\//.test(citation.source?.url || "")
      || !["retained", "unknown"].includes(citation.passage?.text_state)
      || !COVERAGE_STATES.has(citation.coverage_state)
      || !FRESHNESS_STATES.has(citation.freshness?.state)) {
    throw new TypeError("cited.passages citation is incomplete");
  }
  const boundary = citation.passage.boundary;
  if (boundary?.unit !== "utf16_code_unit"
      || (boundary.start !== null && (!Number.isInteger(boundary.start) || boundary.start < 0))
      || (boundary.end !== null && (!Number.isInteger(boundary.end) || boundary.end < 0))
      || (boundary.start !== null && boundary.end !== null && boundary.end < boundary.start)
      || (citation.passage.text_state === "retained"
        && (typeof citation.passage.text !== "string"
          || boundary.start === null || boundary.end === null
          || citation.passage.text.length !== boundary.end - boundary.start))
      || (citation.passage.text_state === "unknown" && citation.passage.text !== null)) {
    throw new TypeError("cited.passages citation boundary is invalid");
  }
  const evidence = citation.exact_join_evidence;
  if (!evidence || !["matched", "unknown"].includes(evidence.state)
      || evidence.candidate_id !== citation.citation_id) {
    throw new TypeError("cited.passages exact join evidence is incomplete");
  }
  if (evidence.state === "matched"
      && (evidence.method !== CITED_PASSAGES_EXACT_JOIN_METHOD
        || evidence.source_record_id !== citation.source.id
        || evidence.passage_id !== citation.passage.id)) {
    throw new TypeError("cited.passages exact join evidence is inconsistent");
  }
  if (evidence.state === "unknown"
      && (evidence.method !== null || evidence.source_record_id !== null || evidence.passage_id !== null)) {
    throw new TypeError("unknown cited.passages evidence must not infer identifiers");
  }
}

/** Validate the existing cited response without cloning or widening it. */
export function validateCitedPassagesOutput(result, input) {
  validateCitedPassagesInput(input);
  const request = normalizedRequest(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("cited.passages provider must return an object");
  }
  if (result.schema !== CITED_PASSAGES_RESPONSE_SCHEMA
      || result.contract_version !== CITED_PASSAGES_CONTRACT_VERSION
      || result.query !== request.query
      || !result.retrieval?.method
      || result.retrieval?.corpus?.schema !== "cityscroll.semantic_retrieval.corpus_manifest.v1"
      || result.retrieval?.corpus?.manifest_version !== 1
      || !SHA256.test(result.retrieval?.corpus?.manifest_sha256 || "")
      || !SHA256.test(result.retrieval?.corpus?.content_sha256 || "")
      || result.retrieval?.index?.schema !== "cityscroll.semantic_retrieval.source_passage_map.v1"
      || !SHA256.test(result.retrieval?.index?.version || "")
      || !SHA256.test(result.retrieval?.index?.corpus_sha256 || "")
      || result.hard_scope?.state !== (Object.keys(request.filters).length ? "applied" : "unscoped")
      || JSON.stringify(result.hard_scope?.filters) !== JSON.stringify(request.filters)
      || !COVERAGE_STATES.has(result.coverage?.state)
      || (result.coverage?.boundary !== null && typeof result.coverage?.boundary !== "string")
      || !Array.isArray(result.citations)) {
    throw new TypeError("cited.passages response contract drifted");
  }
  const appliedLimit = input.limit ?? CITED_PASSAGES_LIMITS.defaultResults;
  if (result.citations.length > appliedLimit || result.citations.length > CITED_PASSAGES_LIMITS.maximumResults) {
    throw new TypeError("cited.passages citations exceed the declared bound");
  }
  const citationIds = new Set();
  for (const citation of result.citations) {
    validateCitation(citation);
    if (citationIds.has(citation.citation_id)) {
      throw new TypeError("cited.passages citation identities must be unique");
    }
    citationIds.add(citation.citation_id);
  }
  assertNoForbiddenSemantics(result);
  return result;
}

/** Execute one explicit provider. This is deliberately not a service locator. */
export async function executeCitedPassages(provider, input) {
  validateCitedPassagesInput(input);
  if (!provider
      || provider.capabilityReference !== CITED_PASSAGES_CAPABILITY_REFERENCE
      || provider.providerId !== CITED_PASSAGES_PROVIDER_ID
      || typeof provider.execute !== "function") {
    throw new TypeError("cited.passages.retrieve requires the registered explicit provider");
  }
  const result = await provider.execute(input);
  return validateCitedPassagesOutput(result, input);
}
