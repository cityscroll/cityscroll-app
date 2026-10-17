import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync,
  renameSync, chmodSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const INSTALL_MANIFEST_SCHEMA = "cityscroll.observability_restorer_install_manifest.v1";

import {
  TERMINAL_WINDOW_PHASES,
  WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
  armRestorer,
  classifyCurrentSettings,
  confirmOwnedSettings,
  createFileWindowStore,
  isProcessAlive,
  pendingMutationIsIssued,
  runIndependentRestorer,
} from "./worker_observability_settings.mjs";

export const RESTORER_RUNTIME_SCHEMA = "cityscroll.worker_observability_restorer_runtime.v1";
export const RESTORER_READY_SCHEMA = "cityscroll.worker_observability_restorer_ready.v1";
export const DEFAULT_RESTORER_STATE_ROOT = join(
  process.env.HOME || "",
  ".local/state/cityscroll-cost-control/observability-restorer",
);
export const DEFAULT_HEARTBEAT_MAX_AGE_MS = 30_000;
export const DEFAULT_POLL_MS = 1_000;

function fail(message) {
  throw new Error(message);
}

function fsyncWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporary, payload, { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const out = openSync(path, "r");
  try { fsyncSync(out); } finally { closeSync(out); }
  chmodSync(path, 0o600);
}

export const RESTORER_PROCESS_EXIT_SCHEMA = "cityscroll.worker_observability_restorer_process_exit.v1";
export const RESTORER_GUARDIAN_FAILURE_SCHEMA = "cityscroll.worker_observability_restorer_guardian_failure.v1";
export const RESTORER_LOG_BYTE_CAP = 16 * 1024;

/**
 * Fixed diagnostic codes allowed on durable guardian receipts / coded log lines.
 * Free-form stderr, provider bodies, and stacks are never persisted.
 */
export const RESTORER_DIAGNOSTIC_CODES = Object.freeze([
  "ready",
  "heartbeat",
  "terminal",
  "process-exit",
  "spawn-error",
  "tick-throw",
  "uncaught-exception",
  "unhandled-rejection",
  "restore-readback-mismatch",
  "await-effective-baseline",
  "refuse-conflict",
  "config-revert-invoked",
  "config-revert-unavailable",
  "config-revert-threw",
  "actuator-foreign-preserved",
  "ownership-preserved",
  "guardian-actuator-failure",
]);

/** Finite approved fields permitted on guardian failure / coded diagnostic receipts. */
export const RESTORER_DIAGNOSTIC_FIELD_KEYS = Object.freeze([
  "code",
  "stage",
  "window_id",
  "restorer_id",
  "pid",
  "exit_code",
  "signal",
  "proved",
  "ownership_preserved",
  "pending_retained",
  "ownership_unknown",
  "after_sha256",
  "baseline_sha256",
  "owned_sha256",
  "classification",
  "restore_via_attempted",
  "config_revert_available",
  "config_revert_invoked",
  "actuator_error_code",
  "error_name",
  "survived",
  "controller_death",
  "cancel_requested",
  "expired",
]);

/**
 * Finite enum for durable error_name fields. Custom Error.name values (including
 * secret-bearing ones) collapse to "unknown" so they never persist as-is.
 */
export const RESTORER_KNOWN_ERROR_NAMES = Object.freeze([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
  "AssertionError",
  "SystemError",
]);

const DIAGNOSTIC_CODE_SET = new Set(RESTORER_DIAGNOSTIC_CODES);
const DIAGNOSTIC_FIELD_SET = new Set(RESTORER_DIAGNOSTIC_FIELD_KEYS);
const KNOWN_ERROR_NAME_SET = new Set(RESTORER_KNOWN_ERROR_NAMES);
const SECRET_LIKE_LINE_RE = /authorization\s*:|bearer\s+[a-z0-9._-]+|api[_-]?token\s*[:=]|CLOUDFLARE_API_TOKEN\s*=/i;
const CODED_DIAGNOSTIC_LINE_RE = /^restorer:code=([a-z0-9-]+)((?:\s+[a-z_][a-z0-9_]*=[A-Za-z0-9._:@+-]{1,128})*)\s*$/;

/** Map any thrown name to the finite enum or the fixed sentinel "unknown". */
export function mapRestorerErrorName(name) {
  const raw = String(name ?? "");
  if (KNOWN_ERROR_NAME_SET.has(raw)) return raw;
  return "unknown";
}

export function restorerPaths(stateRoot = DEFAULT_RESTORER_STATE_ROOT) {
  return {
    root: stateRoot,
    killSwitch: join(stateRoot, "observability-restorer.off"),
    pidFile: join(stateRoot, "restorer.pid"),
    startReceipt: join(stateRoot, "receipts/start.json"),
    readyReceipt: join(stateRoot, "receipts/ready.json"),
    heartbeatReceipt: join(stateRoot, "receipts/heartbeat.json"),
    terminalReceipt: join(stateRoot, "receipts/terminal.json"),
    controllerDeathReceipt: join(stateRoot, "receipts/controller-death.json"),
    processExitReceipt: join(stateRoot, "receipts/process-exit.json"),
    tickFailureReceipt: join(stateRoot, "receipts/tick-failure.json"),
    guardianFailureReceipt: join(stateRoot, "receipts/guardian-failure.json"),
    assignedWindow: join(stateRoot, "assigned-window.json"),
    durableRunner: join(stateRoot, "run.mjs"),
    durableLibDir: join(stateRoot, "lib"),
    installManifest: join(stateRoot, "install-manifest.json"),
    logsDir: join(stateRoot, "logs"),
    diagnosticLog: join(stateRoot, "logs/restorer.diagnostic.log"),
  };
}

function finiteDiagnosticValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  if (!value || value.length > 128) return null;
  if (SECRET_LIKE_LINE_RE.test(value)) return null;
  if (!/^[A-Za-z0-9._:@+-]+$/.test(value)) return null;
  return value;
}

/**
 * Build one allowlisted coded diagnostic line. Returns "" when code/fields
 * are not approved. Never embeds raw stacks, bodies, or free-form text.
 */
export function formatRestorerDiagnosticLine(code, fields = {}) {
  if (!DIAGNOSTIC_CODE_SET.has(code)) return "";
  const parts = [`restorer:code=${code}`];
  for (const key of Object.keys(fields || {}).sort()) {
    if (!DIAGNOSTIC_FIELD_SET.has(key) || key === "code") continue;
    const rendered = finiteDiagnosticValue(fields[key]);
    if (rendered === null) continue;
    parts.push(`${key}=${rendered}`);
  }
  return `${parts.join(" ")}\n`;
}

/**
 * Positive-allowlist filter applied BEFORE any durable restorer log write.
 * Only `restorer:code=<allowlisted> key=value...` lines persist.
 */
export function filterRestorerDiagnosticChunk(chunk) {
  const text = String(chunk ?? "");
  if (!text) return "";
  const kept = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (SECRET_LIKE_LINE_RE.test(rawLine)) continue;
    const match = CODED_DIAGNOSTIC_LINE_RE.exec(rawLine.trim());
    if (!match) continue;
    const code = match[1];
    if (!DIAGNOSTIC_CODE_SET.has(code)) continue;
    const fields = {};
    const pairs = match[2].trim();
    if (pairs) {
      for (const token of pairs.split(/\s+/)) {
        const eq = token.indexOf("=");
        if (eq <= 0) continue;
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        if (!DIAGNOSTIC_FIELD_SET.has(key)) continue;
        const rendered = finiteDiagnosticValue(value);
        if (rendered === null) continue;
        fields[key] = rendered;
      }
    }
    const rebuilt = formatRestorerDiagnosticLine(code, fields);
    if (rebuilt) kept.push(rebuilt.trimEnd());
  }
  if (kept.length === 0) return "";
  return `${kept.join("\n")}\n`;
}

/**
 * Append allowlisted diagnostic text with an enforced on-disk byte cap.
 * Existing file bytes are re-filtered BEFORE concatenation so a legacy raw
 * log cannot be re-persisted. Oldest bytes are dropped when over byteCap.
 */
export function appendBoundedRestorerLog(logPath, chunk, { byteCap = RESTORER_LOG_BYTE_CAP } = {}) {
  const filteredNew = filterRestorerDiagnosticChunk(chunk);
  const hadFile = existsSync(logPath);
  const existingRaw = hadFile ? readFileSync(logPath).toString("utf8") : "";
  // Re-filter legacy bytes every write so unfiltered secrets are scrubbed.
  const existingFiltered = filterRestorerDiagnosticChunk(existingRaw);
  const nextText = `${existingFiltered}${filteredNew}`;
  if (!nextText) {
    if (hadFile && existingRaw && !existingFiltered) {
      // Scrub a file that contained only disallowed bytes.
      writeFileSync(logPath, "", { mode: 0o600 });
      return { written: true, bytes: 0, scrubbed_existing: true };
    }
    return { written: false, bytes: hadFile ? Buffer.byteLength(existingFiltered) : 0 };
  }
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  let next = Buffer.from(nextText, "utf8");
  if (next.length > byteCap) {
    // Cap after filtering; re-filter the truncated slice so a mid-line cut
    // cannot reintroduce a partial raw secret line.
    next = Buffer.from(
      filterRestorerDiagnosticChunk(next.subarray(next.length - byteCap).toString("utf8")),
      "utf8",
    );
  }
  writeFileSync(logPath, next, { mode: 0o600 });
  return {
    written: true,
    bytes: next.length,
    scrubbed_existing: hadFile && existingRaw !== existingFiltered,
  };
}

/**
 * Write one coded diagnostic line under the byte cap. No raw tee.
 */
export function writeRestorerDiagnostic(stateRoot, code, fields = {}) {
  const line = formatRestorerDiagnosticLine(code, fields);
  if (!line) return { written: false, bytes: 0 };
  const paths = restorerPaths(stateRoot);
  return appendBoundedRestorerLog(paths.diagnosticLog, line);
}

/**
 * Guardian-owned failure receipt written at the failure site (not by a parent
 * exit listener). Only allowlisted codes and finite approved fields are kept.
 * Ownership / UNKNOWN flags are explicit so unacknowledged writes stay owned.
 */
export function writeGuardianFailureReceipt(stateRoot, {
  code,
  stage,
  windowId = null,
  restorerId = null,
  fields = {},
} = {}) {
  if (!DIAGNOSTIC_CODE_SET.has(code)) fail(`guardian failure code not allowlisted: ${code}`);
  const paths = restorerPaths(stateRoot);
  mkdirSync(join(paths.root, "receipts"), { recursive: true, mode: 0o700 });
  const approved = {};
  for (const key of Object.keys(fields || {})) {
    if (!DIAGNOSTIC_FIELD_SET.has(key)) continue;
    let value = fields[key];
    if (key === "error_name") {
      approved[key] = mapRestorerErrorName(value);
      continue;
    }
    if (value === null || typeof value === "boolean") {
      approved[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      approved[key] = value;
      continue;
    }
    const rendered = finiteDiagnosticValue(value);
    if (rendered !== null) approved[key] = rendered;
  }
  const receipt = writeRestorerReceipt(paths.guardianFailureReceipt, {
    schema: RESTORER_GUARDIAN_FAILURE_SCHEMA,
    kind: "guardian-failure",
    observed_at: new Date().toISOString(),
    pid: process.pid,
    window_id: windowId,
    restorer_id: restorerId,
    code,
    stage: stage || null,
    ...approved,
  });
  writeRestorerDiagnostic(stateRoot, code, {
    stage: stage || undefined,
    window_id: windowId || undefined,
    restorer_id: restorerId || undefined,
    proved: approved.proved,
    ownership_preserved: approved.ownership_preserved,
    config_revert_available: approved.config_revert_available,
    config_revert_invoked: approved.config_revert_invoked,
    restore_via_attempted: approved.restore_via_attempted,
    actuator_error_code: approved.actuator_error_code,
    after_sha256: approved.after_sha256,
    baseline_sha256: approved.baseline_sha256,
  });
  return receipt;
}

/**
 * Bounded, already-filtered log excerpt for receipts. Truncates to the byte
 * cap from the end (defense in depth; writers must allowlist at write time).
 */
export function readBoundedRestorerLogTail(path, { byteCap = RESTORER_LOG_BYTE_CAP } = {}) {
  if (!existsSync(path)) return { present: false, bytes: 0, truncated: false, text: "" };
  const raw = readFileSync(path);
  const truncated = raw.length > byteCap;
  const slice = truncated ? raw.subarray(raw.length - byteCap) : raw;
  // Re-filter so a pre-allowlist file cannot surface raw content via receipts.
  const text = filterRestorerDiagnosticChunk(slice.toString("utf8"));
  return { present: true, bytes: raw.length, truncated, text };
}

/**
 * Child-side evidence handlers. Parent spawn uses stdio:ignore; the parent
 * exit listener cannot supply receipts after the parent dies, so the guardian
 * writes its own coded process-exit / failure receipts. Raw stdout/stderr are
 * never teed to disk.
 */
export function installRestorerProcessEvidenceHandlers(stateRoot = DEFAULT_RESTORER_STATE_ROOT, {
  windowId = null,
} = {}) {
  const paths = restorerPaths(stateRoot);
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.root, "receipts"), { recursive: true, mode: 0o700 });

  let exitReceiptWritten = false;
  const writeExit = (fields) => {
    if (exitReceiptWritten) return;
    exitReceiptWritten = true;
    const diagnostic = readBoundedRestorerLogTail(paths.diagnosticLog);
    writeRestorerReceipt(paths.processExitReceipt, {
      schema: RESTORER_PROCESS_EXIT_SCHEMA,
      kind: "process-exit",
      observed_at: new Date().toISOString(),
      pid: process.pid,
      window_id: windowId,
      state_root: stateRoot,
      diagnostic_bytes: diagnostic.bytes,
      diagnostic_tail_truncated: diagnostic.truncated,
      diagnostic_tail: diagnostic.text.slice(-2000),
      ownership_note: "guardian-owned; parent exit listener is not the evidence path",
      ...fields,
    });
  };

  process.on("exit", (code) => {
    writeExit({ exit_code: code, signal: null, code: "process-exit" });
  });
  process.on("uncaughtException", (error) => {
    const name = mapRestorerErrorName(error?.name || "Error");
    writeGuardianFailureReceipt(stateRoot, {
      code: "uncaught-exception",
      stage: "process",
      windowId,
      fields: {
        error_name: name,
        ownership_preserved: true,
        proved: false,
        survived: false,
      },
    });
    writeExit({
      exit_code: 1,
      signal: null,
      code: "uncaught-exception",
      error_name: name,
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const name = mapRestorerErrorName(reason?.name || "Error");
    writeGuardianFailureReceipt(stateRoot, {
      code: "unhandled-rejection",
      stage: "process",
      windowId,
      fields: {
        error_name: name,
        ownership_preserved: true,
        proved: false,
        survived: false,
      },
    });
    writeExit({
      exit_code: 1,
      signal: null,
      code: "unhandled-rejection",
      error_name: name,
    });
    process.exit(1);
  });

  return paths;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Read the installer-written runtime identity (commit + per-file sha256). */
export function readInstalledRuntimeManifest(stateRoot = DEFAULT_RESTORER_STATE_ROOT) {
  const paths = restorerPaths(stateRoot);
  const manifest = readJsonIfPresent(paths.installManifest);
  if (!manifest || manifest.schema !== INSTALL_MANIFEST_SCHEMA) return null;
  return manifest;
}

/**
 * Live hashes of the pinned durable runner/libs. Used to prove ready receipts
 * match the install-manifest before any provider mutation.
 */
export function measureInstalledRuntimeShas(stateRoot = DEFAULT_RESTORER_STATE_ROOT) {
  const paths = restorerPaths(stateRoot);
  return {
    "run.mjs": existsSync(paths.durableRunner) ? sha256File(paths.durableRunner) : null,
    "lib/worker_observability_restorer.mjs": existsSync(join(paths.durableLibDir, "worker_observability_restorer.mjs"))
      ? sha256File(join(paths.durableLibDir, "worker_observability_restorer.mjs"))
      : null,
    "lib/worker_observability_settings.mjs": existsSync(join(paths.durableLibDir, "worker_observability_settings.mjs"))
      ? sha256File(join(paths.durableLibDir, "worker_observability_settings.mjs"))
      : null,
  };
}

export function killSwitchEngaged(stateRoot = DEFAULT_RESTORER_STATE_ROOT) {
  return existsSync(restorerPaths(stateRoot).killSwitch);
}

/**
 * Explicit controller-death receipt asks the guardian to restore before the
 * deadline. The receipt must bind to this window_id and restorer_id so a stale
 * death signal from an older generation cannot restore a fresh healthy window.
 */
export function controllerDeathSignaled(
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  { windowId = null, restorerId = null } = {},
) {
  const paths = restorerPaths(stateRoot);
  const receipt = readJsonIfPresent(paths.controllerDeathReceipt);
  if (!receipt || receipt.kind !== "controller-death") return false;
  if (typeof windowId !== "string" || !windowId) return false;
  if (typeof restorerId !== "string" || !restorerId) return false;
  return receipt.window_id === windowId && receipt.restorer_id === restorerId;
}

/**
 * Pending intents are reconciled by GET while the window is still healthy:
 * - pending-after => confirm ownership and keep the window active
 * - pending-before/baseline with issued UNKNOWN intent => retain intended-after
 *   ownership (a prestate GET does not prove the PATCH never applied)
 * - pending-before also covers the owned confirmed-armed prestate of a next
 *   enable (classify prefers pending-before over owned when digests coincide)
 * - pending-before/baseline when never issued or explicitly rejected => clear
 * - conflict => refuse
 * Never closes a healthy non-expired window just because ownership exists.
 */
export async function reconcilePendingMutation({
  window,
  transport,
  now = new Date().toISOString(),
} = {}) {
  if (!window?.pending_mutation) fail("reconcilePendingMutation requires a pending mutation");
  if (!transport || typeof transport.getObservability !== "function") {
    fail("reconcile transport must provide getObservability");
  }
  const current = await transport.getObservability();
  const classification = classifyCurrentSettings(current, window);
  const at = now;
  const pending = window.pending_mutation;

  if (classification.class === "pending-after") {
    const confirmed = confirmOwnedSettings(window, current, { now: at });
    return {
      outcome: "reconciled-owned",
      action: "reconciled-owned",
      proved: true,
      expired: false,
      classification,
      window: confirmed,
      after: confirmed.owned_observability,
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "reconciled-owned",
        window_id: window.window_id,
        observed_at: at,
        current_sha256: classification.sha256,
        owned_sha256: confirmed.owned_sha256,
        pending_after_sha256: pending.after_sha256,
      },
    };
  }

  if (classification.class === "pending-before" || classification.class === "baseline") {
    // Issued-but-unacknowledged PATCH: prestate GET is UNKNOWN, not "not applied".
    // Keep durable intended-after ownership until rejection or resolved restoration.
    if (pendingMutationIsIssued(pending)) {
      const prior = window.mutations || [];
      const last = prior.length ? prior[prior.length - 1] : null;
      // Bound storage: repeated unresolved polls must not append unlimited identical
      // retain rows for the same pending after-target and current digest.
      const identicalRetain = Boolean(
        last
        && last.kind === "pending-retained-unknown"
        && last.before_sha256 === pending.before_sha256
        && last.after_sha256 === pending.after_sha256
        && last.current_sha256 === classification.sha256
      );
      const retained = identicalRetain
        ? {
          ...window,
          mutations: prior,
        }
        : {
          ...window,
          mutations: [
            ...prior,
            {
              at,
              kind: "pending-retained-unknown",
              reason: "prestate-get-does-not-disprove-issued-patch",
              before_sha256: pending.before_sha256,
              after_sha256: pending.after_sha256,
              current_sha256: classification.sha256,
            },
          ],
        };
      return {
        outcome: "retained-pending-unknown",
        action: "retained-pending-unknown",
        proved: false,
        expired: false,
        classification,
        window: retained,
        after: classification.observability,
        receipt: {
          schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
          kind: "restorer",
          outcome: "retained-pending-unknown",
          window_id: window.window_id,
          observed_at: at,
          current_sha256: classification.sha256,
          baseline_sha256: window.baseline_sha256,
          pending_after_sha256: pending.after_sha256,
          issued: true,
          retain_history_appended: !identicalRetain,
        },
      };
    }

    const cleared = {
      ...window,
      phase: window.phase?.startsWith("intent-") ? "captured" : window.phase,
      pending_mutation: null,
      mutations: [
        ...(window.mutations || []),
        {
          at,
          kind: "pending-cleared",
          reason: pending?.rejected ? "explicit-rejection" : "reconcile-pending-before-unissued",
          before_sha256: pending.before_sha256,
          after_sha256: classification.sha256,
        },
      ],
    };
    return {
      outcome: "reconciled-cleared",
      action: "reconciled-cleared",
      proved: true,
      expired: false,
      classification,
      window: cleared,
      after: classification.observability,
      receipt: {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "reconciled-cleared",
        window_id: window.window_id,
        observed_at: at,
        current_sha256: classification.sha256,
        baseline_sha256: window.baseline_sha256,
        pending_after_sha256: pending.after_sha256,
      },
    };
  }

  return {
    outcome: "refused-conflict",
    action: "refuse-conflict",
    proved: false,
    expired: false,
    classification,
    window,
    after: classification.observability,
    receipt: {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "restorer",
      outcome: "refused-conflict",
      window_id: window.window_id,
      observed_at: at,
      current_sha256: classification.sha256,
      reason: "effective settings changed outside this window during pending reconcile",
    },
  };
}

export function writeRestorerReceipt(path, receipt) {
  fsyncWriteJson(path, receipt);
  return receipt;
}

export function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function assertRestorerReady(window, {
  now = new Date().toISOString(),
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  maxHeartbeatAgeMs = DEFAULT_HEARTBEAT_MAX_AGE_MS,
  paths = restorerPaths(stateRoot),
} = {}) {
  if (!window?.restorer?.armed) fail("restorer flag is not armed");
  const runtime = window.restorer.runtime;
  if (!runtime || runtime.kind !== "supervised-process") {
    fail("live supervised restorer runtime is required before mutation");
  }
  if (!isProcessAlive(runtime.pid)) fail("supervised restorer process is not alive");
  if (killSwitchEngaged(stateRoot)) fail("observability restorer kill switch is engaged");

  const ready = readJsonIfPresent(paths.readyReceipt);
  if (!ready || ready.schema !== RESTORER_READY_SCHEMA) fail("restorer readiness receipt is missing");
  if (ready.window_id !== window.window_id) fail("restorer readiness window_id mismatch");
  if (ready.restorer_id !== window.restorer.restorer_id) fail("restorer readiness restorer_id mismatch");
  if (ready.pid !== runtime.pid) fail("restorer readiness pid mismatch");

  const heartbeat = readJsonIfPresent(paths.heartbeatReceipt) || ready;
  const age = Date.parse(now) - Date.parse(heartbeat.observed_at || heartbeat.ready_at || 0);
  if (!Number.isFinite(age) || age > maxHeartbeatAgeMs) {
    fail("restorer heartbeat is stale");
  }
  return { ready, heartbeat, runtime };
}

export function bindWindowToRestorer(window, {
  now = new Date().toISOString(),
  restorerId = window?.restorer?.restorer_id || randomUUID(),
  pid,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) fail("restorer pid is required");
  const armed = window.restorer?.armed
    ? window
    : armRestorer(window, { now, restorerId });
  return {
    ...armed,
    restorer: {
      ...armed.restorer,
      restorer_id: restorerId,
      runtime: {
        kind: "supervised-process",
        schema: RESTORER_RUNTIME_SCHEMA,
        pid,
        state_root: stateRoot,
        started_at: now,
        ready_at: null,
        heartbeat_at: null,
      },
    },
  };
}

export function markWindowRestorerReady(window, {
  now = new Date().toISOString(),
  pid = window?.restorer?.runtime?.pid,
} = {}) {
  if (!window?.restorer?.runtime) fail("restorer runtime is missing");
  return {
    ...window,
    restorer: {
      ...window.restorer,
      runtime: {
        ...window.restorer.runtime,
        pid,
        ready_at: now,
        heartbeat_at: now,
      },
    },
  };
}

export function assignWindowForRestorer({
  windowPath,
  windowId,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  now = new Date().toISOString(),
} = {}) {
  const paths = restorerPaths(stateRoot);
  const assignment = {
    schema: RESTORER_RUNTIME_SCHEMA,
    kind: "assigned-window",
    window_path: windowPath,
    window_id: windowId,
    assigned_at: now,
  };
  writeRestorerReceipt(paths.assignedWindow, assignment);
  return assignment;
}

export async function waitForRestorerReady({
  window,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  timeoutMs = 15_000,
  pollMs = 50,
  nowFn = () => new Date().toISOString(),
} = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return assertRestorerReady(window, { now: nowFn(), stateRoot });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  fail(`restorer readiness handshake timed out: ${lastError?.message || lastError}`);
}

/**
 * One supervised restore tick. Shared by the durable daemon and tests.
 */
export async function restorerTick({
  store,
  transport,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  now = new Date().toISOString(),
  expectedWindowId = null,
} = {}) {
  const paths = restorerPaths(stateRoot);
  if (killSwitchEngaged(stateRoot)) {
    return writeRestorerReceipt(paths.terminalReceipt, {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "restorer",
      outcome: "kill-switch",
      observed_at: now,
    });
  }

  return store.withLock(async () => {
    const window = await store.read();
    if (!window) {
      return writeRestorerReceipt(paths.heartbeatReceipt, {
        schema: RESTORER_READY_SCHEMA,
        kind: "heartbeat",
        outcome: "waiting-for-window",
        observed_at: now,
        pid: process.pid,
      });
    }
    if (expectedWindowId && window.window_id !== expectedWindowId) {
      fail("restorer assigned window_id mismatch");
    }

    writeRestorerReceipt(paths.heartbeatReceipt, {
      schema: RESTORER_READY_SCHEMA,
      kind: "heartbeat",
      outcome: "alive",
      observed_at: now,
      pid: process.pid,
      window_id: window.window_id,
      restorer_id: window.restorer?.restorer_id || null,
      phase: window.phase,
    });

    if (TERMINAL_WINDOW_PHASES.includes(window.phase)) {
      return writeRestorerReceipt(paths.terminalReceipt, {
        schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "already-terminal",
        observed_at: now,
        window_id: window.window_id,
        phase: window.phase,
      });
    }

    const expired = Date.parse(now) >= Date.parse(window.expires_at);
    const pending = Boolean(window.pending_mutation);
    const owned = Boolean(window.owned_observability);
    const controllerDead = controllerDeathSignaled(stateRoot, {
      windowId: window.window_id,
      restorerId: window.restorer?.restorer_id || null,
    });
    const cancelRequested = window.cancel_requested === true;

    // Healthy owned/enabled windows stay active until deadline, cancel, or
    // explicit controller-death. Ownership alone must not trigger restore.
    if (owned && !pending && !expired && !controllerDead && !cancelRequested) {
      return {
        outcome: "idle",
        window,
        reason: "owned-window-active-until-deadline",
      };
    }

    if (!pending && !owned && !expired && !controllerDead && !cancelRequested) {
      return {
        outcome: "idle",
        window,
      };
    }

    // Pending intent while the window is still healthy: reconcile by GET.
    // Do not close a healthy window or restore baseline early.
    if (pending && !expired && !controllerDead && !cancelRequested) {
      const reconciled = await reconcilePendingMutation({ window, transport, now });
      await store.write(reconciled.window, { expectedWindowId: window.window_id });
      if (reconciled.outcome === "refused-conflict") {
        const receipt = writeRestorerReceipt(paths.terminalReceipt, reconciled.receipt);
        return { ...reconciled, terminal_receipt: receipt };
      }
      writeRestorerReceipt(paths.heartbeatReceipt, {
        schema: RESTORER_READY_SCHEMA,
        kind: "heartbeat",
        outcome: reconciled.outcome,
        observed_at: now,
        pid: process.pid,
        window_id: reconciled.window.window_id,
        restorer_id: reconciled.window.restorer?.restorer_id || null,
        phase: reconciled.window.phase,
      });
      return reconciled;
    }

    // Deadline, controller death, or cancel: restore baseline with GET proof.
    // Issued-but-unacknowledged pending + baseline/pending-before GET is UNKNOWN:
    // a hang mid-PATCH can still land after this GET. Retaining ownership keeps the
    // window open so late visibility restores instead of already-restored-clearing
    // and orphaning the applied settings after an in-flight issued write.
    if (pending && pendingMutationIsIssued(window.pending_mutation)) {
      const reconciled = await reconcilePendingMutation({ window, transport, now });
      await store.write(reconciled.window, { expectedWindowId: window.window_id });
      if (reconciled.outcome === "retained-pending-unknown") {
        writeRestorerReceipt(paths.heartbeatReceipt, {
          schema: RESTORER_READY_SCHEMA,
          kind: "heartbeat",
          outcome: reconciled.outcome,
          observed_at: now,
          pid: process.pid,
          window_id: reconciled.window.window_id,
          restorer_id: reconciled.window.restorer?.restorer_id || null,
          phase: reconciled.window.phase,
          controller_death: controllerDead,
          cancel_requested: cancelRequested,
          expired,
        });
        return reconciled;
      }
      if (reconciled.outcome === "refused-conflict") {
        const receipt = writeRestorerReceipt(paths.terminalReceipt, {
          ...reconciled.receipt,
          controller_death: controllerDead,
          cancel_requested: cancelRequested,
          expired,
        });
        return { ...reconciled, terminal_receipt: receipt };
      }
      // reconciled-owned / cleared: fall through to restore with updated window.
    }

    // alreadyLocked: restorerTick holds the window lock for this critical section.
    const restored = await runIndependentRestorer({ store, transport, now, alreadyLocked: true });

    // Script null but effective still owned/pending: stay nonterminal and retry.
    // Same for restore-readback-mismatch: beta PATCH can HTTP-200 while GET stays
    // at the wrangler-enabled owned digest. Write a guardian-owned failure receipt
    // at the failure site (parent exit listeners cannot cover guardian death) and
    // keep ownership. Effective restore requires the config-revert actuator when
    // beta readback stays owned — do not treat catch/retry of the same PATCH as proof.
    if (
      restored.action === "await-effective-baseline"
      || restored.action === "restore-readback-mismatch"
    ) {
      const failureCode = restored.receipt?.actuator_error_code === "config-revert-unavailable"
        ? "config-revert-unavailable"
        : restored.receipt?.actuator_error_code === "config-revert-threw"
          ? "config-revert-threw"
          : restored.action === "await-effective-baseline"
            ? "await-effective-baseline"
            : "restore-readback-mismatch";
      writeGuardianFailureReceipt(stateRoot, {
        code: failureCode,
        stage: "restorerTick",
        windowId: restored.window.window_id,
        restorerId: restored.window.restorer?.restorer_id || null,
        fields: {
          proved: false,
          ownership_preserved: true,
          pending_retained: Boolean(restored.window.pending_mutation),
          ownership_unknown: Boolean(
            restored.window.pending_mutation
            && restored.window.pending_mutation.issued
            && !restored.window.pending_mutation.confirmed
          ),
          after_sha256: restored.receipt?.after_sha256 || restored.receipt?.effective_sha256 || null,
          baseline_sha256: restored.receipt?.baseline_sha256 || null,
          owned_sha256: restored.window.owned_sha256 || null,
          restore_via_attempted: restored.receipt?.restore_via_attempted || null,
          config_revert_available: restored.receipt?.config_revert_available ?? null,
          config_revert_invoked: restored.receipt?.config_revert_invoked ?? null,
          actuator_error_code: restored.receipt?.actuator_error_code || null,
          controller_death: controllerDead,
          cancel_requested: cancelRequested,
          expired: restored.expired === true,
          survived: true,
        },
      });
      writeRestorerReceipt(paths.heartbeatReceipt, {
        schema: RESTORER_READY_SCHEMA,
        kind: "heartbeat",
        outcome: restored.action,
        observed_at: now,
        pid: process.pid,
        window_id: restored.window.window_id,
        restorer_id: restored.window.restorer?.restorer_id || null,
        phase: restored.window.phase,
        proved: false,
        effective_sha256: restored.receipt?.effective_sha256 || restored.receipt?.after_sha256 || null,
        baseline_sha256: restored.receipt?.baseline_sha256 || null,
        restore_via_attempted: restored.receipt?.restore_via_attempted || null,
        config_revert_available: restored.receipt?.config_revert_available ?? null,
        config_revert_invoked: restored.receipt?.config_revert_invoked ?? null,
        actuator_error_code: restored.receipt?.actuator_error_code || null,
        ownership_preserved: true,
        guardian_failure_receipt: paths.guardianFailureReceipt,
        controller_death: controllerDead,
        cancel_requested: cancelRequested,
        expired: restored.expired === true,
      });
      return restored;
    }

    const receipt = writeRestorerReceipt(paths.terminalReceipt, {
      schema: WORKER_OBSERVABILITY_SETTINGS_RECEIPT_SCHEMA,
      kind: "restorer",
      outcome: restored.proved ? restored.action : "blocked",
      observed_at: now,
      window_id: restored.window.window_id,
      proved: restored.proved,
      expired: restored.expired === true,
      classification: restored.classification?.class || null,
      current_sha256: restored.receipt?.current_sha256 || null,
      baseline_sha256: restored.receipt?.baseline_sha256 || null,
      after_sha256: restored.receipt?.after_sha256 || null,
      reason: restored.receipt?.reason || null,
      controller_death: controllerDead,
      cancel_requested: cancelRequested,
    });
    return { ...restored, terminal_receipt: receipt };
  });
}

export async function announceRestorerReady({
  store,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  now = new Date().toISOString(),
  pid = process.pid,
} = {}) {
  const paths = restorerPaths(stateRoot);
  return store.withLock(async () => {
    let window = await store.read();
    if (!window) fail("cannot announce readiness without a window");
    if (!window.restorer?.armed) {
      window = armRestorer(window, { now, restorerId: window.restorer?.restorer_id });
    }
    window = markWindowRestorerReady(bindWindowToRestorer(window, {
      now,
      pid,
      stateRoot,
      restorerId: window.restorer.restorer_id,
    }), { now, pid });
    await store.write(window, { expectedWindowId: window.window_id });
    const installManifest = readInstalledRuntimeManifest(stateRoot);
    const installedShas = measureInstalledRuntimeShas(stateRoot);
    const ready = writeRestorerReceipt(paths.readyReceipt, {
      schema: RESTORER_READY_SCHEMA,
      kind: "ready",
      ready_at: now,
      observed_at: now,
      pid,
      window_id: window.window_id,
      installed_runtime: {
        source_commit: installManifest?.source_commit || null,
        includes_commit: installManifest?.includes_commit || null,
        manifest_path: paths.installManifest,
        files: installedShas,
        manifest_files: installManifest?.files || null,
        matches_manifest: Boolean(
          installManifest?.files
          && installedShas["run.mjs"] === installManifest.files["run.mjs"]
          && installedShas["lib/worker_observability_restorer.mjs"] === installManifest.files["lib/worker_observability_restorer.mjs"]
          && installedShas["lib/worker_observability_settings.mjs"] === installManifest.files["lib/worker_observability_settings.mjs"]
        ),
      },
      restorer_id: window.restorer.restorer_id,
      window_path: store.path,
      state_root: stateRoot,
    });
    writeRestorerReceipt(paths.heartbeatReceipt, {
      ...ready,
      kind: "heartbeat",
      outcome: "ready",
    });
    return { window, ready };
  });
}

export async function runRestorerLoop({
  store,
  transport,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  pollMs = DEFAULT_POLL_MS,
  expectedWindowId = null,
  nowFn = () => new Date().toISOString(),
  shouldStop = () => false,
  onTick = null,
} = {}) {
  const paths = restorerPaths(stateRoot);
  writeRestorerReceipt(paths.startReceipt, {
    schema: RESTORER_RUNTIME_SCHEMA,
    kind: "start",
    started_at: nowFn(),
    pid: process.pid,
    state_root: stateRoot,
    window_path: store.path,
    expected_window_id: expectedWindowId,
  });
  writeFileSync(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });

  const announced = await announceRestorerReady({ store, stateRoot, now: nowFn(), pid: process.pid });
  while (!shouldStop() && !killSwitchEngaged(stateRoot)) {
    let tick;
    try {
      tick = await restorerTick({
        store,
        transport,
        stateRoot,
        now: nowFn(),
        expectedWindowId: expectedWindowId || announced.window.window_id,
      });
    } catch (error) {
      // Survive unexpected actuator/transport throws; keep ownership. Persist
      // only allowlisted codes + finite fields — never raw error/provider bodies.
      const errorName = mapRestorerErrorName(error?.name || "Error");
      const windowId = expectedWindowId || announced.window.window_id;
      writeGuardianFailureReceipt(stateRoot, {
        code: "tick-throw",
        stage: "runRestorerLoop",
        windowId,
        restorerId: announced.window.restorer?.restorer_id || null,
        fields: {
          error_name: errorName,
          proved: false,
          ownership_preserved: true,
          ownership_unknown: true,
          survived: true,
        },
      });
      writeRestorerReceipt(paths.tickFailureReceipt, {
        schema: RESTORER_RUNTIME_SCHEMA,
        kind: "tick-failure",
        observed_at: nowFn(),
        pid: process.pid,
        window_id: windowId,
        code: "tick-throw",
        error_name: errorName,
        ownership_preserved: true,
        ownership_unknown: true,
        survived: true,
      });
      writeRestorerReceipt(paths.heartbeatReceipt, {
        schema: RESTORER_READY_SCHEMA,
        kind: "heartbeat",
        outcome: "tick-failure-survived",
        observed_at: nowFn(),
        pid: process.pid,
        window_id: windowId,
        restorer_id: announced.window.restorer?.restorer_id || null,
        proved: false,
        code: "tick-throw",
        error_name: errorName,
        ownership_preserved: true,
        guardian_failure_receipt: paths.guardianFailureReceipt,
      });
      tick = {
        outcome: "tick-failure-survived",
        proved: false,
        code: "tick-throw",
        error_name: errorName,
        ownership_preserved: true,
      };
    }
    if (typeof onTick === "function") onTick(tick);
    if (tick?.terminal_receipt || TERMINAL_WINDOW_PHASES.includes(tick?.window?.phase)) {
      return tick;
    }
    if (tick?.outcome === "already-terminal" || tick?.outcome === "kill-switch") {
      return tick;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { outcome: "stopped" };
}

/**
 * Start a supervised restorer in a durable state root. The child imports the
 * durable runner copy under stateRoot so disposing the source checkout cannot
 * kill the code path mid-window. Tests may pass nodeArgs/execPath overrides.
 */
export function startSupervisedRestorerProcess({
  windowPath,
  windowId,
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  transportModuleUrl = null,
  nodeExecPath = process.execPath,
  env = process.env,
  detached = true,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const paths = restorerPaths(stateRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.root, "receipts"), { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  if (killSwitchEngaged(stateRoot)) fail("observability restorer kill switch is engaged");

  assignWindowForRestorer({ windowPath, windowId, stateRoot });

  const runner = paths.durableRunner;
  if (!existsSync(runner)) {
    fail(`durable restorer runner missing at ${runner}; run install_observability_settings_restorer.sh`);
  }

  // stdio ignored in the parent so spawn pipes cannot pin the parent event loop.
  // Crash/exit evidence is written by the child via installRestorerProcessEvidenceHandlers
  // (durable runner installs this at boot). Parent only records spawn metadata.
  const child = spawn(nodeExecPath, [runner, "--window-state", windowPath, "--state-root", stateRoot, "--poll-ms", String(pollMs)], {
    detached,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...env,
      CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: transportModuleUrl || "",
      CITYSCROLL_OBSERVABILITY_RESTORER_STATE: stateRoot,
    },
  });

  child.once("error", (error) => {
    // Spawn failures never reach the child; this is the only parent-written
    // process receipt. Ordinary guardian failures are child/guardian-owned.
    const errorName = mapRestorerErrorName(error?.name || "Error");
    writeRestorerReceipt(paths.processExitReceipt, {
      schema: RESTORER_PROCESS_EXIT_SCHEMA,
      kind: "process-exit",
      observed_at: new Date().toISOString(),
      pid: child.pid || null,
      exit_code: null,
      signal: null,
      code: "spawn-error",
      error_name: errorName,
      window_id: windowId,
      state_root: stateRoot,
      ownership_note: "spawn-only parent receipt; guardian failures are child-owned",
    });
  });

  if (detached) child.unref();

  writeRestorerReceipt(paths.startReceipt, {
    schema: RESTORER_RUNTIME_SCHEMA,
    kind: "start-spawn",
    started_at: new Date().toISOString(),
    pid: child.pid,
    state_root: stateRoot,
    window_path: windowPath,
    window_id: windowId,
    runner,
    stdio: "ignore-parent+guardian-owned-receipts",
    process_exit_receipt: paths.processExitReceipt,
    guardian_failure_receipt: paths.guardianFailureReceipt,
    logs: {
      diagnostic: paths.diagnosticLog,
      byte_cap: RESTORER_LOG_BYTE_CAP,
      raw_stdio_tee: false,
    },
  });
  writeFileSync(paths.pidFile, `${child.pid}\n`, { mode: 0o600 });
  return { pid: child.pid, child, paths };
}

export function stopSupervisedRestorerProcess({
  stateRoot = DEFAULT_RESTORER_STATE_ROOT,
  signal = "SIGTERM",
} = {}) {
  const paths = restorerPaths(stateRoot);
  let parsed = null;
  if (existsSync(paths.pidFile)) {
    parsed = Number(readFileSync(paths.pidFile, "utf8").trim());
  }
  if (Number.isInteger(parsed) && parsed > 0 && isProcessAlive(parsed)) {
    try { process.kill(parsed, signal); } catch { /* already gone */ }
  }
  return { pid: parsed };
}

export function engageKillSwitch(stateRoot = DEFAULT_RESTORER_STATE_ROOT) {
  const paths = restorerPaths(stateRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  writeFileSync(paths.killSwitch, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return paths.killSwitch;
}

export function clearKillSwitch(stateRoot = DEFAULT_RESTORER_STATE_ROOT) {
  const paths = restorerPaths(stateRoot);
  if (existsSync(paths.killSwitch)) rmSync(paths.killSwitch);
  return true;
}

export function repoRestorerEntryUrl() {
  return new URL("../worker_observability_restorer.mjs", import.meta.url).href;
}

export function repoRestorerEntryPath() {
  return fileURLToPath(new URL("../worker_observability_restorer.mjs", import.meta.url));
}
