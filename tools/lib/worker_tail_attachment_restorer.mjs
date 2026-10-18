/**
 * Supervised Tail-attachment restorer.
 *
 * Reuses the observability restorer's durable state-root / receipt / controller-
 * death binding pattern for script-settings tail_consumers windows. Own-window
 * stays idle until expiry, controller-death, or cancel. Issued-but-unacked
 * writes retain UNKNOWN ownership. Foreign same-count identity is refused.
 */
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CAP_SIGNAL_REASON,
  TAIL_ATTACHMENT_TERMINAL_PHASES,
  VERSION_GUARD_LABEL,
  WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
  adaptProviderTailConsumers,
  allowlistedCapSignalReason,
  assertTailTransportTargetMatchesWindow,
  assertVersionTransportMatchesBound,
  bindCapObservationToWindowSnapshot,
  capObservationMatchesLiveWindow,
  classifyTailAttachment,
  cleanupUrlFromReadbackUrl,
  closeOwnedSinkWindow,
  confirmTailAttachment,
  mutateOwnedTailAttachment,
  projectAllowlistedCostVector,
  projectTypedCohortEventCounts,
  readOwnedSinkAggregate,
  createBetaWorkerTailConsumersTransport,
  createDeploymentsVersionTransport,
  createDualViewTailConsumersTransport,
  createFileTailAttachmentStore,
  createScriptSettingsTailConsumersTransport,
  observeVersionGuard,
  projectCapIdentityBinding,
  projectCapSignalA2,
  runIndependentTailRestorer,
} from "./worker_tail_attachment.mjs";
import { DEFAULT_WORKER_ID, isProcessAlive } from "./worker_observability_settings.mjs";

export const TAIL_RESTORER_RUNTIME_SCHEMA = "cityscroll.worker_tail_attachment_restorer_runtime.v1";
export const TAIL_RESTORER_READY_SCHEMA = "cityscroll.worker_tail_attachment_restorer_ready.v1";
export const TAIL_SINK_CLOSE_PENDING_SCHEMA = "cityscroll.tail_sink_close_pending.v1";
export const TAIL_SINK_FINAL_AGGREGATE_SCHEMA = "cityscroll.tail_sink_final_aggregate.v1";
export const TAIL_PRODUCER_OUTCOME_SCHEMA = "cityscroll.tail_producer_window_outcome.v1";
export const DEFAULT_TAIL_RESTORER_STATE_ROOT = join(
  process.env.HOME || "",
  ".local/state/cityscroll-cost-control/tail-attachment-restorer",
);
export const DEFAULT_TAIL_HEARTBEAT_MAX_AGE_MS = 30_000;
export const DEFAULT_TAIL_POLL_MS = 1_000;

function fail(message) {
  throw new Error(message);
}

/** Persist only the allowlisted A2 projection — never raw a2 / body text. */
function projectPersistedCapA2(raw) {
  if (raw == null) return null;
  return projectCapSignalA2(raw);
}

/** Persist only allowlisted cap-signal scalars (no body, no arbitrary keys). */
function projectPersistedCapSignal(signal) {
  if (!signal || typeof signal !== "object") return null;
  return {
    cap_reached: signal.cap_reached === true,
    readback_ok: signal.readback_ok === true,
    reason: typeof signal.reason === "string"
      ? allowlistedCapSignalReason(signal.reason)
      : (signal.readback_ok === true ? null : CAP_SIGNAL_REASON.CAP_SIGNAL_UNKNOWN),
    events_seen: Number.isInteger(signal.events_seen) && signal.events_seen >= 0
      ? signal.events_seen
      : null,
    apply_overshoot: Number.isInteger(signal.apply_overshoot) && signal.apply_overshoot >= 0
      ? signal.apply_overshoot
      : null,
    deadline_ms: Number.isFinite(signal.deadline_ms) && signal.deadline_ms > 0
      ? signal.deadline_ms
      : null,
    max_events: Number.isInteger(signal.max_events) && signal.max_events > 0
      ? signal.max_events
      : null,
    opened: typeof signal.opened === "boolean" ? signal.opened : null,
    a2: projectPersistedCapA2(signal.a2),
    identity_binding: projectCapIdentityBinding(signal.identity_binding),
  };
}

/** Allowlisted projection of a sink-close attempt (never token/URL). */
function projectPersistedSinkClose(result) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: result.ok === true,
    cleaned: result.cleaned === true,
    tombstone: result.tombstone === true,
    closed: result.closed === true,
    window_id: typeof result.window_id === "string" ? result.window_id : null,
    reason: typeof result.reason === "string" ? result.reason : null,
    status: Number.isInteger(result.status) ? result.status : null,
  };
}

/** True when cleanup proved a tombstone or closed AggregateSink window. */
export function sinkCloseProved(sinkClose) {
  return sinkClose?.ok === true
    && (sinkClose.tombstone === true || sinkClose.closed === true);
}

/** Allowlisted attachment-restore scalars on the terminal receipt. */
function projectAttachmentRestore({
  proved = null,
  action = null,
  outcome = null,
  expired = null,
  reason = null,
} = {}) {
  return {
    proved: proved === true,
    action: typeof action === "string" ? action : null,
    outcome: typeof outcome === "string" ? outcome : null,
    expired: typeof expired === "boolean" ? expired : null,
    reason: typeof reason === "string" ? reason : null,
  };
}

/**
 * Build a closeOwnedSinkWindow binder from guardian env.
 * Missing URL/token → null (tick skips close; tests inject closeSinkWindow).
 */
export function createSinkCloserFromEnv(env, { fetchImpl = globalThis.fetch } = {}) {
  const readbackUrl = env?.CITYSCROLL_TAIL_SINK_READBACK_URL;
  const token = env?.CITYSCROLL_TAIL_SINK_READBACK_TOKEN;
  if (typeof readbackUrl !== "string" || !readbackUrl) return null;
  if (typeof token !== "string" || !token || token === "unset") return null;
  let cleanupUrl;
  try {
    cleanupUrl = cleanupUrlFromReadbackUrl(readbackUrl);
  } catch {
    return null;
  }
  return async function closeSinkWindow({ windowId } = {}) {
    return closeOwnedSinkWindow({
      url: cleanupUrl,
      token,
      windowId,
      fetchImpl,
    });
  };
}

/**
 * Authenticated AggregateSink /readback capture for guardian terminal.
 * Persists allowlisted counters BEFORE /cleanup tombstone.
 */
/** Bound for terminal final-aggregate GET so capture never stalls detach. */
export const DEFAULT_FINAL_AGGREGATE_TIMEOUT_MS = 1_500;

/**
 * A prior final-aggregate receipt is immutable when it is a successful sample
 * for this exact window with a non-negative measured events_seen (including 0
 * only when explicitly ok and not a post-tombstone wipe). Non-empty measured
 * counters must never be overwritten by a retry that reads the tombstone.
 */
export function isImmutableFinalAggregateSnapshot(existing, windowId) {
  if (!existing || typeof existing !== "object") return false;
  if (existing.window_id !== windowId) return false;
  if (existing.ok !== true) return false;
  if (existing.from_tombstone === true || existing.closed === true) return false;
  if (existing.sample_kind === "last-sample-unknown") return false;
  // Preserve any successful pre-tombstone sample (including events_seen === 0).
  if (existing.sample_kind === "last-sample-before-tombstone") return true;
  if (Number.isInteger(existing.events_seen) && existing.events_seen >= 0) return true;
  return false;
}

function writeFinalAggregateReceiptOnce(path, receipt, windowId) {
  const existing = readJsonIfPresent(path);
  if (isImmutableFinalAggregateSnapshot(existing, windowId)) {
    return existing;
  }
  return writeTailRestorerReceipt(path, receipt);
}

export function createSinkFinalAggregateCaptureFromEnv(env, { fetchImpl = globalThis.fetch } = {}) {
  const readbackUrl = env?.CITYSCROLL_TAIL_SINK_READBACK_URL;
  const token = env?.CITYSCROLL_TAIL_SINK_READBACK_TOKEN;
  if (typeof readbackUrl !== "string" || !readbackUrl) return null;
  if (typeof token !== "string" || !token || token === "unset") return null;
  return async function captureFinalAggregate({
    windowId,
    now = new Date().toISOString(),
    timeoutMs = DEFAULT_FINAL_AGGREGATE_TIMEOUT_MS,
  } = {}) {
    return readOwnedSinkAggregate({
      url: readbackUrl,
      token,
      windowId,
      fetchImpl,
      now,
      // Never delay automatic detach: short hard bound; failures are non-blocking.
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, DEFAULT_FINAL_AGGREGATE_TIMEOUT_MS)
        : DEFAULT_FINAL_AGGREGATE_TIMEOUT_MS,
    });
  };
}

/**
 * Close the AggregateSink window at guardian terminal (expiry/cap/death/cancel).
 * Authenticated /cleanup leaves a TERMINAL tombstone. Failures are recorded;
 * they do not unwind an already-proved detach/restore.
 */
async function closeSinkAtTerminal(closeSinkWindow, windowId) {
  if (typeof closeSinkWindow !== "function") return null;
  if (typeof windowId !== "string" || !windowId) {
    return projectPersistedSinkClose({
      ok: false,
      cleaned: false,
      tombstone: false,
      closed: false,
      window_id: null,
      reason: "window_id_missing",
      status: null,
    });
  }
  try {
    const result = await closeSinkWindow({ windowId });
    return projectPersistedSinkClose(result);
  } catch {
    return projectPersistedSinkClose({
      ok: false,
      cleaned: false,
      tombstone: false,
      closed: false,
      window_id: windowId,
      reason: "sink_close_error",
      status: null,
    });
  }
}

export function readSinkClosePending(stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT) {
  return readJsonIfPresent(tailRestorerPaths(stateRoot).sinkClosePending);
}

function clearSinkClosePending(paths) {
  if (existsSync(paths.sinkClosePending)) unlinkSync(paths.sinkClosePending);
}

function writeSinkClosePendingRecord(paths, record) {
  return writeTailRestorerReceipt(paths.sinkClosePending, {
    schema: TAIL_SINK_CLOSE_PENDING_SCHEMA,
    kind: "sink-close-pending",
    status: typeof record.status === "string" ? record.status : "pending",
    window_id: typeof record.window_id === "string" ? record.window_id : null,
    observed_at: typeof record.observed_at === "string" ? record.observed_at : null,
    reason: typeof record.reason === "string" ? record.reason : null,
    last_close: projectPersistedSinkClose(record.last_close),
  });
}

/**
 * Close AggregateSink with a durable pending obligation.
 * Unbound closer → null and no pending file (no obligation).
 * Writes pending before the call; leaves last_close on the pending record.
 * Callers persist the terminal receipt, then clearPendingSinkCloseIfProved.
 */
async function attemptOwnedSinkClose({
  closeSinkWindow,
  captureFinalAggregate = null,
  windowId,
  paths,
  now = null,
  reason = null,
  /**
   * When set (ISO), remaining ms until expires_at caps the capture timeout so
   * terminal cleanup never stalls past the detach deadline. Past-deadline →
   * skip capture and record an honest last-sample-unknown receipt.
   */
  expiresAt = null,
} = {}) {
  if (typeof closeSinkWindow !== "function") return null;
  const at = typeof now === "string" ? now : new Date().toISOString();
  const id = typeof windowId === "string" && windowId ? windowId : null;
  // ROOT 13:20: Tail attachment restore/detach already ran before this closer
  // (deadline detach is never gated on this GET). Capture is short-bounded and
  // non-throwing; Tail arrivals between snapshot and tombstone stay UNKNOWN.
  // Valid non-empty snapshots are write-once per exact window so a lost cleanup
  // ACK retry cannot overwrite measured counters with a post-tombstone zero.
  if (typeof captureFinalAggregate === "function" && id && paths?.finalAggregateReceipt) {
    const existing = readJsonIfPresent(paths.finalAggregateReceipt);
    if (isImmutableFinalAggregateSnapshot(existing, id)) {
      // Keep prior evidence; still proceed to cleanup.
    } else {
      try {
        const atMs = Date.parse(at);
        const expMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
        // Before deadline: cap by remaining window. At/after deadline (normal
        // terminal path): still capture with the short default bound — detach
        // already completed; do not skip the last-sample GET.
        let timeoutMs = DEFAULT_FINAL_AGGREGATE_TIMEOUT_MS;
        if (Number.isFinite(expMs) && Number.isFinite(atMs) && expMs > atMs) {
          timeoutMs = Math.min(DEFAULT_FINAL_AGGREGATE_TIMEOUT_MS, Math.max(1, expMs - atMs));
        }
        const finalAggregate = await captureFinalAggregate({
          windowId: id,
          now: at,
          timeoutMs,
        });
        if (finalAggregate) {
          writeFinalAggregateReceiptOnce(paths.finalAggregateReceipt, {
            ...finalAggregate,
            sample_kind: "last-sample-before-tombstone",
            arrivals_between_snapshot_and_cleanup: "UNKNOWN",
            detach_not_delayed_by_capture: true,
            label: finalAggregate.label
              || "last sample before terminal tombstone; arrivals until cleanup UNKNOWN",
          }, id);
        }
      } catch {
        // Capture failure must not block restore/tombstone.
        try {
          writeFinalAggregateReceiptOnce(paths.finalAggregateReceipt, {
            schema: TAIL_SINK_FINAL_AGGREGATE_SCHEMA,
            kind: "final-aggregate-before-tombstone",
            observed_at: at,
            window_id: id,
            ok: false,
            sample_kind: "last-sample-unknown",
            label: "capture error; detach/cleanup not delayed; arrivals until tombstone UNKNOWN",
            arrivals_between_snapshot_and_cleanup: "UNKNOWN",
            detach_not_delayed_by_capture: true,
            reason: "capture_error",
          }, id);
        } catch { /* receipt best-effort */ }
      }
    }
  }
  writeSinkClosePendingRecord(paths, {
    status: "pending",
    window_id: id,
    observed_at: at,
    reason,
    last_close: null,
  });
  writeSinkClosePendingRecord(paths, {
    status: "issued-unacked",
    window_id: id,
    observed_at: at,
    reason,
    last_close: null,
  });
  const sinkClose = await closeSinkAtTerminal(closeSinkWindow, id);
  writeSinkClosePendingRecord(paths, {
    status: "issued-unacked",
    window_id: id,
    observed_at: at,
    reason,
    last_close: sinkClose,
  });
  return sinkClose;
}

function clearPendingSinkCloseIfProved(paths, sinkClose) {
  if (sinkCloseProved(sinkClose)) clearSinkClosePending(paths);
}

/** Open cleanup obligation when a closer is bound and pending/unproved close remains. */
export function sinkCloseObligationRemains(stateRoot, closeSinkWindow) {
  if (typeof closeSinkWindow !== "function") return false;
  const paths = tailRestorerPaths(stateRoot);
  if (existsSync(paths.sinkClosePending)) return true;
  if (!existsSync(paths.terminalReceipt)) return false;
  const terminal = readJsonIfPresent(paths.terminalReceipt);
  return Boolean(terminal) && !sinkCloseProved(terminal.sink_close);
}

/**
 * Retry idempotent sink cleanup when pending exists or terminal sink_close is unproved.
 * Updates the terminal receipt's sink_close in place; clears pending when proved.
 */
async function reconcileSinkCloseObligation({
  closeSinkWindow,
  captureFinalAggregate = null,
  paths,
  windowId = null,
  now = null,
  reason = "sink-close-retry",
} = {}) {
  if (typeof closeSinkWindow !== "function") {
    return { attempted: false, sink_close: null };
  }
  const pending = readJsonIfPresent(paths.sinkClosePending);
  const terminal = readJsonIfPresent(paths.terminalReceipt);
  const needsRetry = Boolean(pending)
    || (Boolean(terminal) && !sinkCloseProved(terminal.sink_close));
  if (!needsRetry) {
    return {
      attempted: false,
      sink_close: terminal ? projectPersistedSinkClose(terminal.sink_close) : null,
    };
  }
  const closeWindowId = (typeof pending?.window_id === "string" && pending.window_id)
    || (typeof terminal?.window_id === "string" && terminal.window_id)
    || (typeof windowId === "string" && windowId)
    || null;
  const sinkClose = await attemptOwnedSinkClose({
    closeSinkWindow,
    captureFinalAggregate,
    windowId: closeWindowId,
    paths,
    now,
    reason,
    // Retries: do not stall cleanup; short default bound inside capture helper.
    expiresAt: null,
  });
  if (terminal) {
    writeTailRestorerReceipt(paths.terminalReceipt, {
      ...terminal,
      sink_close: sinkClose,
    });
  }
  return { attempted: true, sink_close: sinkClose };
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

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function tailRestorerPaths(stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT) {
  return {
    root: stateRoot,
    killSwitch: join(stateRoot, "tail-attachment-restorer.off"),
    pidFile: join(stateRoot, "restorer.pid"),
    startReceipt: join(stateRoot, "receipts/start.json"),
    startSpawnReceipt: join(stateRoot, "receipts/start-spawn.json"),
    readyReceipt: join(stateRoot, "receipts/ready.json"),
    heartbeatReceipt: join(stateRoot, "receipts/heartbeat.json"),
    terminalReceipt: join(stateRoot, "receipts/terminal.json"),
    sinkClosePending: join(stateRoot, "receipts/sink-close-pending.json"),
    finalAggregateReceipt: join(stateRoot, "receipts/final-aggregate-before-tombstone.json"),
    controllerDeathReceipt: join(stateRoot, "receipts/controller-death.json"),
    childExitReceipt: join(stateRoot, "receipts/child-exit.json"),
    childFailedBeforeReadyReceipt: join(stateRoot, "receipts/child-failed-before-ready.json"),
    assignedWindow: join(stateRoot, "assigned-window.json"),
    durableRunner: join(stateRoot, "run.mjs"),
    durableLibDir: join(stateRoot, "lib"),
    logsDir: join(stateRoot, "logs"),
  };
}

/** Allowlisted guardian startup failure codes — never persist raw stderr. */
export const GUARDIAN_STARTUP_FAILURE_CODE = Object.freeze({
  CREDENTIAL_MUTUALLY_EXCLUSIVE: "credential_mutually_exclusive",
  CREDENTIAL_MISSING: "credential_missing",
  CREDENTIAL_FILE_MODE: "credential_file_mode",
  WINDOW_MISSING: "window_missing",
  TRANSPORT_TARGET_MISMATCH: "transport_target_mismatch",
  VERSION_EVIDENCE_MISSING: "version_evidence_missing",
  CAP_DETACH_RUNTIME_ABSENT: "cap_detach_runtime_absent",
  SPAWN_ERROR: "spawn_error",
  UNKNOWN_STARTUP_FAILURE: "unknown_startup_failure",
  NONE: "none",
});

const GUARDIAN_STDERR_DIAG_MAX_BYTES = 4_096;

/**
 * Classify a bounded in-memory stderr sample into an allowlisted failure code.
 * The sample is never persisted — only the returned code/counts are.
 */
export function classifyGuardianStartupStderr(sampleText = "") {
  const text = typeof sampleText === "string" ? sampleText : "";
  if (/mutually exclusive/i.test(text)) {
    return GUARDIAN_STARTUP_FAILURE_CODE.CREDENTIAL_MUTUALLY_EXCLUSIVE;
  }
  if (/must be mode 0600|mode 0600/i.test(text)) {
    return GUARDIAN_STARTUP_FAILURE_CODE.CREDENTIAL_FILE_MODE;
  }
  if (/CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_TOKEN_FILE is required/i.test(text)
    || (/CLOUDFLARE_API_TOKEN/i.test(text) && /is required/i.test(text) && !/mutually exclusive/i.test(text))) {
    return GUARDIAN_STARTUP_FAILURE_CODE.CREDENTIAL_MISSING;
  }
  if (/window state missing|tail attachment window is empty|cannot announce.*without a window/i.test(text)) {
    return GUARDIAN_STARTUP_FAILURE_CODE.WINDOW_MISSING;
  }
  if (/transport target|account or worker mismatch|does not match window/i.test(text)) {
    return GUARDIAN_STARTUP_FAILURE_CODE.TRANSPORT_TARGET_MISMATCH;
  }
  if (/version evidence|version_evidence|deployments version/i.test(text)
    && /required|missing|unproved|refusing/i.test(text)) {
    return GUARDIAN_STARTUP_FAILURE_CODE.VERSION_EVIDENCE_MISSING;
  }
  if (/cap-detach actuator but runtime actuator is absent|armed with cap-detach but runtime actuator absent/i.test(text)) {
    return GUARDIAN_STARTUP_FAILURE_CODE.CAP_DETACH_RUNTIME_ABSENT;
  }
  if (text.trim()) return GUARDIAN_STARTUP_FAILURE_CODE.UNKNOWN_STARTUP_FAILURE;
  return GUARDIAN_STARTUP_FAILURE_CODE.NONE;
}

function createBoundedStderrDiagnoser({ maxBytes = GUARDIAN_STDERR_DIAG_MAX_BYTES } = {}) {
  let sample = Buffer.alloc(0);
  let bytesSeen = 0;
  let bytesOmitted = 0;
  let linesSeen = 0;
  let linesOmitted = 0;
  return {
    max_bytes: maxBytes,
    onChunk(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytesSeen += buf.length;
      const asText = buf.toString("utf8");
      const newLines = (asText.match(/\n/g) || []).length;
      linesSeen += newLines;
      if (sample.length >= maxBytes) {
        bytesOmitted += buf.length;
        linesOmitted += newLines;
        return;
      }
      const room = maxBytes - sample.length;
      if (buf.length <= room) {
        sample = Buffer.concat([sample, buf]);
        return;
      }
      sample = Buffer.concat([sample, buf.subarray(0, room)]);
      bytesOmitted += buf.length - room;
      const omittedText = buf.subarray(room).toString("utf8");
      linesOmitted += (omittedText.match(/\n/g) || []).length;
    },
    snapshot() {
      const sampleText = sample.toString("utf8");
      return {
        failure_code: classifyGuardianStartupStderr(sampleText),
        stderr_bytes_seen: bytesSeen,
        stderr_bytes_omitted: bytesOmitted,
        stderr_lines_seen: linesSeen,
        stderr_lines_omitted: linesOmitted,
        stderr_diag_cap_bytes: maxBytes,
        // Intentionally omit sampleText — never persist raw stderr.
      };
    },
  };
}

/**
 * Compose the guardian child env with exactly ONE Cloudflare credential source.
 * Prefers CLOUDFLARE_API_TOKEN_FILE (no raw token in env). Explicitly deletes the
 * unused variable so an inherited TOKEN cannot ride along with TOKEN_FILE.
 * Returns booleans only for logging — never credential values.
 */
export function composeGuardianChildEnv(env = process.env, {
  tokenFile = null,
  token = null,
  preferTokenFile = true,
} = {}) {
  const incoming = env && typeof env === "object" ? env : {};
  const out = { ...incoming };
  const hadToken = Boolean(incoming.CLOUDFLARE_API_TOKEN);
  const hadTokenFile = Boolean(incoming.CLOUDFLARE_API_TOKEN_FILE);
  delete out.CLOUDFLARE_API_TOKEN;
  delete out.CLOUDFLARE_API_TOKEN_FILE;

  const fileCandidate = typeof tokenFile === "string" && tokenFile
    ? tokenFile
    : (typeof incoming.CLOUDFLARE_API_TOKEN_FILE === "string" && incoming.CLOUDFLARE_API_TOKEN_FILE
      ? incoming.CLOUDFLARE_API_TOKEN_FILE
      : null);
  const tokenCandidate = typeof token === "string" && token
    ? token
    : (typeof incoming.CLOUDFLARE_API_TOKEN === "string" && incoming.CLOUDFLARE_API_TOKEN
      ? incoming.CLOUDFLARE_API_TOKEN
      : null);

  let credentialSource = "none";
  if (preferTokenFile && fileCandidate) {
    out.CLOUDFLARE_API_TOKEN_FILE = fileCandidate;
    credentialSource = "TOKEN_FILE";
  } else if (tokenCandidate) {
    out.CLOUDFLARE_API_TOKEN = tokenCandidate;
    credentialSource = "TOKEN";
  } else if (fileCandidate) {
    out.CLOUDFLARE_API_TOKEN_FILE = fileCandidate;
    credentialSource = "TOKEN_FILE";
  }

  return {
    env: out,
    credential_source: credentialSource,
    has_TOKEN: Boolean(out.CLOUDFLARE_API_TOKEN),
    has_TOKEN_FILE: Boolean(out.CLOUDFLARE_API_TOKEN_FILE),
    incoming_had_TOKEN: hadToken,
    incoming_had_TOKEN_FILE: hadTokenFile,
    sanitized_dual_credential: hadToken && hadTokenFile,
  };
}

export function writeTailRestorerReceipt(path, receipt) {
  fsyncWriteJson(path, receipt);
  return receipt;
}

export function killSwitchEngaged(stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT) {
  return existsSync(tailRestorerPaths(stateRoot).killSwitch);
}

/**
 * Explicit controller-death receipt asks the guardian to restore before the
 * deadline. Must bind window_id and restorer_id so a stale signal cannot
 * restore a fresh healthy window.
 */
export function tailControllerDeathSignaled(
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  { windowId = null, restorerId = null } = {},
) {
  const paths = tailRestorerPaths(stateRoot);
  const receipt = readJsonIfPresent(paths.controllerDeathReceipt);
  if (!receipt || receipt.kind !== "controller-death") return false;
  if (typeof windowId !== "string" || !windowId) return false;
  if (typeof restorerId !== "string" || !restorerId) return false;
  return receipt.window_id === windowId && receipt.restorer_id === restorerId;
}

export function assignTailWindowForRestorer({
  windowPath,
  windowId,
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
} = {}) {
  if (typeof windowPath !== "string" || !windowPath) fail("windowPath is required");
  if (typeof windowId !== "string" || !windowId) fail("windowId is required");
  const paths = tailRestorerPaths(stateRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.root, "receipts"), { recursive: true, mode: 0o700 });
  writeTailRestorerReceipt(paths.assignedWindow, {
    schema: TAIL_RESTORER_RUNTIME_SCHEMA,
    kind: "assigned-window",
    assigned_at: new Date().toISOString(),
    window_path: windowPath,
    window_id: windowId,
  });
  return paths.assignedWindow;
}

function pendingIssuedUnacked(window) {
  return Boolean(window.pending_mutation?.issued && !window.pending_mutation?.confirmed);
}

/**
 * Reconcile a pending Tail attach/detach by GET while the window is healthy.
 */
export async function reconcileTailPendingMutation({
  window,
  transport,
  now = new Date().toISOString(),
} = {}) {
  if (!window?.pending_mutation) fail("reconcileTailPendingMutation requires a pending mutation");
  if (!transport || typeof transport.getTailConsumers !== "function") {
    fail("reconcile transport must provide getTailConsumers");
  }
  const currentRaw = await transport.getTailConsumers();
  const adapted = adaptProviderTailConsumers(currentRaw);
  if (!adapted.present) {
    return {
      outcome: "retained-pending-unknown",
      action: "retain-owned-unknown",
      proved: false,
      ownership_preserved: true,
      ownership_unknown: true,
      classification: { class: "unknown", consumers: null, sha256: null },
      window,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "retained-pending-unknown",
        window_id: window.window_id,
        observed_at: now,
        reason: "provider GET missing/malformed during pending reconcile",
      },
    };
  }
  const classification = classifyTailAttachment(adapted.consumers, window);
  const pending = window.pending_mutation;

  if (classification.class === "pending-after") {
    const confirmed = confirmTailAttachment(window, {
      observedConsumers: adapted.consumers,
      now,
    });
    return {
      outcome: "reconciled-owned",
      action: "reconciled-owned",
      proved: true,
      ownership_preserved: true,
      ownership_unknown: false,
      classification,
      window: confirmed,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "reconciled-owned",
        window_id: window.window_id,
        observed_at: now,
        current_sha256: classification.sha256,
        owned_sha256: confirmed.owned_sha256,
        pending_after_sha256: pending.after_sha256,
      },
    };
  }

  if (classification.class === "pending-before" || classification.class === "baseline") {
    if (pendingIssuedUnacked(window)) {
      return {
        outcome: "retained-pending-unknown",
        action: "retain-owned-unknown",
        proved: false,
        ownership_preserved: true,
        ownership_unknown: true,
        classification,
        window,
        receipt: {
          schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
          kind: "restorer",
          outcome: "retained-pending-unknown",
          window_id: window.window_id,
          observed_at: now,
          reason: "issued attachment write is unacknowledged; one GET is not baseline-safe",
        },
      };
    }
    // Unissued pending: clear and keep window open.
    const cleared = {
      ...window,
      pending_mutation: null,
      phase: window.owned_sha256 ? "attached" : "captured",
    };
    return {
      outcome: "cleared-unissued-pending",
      action: "cleared-unissued-pending",
      proved: false,
      ownership_preserved: Boolean(window.owned_sha256),
      ownership_unknown: false,
      classification,
      window: cleared,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "cleared-unissued-pending",
        window_id: window.window_id,
        observed_at: now,
      },
    };
  }

  if (classification.class === "conflict") {
    return {
      outcome: "refused-conflict",
      action: "refuse-conflict",
      proved: false,
      ownership_preserved: true,
      ownership_unknown: false,
      classification,
      window,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "refuse-conflict",
        window_id: window.window_id,
        observed_at: now,
        after_sha256: classification.sha256,
        reason: "foreign tail_consumers identity preserved",
      },
    };
  }

  return {
    outcome: "idle-pending",
    action: "idle-pending",
    proved: false,
    ownership_preserved: true,
    ownership_unknown: false,
    classification,
    window,
    receipt: {
      schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
      kind: "restorer",
      outcome: "idle-pending",
      window_id: window.window_id,
      observed_at: now,
      classification: classification.class,
    },
  };
}

/**
 * One guardian tick over a durable Tail window.
 */
export async function announceTailRestorerReady({
  store,
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  now = new Date().toISOString(),
  pid = process.pid,
  versionTransport = null,
} = {}) {
  if (!store || typeof store.withLock !== "function") fail("durable Tail store withLock is required");
  const paths = tailRestorerPaths(stateRoot);
  return store.withLock(async () => {
    const window = await store.read();
    if (!window) fail("cannot announce Tail restorer readiness without a window");
    if (!window.restorer?.armed) fail("tail restorer must be armed before ready announcement");
    writeFileSync(paths.pidFile, `${pid}\n`, { mode: 0o600 });
    // ready.* flags are derived from an ACTUAL GET observed here — never from
    // the transport merely being configured. fresh_get_before_and_after_actuator
    // is reserved for restore terminal receipts after both sides run.
    const readyObservation = await observeVersionGuard({
      versionTransport,
      boundEvidence: window.version_evidence,
      reasonIfMissing: "ready announcement: versionTransport or bound evidence missing",
    });
    // Bound means an actual getLatestVersionEvidence call was observed.
    const versionGuardBound = readyObservation.performed === true;
    if (!Number.isInteger(window.window_generation)) {
      fail("cannot announce Tail restorer readiness without an integer window_generation");
    }
    const ready = writeTailRestorerReceipt(paths.readyReceipt, {
      schema: TAIL_RESTORER_READY_SCHEMA,
      kind: "ready",
      ready_at: now,
      observed_at: now,
      pid,
      window_id: window.window_id,
      restorer_id: window.restorer.restorer_id,
      window_generation: window.window_generation,
      window_path: store.path,
      state_root: stateRoot,
      independent_process: true,
      version_guard_bound: versionGuardBound,
      version_guard: {
        observed_at_ready: readyObservation.outcome,
        reason: readyObservation.reason,
        version: readyObservation.version_unknown ? "UNKNOWN" : readyObservation.version,
        version_unknown: readyObservation.version_unknown,
        consumer: window.version_evidence?.consumer || null,
        get_target: window.version_evidence?.get_target || null,
        account_id_sha256: window.version_evidence?.account_id_sha256 || null,
        // Not claimed here — only set after restore observes before+after.
        fresh_get_before_and_after_actuator: false,
        provider_cas: "UNKNOWN",
      },
    });
    writeTailRestorerReceipt(paths.heartbeatReceipt, {
      schema: TAIL_RESTORER_READY_SCHEMA,
      kind: "heartbeat",
      outcome: "ready",
      observed_at: now,
      pid,
      window_id: window.window_id,
      restorer_id: window.restorer.restorer_id,
      window_generation: window.window_generation,
      phase: window.phase,
      version_guard_bound: versionGuardBound,
      version_guard_observed_at_ready: readyObservation.outcome,
    });
    return {
      window,
      ready,
      version_guard_bound: versionGuardBound,
      version_guard: ready.version_guard,
    };
  });
}

/**
 * Durable poll loop for the independent Tail guardian process.
 * Survives controller exit; stops on terminal receipt, kill switch, or shouldStop.
 * When versionTransport is provided it is the same consumer-bound deployments
 * guard the actuator tests cover (fresh GET before/after attach).
 */
export async function runTailRestorerLoop({
  store,
  transport,
  versionTransport = null,
  capDetachActuator = null,
  closeSinkWindow = null,
  captureFinalAggregate = null,
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  pollMs = DEFAULT_TAIL_POLL_MS,
  nowFn = () => new Date().toISOString(),
  shouldStop = () => false,
} = {}) {
  const paths = tailRestorerPaths(stateRoot);
  const initial = await store.read();
  if (
    initial?.restorer?.cap_detach_actuator_bound === true
    && initial?.restorer?.restore_only !== true
  ) {
    if (!capDetachActuator || typeof capDetachActuator.pollAndDetachIfCapped !== "function") {
      fail(
        "refuse to run: window armed with cap-detach actuator but runtime actuator is absent",
      );
    }
  }
  writeTailRestorerReceipt(paths.startReceipt, {
    schema: TAIL_RESTORER_RUNTIME_SCHEMA,
    kind: "start",
    started_at: nowFn(),
    pid: process.pid,
    state_root: stateRoot,
    window_path: store.path,
    // Configured ≠ observed; ready receipt records the actual GET outcome.
    version_transport_configured: Boolean(
      versionTransport && typeof versionTransport.getLatestVersionEvidence === "function",
    ),
    cap_detach_actuator_bound: initial?.restorer?.cap_detach_actuator_bound === true,
    cap_detach_actuator_runtime: Boolean(
      capDetachActuator && typeof capDetachActuator.pollAndDetachIfCapped === "function",
    ),
    sink_closer_bound: typeof closeSinkWindow === "function",
  });
  writeFileSync(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  const announced = await announceTailRestorerReady({
    store,
    stateRoot,
    now: nowFn(),
    pid: process.pid,
    versionTransport,
  });

  let last = announced;
  while (!shouldStop() && !killSwitchEngaged(stateRoot)) {
    // Terminal receipt alone is not enough while sink cleanup remains unproved
    // and a closer is bound; unbound closer means no cleanup obligation.
    if (
      existsSync(paths.terminalReceipt)
      && !sinkCloseObligationRemains(stateRoot, closeSinkWindow)
    ) {
      break;
    }
    const tick = await tailAttachmentRestorerTick({
      store,
      transport,
      versionTransport,
      capDetachActuator,
      closeSinkWindow,
      captureFinalAggregate,
      stateRoot,
      now: nowFn(),
    });
    last = tick;
    if (tick?.outcome === "kill-switch") break;
    const obligationOpen = sinkCloseObligationRemains(stateRoot, closeSinkWindow);
    if (
      (tick?.terminal_receipt || tick?.outcome === "already-terminal")
      && !obligationOpen
    ) {
      break;
    }
    if (
      tick?.proved === true
      && ["restored", "already-restored", "refuse-conflict", "cap-detach"].includes(
        tick.action || tick.outcome,
      )
      && !obligationOpen
    ) {
      break;
    }
    await sleep(pollMs);
  }
  return last;
}

/** Upper bound for a single outside-lock cap readback poll (ms). */
export const DEFAULT_CAP_POLL_OUTSIDE_LOCK_MS = 5_000;

function remainingWindowMs(window, now) {
  const expiresAt = Date.parse(window?.expires_at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, expiresAt - nowMs);
}

export async function tailAttachmentRestorerTick({
  store,
  transport,
  versionTransport = null,
  capDetachActuator = null,
  closeSinkWindow = null,
  captureFinalAggregate = null,
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  now = null,
  nowFn = () => new Date().toISOString(),
} = {}) {
  const paths = tailRestorerPaths(stateRoot);
  const nowBefore = typeof now === "string" ? now : nowFn();
  if (killSwitchEngaged(stateRoot)) {
    return writeTailRestorerReceipt(paths.terminalReceipt, {
      schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
      kind: "restorer",
      outcome: "kill-switch",
      observed_at: nowBefore,
      pid: process.pid,
    });
  }
  if (!store || typeof store.withLock !== "function") fail("durable Tail store withLock is required");
  if (typeof store.read !== "function") fail("durable Tail store.read is required");

  // Bound the authenticated cap poll OUTSIDE the lock so a hung/slow readback
  // cannot block expiry, cancel, or the normal restore path. Bind the poll to
  // snapshot A's window/generation/ownership so a stale result cannot actuate
  // against a later window B under the lock.
  let prefetchedCapSignal = null;
  let capObservation = null;
  const snapshot = await store.read();
  if (!snapshot) fail("tail attachment window is missing");
  if (!snapshot.restorer?.armed) fail("tail restorer is not armed");
  const snapExpired = Date.parse(nowBefore) >= Date.parse(snapshot.expires_at);
  const snapPending = Boolean(snapshot.pending_mutation);
  const snapOwned = Boolean(snapshot.owned_sha256);
  const snapControllerDead = tailControllerDeathSignaled(stateRoot, {
    windowId: snapshot.window_id,
    restorerId: snapshot.restorer?.restorer_id || null,
  });
  const snapCancelRequested = snapshot.cancel_requested === true;
  if (
    snapOwned
    && !snapPending
    && !snapExpired
    && !snapControllerDead
    && !snapCancelRequested
    && snapshot.restorer?.cap_detach_actuator_bound === true
    && snapshot.restorer?.restore_only !== true
  ) {
    if (!capDetachActuator || typeof capDetachActuator.pollAndDetachIfCapped !== "function") {
      fail("refuse: window armed with cap-detach but runtime actuator absent");
    }
    const remainingMs = remainingWindowMs(snapshot, nowBefore);
    const timeoutMs = Math.max(
      1,
      Math.min(remainingMs || DEFAULT_CAP_POLL_OUTSIDE_LOCK_MS, DEFAULT_CAP_POLL_OUTSIDE_LOCK_MS),
    );
    if (typeof capDetachActuator.pollCapSignal === "function") {
      prefetchedCapSignal = await capDetachActuator.pollCapSignal({ timeoutMs });
    } else {
      // Fixture/legacy actuators without pollCapSignal: best-effort bounded poll
      // via pollAndDetachIfCapped would detach under no lock — refuse that path.
      prefetchedCapSignal = {
        cap_reached: false,
        readback_ok: false,
        reason: "actuator_missing_pollCapSignal",
        events_seen: null,
        apply_overshoot: null,
        deadline_ms: null,
        max_events: null,
        opened: null,
        a2: { pass: false, reason: "a2_reason_unknown", events_seen: null, apply_overshoot: null },
        identity_binding: null,
      };
    }
    capObservation = bindCapObservationToWindowSnapshot(prefetchedCapSignal, snapshot);
  }

  // Re-read time AFTER the poll so a poll that ends at the deadline does not
  // postpone expiry/cancel/restore. Frozen `now` keeps tests hermetic.
  const nowAfter = typeof now === "string" ? now : nowFn();

  return store.withLock(async () => {
    const window = await store.read();
    if (!window) fail("tail attachment window is missing");
    if (!window.restorer?.armed) fail("tail restorer is not armed");

    writeTailRestorerReceipt(paths.heartbeatReceipt, {
      schema: TAIL_RESTORER_READY_SCHEMA,
      kind: "heartbeat",
      outcome: "alive",
      observed_at: nowAfter,
      pid: process.pid,
      window_id: window.window_id,
      restorer_id: window.restorer?.restorer_id || null,
      phase: window.phase,
      // Allowlisted reason codes only — never raw URL/query/body/token/error text.
      cap_signal_reason: typeof prefetchedCapSignal?.reason === "string"
        ? prefetchedCapSignal.reason
        : null,
      cap_readback_ok: prefetchedCapSignal ? prefetchedCapSignal.readback_ok === true : null,
    });

    if (TAIL_ATTACHMENT_TERMINAL_PHASES.includes(window.phase)) {
      const existingTerminal = readJsonIfPresent(paths.terminalReceipt);
      const reconciled = await reconcileSinkCloseObligation({
        closeSinkWindow,
        captureFinalAggregate,
        paths,
        windowId: window.window_id
          || existingTerminal?.window_id
          || null,
        now: nowAfter,
        reason: "already-terminal-retry",
      });
      const sinkClose = reconciled.attempted
        ? reconciled.sink_close
        : (existingTerminal
          ? projectPersistedSinkClose(existingTerminal.sink_close)
          : null);
      const attachmentRestore = existingTerminal?.attachment_restore
        && typeof existingTerminal.attachment_restore === "object"
        ? projectAttachmentRestore(existingTerminal.attachment_restore)
        : projectAttachmentRestore({
          proved: true,
          action: typeof window.phase === "string" ? window.phase : null,
          outcome: "already-terminal",
        });
      const receipt = writeTailRestorerReceipt(paths.terminalReceipt, {
        ...(existingTerminal && typeof existingTerminal === "object" ? existingTerminal : {}),
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restorer",
        outcome: "already-terminal",
        observed_at: nowAfter,
        window_id: window.window_id,
        phase: window.phase,
        attachment_restore: attachmentRestore,
        sink_close: sinkClose,
      });
      clearPendingSinkCloseIfProved(paths, sinkClose);
      return {
        ...receipt,
        terminal_receipt: receipt,
        sink_close: sinkClose,
        outcome: "already-terminal",
      };
    }

    const expired = Date.parse(nowAfter) >= Date.parse(window.expires_at);
    const pending = Boolean(window.pending_mutation);
    const owned = Boolean(window.owned_sha256);
    const controllerDead = tailControllerDeathSignaled(stateRoot, {
      windowId: window.window_id,
      restorerId: window.restorer?.restorer_id || null,
    });
    const cancelRequested = window.cancel_requested === true;

    // Healthy owned windows: use the outside-lock cap poll, then detach under
    // the lock. UNKNOWN/error/stalled polls stay idle so expiry/cancel/restore
    // below still run on later ticks. A stale observation (A ≠ B) refuses
    // actuation with 0 PATCH — never invent B's binding or re-poll under lock.
    if (owned && !pending && !expired && !controllerDead && !cancelRequested) {
      if (
        window.restorer?.cap_detach_actuator_bound === true
        && window.restorer?.restore_only !== true
      ) {
        if (!capDetachActuator || typeof capDetachActuator.pollAndDetachIfCapped !== "function") {
          fail("refuse: window armed with cap-detach but runtime actuator absent");
        }
        if (!capObservation || !capObservationMatchesLiveWindow(capObservation, window)) {
          writeTailRestorerReceipt(paths.heartbeatReceipt, {
            schema: TAIL_RESTORER_READY_SCHEMA,
            kind: "heartbeat",
            outcome: "alive",
            observed_at: nowAfter,
            pid: process.pid,
            window_id: window.window_id,
            restorer_id: window.restorer?.restorer_id || null,
            phase: window.phase,
            cap_signal_reason: CAP_SIGNAL_REASON.STALE_CAP_OBSERVATION,
            cap_readback_ok: prefetchedCapSignal ? prefetchedCapSignal.readback_ok === true : null,
          });
          return {
            outcome: "idle",
            window,
            reason: CAP_SIGNAL_REASON.STALE_CAP_OBSERVATION,
            cap_signal: projectPersistedCapSignal(prefetchedCapSignal),
          };
        }
        const cap = await capDetachActuator.pollAndDetachIfCapped({
          store,
          now: nowAfter,
          capObservation,
          prefetchedSignal: capObservation.signal,
          allowRepollUnderLock: false,
        });
        if (cap?.reason === CAP_SIGNAL_REASON.STALE_CAP_OBSERVATION) {
          return {
            outcome: "idle",
            window,
            reason: CAP_SIGNAL_REASON.STALE_CAP_OBSERVATION,
            cap_signal: projectPersistedCapSignal(cap.signal || prefetchedCapSignal),
          };
        }
        if (cap?.signal?.a2 && cap.signal.a2.pass === false) {
          writeTailRestorerReceipt(paths.heartbeatReceipt, {
            schema: TAIL_RESTORER_READY_SCHEMA,
            kind: "heartbeat",
            outcome: "a2-failed",
            observed_at: nowAfter,
            pid: process.pid,
            window_id: window.window_id,
            restorer_id: window.restorer?.restorer_id || null,
            phase: window.phase,
            // Allowlisted A2 projection only — never raw body/a2.
            a2: projectPersistedCapA2(cap.signal.a2),
            events_seen: typeof cap.signal.events_seen === "number"
              ? cap.signal.events_seen
              : null,
          });
        }
        if (cap?.actuated === true && (cap.proved === true || cap.action === "already-restored")) {
          const restoredWindow = cap.result?.window || (await store.read()) || window;
          const attachmentRestore = projectAttachmentRestore({
            proved: cap.proved === true,
            action: cap.action || "cap-detach",
            outcome: "cap-detach",
            expired: false,
            reason: "owned-cap-detach",
          });
          const sinkClose = await attemptOwnedSinkClose({
            closeSinkWindow,
            captureFinalAggregate,
            windowId: restoredWindow.window_id,
            paths,
            now: nowAfter,
            reason: "owned-cap-detach",
            expiresAt: restoredWindow?.expires_at || window.expires_at || null,
          });
          const receipt = writeTailRestorerReceipt(paths.terminalReceipt, {
            schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
            kind: "restorer",
            outcome: cap.action || "cap-detach",
            observed_at: nowAfter,
            window_id: restoredWindow.window_id,
            proved: cap.proved === true,
            cap_reached: true,
            events_seen: typeof cap.signal?.events_seen === "number"
              ? cap.signal.events_seen
              : null,
            apply_overshoot: typeof cap.signal?.apply_overshoot === "number"
              ? cap.signal.apply_overshoot
              : null,
            a2: projectPersistedCapA2(cap.signal?.a2),
            version_guard: cap.version_guard || cap.result?.version_guard || null,
            controller_death: false,
            cancel_requested: false,
            expired: false,
            reason: "owned-cap-detach",
            attachment_restore: attachmentRestore,
            sink_close: sinkClose,
          });
          clearPendingSinkCloseIfProved(paths, sinkClose);
          return {
            ...cap.result,
            outcome: "cap-detach",
            action: cap.action || "cap-detach",
            proved: cap.proved === true,
            terminal_receipt: receipt,
            window: restoredWindow,
            sink_close: sinkClose,
          };
        }
      }
      return {
        outcome: "idle",
        window,
        reason: "owned-window-active-until-deadline",
        // Prefetched signal is already an allowlisted scalar projection.
        cap_signal: projectPersistedCapSignal(prefetchedCapSignal),
      };
    }

    if (!pending && !owned && !expired && !controllerDead && !cancelRequested) {
      return { outcome: "idle", window };
    }

    if (pending && !expired && !controllerDead && !cancelRequested) {
      const reconciled = await reconcileTailPendingMutation({ window, transport, now: nowAfter });
      await store.write(reconciled.window, { expectedWindowId: window.window_id });
      if (reconciled.outcome === "refused-conflict") {
        const closeWindowId = reconciled.window?.window_id || window.window_id;
        const attachmentRestore = projectAttachmentRestore({
          proved: false,
          action: "refuse-conflict",
          outcome: "refused-conflict",
          reason: reconciled.receipt?.reason || "refused-conflict",
        });
        const sinkClose = await attemptOwnedSinkClose({
          closeSinkWindow,
          captureFinalAggregate,
          windowId: closeWindowId,
          paths,
          now: nowAfter,
          reason: "refused-conflict",
          expiresAt: reconciled.window?.expires_at || window.expires_at || null,
        });
        const receipt = writeTailRestorerReceipt(paths.terminalReceipt, {
          ...reconciled.receipt,
          attachment_restore: attachmentRestore,
          sink_close: sinkClose,
        });
        clearPendingSinkCloseIfProved(paths, sinkClose);
        return { ...reconciled, terminal_receipt: receipt, sink_close: sinkClose };
      }
      writeTailRestorerReceipt(paths.heartbeatReceipt, {
        schema: TAIL_RESTORER_READY_SCHEMA,
        kind: "heartbeat",
        outcome: reconciled.outcome,
        observed_at: nowAfter,
        pid: process.pid,
        window_id: reconciled.window.window_id,
        restorer_id: reconciled.window.restorer?.restorer_id || null,
        phase: reconciled.window.phase,
      });
      return reconciled;
    }

    if (pending && pendingIssuedUnacked(window)) {
      const reconciled = await reconcileTailPendingMutation({ window, transport, now: nowAfter });
      await store.write(reconciled.window, { expectedWindowId: window.window_id });
      if (reconciled.outcome === "retained-pending-unknown") {
        writeTailRestorerReceipt(paths.heartbeatReceipt, {
          schema: TAIL_RESTORER_READY_SCHEMA,
          kind: "heartbeat",
          outcome: reconciled.outcome,
          observed_at: nowAfter,
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
        const closeWindowId = reconciled.window?.window_id || window.window_id;
        const attachmentRestore = projectAttachmentRestore({
          proved: false,
          action: "refuse-conflict",
          outcome: "refused-conflict",
          expired,
          reason: reconciled.receipt?.reason || "refused-conflict",
        });
        const sinkClose = await attemptOwnedSinkClose({
          closeSinkWindow,
          captureFinalAggregate,
          windowId: closeWindowId,
          paths,
          now: nowAfter,
          reason: "refused-conflict",
          expiresAt: reconciled.window?.expires_at || window.expires_at || null,
        });
        const receipt = writeTailRestorerReceipt(paths.terminalReceipt, {
          ...reconciled.receipt,
          controller_death: controllerDead,
          cancel_requested: cancelRequested,
          expired,
          attachment_restore: attachmentRestore,
          sink_close: sinkClose,
        });
        clearPendingSinkCloseIfProved(paths, sinkClose);
        return { ...reconciled, terminal_receipt: receipt, sink_close: sinkClose };
      }
    }

    const restored = await runIndependentTailRestorer({
      store,
      transport,
      versionTransport,
      now: nowAfter,
      alreadyLocked: true,
    });

    const versionGuard = restored.version_guard || null;
    const freshBothSides = Boolean(
      versionGuard
      && versionGuard.before_actuator
      && versionGuard.before_actuator !== VERSION_GUARD_LABEL.NOT_PERFORMED
      && versionGuard.after_actuator
      && versionGuard.after_actuator !== VERSION_GUARD_LABEL.NOT_PERFORMED,
    );

    if (
      restored.action === "retain-owned-unknown"
      || restored.action === "confirm-pending"
      || restored.action === "restore-readback-mismatch"
    ) {
      writeTailRestorerReceipt(paths.heartbeatReceipt, {
        schema: TAIL_RESTORER_READY_SCHEMA,
        kind: "heartbeat",
        outcome: restored.action,
        observed_at: nowAfter,
        pid: process.pid,
        window_id: restored.window.window_id,
        restorer_id: restored.window.restorer?.restorer_id || null,
        phase: restored.window.phase,
        proved: false,
        ownership_preserved: true,
        controller_death: controllerDead,
        cancel_requested: cancelRequested,
        expired: restored.expired === true,
        version_guard: versionGuard,
        fresh_get_before_and_after_actuator: freshBothSides,
      });
      return restored;
    }

    // Terminal restore (expiry / controller-death / cancel / proved restore):
    // close the AggregateSink window so the next window starts FRESH. Pending
    // cleanup is durable and retried on later ticks if this close is unproved.
    const closeWindowId = restored.window?.window_id || window.window_id;
    const attachmentRestore = projectAttachmentRestore({
      proved: restored.proved === true,
      action: typeof restored.action === "string" ? restored.action : null,
      outcome: restored.proved ? restored.action : "blocked",
      expired: restored.expired === true,
      reason: restored.receipt?.reason || null,
    });
    const sinkClose = await attemptOwnedSinkClose({
      closeSinkWindow,
      captureFinalAggregate,
      windowId: closeWindowId,
      paths,
      now: nowAfter,
      reason: restored.receipt?.reason || restored.action || "terminal-restore",
      expiresAt: restored.window?.expires_at || window.expires_at || null,
    });
    const receipt = writeTailRestorerReceipt(paths.terminalReceipt, {
      schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
      kind: "restorer",
      outcome: restored.proved ? restored.action : "blocked",
      observed_at: nowAfter,
      window_id: restored.window.window_id,
      proved: restored.proved,
      expired: restored.expired === true,
      classification: restored.classification?.class || null,
      after_sha256: restored.receipt?.after_sha256 || null,
      baseline_sha256: restored.receipt?.baseline_sha256 || null,
      reason: restored.receipt?.reason || null,
      controller_death: controllerDead,
      cancel_requested: cancelRequested,
      version_guard: versionGuard,
      fresh_get_before_and_after_actuator: freshBothSides,
      attachment_restore: attachmentRestore,
      sink_close: sinkClose,
    });
    clearPendingSinkCloseIfProved(paths, sinkClose);
    return { ...restored, terminal_receipt: receipt, sink_close: sinkClose };
  });
}

export function createBoundScriptSettingsTailTransport(env, window) {
  const bound = assertTailTransportTargetMatchesWindow(env, window);
  return createScriptSettingsTailConsumersTransport({
    accountId: bound.accountId,
    scriptName: bound.workerId,
    token: env.CLOUDFLARE_API_TOKEN,
  });
}

/**
 * Bound dual-view Tail transport for probe + guardian restoration.
 * Script-settings remains the write path; beta Worker GET is the independent
 * effective empty view. worker_id → script mapping is verified on every beta GET.
 */
export function createBoundDualViewTailConsumersTransport(env, window) {
  const bound = assertTailTransportTargetMatchesWindow(env, window);
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || !token) {
    fail("CLOUDFLARE_API_TOKEN is required for dual-view Tail transport");
  }
  const scriptSettingsTransport = createScriptSettingsTailConsumersTransport({
    accountId: bound.accountId,
    scriptName: bound.workerId,
    token,
  });
  const betaTransport = createBetaWorkerTailConsumersTransport({
    accountId: bound.accountId,
    workerId: bound.workerId,
    scriptName: bound.workerId,
    token,
  });
  return createDualViewTailConsumersTransport({
    scriptSettingsTransport,
    betaTransport,
  });
}

/**
 * Deployments versionTransport bound to the window's consumer-bound version
 * evidence. Same guard the actuator tests cover: account + script + URL/path
 * provenance must match before a fresh GET is trusted.
 */
export function createBoundDeploymentsVersionTransport(env, window) {
  if (!window || typeof window !== "object") {
    fail("Tail attachment window is required for bound deployments versionTransport");
  }
  const evidence = window.version_evidence;
  if (!evidence || evidence.present !== true || !evidence.consumer) {
    fail("bound consumer version evidence is required for deployments versionTransport");
  }
  const accountId = typeof env.CLOUDFLARE_ACCOUNT_ID === "string" && env.CLOUDFLARE_ACCOUNT_ID.trim()
    ? env.CLOUDFLARE_ACCOUNT_ID.trim()
    : null;
  if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID is required for deployments versionTransport");
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || !token) {
    fail("CLOUDFLARE_API_TOKEN is required for deployments versionTransport");
  }
  const accountSha = createHash("sha256").update(accountId).digest("hex");
  if (accountSha !== window.account_id_sha256) {
    fail("CLOUDFLARE_ACCOUNT_ID does not match window account_id_sha256");
  }
  if (accountSha !== evidence.account_id_sha256) {
    fail("CLOUDFLARE_ACCOUNT_ID does not match bound version evidence account");
  }
  const consumer = evidence.consumer;
  const transport = createDeploymentsVersionTransport({
    accountId,
    scriptName: consumer.service,
    token,
    environment: consumer.environment,
    namespace: consumer.namespace,
  });
  assertVersionTransportMatchesBound(transport, evidence);
  return transport;
}


/**
 * Hard READY gate before owned self/producer attach.
 * Refuses absent, malformed, foreign, stale, or not-independent READY receipts.
 * Requires schema, independent_process, exact window/restorer binding, and a
 * live child pid (or an injected pidAlive probe). readyPresent:true alone is
 * never enough.
 */
export function assertRestorerReadyBeforeOwnedAttach({
  readyReceipt = null,
  readyPresent = null,
  expectedWindowId = null,
  expectedRestorerId = null,
  expectedGeneration = null,
  pidAlive = isProcessAlive,
  label = "restorer",
} = {}) {
  // readyPresent alone must never authorize attach.
  if (readyPresent === true && !(readyReceipt && typeof readyReceipt === "object")) {
    fail(`refuse owned attach: ${label} READY receipt object is required (readyPresent alone is insufficient)`);
  }
  if (!readyReceipt || typeof readyReceipt !== "object") {
    fail(`refuse owned attach: ${label} READY receipt is absent`);
  }
  const receipt = readyReceipt;
  if (receipt.schema !== TAIL_RESTORER_READY_SCHEMA) {
    fail(`refuse owned attach: ${label} READY receipt schema mismatch`);
  }
  if (receipt.kind != null && receipt.kind !== "ready") {
    fail(`refuse owned attach: ${label} READY receipt kind is not ready`);
  }
  if (receipt.independent_process !== true) {
    fail(`refuse owned attach: ${label} READY is not an independent process`);
  }
  if (typeof expectedWindowId === "string" && expectedWindowId) {
    if (receipt.window_id !== expectedWindowId) {
      fail(`refuse owned attach: ${label} READY window_id does not match owned window`);
    }
  } else if (typeof receipt.window_id !== "string" || !receipt.window_id) {
    fail(`refuse owned attach: ${label} READY receipt missing window_id`);
  }
  if (typeof expectedRestorerId === "string" && expectedRestorerId) {
    if (receipt.restorer_id !== expectedRestorerId) {
      fail(`refuse owned attach: ${label} READY restorer_id does not match owned restorer`);
    }
  } else if (typeof receipt.restorer_id !== "string" || !receipt.restorer_id) {
    fail(`refuse owned attach: ${label} READY receipt missing restorer_id`);
  }
  // Mandatory exact admitted generation — missing/foreign/stale all refuse.
  if (!Number.isInteger(expectedGeneration)) {
    fail(`refuse owned attach: ${label} owned window_generation is required`);
  }
  const receiptGen = receipt.window_generation ?? receipt.generation;
  if (!Number.isInteger(receiptGen)) {
    fail(`refuse owned attach: ${label} READY receipt missing window_generation`);
  }
  if (receiptGen !== expectedGeneration) {
    fail(`refuse owned attach: ${label} READY generation does not match owned window`);
  }
  const pid = Number.isInteger(receipt.pid) ? receipt.pid : null;
  if (pid == null || pid <= 0) {
    fail(`refuse owned attach: ${label} READY receipt missing live pid`);
  }
  const aliveProbe = typeof pidAlive === "function" ? pidAlive : isProcessAlive;
  if (aliveProbe(pid) !== true) {
    fail(`refuse owned attach: ${label} READY child pid is not alive`);
  }
  return {
    ok: true,
    label,
    ready_present: true,
    independent_process: true,
    window_id: receipt.window_id,
    restorer_id: receipt.restorer_id,
    window_generation: receiptGen,
    pid,
    version_guard: receipt.version_guard || null,
    // Version/consumer binding is enforced by mutateOwnedTailAttachment's
    // versionTransport gate — this helper does not re-check it.
    version_binding_checked_here: false,
  };
}

/**
 * Attach path that enforces the READY gate inside mutateOwnedTailAttachment
 * before any version GET, intent write, or PATCH (0 PATCH on refuse).
 */
export async function mutateOwnedTailAttachmentWithReadyGate({
  readyReceipt = null,
  pidAlive = isProcessAlive,
  label = "restorer",
  ...mutateArgs
} = {}) {
  const beforeOwnedAttach = ({ window }) => {
    assertRestorerReadyBeforeOwnedAttach({
      readyReceipt,
      expectedWindowId: window?.window_id || null,
      expectedRestorerId: window?.restorer?.restorer_id || null,
      expectedGeneration: window?.window_generation ?? null,
      pidAlive,
      label,
    });
  };
  return mutateOwnedTailAttachment({
    ...mutateArgs,
    beforeOwnedAttach,
  });
}

/**
 * Pre-spawn / pre-loop check: when the window is armed with a durable
 * cap-detach actuator, the child env must provision the runtime actuator.
 * restore_only windows skip this (no durable cap-detach expected).
 */
export function assertDurableCapDetachRuntimeProvisioned({
  window = null,
  env = process.env,
  capDetachActuator = null,
} = {}) {
  if (window?.restorer?.restore_only === true) {
    return { ok: true, restore_only: true, required: false };
  }
  if (window?.restorer?.cap_detach_actuator_bound !== true) {
    return { ok: true, restore_only: false, required: false };
  }
  if (capDetachActuator && typeof capDetachActuator.pollAndDetachIfCapped === "function") {
    return { ok: true, restore_only: false, required: true, runtime_present: true };
  }
  if (env?.CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE) {
    return { ok: true, restore_only: false, required: true, runtime_present: "module" };
  }
  const readbackUrl = env?.CITYSCROLL_TAIL_SINK_READBACK_URL;
  const readbackToken = env?.CITYSCROLL_TAIL_SINK_READBACK_TOKEN;
  if (typeof readbackUrl === "string" && readbackUrl
    && typeof readbackToken === "string" && readbackToken && readbackToken !== "unset") {
    return { ok: true, restore_only: false, required: true, runtime_present: "env-readback" };
  }
  fail(
    "refuse to run: window armed with cap-detach actuator but runtime actuator is absent",
  );
}

/**
 * Producer window outcome independent of a never-READY self guardian.
 * Self deviation is surfaced separately and must not poison restore_proven.
 * An action/outcome label alone is never proof — require proved:true (or
 * attachment_restore.proved:true). Foreign window terminals refuse.
 */
export function observeProducerTailWindowOutcome({
  producerTerminal = null,
  producerBetaEmpty = null,
  expectedWindowId = null,
  selfReadyPresent = null,
  selfTerminal = null,
  selfOwnedDetached = null,
  sinkClosed = null,
  tombstoneProved = null,
  now = new Date().toISOString(),
} = {}) {
  const terminalObj = producerTerminal && typeof producerTerminal === "object"
    ? producerTerminal
    : null;
  let foreignTerminal = false;
  let missingOwnership = false;
  if (terminalObj && typeof expectedWindowId === "string" && expectedWindowId) {
    const terminalWindowId = terminalObj.window_id
      || terminalObj.attachment_restore?.window_id
      || null;
    if (typeof terminalWindowId !== "string" || !terminalWindowId) {
      // Missing ownership identity stays unproved (not an implicit match).
      missingOwnership = true;
    } else if (terminalWindowId !== expectedWindowId) {
      foreignTerminal = true;
    }
  }
  // Label-only (action/outcome without proved:true) is NOT proof.
  const producerProved = !foreignTerminal
    && !missingOwnership
    && terminalObj
    && (
      terminalObj.proved === true
      || terminalObj.attachment_restore?.proved === true
    )
    && terminalObj.proved !== false
    && terminalObj.attachment_restore?.proved !== false;
  const betaEmpty = producerBetaEmpty === true;
  const selfNeverReady = selfReadyPresent !== true;
  const selfDetached = selfOwnedDetached === true;
  const selfTerminalPresent = Boolean(selfTerminal && typeof selfTerminal === "object");
  // When self never READY / already owned-detached, do not wait on self terminal.
  const selfDeviation = selfNeverReady
    ? {
      kind: "self-never-ready",
      ready_present: false,
      terminal_present: selfTerminalPresent,
      owned_detached: selfDetached,
      collector_cpu_ms: "UNKNOWN",
    }
    : (selfDetached && !selfTerminalPresent
      ? {
        kind: "self-owned-detached-without-terminal",
        ready_present: true,
        terminal_present: false,
        owned_detached: true,
        collector_cpu_ms: "UNKNOWN",
      }
      : null);

  const restoreProven = producerProved === true && betaEmpty === true;
  let outcome = "UNKNOWN";
  let stopReason = null;
  if (foreignTerminal) {
    outcome = "failed";
    stopReason = "producer-terminal-foreign-window";
  } else if (missingOwnership) {
    outcome = "failed";
    stopReason = "producer-terminal-missing-window-id";
  } else if (restoreProven) {
    outcome = selfDeviation
      ? "restored-proven-producer;self-deviation"
      : "restored-proven";
  } else if (producerTerminal == null) {
    outcome = "failed";
    stopReason = "producer-guardian-terminal-timeout";
  } else if (!betaEmpty) {
    outcome = "failed";
    stopReason = "producer-beta-not-empty";
  } else {
    outcome = "failed";
    stopReason = "producer-restore-unproved";
  }

  return {
    schema: TAIL_PRODUCER_OUTCOME_SCHEMA,
    kind: "producer-tail-window-outcome",
    observed_at: typeof now === "string" ? now : new Date().toISOString(),
    outcome,
    stop_reason: stopReason,
    restore_proven: restoreProven,
    producer: {
      terminal_present: Boolean(producerTerminal),
      proved: producerProved === true,
      beta_empty: betaEmpty,
      action: producerTerminal?.action || producerTerminal?.outcome || null,
      foreign_window: foreignTerminal,
      missing_window_id: missingOwnership,
    },
    self: selfDeviation || {
      kind: "self-ready",
      ready_present: true,
      terminal_present: selfTerminalPresent,
      owned_detached: selfDetached,
      collector_cpu_ms: null,
    },
    sink_closed: sinkClosed === true,
    tombstone_proved: tombstoneProved === true,
    // Never-READY or owned-detached self must not require self terminal.
    waits_on_self_terminal: (selfNeverReady || selfDetached) ? false : true,
  };
}

/**
 * Prefer the validated pre-tombstone AggregateSink sample for measured
 * collection summary. Post-cleanup tombstone zeros must not become measured
 * cohort/cost values. Tombstone proof stays a separate field.
 */
export function selectPreTombstoneCollectionSample({
  finalAggregateReceipt = null,
  lastLiveSample = null,
  postCleanupReadback = null,
  expectedWindowId = null,
} = {}) {
  const receipt = finalAggregateReceipt && typeof finalAggregateReceipt === "object"
    ? finalAggregateReceipt
    : null;
  const windowId = expectedWindowId
    || receipt?.window_id
    || lastLiveSample?.window_id
    || null;
  if (receipt && isImmutableFinalAggregateSnapshot(receipt, receipt.window_id || windowId)) {
    if (!expectedWindowId || receipt.window_id === expectedWindowId) {
      return {
        source: "final-aggregate-receipt",
        sample_kind: receipt.sample_kind || "last-sample-before-tombstone",
        events_seen: Number.isInteger(receipt.events_seen) ? receipt.events_seen : null,
        a2: receipt.a2 ?? null,
        // Keep typed event counts and CPU distributions SEPARATE — never mix.
        by_cohort: projectTypedCohortEventCounts(receipt.by_cohort),
        by_cohort_cpu: receipt.by_cohort_cpu && typeof receipt.by_cohort_cpu === "object"
          ? receipt.by_cohort_cpu
          : null,
        cost_vector: projectAllowlistedCostVector(receipt.cost_vector, {
          collector_do_requests: receipt.collector_do_requests,
          collector_storage_ops: receipt.collector_storage_ops,
          collector_cpu_ms: receipt.collector_cpu_ms,
        }),
        by_event_type: receipt.by_event_type ?? null,
        by_deployed_revision: receipt.by_deployed_revision ?? null,
        collector_cpu_ms: receipt.collector_cpu_ms ?? receipt.cost_vector?.collector_cpu_ms ?? null,
        measured: true,
        arrivals_between_snapshot_and_cleanup:
          receipt.arrivals_between_snapshot_and_cleanup ?? "UNKNOWN",
      };
    }
  }
  const live = lastLiveSample && typeof lastLiveSample === "object" ? lastLiveSample : null;
  if (live && (live.from_tombstone !== true) && (live.closed !== true)) {
    const liveCounters = live.counters && typeof live.counters === "object" ? live.counters : null;
    return {
      source: "last-live-sample",
      sample_kind: "last-sample-before-tombstone",
      events_seen: Number.isInteger(live.events_seen) ? live.events_seen : null,
      a2: live.a2 ?? null,
      by_cohort: projectTypedCohortEventCounts(live.by_cohort ?? liveCounters?.by_cohort),
      by_cohort_cpu: (liveCounters?.by_cohort_cpu || live.by_cohort_cpu)
        && typeof (liveCounters?.by_cohort_cpu || live.by_cohort_cpu) === "object"
        ? (liveCounters?.by_cohort_cpu || live.by_cohort_cpu)
        : null,
      cost_vector: projectAllowlistedCostVector(live.cost_vector, liveCounters),
      by_event_type: liveCounters?.by_event_type || live.by_event_type || null,
      by_deployed_revision: liveCounters?.by_deployed_revision || live.by_deployed_revision || null,
      collector_cpu_ms: liveCounters?.collector_cpu_ms
        ?? live.cost_vector?.collector_cpu_ms
        ?? live.collector_cpu_ms
        ?? null,
      measured: Number.isInteger(live.events_seen),
      arrivals_between_snapshot_and_cleanup: "UNKNOWN",
    };
  }
  // Do not promote post-cleanup tombstone zeros to measured collection.
  const post = postCleanupReadback && typeof postCleanupReadback === "object"
    ? postCleanupReadback
    : null;
  return {
    source: "unknown",
    sample_kind: "last-sample-unknown",
    events_seen: null,
    a2: null,
    cost_vector: null,
    by_cohort: null,
    by_cohort_cpu: null,
    by_event_type: null,
    by_deployed_revision: null,
    collector_cpu_ms: "UNKNOWN",
    measured: false,
    arrivals_between_snapshot_and_cleanup: "UNKNOWN",
    tombstone_readback_events_seen: Number.isInteger(post?.events_seen) ? post.events_seen : null,
    note: "no validated pre-tombstone sample; post-cleanup zeros are not measured collection",
  };
}

/**
 * Start a supervised Tail restorer child against a durable runner copy.
 * Tests may pass a runnerPath override that imports the repo modules.
 *
 * Credential env is sanitized to exactly ONE source (prefer TOKEN_FILE).
 * Child stderr is parsed through a bounded in-memory pipe into allowlisted
 * startup-diagnosis fields only — no raw stderr file or tail is persisted.
 */
export function startSupervisedTailRestorerProcess({
  windowPath,
  windowId,
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  runnerPath = null,
  nodeExecPath = process.execPath,
  nodeArgs = [],
  env = process.env,
  detached = true,
  pollMs = DEFAULT_TAIL_POLL_MS,
  tokenFile = null,
  preferTokenFile = true,
  skipCredentialCompose = false,
} = {}) {
  const paths = tailRestorerPaths(stateRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.root, "receipts"), { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  if (killSwitchEngaged(stateRoot)) fail("tail attachment restorer kill switch is engaged");

  assignTailWindowForRestorer({ windowPath, windowId, stateRoot });

  const runner = runnerPath || paths.durableRunner;
  if (!existsSync(runner)) {
    fail(`durable Tail restorer runner missing at ${runner}`);
  }

  // Cap-detach runtime provision is enforced in the durable child main /
  // runTailRestorerLoop (and by callers via assertDurableCapDetachRuntimeProvisioned)
  // so intentional child-failure diagnosis tests can still spawn. restore_only
  // windows skip the bound-actuator requirement at arm time.

  const composed = skipCredentialCompose
    ? {
      env: { ...env },
      credential_source: "passthrough",
      has_TOKEN: Boolean(env?.CLOUDFLARE_API_TOKEN),
      has_TOKEN_FILE: Boolean(env?.CLOUDFLARE_API_TOKEN_FILE),
      incoming_had_TOKEN: Boolean(env?.CLOUDFLARE_API_TOKEN),
      incoming_had_TOKEN_FILE: Boolean(env?.CLOUDFLARE_API_TOKEN_FILE),
      sanitized_dual_credential: false,
    }
    : composeGuardianChildEnv(env, { tokenFile, preferTokenFile });

  const childEnv = {
    ...composed.env,
    CITYSCROLL_TAIL_ATTACHMENT_RESTORER_STATE: stateRoot,
  };
  // Defense in depth: after compose, never leave both credential vars set.
  if (!skipCredentialCompose && childEnv.CLOUDFLARE_API_TOKEN && childEnv.CLOUDFLARE_API_TOKEN_FILE) {
    delete childEnv.CLOUDFLARE_API_TOKEN;
  }

  const diagnoser = createBoundedStderrDiagnoser();
  const argvPrefix = Array.isArray(nodeArgs) ? nodeArgs.filter((a) => typeof a === "string") : [];
  const child = spawn(nodeExecPath, [
    ...argvPrefix,
    runner,
    "--window-state", windowPath,
    "--state-root", stateRoot,
    "--poll-ms", String(pollMs),
  ], {
    detached,
    stdio: ["ignore", "ignore", "pipe"],
    env: childEnv,
  });

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      try { diagnoser.onChunk(chunk); } catch { /* diagnosis best-effort */ }
    });
  }

  const allowlistedDiagnosis = (extra = {}) => {
    const snap = diagnoser.snapshot();
    return {
      failure_code: snap.failure_code,
      exit_code: extra.exit_code ?? null,
      exit_signal: extra.exit_signal ?? null,
      has_TOKEN: composed.has_TOKEN,
      has_TOKEN_FILE: composed.has_TOKEN_FILE,
      credential_source: composed.credential_source,
      sanitized_dual_credential: composed.sanitized_dual_credential === true,
      stderr_bytes_seen: snap.stderr_bytes_seen,
      stderr_bytes_omitted: snap.stderr_bytes_omitted,
      stderr_lines_seen: snap.stderr_lines_seen,
      stderr_lines_omitted: snap.stderr_lines_omitted,
      stderr_diag_cap_bytes: snap.stderr_diag_cap_bytes,
      raw_stderr_persisted: false,
    };
  };

  const writeChildExitReceipts = (code, signal) => {
    const diagnosis = allowlistedDiagnosis({ exit_code: code, exit_signal: signal });
    const exitReceipt = writeTailRestorerReceipt(paths.childExitReceipt, {
      schema: TAIL_RESTORER_RUNTIME_SCHEMA,
      kind: "child-exit",
      observed_at: new Date().toISOString(),
      pid: child.pid,
      state_root: stateRoot,
      window_id: windowId,
      runner,
      ready_present: existsSync(paths.readyReceipt),
      ...diagnosis,
    });
    if (!existsSync(paths.readyReceipt)) {
      writeTailRestorerReceipt(paths.childFailedBeforeReadyReceipt, {
        schema: TAIL_RESTORER_RUNTIME_SCHEMA,
        kind: "child-failed-before-ready",
        observed_at: new Date().toISOString(),
        pid: child.pid,
        state_root: stateRoot,
        window_id: windowId,
        runner,
        reason_code: diagnosis.failure_code === GUARDIAN_STARTUP_FAILURE_CODE.NONE
          ? GUARDIAN_STARTUP_FAILURE_CODE.UNKNOWN_STARTUP_FAILURE
          : diagnosis.failure_code,
        child_exit_receipt: paths.childExitReceipt,
        ...diagnosis,
      });
    }
    return exitReceipt;
  };

  child.once("exit", (code, signal) => {
    try { writeChildExitReceipts(code, signal); } catch { /* receipt best-effort */ }
  });
  child.once("error", () => {
    try {
      const diagnosis = allowlistedDiagnosis({
        exit_code: null,
        exit_signal: null,
      });
      writeTailRestorerReceipt(paths.childFailedBeforeReadyReceipt, {
        schema: TAIL_RESTORER_RUNTIME_SCHEMA,
        kind: "child-failed-before-ready",
        observed_at: new Date().toISOString(),
        pid: child.pid || null,
        state_root: stateRoot,
        window_id: windowId,
        runner,
        ...diagnosis,
        failure_code: GUARDIAN_STARTUP_FAILURE_CODE.SPAWN_ERROR,
        reason_code: GUARDIAN_STARTUP_FAILURE_CODE.SPAWN_ERROR,
      });
    } catch { /* receipt best-effort */ }
  });

  if (detached) child.unref();

  // Parent spawn receipt is separate from the child's loop start.json so
  // credential metadata is never overwritten when ready is reached.
  writeTailRestorerReceipt(paths.startSpawnReceipt, {
    schema: TAIL_RESTORER_RUNTIME_SCHEMA,
    kind: "start-spawn",
    started_at: new Date().toISOString(),
    pid: child.pid,
    state_root: stateRoot,
    window_path: windowPath,
    window_id: windowId,
    runner,
    node_exec_path: nodeExecPath,
    node_args: argvPrefix,
    credential_source: composed.credential_source,
    has_TOKEN: composed.has_TOKEN,
    has_TOKEN_FILE: composed.has_TOKEN_FILE,
    incoming_had_TOKEN: composed.incoming_had_TOKEN,
    incoming_had_TOKEN_FILE: composed.incoming_had_TOKEN_FILE,
    sanitized_dual_credential: composed.sanitized_dual_credential,
    raw_stderr_persisted: false,
    child_exit_receipt: paths.childExitReceipt,
    child_failed_before_ready_receipt: paths.childFailedBeforeReadyReceipt,
  });
  // Keep writing start.json for backward-compatible parent spawn observers.
  writeTailRestorerReceipt(paths.startReceipt, {
    schema: TAIL_RESTORER_RUNTIME_SCHEMA,
    kind: "start-spawn",
    started_at: new Date().toISOString(),
    pid: child.pid,
    state_root: stateRoot,
    window_path: windowPath,
    window_id: windowId,
    runner,
    credential_source: composed.credential_source,
    has_TOKEN: composed.has_TOKEN,
    has_TOKEN_FILE: composed.has_TOKEN_FILE,
    raw_stderr_persisted: false,
  });
  writeFileSync(paths.pidFile, `${child.pid}\n`, { mode: 0o600 });
  return {
    pid: child.pid,
    child,
    paths,
    credential: {
      source: composed.credential_source,
      has_TOKEN: composed.has_TOKEN,
      has_TOKEN_FILE: composed.has_TOKEN_FILE,
      sanitized_dual_credential: composed.sanitized_dual_credential,
    },
  };
}

export function stopSupervisedTailRestorerProcess({
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  signal = "SIGTERM",
} = {}) {
  const paths = tailRestorerPaths(stateRoot);
  let parsed = null;
  if (existsSync(paths.pidFile)) {
    parsed = Number(readFileSync(paths.pidFile, "utf8").trim());
  }
  if (Number.isInteger(parsed) && parsed > 0 && isProcessAlive(parsed)) {
    try { process.kill(parsed, signal); } catch { /* already gone */ }
  }
  return { pid: parsed };
}

export function accountIdSha256(accountId) {
  return createHash("sha256").update(String(accountId)).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Copy the Tail restorer CLI + libs into a durable state root so the guardian
 * process survives disposal of the source checkout. Rewrites runner imports to
 * the durable lib directory.
 */
export function installDurableTailRestorerRunner({
  stateRoot = DEFAULT_TAIL_RESTORER_STATE_ROOT,
  repoRoot,
  runnerSourcePath = null,
  libDirSource = null,
} = {}) {
  if (typeof repoRoot !== "string" || !repoRoot) fail("repoRoot is required to install the Tail restorer");
  const paths = tailRestorerPaths(stateRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.durableLibDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(paths.root, "receipts"), { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });

  const runnerSrc = runnerSourcePath || join(repoRoot, "tools/worker_tail_attachment_restorer.mjs");
  const libSrc = libDirSource || join(repoRoot, "tools/lib");
  if (!existsSync(runnerSrc)) fail(`Tail restorer runner source missing at ${runnerSrc}`);

  const libFiles = [
    "worker_tail_attachment.mjs",
    "worker_tail_attachment_restorer.mjs",
    "worker_observability_settings.mjs",
  ];
  for (const name of libFiles) {
    const src = join(libSrc, name);
    if (!existsSync(src)) fail(`Tail restorer lib source missing at ${src}`);
    cpSync(src, join(paths.durableLibDir, name));
  }
  cpSync(runnerSrc, paths.durableRunner);

  // Durable runner must import from ./lib next to itself.
  let runnerText = readFileSync(paths.durableRunner, "utf8");
  runnerText = runnerText
    .replaceAll('from "./lib/worker_tail_attachment.mjs"', 'from "./lib/worker_tail_attachment.mjs"')
    .replaceAll(
      'from "./lib/worker_tail_attachment_restorer.mjs"',
      'from "./lib/worker_tail_attachment_restorer.mjs"',
    );
  // Source CLI uses ./lib/... already when placed at tools/; after copy to
  // stateRoot/run.mjs the same relative ./lib path resolves to durableLibDir.
  writeFileSync(paths.durableRunner, runnerText, { mode: 0o755 });
  chmodSync(paths.durableRunner, 0o755);

  // Durable restorer lib imports sibling attachment + settings modules.
  const restorerLib = join(paths.durableLibDir, "worker_tail_attachment_restorer.mjs");
  let restorerText = readFileSync(restorerLib, "utf8");
  restorerText = restorerText
    .replaceAll('from "./worker_tail_attachment.mjs"', 'from "./worker_tail_attachment.mjs"')
    .replaceAll(
      'from "./worker_observability_settings.mjs"',
      'from "./worker_observability_settings.mjs"',
    );
  writeFileSync(restorerLib, restorerText, { mode: 0o644 });

  const attachmentLib = join(paths.durableLibDir, "worker_tail_attachment.mjs");
  let attachmentText = readFileSync(attachmentLib, "utf8");
  attachmentText = attachmentText.replaceAll(
    'from "./worker_observability_settings.mjs"',
    'from "./worker_observability_settings.mjs"',
  );
  writeFileSync(attachmentLib, attachmentText, { mode: 0o644 });

  const files = {
    "run.mjs": sha256File(paths.durableRunner),
    "lib/worker_tail_attachment.mjs": sha256File(attachmentLib),
    "lib/worker_tail_attachment_restorer.mjs": sha256File(restorerLib),
    "lib/worker_observability_settings.mjs": sha256File(
      join(paths.durableLibDir, "worker_observability_settings.mjs"),
    ),
  };
  const manifest = {
    schema: "cityscroll.tail_attachment_restorer_install_manifest.v1",
    installed_at: new Date().toISOString(),
    state_root: stateRoot,
    files,
  };
  writeTailRestorerReceipt(join(paths.root, "install-manifest.json"), manifest);
  return { stateRoot, paths, files, manifest };
}

export { DEFAULT_WORKER_ID, isProcessAlive };
