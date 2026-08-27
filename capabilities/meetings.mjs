// Transport-neutral contract for one source-qualified meeting from the
// materialized shared meeting read model. The UI, HTTP, and MCP adapters all
// use this bounded projection; none of them query a publisher at request time.

export const MEETING_GET_CAPABILITY_ID = "meeting.get";
export const MEETING_GET_CAPABILITY_VERSION = "1.0.0";
export const MEETING_GET_CAPABILITY_REFERENCE = "meeting.get@1";
export const MEETING_GET_PROVIDER_ID = "worker-static.shared-meeting.get";
export const MEETING_GET_LIMITS = Object.freeze({
  meetingIdMaximumLength: 320,
  maximum: 1,
});
export const MEETING_GET_AVAILABILITY = Object.freeze([
  "available",
  "not_yet_public",
  "unavailable",
]);
export const MEETING_GET_REPRESENTATIONS = Object.freeze([
  Object.freeze({ id: "json", mediaType: "application/json", projection: "one shared meeting row" }),
  Object.freeze({ id: "text-summary", mediaType: "text/plain", projection: "one shared meeting summary" }),
]);

// Keep the helper names scoped to this capability's public module. The legacy
// inline reconstruction flattens helper modules into one classic script.
const MEETING_INPUT_FIELDS = new Set(["meetingId"]);
const MEETING_SHARED_READ_MODEL_SCHEMA = "cityscroll.shared_meeting_read_model.v1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const MEETING_GET_CAPABILITY = deepFreeze({
  id: MEETING_GET_CAPABILITY_ID,
  version: MEETING_GET_CAPABILITY_VERSION,
  reference: MEETING_GET_CAPABILITY_REFERENCE,
  owner: "meetings",
  operation: "read",
  authority: { class: "public-read", sideEffect: "none", approval: "none" },
  cost: { class: "bounded-static-read-model", machineFanOut: "one-record" },
  bounds: {
    input: MEETING_GET_LIMITS,
    output: { maximumResults: MEETING_GET_LIMITS.maximum },
  },
  input: {
    schema: "cityscroll.capability.meeting_get.input.v1",
    identity: "exact source-qualified meeting_id; legacy City Record ids are adapter compatibility only",
    limits: MEETING_GET_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.meeting_get.output.v1",
    fields: ["capability_reference", "availability", "meeting", "source", "coverage", "freshness", "error"],
    availability: MEETING_GET_AVAILABILITY,
    representations: MEETING_GET_REPRESENTATIONS,
  },
  provenance: {
    identity: "meeting.meeting_id",
    sourceObservation: "meeting.source_record and meeting.source_receipt",
    coverage: "source and freshness envelopes from shared meeting read model",
  },
  freshness: {
    owner: "committed shared meeting read model",
    projection: "generated_at, checked_at, and per-source status",
  },
  provider: {
    id: MEETING_GET_PROVIDER_ID,
    module: "worker/src/hearings.mjs",
    export: "workerMeetingGet",
    store: "precomputed shared meeting read model in KV or Pages",
    readModel: MEETING_SHARED_READ_MODEL_SCHEMA,
  },
  examples: [
    {
      input: { meetingId: "meeting:city_record:20260810053" },
      output: { availability: "available", source: "city_record", exactIdentity: true },
    },
    {
      input: { meetingId: "meeting:community_board:unpublished" },
      output: { availability: "not_yet_public", error: "not-found" },
    },
  ],
  adapters: [
    {
      id: "worker-http.meeting-get@1",
      module: "worker/src/hearings.mjs",
      kind: "http-route",
      route: "GET /hearings?id=…",
      surface: "Meeting detail",
      representations: MEETING_GET_REPRESENTATIONS,
    },
    {
      id: "mcp.get_meeting@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "get_meeting",
      route: "POST /mcp",
      surface: "MCP",
      representations: MEETING_GET_REPRESENTATIONS,
    },
  ],
});

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

export function validateMeetingGetInput(input) {
  assertObject(input, "meeting.get input");
  for (const field of Object.keys(input)) if (!MEETING_INPUT_FIELDS.has(field)) throw new TypeError(`meeting.get does not accept field: ${field}`);
  if (typeof input.meetingId !== "string" || !input.meetingId.trim() || input.meetingId.length > MEETING_GET_LIMITS.meetingIdMaximumLength) {
    throw new TypeError("meetingId must be a non-empty string of 320 characters or fewer");
  }
  if (!input.meetingId.trim().startsWith("meeting:")) throw new TypeError("meetingId must be an exact canonical meeting id");
  return input;
}

function assertAvailableMeeting(meeting, input) {
  if (!meeting || typeof meeting !== "object" || Array.isArray(meeting)
      || meeting.object_type !== "meeting"
      || meeting.meeting_id !== input.meetingId.trim()
      || !meeting.source_receipt
      || !meeting.source_record) {
    throw new TypeError("available meeting has incomplete exact identity or provenance");
  }
}

export function validateMeetingGetOutput(result, input) {
  validateMeetingGetInput(input);
  assertObject(result, "meeting.get provider output");
  if (result.capability_reference !== MEETING_GET_CAPABILITY_REFERENCE) throw new TypeError("meeting.get capability reference drifted");
  if (!MEETING_GET_AVAILABILITY.includes(result.availability)) throw new TypeError("meeting.get availability is invalid");
  if (result.availability === "available") {
    assertAvailableMeeting(result.meeting, input);
    if (!result.coverage || !result.freshness || typeof result.freshness.as_of !== "string" || result.error !== null) {
      throw new TypeError("available meeting requires coverage, freshness, and no error");
    }
  } else if (result.meeting !== null || !["not-found", "unavailable"].includes(result.error)) {
    throw new TypeError("meeting.get unavailable output is inconsistent");
  }
  return result;
}

function modelRows(model) {
  if (!model || model.schema !== MEETING_SHARED_READ_MODEL_SCHEMA || !Array.isArray(model.rows)) {
    throw new Error("shared meeting read model is unavailable");
  }
  const ids = new Set();
  for (const row of model.rows) {
    if (!row?.meeting_id || ids.has(row.meeting_id)) throw new Error("shared meeting identity is not unique");
    ids.add(row.meeting_id);
  }
  return model.rows;
}

/** Execute meeting.get against an already loaded static/KV model. */
export function meetingGetFromModel(model, input) {
  validateMeetingGetInput(input);
  let rows;
  try { rows = modelRows(model); } catch {
    return {
      capability_reference: MEETING_GET_CAPABILITY_REFERENCE,
      availability: "unavailable",
      meeting: null,
      source: null,
      coverage: null,
      freshness: null,
      error: "unavailable",
    };
  }
  const meeting = rows.find((row) => row.meeting_id === input.meetingId.trim()) || null;
  if (!meeting) {
    return {
      capability_reference: MEETING_GET_CAPABILITY_REFERENCE,
      availability: "not_yet_public",
      meeting: null,
      source: null,
      coverage: model.sources || null,
      freshness: { ...(model.freshness || {}), as_of: model.generated_at || "unknown" },
      error: "not-found",
    };
  }
  const source = meeting.source_system || "unknown";
  return {
    capability_reference: MEETING_GET_CAPABILITY_REFERENCE,
    availability: "available",
    meeting,
    source: meeting.source_record || { source_system: source, identifier: meeting.source_record_id || null },
    coverage: { state: "observed", sources: model.sources || {}, source_system: source },
    freshness: { ...(model.freshness || {}), as_of: model.generated_at || "unknown" },
    error: null,
  };
}

export function executeMeetingGet(provider, input) {
  validateMeetingGetInput(input);
  if (!provider || provider.capabilityReference !== MEETING_GET_CAPABILITY_REFERENCE
      || provider.providerId !== MEETING_GET_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("meeting.get requires the registered explicit provider");
  }
  return Promise.resolve(provider.execute(input)).then((result) => validateMeetingGetOutput(result, input));
}
