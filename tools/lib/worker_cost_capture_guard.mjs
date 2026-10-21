/**
 * Wrangler-tail capture guard for owned Worker cost-control probes.
 *
 * At ingest, before any disk write:
 * 1. Drop every event that is not an exact owned cost-control probe.
 * 2. Persist only predicate fields + numeric telemetry for owned events.
 * 3. Privacy checker is fail-closed: any checker error aborts persistence/run.
 *
 * Ownership is exact membership of the probe marker in the active run's
 * `ownedMarkers` set (held in RAM by the collector and passed into the filter),
 * plus optional intended version / cohort / arm sets. Header presence alone is
 * never enough. Missing run context drops everything (fail closed).
 *
 * In-memory matching may retain richer fields (logs/receipts) only in RAM;
 * those must never be written. This module owns the persistable projection.
 *
 * Zero provider writes. Synthetic tests only — never load quarantined captures.
 */

export const OWNED_PROBE_URL = "https://api.cityscroll.org/admin/cost-control-probe";
export const OWNED_PROBE_METHOD = "POST";
export const OWNED_ROUTE_CLASS = "admin-cost-control-probe";
export const PROBE_HEADER = "x-cityscroll-cost-probe";

/** Header names that must never appear on a persisted capture record. */
export const FORBIDDEN_PERSIST_HEADER_KEYS = Object.freeze([
  "cf-ray",
  "user-agent",
  "referer",
  "origin",
  "from",
  "authorization",
  "cookie",
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
  "true-client-ip",
  "cf-ipcountry",
  "forwarded",
  "accept",
  "accept-encoding",
  "accept-language",
  "host",
  "connection",
  "content-type",
  "content-length",
  "cf-visitor",
  "cf-worker",
  "cf-connecting-o2o",
  "cloudflare-workers-version-overrides",
  "x-forwarded-proto",
  "x-cityscroll-cost-cohort",
  "x-cityscroll-cost-series",
  "x-cityscroll-cost-workload",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "upgrade-insecure-requests",
  "cache-control",
  "pragma",
]);

/** Top-level / nested keys forbidden on persisted records. */
export const FORBIDDEN_PERSIST_KEYS = Object.freeze([
  "logs",
  "exceptions",
  "headers",
  "cf",
  "url",
  "body",
  "requestHeaderNames",
  "scriptName",
  "executionModel",
  "truncated",
  "event",
  "$workers",
  "$metadata",
]);

const PREDICATE_TOP_KEYS = new Set([
  "cpuTime",
  "wallTime",
  "eventTimestamp",
  "outcome",
  "scriptVersion",
  "probe",
  "method",
  "route_class",
]);

function fail(message) {
  const error = new Error(message);
  error.code = "CAPTURE_GUARD";
  throw error;
}

function headerMap(request) {
  const headers = request?.headers;
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function requestOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  return raw.event?.request || raw.$workers?.event?.request || raw.request || null;
}

function normalizeUrl(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

/**
 * Normalize optional ownership context.
 * Missing/empty ownedMarkers → fail-closed (nothing is owned).
 */
export function normalizeOwnershipContext(context) {
  if (!context || typeof context !== "object") return null;
  const markers = context.ownedMarkers;
  if (!(markers instanceof Set) || markers.size === 0) return null;
  const allowedVersionIds = context.allowedVersionIds instanceof Set
    && context.allowedVersionIds.size > 0
    ? context.allowedVersionIds
    : null;
  const allowedCohorts = context.allowedCohorts instanceof Set
    && context.allowedCohorts.size > 0
    ? context.allowedCohorts
    : null;
  const allowedArms = context.allowedArms instanceof Set
    && context.allowedArms.size > 0
    ? context.allowedArms
    : null;
  return { ownedMarkers: markers, allowedVersionIds, allowedCohorts, allowedArms };
}

/**
 * Exact owned probe: POST admin cost-control-probe URL AND probe marker is an
 * exact member of the active run's ownedMarkers set (held in RAM by the
 * collector). Header presence / prefix alone is never enough. Missing run
 * context → not owned (fail closed).
 */
export function isOwnedProbeEvent(raw, context = null) {
  const ownership = normalizeOwnershipContext(context);
  if (!ownership) return false;
  const request = requestOf(raw);
  if (!request) return false;
  if (String(request.method || "").toUpperCase() !== OWNED_PROBE_METHOD) return false;
  if (normalizeUrl(request.url) !== OWNED_PROBE_URL) return false;
  const headers = headerMap(request);
  const probe = headers[PROBE_HEADER];
  if (typeof probe !== "string" || !ownership.ownedMarkers.has(probe)) return false;

  if (ownership.allowedVersionIds) {
    const scriptVersion = raw.scriptVersion || raw.$workers?.scriptVersion || null;
    const versionId = scriptVersion && typeof scriptVersion === "object"
      ? scriptVersion.id
      : null;
    if (typeof versionId !== "string" || !ownership.allowedVersionIds.has(versionId)) {
      return false;
    }
  }
  if (ownership.allowedCohorts) {
    const cohort = headers["x-cityscroll-cost-cohort"];
    if (typeof cohort !== "string" || !ownership.allowedCohorts.has(cohort)) return false;
  }
  if (ownership.allowedArms) {
    const arm = headers["x-cityscroll-cost-series"] || headers["x-cityscroll-cost-arm"];
    if (typeof arm !== "string" || !ownership.allowedArms.has(arm)) return false;
  }
  return true;
}

/**
 * Persistable projection: predicate fields + numeric telemetry only.
 * Call only after isOwnedProbeEvent(raw, context) === true.
 * Never persists the raw attacker-controllable probe header value.
 */
export function toPredicateOnlyCapture(raw, context = null) {
  if (!isOwnedProbeEvent(raw, context)) {
    fail("toPredicateOnlyCapture refuses non-owned events");
  }
  const scriptVersion = raw.scriptVersion || raw.$workers?.scriptVersion || null;
  const versionId = scriptVersion && typeof scriptVersion === "object"
    ? scriptVersion.id
    : null;
  if (typeof versionId !== "string" || !versionId) {
    fail("owned probe missing scriptVersion.id");
  }
  if (typeof raw.outcome !== "string" || !raw.outcome) {
    fail("owned probe missing outcome");
  }
  const projected = {
    outcome: raw.outcome,
    scriptVersion: { id: versionId },
    // Normalized owned predicate only — never the raw probe header value.
    probe: "owned",
    method: OWNED_PROBE_METHOD,
    route_class: OWNED_ROUTE_CLASS,
  };
  for (const key of ["cpuTime", "wallTime", "eventTimestamp"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) {
      projected[key] = raw[key];
    }
    // Missing numeric telemetry stays absent (UNKNOWN); never substitute 0/wall.
  }
  assertPersistedCapturePrivacy(projected);
  return projected;
}

function walkForbidden(value, path, hits) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkForbidden(entry, `${path}[${index}]`, hits));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    const childPath = path === "$" ? key : `${path}.${key}`;
    if (FORBIDDEN_PERSIST_KEYS.some((name) => name.toLowerCase() === lower)) {
      hits.push(childPath);
    }
    if (FORBIDDEN_PERSIST_HEADER_KEYS.includes(lower)) {
      hits.push(childPath);
    }
    if (lower === "headers" && child && typeof child === "object") {
      for (const headerKey of Object.keys(child)) {
        hits.push(`${childPath}.${headerKey}`);
      }
    }
    walkForbidden(child, childPath, hits);
  }
}

/**
 * Fail-closed privacy checker for a record that is about to be / was persisted.
 * Throws on any forbidden key. Checker errors must abort persistence and the run.
 */
export function assertPersistedCapturePrivacy(record) {
  if (!record || typeof record !== "object") {
    fail("persisted capture must be an object");
  }
  const hits = [];
  walkForbidden(record, "$", hits);
  for (const key of Object.keys(record)) {
    if (!PREDICATE_TOP_KEYS.has(key)) {
      hits.push(`$.${key}`);
    }
  }
  if (record.scriptVersion && typeof record.scriptVersion === "object") {
    for (const key of Object.keys(record.scriptVersion)) {
      if (key !== "id") hits.push(`$.scriptVersion.${key}`);
    }
  }
  if (hits.length) {
    fail(`persisted capture retained forbidden fields: ${hits.slice(0, 12).join(",")}`);
  }
  return true;
}

/**
 * Ingest one raw wrangler-tail event for persistence.
 * `context.ownedMarkers` is required (exact active-run marker set in RAM).
 * Missing context → drop everything (fail closed, no throw).
 * Returns { persist: null } for non-owned (dropped).
 * Returns { persist: predicateOnly } for owned.
 * Throws (fail-closed) on checker/projection errors — caller must abort the run.
 */
export function ingestForPersistence(raw, context = null) {
  const ownership = normalizeOwnershipContext(context);
  if (!ownership) {
    return { owned: false, persist: null, reason: "missing_run_context" };
  }
  try {
    if (!isOwnedProbeEvent(raw, ownership)) {
      return { owned: false, persist: null };
    }
    const persist = toPredicateOnlyCapture(raw, ownership);
    assertPersistedCapturePrivacy(persist);
    return { owned: true, persist };
  } catch (error) {
    const wrapped = new Error(
      `capture-guard fail-closed: ${error?.message || error}`,
    );
    wrapped.code = "CAPTURE_GUARD_FAIL_CLOSED";
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * Append owned predicate-only records only. Fail-closed on checker errors.
 * `context.ownedMarkers` required. `writeLine` receives one JSON string.
 */
export function persistOwnedCaptures(rawEvents, writeLine, context = null) {
  if (typeof writeLine !== "function") fail("writeLine required");
  let owned = 0;
  let dropped = 0;
  for (const raw of rawEvents) {
    const result = ingestForPersistence(raw, context);
    if (!result.owned) {
      dropped += 1;
      continue;
    }
    writeLine(`${JSON.stringify(result.persist)}\n`);
    owned += 1;
  }
  return { owned, dropped };
}
