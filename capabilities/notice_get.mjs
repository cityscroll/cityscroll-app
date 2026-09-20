// Transport-neutral contract for one public City Record notice read.
// The existing notice read model owns source fallback, stale snapshots, and
// the public row projection; adapters own status codes and presentation.

export const NOTICE_GET_CAPABILITY_ID = "notice.get";
export const NOTICE_GET_CAPABILITY_VERSION = "1.0.0";
export const NOTICE_GET_CAPABILITY_REFERENCE = "notice.get@1";
export const NOTICE_GET_PROVIDER_ID = "worker-notices.notice-get";
export const NOTICE_GET_CITATION_SCHEMA = "cityscroll.notice_get.citation.v1";
export const NOTICE_GET_CITATION_PUBLISHER = "NYC City Record";
const CITYSCROLL_NOTICE_URL_BASE = "https://cityscroll.org/notices/";
const CITY_RECORD_NOTICE_URL_BASE = "https://a856-cityrecord.nyc.gov/RequestDetail/";
export const NOTICE_GET_LIMITS = Object.freeze({
  requestIdMaximumLength: 80,
  maximum: 1,
});
export const NOTICE_GET_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const NOTICE_GET_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const NOTICE_GET_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "public notice read envelope",
  }),
  Object.freeze({
    id: "text-summary",
    mediaType: "text/plain",
    projection: "bounded public notice summary",
  }),
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const NOTICE_GET_CITATION_OUTPUT_SCHEMA = deepFreeze({
  type: ["object", "null"],
  additionalProperties: false,
  required: ["schema", "publisher", "request_id", "publication_date", "cityscroll_url", "official_url"],
  properties: {
    schema: { type: "string", const: NOTICE_GET_CITATION_SCHEMA },
    publisher: { type: "string", const: NOTICE_GET_CITATION_PUBLISHER },
    request_id: { type: "string", minLength: 1, maxLength: NOTICE_GET_LIMITS.requestIdMaximumLength },
    publication_date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    cityscroll_url: { type: "string", format: "uri", pattern: "^https://cityscroll\\.org/notices/" },
    official_url: { type: "string", format: "uri", pattern: "^https://a856-cityrecord\\.nyc\\.gov/RequestDetail/" },
  },
});

export const NOTICE_GET_CAPABILITY = deepFreeze({
  id: NOTICE_GET_CAPABILITY_ID,
  version: NOTICE_GET_CAPABILITY_VERSION,
  reference: NOTICE_GET_CAPABILITY_REFERENCE,
  owner: "notices",
  operation: "read",
  authority: {
    class: "public-read",
    sideEffect: "none",
    approval: "none",
  },
  cost: {
    class: "bounded-public-source-read",
    machineFanOut: "low",
  },
  bounds: {
    input: NOTICE_GET_LIMITS,
    output: { oneNotice: true },
  },
  input: {
    schema: "cityscroll.capability.notice_get.input.v1",
    identity: "exact City Record RequestID",
    limits: NOTICE_GET_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.notice_get.output.v1",
    fields: ["capability_reference", "availability", "notice", "source", "generated_at", "stale", "citation", "error"],
    availability: NOTICE_GET_AVAILABILITY,
    representations: NOTICE_GET_REPRESENTATIONS,
  },
  provenance: {
    noticeIdentity: "notice.request_id",
    sourceIdentity: "source + notice.request_id",
    citationIdentity: "citation.publisher + citation.request_id + citation.official_url",
    publicationClock: "citation.publication_date from notice.start_date",
    observationClock: "generated_at",
    staleSnapshotPreserved: true,
  },
  freshness: {
    owner: "materialized notice mirror with public-source fallback",
    projection: "generated_at plus stale",
  },
  provider: {
    id: NOTICE_GET_PROVIDER_ID,
    module: "worker/src/notice.mjs",
    export: "workerNoticeGet",
    store: "Cloudflare D1 with City Record fallback",
    readModel: "public City Record notice row",
  },
  examples: [
    {
      input: { requestId: "20260807001" },
      output: {
        availability: "available",
        source: "materialized",
        stale: false,
        citation: {
          schema: NOTICE_GET_CITATION_SCHEMA,
          publisher: NOTICE_GET_CITATION_PUBLISHER,
          request_id: "20260807001",
          publication_date: "2026-08-07",
          cityscroll_url: "https://cityscroll.org/notices/20260807001/",
          official_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260807001",
        },
      },
    },
    {
      input: { requestId: "20260807999" },
      output: { availability: "not_yet_public", citation: null, error: "not-found" },
    },
  ],
  adapters: [
    {
      id: "worker-http.notice-get@1",
      module: "worker/src/notice.mjs",
      kind: "http-route",
      route: "GET /notice",
      surface: "Notice detail",
      representations: NOTICE_GET_REPRESENTATIONS,
    },
    {
      id: "mcp.get_notice@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_notice",
      route: "POST /mcp",
      surface: "MCP",
      representations: NOTICE_GET_REPRESENTATIONS,
    },
  ],
});

export function validateNoticeGetInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("notice.get input must be an object");
  }
  const fields = Object.keys(input);
  if (fields.length !== 1 || fields[0] !== "requestId") {
    throw new TypeError("notice.get accepts only requestId");
  }
  if (typeof input.requestId !== "string"
      || !input.requestId.trim()
      || !NOTICE_GET_REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new TypeError("requestId must be a non-empty City Record identifier");
  }
  return input;
}

function assertPublicNotice(notice, requestId) {
  if (!notice || typeof notice !== "object" || Array.isArray(notice)
      || notice.request_id !== requestId) {
    throw new TypeError("notice.get available output must identify the requested notice");
  }
  return notice;
}

function sourcePublicationDate(notice) {
  const value = typeof notice?.start_date === "string" ? notice.start_date : "";
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

/** Build publisher provenance only from a validated, exact notice identity. */
export function buildNoticeCitation(notice, requestId = notice?.request_id) {
  const id = typeof requestId === "string" ? requestId.trim() : "";
  if (!NOTICE_GET_REQUEST_ID_PATTERN.test(id) || !notice || notice.request_id !== id) return null;
  return {
    schema: NOTICE_GET_CITATION_SCHEMA,
    publisher: NOTICE_GET_CITATION_PUBLISHER,
    request_id: id,
    publication_date: sourcePublicationDate(notice),
    cityscroll_url: `${CITYSCROLL_NOTICE_URL_BASE}${id}/`,
    official_url: `${CITY_RECORD_NOTICE_URL_BASE}${id}`,
  };
}

function validateNoticeCitation(citation, requestId) {
  if (!citation || typeof citation !== "object" || Array.isArray(citation)
      || citation.schema !== NOTICE_GET_CITATION_SCHEMA
      || citation.publisher !== NOTICE_GET_CITATION_PUBLISHER
      || citation.request_id !== requestId
      || citation.cityscroll_url !== `${CITYSCROLL_NOTICE_URL_BASE}${requestId}/`
      || citation.official_url !== `${CITY_RECORD_NOTICE_URL_BASE}${requestId}`
      || (citation.publication_date !== null && sourcePublicationDate({ start_date: citation.publication_date }) !== citation.publication_date)) {
    throw new TypeError("available notice.get output citation is invalid");
  }
  return citation;
}

export function validateNoticeGetOutput(result, input) {
  validateNoticeGetInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("notice.get provider must return an object");
  }
  if (result.capability_reference !== NOTICE_GET_CAPABILITY_REFERENCE) {
    throw new TypeError("notice.get capability reference drifted");
  }
  if (!NOTICE_GET_AVAILABILITY.includes(result.availability)) {
    throw new TypeError("notice.get availability is invalid");
  }
  if (result.availability === "available") {
    assertPublicNotice(result.notice, input.requestId.trim());
    if (!result.source || typeof result.source !== "string") {
      throw new TypeError("available notice.get output requires a source");
    }
    if (typeof result.stale !== "boolean") throw new TypeError("notice.get stale state is required");
    validateNoticeCitation(result.citation, input.requestId.trim());
    if (result.error !== null) throw new TypeError("available notice.get output cannot carry an error");
  } else {
    if (result.notice !== null) throw new TypeError("non-available notice.get output cannot carry a notice");
    if (result.citation !== null) throw new TypeError("non-available notice.get output cannot carry a citation");
    if (typeof result.error !== "string" || !result.error) {
      throw new TypeError("non-available notice.get output requires an error code");
    }
    if (result.availability === "not_yet_public" && result.error !== "not-found") {
      throw new TypeError("not_yet_public notice.get output requires not-found");
    }
    if (result.availability === "unavailable" && result.error !== "unavailable") {
      throw new TypeError("unavailable notice.get output requires unavailable");
    }
  }
  return result;
}

/** Execute the registered notice read provider without widening its output. */
export async function executeNoticeGet(provider, input) {
  validateNoticeGetInput(input);
  if (!provider
      || provider.capabilityReference !== NOTICE_GET_CAPABILITY_REFERENCE
      || provider.providerId !== NOTICE_GET_PROVIDER_ID
      || typeof provider.execute !== "function") {
    throw new TypeError("notice.get requires the registered explicit provider");
  }
  return validateNoticeGetOutput(await provider.execute(input), input);
}
