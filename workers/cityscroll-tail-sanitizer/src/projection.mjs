/**
 * Positive-allowlist Tail event projection for cityscroll-tail-sanitizer.
 * Validates event shape before any persistence. Never substitutes wall time for CPU.
 * Drops URLs, query strings, headers, bodies, and identifiers from the projection.
 */

export const CPU_CLASSES = Object.freeze([
  "undefined",
  "null",
  "nan",
  "zero",
  "positive",
  "negative",
  "nonfinite",
  "type_other",
]);

export const ALLOWED_OUTCOMES = new Set([
  "ok",
  "canceled",
  "exception",
  "unknown",
  "kill",
  "exceededCpu",
  "exceededMemory",
  "loadShed",
  "responseStreamDisconnected",
  "scriptStartupFailed",
]);

/** Keys that must never appear on a persisted aggregate delta. */
export const FORBIDDEN_PERSIST_KEYS = Object.freeze([
  "url",
  "headers",
  "query",
  "body",
  "authorization",
  "cookie",
  "rayId",
  "scriptVersion",
  "cf",
  "request",
  "logs",
  "exceptions",
  "diagnosticsChannelEvents",
]);

/**
 * Incremental NDJSON framer: feed chunks; emit only complete lines.
 * Incomplete trailing fragments stay buffered.
 */
export function createNdjsonFramer() {
  let buf = "";
  return {
    push(chunk) {
      buf += String(chunk ?? "");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      return lines.filter((line) => line.trim().length > 0);
    },
    flush() {
      const rest = buf;
      buf = "";
      return rest.trim().length ? [rest] : [];
    },
    buffered() {
      return buf;
    },
  };
}

export function classifyCpuValue(cpuTime) {
  if (cpuTime === undefined) return "undefined";
  if (cpuTime === null) return "null";
  if (typeof cpuTime === "number" && Number.isNaN(cpuTime)) return "nan";
  if (typeof cpuTime !== "number") return "type_other";
  if (!Number.isFinite(cpuTime)) return "nonfinite";
  if (cpuTime === 0) return "zero";
  if (cpuTime > 0) return "positive";
  return "negative";
}

/**
 * Fixed allowlisted comparison cohorts. Keys are the only ones that may be
 * persisted. RUM is ONE weighted batch cohort (16 observations), not 16 routes.
 * Search, nearby, cold-start flag partitions, and collector stay UNKNOWN
 * (count 0) until an allowlisted cohort tag is present — never derived from
 * URL/query/request identity.
 */
export const RUM_BATCH_OBSERVATION_COUNT = 16;
export const RUM_BATCH_COHORT_KEY = "rum_batch_16";

export const FIXED_COHORT_KEYS = Object.freeze([
  "http",
  RUM_BATCH_COHORT_KEY,
  "search",
  "nearby",
  "cold_start_flag_raw_0",
  "cold_start_flag_raw_1",
  "cold_start_unknown",
  "cron_0800",
  "cron_1000",
  "cron_1300",
  "cron_unknown",
  "queue",
  "collector",
  "unknown",
]);

const FIXED_COHORT_SET = new Set(FIXED_COHORT_KEYS);

/** Known production cron expressions → fixed cohort keys. */
export const KNOWN_CRON_TO_COHORT = Object.freeze({
  "0 8 * * *": "cron_0800",
  "0 10 * * *": "cron_1000",
  "0 13 * * *": "cron_1300",
});

export function mapFixedCohort({ eventType = null, cron = null, cohort = null } = {}) {
  if (typeof cohort === "string" && FIXED_COHORT_SET.has(cohort)) return cohort;
  if (typeof cron === "string" && KNOWN_CRON_TO_COHORT[cron]) return KNOWN_CRON_TO_COHORT[cron];
  if (eventType === "scheduled") return "cron_unknown";
  if (eventType === "queue") return "queue";
  if (eventType === "fetch") return "http";
  return "unknown";
}

export function mapPersistedOutcome(outcome) {
  if (outcome == null) return "null";
  if (ALLOWED_OUTCOMES.has(outcome)) return outcome;
  return "other";
}

export function parseExpectedRevisionAllowlist(raw) {
  const set = new Set();
  if (typeof raw !== "string" || !raw.trim()) return set;
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id) set.add(id);
  }
  return set;
}

/**
 * Persist only configured expected-version ids. Missing allowlist or unknown
 * revision → "unknown"; present but not allowlisted → "other".
 */
export function mapPersistedRevision(revision, expectedSet) {
  if (typeof revision !== "string" || revision.length === 0) return "unknown";
  if (!(expectedSet instanceof Set) || expectedSet.size === 0) return "unknown";
  if (expectedSet.has(revision)) return revision;
  return "other";
}

/**
 * Positive control: TraceItem-shaped object with a lazy cpuTime getter.
 * Local fixture only — not a claim about provider property enumerability.
 */
export function makeLazyCpuTraceItem({
  cpuTime = 7,
  wallTime = 12,
  outcome = "ok",
  eventType = "fetch",
  scheduledTimeMs = 1_700_000_000_000,
  scriptVersionId = "local-positive-control",
} = {}) {
  const event =
    eventType === "fetch" ? { request: { cf: {}, url: "https://example.invalid/secret?token=abc" } }
      : eventType === "scheduled" ? { cron: "* * * * *", scheduledTime: scheduledTimeMs }
        : eventType === "queue" ? { queue: "q", batchSize: 1 }
          : {};
  const item = {
    outcome,
    event,
    get wallTime() {
      return wallTime;
    },
    get scriptVersion() {
      return { id: scriptVersionId };
    },
  };
  Object.defineProperty(item, "cpuTime", {
    enumerable: false,
    configurable: true,
    get() {
      return cpuTime;
    },
  });
  return item;
}

/**
 * Local getter-only TraceItem fixture: outcome/event/cpuTime/wallTime/
 * scriptVersion are non-enumerable getters. This exercises semantic property
 * reads; it is not provider enumerability proof.
 */
export function makeGetterOnlyTraceItem({
  cpuTime = 5,
  wallTime = 8,
  outcome = "ok",
  eventType = "fetch",
  scheduledTimeMs = 1_700_000_000_000,
  scriptVersionId = "getter-only-revision",
  throwOn = null,
} = {}) {
  const event =
    eventType === "fetch" ? { request: { cf: {}, url: "https://example.invalid/secret?token=abc" } }
      : eventType === "scheduled" ? { cron: "* * * * *", scheduledTime: scheduledTimeMs }
        : eventType === "queue" ? { queue: "q", batchSize: 1 }
          : {};
  const item = {};
  const defineGetter = (key, value) => {
    Object.defineProperty(item, key, {
      enumerable: false,
      configurable: true,
      get() {
        if (throwOn === key) throw new Error(`getter-throw:${key}`);
        return value;
      },
    });
  };
  defineGetter("outcome", outcome);
  defineGetter("event", event);
  defineGetter("cpuTime", cpuTime);
  defineGetter("wallTime", wallTime);
  defineGetter("scriptVersion", { id: scriptVersionId });
  return item;
}

/**
 * True only for objects that look like Tail invocation events.
 * Validates by semantic guarded property reads — never by Object.keys length.
 * Empty {} fails because outcome and event are absent. A throwing getter is
 * treated as UNKNOWN / invalid (not accepted).
 */
export function isValidatedTailEventShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  let outcome;
  let event;
  let outcomeThrown = false;
  let eventThrown = false;
  try {
    outcome = obj.outcome ?? obj.Outcome;
  } catch {
    outcomeThrown = true;
    outcome = undefined;
  }
  try {
    event = obj.event ?? obj.Event;
  } catch {
    eventThrown = true;
    event = undefined;
  }
  // Throwing getters cannot prove invocation shape — UNKNOWN / invalid.
  if (outcomeThrown || eventThrown) return false;
  const hasOutcome = typeof outcome === "string" && outcome.length > 0;
  const hasEvent = event != null && typeof event === "object" && !Array.isArray(event);
  return hasOutcome || hasEvent;
}

/**
 * Project a Tail item onto the positive allowlist only.
 * Never copies URL, headers, query, body, or identifiers into the result.
 */
export function projectAllowlistedTailEvent(obj) {
  if (!isValidatedTailEventShape(obj)) {
    return {
      accepted: false,
      reason: "not_validated_tail_event_shape",
      // Enumeration length is diagnostic only and must not gate acceptance.
      top_keys_len: obj && typeof obj === "object" ? Object.keys(obj).length : 0,
    };
  }
  let cpuTime;
  let cpuThrown = false;
  try {
    cpuTime = obj.cpuTime;
    if (cpuTime === undefined && Object.prototype.hasOwnProperty.call(obj, "CpuTime")) {
      cpuTime = obj.CpuTime;
    }
  } catch {
    cpuThrown = true;
    cpuTime = undefined;
  }
  // Throwing cpuTime getter → UNKNOWN class (never invent CPU0).
  const cpuClass = cpuThrown ? "undefined" : classifyCpuValue(cpuTime);
  let outcomeRaw;
  try {
    outcomeRaw = obj.outcome ?? obj.Outcome;
  } catch {
    // Should not reach here after isValidatedTailEventShape, but stay fail-closed.
    return { accepted: false, reason: "outcome_getter_unknown" };
  }
  let event;
  try {
    event = obj.event ?? obj.Event;
  } catch {
    return { accepted: false, reason: "event_getter_unknown" };
  }
  let eventType = "unknown";
  let cron = null;
  if (event && typeof event === "object") {
    if ("request" in event) eventType = "fetch";
    else if ("cron" in event || "scheduledTime" in event) {
      eventType = "scheduled";
      if (typeof event.cron === "string" && KNOWN_CRON_TO_COHORT[event.cron]) {
        cron = event.cron;
      }
    } else if ("queue" in event || "batchSize" in event) eventType = "queue";
    else eventType = "other";
  }
  let wallTime = null;
  try {
    const w = obj.wallTime;
    if (typeof w === "number" && Number.isFinite(w)) wallTime = w;
  } catch {
    wallTime = null;
  }
  let deployedRevision = null;
  try {
    const sv = obj.scriptVersion ?? obj.ScriptVersion;
    if (sv && typeof sv === "object" && typeof sv.id === "string" && sv.id.length > 0) {
      deployedRevision = sv.id;
    }
  } catch {
    deployedRevision = null;
  }

  const cohort = mapFixedCohort({ eventType, cron, cohort: null });

  return {
    accepted: true,
    cpuTime: (!cpuThrown && typeof cpuTime === "number" && Number.isFinite(cpuTime)) ? cpuTime : null,
    cpu_class: cpuClass,
    cpu_unknown: cpuThrown || !(typeof cpuTime === "number" && Number.isFinite(cpuTime)),
    wallTime,
    outcome: ALLOWED_OUTCOMES.has(outcomeRaw) ? outcomeRaw : (outcomeRaw == null ? null : "other"),
    eventType,
    cron,
    cohort,
    deployed_revision: deployedRevision,
    // Intentionally omit URL, headers, query, body, logs, rayId.
  };
}

/**
 * Parse one NDJSON line: complete JSON only; reject non-events.
 */
export function projectNdjsonLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ok: false, reason: "json_parse_error" };
  }
  if (obj === null || typeof obj !== "object") {
    return { ok: false, reason: "not_object" };
  }
  const projected = projectAllowlistedTailEvent(obj);
  if (!projected.accepted) {
    return { ok: false, reason: projected.reason, top_keys_len: projected.top_keys_len };
  }
  return { ok: true, projected };
}

/** Fixed allowlisted CPU-ms histogram buckets for aggregate A1-style sums. */
export const CPU_MS_BUCKETS = Object.freeze([
  "0",
  "0_1",
  "1_10",
  "10_100",
  "100_1000",
  "1000_plus",
]);

export function cpuMsBucket(cpuTime) {
  if (typeof cpuTime !== "number" || !Number.isFinite(cpuTime) || cpuTime < 0) return null;
  if (cpuTime === 0) return "0";
  if (cpuTime <= 1) return "0_1";
  if (cpuTime <= 10) return "1_10";
  if (cpuTime <= 100) return "10_100";
  if (cpuTime <= 1000) return "100_1000";
  return "1000_plus";
}

/** Serialize a projected delta for sink apply; strips any accidental forbidden keys. */
export function serializeAllowlistedDelta(projected) {
  if (!projected || projected.accepted !== true) {
    return { accepted: false, reason: projected?.reason || "not_accepted" };
  }
  const cohort = mapFixedCohort({
    eventType: projected.eventType,
    cron: projected.cron,
    cohort: projected.cohort,
  });
  return {
    accepted: true,
    cpuTime: projected.cpuTime,
    cpu_class: projected.cpu_class,
    cpu_unknown: projected.cpu_unknown === true,
    wallTime: projected.wallTime,
    outcome: projected.outcome,
    eventType: projected.eventType,
    cron: typeof projected.cron === "string" && KNOWN_CRON_TO_COHORT[projected.cron]
      ? projected.cron
      : null,
    cohort,
    deployed_revision: typeof projected.deployed_revision === "string"
      ? projected.deployed_revision
      : null,
  };
}
