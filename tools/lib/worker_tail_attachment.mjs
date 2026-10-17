/**
 * Tail-attachment window + restore planning.
 *
 * Binds baseline / owned / pending to the exact script-settings ConsumerScript
 * identity (service + environment + namespace), never to list length. A
 * same-count foreign namespace replacement is conflict. Deployed revision is
 * separate evidence from the deployments list, never an invented fixture field
 * on the consumer. Issued-but-unacknowledged writes stay UNKNOWN or owned until
 * reconciled — one baseline GET is not already-restored.
 *
 * Missing or malformed provider GETs stay UNKNOWN / unproved and never become
 * a declared empty list. Planned, issued, and confirmed stay distinct.
 *
 * Reuses the settings-window exclusive directory lock and restorer arming
 * pattern. Provider-native atomic CAS for script-settings remains UNKNOWN.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DEFAULT_WORKER_ID,
  MAX_SETTINGS_WINDOW_SECONDS,
  PROVIDER_OBSERVABILITY_CONCURRENCY,
  betaWorkerUrl,
  scriptSettingsUrl,
  withExclusiveDirLock,
} from "./worker_observability_settings.mjs";

export const TAIL_ATTACHMENT_TERMINAL_PHASES = Object.freeze([
  "restored",
  "expired-restored",
  "closed",
  "refused-conflict",
]);

export const WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA = "cityscroll.worker_tail_attachment_window.v1";
export const WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA = "cityscroll.worker_tail_attachment_receipt.v1";
export const TAIL_ATTACHMENT_RESTORE_MODE = "script-settings-tail-consumers";

function fail(message) {
  throw new Error(message);
}

/** Strict UTC ISO-8601 with optional fractional seconds, e.g. 2026-10-17T14:11:05.000Z */
const STRICT_ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isParseableIsoTimestamp(value) {
  return typeof value === "string"
    && STRICT_ISO_TIMESTAMP_RE.test(value)
    && !Number.isNaN(Date.parse(value));
}

function requireIso(value, path) {
  if (!isParseableIsoTimestamp(value)) {
    fail(`${path} must be an ISO timestamp`);
  }
  return value;
}

function requirePositiveDurationSeconds(value, path) {
  if (!Number.isInteger(value) || value <= 0) fail(`${path} must be a positive integer`);
  if (value > MAX_SETTINGS_WINDOW_SECONDS) {
    fail(`${path} exceeds max ${MAX_SETTINGS_WINDOW_SECONDS}s`);
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function isAdaptedTailConsumers(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "present"),
  );
}

/**
 * Exact script-settings ConsumerScript identity: {service, environment, namespace}.
 * Unknown provider keys are dropped. `script` is accepted only when `service`
 * is absent (legacy probe shape). Namespace is never silently discarded.
 * Revision / version fields are refused here — bind deployed version through
 * an independently acquired deployments readback, never as a fixture field.
 */
export function canonicalizeTailConsumer(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail("tail consumer entry must be an object");
  }
  const service = typeof entry.service === "string" && entry.service.trim()
    ? entry.service.trim()
    : (typeof entry.script === "string" && entry.script.trim() ? entry.script.trim() : null);
  if (!service) fail("tail consumer requires service (or legacy script)");

  if (entry.environment != null && typeof entry.environment !== "string") {
    fail("tail consumer environment must be a string or null");
  }
  const environment = typeof entry.environment === "string" && entry.environment.trim()
    ? entry.environment.trim()
    : null;

  if (
    entry.revision !== undefined
    || entry.version !== undefined
    || entry.script_version !== undefined
  ) {
    fail(
      "tail consumer revision is not a script-settings identity field; "
      + "bind deployed version via deployments readback",
    );
  }

  if (entry.namespace != null && typeof entry.namespace !== "string") {
    fail("tail consumer namespace must be a string or null; refusing unrecognized identity field");
  }
  const namespace = typeof entry.namespace === "string" && entry.namespace.trim()
    ? entry.namespace.trim()
    : null;
  return { service, environment, namespace };
}

/**
 * Canonicalize a provider-declared tail_consumers array.
 * Null/undefined are refused here — use adaptProviderTailConsumers to
 * distinguish a missing GET from a declared empty list.
 */
export function canonicalizeTailConsumers(list) {
  if (list == null) fail("tail_consumers list is missing; use adaptProviderTailConsumers for GET absence");
  if (!Array.isArray(list)) fail("tail_consumers must be an array");
  const canonical = list.map((entry) => canonicalizeTailConsumer(entry));
  canonical.sort((a, b) => {
    const left = `${a.service}\0${a.environment ?? ""}\0${a.namespace ?? ""}`;
    const right = `${b.service}\0${b.environment ?? ""}\0${b.namespace ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return canonical;
}

/**
 * Schema adapter for a provider GET of tail_consumers.
 * Declared [] is present+empty. null/undefined/non-array stay unproved.
 * present:true requires an actual consumers array — never coalesce missing to [].
 */
export function adaptProviderTailConsumers(raw) {
  if (isAdaptedTailConsumers(raw)) {
    if (!raw.present) {
      return {
        present: false,
        reason: typeof raw.reason === "string" && raw.reason ? raw.reason : "missing",
        consumers: null,
        sha256: null,
      };
    }
    if (!Object.prototype.hasOwnProperty.call(raw, "consumers") || !Array.isArray(raw.consumers)) {
      return {
        present: false,
        reason: "missing-consumers",
        consumers: null,
        sha256: null,
      };
    }
    const consumers = canonicalizeTailConsumers(raw.consumers);
    return {
      present: true,
      reason: null,
      consumers,
      sha256: tailConsumersSha256(consumers),
    };
  }
  if (raw == null) {
    return { present: false, reason: "missing", consumers: null, sha256: null };
  }
  if (!Array.isArray(raw)) {
    return { present: false, reason: "malformed", consumers: null, sha256: null };
  }
  const consumers = canonicalizeTailConsumers(raw);
  return {
    present: true,
    reason: null,
    consumers,
    sha256: tailConsumersSha256(consumers),
  };
}

export function tailConsumersSha256(list) {
  return createHash("sha256")
    .update(canonicalJson(canonicalizeTailConsumers(list)))
    .digest("hex");
}

export function assertTailAttachmentWindowWritable(window, {
  expectedWindowId = null,
  allowTerminalWrite = false,
} = {}) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("tail attachment window is invalid");
  }
  if (typeof window.window_id !== "string" || !window.window_id) fail("window_id is required");
  if (expectedWindowId && window.window_id !== expectedWindowId) {
    fail("stale window identity rejected");
  }
  if (!allowTerminalWrite && TAIL_ATTACHMENT_TERMINAL_PHASES.includes(window.phase)) {
    fail(`window phase ${window.phase} is closed; reject stale lifecycle write`);
  }
  return window;
}

/**
 * Refuse arm/attach on terminal or expired windows. Restoration and detach stay
 * allowed through assertTailAttachmentWindowWritable alone.
 */
export function assertTailAttachmentWindowMutable(window, now = new Date().toISOString()) {
  assertTailAttachmentWindowWritable(window);
  const at = requireIso(now, "now");
  if (Date.parse(at) >= Date.parse(window.expires_at)) {
    fail("tail attachment window has expired; refuse arm/attach and capture a fresh window");
  }
  return window;
}

function readOnDiskWindow(path) {
  if (!existsSync(path)) return null;
  if ((statSync(path).mode & 0o077) !== 0) fail("window store must be mode 0600");
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Durable file store mirroring the settings-window fsync/rename boundary.
 * Exclusive mkdir lock (no recursive). Write CAS checks the CURRENT on-disk
 * window_id/generation, never only the incoming payload.
 */
export function createFileTailAttachmentStore(path) {
  if (typeof path !== "string" || !path) fail("window store path is required");
  const lockDir = `${path}.lock`;
  const store = {
    path,
    lockDir,
    async read() {
      return readOnDiskWindow(path);
    },
    async write(window, { expectedWindowId = null, expectedGeneration = null } = {}) {
      assertTailAttachmentWindowWritable(window, { expectedWindowId, allowTerminalWrite: true });
      const current = readOnDiskWindow(path);
      if (expectedWindowId != null) {
        if (!current) {
          fail("stale window identity rejected: durable store is empty");
        }
        if (current.window_id !== expectedWindowId) {
          fail(
            `stale window identity rejected: on-disk ${current.window_id} != expected ${expectedWindowId}`,
          );
        }
      }
      const currentGen = current && Number.isInteger(current.window_generation)
        ? current.window_generation
        : 0;
      if (current && current.window_id === window.window_id) {
        if (expectedGeneration != null) {
          if (expectedGeneration !== currentGen) {
            fail(
              `stale window generation rejected: on-disk ${currentGen} != expected ${expectedGeneration}`,
            );
          }
        } else {
          const incomingGen = Number.isInteger(window.window_generation)
            ? window.window_generation
            : 0;
          if (incomingGen < currentGen) {
            fail(
              `stale window generation rejected: incoming ${incomingGen} < on-disk ${currentGen}`,
            );
          }
        }
      } else if (expectedGeneration != null && current) {
        fail(
          `stale window generation rejected: on-disk window ${current.window_id} does not match incoming`,
        );
      }
      const stamped = {
        ...window,
        window_generation: currentGen + 1,
      };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.next`;
      const payload = `${JSON.stringify(stamped, null, 2)}\n`;
      writeFileSync(temporary, payload, { mode: 0o600 });
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const out = openSync(path, "r");
      try { fsyncSync(out); } finally { closeSync(out); }
      return stamped;
    },
    async withLock(fn, options = {}) {
      return withExclusiveDirLock(lockDir, () => fn(store), options);
    },
  };
  return store;
}

export function openTailAttachmentWindow({
  baselineConsumers = [],
  workerId = DEFAULT_WORKER_ID,
  accountIdSha256,
  now = new Date().toISOString(),
  durationSeconds = MAX_SETTINGS_WINDOW_SECONDS,
  windowId = randomUUID(),
} = {}) {
  const capturedAt = requireIso(now, "now");
  const duration = requirePositiveDurationSeconds(durationSeconds, "durationSeconds");
  if (typeof accountIdSha256 !== "string" || !/^[a-f0-9]{64}$/.test(accountIdSha256)) {
    fail("accountIdSha256 must be a sha256 hex digest");
  }
  if (typeof workerId !== "string" || !workerId.trim()) fail("workerId is required");
  // Baseline capture requires a provider-declared list (including []). Absence
  // must not silently become an empty detach baseline.
  if (baselineConsumers == null) {
    fail("baselineConsumers is missing; capture requires a declared provider list");
  }
  const baseline = canonicalizeTailConsumers(baselineConsumers);
  const expiresAt = new Date(Date.parse(capturedAt) + duration * 1000).toISOString();
  return {
    schema: WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA,
    window_id: windowId,
    worker_id: workerId,
    account_id_sha256: accountIdSha256,
    created_at: capturedAt,
    expires_at: expiresAt,
    duration_seconds: duration,
    phase: "captured",
    restore_mode: TAIL_ATTACHMENT_RESTORE_MODE,
    baseline_consumers: baseline,
    baseline_sha256: tailConsumersSha256(baseline),
    owned_consumers: null,
    owned_sha256: null,
    pending_mutation: null,
    // Deployed-version evidence is separate from ConsumerScript identity.
    version_evidence: null,
    restorer: { armed: false },
    window_generation: 0,
    concurrency_control: PROVIDER_OBSERVABILITY_CONCURRENCY,
    mutations: [],
  };
}

export function armTailAttachmentRestorer(window, {
  now = new Date().toISOString(),
  restorerId = randomUUID(),
} = {}) {
  assertTailAttachmentWindowMutable(window, now);
  return {
    ...window,
    restorer: {
      armed: true,
      restorer_id: restorerId,
      armed_at: requireIso(now, "now"),
    },
  };
}

export function recordTailAttachmentIntent(window, {
  phase,
  beforeSha256,
  intendedConsumers,
  now = new Date().toISOString(),
} = {}) {
  if (!["attach", "detach"].includes(phase)) fail("attachment intent phase is invalid");
  // Attach refuses expiry; detach remains available on an expired owned window.
  if (phase === "attach") {
    assertTailAttachmentWindowMutable(window, now);
  } else {
    assertTailAttachmentWindowWritable(window);
  }
  if (!window.restorer?.armed) fail("independent restorer must be armed before any attachment intent");
  if (typeof beforeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(beforeSha256)) {
    fail("beforeSha256 must be a sha256 hex digest");
  }
  const intended = canonicalizeTailConsumers(intendedConsumers);
  const afterSha256 = tailConsumersSha256(intended);
  const at = requireIso(now, "now");
  return {
    ...window,
    phase: phase === "attach" ? "intent-attach" : "intent-detach",
    pending_mutation: {
      phase,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      intended_consumers: intended,
      recorded_at: at,
      confirmed: false,
      issued: false,
    },
    mutations: [
      ...(window.mutations || []),
      {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "intent",
        phase,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        recorded_at: at,
      },
    ],
  };
}

export function markTailAttachmentIssued(window, { now = new Date().toISOString() } = {}) {
  // Lifecycle refuse first so terminal/expired windows never reach pending checks.
  if (window?.pending_mutation?.phase === "attach") {
    assertTailAttachmentWindowMutable(window, now);
  } else {
    assertTailAttachmentWindowWritable(window);
  }
  if (!window.pending_mutation) fail("no pending attachment mutation to mark issued");
  if (window.pending_mutation.confirmed) fail("pending attachment mutation already confirmed");
  const at = requireIso(now, "now");
  return {
    ...window,
    pending_mutation: {
      ...window.pending_mutation,
      issued: true,
      issued_at: at,
    },
  };
}

export function confirmTailAttachment(window, {
  observedConsumers,
  now = new Date().toISOString(),
} = {}) {
  // Lifecycle refuse first so terminal/expired windows never reach pending checks.
  if (window?.pending_mutation?.phase === "attach") {
    assertTailAttachmentWindowMutable(window, now);
  } else {
    assertTailAttachmentWindowWritable(window);
  }
  if (!window.pending_mutation) fail("no pending attachment mutation to confirm");
  if (!window.pending_mutation.issued) {
    fail("cannot confirm an unissued planned attachment; keep planned, issued, and confirmed distinct");
  }
  const observed = canonicalizeTailConsumers(observedConsumers);
  const observedSha = tailConsumersSha256(observed);
  if (observedSha !== window.pending_mutation.after_sha256) {
    fail("observed attachment does not match pending after_sha256");
  }
  const at = requireIso(now, "now");
  const phase = window.pending_mutation.phase === "attach" ? "attached" : "detached";
  return {
    ...window,
    phase,
    owned_consumers: observed,
    owned_sha256: observedSha,
    pending_mutation: null,
    mutations: [
      ...(window.mutations || []),
      {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "confirm",
        phase: window.pending_mutation.phase,
        after_sha256: observedSha,
        confirmed_at: at,
      },
    ],
  };
}

/**
 * Classify current attachment against exact window identities.
 * Pending before/after win over owned. Same-count foreign → conflict.
 * Requires a provider-declared consumer list (including []).
 */
export function classifyTailAttachment(currentConsumers, window) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("tail attachment window is invalid");
  }
  const consumers = canonicalizeTailConsumers(currentConsumers);
  const digest = tailConsumersSha256(consumers);
  if (digest === window.baseline_sha256) {
    return { class: "baseline", consumers, sha256: digest };
  }
  if (window.pending_mutation?.after_sha256 && digest === window.pending_mutation.after_sha256) {
    return { class: "pending-after", consumers, sha256: digest };
  }
  if (window.pending_mutation?.before_sha256 && digest === window.pending_mutation.before_sha256) {
    return { class: "pending-before", consumers, sha256: digest };
  }
  if (window.owned_sha256 && digest === window.owned_sha256) {
    return { class: "owned", consumers, sha256: digest };
  }
  return { class: "conflict", consumers, sha256: digest };
}

function pendingIssuedUnacked(window) {
  return Boolean(window.pending_mutation?.issued && !window.pending_mutation?.confirmed);
}

function missingGetRestorePlan(window, adapted, at, expired) {
  return {
    action: "retain-owned-unknown",
    expired,
    classification: {
      class: "unknown",
      consumers: null,
      sha256: null,
      reason: adapted.reason || "missing",
    },
    proved: false,
    ownership_preserved: true,
    ownership_unknown: true,
    patch: null,
    receipt: {
      schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
      kind: "restore-plan",
      outcome: "retain-owned-unknown",
      window_id: window.window_id,
      observed_at: at,
      expired,
      classification: "unknown",
      reason: "provider tail_consumers GET is missing or malformed; not a declared empty list",
    },
  };
}

/**
 * Restore planning for Tail attachment.
 * Issued-but-unacknowledged never becomes already-restored from one baseline GET.
 * A missing/malformed GET never becomes declared [] / already-restored.
 */
export function planTailAttachmentRestore(currentConsumers, window, {
  now = new Date().toISOString(),
} = {}) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("tail attachment window is invalid");
  }
  const at = requireIso(now, "now");
  const expired = Date.parse(at) >= Date.parse(window.expires_at);
  const adapted = adaptProviderTailConsumers(currentConsumers);
  if (!adapted.present) {
    return missingGetRestorePlan(window, adapted, at, expired);
  }
  const classification = classifyTailAttachment(adapted.consumers, window);

  if (pendingIssuedUnacked(window)) {
    if (classification.class === "pending-after") {
      return {
        action: "confirm-pending",
        expired,
        classification,
        proved: false,
        ownership_preserved: true,
        ownership_unknown: false,
        patch: null,
        receipt: {
          schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
          kind: "restore-plan",
          outcome: "confirm-pending",
          window_id: window.window_id,
          observed_at: at,
          expired,
          classification: classification.class,
        },
      };
    }
    // Baseline / before / owned / conflict while issued: retain UNKNOWN ownership.
    return {
      action: classification.class === "conflict" ? "refuse-conflict" : "retain-owned-unknown",
      expired,
      classification,
      proved: false,
      ownership_preserved: true,
      ownership_unknown: true,
      patch: null,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restore-plan",
        outcome: classification.class === "conflict" ? "refuse-conflict" : "retain-owned-unknown",
        window_id: window.window_id,
        observed_at: at,
        expired,
        classification: classification.class,
        reason: "issued attachment write is unacknowledged; one GET is not baseline-safe",
      },
    };
  }

  if (classification.class === "baseline") {
    return {
      action: "already-restored",
      expired,
      classification,
      proved: true,
      ownership_preserved: false,
      ownership_unknown: false,
      patch: null,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restore-plan",
        outcome: "already-restored",
        window_id: window.window_id,
        observed_at: at,
        expired,
        classification: "baseline",
      },
    };
  }

  if (classification.class === "conflict") {
    return {
      action: "refuse-conflict",
      expired,
      classification,
      proved: false,
      ownership_preserved: true,
      ownership_unknown: false,
      patch: null,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restore-plan",
        outcome: "refuse-conflict",
        window_id: window.window_id,
        observed_at: at,
        expired,
        classification: "conflict",
        after_sha256: classification.sha256,
        reason: "foreign tail_consumers identity (including same-count replacement) preserved",
      },
    };
  }

  // owned / pending-before / pending-after (unissued) → restore to baseline identity
  return {
    action: "restore",
    expired,
    classification,
    proved: false,
    ownership_preserved: true,
    ownership_unknown: false,
    patch: { tail_consumers: structuredClone(window.baseline_consumers) },
    receipt: {
      schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
      kind: "restore-plan",
      outcome: "restore",
      window_id: window.window_id,
      observed_at: at,
      expired,
      classification: classification.class,
      before_sha256: classification.sha256,
      baseline_sha256: window.baseline_sha256,
    },
  };
}

function markTailWindowRestored(window, { now, beforeSha256, afterSha256, expired, outcome }) {
  return {
    ...window,
    phase: expired ? "expired-restored" : "restored",
    owned_consumers: null,
    owned_sha256: null,
    pending_mutation: null,
    mutations: [
      ...(window.mutations || []),
      {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restore",
        outcome,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        restored_at: now,
        expired,
      },
    ],
  };
}

/**
 * Restore Tail attachment to the window baseline identity via transport.
 * Transport: { getTailConsumers(), patchTailConsumers(list) }.
 * getTailConsumers may return null/undefined on failure — that stays UNKNOWN.
 *
 * versionTransport is the consumer-bound deployments guard. RESTORE is the
 * safety path: a fresh version GET is performed before and after the actuator
 * when possible, but drift/failed GET NEVER blocks restore — only baseline,
 * foreign-ownership, and window-CAS checks do. Receipts use labeled outcomes
 * (never bare true); drift/failure labels version UNKNOWN.
 */
export async function restoreTailAttachmentWindow(window, transport, {
  now = new Date().toISOString(),
  versionTransport = null,
} = {}) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("tail attachment window is invalid");
  }
  if (!transport || typeof transport.getTailConsumers !== "function") {
    fail("attachment transport must provide getTailConsumers");
  }
  if (typeof transport.patchTailConsumers !== "function") {
    fail("attachment transport must provide patchTailConsumers");
  }
  const at = requireIso(now, "now");
  let getCount = 0;
  const countingVt = versionTransport && typeof versionTransport.getLatestVersionEvidence === "function"
    ? {
      ...versionTransport,
      account_id: versionTransport.account_id,
      account_id_sha256: versionTransport.account_id_sha256,
      script_name: versionTransport.script_name,
      consumer: versionTransport.consumer,
      url: versionTransport.url,
      path: versionTransport.path,
      async getLatestVersionEvidence(...args) {
        getCount += 1;
        return versionTransport.getLatestVersionEvidence(...args);
      },
    }
    : versionTransport;

  const beforeObs = await observeVersionGuard({
    versionTransport: countingVt,
    boundEvidence: window.version_evidence,
    reasonIfMissing: "restore versionTransport or bound evidence missing",
  });

  const beforeRaw = await transport.getTailConsumers();
  const plan = planTailAttachmentRestore(beforeRaw, window, { now: at });

  const finishWithoutActuator = async (result) => {
    const afterObs = {
      outcome: VERSION_GUARD_LABEL.NOT_PERFORMED,
      reason: "no restore actuator invoked",
      version: beforeObs.version_unknown ? "UNKNOWN" : beforeObs.version,
      version_unknown: beforeObs.version_unknown,
    };
    const version_guard = versionGuardReceipt(beforeObs, afterObs, { getCount });
    return { ...result, version_guard };
  };

  if (plan.action === "already-restored") {
    return finishWithoutActuator({
      ...plan,
      window: markTailWindowRestored(window, {
        now: at,
        beforeSha256: plan.classification.sha256,
        afterSha256: plan.classification.sha256,
        expired: plan.expired,
        outcome: "already-restored",
      }),
      after: plan.classification.consumers,
      proved: true,
    });
  }

  if (
    plan.action === "refuse-conflict"
    || plan.action === "retain-owned-unknown"
    || plan.action === "confirm-pending"
  ) {
    return finishWithoutActuator({
      ...plan,
      window,
      after: plan.classification.consumers,
      proved: false,
    });
  }

  if (plan.action !== "restore" || !plan.patch) {
    fail(`unexpected tail attachment restore plan action: ${plan.action}`);
  }

  await transport.patchTailConsumers(plan.patch.tail_consumers);
  // Poll only for a provider-declared array. Omit/null stay UNKNOWN — never [].
  // After an attach→detach cycle the provider has been observed to declare [].
  let afterRaw = await transport.getTailConsumers();
  let afterAdapted = adaptProviderTailConsumers(afterRaw);
  for (let attempt = 0; attempt < 45 && !afterAdapted.present; attempt += 1) {
    await sleep(200);
    afterRaw = await transport.getTailConsumers();
    afterAdapted = adaptProviderTailConsumers(afterRaw);
  }

  const afterObs = await observeVersionGuard({
    versionTransport: countingVt,
    boundEvidence: window.version_evidence,
    reasonIfMissing: "restore versionTransport or bound evidence missing",
  });
  const version_guard = versionGuardReceipt(beforeObs, afterObs, { getCount });
  // Attach version_guard onto every post-actuator result; never block on it.
  const withGuard = (result) => ({
    ...result,
    version_guard,
    receipt: result.receipt
      ? { ...result.receipt, version_guard }
      : result.receipt,
  });

  if (!afterAdapted.present) {
    return withGuard({
      action: "retain-owned-unknown",
      proved: false,
      ownership_preserved: true,
      ownership_unknown: true,
      expired: plan.expired,
      classification: {
        class: "unknown",
        consumers: null,
        sha256: null,
        reason: afterAdapted.reason || "missing",
      },
      window,
      after: null,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "retain-owned-unknown",
        window_id: window.window_id,
        observed_at: at,
        reason: "post-patch attachment GET is missing or malformed; ownership retained",
      },
    });
  }
  const after = afterAdapted.consumers;
  const afterSha = afterAdapted.sha256;
  if (afterSha !== window.baseline_sha256) {
    const afterClass = classifyTailAttachment(after, window);
    if (afterClass.class === "conflict") {
      return withGuard({
        action: "refuse-conflict",
        proved: false,
        ownership_preserved: true,
        ownership_unknown: false,
        expired: plan.expired,
        classification: afterClass,
        window,
        after,
        receipt: {
          schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
          kind: "restore",
          outcome: "refuse-conflict",
          window_id: window.window_id,
          observed_at: at,
          after_sha256: afterSha,
          reason: "post-patch attachment readback is foreign; preserved",
        },
      });
    }
    return withGuard({
      action: "restore-readback-mismatch",
      proved: false,
      ownership_preserved: true,
      ownership_unknown: false,
      expired: plan.expired,
      classification: afterClass,
      window,
      after,
      receipt: {
        schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
        kind: "restore",
        outcome: "restore-readback-mismatch",
        window_id: window.window_id,
        observed_at: at,
        after_sha256: afterSha,
        baseline_sha256: window.baseline_sha256,
        reason: "attachment readback did not prove baseline identity",
      },
    });
  }

  return withGuard({
    action: "restored",
    proved: true,
    ownership_preserved: false,
    ownership_unknown: false,
    expired: plan.expired,
    classification: { class: "baseline", consumers: after, sha256: afterSha },
    window: markTailWindowRestored(window, {
      now: at,
      beforeSha256: plan.classification.sha256,
      afterSha256: afterSha,
      expired: plan.expired,
      outcome: "restored",
    }),
    after,
    receipt: {
      schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
      kind: "restore",
      outcome: "restored",
      window_id: window.window_id,
      observed_at: at,
      before_sha256: plan.classification.sha256,
      after_sha256: afterSha,
      baseline_sha256: window.baseline_sha256,
    },
  });
}

/**
 * Emergency detach: classify the live attachment before any empty-consumer PATCH.
 * Never blank-patches [] without restore planning. When a durable store is
 * supplied, refuse on window_id or window_generation mismatch (0 PATCH).
 * Foreign same-count and missing/UNKNOWN GETs return the plan with proved:false
 * and 0 PATCH; only a restore / already-restored plan may actuate.
 */
export async function emergencyDetachTailAttachment(window, transport, {
  now = new Date().toISOString(),
  store = null,
  expectedGeneration = null,
} = {}) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("tail attachment window is invalid");
  }
  if (!transport || typeof transport.getTailConsumers !== "function") {
    fail("attachment transport must provide getTailConsumers");
  }
  const at = requireIso(now, "now");
  let active = window;

  if (store) {
    if (typeof store.read !== "function") fail("emergency detach store must provide read");
    const current = await store.read();
    if (!current) {
      return {
        action: "refuse-stale",
        proved: false,
        ownership_preserved: true,
        ownership_unknown: true,
        patch: null,
        window,
        after: null,
        reason: "durable store is empty",
        receipt: {
          schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
          kind: "emergency-detach",
          outcome: "refuse-stale",
          window_id: window.window_id,
          observed_at: at,
          reason: "durable store is empty",
        },
      };
    }
    if (current.window_id !== window.window_id) {
      return {
        action: "refuse-stale",
        proved: false,
        ownership_preserved: true,
        ownership_unknown: false,
        patch: null,
        window: current,
        after: null,
        reason: "window_id mismatch",
        receipt: {
          schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
          kind: "emergency-detach",
          outcome: "refuse-stale",
          window_id: window.window_id,
          observed_at: at,
          on_disk_window_id: current.window_id,
          reason: "window_id mismatch",
        },
      };
    }
    if (expectedGeneration != null) {
      const currentGen = Number.isInteger(current.window_generation) ? current.window_generation : 0;
      if (currentGen !== expectedGeneration) {
        return {
          action: "refuse-stale",
          proved: false,
          ownership_preserved: true,
          ownership_unknown: false,
          patch: null,
          window: current,
          after: null,
          reason: "window_generation mismatch",
          receipt: {
            schema: WORKER_TAIL_ATTACHMENT_RECEIPT_SCHEMA,
            kind: "emergency-detach",
            outcome: "refuse-stale",
            window_id: window.window_id,
            observed_at: at,
            expected_generation: expectedGeneration,
            on_disk_generation: currentGen,
            reason: "window_generation mismatch",
          },
        };
      }
    }
    active = current;
  }

  const beforeRaw = await transport.getTailConsumers();
  const plan = planTailAttachmentRestore(beforeRaw, active, { now: at });

  if (plan.action === "refuse-conflict" || plan.action === "retain-owned-unknown") {
    return {
      ...plan,
      proved: false,
      window: active,
      after: plan.classification?.consumers ?? null,
      patch: null,
    };
  }

  if (plan.action === "already-restored") {
    return {
      ...plan,
      window: markTailWindowRestored(active, {
        now: at,
        beforeSha256: plan.classification.sha256,
        afterSha256: plan.classification.sha256,
        expired: plan.expired,
        outcome: "already-restored",
      }),
      after: plan.classification.consumers,
      proved: true,
      patch: null,
    };
  }

  if (plan.action === "restore") {
    return restoreTailAttachmentWindow(active, transport, { now: at });
  }

  // confirm-pending and other non-restore plans: never blank-patch.
  return {
    ...plan,
    proved: false,
    window: active,
    after: plan.classification?.consumers ?? null,
    patch: null,
  };
}

/**
 * Bind env account/worker to the persisted Tail window before any GET or PATCH.
 */
export function assertTailTransportTargetMatchesWindow(env, window) {
  if (!window || typeof window !== "object") fail("tail attachment window is required for transport binding");
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID;
  const workerId = env?.CLOUDFLARE_WORKER_ID || DEFAULT_WORKER_ID;
  if (!accountId || typeof accountId !== "string") {
    fail("CLOUDFLARE_ACCOUNT_ID is required to bind Tail transport to the window");
  }
  const accountSha = createHash("sha256").update(accountId).digest("hex");
  if (window.account_id_sha256 && window.account_id_sha256 !== accountSha) {
    fail("tail transport account does not match window account_id_sha256");
  }
  if (window.worker_id && window.worker_id !== workerId) {
    fail("tail transport worker does not match window worker_id");
  }
  return { accountId, workerId, accountSha };
}

/**
 * Extract the actively serving versions array from a deployments-list payload.
 * Docs: the first deployment in the list is the latest actively serving traffic.
 * Accepts the full API `result`, `{deployments}`, a deployments array, or a bare
 * versions array. Returns null when the shape is missing/malformed.
 */
export function extractLatestDeploymentVersions(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    // Bare versions[{version_id,percentage}] OR deployments[{versions}].
    if (raw.length === 0) return [];
    if (raw[0] && typeof raw[0] === "object" && Array.isArray(raw[0].versions)) {
      return raw[0].versions;
    }
    if (raw[0] && typeof raw[0] === "object" && "version_id" in raw[0]) {
      return raw;
    }
    return null;
  }
  if (typeof raw !== "object") return null;
  if (Array.isArray(raw.versions) && !Array.isArray(raw.deployments)) {
    return raw.versions;
  }
  const deployments = Array.isArray(raw.deployments) ? raw.deployments : null;
  if (!deployments) return null;
  if (deployments.length === 0) return [];
  const latest = deployments[0];
  if (!latest || typeof latest !== "object" || !Array.isArray(latest.versions)) return null;
  return latest.versions;
}

/**
 * Deployed version evidence from the deployments list API.
 * Never invents fixture revision fields onto ConsumerScript identity.
 * Expected shape: versions[{version_id, percentage}, ...] (or a deployments
 * list from which the latest actively-serving versions are extracted).
 */
export function adaptDeploymentsVersionEvidence(raw) {
  if (raw == null) {
    return { present: false, reason: "missing", versions: null };
  }
  const versions = extractLatestDeploymentVersions(raw);
  if (versions == null) {
    return { present: false, reason: "malformed", versions: null };
  }
  const normalized = [];
  for (const entry of versions) {
    if (!entry || typeof entry !== "object") {
      return { present: false, reason: "malformed-entry", versions: null };
    }
    if (typeof entry.version_id !== "string" || !entry.version_id.trim()) {
      return { present: false, reason: "missing-version_id", versions: null };
    }
    if (typeof entry.percentage !== "number" || !Number.isFinite(entry.percentage)) {
      return { present: false, reason: "missing-percentage", versions: null };
    }
    normalized.push({
      version_id: entry.version_id.trim(),
      percentage: entry.percentage,
    });
  }
  return { present: true, reason: null, versions: normalized };
}

export function deploymentsVersionEvidenceSha256(versions) {
  return createHash("sha256")
    .update(JSON.stringify(versions == null ? null : versions))
    .digest("hex");
}

export function tailConsumerIdentityEquals(left, right) {
  const a = canonicalizeTailConsumer(left);
  const b = canonicalizeTailConsumer(right);
  return a.service === b.service
    && a.environment === b.environment
    && a.namespace === b.namespace;
}

function resolveAccountIdSha256({ accountId = null, accountIdSha256 = null } = {}) {
  if (typeof accountIdSha256 === "string" && /^[a-f0-9]{64}$/.test(accountIdSha256)) {
    return accountIdSha256;
  }
  if (typeof accountId === "string" && accountId.trim()) {
    return createHash("sha256").update(accountId.trim()).digest("hex");
  }
  fail("version evidence requires accountId or accountIdSha256");
}

function parseGetTarget(getTarget) {
  let targetScript = null;
  let targetPath = null;
  let targetUrl = null;
  if (typeof getTarget === "string" && getTarget.trim()) {
    targetScript = getTarget.trim();
  } else if (getTarget && typeof getTarget === "object") {
    if (typeof getTarget.script_name === "string" && getTarget.script_name.trim()) {
      targetScript = getTarget.script_name.trim();
    } else if (typeof getTarget.scriptName === "string" && getTarget.scriptName.trim()) {
      targetScript = getTarget.scriptName.trim();
    }
    if (typeof getTarget.path === "string" && getTarget.path.trim()) {
      targetPath = getTarget.path.trim();
    }
    if (typeof getTarget.url === "string" && getTarget.url.trim()) {
      targetUrl = getTarget.url.trim();
    }
  }
  return { targetScript, targetPath, targetUrl };
}

/**
 * True when evidence carries inseparable transport GET provenance (account +
 * actual URL/path + script_name). Versions alone are not an actual GET.
 */
export function deploymentsVersionEvidenceHasTransportProvenance(evidence) {
  if (!evidence || typeof evidence !== "object") return false;
  if (evidence.provenance !== "deployments-list-GET") return false;
  if (typeof evidence.account_id_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.account_id_sha256)) {
    return false;
  }
  const target = evidence.get_target;
  if (!target || typeof target !== "object") return false;
  if (typeof target.script_name !== "string" || !target.script_name.trim()) return false;
  const hasUrl = typeof target.url === "string" && target.url.trim();
  const hasPath = typeof target.path === "string" && target.path.trim();
  if (!hasUrl && !hasPath) return false;
  if (!evidence.http || evidence.http.success !== true) return false;
  return true;
}

/**
 * Bind independently acquired deployments-list version evidence onto the window.
 * Evidence must carry transport-produced GET provenance (account + actual URL/path
 * + script_name) inseparably from the versions. A manual script label cannot
 * relabel an actual GET for A as B. Never merges version_id into ConsumerScript
 * identity; a proof for consumer A never authorizes an attach of consumer B.
 */
export function bindTailAttachmentVersionEvidence(window, evidence, {
  now = new Date().toISOString(),
  source = null,
  consumer = null,
  accountId = null,
  accountIdSha256 = null,
  getTarget = null,
} = {}) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("bindTailAttachmentVersionEvidence requires a Tail attachment window");
  }
  if (!evidence || typeof evidence !== "object") {
    fail("deployed-version evidence is missing or empty; refusing to bind");
  }
  if (!deploymentsVersionEvidenceHasTransportProvenance(evidence)) {
    fail(
      "deployed-version evidence lacks transport GET provenance "
      + "(account+url/path+script_name); refusing manual script label as an actual GET",
    );
  }
  if (!evidence.present || !Array.isArray(evidence.versions) || evidence.versions.length === 0) {
    fail("deployed-version evidence is missing or empty; refusing to bind");
  }

  const evidenceAccountSha = evidence.account_id_sha256;
  if (evidenceAccountSha !== window.account_id_sha256) {
    fail("version evidence account does not match window account_id_sha256");
  }
  if (accountId != null || accountIdSha256 != null) {
    const callerAccountSha = resolveAccountIdSha256({ accountId, accountIdSha256 });
    if (callerAccountSha !== evidenceAccountSha) {
      fail("caller account does not match transport GET provenance account");
    }
  }

  const evidenceTarget = evidence.get_target;
  const evidenceScript = evidenceTarget.script_name.trim();
  const evidenceUrl = typeof evidenceTarget.url === "string" ? evidenceTarget.url.trim() : null;
  const evidencePath = typeof evidenceTarget.path === "string" ? evidenceTarget.path.trim() : null;
  if (evidenceUrl && !evidenceUrl.includes(`/workers/scripts/${encodeURIComponent(evidenceScript)}/deployments`)
    && !evidenceUrl.includes(`/workers/scripts/${evidenceScript}/deployments`)) {
    fail("transport GET provenance URL does not target evidence script_name");
  }

  const evidenceConsumer = canonicalizeTailConsumer(
    evidence.consumer && typeof evidence.consumer === "object"
      ? evidence.consumer
      : { service: evidenceScript, environment: null, namespace: null },
  );
  if (evidenceConsumer.service !== evidenceScript) {
    fail("transport GET provenance consumer.service does not match get_target.script_name");
  }

  if (consumer != null) {
    const callerConsumer = canonicalizeTailConsumer(consumer);
    if (!tailConsumerIdentityEquals(callerConsumer, evidenceConsumer)) {
      fail(
        "caller consumer does not match transport GET provenance; "
        + "refusing to relabel an actual GET as a different consumer",
      );
    }
  }

  if (getTarget != null) {
    const caller = parseGetTarget(getTarget);
    if (!caller.targetScript) {
      fail("caller getTarget is missing script_name");
    }
    if (caller.targetScript !== evidenceScript) {
      fail(
        "caller getTarget.script_name does not match transport GET provenance; "
        + "refusing to relabel an actual GET target",
      );
    }
    if (caller.targetUrl && evidenceUrl && caller.targetUrl !== evidenceUrl) {
      fail("caller getTarget.url does not match transport GET provenance url");
    }
    if (caller.targetPath && evidencePath && caller.targetPath !== evidencePath) {
      fail("caller getTarget.path does not match transport GET provenance path");
    }
    // URL/path pointing at a different script than the claimed label.
    if (caller.targetUrl) {
      const urlOk = caller.targetUrl.includes(`/workers/scripts/${encodeURIComponent(caller.targetScript)}/deployments`)
        || caller.targetUrl.includes(`/workers/scripts/${caller.targetScript}/deployments`);
      if (!urlOk) {
        fail("caller getTarget.url does not target caller script_name");
      }
    }
  }

  const versions = structuredClone(evidence.versions);
  // Re-normalize through adapter so malformed version rows cannot sneak in.
  const adapted = adaptDeploymentsVersionEvidence({ versions });
  if (!adapted.present || !adapted.versions.length) {
    fail("deployed-version evidence is missing or empty; refusing to bind");
  }
  const at = requireIso(now, "now");
  const sourceLabel = typeof source === "string" && source.trim()
    ? source.trim()
    : `GET /workers/scripts/${evidenceScript}/deployments`;
  return {
    ...window,
    version_evidence: {
      present: true,
      source: sourceLabel,
      provenance: "deployments-list-GET",
      bound_at: at,
      account_id_sha256: evidenceAccountSha,
      get_target: {
        script_name: evidenceScript,
        ...(evidencePath ? { path: evidencePath } : {}),
        ...(evidenceUrl ? { url: evidenceUrl } : {}),
      },
      consumer: evidenceConsumer,
      http: structuredClone(evidence.http),
      versions: adapted.versions,
      // version_id stays on the evidence record, never on ConsumerScript identity.
      version: adapted.versions[0]?.version_id ?? null,
      sha256: deploymentsVersionEvidenceSha256(adapted.versions),
      reason: null,
    },
  };
}

/**
 * Require consumer-bound deployed-version evidence before any attach/detach write.
 * For attach, every intended consumer must exactly match the bound consumer —
 * a proof for A never authorizes an attach of B. Digests are rechecked against
 * the bound versions to catch drift/tamper. Absent or mismatched evidence refuses.
 */
export function assertTailAttachmentVersionBound(window, {
  intendedConsumers = null,
  phase = null,
} = {}) {
  if (!window || window.schema !== WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA) {
    fail("Tail attachment window is required for version binding check");
  }
  const evidence = window.version_evidence;
  if (!evidence || evidence.present !== true) {
    fail("deployed-version GET evidence is not bound on the Tail window");
  }
  if (!Array.isArray(evidence.versions) || evidence.versions.length === 0) {
    fail("bound deployed-version evidence is empty");
  }
  if (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
    fail("bound deployed-version evidence sha256 is missing");
  }
  const recomputed = deploymentsVersionEvidenceSha256(evidence.versions);
  if (recomputed !== evidence.sha256) {
    fail("bound deployed-version evidence digest does not match versions; refusing drift");
  }
  if (
    typeof evidence.account_id_sha256 !== "string"
    || evidence.account_id_sha256 !== window.account_id_sha256
  ) {
    fail("bound deployed-version evidence account does not match window");
  }
  if (!evidence.consumer || typeof evidence.consumer !== "object") {
    fail("bound deployed-version evidence is missing consumer identity");
  }
  const boundConsumer = canonicalizeTailConsumer(evidence.consumer);
  if (
    !evidence.get_target
    || typeof evidence.get_target !== "object"
    || typeof evidence.get_target.script_name !== "string"
    || !evidence.get_target.script_name.trim()
  ) {
    fail("bound deployed-version evidence is missing GET target script_name");
  }
  if (evidence.get_target.script_name.trim() !== boundConsumer.service) {
    fail("bound deployed-version GET target does not match bound consumer.service");
  }

  if (phase === "attach") {
    if (intendedConsumers == null) {
      fail("attach requires intendedConsumers matched against consumer-bound version evidence");
    }
    const intended = canonicalizeTailConsumers(intendedConsumers);
    if (intended.length === 0) {
      fail("attach intendedConsumers is empty; refusing with unbound attach");
    }
    for (const entry of intended) {
      if (!tailConsumerIdentityEquals(entry, boundConsumer)) {
        fail(
          "version evidence is bound to a different consumer; "
          + "a proof for one consumer does not authorize attach of another",
        );
      }
    }
  }

  return {
    ...evidence,
    consumer: boundConsumer,
  };
}

/**
 * GET transport for Workers script deployments list (version evidence only).
 * Does not touch script-settings or ConsumerScript identity.
 */
export function createDeploymentsVersionTransport({
  accountId,
  scriptName = DEFAULT_WORKER_ID,
  token,
  fetchImpl = fetch,
  origin = "https://api.cloudflare.com/client/v4",
  environment = null,
  namespace = null,
} = {}) {
  if (typeof accountId !== "string" || !accountId.trim()) fail("accountId is required");
  if (typeof scriptName !== "string" || !scriptName.trim()) fail("scriptName is required");
  if (typeof token !== "string" || !token) fail("token is required");
  if (environment != null && typeof environment !== "string") {
    fail("deployments version transport environment must be a string or null");
  }
  if (namespace != null && typeof namespace !== "string") {
    fail("deployments version transport namespace must be a string or null; unsupported scope refused");
  }
  const account = accountId.trim();
  const script = scriptName.trim();
  const accountSha = createHash("sha256").update(account).digest("hex");
  const path = `/accounts/${account}/workers/scripts/${script}/deployments`;
  const url = `${origin.replace(/\/$/, "")}/accounts/${encodeURIComponent(account)}`
    + `/workers/scripts/${encodeURIComponent(script)}/deployments`;
  const consumer = canonicalizeTailConsumer({
    service: script,
    environment: typeof environment === "string" && environment.trim() ? environment.trim() : null,
    namespace: typeof namespace === "string" && namespace.trim() ? namespace.trim() : null,
  });
  let lastExchange = null;
  let lastFullResult = null;

  return {
    get url() { return url; },
    get path() { return path; },
    get last_exchange() { return lastExchange; },
    get last_full_result() { return lastFullResult; },
    account_id: account,
    account_id_sha256: accountSha,
    script_name: script,
    consumer,
    async getDeployments() {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        lastExchange = {
          method: "GET",
          url,
          path,
          script_name: script,
          account_id_sha256: accountSha,
          http_status: response.status,
          success: false,
          error_name: "json-parse-failed",
        };
        fail(`deployments GET failed with status ${response.status}`);
      }
      const result = payload?.result && typeof payload.result === "object" ? payload.result : null;
      lastFullResult = result;
      lastExchange = {
        method: "GET",
        url,
        path,
        script_name: script,
        account_id_sha256: accountSha,
        http_status: response.status,
        success: payload?.success === true,
        deployments_len: Array.isArray(result?.deployments) ? result.deployments.length : null,
      };
      if (!response.ok || payload?.success !== true) {
        fail(`deployments GET failed with status ${response.status}`);
      }
      return result;
    },
    async getLatestVersionEvidence() {
      const result = await this.getDeployments();
      const adapted = adaptDeploymentsVersionEvidence(result);
      if (!adapted.present) {
        return {
          ...adapted,
          provenance: "deployments-list-GET",
          account_id_sha256: accountSha,
          get_target: { script_name: script, url, path },
          consumer: structuredClone(consumer),
          http: {
            method: "GET",
            status: lastExchange?.http_status ?? null,
            success: false,
          },
        };
      }
      return {
        present: true,
        reason: null,
        versions: adapted.versions,
        provenance: "deployments-list-GET",
        account_id_sha256: accountSha,
        get_target: { script_name: script, url, path },
        consumer: structuredClone(consumer),
        http: {
          method: "GET",
          status: lastExchange?.http_status ?? null,
          success: true,
        },
        sha256: deploymentsVersionEvidenceSha256(adapted.versions),
        version: adapted.versions[0]?.version_id ?? null,
      };
    },
  };
}

/**
 * Labeled version-guard outcomes for receipts. Never a bare true/false.
 * ATTACH is strict (missing/failed/drift refuse). RESTORE/DETACH always
 * proceed after recording one of these labels; drift/failure → version UNKNOWN.
 */
export const VERSION_GUARD_LABEL = Object.freeze({
  MATCH: "performed:match",
  DRIFT: "performed:drift",
  FAILED: "failed:unknown",
  NOT_PERFORMED: "not_performed",
});

/**
 * Observe one fresh deployments version GET against bound evidence.
 * Never throws for restore/detach safety-path use — returns a labeled result.
 * ATTACH callers still refuse unless outcome is performed:match.
 */
export async function observeVersionGuard({
  versionTransport = null,
  boundEvidence = null,
  reasonIfMissing = "versionTransport or bound version evidence missing",
} = {}) {
  if (!versionTransport || typeof versionTransport.getLatestVersionEvidence !== "function") {
    return {
      outcome: VERSION_GUARD_LABEL.NOT_PERFORMED,
      reason: reasonIfMissing,
      version: "UNKNOWN",
      version_unknown: true,
      sha256: null,
      versions: null,
      performed: false,
    };
  }
  if (!boundEvidence || boundEvidence.present !== true) {
    return {
      outcome: VERSION_GUARD_LABEL.NOT_PERFORMED,
      reason: "bound version evidence absent",
      version: "UNKNOWN",
      version_unknown: true,
      sha256: null,
      versions: null,
      performed: false,
    };
  }
  try {
    assertVersionTransportMatchesBound(versionTransport, boundEvidence);
  } catch (error) {
    return {
      outcome: VERSION_GUARD_LABEL.FAILED,
      reason: String(error?.message || error),
      version: "UNKNOWN",
      version_unknown: true,
      sha256: null,
      versions: null,
      performed: false,
    };
  }
  let fresh;
  try {
    fresh = await versionTransport.getLatestVersionEvidence();
  } catch (error) {
    return {
      outcome: VERSION_GUARD_LABEL.FAILED,
      reason: String(error?.message || error),
      version: "UNKNOWN",
      version_unknown: true,
      sha256: null,
      versions: null,
      performed: true,
    };
  }
  try {
    const matched = assertFreshVersionEvidenceMatchesBound(fresh, boundEvidence);
    return {
      outcome: VERSION_GUARD_LABEL.MATCH,
      reason: null,
      version: matched.version,
      version_unknown: false,
      sha256: matched.sha256,
      versions: matched.versions,
      performed: true,
    };
  } catch (error) {
    return {
      outcome: VERSION_GUARD_LABEL.DRIFT,
      reason: String(error?.message || error),
      version: "UNKNOWN",
      version_unknown: true,
      observed_version: fresh?.version ?? fresh?.versions?.[0]?.version_id ?? null,
      observed_sha256: fresh?.sha256 ?? null,
      sha256: null,
      versions: Array.isArray(fresh?.versions) ? fresh.versions : null,
      performed: true,
    };
  }
}

function versionGuardReceipt(beforeObs, afterObs, {
  consumerBound = true,
  getCount = null,
} = {}) {
  const versionUnknown = Boolean(beforeObs?.version_unknown || afterObs?.version_unknown);
  const version = versionUnknown
    ? "UNKNOWN"
    : (afterObs?.version ?? beforeObs?.version ?? "UNKNOWN");
  return {
    before_actuator: beforeObs?.outcome || VERSION_GUARD_LABEL.NOT_PERFORMED,
    after_actuator: afterObs?.outcome || VERSION_GUARD_LABEL.NOT_PERFORMED,
    before_reason: beforeObs?.reason || null,
    after_reason: afterObs?.reason || null,
    version,
    version_unknown: versionUnknown || version === "UNKNOWN",
    consumer_bound: consumerBound,
    provider_cas: "UNKNOWN",
    ...(getCount != null ? { get_count: getCount } : {}),
  };
}

/**
 * Require a versionTransport's constructed target to match bound evidence before
 * a fresh GET is trusted for attach.
 */
export function assertVersionTransportMatchesBound(versionTransport, evidence) {
  if (!versionTransport || typeof versionTransport.getLatestVersionEvidence !== "function") {
    fail("deployments versionTransport is required for fresh version GET");
  }
  if (!evidence || evidence.present !== true) {
    fail("bound deployed-version evidence is required");
  }
  const transportAccount = typeof versionTransport.account_id_sha256 === "string"
    ? versionTransport.account_id_sha256
    : (typeof versionTransport.account_id === "string"
      ? createHash("sha256").update(versionTransport.account_id).digest("hex")
      : null);
  if (!transportAccount || transportAccount !== evidence.account_id_sha256) {
    fail("versionTransport account does not match bound version evidence");
  }
  const transportScript = typeof versionTransport.script_name === "string"
    ? versionTransport.script_name.trim()
    : null;
  if (!transportScript || transportScript !== evidence.get_target?.script_name) {
    fail("versionTransport script_name does not match bound GET target");
  }
  if (typeof versionTransport.url === "string" && evidence.get_target?.url
    && versionTransport.url !== evidence.get_target.url) {
    fail("versionTransport url does not match bound GET target url");
  }
  if (versionTransport.consumer) {
    if (!tailConsumerIdentityEquals(versionTransport.consumer, evidence.consumer)) {
      fail("versionTransport consumer identity does not match bound evidence");
    }
  }
  return true;
}

/**
 * Compare a fresh deployments GET against bound evidence. Catches provider
 * deployment drift (UUID1 → UUID2) that durable digest recompute cannot see.
 */
export function assertFreshVersionEvidenceMatchesBound(fresh, evidence) {
  if (!evidence || evidence.present !== true) {
    fail("bound deployed-version evidence is required for fresh GET match");
  }
  if (!fresh || fresh.present !== true || !Array.isArray(fresh.versions) || fresh.versions.length === 0) {
    fail("fresh deployed-version GET is missing, failed, or empty; refusing attach");
  }
  if (!deploymentsVersionEvidenceHasTransportProvenance(fresh)) {
    fail("fresh deployed-version GET lacks transport provenance; refusing attach");
  }
  if (fresh.account_id_sha256 !== evidence.account_id_sha256) {
    fail("fresh version GET account does not match bound evidence");
  }
  if (fresh.get_target?.script_name !== evidence.get_target?.script_name) {
    fail("fresh version GET target does not match bound evidence");
  }
  if (evidence.get_target?.url && fresh.get_target?.url
    && fresh.get_target.url !== evidence.get_target.url) {
    fail("fresh version GET url does not match bound evidence");
  }
  if (!tailConsumerIdentityEquals(fresh.consumer || { service: fresh.get_target.script_name }, evidence.consumer)) {
    fail("fresh version GET consumer does not match bound evidence");
  }
  const freshSha = fresh.sha256 || deploymentsVersionEvidenceSha256(fresh.versions);
  if (freshSha !== evidence.sha256) {
    fail(
      "provider deployment drift: fresh version GET does not match bound versions; "
      + "refusing attach",
    );
  }
  return {
    versions: fresh.versions,
    sha256: freshSha,
    version: fresh.versions[0]?.version_id ?? null,
  };
}

/**
 * Read tail_consumers from a successful ScriptSetting result without inventing
 * a declared empty list. Omitted key, explicit null, non-array, or empty result
 * object stay UNKNOWN (null). Only an actual array is returned.
 */
export function readTailConsumersFieldFromScriptSettingsResult(result) {
  if (!result || typeof result !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(result, "tail_consumers")) return null;
  if (result.tail_consumers == null) return null;
  if (!Array.isArray(result.tail_consumers)) return null;
  return result.tail_consumers;
}

/**
 * Validate a beta Worker GET name-only entry (`{name}`).
 * Returns `{ name }` only — never invents environment/namespace nulls as
 * proved ConsumerScript identity. Callers must not feed this into classify
 * or restore planning; beta is authoritative only for an explicit [].
 */
export function mapBetaTailConsumerNameOnly(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail("beta Worker tail consumer entry must be an object");
  }
  const name = typeof entry.name === "string" && entry.name.trim()
    ? entry.name.trim()
    : null;
  if (!name) fail("beta Worker tail consumer requires name");
  return { name };
}

/**
 * Verify a beta Worker GET result maps worker_id → exact script name.
 * worker_id in the URL may be the immutable id or the name; the response must
 * identify the expected script via result.name (and optionally result.id).
 */
export function assertBetaWorkerResultMapsToScript(result, {
  expectedScriptName = null,
  expectedWorkerId = null,
} = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("beta Worker GET result is required for script mapping");
  }
  const name = typeof result.name === "string" && result.name.trim()
    ? result.name.trim()
    : null;
  const id = typeof result.id === "string" && result.id.trim()
    ? result.id.trim()
    : null;
  if (!name) fail("beta Worker GET result.name is missing; cannot map worker_id to script");

  const expectedName = typeof expectedScriptName === "string" && expectedScriptName.trim()
    ? expectedScriptName.trim()
    : null;
  const expectedId = typeof expectedWorkerId === "string" && expectedWorkerId.trim()
    ? expectedWorkerId.trim()
    : null;

  if (expectedName && name !== expectedName) {
    // Allow URL worker_id == name when expectedWorkerId was the name.
    if (!(expectedId && expectedId === name && name === expectedName)) {
      fail(
        `beta Worker GET name "${name}" does not map to expected script "${expectedName}"`,
      );
    }
  }
  if (expectedId && expectedId !== name && expectedId !== id) {
    fail(
      `beta Worker GET id/name does not map to expected worker_id "${expectedId}"`,
    );
  }
  if (!expectedName && !expectedId) {
    fail("expectedScriptName or expectedWorkerId is required for beta Worker mapping");
  }
  return { name, id };
}

/**
 * Read tail_consumers from a successful beta Worker GET result.
 * Docs: required array<{name}>. Explicit [] proves empty and is the ONLY
 * beta-authoritative value. Omitted key, null, or non-array stay UNKNOWN.
 * Any non-empty name-only array also stays UNKNOWN: a name-only view cannot
 * prove environment or namespace, and inventing nulls would lose identity
 * (same-service owned match → false PATCH []). Entries are shape-checked
 * then discarded. Verifies worker_id → script name before trusting the field.
 */
export function readTailConsumersFieldFromBetaWorkerResult(result, {
  expectedScriptName = null,
  expectedWorkerId = null,
} = {}) {
  if (!result || typeof result !== "object") return null;
  assertBetaWorkerResultMapsToScript(result, { expectedScriptName, expectedWorkerId });
  if (!Object.prototype.hasOwnProperty.call(result, "tail_consumers")) return null;
  if (result.tail_consumers == null) return null;
  if (!Array.isArray(result.tail_consumers)) return null;
  if (result.tail_consumers.length === 0) return [];
  // Non-empty name-only: validate shape, refuse to invent ConsumerScript nulls.
  for (const entry of result.tail_consumers) {
    mapBetaTailConsumerNameOnly(entry);
  }
  return null;
}

/**
 * JSON GET/PATCH transport for script-settings tail_consumers.
 * HTTP success with an optional/omitted/null tail_consumers field is UNKNOWN
 * (returns null) — never coerced to []. Only a real array is declared.
 * Transport failures throw. Callers run adaptProviderTailConsumers on the value.
 */
export function createScriptSettingsTailConsumersTransport({
  accountId,
  scriptName = DEFAULT_WORKER_ID,
  token,
  fetchImpl = fetch,
  origin = "https://api.cloudflare.com/client/v4",
} = {}) {
  if (typeof accountId !== "string" || !accountId.trim()) fail("accountId is required");
  if (typeof scriptName !== "string" || !scriptName.trim()) fail("scriptName is required");
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
      lastExchange = {
        method,
        url,
        http_status: response.status,
        success: false,
        error_name: "json-parse-failed",
      };
      fail(`script-settings tail ${method} failed with status ${response.status}`);
    }
    const result = payload?.result && typeof payload.result === "object" ? payload.result : null;
    lastFullResult = result;
    const field = readTailConsumersFieldFromScriptSettingsResult(result);
    lastExchange = {
      method,
      url,
      http_status: response.status,
      success: payload?.success === true,
      has_tail_consumers_key: Boolean(result && Object.prototype.hasOwnProperty.call(result, "tail_consumers")),
      tail_consumers_declared_array: Array.isArray(field),
    };
    if (!response.ok || payload?.success !== true) {
      fail(`script-settings tail ${method} failed with status ${response.status}`);
    }
    return result;
  }

  return {
    get url() { return url; },
    get last_exchange() { return lastExchange; },
    get last_full_result() { return lastFullResult; },
    account_id: accountId,
    script_name: scriptName,
    view: "script-settings",
    async getTailConsumers() {
      const result = await request("GET");
      return readTailConsumersFieldFromScriptSettingsResult(result);
    },
    async patchTailConsumers(list) {
      const canonical = canonicalizeTailConsumers(list);
      const result = await request("PATCH", { tail_consumers: canonical });
      return readTailConsumersFieldFromScriptSettingsResult(result);
    },
  };
}

/**
 * Independent effective-view GET for beta Worker tail_consumers.
 * Endpoint: GET /accounts/{account_id}/workers/workers/{worker_id}.
 * tail_consumers is a required array<{name}>; explicit [] proves empty and is
 * the only beta-authoritative value. Omitted/null/non-array and non-empty
 * name-only arrays stay UNKNOWN (no invented env/namespace nulls).
 * Script-settings null is never zero. Verifies result.name maps to the
 * expected script before trusting the field. Read-only — writes stay on
 * script-settings.
 */
export function createBetaWorkerTailConsumersTransport({
  accountId,
  workerId = DEFAULT_WORKER_ID,
  scriptName = null,
  token,
  fetchImpl = fetch,
  origin = "https://api.cloudflare.com/client/v4",
} = {}) {
  if (typeof accountId !== "string" || !accountId.trim()) fail("accountId is required");
  if (typeof workerId !== "string" || !workerId.trim()) fail("workerId is required");
  if (typeof token !== "string" || !token) fail("token is required");
  const expectedScript = typeof scriptName === "string" && scriptName.trim()
    ? scriptName.trim()
    : workerId.trim();
  const url = betaWorkerUrl({ accountId, workerId, origin });
  const path = `/accounts/${accountId.trim()}/workers/workers/${workerId.trim()}`;
  const accountSha = createHash("sha256").update(accountId.trim()).digest("hex");
  let lastExchange = null;
  let lastFullResult = null;
  let lastMapping = null;

  async function requestGet() {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      lastExchange = {
        method: "GET",
        url,
        path,
        view: "beta-worker",
        worker_id: workerId.trim(),
        expected_script_name: expectedScript,
        account_id_sha256: accountSha,
        http_status: response.status,
        success: false,
        error_name: "json-parse-failed",
      };
      fail(`beta Worker tail GET failed with status ${response.status}`);
    }
    const result = payload?.result && typeof payload.result === "object" ? payload.result : null;
    lastFullResult = result;
    lastExchange = {
      method: "GET",
      url,
      path,
      view: "beta-worker",
      worker_id: workerId.trim(),
      expected_script_name: expectedScript,
      account_id_sha256: accountSha,
      http_status: response.status,
      success: payload?.success === true,
      result_name: typeof result?.name === "string" ? result.name : null,
      result_id: typeof result?.id === "string" ? result.id : null,
      has_tail_consumers_key: Boolean(
        result && Object.prototype.hasOwnProperty.call(result, "tail_consumers"),
      ),
      tail_consumers_declared_array: Array.isArray(result?.tail_consumers),
      entry_shape: "name-only",
      namespace_fidelity: "none",
    };
    if (!response.ok || payload?.success !== true) {
      fail(`beta Worker tail GET failed with status ${response.status}`);
    }
    if (!result) {
      fail("beta Worker GET omitted result; effective tail view unproved");
    }
    lastMapping = assertBetaWorkerResultMapsToScript(result, {
      expectedScriptName: expectedScript,
      expectedWorkerId: workerId.trim(),
    });
    lastExchange = {
      ...lastExchange,
      mapped_script_name: lastMapping.name,
      mapped_worker_id: lastMapping.id,
      mapping_ok: true,
    };
    return result;
  }

  return {
    get url() { return url; },
    get path() { return path; },
    get last_exchange() { return lastExchange; },
    get last_full_result() { return lastFullResult; },
    get last_mapping() { return lastMapping; },
    account_id: accountId.trim(),
    account_id_sha256: accountSha,
    worker_id: workerId.trim(),
    script_name: expectedScript,
    view: "beta-worker",
    entry_shape: "name-only",
    namespace_fidelity: "none",
    async getTailConsumers() {
      const result = await requestGet();
      return readTailConsumersFieldFromBetaWorkerResult(result, {
        expectedScriptName: expectedScript,
        expectedWorkerId: workerId.trim(),
      });
    },
  };
}

/**
 * Dual-view Tail transport: writes go to script-settings; effective empty
 * proof may come from the independent beta Worker GET when script-settings is
 * UNKNOWN (null/omit). Never count script-settings null as zero. Explicit beta
 * [] proves empty — the only beta-authoritative value. Non-empty name-only beta
 * stays UNKNOWN (no invented null env/namespace identity).
 */
export function createDualViewTailConsumersTransport({
  scriptSettingsTransport,
  betaTransport,
} = {}) {
  if (!scriptSettingsTransport
    || typeof scriptSettingsTransport.getTailConsumers !== "function"
    || typeof scriptSettingsTransport.patchTailConsumers !== "function") {
    fail("scriptSettingsTransport with getTailConsumers/patchTailConsumers is required");
  }
  if (!betaTransport || typeof betaTransport.getTailConsumers !== "function") {
    fail("betaTransport with getTailConsumers is required for the independent empty view");
  }

  let lastView = null;

  return {
    endpoint: "dual-view-script-settings+beta-worker",
    get last_exchange() {
      return scriptSettingsTransport.last_exchange || betaTransport.last_exchange || null;
    },
    get last_view() { return lastView; },
    get script_settings_transport() { return scriptSettingsTransport; },
    get beta_transport() { return betaTransport; },
    async getTailConsumers() {
      const scriptRaw = await scriptSettingsTransport.getTailConsumers();
      if (scriptRaw !== null) {
        lastView = {
          view: "script-settings",
          present: true,
          entry_shape: "service-environment-namespace",
          namespace_fidelity: "full",
          script_settings_unknown: false,
          beta_consulted: false,
        };
        return scriptRaw;
      }
      // Script-settings null/omit is UNKNOWN — never coerce to []. Consult beta.
      // Beta returns [] (empty proved) or null (omit / non-empty name-only UNKNOWN).
      const betaRaw = await betaTransport.getTailConsumers();
      const emptyProved = Array.isArray(betaRaw) && betaRaw.length === 0;
      const betaExchange = betaTransport.last_exchange || null;
      const betaDeclaredNonEmpty = Boolean(
        betaExchange?.tail_consumers_declared_array
        && !emptyProved
        && betaRaw === null,
      );
      lastView = {
        view: "beta-worker",
        present: betaRaw !== null,
        entry_shape: "name-only",
        namespace_fidelity: "none",
        script_settings_unknown: true,
        beta_consulted: true,
        empty_proved: emptyProved,
        beta_name_only_nonempty_unknown: betaDeclaredNonEmpty,
      };
      return betaRaw;
    },
    async patchTailConsumers(list) {
      lastView = {
        view: "script-settings",
        present: true,
        write: true,
        beta_consulted: false,
      };
      return scriptSettingsTransport.patchTailConsumers(list);
    },
    async getDualView() {
      const scriptOverride = await scriptSettingsTransport.getTailConsumers();
      const effective = await betaTransport.getTailConsumers();
      const emptyProved = Array.isArray(effective) && effective.length === 0;
      const betaExchange = betaTransport.last_exchange || null;
      const betaDeclaredNonEmpty = Boolean(
        betaExchange?.tail_consumers_declared_array
        && !emptyProved
        && effective === null,
      );
      lastView = {
        view: "dual",
        script_override_present: scriptOverride !== null,
        effective_present: effective !== null,
        empty_proved: emptyProved,
        entry_shape_effective: "name-only",
        namespace_fidelity: "none",
        beta_name_only_nonempty_unknown: betaDeclaredNonEmpty,
      };
      return {
        script_override: scriptOverride,
        script_override_present: scriptOverride !== null,
        // Honest: script-settings null is UNKNOWN, not empty.
        script_settings_unknown: scriptOverride === null,
        effective,
        effective_present: effective !== null,
        effective_view: "beta-worker",
        effective_entry_shape: "name-only",
        namespace_fidelity: "none",
        empty_proved_by_beta: emptyProved,
        beta_name_only_nonempty_unknown: betaDeclaredNonEmpty,
        exchanges: {
          script_settings: scriptSettingsTransport.last_exchange || null,
          beta_worker: betaTransport.last_exchange || null,
        },
      };
    },
  };
}

/**
 * Window-owned Tail attach/detach with durable write-ahead intent.
 * Provider-native CAS remains UNKNOWN — see concurrency_control.
 */
export async function mutateOwnedTailAttachment({
  transport,
  store,
  intendedConsumers,
  phase,
  now = new Date().toISOString(),
  alreadyLocked = false,
  versionTransport = null,
} = {}) {
  if (!transport || typeof transport.getTailConsumers !== "function"
    || typeof transport.patchTailConsumers !== "function") {
    fail("mutation transport must provide getTailConsumers and patchTailConsumers");
  }
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    fail("durable Tail window store is required");
  }
  if (!["attach", "detach"].includes(phase)) fail("attachment mutation phase is invalid");

  const run = async () => {
    let window = await store.read();
    if (!window) fail("tail attachment window is missing from durable store");
    if (!window.restorer?.armed) fail("independent restorer must be armed before Tail mutation");
    // Consumer-bound version actuator: refuse BEFORE any write when the bound
    // deployments GET does not authorize these exact intended consumer(s).
    assertTailAttachmentVersionBound(window, { intendedConsumers, phase });
    let beforeObs = null;
    if (phase === "attach") {
      assertTailAttachmentWindowMutable(window, now);
      // ATTACH (adds risk): fresh actual version GET REQUIRED before actuator.
      // Missing, failed, or drift → refuse with 0 PATCH.
      if (!versionTransport || typeof versionTransport.getLatestVersionEvidence !== "function") {
        fail("attach requires deployments versionTransport for a fresh GET before actuator");
      }
      beforeObs = await observeVersionGuard({
        versionTransport,
        boundEvidence: window.version_evidence,
        reasonIfMissing: "attach requires deployments versionTransport",
      });
      if (beforeObs.outcome !== VERSION_GUARD_LABEL.MATCH) {
        fail(
          beforeObs.reason
          || `attach version guard refused: ${beforeObs.outcome}`,
        );
      }
    } else {
      // DETACH (safety path): observe but NEVER block on drift/failed GET.
      assertTailAttachmentWindowWritable(window);
      beforeObs = await observeVersionGuard({
        versionTransport,
        boundEvidence: window.version_evidence,
        reasonIfMissing: "detach versionTransport or bound evidence missing",
      });
    }

    const windowId = window.window_id;
    const beforeRaw = await transport.getTailConsumers();
    const beforeAdapted = adaptProviderTailConsumers(beforeRaw);
    let beforeSha;
    let beforeSource = "provider-get-declared-array";
    if (beforeAdapted.present) {
      beforeSha = beforeAdapted.sha256;
    } else if (
      // Fresh owned throwaway only: GET stayed UNKNOWN after an explicit
      // initialize write-ahead that acknowledged the baseline. Never invent
      // empty for foreign/unknown/production windows.
      window.baseline_source === "owned-initialize-write-ahead-acknowledged"
      && window.phase === "captured"
      && !window.owned_sha256
      && !window.pending_mutation
      && Array.isArray(window.baseline_consumers)
      && phase === "attach"
    ) {
      beforeSha = window.baseline_sha256;
      beforeSource = "owned-initialize-acknowledged";
    } else {
      return {
        ok: false,
        reason: "provider-get-unproved",
        window,
        ownership_unknown: true,
        before_get_reason: beforeAdapted.reason || "missing",
      };
    }
    window = recordTailAttachmentIntent(window, {
      phase,
      beforeSha256: beforeSha,
      intendedConsumers,
      now,
    });
    // store.write stamps window_generation; keep the returned copy for CAS.
    window = await store.write(window, { expectedWindowId: windowId });

    window = markTailAttachmentIssued(window, { now });
    window = await store.write(window, { expectedWindowId: windowId });

    let patchError = null;
    try {
      await transport.patchTailConsumers(window.pending_mutation.intended_consumers);
    } catch (error) {
      patchError = error;
    }

    let afterRaw;
    let afterAdapted;
    try {
      // Poll for a declared array only; omit/null stay UNKNOWN.
      afterRaw = await transport.getTailConsumers();
      afterAdapted = adaptProviderTailConsumers(afterRaw);
      for (let attempt = 0; attempt < 5 && !afterAdapted.present; attempt += 1) {
        await sleep(200);
        afterRaw = await transport.getTailConsumers();
        afterAdapted = adaptProviderTailConsumers(afterRaw);
      }
    } catch (error) {
      return {
        ok: false,
        reason: "readback-failed",
        patch_error: patchError ? String(patchError?.message || patchError) : null,
        readback_error: String(error?.message || error),
        window,
        ownership_unknown: true,
      };
    }

    if (!afterAdapted.present) {
      return {
        ok: false,
        reason: "readback-unproved",
        window,
        ownership_unknown: true,
        before_source: beforeSource,
      };
    }
    if (afterAdapted.sha256 !== window.pending_mutation.after_sha256) {
      return {
        ok: false,
        reason: "readback-mismatch",
        window,
        after: afterAdapted.consumers,
        after_sha256: afterAdapted.sha256,
        ownership_preserved: true,
      };
    }

    window = confirmTailAttachment(window, {
      observedConsumers: afterAdapted.consumers,
      now,
    });
    window = await store.write(window, { expectedWindowId: windowId });

    // Fresh version GET after the actuator. ATTACH is strict (drift → ok:false).
    // DETACH is the safety path: observe and label, never block. Labels only —
    // never a bare true. Provider CAS stays UNKNOWN.
    let afterObs;
    if (phase === "attach") {
      afterObs = await observeVersionGuard({
        versionTransport,
        boundEvidence: window.version_evidence,
        reasonIfMissing: "attach requires deployments versionTransport",
      });
      if (afterObs.outcome !== VERSION_GUARD_LABEL.MATCH) {
        return {
          ok: false,
          reason: "provider-drift-after-attach",
          window,
          after: window.owned_consumers,
          after_sha256: window.owned_sha256,
          before_source: beforeSource,
          version_guard: versionGuardReceipt(beforeObs, afterObs),
          version_guard_error: afterObs.reason,
          ownership_attached: true,
          recovered_from_patch_throw: Boolean(patchError),
        };
      }
    } else {
      afterObs = await observeVersionGuard({
        versionTransport,
        boundEvidence: window.version_evidence,
        reasonIfMissing: "detach versionTransport or bound evidence missing",
      });
    }

    return {
      ok: true,
      before: beforeAdapted.present ? beforeAdapted.consumers : window.baseline_consumers,
      before_sha256: beforeSha,
      before_source: beforeSource,
      after: window.owned_consumers,
      after_sha256: window.owned_sha256,
      window,
      recovered_from_patch_throw: Boolean(patchError),
      version_guard: versionGuardReceipt(beforeObs, afterObs),
    };
  };

  if (alreadyLocked || typeof store.withLock !== "function") return run();
  return store.withLock(run);
}

/**
 * Independent Tail restorer over the durable store + attachment transport.
 * Threads versionTransport into the restore actuator so the guardian observes
 * actual deployments GETs (labeled; never blocked by drift).
 */
export async function runIndependentTailRestorer({
  store,
  transport,
  versionTransport = null,
  now = new Date().toISOString(),
  alreadyLocked = false,
} = {}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    fail("durable window store is required for the independent Tail restorer");
  }
  const run = async () => {
    const window = await store.read();
    if (!window) fail("tail attachment window is missing");
    if (!window.restorer?.armed) fail("tail restorer is not armed");
    const windowId = window.window_id;
    const restored = await restoreTailAttachmentWindow(window, transport, {
      now,
      versionTransport,
    });
    await store.write(restored.window, { expectedWindowId: windowId });
    return restored;
  };
  if (alreadyLocked || typeof store.withLock !== "function") return run();
  return store.withLock(run);
}
