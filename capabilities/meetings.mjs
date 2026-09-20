import { evaluateMeetingAvailabilityRows } from "../site/meeting_availability_filter.mjs";
import { attendanceModeForRecord, MEETINGS_ATTENDANCE_MODES } from "../site/meetings_attendance.mjs";
import { scheduleHasExactTime } from "../site/meeting_temporal_evidence.mjs";

// Transport-neutral contract for one source-qualified meeting from the
// materialized shared meeting read model. The UI, HTTP, and MCP adapters all
// use this bounded projection; none of them query a publisher at request time.

export const MEETING_GET_CAPABILITY_ID = "meeting.get";
export const MEETING_GET_CAPABILITY_VERSION = "1.1.0";
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

export const MEETINGS_BROWSE_CAPABILITY_ID = "meetings.browse";
export const MEETINGS_BROWSE_CAPABILITY_VERSION = "1.0.0";
export const MEETINGS_BROWSE_CAPABILITY_REFERENCE = "meetings.browse@1";
export const MEETINGS_BROWSE_PROVIDER_ID = "worker-static.shared-meetings.browse";
export const MEETINGS_BROWSE_LIMITS = Object.freeze({
  filterMaximumLength: 240,
  cursorMaximumLength: 512,
  minimum: 1,
  maximum: 100,
  default: 25,
});
export const MEETINGS_BROWSE_AVAILABILITY = Object.freeze(["complete", "empty", "unavailable"]);
export const MEETINGS_BROWSE_ACTIVITY = Object.freeze(["observe", "attend", "speak"]);
export const MEETINGS_BROWSE_SPEAKING_RIGHTS = Object.freeze(["allowed", "not_allowed", "requires_registration", "unknown"]);
export const MEETINGS_BROWSE_OBSERVER_ACCESS = Object.freeze(["remote", "in_person", "watch_only", "unknown"]);
export const MEETINGS_BROWSE_REPRESENTATIONS = Object.freeze([
  Object.freeze({ id: "json", mediaType: "application/json", projection: "paged shared meeting rows and coverage" }),
  Object.freeze({ id: "text-summary", mediaType: "text/plain", projection: "bounded meeting browse summary" }),
]);

// Keep the helper names scoped to this capability's public module. The legacy
// inline reconstruction flattens helper modules into one classic script.
const MEETING_INPUT_FIELDS = new Set(["meetingId"]);
const MEETINGS_BROWSE_INPUT_FIELDS = new Set([
  "from", "to", "dateFrom", "dateTo", "availability", "attendanceModes", "attendance",
  "activity", "speakingRights", "observerAccess", "sourceContractId", "sourceSystem",
  "institution", "body", "agency", "communityBoard", "geography", "placeScope", "query", "textQuery", "status", "limit", "cursor",
]);
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
    recordStates: "meeting.source_presence (present), source_observation (observed_at/observed_on), minutes (publisher status or unknown), city_record_join (source_record/matched/none/unknown); absent joins never erase publisher meeting identity or board_ref",
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

function validISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function browseString(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TypeError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length > MEETINGS_BROWSE_LIMITS.filterMaximumLength || (required && !value.trim())) {
    throw new TypeError(`${field} must be a bounded string`);
  }
  return value.trim() || null;
}

function browseEnum(value, field, values) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${field} is unsupported`);
  return value;
}

function browseArray(value, field, values) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !values.includes(item))) {
    throw new TypeError(`${field} contains an unsupported value`);
  }
  return [...new Set(value)];
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(value) {
  let hash = 2166136261;
  for (const character of stableJSON(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function encodeCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value) {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError("cursor is invalid or stale");
  }
}

function dateForRow(row) {
  return String(row?.event_date || row?.schedule?.raw_date || row?.date || "").slice(0, 10);
}

function rowText(row) {
  return [row?.search_text, row?.title, row?.description, row?.agency, row?.board_name, row?.venue?.name, row?.venue?.address]
    .filter(Boolean).join(" ").toLowerCase();
}

function observerAccessForRow(row) {
  if (row?.observer_access?.remote_join_url || row?.remote_join_url) return "remote";
  if (row?.observer_access?.watch_url) return "watch_only";
  if (row?.venue?.name || row?.venue?.address) return "in_person";
  return "unknown";
}

function browseModelRows(model) {
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

function modelStamp(model, rows) {
  return {
    generated_at: model.generated_at || model.freshness?.generated_at || null,
    row_count: rows.length,
    first_id: rows[0]?.meeting_id || null,
    last_id: rows.at(-1)?.meeting_id || null,
  };
}

function browseFilters(input) {
  return {
    from: input.from || null,
    to: input.to || null,
    availability: input.availability || null,
    attendance_modes: input.attendanceModes,
    activity: input.activity,
    speaking_rights: input.speakingRights,
    observer_access: input.observerAccess,
    source_contract_id: input.sourceContractId,
    source_system: input.sourceSystem,
    institution: input.institution,
    body: input.body,
    agency: input.agency,
    community_board: input.communityBoard,
    geography: input.geography,
    query: input.query,
    status: input.status,
  };
}

export function normalizeMeetingsBrowseInput(input = {}) {
  assertObject(input, "meetings.browse");
  for (const field of Object.keys(input)) {
    if (!MEETINGS_BROWSE_INPUT_FIELDS.has(field)) throw new TypeError(`meetings.browse does not accept field: ${field}`);
  }
  const from = input.from ?? input.dateFrom;
  const to = input.to ?? input.dateTo;
  for (const [field, value] of [["from", from], ["to", to]]) {
    if (value !== undefined && value !== null && !validISODate(value)) throw new TypeError(`${field} must be a valid ISO date`);
  }
  if (from && to && from > to) throw new TypeError("from must not be later than to");
  const availability = input.availability == null ? null : input.availability;
  const availabilityValidation = availability == null
    ? { ok: true, canonical: null }
    : (awaitableValidation(availability));
  if (!availabilityValidation.ok) throw new TypeError(`availability is invalid: ${availabilityValidation.errors[0]?.code || "invalid"}`);
  const attendanceModes = browseArray(input.attendanceModes ?? input.attendance, "attendanceModes", MEETINGS_ATTENDANCE_MODES);
  const normalized = {
    from: from || null,
    to: to || null,
    availability: availabilityValidation.canonical,
    attendanceModes,
    activity: browseEnum(input.activity, "activity", MEETINGS_BROWSE_ACTIVITY),
    speakingRights: browseEnum(input.speakingRights, "speakingRights", MEETINGS_BROWSE_SPEAKING_RIGHTS),
    observerAccess: browseEnum(input.observerAccess, "observerAccess", MEETINGS_BROWSE_OBSERVER_ACCESS),
    sourceContractId: browseString(input.sourceContractId, "sourceContractId"),
    sourceSystem: browseString(input.sourceSystem, "sourceSystem"),
    institution: browseString(input.institution, "institution"),
    body: browseString(input.body, "body"),
    agency: browseString(input.agency, "agency"),
    communityBoard: browseString(input.communityBoard, "communityBoard"),
    geography: browseString(input.geography ?? input.placeScope, "geography"),
    query: browseString(input.query ?? input.textQuery, "query"),
    status: browseString(input.status, "status"),
    limit: input.limit == null ? MEETINGS_BROWSE_LIMITS.default : input.limit,
    cursor: input.cursor == null ? null : input.cursor,
  };
  if (!Number.isInteger(normalized.limit) || normalized.limit < MEETINGS_BROWSE_LIMITS.minimum || normalized.limit > MEETINGS_BROWSE_LIMITS.maximum) {
    throw new TypeError(`limit must be an integer from ${MEETINGS_BROWSE_LIMITS.minimum} through ${MEETINGS_BROWSE_LIMITS.maximum}`);
  }
  if (normalized.cursor !== null && (typeof normalized.cursor !== "string" || normalized.cursor.length > MEETINGS_BROWSE_LIMITS.cursorMaximumLength)) {
    throw new TypeError("cursor must be a bounded string");
  }
  return normalized;
}

// Kept local so validation remains synchronous and capability modules stay transport-neutral.
function awaitableValidation(value) {
  // Importing the evaluator's validator would duplicate the availability contract's public API.
  // The evaluator is called below and reports the same structured errors; this probe is enough to
  // reject malformed expressions before a provider reads the model.
  const result = evaluateMeetingAvailabilityRows([], value);
  return result.errors.length ? { ok: false, errors: result.errors, canonical: null } : { ok: true, canonical: result.expression || null };
}

export const MEETINGS_BROWSE_CAPABILITY = deepFreeze({
  id: MEETINGS_BROWSE_CAPABILITY_ID,
  version: MEETINGS_BROWSE_CAPABILITY_VERSION,
  reference: MEETINGS_BROWSE_CAPABILITY_REFERENCE,
  owner: "meetings",
  operation: "read",
  authority: { class: "public-read", sideEffect: "none", approval: "none" },
  cost: { class: "bounded-static-read-model", machineFanOut: "one-materialized-model" },
  bounds: { input: MEETINGS_BROWSE_LIMITS, output: { maximumResults: MEETINGS_BROWSE_LIMITS.maximum } },
  input: {
    schema: "cityscroll.capability.meetings_browse.input.v1",
    filters: "bounded date range, canonical civil-time availability, attendance, activity, speaking rights, observer access, source contract/system, agency, board, geography, text, and lifecycle status",
    pagination: "opaque cursor bound to the normalized filters and read-model vintage",
    limits: MEETINGS_BROWSE_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.meetings_browse.output.v1",
    fields: ["capability_reference", "availability", "results", "total_matches", "pagination", "filters", "applied_filters", "coverage", "freshness", "error"],
    availability: MEETINGS_BROWSE_AVAILABILITY,
    representations: MEETINGS_BROWSE_REPRESENTATIONS,
  },
  provider: { id: MEETINGS_BROWSE_PROVIDER_ID, module: "worker/src/hearings.mjs", export: "workerMeetingsBrowse", store: "precomputed shared meeting read model", readModel: MEETING_SHARED_READ_MODEL_SCHEMA },
  adapters: [{ id: "mcp.browse_meetings@1", module: "worker/src/mcp.mjs", kind: "mcp-tool", tool: "browse_meetings", route: "POST /mcp", surface: "MCP", representations: MEETINGS_BROWSE_REPRESENTATIONS }],
});

function browseResult(result, input) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("meetings.browse provider must return an object");
  if (result.capability_reference !== MEETINGS_BROWSE_CAPABILITY_REFERENCE) throw new TypeError("meetings.browse capability reference drifted");
  if (!MEETINGS_BROWSE_AVAILABILITY.includes(result.availability)) throw new TypeError("meetings.browse availability is invalid");
  if (result.availability === "unavailable") {
    if (result.results !== null || result.error !== "unavailable") throw new TypeError("unavailable meetings.browse output is inconsistent");
    return result;
  }
  if (!Array.isArray(result.results) || result.results.length > MEETINGS_BROWSE_LIMITS.maximum || !Number.isInteger(result.total_matches) || result.total_matches < result.results.length) {
    throw new TypeError("meetings.browse results are invalid");
  }
  if (result.availability === "complete" && result.results.length === 0) throw new TypeError("empty browse result must use empty availability");
  if (result.availability === "empty" && result.results.length !== 0) throw new TypeError("non-empty browse result must use complete availability");
  const page = result.pagination;
  if (!page || page.limit !== input.limit || page.returned !== result.results.length || typeof page.truncated !== "boolean" || (page.next_cursor !== null && typeof page.next_cursor !== "string")) throw new TypeError("meetings.browse pagination is invalid");
  if (!result.coverage || !result.freshness || typeof result.freshness.as_of !== "string") throw new TypeError("meetings.browse coverage and freshness are required");
  return result;
}

export function meetingsBrowseFromModel(model, input = {}) {
  const normalized = normalizeMeetingsBrowseInput(input);
  let rows;
  try { rows = browseModelRows(model); } catch {
    return { capability_reference: MEETINGS_BROWSE_CAPABILITY_REFERENCE, availability: "unavailable", results: null, total_matches: null, pagination: null, filters: null, applied_filters: null, coverage: null, freshness: null, error: "unavailable" };
  }
  const stamp = modelStamp(model, rows);
  const queryKey = fingerprint({ filters: browseFilters(normalized), model: stamp });
  let offset = 0;
  if (normalized.cursor) {
    const cursor = decodeCursor(normalized.cursor);
    if (cursor?.version !== 1 || cursor.query_key !== queryKey || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw new TypeError("cursor is invalid or stale");
    offset = cursor.offset;
  }
  const candidates = rows.filter((row) => {
    const date = dateForRow(row);
    if (normalized.from && (!date || date < normalized.from)) return false;
    if (normalized.to && (!date || date > normalized.to)) return false;
    if (normalized.sourceContractId && row.source_contract_id !== normalized.sourceContractId) return false;
    if (normalized.sourceSystem && row.source_system !== normalized.sourceSystem) return false;
    if (normalized.institution && (row.institution_refs?.institution_ref || row.institution_ref || row.agency) !== normalized.institution) return false;
    if (normalized.body && (row.board_name || row.source_system || row.agency) !== normalized.body) return false;
    if (normalized.agency && row.agency !== normalized.agency) return false;
    if (normalized.communityBoard && String(row.board_id || "") !== normalized.communityBoard.replace(/^community-board:/, "")) return false;
    if (normalized.geography && !rowText(row).includes(normalized.geography.toLowerCase())) return false;
    if (normalized.query && !rowText(row).includes(normalized.query.toLowerCase())) return false;
    if (normalized.activity && row.activity !== normalized.activity) return false;
    if (normalized.speakingRights && (row.speaking_rights || "unknown") !== normalized.speakingRights) return false;
    if (normalized.observerAccess && observerAccessForRow(row) !== normalized.observerAccess) return false;
    if (normalized.attendanceModes.length && !normalized.attendanceModes.includes(row.attendance_mode || attendanceModeForRecord(row))) return false;
    if (normalized.status && (row.status || row.lifecycle || row.schedule?.status) !== normalized.status) return false;
    return true;
  }).sort((left, right) => dateForRow(left).localeCompare(dateForRow(right)) || left.meeting_id.localeCompare(right.meeting_id));
  const availability = evaluateMeetingAvailabilityRows(candidates, normalized.availability, { asOf: model.freshness?.checked_at || model.generated_at || "1900-01-01" });
  const matched = availability.rows;
  const unknownStart = normalized.availability
    ? availability.counts.unknown_start
    : candidates.filter((row) => !scheduleHasExactTime(row.schedule)).length;
  const pageRows = matched.slice(offset, offset + normalized.limit);
  const nextOffset = offset + pageRows.length;
  const nextCursor = nextOffset < matched.length
    ? encodeCursor({ version: 1, query_key: queryKey, offset: nextOffset })
    : null;
  const filters = browseFilters(normalized);
  const result = {
    capability_reference: MEETINGS_BROWSE_CAPABILITY_REFERENCE,
    availability: pageRows.length ? "complete" : "empty",
    results: pageRows,
    total_matches: matched.length,
    pagination: { limit: normalized.limit, returned: pageRows.length, truncated: nextCursor !== null, next_cursor: nextCursor },
    filters,
    applied_filters: filters,
    coverage: {
      state: "observed",
      sources: model.sources || {},
      candidate_rows: candidates.length,
      matched_rows: matched.length,
      exclusions: { ...availability.counts, unknown_start: unknownStart },
      unknown_start_exclusions: unknownStart,
    },
    freshness: { ...(model.freshness || {}), as_of: model.generated_at || model.freshness?.generated_at || "unknown" },
    error: null,
  };
  return browseResult(result, normalized);
}

export async function executeMeetingsBrowse(provider, input = {}) {
  const normalized = normalizeMeetingsBrowseInput(input);
  if (!provider || provider.capabilityReference !== MEETINGS_BROWSE_CAPABILITY_REFERENCE
      || provider.providerId !== MEETINGS_BROWSE_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("meetings.browse requires the registered explicit provider");
  }
  return browseResult(await provider.execute(normalized), normalized);
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
    meeting: {
      ...meeting,
      source_presence: { status: "present", publisher_identifier: meeting.publisher_identifier || meeting.source_record_id || null },
      source_observation: {
        observed_at: meeting.source_receipt?.observed_at || null,
        observed_on: meeting.source_receipt?.observed_at?.slice(0, 10) || null,
      },
      minutes: { status: meeting.minutes_freshness?.status || "unknown", checked_at: meeting.minutes_freshness?.checked_at || null },
      city_record_join: {
        status: meeting.source_system === "city_record" ? "source_record"
          : meeting.meeting_join?.join?.matched === true ? "matched"
          : meeting.meeting_join?.reason === "no_city_record_notice" ? "none" : "unknown",
        reason: meeting.meeting_join?.reason || null,
        scope: "Join to the retained City Record notices; an absent join does not mean the source meeting is absent.",
      },
    },
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
