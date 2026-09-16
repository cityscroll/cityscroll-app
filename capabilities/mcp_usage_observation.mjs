// Versioned, content-free MCP usage observation schema.
//
// One observation describes one supported MCP dispatch/request outcome. The field set is
// closed: credentials, IPs, raw user agents, prompts, arguments, response bodies, entity
// identifiers, subscriber identities, exception text, and arbitrary unknown tool or client
// names never enter a stored row. Unknown high-cardinality inputs collapse into bounded
// buckets instead of being passed through.
//
// The six-field MACHINE_CLIENT_TELEMETRY contract remains intact. toolCallObservationFromTelemetry()
// is the versioned adapter that projects those six fields into this schema without widening
// the original record.

import { MCP_TOOL_BINDINGS } from "./mcp_tool_declarations.mjs";
import {
  MACHINE_CLIENT_ERROR_CLASSES,
  MACHINE_CLIENT_PROFILES,
  MACHINE_CLIENT_TELEMETRY_FIELDS,
} from "./machine_client_profile.mjs";

export const MCP_USAGE_OBSERVATION_SCHEMA = "cityscroll.mcp_usage_observation.v1";
export const MCP_USAGE_TAXONOMY_VERSION = "mcp.1.0.0";
export const MCP_USAGE_SURFACE = "mcp";
export const MCP_USAGE_RETENTION_DAYS = 90;

/** Protocol methods and request-level outcomes this collector may name. */
export const MCP_USAGE_METHODS = Object.freeze([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "unsupported_method",
  "parse_error",
  "unauthorized",
  "quota_refusal",
  "method_not_allowed",
  "notification",
]);

/**
 * Closed outcome classes. Application-level tool errors (isError) stay distinct from
 * thrown handler failures and from transport/auth refusals.
 */
export const MCP_USAGE_OUTCOMES = Object.freeze([
  "success",
  "empty_success",
  "application_error",
  "thrown_error",
  "unknown_tool",
  "not_granted",
  "invalid_input",
  "unauthorized",
  "quota_exhausted",
  "malformed_json",
  "unsupported_method",
  "method_not_allowed",
  "notification_ack",
  "cancelled",
  "provider_unavailable",
  "internal",
]);

/**
 * Observation classes separate real product use from known operator/canary/probe traffic.
 * Only trusted exclusion mechanisms (developer HMAC, explicit canary/probe marking, or a
 * non-production analytics environment) may leave "production". Self-reported labels without
 * that trust path stay production so anonymous claims cannot mint verified adoption nor hide
 * themselves by spoofing a non-production class without the shared exclusion secret.
 */
export const MCP_USAGE_OBSERVATION_CLASSES = Object.freeze([
  "production",
  "developer",
  "canary",
  "probe",
]);

export const MCP_USAGE_CLIENT_FAMILIES = Object.freeze([
  "unknown",
  "claude",
  "chatgpt",
  "cursor",
  "vscode",
  "copilot",
  "gemini",
  "sdk",
  "curl",
  "other",
]);

export const MCP_USAGE_AVAILABILITY_VALUES = Object.freeze([
  "none",
  "available",
  "complete",
  "empty",
  "partial",
  "not_yet_public",
  "unavailable",
  "unknown",
  "other",
]);

export const MCP_USAGE_COVERAGE_GAPS = Object.freeze([
  "Client disconnect after the Worker has begun writing a response is not observable as cancellation on this runtime.",
  "JSON-RPC notifications (no id) acknowledge with 202 and record notification_ack only; they do not prove a remote client retained state.",
  "Client family and version are self-reported on initialize only and may be gateway-proxied; other methods leave them unknown because this endpoint is stateless HTTP and invents no cross-request session.",
  "A tools/list observation fingerprints the catalog served on that response; it does not prove a remote client cached that catalog.",
  "Calls, connections, results, and unique people remain distinct units; this collector never derives a unique-user count.",
]);

const REGISTERED_TOOLS = Object.freeze(MCP_TOOL_BINDINGS.map((binding) => binding.name).sort());
const REGISTERED_TOOL_SET = new Set(REGISTERED_TOOLS);
const REGISTERED_PROFILE_IDS = Object.freeze(MACHINE_CLIENT_PROFILES.map((profile) => profile.id));
const REGISTERED_PROFILE_SET = new Set(REGISTERED_PROFILE_IDS);
const NONE = "none";
const UNKNOWN = "unknown";
const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const FINGERPRINT_HEX = /^[a-f0-9]{16}$/;
const PROTOCOL_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/;

export const MCP_USAGE_OBSERVATION_FIELDS = Object.freeze([
  "schema",
  "taxonomy_version",
  "surface",
  "method",
  "tool",
  "outcome",
  "observation_class",
  "deployment_identity",
  "client_family",
  "client_version",
  "protocol_version",
  "catalog_fingerprint",
  "catalog_tool_count",
  "profile_id",
  "capability_reference",
  "availability",
  "duration_ms",
  "result_count",
  "error_class",
]);

function enumOr(value, allowed, fallback) {
  const normalized = String(value || "").trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function boundedNonNegativeInt(value, max = 86_400_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), max);
}

function deploymentIdentity(value) {
  const raw = String(value || "").trim().toLowerCase();
  return COMMIT_SHA.test(raw) ? raw : UNKNOWN;
}

function protocolVersion(value) {
  const raw = String(value || "").trim();
  return PROTOCOL_VERSION_RE.test(raw) ? raw : UNKNOWN;
}

function clientVersion(value) {
  const raw = String(value || "").trim();
  if (!raw) return UNKNOWN;
  return CLIENT_VERSION_RE.test(raw) ? raw.slice(0, 32) : UNKNOWN;
}

function clientFamily(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return UNKNOWN;
  if (MCP_USAGE_CLIENT_FAMILIES.includes(raw)) return raw;
  if (raw.includes("claude")) return "claude";
  if (raw.includes("chatgpt") || raw.includes("openai")) return "chatgpt";
  if (raw.includes("cursor")) return "cursor";
  if (raw.includes("vscode") || raw.includes("visual studio")) return "vscode";
  if (raw.includes("copilot")) return "copilot";
  if (raw.includes("gemini") || raw.includes("google")) return "gemini";
  if (raw.includes("curl")) return "curl";
  if (raw.includes("sdk") || raw.includes("modelcontextprotocol")) return "sdk";
  // Arbitrary free-text client names collapse; they never become a stored dimension.
  return "other";
}

function toolName(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === NONE) return NONE;
  return REGISTERED_TOOL_SET.has(raw) ? raw : UNKNOWN;
}

function profileId(value) {
  if (value == null || value === "") return "anonymous";
  const raw = String(value);
  return REGISTERED_PROFILE_SET.has(raw) ? raw : UNKNOWN;
}

function availabilityValue(value) {
  if (value == null || value === "") return NONE;
  const raw = String(value);
  if (MCP_USAGE_AVAILABILITY_VALUES.includes(raw)) return raw;
  return "other";
}

function catalogFingerprint(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === NONE) return NONE;
  return FINGERPRINT_HEX.test(raw) ? raw : UNKNOWN;
}

function capabilityReference(value) {
  if (value == null || value === "") return null;
  const raw = String(value);
  // Capability references are registry strings like "search.notices@1". Bound length and charset.
  if (!/^[a-z0-9][a-z0-9._@-]{0,63}$/i.test(raw)) return null;
  return raw;
}

function errorClass(value) {
  const raw = String(value || "none");
  return MACHINE_CLIENT_ERROR_CLASSES.includes(raw) ? raw : "internal";
}

/**
 * Build one closed observation. Unknown keys are dropped; illegal enum values fall back to
 * bounded buckets. The returned object's key set is exactly MCP_USAGE_OBSERVATION_FIELDS.
 */
export function mcpUsageObservation(input = {}) {
  const method = enumOr(input.method, MCP_USAGE_METHODS, "unsupported_method");
  const outcome = enumOr(input.outcome, MCP_USAGE_OUTCOMES, "internal");
  const observationClass = enumOr(input.observation_class, MCP_USAGE_OBSERVATION_CLASSES, "production");
  const tool = method === "tools/call" || method === "tools/list" ? toolName(input.tool) : NONE;
  const catalogToolCount = method === "tools/list"
    ? boundedNonNegativeInt(input.catalog_tool_count, 512)
    : 0;

  return Object.freeze({
    schema: MCP_USAGE_OBSERVATION_SCHEMA,
    taxonomy_version: MCP_USAGE_TAXONOMY_VERSION,
    surface: MCP_USAGE_SURFACE,
    method,
    tool: method === "tools/call" ? tool : (method === "tools/list" ? NONE : NONE),
    outcome,
    observation_class: observationClass,
    deployment_identity: deploymentIdentity(input.deployment_identity),
    client_family: clientFamily(input.client_family),
    client_version: clientVersion(input.client_version),
    protocol_version: protocolVersion(input.protocol_version),
    catalog_fingerprint: method === "tools/list" ? catalogFingerprint(input.catalog_fingerprint) : NONE,
    catalog_tool_count: catalogToolCount,
    profile_id: profileId(input.profile_id),
    capability_reference: capabilityReference(input.capability_reference),
    availability: availabilityValue(input.availability),
    duration_ms: boundedNonNegativeInt(input.duration_ms),
    result_count: boundedNonNegativeInt(input.result_count, 10_000),
    error_class: errorClass(input.error_class),
  });
}

/**
 * Versioned adapter: project the closed six-field profile telemetry record into an observation
 * without reading any additional caller content. Missing protocol fields stay unknown/none.
 */
export function toolCallObservationFromTelemetry(telemetry, extras = {}) {
  const keys = Object.keys(telemetry || {});
  const expected = new Set(MACHINE_CLIENT_TELEMETRY_FIELDS);
  if (keys.length !== MACHINE_CLIENT_TELEMETRY_FIELDS.length
    || keys.some((field) => !expected.has(field))) {
    // Refuse to adapt a widened record; the six-field contract stays exact.
    return mcpUsageObservation({
      method: "tools/call",
      outcome: "internal",
      observation_class: extras.observation_class,
      deployment_identity: extras.deployment_identity,
      error_class: "internal",
      profile_id: extras.profile_id,
    });
  }

  const error = telemetry.error_class || "none";
  let outcome = "success";
  if (error === "not_granted") outcome = "not_granted";
  else if (error === "unknown_tool") outcome = "unknown_tool";
  else if (error === "invalid_input") outcome = "application_error";
  else if (error === "quota_exhausted") outcome = "quota_exhausted";
  else if (error === "unauthorized") outcome = "unauthorized";
  else if (error === "provider_unavailable") outcome = "provider_unavailable";
  else if (error === "internal") outcome = "internal";
  else if (error === "none" && boundedNonNegativeInt(telemetry.count) === 0
    && (telemetry.availability === "empty" || telemetry.availability === "complete"
      || telemetry.availability == null)) {
    // Empty success is available when the tool reported zero results without error.
    if (telemetry.availability === "empty" || (telemetry.availability == null && telemetry.count === 0 && extras.emptySuccess)) {
      outcome = "empty_success";
    }
  }

  return mcpUsageObservation({
    method: "tools/call",
    tool: extras.tool,
    outcome,
    observation_class: extras.observation_class,
    deployment_identity: extras.deployment_identity,
    client_family: extras.client_family,
    client_version: extras.client_version,
    protocol_version: extras.protocol_version,
    profile_id: telemetry.profile_id,
    capability_reference: telemetry.capability_reference,
    availability: telemetry.availability,
    duration_ms: telemetry.duration_ms,
    result_count: telemetry.count,
    error_class: error,
  });
}

/**
 * Deterministic fingerprint of the profile-filtered tool descriptors actually returned,
 * including name, description, and input schema. Returns a 16-hex digest prefix.
 */
export async function fingerprintToolCatalog(tools) {
  const normalized = (Array.isArray(tools) ? tools : [])
    .map((tool) => ({
      name: String(tool?.name || ""),
      description: String(tool?.description || ""),
      inputSchema: tool?.inputSchema ?? tool?.input_schema ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const payload = JSON.stringify(normalized);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function registeredMcpToolNames() {
  return REGISTERED_TOOLS;
}

export function outcomeFromToolResult(result, { thrown = false } = {}) {
  if (thrown) return "thrown_error";
  if (result?.isError) return "application_error";
  const structured = result?.structuredContent;
  let count = 0;
  for (const key of ["records", "results", "passages", "relationships", "projects", "contracts", "organizations"]) {
    if (Array.isArray(structured?.[key])) {
      count = structured[key].length;
      break;
    }
  }
  if (count === 0 && (structured?.availability === "empty" || structured?.availability === "complete" || structured == null)) {
    if (structured?.availability === "empty") return "empty_success";
  }
  return "success";
}

/**
 * Map Analytics Engine blobs/doubles for one observation. Distinct taxonomy_version keeps
 * these rows out of the browser usage SQL allowlist.
 */
export function mcpUsageDataPoint(observation) {
  const row = observation?.schema === MCP_USAGE_OBSERVATION_SCHEMA
    ? observation
    : mcpUsageObservation(observation);
  return {
    blobs: [
      row.schema,
      row.method,
      row.tool,
      row.outcome,
      row.observation_class,
      row.taxonomy_version,
      row.deployment_identity,
      row.client_family,
      row.client_version,
      row.protocol_version,
      row.catalog_fingerprint,
      row.profile_id,
      row.availability,
      row.surface,
      row.error_class,
      row.capability_reference || NONE,
    ],
    doubles: [
      1,
      row.duration_ms,
      row.result_count,
      row.catalog_tool_count,
    ],
    indexes: ["mcp_usage"],
  };
}

export function parseMcpUsageDataPoint(blobs = [], doubles = []) {
  return mcpUsageObservation({
    method: blobs[1],
    tool: blobs[2],
    outcome: blobs[3],
    observation_class: blobs[4],
    deployment_identity: blobs[6],
    client_family: blobs[7],
    client_version: blobs[8],
    protocol_version: blobs[9],
    catalog_fingerprint: blobs[10],
    profile_id: blobs[11] === "anonymous" ? null : blobs[11],
    availability: blobs[12],
    error_class: blobs[14],
    capability_reference: blobs[15] === NONE ? null : blobs[15],
    duration_ms: doubles[1],
    result_count: doubles[2],
    catalog_tool_count: doubles[3],
  });
}
