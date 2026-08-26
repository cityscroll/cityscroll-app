// Transport-neutral contract for one public City Record notice read.
// The existing notice read model owns source fallback, stale snapshots, and
// the public row projection; adapters own status codes and presentation.

export const NOTICE_GET_CAPABILITY_ID = "notice.get";
export const NOTICE_GET_CAPABILITY_VERSION = "1.0.0";
export const NOTICE_GET_CAPABILITY_REFERENCE = "notice.get@1";
export const NOTICE_GET_PROVIDER_ID = "worker-notices.notice-get";
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
    fields: ["capability_reference", "availability", "notice", "source", "generated_at", "stale", "error"],
    availability: NOTICE_GET_AVAILABILITY,
    representations: NOTICE_GET_REPRESENTATIONS,
  },
  provenance: {
    noticeIdentity: "notice.request_id",
    sourceIdentity: "source + notice.request_id",
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
      output: { availability: "available", source: "materialized", stale: false },
    },
    {
      input: { requestId: "20260807999" },
      output: { availability: "not_yet_public", error: "not-found" },
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
    if (result.error !== null) throw new TypeError("available notice.get output cannot carry an error");
  } else {
    if (result.notice !== null) throw new TypeError("non-available notice.get output cannot carry a notice");
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
