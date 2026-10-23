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
  // Controlled-marker registry projections (allowlisted values or "UNKNOWN").
  "cohort",
  "workload_hash",
  "arm",
]);

/** Sentinel when a controlled-marker registry is active but the header is absent/unlisted. */
export const CONTROLLED_MARKER_UNKNOWN = "UNKNOWN";

/**
 * Closed canonical cohort enum for allowlisted controlled-marker projection.
 * Independent of caller-supplied Sets so arbitrary identifiers cannot enter.
 */
export const CONTROLLED_MARKER_COHORTS = Object.freeze([
  "zap-bbl",
  "zap-project",
  "doing-business",
  "health",
  "browse",
  "collector-overhead",
]);

/** Closed arm enum: derived from scriptVersion mapping only — never from series. */
export const CONTROLLED_MARKER_ARMS = Object.freeze(["rollback", "candidate"]);

export const WORKLOAD_HASH_RE = /^[a-f0-9]{64}$/;

function fail(message) {
  const error = new Error(message);
  error.code = "CAPTURE_GUARD";
  throw error;
}

export function isCanonicalControlledCohort(value) {
  return typeof value === "string" && CONTROLLED_MARKER_COHORTS.includes(value);
}

export function isCanonicalWorkloadHash(value) {
  return typeof value === "string" && WORKLOAD_HASH_RE.test(value);
}

export function isCanonicalControlledArm(value) {
  return value === "rollback" || value === "candidate";
}

/**
 * Privacy VALUE check for projected controlled-marker fields.
 * Rejects URLs, query strings, emails, path/authority forms, and overlong ids.
 */
export function isSafeControlledMarkerValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return false;
  if (value === CONTROLLED_MARKER_UNKNOWN) return true;
  if (/[/?#@:\s\\]|https?:|%[0-9a-fA-F]{2}/.test(value)) return false;
  return true;
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

function readMarkerTuples(rawTuples) {
  if (!rawTuples) return null;
  const entries = rawTuples instanceof Map
    ? [...rawTuples.entries()]
    : (typeof rawTuples === "object" && !Array.isArray(rawTuples)
      ? Object.entries(rawTuples)
      : null);
  if (!entries || entries.length === 0) return null;
  const markerTuples = new Map();
  for (const [marker, tuple] of entries) {
    if (typeof marker !== "string" || marker.length === 0) {
      fail("controlled-marker registry markerTuples keys must be non-empty strings");
    }
    if (!tuple || typeof tuple !== "object") {
      fail("controlled-marker registry markerTuples values must be objects");
    }
    const cohort = tuple.cohort;
    const workloadHash = tuple.workloadHash ?? tuple.workload_hash;
    if (!isCanonicalControlledCohort(cohort)) {
      fail("controlled-marker registry cohort is not in the closed canonical enum");
    }
    if (!isCanonicalWorkloadHash(workloadHash)) {
      fail("controlled-marker registry workload_hash must be a 64-hex digest");
    }
    if (!isSafeControlledMarkerValue(cohort) || !isSafeControlledMarkerValue(workloadHash)) {
      fail("controlled-marker registry tuple failed privacy value checks");
    }
    markerTuples.set(marker, { cohort, workloadHash });
  }
  return markerTuples.size > 0 ? markerTuples : null;
}

function readArmByVersionId(rawArms) {
  if (!rawArms) return null;
  const entries = rawArms instanceof Map
    ? [...rawArms.entries()]
    : (typeof rawArms === "object" && !Array.isArray(rawArms)
      ? Object.entries(rawArms)
      : null);
  if (!entries || entries.length === 0) return null;
  const armByVersionId = new Map();
  for (const [versionId, arm] of entries) {
    if (typeof versionId !== "string" || versionId.length === 0) {
      fail("controlled-marker registry armByVersionId keys must be non-empty strings");
    }
    if (!isCanonicalControlledArm(arm)) {
      fail("controlled-marker registry arm must be rollback or candidate");
    }
    if (!isSafeControlledMarkerValue(versionId)) {
      // Version UUIDs contain hyphens — allow UUID form explicitly.
      if (!/^[0-9a-fA-F-]{8,64}$/.test(versionId) && versionId !== "SYNTHETIC_VERSION_ID") {
        fail("controlled-marker registry version id failed privacy value checks");
      }
    }
    armByVersionId.set(versionId, arm);
  }
  return armByVersionId.size > 0 ? armByVersionId : null;
}

/**
 * Normalize optional controlled-marker registry.
 *
 * Exact owned-probe binding only:
 * - markerTuples: Map/object of probe-marker → { cohort, workloadHash }
 * - armByVersionId: Map/object of scriptVersion.id → "rollback"|"candidate"
 *
 * Independent cohort/hash/series Sets are rejected (they allow cross-pairing).
 * Series is never an arm. Malformed config fails closed.
 * Missing/empty registry → null (projection omits controlled-marker fields).
 */
export function normalizeControlledMarkerRegistry(registry) {
  if (!registry || typeof registry !== "object") return null;
  if (registry.cohorts != null || registry.workloadHashes != null || registry.arms != null) {
    fail(
      "controlled-marker registry must use markerTuples + armByVersionId; "
      + "independent cohort/workloadHashes/arms Sets are rejected",
    );
  }
  const markerTuples = readMarkerTuples(registry.markerTuples);
  const armByVersionId = readArmByVersionId(registry.armByVersionId);
  if (!markerTuples && !armByVersionId) return null;
  return { markerTuples, armByVersionId };
}

/**
 * Bind one RAM-only owned probe marker to its expected validated tuple.
 * Used by the collector at emit time. Never persists the marker itself.
 */
export function bindOwnedProbeMarkerTuple(registry, marker, tuple) {
  if (!registry || typeof registry !== "object") {
    fail("bindOwnedProbeMarkerTuple requires a registry object");
  }
  if (typeof marker !== "string" || marker.length === 0) {
    fail("bindOwnedProbeMarkerTuple requires a non-empty marker");
  }
  const cohort = tuple?.cohort;
  const workloadHash = tuple?.workloadHash ?? tuple?.workload_hash;
  if (!isCanonicalControlledCohort(cohort)) {
    fail("bindOwnedProbeMarkerTuple cohort is not in the closed canonical enum");
  }
  if (!isCanonicalWorkloadHash(workloadHash)) {
    fail("bindOwnedProbeMarkerTuple workload_hash must be a 64-hex digest");
  }
  if (!isSafeControlledMarkerValue(cohort) || !isSafeControlledMarkerValue(workloadHash)) {
    fail("bindOwnedProbeMarkerTuple tuple failed privacy value checks");
  }
  if (!(registry.markerTuples instanceof Map)) {
    registry.markerTuples = new Map();
  }
  registry.markerTuples.set(marker, { cohort, workloadHash });
  return registry;
}

/**
 * Project allowlisted controlled markers for an owned probe.
 * Enforces isOwnedProbeEvent. Binds exact marker→(cohort,workload_hash) tuples;
 * mismatch → UNKNOWN (never copies independent header values). Arm derives only
 * from scriptVersion via armByVersionId — never from series. Never returns the
 * raw probe marker.
 */
export function projectOwnedControlledMarkers(raw, context = null) {
  if (!isOwnedProbeEvent(raw, context)) {
    fail("projectOwnedControlledMarkers refuses non-owned events");
  }
  const registry = normalizeControlledMarkerRegistry(
    context?.controlledMarkerRegistry ?? context?.controlledMarkers ?? null,
  );
  if (!registry) return null;
  const headers = headerMap(requestOf(raw));
  const marker = headers[PROBE_HEADER];
  const out = {};
  if (registry.markerTuples) {
    const expected = typeof marker === "string" ? registry.markerTuples.get(marker) : null;
    const cohortHeader = headers["x-cityscroll-cost-cohort"];
    const workloadHeader = headers["x-cityscroll-cost-workload"];
    const tupleMatch = Boolean(
      expected
      && cohortHeader === expected.cohort
      && workloadHeader === expected.workloadHash
      && isCanonicalControlledCohort(cohortHeader)
      && isCanonicalWorkloadHash(workloadHeader)
      && isSafeControlledMarkerValue(cohortHeader)
      && isSafeControlledMarkerValue(workloadHeader),
    );
    out.cohort = tupleMatch ? cohortHeader : CONTROLLED_MARKER_UNKNOWN;
    out.workload_hash = tupleMatch ? workloadHeader : CONTROLLED_MARKER_UNKNOWN;
  }
  if (registry.armByVersionId) {
    const scriptVersion = raw.scriptVersion || raw.$workers?.scriptVersion || null;
    const versionId = scriptVersion && typeof scriptVersion === "object"
      ? scriptVersion.id
      : null;
    const arm = typeof versionId === "string"
      ? registry.armByVersionId.get(versionId)
      : null;
    out.arm = isCanonicalControlledArm(arm) ? arm : CONTROLLED_MARKER_UNKNOWN;
  }
  return out;
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
  const controlledMarkerRegistry = normalizeControlledMarkerRegistry(
    context.controlledMarkerRegistry ?? context.controlledMarkers ?? null,
  );
  return {
    ownedMarkers: markers,
    allowedVersionIds,
    allowedCohorts,
    allowedArms,
    controlledMarkerRegistry,
  };
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
    // Outer owned route class (always admin cost-control-probe). Inner warehouse
    // route identity is projected separately via controlled-marker registry.
    route_class: OWNED_ROUTE_CLASS,
  };
  for (const key of ["cpuTime", "wallTime", "eventTimestamp"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) {
      projected[key] = raw[key];
    }
    // Missing numeric telemetry stays absent (UNKNOWN); never substitute 0/wall.
  }
  const controlled = projectOwnedControlledMarkers(raw, context);
  if (controlled) {
    Object.assign(projected, controlled);
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
  // Value checks on allowlisted controlled-marker fields (key-only is insufficient).
  if ("cohort" in record) {
    const cohort = record.cohort;
    if (cohort !== CONTROLLED_MARKER_UNKNOWN) {
      if (!isCanonicalControlledCohort(cohort) || !isSafeControlledMarkerValue(cohort)) {
        hits.push("$.cohort");
      }
    }
  }
  if ("workload_hash" in record) {
    const hash = record.workload_hash;
    if (hash !== CONTROLLED_MARKER_UNKNOWN) {
      if (!isCanonicalWorkloadHash(hash) || !isSafeControlledMarkerValue(hash)) {
        hits.push("$.workload_hash");
      }
    }
  }
  if ("arm" in record) {
    const arm = record.arm;
    if (arm !== CONTROLLED_MARKER_UNKNOWN && !isCanonicalControlledArm(arm)) {
      hits.push("$.arm");
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
