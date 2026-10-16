import { createHash, randomUUID } from "node:crypto";
import { openSync, fsyncSync, closeSync, renameSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";

export const WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA = "cityscroll.worker_observability_settings_window.v1";
export const WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA = "cityscroll.worker_observability_settings_receipt.v1";
export const BETA_WORKER_API_PATH = "/accounts/{account_id}/workers/workers/{worker_id}";
export const DEFAULT_WORKER_ID = "cityscroll-worker";
export const MAX_SETTINGS_WINDOW_SECONDS = 30 * 60;

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
  const at = requireIso(now, "now");
  if (Date.parse(at) >= Date.parse(window.expires_at)) {
    fail("settings window has expired; refuse arm/enable and capture a fresh window");
  }
  return window;
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

export function createFileWindowStore(path) {
  if (typeof path !== "string" || !path) fail("window store path is required");
  return {
    path,
    async read() {
      if (!existsSync(path)) return null;
      if ((statSync(path).mode & 0o077) !== 0) fail("window store must be mode 0600");
      return JSON.parse(readFileSync(path, "utf8"));
    },
    async write(window) {
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
  };
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
    },
  }, {
    at,
    kind: "write-ahead-intent",
    phase,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
  });
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
  if (window.owned_sha256 && digest === window.owned_sha256) {
    return { class: "owned", observability: normalized, sha256: digest };
  }
  if (window.pending_mutation?.after_sha256 && digest === window.pending_mutation.after_sha256) {
    return { class: "pending-after", observability: normalized, sha256: digest };
  }
  if (window.pending_mutation?.before_sha256 && digest === window.pending_mutation.before_sha256) {
    return { class: "pending-before", observability: normalized, sha256: digest };
  }
  return { class: "conflict", observability: normalized, sha256: digest };
}

/**
 * Restore planning understands write-ahead intents:
 * - baseline => already restored
 * - owned or pending-after => restore to baseline (including unacknowledged applied mutations)
 * - pending-before => treat as not applied; already at pre-mutation side
 * - anything else => refuse foreign conflict
 */
export function planSettingsRestore(current, window, { now = new Date().toISOString() } = {}) {
  if (!window || window.schema !== WORKER_OBSERVABILITY_SETTINGS_WINDOW_SCHEMA) fail("settings window is invalid");
  const at = requireIso(now, "now");
  const expired = Date.parse(at) >= Date.parse(window.expires_at);
  const classification = classifyCurrentSettings(current, window);

  if (classification.class === "baseline" || classification.class === "pending-before") {
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

  if (classification.class === "owned" || classification.class === "pending-after") {
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
  const afterRaw = await transport.getObservability();
  const after = normalizeObservability(afterRaw);
  const afterSha = observabilitySha256(after);
  if (afterSha !== window.baseline_sha256) {
    fail("provider readback did not prove baseline restoration");
  }
  return {
    ...plan,
    action: "restored",
    receipt: {
      ...plan.receipt,
      outcome: "restored",
      after_sha256: afterSha,
    },
    window: markWindowRestored(window, {
      now,
      beforeSha256: plan.classification.sha256,
      afterSha256: afterSha,
      expired: plan.expired,
      outcome: "restored",
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

  let window = await store.read();
  if (!window) fail("settings window is missing from durable store");
  if (!window.restorer?.armed) fail("independent restorer must be armed before mutation");
  // Refuse expired arm/enable before any provider GET/PATCH.
  assertWindowMutable(window, now);

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

  window = recordMutationIntent(window, {
    phase,
    beforeSha256: beforeSha,
    intendedObservability: nextObservability,
    now,
  });
  await store.write(window);

  let patchError = null;
  try {
    await transport.patchObservability(window.pending_mutation.intended_observability);
  } catch (error) {
    patchError = error;
  }

  let afterRaw;
  try {
    afterRaw = await transport.getObservability();
  } catch (error) {
    // Intent remains durable; restorer reconciles via a later GET.
    return {
      ok: false,
      reason: "readback-failed",
      patch_error: patchError ? String(patchError?.message || patchError) : null,
      readback_error: String(error?.message || error),
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
      expected_after_sha256: window.pending_mutation.after_sha256,
      window,
      concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    };
  }

  if (patchError) {
    // Applied then threw: RAW GET proves the intended after-state.
    window = confirmOwnedSettings(window, afterRaw, { now });
    await store.write(window);
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
  await store.write(window);
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
  });
}

export async function runIndependentRestorer({ store, transport, now = new Date().toISOString() } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    fail("durable window store is required for the independent restorer");
  }
  const window = await store.read();
  if (!window) fail("settings window is missing");
  if (!window.restorer?.armed) fail("restorer is not armed");
  const restored = await restoreSettingsWindow(window, transport, { now });
  await store.write(restored.window);
  return restored;
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

  async function request(method, body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok || payload?.success !== true) {
      fail(`beta worker settings ${method} failed with status ${response.status}`);
    }
    const observability = payload?.result?.observability;
    if (!observability || typeof observability !== "object") {
      fail("beta worker settings response omitted effective observability");
    }
    return observability;
  }

  return {
    url,
    concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    async getObservability() {
      return request("GET");
    },
    async patchObservability(observability) {
      return request("PATCH", patchBodyForObservability(observability));
    },
  };
}
