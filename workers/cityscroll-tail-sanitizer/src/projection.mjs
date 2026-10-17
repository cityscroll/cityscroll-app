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
 * Positive control: TraceItem-shaped object with a lazy cpuTime getter
 * (models workerd JSG lazy getters; Object.keys will not list it).
 */
export function makeLazyCpuTraceItem({
  cpuTime = 7,
  wallTime = 12,
  outcome = "ok",
  eventType = "fetch",
  scheduledTimeMs = 1_700_000_000_000,
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
      return { id: "local-positive-control" };
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
 * True only for objects that look like Tail invocation events.
 * Rejects null, banners, and empty {}.
 */
export function isValidatedTailEventShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  let outcome;
  let event;
  try {
    outcome = obj.outcome ?? obj.Outcome;
  } catch {
    outcome = undefined;
  }
  try {
    event = obj.event ?? obj.Event;
  } catch {
    event = undefined;
  }
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
      top_keys_len: obj && typeof obj === "object" ? Object.keys(obj).length : 0,
    };
  }
  let cpuTime;
  try {
    cpuTime = obj.cpuTime;
    if (cpuTime === undefined && Object.prototype.hasOwnProperty.call(obj, "CpuTime")) {
      cpuTime = obj.CpuTime;
    }
  } catch {
    cpuTime = "throw";
  }
  const cpuClass = classifyCpuValue(cpuTime === "throw" ? undefined : cpuTime);
  let outcomeRaw;
  try {
    outcomeRaw = obj.outcome ?? obj.Outcome;
  } catch {
    outcomeRaw = undefined;
  }
  let event;
  try {
    event = obj.event ?? obj.Event;
  } catch {
    event = undefined;
  }
  let eventType = "unknown";
  if (event && typeof event === "object") {
    if ("request" in event) eventType = "fetch";
    else if ("cron" in event || "scheduledTime" in event) eventType = "scheduled";
    else if ("queue" in event || "batchSize" in event) eventType = "queue";
    else eventType = "other";
  }
  let wallTime = null;
  try {
    const w = obj.wallTime;
    if (typeof w === "number" && Number.isFinite(w)) wallTime = w;
  } catch {
    wallTime = null;
  }

  return {
    accepted: true,
    cpuTime: typeof cpuTime === "number" && Number.isFinite(cpuTime) ? cpuTime : null,
    cpu_class: cpuClass,
    wallTime,
    outcome: ALLOWED_OUTCOMES.has(outcomeRaw) ? outcomeRaw : (outcomeRaw == null ? null : "other"),
    eventType,
    // Intentionally omit URL, headers, query, body, logs, rayId, scriptVersion.
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

/** Serialize a projected delta for sink apply; strips any accidental forbidden keys. */
export function serializeAllowlistedDelta(projected) {
  if (!projected || projected.accepted !== true) {
    return { accepted: false, reason: projected?.reason || "not_accepted" };
  }
  return {
    accepted: true,
    cpuTime: projected.cpuTime,
    cpu_class: projected.cpu_class,
    wallTime: projected.wallTime,
    outcome: projected.outcome,
    eventType: projected.eventType,
  };
}
