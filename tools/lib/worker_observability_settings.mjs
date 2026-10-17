import { createHash, randomUUID } from "node:crypto";
import {
  openSync, fsyncSync, closeSync, renameSync, writeFileSync, readFileSync,
  existsSync, statSync, mkdirSync, rmSync, readdirSync,
} from "node:fs";

export const WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA = "cityscroll.worker_observability_settings_window.v1";
export const WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA = "cityscroll.worker_observability_settings_receipt.v1";
export const BETA_WORKER_API_PATH = "/accounts/{account_id}/workers/workers/{worker_id}";
export const DEFAULT_WORKER_ID = "cityscroll-worker";
export const MAX_SETTINGS_WINDOW_SECONDS = 30 * 60;
export const SETTINGS_SUCCESS_STATUSES = Object.freeze([
  "ok",
  "captured",
  "privacy-armed",
  "enabled",
  "restored",
  "already-restored",
  "complete",
]);
export const TERMINAL_WINDOW_PHASES = Object.freeze([
  "restored",
  "expired-restored",
  "closed",
  "refused-conflict",
]);

/**
 * Provider beta Worker PATCH documents partial updates with omitted fields left
 * unchanged. It does not document If-Match / ETag conditional updates for
 * observability settings. This harness therefore uses window-owned
 * read-modify-write control only and never claims immunity to foreign writers.
 */
export const PROVIDER_OBSERVABILITY_CONCURRENCY = Object.freeze({
  mode: "window-owned-read-modify-write",
  provider_conditional_update: false,
  limitation: "Cloudflare beta Worker PATCH has no documented conditional update for observability settings; foreign concurrent changes can race between GET and PATCH.",
});

const PRIVACY_REQUIRED_TOP = Object.freeze([
  "enabled",
  "redact_query_string",
  "logs",
  "traces",
]);
const PRIVACY_REQUIRED_LOGS = Object.freeze([
  "enabled",
  "persist",
  "destinations",
]);
const PRIVACY_REQUIRED_TRACES = Object.freeze([
  "enabled",
  "persist",
  "destinations",
]);

function fail(message) {
  throw new Error(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") fail(`${path} must be an explicit boolean`);
  return value;
}

function requireDestinations(value, path) {
  if (value === undefined) fail(`${path} must be present`);
  if (!Array.isArray(value)) fail(`${path} must be an explicit array`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry) fail(`${path} entries must be non-empty strings`);
    return entry;
  });
}

function requirePresent(object, key, path) {
  if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${path} must be an object`);
  if (!Object.prototype.hasOwnProperty.call(object, key)) fail(`${path}.${key} must be present in the provider GET`);
  return object[key];
}

/**
 * Capture-time normalization for equality digests.
 * Preserves supported extra fields (for example traces.propagation_policy).
 * Omitted optional fields are not invented into privacy proof; callers that
 * need privacy acknowledgement must use acknowledgePrivacyFields.
 */
export function normalizeObservability(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    fail("observability settings must be an object");
  }
  const logs = settings.logs && typeof settings.logs === "object" && !Array.isArray(settings.logs)
    ? settings.logs
    : fail("observability.logs must be an object");
  const traces = settings.traces && typeof settings.traces === "object" && !Array.isArray(settings.traces)
    ? settings.traces
    : fail("observability.traces must be an object");

  const normalizedLogs = {
    enabled: logs.enabled === true,
    head_sampling_rate: logs.head_sampling_rate == null ? 1 : Number(logs.head_sampling_rate),
    persist: logs.persist === true,
    destinations: Array.isArray(logs.destinations) ? [...logs.destinations] : [],
  };
  if (Object.prototype.hasOwnProperty.call(logs, "invocation_logs")) {
    normalizedLogs.invocation_logs = logs.invocation_logs === true;
  }

  const normalizedTraces = {
    enabled: traces.enabled === true,
    head_sampling_rate: traces.head_sampling_rate == null ? 1 : Number(traces.head_sampling_rate),
    persist: traces.persist === true,
    destinations: Array.isArray(traces.destinations) ? [...traces.destinations] : [],
  };
  if (Object.prototype.hasOwnProperty.call(traces, "propagation_policy")) {
    normalizedTraces.propagation_policy = traces.propagation_policy;
  }

  return {
    enabled: settings.enabled === true,
    head_sampling_rate: settings.head_sampling_rate == null ? 1 : Number(settings.head_sampling_rate),
    redact_query_string: settings.redact_query_string === true,
    logs: normalizedLogs,
    traces: normalizedTraces,
  };
}

export function observabilitySha256(settings) {
  return createHash("sha256").update(canonicalJson(normalizeObservability(settings))).digest("hex");
}

export function observabilityEquals(left, right) {
  return observabilitySha256(left) === observabilitySha256(right);
}

/**
 * Privacy proof requires every privacy field to be explicitly present and typed
 * in the RAW provider GET. Callers must pass the provider readback before any
 * normalizeObservability step: normalization invents omit→false/[] and must
 * never be used as the enable-gate proof input.
 */
export function acknowledgePrivacyFields(settings, path = "observability") {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    fail(`${path} must be an object`);
  }
  for (const key of PRIVACY_REQUIRED_TOP) requirePresent(settings, key, path);

  const enabled = requireBoolean(settings.enabled, `${path}.enabled`);
  const redact = requireBoolean(settings.redact_query_string, `${path}.redact_query_string`);
  const logs = settings.logs;
  const traces = settings.traces;
  if (!logs || typeof logs !== "object" || Array.isArray(logs)) fail(`${path}.logs must be an object`);
  if (!traces || typeof traces !== "object" || Array.isArray(traces)) fail(`${path}.traces must be an object`);
  for (const key of PRIVACY_REQUIRED_LOGS) requirePresent(logs, key, `${path}.logs`);
  for (const key of PRIVACY_REQUIRED_TRACES) requirePresent(traces, key, `${path}.traces`);

  const logsEnabled = requireBoolean(logs.enabled, `${path}.logs.enabled`);
  const logsPersist = requireBoolean(logs.persist, `${path}.logs.persist`);
  const tracesEnabled = requireBoolean(traces.enabled, `${path}.traces.enabled`);
  const tracesPersist = requireBoolean(traces.persist, `${path}.traces.persist`);
  const logDestinations = requireDestinations(logs.destinations, `${path}.logs.destinations`);
  const traceDestinations = requireDestinations(traces.destinations, `${path}.traces.destinations`);

  if (enabled !== false) fail(`${path}.enabled must be false`);
  if (logsEnabled !== false) fail(`${path}.logs.enabled must be false`);
  if (tracesEnabled !== false) fail(`${path}.traces.enabled must be false`);
  if (redact !== true) fail(`${path}.redact_query_string must be true`);
  if (logsPersist !== false) fail(`${path}.logs.persist must be false`);
  if (tracesPersist !== false) fail(`${path}.traces.persist must be false`);
  if (logDestinations.length !== 0) fail(`${path}.logs.destinations must be empty`);
  if (traceDestinations.length !== 0) fail(`${path}.traces.destinations must be empty`);

  // Preserve the full baseline of supported settings, including extras.
  return normalizeObservability(settings);
}

export function assertPrivacyArmed(settings, path = "observability") {
  return acknowledgePrivacyFields(settings, path);
}

/** Enable-gate helper: requires the RAW provider GET body, not a normalized view. */
export function assertPrivacyArmedFromRawGet(rawSettings, path = "raw_provider_get") {
  return acknowledgePrivacyFields(rawSettings, path);
}

export function assertWindowMutable(window, now = new Date().toISOString()) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) {
    fail("settings window is invalid");
  }
  if (TERMINAL_WINDOW_PHASES.includes(window.phase)) {
    fail(`window phase ${window.phase} is closed; refuse arm/enable`);
  }
  const at = requireIso(now, "now");
  if (Date.parse(at) >= Date.parse(window.expires_at)) {
    fail("settings window has expired; refuse arm/enable and capture a fresh window");
  }
  return window;
}

export function isProcessAlive(pid) {
  return processAlive(pid);
}

export function privacyArmedObservability(baseline) {
  const current = normalizeObservability(baseline);
  if (current.enabled !== false || current.logs.enabled !== false || current.traces.enabled !== false) {
    fail("privacy arming requires observability, logs, and traces to start disabled");
  }
  const armed = {
    enabled: false,
    head_sampling_rate: current.head_sampling_rate,
    redact_query_string: true,
    logs: {
      enabled: false,
      head_sampling_rate: current.logs.head_sampling_rate,
      ...(current.logs.invocation_logs !== undefined ? { invocation_logs: current.logs.invocation_logs } : { invocation_logs: true }),
      persist: false,
      destinations: [],
    },
    traces: {
      enabled: false,
      head_sampling_rate: current.traces.head_sampling_rate,
      persist: false,
      destinations: [],
      ...(current.traces.propagation_policy !== undefined
        ? { propagation_policy: current.traces.propagation_policy }
        : {}),
    },
  };
  return acknowledgePrivacyFields(armed, "privacy_armed");
}

export function measurementWindowObservability(privacyArmed) {
  const armed = acknowledgePrivacyFields(privacyArmed, "privacy_armed");
  return normalizeObservability({
    enabled: true,
    head_sampling_rate: armed.head_sampling_rate,
    redact_query_string: true,
    logs: {
      enabled: true,
      head_sampling_rate: armed.logs.head_sampling_rate,
      invocation_logs: armed.logs.invocation_logs !== false,
      persist: false,
      destinations: [],
    },
    traces: {
      enabled: false,
      head_sampling_rate: armed.traces.head_sampling_rate,
      persist: false,
      destinations: [],
      ...(armed.traces.propagation_policy !== undefined
        ? { propagation_policy: armed.traces.propagation_policy }
        : {}),
    },
  });
}

export function assertMeasurementWindow(settings, path = "observability") {
  if (!settings || typeof settings !== "object") fail(`${path} must be an object`);
  for (const key of ["enabled", "redact_query_string", "logs", "traces"]) {
    requirePresent(settings, key, path);
  }
  requireBoolean(settings.enabled, `${path}.enabled`);
  requireBoolean(settings.redact_query_string, `${path}.redact_query_string`);
  for (const key of PRIVACY_REQUIRED_LOGS) requirePresent(settings.logs, key, `${path}.logs`);
  for (const key of PRIVACY_REQUIRED_TRACES) requirePresent(settings.traces, key, `${path}.traces`);
  requireBoolean(settings.logs.enabled, `${path}.logs.enabled`);
  requireBoolean(settings.logs.persist, `${path}.logs.persist`);
  requireBoolean(settings.traces.enabled, `${path}.traces.enabled`);
  requireBoolean(settings.traces.persist, `${path}.traces.persist`);
  requireDestinations(settings.logs.destinations, `${path}.logs.destinations`);
  requireDestinations(settings.traces.destinations, `${path}.traces.destinations`);

  const normalized = normalizeObservability(settings);
  if (normalized.enabled !== true) fail(`${path}.enabled must be true during the measurement window`);
  if (normalized.redact_query_string !== true) fail(`${path}.redact_query_string must stay true`);
  if (normalized.logs.enabled !== true) fail(`${path}.logs.enabled must be true during the measurement window`);
  if (normalized.logs.persist !== false) fail(`${path}.logs.persist must stay false`);
  if (normalized.traces.enabled !== false) fail(`${path}.traces.enabled must stay false`);
  if (normalized.traces.persist !== false) fail(`${path}.traces.persist must stay false`);
  if (normalized.logs.destinations.length !== 0 || normalized.traces.destinations.length !== 0) {
    fail(`${path} destinations must remain empty`);
  }
  return normalized;
}

export function patchBodyForObservability(settings) {
  return { observability: normalizeObservability(settings) };
}

/** Redact observability for receipts/logs: keep privacy-relevant fields, drop secrets. */
export function redactObservabilityForReceipt(observability) {
  if (observability == null) return observability;
  if (typeof observability !== "object") return { type: typeof observability };
  const logs = observability.logs && typeof observability.logs === "object" ? observability.logs : null;
  const traces = observability.traces && typeof observability.traces === "object" ? observability.traces : null;
  return {
    enabled: observability.enabled,
    head_sampling_rate: observability.head_sampling_rate,
    redact_query_string: observability.redact_query_string,
    top_keys: Object.keys(observability).sort(),
    logs: logs ? {
      enabled: logs.enabled,
      persist: logs.persist,
      invocation_logs: logs.invocation_logs,
      head_sampling_rate: logs.head_sampling_rate,
      destinations_len: Array.isArray(logs.destinations) ? logs.destinations.length : null,
      destinations_present: Object.prototype.hasOwnProperty.call(logs, "destinations"),
      keys: Object.keys(logs).sort(),
    } : logs,
    traces: traces ? {
      enabled: traces.enabled,
      persist: traces.persist,
      head_sampling_rate: traces.head_sampling_rate,
      destinations_len: Array.isArray(traces.destinations) ? traces.destinations.length : null,
      destinations_present: Object.prototype.hasOwnProperty.call(traces, "destinations"),
      propagation_policy: traces.propagation_policy ?? null,
      keys: Object.keys(traces).sort(),
    } : traces,
    issues: observability.issues ?? null,
  };
}

export function captureProviderExchange({
  method,
  url,
  httpStatus,
  success,
  requestBody = undefined,
  resultObservability = undefined,
  errors = [],
  messages = [],
} = {}) {
  return {
    method,
    url,
    http_status: httpStatus,
    success: success === true,
    content_type: "application/json",
    request_body_redacted: requestBody && typeof requestBody === "object"
      ? {
          top_keys: Object.keys(requestBody).sort(),
          observability: redactObservabilityForReceipt(requestBody.observability),
        }
      : requestBody === undefined ? undefined : null,
    result_observability_redacted: redactObservabilityForReceipt(resultObservability),
    errors: Array.isArray(errors) ? errors.map((entry) => ({
      code: entry?.code ?? null,
      message: entry?.message ?? String(entry),
    })) : [],
    messages: Array.isArray(messages) ? messages.map((entry) => ({
      code: entry?.code ?? null,
      message: entry?.message ?? String(entry),
    })) : [],
  };
}

function requireIso(value, label) {
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp`);
  return value;
}

function requirePositiveDurationSeconds(value, label) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SETTINGS_WINDOW_SECONDS) {
    fail(`${label} must be within 1..${MAX_SETTINGS_WINDOW_SECONDS} seconds`);
  }
  return seconds;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive directory lock serializing mutator and restorer against one window.
 * Stale locks whose recorded pid is dead are reaped.
 */
export async function withExclusiveDirLock(lockDir, fn, {
  timeoutMs = 15_000,
  staleMs = 120_000,
  holder = `pid:${process.pid}`,
} = {}) {
  if (typeof lockDir !== "string" || !lockDir) fail("lockDir is required");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(`${lockDir}/holder.json`, `${JSON.stringify({
        holder,
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const holderPath = `${lockDir}/holder.json`;
        if (existsSync(holderPath)) {
          const recorded = JSON.parse(readFileSync(holderPath, "utf8"));
          const age = Date.now() - Date.parse(recorded.acquired_at || 0);
          if (!processAlive(recorded.pid) || (Number.isFinite(age) && age > staleMs)) stale = true;
        } else if (!readdirSync(lockDir).length) {
          stale = true;
        }
      } catch {
        stale = true;
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) fail(`timed out waiting for window lock ${lockDir}`);
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function createFileWindowStore(path) {
  if (typeof path !== "string" || !path) fail("window store path is required");
  const lockDir = `${path}.lock`;
  const store = {
    path,
    lockDir,
    async read() {
      if (!existsSync(path)) return null;
      if ((statSync(path).mode & 0o077) !== 0) fail("window store must be mode 0600");
      return JSON.parse(readFileSync(path, "utf8"));
    },
    async write(window, { expectedWindowId = null } = {}) {
      assertWindowIdentityWritable(window, { expectedWindowId, allowTerminalWrite: true });
      const temporary = `${path}.next`;
      const payload = `${JSON.stringify(window, null, 2)}\n`;
      writeFileSync(temporary, payload, { mode: 0o600 });
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      // Best-effort directory durability is platform-specific; the file fsync
      // plus atomic rename is the durable write-ahead boundary this harness owns.
      const out = openSync(path, "r");
      try {
        fsyncSync(out);
      } finally {
        closeSync(out);
      }
    },
    async withLock(fn, options = {}) {
      return withExclusiveDirLock(lockDir, () => fn(store), options);
    },
  };
  return store;
}

export function assertWindowIdentityWritable(window, {
  expectedWindowId = null,
  allowTerminalWrite = false,
} = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) {
    fail("settings window is invalid");
  }
  if (typeof window.window_id !== "string" || !window.window_id) fail("window_id is required");
  if (expectedWindowId && window.window_id !== expectedWindowId) {
    fail("stale window identity rejected");
  }
  if (!allowTerminalWrite && TERMINAL_WINDOW_PHASES.includes(window.phase)) {
    fail(`window phase ${window.phase} is closed; reject stale lifecycle write`);
  }
  return window;
}

export function openSettingsWindow({
  baseline,
  workerId = DEFAULT_WORKER_ID,
  accountIdSha256,
  now = new Date().toISOString(),
  durationSeconds = MAX_SETTINGS_WINDOW_SECONDS,
  windowId = randomUUID(),
} = {}) {
  const capturedAt = requireIso(now, "now");
  const duration = requirePositiveDurationSeconds(durationSeconds, "durationSeconds");
  const normalizedBaseline = normalizeObservability(baseline);
  if (typeof accountIdSha256 !== "string" || !/^[a-f0-9]{64}$/.test(accountIdSha256)) {
    fail("accountIdSha256 must be a sha256 hex digest");
  }
  if (typeof workerId !== "string" || !workerId.trim()) fail("workerId is required");
  const expiresAt = new Date(Date.parse(capturedAt) + duration * 1000).toISOString();
  return {
    schema: WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA,
    window_id: windowId,
    worker_id: workerId,
    account_id_sha256: accountIdSha256,
    created_at: capturedAt,
    expires_at: expiresAt,
    duration_seconds: duration,
    phase: "captured",
    baseline_observability: normalizedBaseline,
    baseline_sha256: observabilitySha256(normalizedBaseline),
    owned_observability: null,
    owned_sha256: null,
    pending_mutation: null,
    restorer: { armed: false },
    concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    mutations: [],
  };
}

function appendMutation(window, mutation) {
  return {
    ...window,
    mutations: [...(window.mutations || []), mutation],
  };
}

export function armRestorer(window, { now = new Date().toISOString(), restorerId = randomUUID() } = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) fail("settings window is invalid");
  return {
    ...window,
    restorer: {
      armed: true,
      restorer_id: restorerId,
      armed_at: requireIso(now, "now"),
    },
  };
}

export function recordMutationIntent(window, {
  phase,
  beforeSha256,
  intendedObservability,
  now = new Date().toISOString(),
} = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) fail("settings window is invalid");
  if (!window.restorer?.armed) fail("independent restorer must be armed before any mutation intent");
  if (!["privacy_armed", "enabled"].includes(phase)) fail("mutation intent phase is invalid");
  if (typeof beforeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(beforeSha256)) {
    fail("beforeSha256 must be a sha256 hex digest");
  }
  const intended = phase === "privacy_armed"
    ? acknowledgePrivacyFields(intendedObservability, "intended")
    : assertMeasurementWindow(intendedObservability, "intended");
  const afterSha256 = observabilitySha256(intended);
  const at = requireIso(now, "now");
  return appendMutation({
    ...window,
    phase: phase === "privacy_armed" ? "intent-privacy_armed" : "intent-enabled",
    pending_mutation: {
      phase,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      intended_observability: intended,
      recorded_at: at,
      confirmed: false,
      issued: false,
      rejected: false,
    },
  }, {
    at,
    kind: "write-ahead-intent",
    phase,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
  });
}

/**
 * Mark that a provider PATCH for the pending intent was issued (or may have
 * been issued). Prestate GETs must not clear this ownership while UNKNOWN.
 */
export function markPendingMutationIssued(window, {
  now = new Date().toISOString(),
  exchange = null,
} = {}) {
  if (!window?.pending_mutation) fail("markPendingMutationIssued requires a pending mutation");
  const at = requireIso(now, "now");
  return appendMutation({
    ...window,
    pending_mutation: {
      ...window.pending_mutation,
      issued: true,
      issued_at: at,
      rejected: false,
      last_exchange_http_status: exchange?.http_status ?? null,
    },
  }, {
    at,
    kind: "pending-issued",
    after_sha256: window.pending_mutation.after_sha256,
    http_status: exchange?.http_status ?? null,
  });
}

/**
 * Explicit provider rejection (documented client error) means the PATCH was not
 * applied; the intended-after ownership may be cleared on reconcile.
 */
export function markPendingMutationRejected(window, {
  now = new Date().toISOString(),
  exchange = null,
  reason = "explicit-provider-rejection",
} = {}) {
  if (!window?.pending_mutation) fail("markPendingMutationRejected requires a pending mutation");
  const at = requireIso(now, "now");
  return appendMutation({
    ...window,
    pending_mutation: {
      ...window.pending_mutation,
      issued: false,
      rejected: true,
      rejected_at: at,
      rejection_reason: reason,
      last_exchange_http_status: exchange?.http_status ?? null,
    },
  }, {
    at,
    kind: "pending-rejected",
    reason,
    http_status: exchange?.http_status ?? null,
  });
}

export function pendingMutationIsIssued(pending) {
  return Boolean(pending?.issued) && pending?.rejected !== true;
}

export function isExplicitProviderRejection(exchange) {
  const status = Number(exchange?.http_status);
  return Number.isInteger(status) && status >= 400 && status < 500 && exchange?.success === false;
}

export function confirmOwnedSettings(window, confirmedObservability, { now = new Date().toISOString() } = {}) {
  if (!window?.pending_mutation) fail("confirmOwnedSettings requires a pending mutation");
  const pending = window.pending_mutation;
  const confirmed = pending.phase === "privacy_armed"
    ? acknowledgePrivacyFields(confirmedObservability, "confirmed")
    : assertMeasurementWindow(confirmedObservability, "confirmed");
  const confirmedSha = observabilitySha256(confirmed);
  if (confirmedSha !== pending.after_sha256) {
    fail("confirmed observability does not match the write-ahead intent digest");
  }
  const at = requireIso(now, "now");
  return appendMutation({
    ...window,
    phase: pending.phase,
    owned_observability: confirmed,
    owned_sha256: confirmedSha,
    pending_mutation: null,
  }, {
    at,
    kind: pending.phase === "privacy_armed" ? "privacy-arm-confirmed" : "enable-confirmed",
    before_sha256: pending.before_sha256,
    after_sha256: confirmedSha,
  });
}

export function classifyCurrentSettings(current, window) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) {
    fail("settings window is invalid");
  }
  const normalized = normalizeObservability(current);
  const digest = observabilitySha256(normalized);
  if (digest === window.baseline_sha256) return { class: "baseline", observability: normalized, sha256: digest };
  // Pending before/after must win over owned. After a confirmed privacy-arm the
  // owned digest equals the next enable intent's before-sha; classifying that as
  // "owned" refused the valid next owned transition as a foreign conflict.
  if (window.pending_mutation?.after_sha256 && digest === window.pending_mutation.after_sha256) {
    return { class: "pending-after", observability: normalized, sha256: digest };
  }
  if (window.pending_mutation?.before_sha256 && digest === window.pending_mutation.before_sha256) {
    return { class: "pending-before", observability: normalized, sha256: digest };
  }
  if (window.owned_sha256 && digest === window.owned_sha256) {
    return { class: "owned", observability: normalized, sha256: digest };
  }
  return { class: "conflict", observability: normalized, sha256: digest };
}

/**
 * Restore planning understands write-ahead intents:
 * - baseline => already restored
 * - owned or pending-after => restore to baseline (including unacknowledged applied mutations)
 * - pending-before => restore to baseline when the prestate is an owned intermediate
 *   (e.g. privacy-armed before enable). Baseline-side prestates classify as "baseline"
 *   first, so they never reach this branch.
 * - anything else => refuse foreign conflict
 */
export function planSettingsRestore(current, window, { now = new Date().toISOString() } = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) fail("settings window is invalid");
  const at = requireIso(now, "now");
  const expired = Date.parse(at) >= Date.parse(window.expires_at);
  const classification = classifyCurrentSettings(current, window);

  if (classification.class === "baseline") {
    return {
      action: "already-restored",
      expired,
      classification,
      patch: null,
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "already-restored",
        window_id: window.window_id,
        observed_at: at,
        expired,
        current_sha256: classification.sha256,
        baseline_sha256: window.baseline_sha256,
        owned_sha256: window.owned_sha256,
        pending_after_sha256: window.pending_mutation?.after_sha256 || null,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      },
    };
  }

  if (
    classification.class === "owned"
    || classification.class === "pending-after"
    || classification.class === "pending-before"
  ) {
    return {
      action: "restore",
      expired,
      classification,
      patch: patchBodyForObservability(window.baseline_observability),
      expected_after_sha256: window.baseline_sha256,
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "restore-planned",
        window_id: window.window_id,
        observed_at: at,
        expired,
        current_sha256: classification.sha256,
        baseline_sha256: window.baseline_sha256,
        owned_sha256: window.owned_sha256,
        pending_after_sha256: window.pending_mutation?.after_sha256 || null,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      },
    };
  }

  return {
    action: "refuse-conflict",
    expired,
    classification,
    patch: null,
    receipt: {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "restore",
      outcome: "refused-conflict",
      window_id: window.window_id,
      observed_at: at,
      expired,
      current_sha256: classification.sha256,
      baseline_sha256: window.baseline_sha256,
      owned_sha256: window.owned_sha256,
      pending_after_sha256: window.pending_mutation?.after_sha256 || null,
      reason: "effective settings changed outside this window",
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    },
  };
}

export function markWindowRestored(window, {
  now = new Date().toISOString(),
  beforeSha256,
  afterSha256,
  expired = false,
  outcome = "restored",
} = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) fail("settings window is invalid");
  const at = requireIso(now, "now");
  return appendMutation({
    ...window,
    phase: expired ? "expired-restored" : "restored",
    owned_observability: null,
    owned_sha256: null,
    pending_mutation: null,
  }, {
    at,
    kind: "restore",
    outcome,
    expired,
    before_sha256: beforeSha256 || null,
    after_sha256: afterSha256 || window.baseline_sha256,
  });
}

export function markWindowExpiry(window, { now = new Date().toISOString(), currentSha256 } = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) fail("settings window is invalid");
  const at = requireIso(now, "now");
  return {
    window: appendMutation(window, {
      at,
      kind: "expiry",
      current_sha256: currentSha256 || null,
    }),
    receipt: {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "expiry",
      outcome: "expired",
      window_id: window.window_id,
      observed_at: at,
      expired: true,
      current_sha256: currentSha256 || null,
      baseline_sha256: window.baseline_sha256,
      owned_sha256: window.owned_sha256,
      pending_after_sha256: window.pending_mutation?.after_sha256 || null,
    },
  };
}

export async function restoreSettingsWindow(window, transport, { now = new Date().toISOString() } = {}) {
  if (!transport || typeof transport.getObservability !== "function" || typeof transport.patchObservability !== "function") {
    fail("restore transport must provide getObservability and patchObservability");
  }
  const before = await transport.getObservability();
  const plan = planSettingsRestore(before, window, { now });
  if (plan.action === "already-restored") {
    return {
      ...plan,
      window: markWindowRestored(window, {
        now,
        beforeSha256: plan.classification.sha256,
        afterSha256: plan.classification.sha256,
        expired: plan.expired,
        outcome: "already-restored",
      }),
      after: plan.classification.observability,
      proved: true,
    };
  }
  if (plan.action === "refuse-conflict") {
    return {
      ...plan,
      window,
      after: plan.classification.observability,
      proved: false,
    };
  }

  await transport.patchObservability(plan.patch.observability);
  let afterRaw = await transport.getObservability();
  let after = normalizeObservability(afterRaw);
  let afterSha = observabilitySha256(after);
  let restoreVia = "beta-patch";
  let configRevertInvoked = false;
  const configRevertAvailable = typeof transport.revertObservabilityToBaseline === "function";
  let actuatorErrorCode = null;

  // Optional probe/config-revert actuator: when beta PATCH HTTP-succeeds but the
  // effective GET stays at this window's owned/pending digest, a transport may
  // expose revertObservabilityToBaseline (e.g. wrangler remove-[observability]
  // redeploy). Production beta-only transports omit this hook.
  //
  // Before any fallback: reclassify the after-readback against this exact window.
  // baseline => done; owned/pending => scoped config revert may run; FOREIGN =>
  // refuse and preserve the observed foreign state (provider atomic CAS UNKNOWN).
  // Catching and retrying the same failed beta PATCH is not an effective restore;
  // the actuator is the effective path when beta readback stays owned.
  if (afterSha !== window.baseline_sha256) {
    const afterClass = classifyCurrentSettings(after, window);
    if (afterClass.class === "conflict") {
      return {
        ...plan,
        action: "refuse-conflict",
        proved: false,
        window,
        after,
        receipt: {
          ...plan.receipt,
          outcome: "refuse-conflict",
          proved: false,
          after_sha256: afterSha,
          classification: "conflict",
          reason: "post-patch readback is foreign; config-revert refused to preserve observed foreign state",
          restore_via_attempted: "beta-patch",
          config_revert_available: configRevertAvailable,
          config_revert_invoked: false,
          ownership_preserved: true,
        },
      };
    }
    const ownedOrPending = afterClass.class === "owned"
      || afterClass.class === "pending-after"
      || afterClass.class === "pending-before";
    if (ownedOrPending && configRevertAvailable) {
      configRevertInvoked = true;
      restoreVia = "config-revert-actuator";
      try {
        await transport.revertObservabilityToBaseline(window.baseline_observability);
      } catch {
        actuatorErrorCode = "config-revert-threw";
        return {
          ...plan,
          action: "restore-readback-mismatch",
          proved: false,
          window,
          after,
          receipt: {
            ...plan.receipt,
            outcome: "restore-readback-mismatch",
            proved: false,
            after_sha256: afterSha,
            baseline_sha256: window.baseline_sha256,
            reason: "config-revert actuator threw; ownership preserved",
            restore_via_attempted: restoreVia,
            config_revert_available: true,
            config_revert_invoked: true,
            actuator_error_code: actuatorErrorCode,
            ownership_preserved: true,
          },
        };
      }
      afterRaw = await transport.getObservability();
      after = normalizeObservability(afterRaw);
      afterSha = observabilitySha256(after);
      // Re-check the actuator's own readback before declaring success.
      if (afterSha !== window.baseline_sha256) {
        const actuatorClass = classifyCurrentSettings(after, window);
        if (actuatorClass.class === "conflict") {
          return {
            ...plan,
            action: "refuse-conflict",
            proved: false,
            window,
            after,
            receipt: {
              ...plan.receipt,
              outcome: "refuse-conflict",
              proved: false,
              after_sha256: afterSha,
              classification: "conflict",
              reason: "config-revert actuator readback is foreign; foreign state preserved",
              restore_via_attempted: restoreVia,
              config_revert_available: true,
              config_revert_invoked: true,
              ownership_preserved: true,
            },
          };
        }
      }
    }
  }

  if (afterSha !== window.baseline_sha256) {
    // Do not throw: a throwing restore kills the supervised guardian loop and
    // previously left no terminal evidence. Do not collapse zero/unknown into
    // success. Ownership stays on the window for retry / actuator.
    return {
      ...plan,
      action: "restore-readback-mismatch",
      proved: false,
      window,
      after,
      receipt: {
        ...plan.receipt,
        outcome: "restore-readback-mismatch",
        proved: false,
        after_sha256: afterSha,
        baseline_sha256: window.baseline_sha256,
        reason: configRevertAvailable
          ? (configRevertInvoked
            ? "provider readback did not prove baseline after config-revert actuator"
            : "provider readback did not prove baseline restoration")
          : "beta patch readback mismatch and config-revert actuator unavailable",
        restore_via_attempted: restoreVia,
        config_revert_available: configRevertAvailable,
        config_revert_invoked: configRevertInvoked,
        actuator_error_code: actuatorErrorCode
          || (configRevertAvailable ? null : "config-revert-unavailable"),
        ownership_preserved: true,
      },
    };
  }
  return {
    ...plan,
    action: restoreVia === "config-revert-actuator" ? "restored-via-config-revert" : "restored",
    receipt: {
      ...plan.receipt,
      outcome: restoreVia === "config-revert-actuator" ? "restored-via-config-revert" : "restored",
      after_sha256: afterSha,
      restore_via: restoreVia,
      config_revert_available: configRevertAvailable,
      config_revert_invoked: configRevertInvoked,
      ownership_preserved: false,
    },
    window: markWindowRestored(window, {
      now,
      beforeSha256: plan.classification.sha256,
      afterSha256: afterSha,
      expired: plan.expired,
      outcome: restoreVia === "config-revert-actuator" ? "restored-via-config-revert" : "restored",
    }),
    after,
    proved: true,
  };
}

/**
 * Window-owned read-modify-write mutation with durable write-ahead intent.
 * Not an atomic provider CAS: see PROVIDER_OBSERVABILITY_CONCURRENCY.
 */
export async function mutateOwnedWindowObservability({
  transport,
  store,
  expectedSha256,
  nextObservability,
  phase,
  now = new Date().toISOString(),
  requireLiveRestorer = true,
  assertRestorerReady = null,
  alreadyLocked = false,
} = {}) {
  if (!transport || typeof transport.getObservability !== "function" || typeof transport.patchObservability !== "function") {
    fail("mutation transport must provide getObservability and patchObservability");
  }
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    fail("durable window store is required");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    fail("expectedSha256 must be a sha256 hex digest");
  }

  const run = async () => {
    let window = await store.read();
    if (!window) fail("settings window is missing from durable store");
    if (!window.restorer?.armed) fail("independent restorer must be armed before mutation");
    // Refuse expired/closed arm/enable before any provider GET/PATCH.
    assertWindowMutable(window, now);
    if (requireLiveRestorer) {
      if (typeof assertRestorerReady !== "function") {
        fail("live restorer readiness check is required before mutation");
      }
      assertRestorerReady(window, { now });
    }

    const windowId = window.window_id;
    const beforeRaw = await transport.getObservability();
    const before = normalizeObservability(beforeRaw);
    const beforeSha = observabilitySha256(before);
    if (beforeSha !== expectedSha256) {
      return {
        ok: false,
        reason: "settings-changed-underneath",
        before,
        before_sha256: beforeSha,
        expected_sha256: expectedSha256,
        window,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }

    // Re-read under the same lock so a concurrent restorer cannot race the intent.
    window = await store.read();
    if (!window || window.window_id !== windowId) fail("stale window identity rejected");
    assertWindowMutable(window, now);

    window = recordMutationIntent(window, {
      phase,
      beforeSha256: beforeSha,
      intendedObservability: nextObservability,
      now,
    });
    await store.write(window, { expectedWindowId: windowId });

    // Issued intent must be durably persisted (store.write fsyncs) BEFORE dispatch.
    // A hang or crash inside patchObservability otherwise leaves dispatched=true with
    // issued=false, and a prestate GET clears ownership (response loss).
    window = markPendingMutationIssued(window, { now, exchange: null });
    await store.write(window, { expectedWindowId: windowId });

    let patchError = null;
    let patchExchange = null;
    try {
      await transport.patchObservability(window.pending_mutation.intended_observability);
      patchExchange = transport.last_exchange || null;
      // Refresh exchange metadata on the already-issued intent; readback still proves ownership.
      window = markPendingMutationIssued(window, { now, exchange: patchExchange });
      await store.write(window, { expectedWindowId: windowId });
    } catch (error) {
      patchError = error;
      patchExchange = transport.last_exchange || error?.provider_exchange || null;
      if (isExplicitProviderRejection(patchExchange)) {
        window = markPendingMutationRejected(window, { now, exchange: patchExchange });
      } else {
        // Network/5xx/unknown: PATCH may have applied; keep issued ownership + exchange.
        window = markPendingMutationIssued(window, { now, exchange: patchExchange });
      }
      await store.write(window, { expectedWindowId: windowId });
    }

    let afterRaw;
    let readbackExchange = null;
    try {
      afterRaw = await transport.getObservability();
      readbackExchange = transport.last_exchange || null;
    } catch (error) {
      // Intent remains durable; restorer reconciles via a later GET.
      return {
        ok: false,
        reason: "readback-failed",
        patch_error: patchError ? String(patchError?.message || patchError) : null,
        readback_error: String(error?.message || error),
        provider_exchanges: {
          patch: patchExchange,
          readback_get: transport.last_exchange || error?.provider_exchange || null,
        },
        window,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }

    // Digests use normalization for equality; privacy/measurement confirmation
    // must see the RAW provider GET so omit-defaults cannot fabricate proof.
    const after = normalizeObservability(afterRaw);
    const afterSha = observabilitySha256(after);
    if (afterSha !== window.pending_mutation.after_sha256) {
      // PATCH may have failed or a foreign writer won the race. Leave intent for restorer.
      return {
        ok: false,
        reason: patchError ? "patch-failed-uncertain" : "readback-mismatch",
        patch_error: patchError ? String(patchError?.message || patchError) : null,
        before,
        before_sha256: beforeSha,
        after,
        after_sha256: afterSha,
        after_redacted: redactObservabilityForReceipt(afterRaw),
        expected_after_sha256: window.pending_mutation.after_sha256,
        expected_after_redacted: redactObservabilityForReceipt(window.pending_mutation.intended_observability),
        provider_exchanges: {
          patch: patchExchange,
          readback_get: readbackExchange,
        },
        window,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }

    if (patchError) {
      // Applied then threw: RAW GET proves the intended after-state.
      window = confirmOwnedSettings(window, afterRaw, { now });
      await store.write(window, { expectedWindowId: windowId });
      return {
        ok: true,
        recovered_from_patch_throw: true,
        before,
        before_sha256: beforeSha,
        after: window.owned_observability,
        after_sha256: afterSha,
        after_raw: afterRaw,
        window,
        concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
      };
    }

    window = confirmOwnedSettings(window, afterRaw, { now });
    await store.write(window, { expectedWindowId: windowId });
    return {
      ok: true,
      before,
      before_sha256: beforeSha,
      after: window.owned_observability,
      after_sha256: afterSha,
      after_raw: afterRaw,
      window,
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    };
  };

  if (alreadyLocked || typeof store.withLock !== "function") return run();
  return store.withLock(run);
}

/** @deprecated Use mutateOwnedWindowObservability; kept as a thin alias for call sites. */
export async function compareAndSwapObservability(transport, options = {}) {
  const store = options.store || {
    async read() { return options.window; },
    async write() { /* non-durable test helper */ },
  };
  return mutateOwnedWindowObservability({
    transport,
    store,
    expectedSha256: options.expectedSha256,
    nextObservability: options.nextObservability,
    phase: options.phase,
    now: options.now,
    requireLiveRestorer: options.requireLiveRestorer === true,
    assertRestorerReady: options.assertRestorerReady || null,
    alreadyLocked: options.alreadyLocked === true,
  });
}

export function windowRequiresExactLayerTransport(window) {
  return window?.script_layer?.restore_mode === SCRIPT_LAYER_RESTORE_MODE;
}

export async function runIndependentRestorer({
  store,
  transport,
  now = new Date().toISOString(),
  alreadyLocked = false,
} = {}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    fail("durable window store is required for the independent restorer");
  }
  const run = async () => {
    const window = await store.read();
    if (!window) fail("settings window is missing");
    if (!window.restorer?.armed) fail("restorer is not armed");
    const windowId = window.window_id;
    let restored;
    if (windowRequiresExactLayerTransport(window)) {
      if (typeof transport?.getDualView !== "function") {
        fail("exact-layer restore requires dual-view transport; refusing silent beta fallback");
      }
      restored = await restoreExactLayerSettingsWindow(window, transport, { now });
    } else {
      restored = await restoreSettingsWindow(window, transport, { now });
    }
    await store.write(restored.window, { expectedWindowId: windowId });
    return restored;
  };
  if (alreadyLocked || typeof store.withLock !== "function") return run();
  return store.withLock(run);
}

export function settingsCommandSucceeded(result) {
  return SETTINGS_SUCCESS_STATUSES.includes(result?.status);
}

export function betaWorkerUrl({ accountId, workerId = DEFAULT_WORKER_ID, origin = "https://api.cloudflare.com/client/v4" } = {}) {
  if (typeof accountId !== "string" || !accountId.trim()) fail("accountId is required");
  if (typeof workerId !== "string" || !workerId.trim()) fail("workerId is required");
  return `${origin}/accounts/${encodeURIComponent(accountId)}/workers/workers/${encodeURIComponent(workerId)}`;
}

export function createBetaWorkerObservabilityTransport({
  accountId,
  workerId = DEFAULT_WORKER_ID,
  token,
  fetchImpl = fetch,
  origin = "https://api.cloudflare.com/client/v4",
} = {}) {
  if (typeof token !== "string" || !token) fail("token is required");
  const url = betaWorkerUrl({ accountId, workerId, origin });
  let lastExchange = null;

  async function request(method, body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      lastExchange = captureProviderExchange({
        method,
        url,
        httpStatus: response.status,
        success: false,
        requestBody: body,
        resultObservability: null,
        errors: [{ message: `response json parse failed: ${String(error?.message || error)}` }],
      });
      fail(`beta worker settings ${method} failed with status ${response.status}`);
    }
    const observability = payload?.result?.observability;
    lastExchange = captureProviderExchange({
      method,
      url,
      httpStatus: response.status,
      success: payload?.success === true,
      requestBody: body,
      resultObservability: observability,
      errors: payload?.errors || [],
      messages: payload?.messages || [],
    });
    if (!response.ok || payload?.success !== true) {
      fail(`beta worker settings ${method} failed with status ${response.status}`);
    }
    if (!observability || typeof observability !== "object") {
      fail("beta worker settings response omitted effective observability");
    }
    return observability;
  }

  return {
    url,
    concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    get last_exchange() {
      return lastExchange;
    },
    async getObservability() {
      return request("GET");
    },
    async patchObservability(observability) {
      return request("PATCH", patchBodyForObservability(observability));
    },
  };
}

// ---------------------------------------------------------------------------
// Script-settings exact layer
// Cloudflare TypeScript SDK SettingEditParams.observability?: Observability | null
// PATCH /workers/scripts/{name}/script-settings accepts explicit null.
// ---------------------------------------------------------------------------

export const SCRIPT_SETTINGS_API_PATH = "/accounts/{account_id}/workers/scripts/{script_name}/script-settings";
export const SCRIPT_LAYER_RESTORE_MODE = "script-settings-null";
export const SCRIPT_SETTINGS_METADATA_KEYS = Object.freeze(["logpush", "tags", "tail_consumers"]);

/**
 * Preserve script-override null exactly. Never normalize null into invented defaults.
 */
export function exactScriptOverride(value, { path = "script_override" } = {}) {
  if (value === null) return null;
  if (value === undefined) fail(`${path} must be present as null or an object`);
  return normalizeObservability(value);
}

export function patchBodyForScriptSettingsObservability(observability) {
  if (observability === null) return { observability: null };
  return { observability: normalizeObservability(observability) };
}

export function redactScriptSettingsMetadata(result) {
  if (!result || typeof result !== "object") return null;
  return {
    logpush: result.logpush ?? null,
    tags: Array.isArray(result.tags) ? [...result.tags].sort() : result.tags ?? null,
    tail_consumers_len: Array.isArray(result.tail_consumers) ? result.tail_consumers.length : null,
    top_keys: Object.keys(result).sort(),
  };
}

export function scriptSettingsMetadataEquals(a, b) {
  return canonicalJson(redactScriptSettingsMetadata(a)) === canonicalJson(redactScriptSettingsMetadata(b));
}

export function scriptSettingsUrl({
  accountId,
  scriptName = DEFAULT_WORKER_ID,
  origin = "https://api.cloudflare.com/client/v4",
} = {}) {
  if (typeof accountId !== "string" || !accountId.trim()) fail("accountId is required");
  if (typeof scriptName !== "string" || !scriptName.trim()) fail("scriptName is required");
  return `${origin}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/script-settings`;
}

/**
 * JSON GET/PATCH transport for /script-settings.
 * getObservability may return null; callers must not normalize null into defaults.
 */
export function createScriptSettingsObservabilityTransport({
  accountId,
  scriptName = DEFAULT_WORKER_ID,
  token,
  fetchImpl = fetch,
  origin = "https://api.cloudflare.com/client/v4",
} = {}) {
  if (typeof token !== "string" || !token) fail("token is required");
  const url = scriptSettingsUrl({ accountId, scriptName, origin });
  let lastExchange = null;
  let lastFullResult = null;

  async function request(method, body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      lastExchange = captureProviderExchange({
        method,
        url,
        httpStatus: response.status,
        success: false,
        requestBody: body,
        resultObservability: null,
        errors: [{ message: `response json parse failed: ${String(error?.message || error)}` }],
      });
      fail(`script-settings ${method} failed with status ${response.status}`);
    }
    const result = payload?.result && typeof payload.result === "object" ? payload.result : null;
    lastFullResult = result;
    const observability = result && Object.prototype.hasOwnProperty.call(result, "observability")
      ? result.observability
      : null;
    lastExchange = captureProviderExchange({
      method,
      url,
      httpStatus: response.status,
      success: payload?.success === true,
      requestBody: body,
      resultObservability: observability,
      errors: payload?.errors || [],
      messages: payload?.messages || [],
    });
    if (!response.ok || payload?.success !== true) {
      fail(`script-settings ${method} failed with status ${response.status}`);
    }
    return { result, observability };
  }

  return {
    url,
    endpoint: "script-settings",
    concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    get last_exchange() {
      return lastExchange;
    },
    get last_full_result() {
      return lastFullResult ? structuredClone(lastFullResult) : null;
    },
    async getScriptSettings() {
      const { result } = await request("GET");
      return structuredClone(result);
    },
    async getObservability() {
      const { observability } = await request("GET");
      // Exact layer: null stays null.
      return observability === null ? null : observability;
    },
    async patchObservability(observability) {
      if (observability !== null && (typeof observability !== "object" || Array.isArray(observability))) {
        fail("script-settings patch observability must be null or an object");
      }
      const { observability: after } = await request(
        "PATCH",
        patchBodyForScriptSettingsObservability(observability),
      );
      return after === null ? null : after;
    },
  };
}

/**
 * Dual-view transport: writes go to /script-settings; effective reads use beta Worker GET.
 * Classification digests use the effective (beta) view. Restore clears the script override to null.
 */
export function createDualViewObservabilityTransport({
  scriptSettingsTransport,
  betaTransport,
} = {}) {
  if (!scriptSettingsTransport || typeof scriptSettingsTransport.patchObservability !== "function") {
    fail("scriptSettingsTransport is required");
  }
  if (!betaTransport || typeof betaTransport.getObservability !== "function") {
    fail("betaTransport is required");
  }

  return {
    endpoint: "dual-view-script-settings+beta",
    concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    get last_exchange() {
      return scriptSettingsTransport.last_exchange || betaTransport.last_exchange || null;
    },
    async getObservability() {
      // Effective view for classification / digests.
      return betaTransport.getObservability();
    },
    async patchObservability(observability) {
      return scriptSettingsTransport.patchObservability(observability);
    },
    async getDualView() {
      const scriptSettings = await scriptSettingsTransport.getScriptSettings();
      const scriptOverride = scriptSettings && Object.prototype.hasOwnProperty.call(scriptSettings, "observability")
        ? scriptSettings.observability
        : null;
      const effective = await betaTransport.getObservability();
      return {
        script_override: scriptOverride === null ? null : scriptOverride,
        script_override_is_null: scriptOverride === null,
        effective,
        effective_sha256: observabilitySha256(effective),
        script_settings_metadata: redactScriptSettingsMetadata(scriptSettings),
        script_settings_raw_top_keys: scriptSettings ? Object.keys(scriptSettings).sort() : [],
      };
    },
    async restoreScriptOverrideToNull() {
      return scriptSettingsTransport.patchObservability(null);
    },
  };
}

/**
 * Open a window whose exact script-layer baseline is null (inherit) while the
 * effective beta baseline is the normalized production object (c0a41c0a…).
 * Non-null scriptOverrideBaseline is rejected: null restore would lose the
 * exact object baseline.
 */
export function openExactLayerSettingsWindow({
  effectiveBaseline,
  scriptOverrideBaseline = null,
  workerId = DEFAULT_WORKER_ID,
  accountIdSha256,
  now = new Date().toISOString(),
  durationSeconds = MAX_SETTINGS_WINDOW_SECONDS,
  windowId = randomUUID(),
} = {}) {
  if (scriptOverrideBaseline !== null && scriptOverrideBaseline !== undefined) {
    fail("exact-layer scriptOverrideBaseline must be null; non-null baselines are unsupported");
  }
  const exactOverride = exactScriptOverride(null, { path: "scriptOverrideBaseline" });
  const window = openSettingsWindow({
    baseline: effectiveBaseline,
    workerId,
    accountIdSha256,
    now,
    durationSeconds,
    windowId,
  });
  return {
    ...window,
    script_layer: {
      endpoint: "script-settings",
      restore_mode: SCRIPT_LAYER_RESTORE_MODE,
      baseline_override: exactOverride,
      baseline_override_is_null: true,
      sdk_null_restore: true,
      sdk_ref: "cloudflare-typescript SettingEditParams.observability?: Observability | null",
    },
  };
}

/** Exact-layer windows may only restore to script-settings observability null. */
export function assertExactLayerNullBaseline(window, { path = "window.script_layer" } = {}) {
  if (!window?.script_layer || window.script_layer.restore_mode !== SCRIPT_LAYER_RESTORE_MODE) {
    fail(`${path} requires script-settings-null restore mode`);
  }
  if (window.script_layer.baseline_override !== null || window.script_layer.baseline_override_is_null !== true) {
    fail(`${path} baseline_override must remain null; refusing restore that would lose a non-null exact baseline`);
  }
}

/**
 * Classify the script-settings observability override against the window's
 * baseline / owned / pending identities. Null baseline stays exact null.
 */
export function classifyExactLayerScriptOverride(scriptOverride, window) {
  if (!window?.script_layer || window.script_layer.restore_mode !== SCRIPT_LAYER_RESTORE_MODE) {
    fail("exact-layer classification requires a script_layer window with script-settings-null mode");
  }
  const baselineOverride = Object.prototype.hasOwnProperty.call(window.script_layer, "baseline_override")
    ? window.script_layer.baseline_override
    : null;
  const baselineIsNull = baselineOverride === null;

  if (scriptOverride === null && baselineIsNull) {
    return { class: "baseline", script_override: null, sha256: null };
  }

  if (scriptOverride !== null && typeof scriptOverride === "object" && !Array.isArray(scriptOverride)) {
    const normalized = normalizeObservability(scriptOverride);
    const digest = observabilitySha256(normalized);
    if (window.pending_mutation?.after_sha256 && digest === window.pending_mutation.after_sha256) {
      return { class: "pending-after", script_override: normalized, sha256: digest };
    }
    if (window.pending_mutation?.before_sha256 && digest === window.pending_mutation.before_sha256) {
      return { class: "pending-before", script_override: normalized, sha256: digest };
    }
    if (window.owned_sha256 && digest === window.owned_sha256) {
      return { class: "owned", script_override: normalized, sha256: digest };
    }
    if (!baselineIsNull && digest === observabilitySha256(normalizeObservability(baselineOverride))) {
      return { class: "baseline", script_override: normalized, sha256: digest };
    }
    return { class: "conflict", script_override: normalized, sha256: digest };
  }

  if (scriptOverride === null && !baselineIsNull) {
    return { class: "conflict", script_override: null, sha256: null };
  }

  return { class: "conflict", script_override: scriptOverride ?? null, sha256: null };
}

function exactLayerIdentityIsOwn(classificationClass) {
  return classificationClass === "owned"
    || classificationClass === "pending-after"
    || classificationClass === "pending-before";
}

/**
 * Plan exact-layer restore against BOTH script override and effective views.
 * Foreign identity on either layer refuses without a PATCH.
 */
export function planExactLayerRestore(dualView, window, { now = new Date().toISOString() } = {}) {
  if (!window?.script_layer || window.script_layer.restore_mode !== SCRIPT_LAYER_RESTORE_MODE) {
    fail("exact-layer restore planning requires a script_layer window with script-settings-null mode");
  }
  if (!dualView || typeof dualView !== "object") fail("dual view is required for exact-layer planning");
  const at = requireIso(now, "now");
  const expired = Date.parse(at) >= Date.parse(window.expires_at);
  const scriptClassification = classifyExactLayerScriptOverride(
    dualView.script_override_is_null ? null : dualView.script_override,
    window,
  );
  const effectiveClassification = classifyCurrentSettings(dualView.effective, window);

  if (scriptClassification.class === "baseline" && effectiveClassification.class === "baseline") {
    return {
      action: "already-restored",
      expired,
      script_classification: scriptClassification,
      effective_classification: effectiveClassification,
      patch: null,
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "already-restored",
        window_id: window.window_id,
        observed_at: at,
        expired,
        restore_mode: SCRIPT_LAYER_RESTORE_MODE,
        script_override_is_null: dualView.script_override_is_null === true,
        effective_sha256: effectiveClassification.sha256,
        baseline_sha256: window.baseline_sha256,
      },
    };
  }

  // Script already at baseline null while effective is still this window's owned
  // or pending identity: script-layer null is satisfied, but effective has not
  // proved baseline. Stay nonterminal/unproved and retry; never clear ownership.
  if (scriptClassification.class === "baseline" && exactLayerIdentityIsOwn(effectiveClassification.class)) {
    return {
      action: "await-effective-baseline",
      expired,
      script_classification: scriptClassification,
      effective_classification: effectiveClassification,
      patch: null,
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "await-effective-baseline",
        window_id: window.window_id,
        observed_at: at,
        expired,
        restore_mode: SCRIPT_LAYER_RESTORE_MODE,
        script_override_is_null: true,
        effective_sha256: effectiveClassification.sha256,
        baseline_sha256: window.baseline_sha256,
        owned_sha256: window.owned_sha256,
        reason: "script override is null but effective view has not proved baseline",
      },
    };
  }

  const scriptOwn = exactLayerIdentityIsOwn(scriptClassification.class);
  const effectiveOwnOrBaseline = exactLayerIdentityIsOwn(effectiveClassification.class)
    || effectiveClassification.class === "baseline";

  if (scriptOwn && effectiveOwnOrBaseline) {
    return {
      action: "restore",
      expired,
      script_classification: scriptClassification,
      effective_classification: effectiveClassification,
      patch: { observability: null },
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "restore-planned",
        window_id: window.window_id,
        observed_at: at,
        expired,
        restore_mode: SCRIPT_LAYER_RESTORE_MODE,
        script_override_sha256: scriptClassification.sha256,
        effective_sha256: effectiveClassification.sha256,
        baseline_sha256: window.baseline_sha256,
        owned_sha256: window.owned_sha256,
      },
    };
  }

  return {
    action: "refuse-conflict",
    expired,
    script_classification: scriptClassification,
    effective_classification: effectiveClassification,
    patch: null,
    receipt: {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "restore",
      outcome: "refused-conflict",
      window_id: window.window_id,
      observed_at: at,
      expired,
      restore_mode: SCRIPT_LAYER_RESTORE_MODE,
      script_class: scriptClassification.class,
      effective_class: effectiveClassification.class,
      script_override_sha256: scriptClassification.sha256,
      effective_sha256: effectiveClassification.sha256,
      baseline_sha256: window.baseline_sha256,
      owned_sha256: window.owned_sha256,
      reason: "script override or effective settings changed outside this window",
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    },
  };
}

/**
 * Restore via PATCH {observability:null} to /script-settings and prove both views.
 * Refuses foreign script override or effective state without PATCH.
 * Other script-settings metadata (logpush/tags/tail_consumers) must stay unchanged.
 */
export async function restoreExactLayerSettingsWindow(window, dualTransport, {
  now = new Date().toISOString(),
} = {}) {
  if (!window?.script_layer || window.script_layer.restore_mode !== SCRIPT_LAYER_RESTORE_MODE) {
    fail("exact-layer restore requires a script_layer window with script-settings-null mode");
  }
  // Persisted invalid windows (non-null exact baseline) must fail before any PATCH.
  assertExactLayerNullBaseline(window);
  if (!dualTransport || typeof dualTransport.getDualView !== "function") {
    fail("exact-layer restore requires a dual-view transport");
  }
  if (typeof dualTransport.restoreScriptOverrideToNull !== "function") {
    fail("exact-layer restore requires restoreScriptOverrideToNull");
  }
  const at = requireIso(now, "now");
  const before = await dualTransport.getDualView();
  const metadataBefore = before.script_settings_metadata;
  const plan = planExactLayerRestore(before, window, { now: at });

  if (plan.action === "already-restored") {
    return {
      action: "already-restored",
      proved: true,
      expired: plan.expired,
      before,
      after: before,
      window: markWindowRestored(window, {
        now: at,
        beforeSha256: before.effective_sha256,
        afterSha256: before.effective_sha256,
        expired: plan.expired,
        outcome: "already-restored",
      }),
      metadata_unchanged: true,
      script_classification: plan.script_classification,
      effective_classification: plan.effective_classification,
      receipt: plan.receipt,
    };
  }

  if (plan.action === "await-effective-baseline") {
    return {
      action: "await-effective-baseline",
      proved: false,
      expired: plan.expired,
      before,
      after: before,
      window,
      metadata_unchanged: true,
      script_classification: plan.script_classification,
      effective_classification: plan.effective_classification,
      receipt: plan.receipt,
    };
  }

  if (plan.action === "refuse-conflict") {
    return {
      action: "refuse-conflict",
      proved: false,
      expired: plan.expired,
      before,
      after: before,
      window,
      metadata_unchanged: true,
      script_classification: plan.script_classification,
      effective_classification: plan.effective_classification,
      receipt: plan.receipt,
    };
  }

  await dualTransport.restoreScriptOverrideToNull();
  const after = await dualTransport.getDualView();
  if (!after.script_override_is_null) {
    fail("script-settings restore did not prove observability null");
  }
  if (after.effective_sha256 !== window.baseline_sha256) {
    fail("beta effective view did not prove baseline after script-settings null restore");
  }
  if (!scriptSettingsMetadataEquals(metadataBefore, after.script_settings_metadata)) {
    fail("script-settings metadata changed during null restore");
  }

  return {
    action: "restored",
    proved: true,
    expired: plan.expired,
    before,
    after,
    window: markWindowRestored(window, {
      now: at,
      beforeSha256: before.effective_sha256,
      afterSha256: after.effective_sha256,
      expired: plan.expired,
      outcome: "restored",
    }),
    metadata_unchanged: true,
    script_classification: plan.script_classification,
    effective_classification: plan.effective_classification,
    receipt: {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "restore",
      outcome: "restored",
      window_id: window.window_id,
      observed_at: at,
      restore_mode: SCRIPT_LAYER_RESTORE_MODE,
      script_override_is_null: true,
      effective_sha256: after.effective_sha256,
      baseline_sha256: window.baseline_sha256,
      metadata_unchanged: true,
    },
  };
}
