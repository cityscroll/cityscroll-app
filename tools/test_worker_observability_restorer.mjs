import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  armRestorer,
  confirmOwnedSettings,
  createFileWindowStore,
  markPendingMutationIssued,
  mutateOwnedWindowObservability,
  normalizeObservability,
  observabilityEquals,
  observabilitySha256,
  openExactLayerSettingsWindow,
  openSettingsWindow,
  privacyArmedObservability,
  recordMutationIntent,
  restoreSettingsWindow,
  SCRIPT_LAYER_RESTORE_MODE,
  SETTINGS_SUCCESS_STATUSES,
  settingsCommandSucceeded,
} from "./lib/worker_observability_settings.mjs";
import { loadTransport } from "./worker_observability_restorer.mjs";
import {
  INSTALL_MANIFEST_SCHEMA,
  announceRestorerReady,
  assertRestorerReady,
  bindWindowToRestorer,
  clearKillSwitch,
  controllerDeathSignaled,
  engageKillSwitch,
  measureInstalledRuntimeShas,
  reconcilePendingMutation,
  restorerPaths,
  restorerTick,
  runRestorerLoop,
  sha256File,
  startSupervisedRestorerProcess,
  readBoundedRestorerLogTail,
  filterRestorerDiagnosticChunk,
  formatRestorerDiagnosticLine,
  appendBoundedRestorerLog,
  mapRestorerErrorName,
  writeGuardianFailureReceipt,
  installRestorerProcessEvidenceHandlers,
  writeRestorerReceipt,
} from "./lib/worker_observability_restorer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_SHA = createHash("sha256").update("a".repeat(32)).digest("hex");
const BASELINE = Object.freeze({
  enabled: false,
  head_sampling_rate: 1,
  redact_query_string: false,
  logs: {
    enabled: false,
    head_sampling_rate: 1,
    invocation_logs: true,
    persist: true,
    destinations: [],
  },
  traces: {
    enabled: false,
    head_sampling_rate: 1,
    persist: true,
    destinations: [],
  },
});

function memoryTransport(initial) {
  let current = structuredClone(initial);
  const calls = [];
  return {
    calls,
    async getObservability() {
      calls.push({ method: "GET" });
      return structuredClone(current);
    },
    async patchObservability(observability) {
      calls.push({ method: "PATCH", observability: structuredClone(observability) });
      current = normalizeObservability(observability);
      return structuredClone(current);
    },
    set(next) { current = normalizeObservability(next); },
    snapshot() { return structuredClone(current); },
  };
}

function installDurableRunner(stateRoot) {
  mkdirSync(join(stateRoot, "lib"), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  cpSync(join(ROOT, "tools/worker_observability_restorer.mjs"), join(stateRoot, "run.mjs"));
  cpSync(join(ROOT, "tools/lib/worker_observability_restorer.mjs"), join(stateRoot, "lib/worker_observability_restorer.mjs"));
  cpSync(join(ROOT, "tools/lib/worker_observability_settings.mjs"), join(stateRoot, "lib/worker_observability_settings.mjs"));
  chmodSync(join(stateRoot, "run.mjs"), 0o755);
}

function writeFakeTransportModule(path, initial) {
  writeFileSync(path, `let current = ${JSON.stringify(initial)};
export function createTransport() {
  return {
    async getObservability() { return structuredClone(current); },
    async patchObservability(observability) {
      current = {
        enabled: observability.enabled === true,
        head_sampling_rate: observability.head_sampling_rate ?? 1,
        redact_query_string: observability.redact_query_string === true,
        logs: { ...observability.logs },
        traces: { ...observability.traces },
      };
      return structuredClone(current);
    },
    __set(next) { current = next; },
  };
}
`, { mode: 0o600 });
}

test("ready receipt carries installed runtime commit and matching file shas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-manifest-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "lib"), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const runPath = join(stateRoot, "run.mjs");
  const restorerLib = join(stateRoot, "lib", "worker_observability_restorer.mjs");
  const settingsLib = join(stateRoot, "lib", "worker_observability_settings.mjs");
  writeFileSync(runPath, "// run\n", { mode: 0o755 });
  writeFileSync(restorerLib, "// restorer\n", { mode: 0o644 });
  writeFileSync(settingsLib, "// settings\n", { mode: 0o644 });
  const files = {
    "run.mjs": sha256File(runPath),
    "lib/worker_observability_restorer.mjs": sha256File(restorerLib),
    "lib/worker_observability_settings.mjs": sha256File(settingsLib),
  };
  writeRestorerReceipt(restorerPaths(stateRoot).installManifest, {
    schema: INSTALL_MANIFEST_SCHEMA,
    source_commit: "d03848063bf69116501e082580bc2994ba1b824e",
    includes_commit: "d03848063bf69116501e082580bc2994ba1b824e",
    files,
  });
  const store = createFileWindowStore(join(dir, "window.json"));
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "manifest-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "r-manifest" });
  await store.write(window);
  const announced = await announceRestorerReady({
    store,
    stateRoot,
    now: "2026-10-16T00:00:02.000Z",
    pid: process.pid,
  });
  assert.equal(announced.ready.installed_runtime.source_commit, "d03848063bf69116501e082580bc2994ba1b824e");
  assert.equal(announced.ready.installed_runtime.matches_manifest, true);
  assert.deepEqual(announced.ready.installed_runtime.files, files);
  assert.deepEqual(measureInstalledRuntimeShas(stateRoot), files);
  rmSync(dir, { recursive: true, force: true });
});

test("settings success statuses cover captured privacy-armed enabled restored", () => {
  for (const status of ["ok", "captured", "privacy-armed", "enabled", "restored", "already-restored", "complete"]) {
    assert.equal(settingsCommandSucceeded({ status }), true);
    assert.ok(SETTINGS_SUCCESS_STATUSES.includes(status));
  }
  assert.equal(settingsCommandSucceeded({ status: "blocked" }), false);
  assert.equal(settingsCommandSucceeded({ status: "partial" }), false);
});

test("window lock serializes concurrent writers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-lock-"));
  const path = join(dir, "window.json");
  const store = createFileWindowStore(path);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "lock-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  await store.write(window);

  let concurrent = 0;
  let maxConcurrent = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => store.withLock(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    const current = await store.read();
    current.mutations = [...(current.mutations || []), { at: `2026-10-16T00:00:0${index}.000Z`, kind: "lock-test", index }];
    await store.write(current);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
  }));
  await Promise.all(tasks);
  assert.equal(maxConcurrent, 1);
  const final = await store.read();
  assert.equal(final.mutations.filter((entry) => entry.kind === "lock-test").length, 8);
  rmSync(dir, { recursive: true, force: true });
});

test("readiness handshake requires live supervised pid and matching receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-ready-"));
  const stateRoot = join(dir, "restorer");
  const windowPath = join(dir, "window.json");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(windowPath);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "ready-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "r1" });
  await store.write(window);
  assert.throws(() => assertRestorerReady(window, { stateRoot }), /supervised restorer runtime/);

  window = bindWindowToRestorer(window, { pid: process.pid, stateRoot, restorerId: "r1" });
  await store.write(window);
  assert.throws(() => assertRestorerReady(window, { stateRoot }), /readiness receipt is missing/);

  const announced = await announceRestorerReady({ store, stateRoot, now: "2026-10-16T00:00:02.000Z", pid: process.pid });
  const ready = assertRestorerReady(announced.window, { stateRoot, now: "2026-10-16T00:00:02.500Z" });
  assert.equal(ready.ready.window_id, "ready-1");
  assert.equal(ready.runtime.pid, process.pid);
  rmSync(dir, { recursive: true, force: true });
});

test("healthy owned window with future expiry stays idle (no early restore)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-idle-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const windowPath = join(dir, "window.json");
  const store = createFileWindowStore(windowPath);
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(armed);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "idle-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);

  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:05:00.000Z",
  });
  assert.equal(tick.outcome, "idle");
  assert.equal(tick.reason, "owned-window-active-until-deadline");
  assert.equal(tick.window.phase, "privacy_armed");
  assert.equal(tick.window.owned_sha256, observabilitySha256(armed));
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  assert.ok(observabilityEquals(transport.snapshot(), armed));
  rmSync(dir, { recursive: true, force: true });
});

test("pending-after while healthy reconciles to owned without restoring baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-pending-after-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(armed);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "pending-after-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  window = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  await store.write(window);

  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(tick.outcome, "reconciled-owned");
  assert.equal(tick.window.phase, "privacy_armed");
  assert.equal(tick.window.pending_mutation, null);
  assert.equal(tick.window.owned_sha256, observabilitySha256(armed));
  assert.ok(observabilityEquals(transport.snapshot(), armed));
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  rmSync(dir, { recursive: true, force: true });
});

test("pending-before while healthy clears intent without closing the window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-pending-before-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const transport = memoryTransport(BASELINE);
  const armed = privacyArmedObservability(BASELINE);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "pending-before-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  window = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  // Unissued write-ahead only: PATCH never left the controller.
  assert.equal(window.pending_mutation.issued, false);
  await store.write(window);

  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(tick.outcome, "reconciled-cleared");
  assert.equal(tick.window.phase, "captured");
  assert.equal(tick.window.pending_mutation, null);
  assert.equal(tick.window.owned_observability, null);
  assert.ok(["captured"].includes(tick.window.phase));
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  rmSync(dir, { recursive: true, force: true });
});

test("issued pending retained on prestate GET; later intended-after restores at expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-issued-retain-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(BASELINE);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 120,
    windowId: "issued-retain-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "restorer-issued-1" });
  window = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  window = markPendingMutationIssued(window, {
    now: "2026-10-16T00:00:31.000Z",
    exchange: { http_status: 200, success: true },
  });
  await store.write(window);

  const retain = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(retain.outcome, "retained-pending-unknown");
  assert.ok(retain.window.pending_mutation);
  assert.equal(retain.window.pending_mutation.issued, true);
  assert.equal(retain.window.pending_mutation.after_sha256, observabilitySha256(armed));
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);

  // Later the intended target becomes visible. Expiry must restore it, not refuse.
  transport.set(armed);
  const expired = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:03:00.000Z",
  });
  assert.equal(expired.proved, true);
  assert.ok(["restored", "already-restored"].includes(expired.action));
  assert.ok(observabilityEquals(expired.after, BASELINE));
  assert.notEqual(expired.action, "refuse-conflict");
  assert.equal(expired.terminal_receipt.outcome, expired.action);
  rmSync(dir, { recursive: true, force: true });
});

test("controller death mid-flight: baseline GET retains ownership; late visibility restores", async () => {
  // Explicit bound controller-death receipt + memory provider (not SIGKILL).
  // While an in-flight issued write is still unresolved, baseline GET must not
  // erase after-target or claim terminal restored on the death path; repeated
  // unresolved polls stay bounded.
  const dir = mkdtempSync(join(tmpdir(), "cc05-midflight-death-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(BASELINE);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "midflight-death-1",
  });
  window = armRestorer(window, {
    now: "2026-10-16T00:00:01.000Z",
    restorerId: "restorer-midflight-1",
  });
  window = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  window = markPendingMutationIssued(window, {
    now: "2026-10-16T00:00:31.000Z",
    exchange: { http_status: null, success: null },
  });
  await store.write(window);

  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: "2026-10-16T00:00:40.000Z",
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
  });

  // PATCH still in flight: provider GET is baseline. Must retain issued ownership.
  const midflight = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:00:41.000Z",
  });
  assert.equal(midflight.outcome, "retained-pending-unknown");
  assert.ok(midflight.window.pending_mutation);
  assert.equal(midflight.window.pending_mutation.issued, true);
  assert.equal(
    midflight.window.pending_mutation.after_sha256,
    observabilitySha256(armed),
  );
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  const retainCountAfterFirst = (midflight.window.mutations || [])
    .filter((m) => m.kind === "pending-retained-unknown").length;
  assert.equal(retainCountAfterFirst, 1);

  // Repeated unresolved polls must not append unlimited identical retain rows.
  const midflightAgain = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:00:45.000Z",
  });
  assert.equal(midflightAgain.outcome, "retained-pending-unknown");
  assert.equal(midflightAgain.receipt.retain_history_appended, false);
  const retainCountAfterRepeat = (midflightAgain.window.mutations || [])
    .filter((m) => m.kind === "pending-retained-unknown").length;
  assert.equal(retainCountAfterRepeat, 1);
  assert.equal(
    midflightAgain.window.pending_mutation.after_sha256,
    observabilitySha256(armed),
  );

  // Late visibility of the in-flight PATCH: restore must keep ownership and
  // return to baseline, never refuse-conflict as a foreign write.
  transport.set(armed);
  const restored = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:00:50.000Z",
  });
  assert.equal(restored.proved, true);
  assert.ok(["restored", "already-restored"].includes(restored.action));
  assert.ok(observabilityEquals(restored.after, BASELINE));
  assert.notEqual(restored.action, "refuse-conflict");
  assert.equal(restored.terminal_receipt.controller_death, true);
  assert.equal(observabilityEquals(transport.snapshot(), BASELINE), true);
  rmSync(dir, { recursive: true, force: true });
});

test("expiry mid-flight: baseline GET retains ownership; late visibility restores", async () => {
  // Same unresolved issued-write obligation on the expiry path.
  const dir = mkdtempSync(join(tmpdir(), "cc05-midflight-expiry-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(BASELINE);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 60,
    windowId: "midflight-expiry-1",
  });
  window = armRestorer(window, {
    now: "2026-10-16T00:00:01.000Z",
    restorerId: "restorer-midflight-expiry-1",
  });
  window = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  window = markPendingMutationIssued(window, {
    now: "2026-10-16T00:00:31.000Z",
    exchange: { http_status: null, success: null },
  });
  await store.write(window);

  const atExpiry = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:02:00.000Z",
  });
  assert.equal(atExpiry.outcome, "retained-pending-unknown");
  assert.ok(atExpiry.window.pending_mutation);
  assert.equal(atExpiry.window.pending_mutation.issued, true);
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);

  transport.set(armed);
  const restored = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:02:10.000Z",
  });
  assert.equal(restored.proved, true);
  assert.ok(["restored", "already-restored"].includes(restored.action));
  assert.ok(observabilityEquals(restored.after, BASELINE));
  assert.notEqual(restored.action, "refuse-conflict");
  assert.equal(restored.terminal_receipt.expired, true);
  rmSync(dir, { recursive: true, force: true });
});

test("restorer tick restores owned settings with GET proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tick-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const windowPath = join(dir, "window.json");
  const store = createFileWindowStore(windowPath);
  const transport = memoryTransport(BASELINE);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 60,
    windowId: "tick-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  const armed = privacyArmedObservability(BASELINE);
  window = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);
  transport.set(armed);

  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:02:00.000Z",
  });
  assert.equal(tick.proved, true);
  assert.ok(["restored", "already-restored"].includes(tick.action));
  assert.ok(observabilityEquals(tick.after, BASELINE));
  assert.equal(tick.terminal_receipt.proved, true);
  assert.ok(existsSync(restorerPaths(stateRoot).terminalReceipt));
  rmSync(dir, { recursive: true, force: true });
});

test("controller-death receipt restores owned window before deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-death-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(armed);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "death-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "restorer-death-1" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);
  assert.equal(controllerDeathSignaled(stateRoot, {
    windowId: window.window_id,
    restorerId: window.restorer.restorer_id,
  }), false);

  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: "2026-10-16T00:05:00.000Z",
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
  });
  assert.equal(controllerDeathSignaled(stateRoot, {
    windowId: window.window_id,
    restorerId: window.restorer.restorer_id,
  }), true);

  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:05:01.000Z",
  });
  assert.equal(tick.proved, true);
  assert.ok(["restored", "already-restored"].includes(tick.action));
  assert.ok(observabilityEquals(tick.after, BASELINE));
  assert.equal(tick.terminal_receipt.controller_death, true);
  rmSync(dir, { recursive: true, force: true });
});

test("stale controller-death receipt for another window is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-stale-death-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const store = createFileWindowStore(join(dir, "window.json"));
  const armed = privacyArmedObservability(BASELINE);
  const transport = memoryTransport(armed);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "fresh-window-1",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "restorer-fresh-1" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);

  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: "2026-10-16T00:05:00.000Z",
    window_id: "old-window-id",
    restorer_id: "old-restorer-id",
  });
  assert.equal(controllerDeathSignaled(stateRoot, {
    windowId: window.window_id,
    restorerId: window.restorer.restorer_id,
  }), false);

  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: "2026-10-16T00:05:01.000Z",
  });
  assert.equal(tick.outcome, "idle");
  assert.equal(tick.window.phase, "privacy_armed");
  assert.ok(observabilityEquals(transport.snapshot(), armed));
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  rmSync(dir, { recursive: true, force: true });
});

test("process-kill fixture: restorer survives controller death and restores", async () => {
  // Limits of this death proof (honest): the controller exits 0 after spawning the
  // restorer; the test parent writes the window-bound death receipt by hand. This
  // is not a SIGKILL and not automatic death detection. Deadline restoration is
  // the bounded fallback that still proves the durable restorer can finish.
  const dir = mkdtempSync(join(tmpdir(), "cc05-kill-"));
  const stateRoot = join(dir, "restorer");
  installDurableRunner(stateRoot);
  clearKillSwitch(stateRoot);
  const windowPath = join(dir, "window.json");
  const transportModule = join(dir, "fake-transport.mjs");
  const armed = privacyArmedObservability(BASELINE);
  writeFakeTransportModule(transportModule, armed);

  const store = createFileWindowStore(windowPath);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date(Date.now() - 2_000).toISOString(),
    durationSeconds: 3,
    windowId: "kill-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "kill-restorer" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);

  // Controller process: starts restorer child, then exits 0 (not SIGKILL).
  const controllerScript = join(dir, "controller.mjs");
  writeFileSync(controllerScript, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const transportUrl = pathToFileURL(${JSON.stringify(transportModule)}).href;
const child = spawn(process.execPath, [
  ${JSON.stringify(join(stateRoot, "run.mjs"))},
  "--window-state", ${JSON.stringify(windowPath)},
  "--state-root", ${JSON.stringify(stateRoot)},
  "--poll-ms", "100",
  "--window-id", "kill-1",
], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: transportUrl,
    CLOUDFLARE_ACCOUNT_ID: ${JSON.stringify("a".repeat(32))},
    CLOUDFLARE_WORKER_ID: "cityscroll-worker",
  },
});
child.unref();
writeFileSync(${JSON.stringify(join(dir, "controller-spawned.json"))}, JSON.stringify({ restorer_pid: child.pid, controller_pid: process.pid }) + "\\n");
setTimeout(() => process.exit(0), 50);
`);

  await new Promise((resolve, reject) => {
    const controller = spawn(process.execPath, [controllerScript], { stdio: "ignore" });
    controller.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`controller exit ${code}`))));
  });

  const spawned = JSON.parse(readFileSync(join(dir, "controller-spawned.json"), "utf8"));
  assert.ok(spawned.restorer_pid > 0);

  // Hand-written, window-bound death receipt (not automatic detection).
  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    restorer_pid: spawned.restorer_pid,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
    detection: "test-parent-handwritten-receipt",
    not_sigkill: true,
    not_automatic_liveness_detection: true,
  });

  const terminalPath = restorerPaths(stateRoot).terminalReceipt;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !existsSync(terminalPath)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(terminalPath), "restorer terminal receipt after controller death");
  const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
  assert.equal(terminal.proved, true);
  assert.ok(["restored", "already-restored"].includes(terminal.outcome));

  // Stop restorer child
  try { process.kill(spawned.restorer_pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("kill switch stops restorer work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-ks-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  engageKillSwitch(stateRoot);
  const store = createFileWindowStore(join(dir, "window.json"));
  const transport = memoryTransport(BASELINE);
  const tick = await restorerTick({
    store,
    transport,
    stateRoot,
    now: new Date().toISOString(),
  });
  assert.equal(tick.outcome, "kill-switch");
  clearKillSwitch(stateRoot);
  rmSync(dir, { recursive: true, force: true });
});

test("root d038 response-loss triad: enable-after-arm, issued-before-dispatch, retain on prestate", async () => {
  // Built on root's reproduce.mjs against a696e13f (zero provider calls).
  const now = "2026-10-16T00:00:00.000Z";
  const base = BASELINE;
  let w = armRestorer(openSettingsWindow({
    baseline: base,
    accountIdSha256: ACCOUNT_SHA,
    now,
    windowId: "root-d038",
  }), { now, restorerId: "root-d038-r" });
  const armed = privacyArmedObservability(base);
  w = recordMutationIntent(w, {
    phase: "privacy_armed",
    beforeSha256: observabilitySha256(base),
    intendedObservability: armed,
    now,
  });
  w = confirmOwnedSettings(w, armed, { now });
  const enabled = {
    ...armed,
    enabled: true,
    logs: { ...armed.logs, enabled: true },
  };
  let pending = markPendingMutationIssued(recordMutationIntent(w, {
    phase: "enabled",
    beforeSha256: observabilitySha256(armed),
    intendedObservability: enabled,
    now,
  }), { now });
  const valid = await reconcilePendingMutation({
    window: pending,
    transport: { async getObservability() { return structuredClone(armed); } },
    now,
  });
  assert.equal(valid.outcome, "retained-pending-unknown");
  assert.equal(valid.classification.class, "pending-before");
  assert.equal(Boolean(valid.window.pending_mutation), true);

  let persisted = structuredClone(w);
  let dispatched = false;
  const store = {
    async read() { return structuredClone(persisted); },
    async write(next) { persisted = structuredClone(next); },
  };
  void mutateOwnedWindowObservability({
    store,
    transport: {
      async getObservability() { return structuredClone(armed); },
      async patchObservability() {
        dispatched = true;
        return new Promise(() => {});
      },
    },
    expectedSha256: observabilitySha256(armed),
    nextObservability: enabled,
    phase: "enabled",
    now,
    requireLiveRestorer: false,
    alreadyLocked: true,
  });
  await new Promise((r) => setTimeout(r, 20));
  const crashed = structuredClone(persisted);
  assert.equal(dispatched, true);
  assert.equal(Boolean(crashed.pending_mutation?.issued), true);

  let privacyPersisted = armRestorer(openSettingsWindow({
    baseline: base,
    accountIdSha256: ACCOUNT_SHA,
    now,
    windowId: "root-gap",
  }), { now, restorerId: "root-gap-r" });
  void mutateOwnedWindowObservability({
    store: {
      async read() { return structuredClone(privacyPersisted); },
      async write(n) { privacyPersisted = structuredClone(n); },
    },
    transport: {
      async getObservability() { return structuredClone(base); },
      async patchObservability() { return new Promise(() => {}); },
    },
    expectedSha256: observabilitySha256(base),
    nextObservability: armed,
    phase: "privacy_armed",
    now,
    requireLiveRestorer: false,
    alreadyLocked: true,
  });
  await new Promise((r) => setTimeout(r, 20));
  const gap = await reconcilePendingMutation({
    window: privacyPersisted,
    transport: { async getObservability() { return structuredClone(base); } },
    now,
  });
  assert.equal(gap.outcome, "retained-pending-unknown");
  assert.equal(Boolean(gap.window.pending_mutation), true);
  assert.equal(gap.window.pending_mutation.issued, true);
});

test("loadTransport refuses exact-layer window without dual-view module", async () => {
  const armed = privacyArmedObservability(BASELINE);
  let window = openExactLayerSettingsWindow({
    effectiveBaseline: BASELINE,
    scriptOverrideBaseline: null,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "load-transport-exact",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "r-lt" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
  };

  const dir = mkdtempSync(join(tmpdir(), "cc05-lt-"));
  const betaModule = join(dir, "beta-only.mjs");
  writeFakeTransportModule(betaModule, armed);
  await assert.rejects(
    () => loadTransport({
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_WORKER_ID: "cityscroll-worker",
      CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: `file://${betaModule}`,
    }, { window }),
    /refusing silent beta fallback/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("loadTransport refuses account or worker mismatch before any GET or PATCH", async () => {
  const armed = privacyArmedObservability(BASELINE);
  let window = openExactLayerSettingsWindow({
    effectiveBaseline: BASELINE,
    scriptOverrideBaseline: null,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "load-transport-bind",
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "r-bind" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
  };

  const dir = mkdtempSync(join(tmpdir(), "cc05-lt-bind-"));
  const dualModule = join(dir, "dual.mjs");
  writeFileSync(dualModule, `export function createTransport() {
  return {
    async getDualView() { throw new Error("GET must not run after target mismatch"); },
    async restoreScriptOverrideToNull() { throw new Error("PATCH must not run after target mismatch"); },
    async getObservability() { throw new Error("GET must not run after target mismatch"); },
    async patchObservability() { throw new Error("PATCH must not run after target mismatch"); },
  };
}
`, { mode: 0o600 });

  await assert.rejects(
    () => loadTransport({
      CLOUDFLARE_ACCOUNT_ID: "different-account",
      CLOUDFLARE_WORKER_ID: "cityscroll-worker",
      CLOUDFLARE_API_TOKEN: "in-memory-test-placeholder",
      CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: `file://${dualModule}`,
    }, { window }),
    /does not match window account_id_sha256/,
  );
  await assert.rejects(
    () => loadTransport({
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_WORKER_ID: "different-worker",
      CLOUDFLARE_API_TOKEN: "in-memory-test-placeholder",
      CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: `file://${dualModule}`,
    }, { window }),
    /does not match window worker_id/,
  );
  rmSync(dir, { recursive: true, force: true });
});

function independentProcessListing(pid) {
  const listed = spawnSync("ps", ["-p", String(pid), "-ww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  if (listed.status !== 0 || !String(listed.stdout || "").trim()) return null;
  const line = String(listed.stdout).trim();
  const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    command: match[3],
    detection: "independent-ps-listing",
  };
}

test("supervised exact-layer fixture: dual-view after controller exit, foreign refuse, reinstall", async () => {
  // Offline supervised-process proof (no provider calls).
  // Limits (honest): controller-death is a handwritten parent receipt, not automatic
  // SIGKILL detection. Birth/argv are proved from an independent `ps` listing of the
  // live restorer pid, not only from what the controller wrote. Foreign-conflict
  // refusal runs inside a pinned-library child (imports settings lib directly; not
  // the full guardian CLI / durable run.mjs), not in the test parent.
  const dir = mkdtempSync(join(tmpdir(), "cc05-supervised-exact-"));
  const stateRoot = join(dir, "restorer");
  installDurableRunner(stateRoot);
  clearKillSwitch(stateRoot);

  const armed = privacyArmedObservability(BASELINE);
  const dualStatePath = join(dir, "dual-state.json");
  writeFileSync(dualStatePath, JSON.stringify({
    script: {
      logpush: false,
      tags: ["supervised"],
      tail_consumers: [],
      observability: armed,
    },
    effective: armed,
    patch_count: 0,
  }), { mode: 0o600 });

  const baselineSha = observabilitySha256(BASELINE);
  const armedSha = observabilitySha256(armed);
  const transportModule = join(dir, "dual-transport.mjs");
  writeFileSync(transportModule, `import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(dualStatePath)};
const BASELINE = ${JSON.stringify(BASELINE)};
const BASELINE_SHA = ${JSON.stringify(baselineSha)};
const ARMED_SHA = ${JSON.stringify(armedSha)};
function load() { return JSON.parse(readFileSync(statePath, "utf8")); }
function save(state) { writeFileSync(statePath, JSON.stringify(state)); }
function effectiveSha(effective) {
  if (effective && effective.redact_query_string === true) return ARMED_SHA;
  return BASELINE_SHA;
}
export function createTransport() {
  return {
    endpoint: "dual-view-script-settings+beta",
    async getObservability() { return structuredClone(load().effective); },
    async patchObservability() { throw new Error("beta PATCH forbidden in exact-layer fixture"); },
    async getDualView() {
      const state = load();
      const scriptOverride = state.script.observability;
      return {
        script_override: scriptOverride === null ? null : structuredClone(scriptOverride),
        script_override_is_null: scriptOverride === null,
        effective: structuredClone(state.effective),
        effective_sha256: effectiveSha(state.effective),
        script_settings_metadata: {
          logpush: state.script.logpush ?? null,
          tags: Array.isArray(state.script.tags) ? [...state.script.tags].sort() : state.script.tags ?? null,
          tail_consumers_len: Array.isArray(state.script.tail_consumers) ? state.script.tail_consumers.length : null,
          top_keys: Object.keys(state.script).sort(),
        },
        script_settings_raw_top_keys: Object.keys(state.script).sort(),
      };
    },
    async restoreScriptOverrideToNull() {
      const state = load();
      state.patch_count = (state.patch_count || 0) + 1;
      state.script = { ...state.script, observability: null };
      state.effective = structuredClone(BASELINE);
      save(state);
      return null;
    },
  };
}
`, { mode: 0o600 });

  const windowPath = join(dir, "window.json");
  const store = createFileWindowStore(windowPath);
  let window = openExactLayerSettingsWindow({
    effectiveBaseline: BASELINE,
    scriptOverrideBaseline: null,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date(Date.now() - 2_000).toISOString(),
    durationSeconds: 8,
    windowId: "supervised-exact-1",
  });
  assert.equal(window.script_layer.restore_mode, SCRIPT_LAYER_RESTORE_MODE);
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "supervised-exact-restorer" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);

  const controllerScript = join(dir, "controller.mjs");
  const spawnHintPath = join(dir, "spawn-hint.json");
  writeFileSync(controllerScript, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const transportUrl = pathToFileURL(${JSON.stringify(transportModule)}).href;
const argv = [
  ${JSON.stringify(join(stateRoot, "run.mjs"))},
  "--window-state", ${JSON.stringify(windowPath)},
  "--state-root", ${JSON.stringify(stateRoot)},
  "--poll-ms", "100",
  "--window-id", "supervised-exact-1",
];
const child = spawn(process.execPath, argv, {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: transportUrl,
    CLOUDFLARE_ACCOUNT_ID: ${JSON.stringify("a".repeat(32))},
    CLOUDFLARE_WORKER_ID: "cityscroll-worker",
  },
});
child.unref();
writeFileSync(${JSON.stringify(spawnHintPath)}, JSON.stringify({
  restorer_pid_hint: child.pid,
  controller_pid: process.pid,
  intended_argv: argv,
  note: "hint only; authoritative birth comes from independent ps",
}) + "\\n");
setTimeout(() => process.exit(0), 80);
`, { mode: 0o600 });

  await new Promise((resolve, reject) => {
    const controller = spawn(process.execPath, [controllerScript], { stdio: "ignore" });
    controller.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`controller exit ${code}`))));
  });

  const spawnHint = JSON.parse(readFileSync(spawnHintPath, "utf8"));
  assert.ok(spawnHint.restorer_pid_hint > 0);

  const paths = restorerPaths(stateRoot);
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.readyReceipt), "ready receipt after supervised spawn");
  const ready = JSON.parse(readFileSync(paths.readyReceipt, "utf8"));
  assert.equal(ready.window_id, "supervised-exact-1");
  assert.equal(ready.restorer_id, "supervised-exact-restorer");
  assert.equal(ready.pid, spawnHint.restorer_pid_hint);

  // Independent process listing (ps), not the controller's self-written birth record.
  const listing = independentProcessListing(ready.pid);
  assert.ok(listing, "independent ps listing of restorer pid");
  assert.equal(listing.pid, ready.pid);
  assert.ok(listing.command.includes("run.mjs"), listing.command);
  assert.ok(listing.command.includes("--window-id"), listing.command);
  assert.ok(listing.command.includes("supervised-exact-1"), listing.command);
  assert.equal(listing.detection, "independent-ps-listing");

  // Heartbeat timestamps must advance past ready and past controller exit.
  assert.ok(existsSync(paths.heartbeatReceipt), "heartbeat after controller exit");
  const heartbeat1 = JSON.parse(readFileSync(paths.heartbeatReceipt, "utf8"));
  assert.equal(heartbeat1.pid, ready.pid);
  assert.equal(heartbeat1.window_id, "supervised-exact-1");
  const t1 = Date.parse(heartbeat1.observed_at);
  assert.ok(Number.isFinite(t1));
  assert.ok(t1 >= Date.parse(ready.observed_at) || t1 >= Date.parse(ready.started_at || ready.observed_at));

  await new Promise((resolve) => setTimeout(resolve, 250));
  const heartbeat2 = JSON.parse(readFileSync(paths.heartbeatReceipt, "utf8"));
  assert.equal(heartbeat2.pid, ready.pid);
  const t2 = Date.parse(heartbeat2.observed_at);
  assert.ok(t2 > t1, `heartbeat must advance: ${heartbeat1.observed_at} -> ${heartbeat2.observed_at}`);

  writeRestorerReceipt(paths.controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    restorer_pid: ready.pid,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
    detection: "test-parent-handwritten-receipt",
    not_sigkill: true,
    not_automatic_liveness_detection: true,
    independent_ps_listing: listing,
  });

  const terminalPath = paths.terminalReceipt;
  const terminalDeadline = Date.now() + 15_000;
  while (Date.now() < terminalDeadline && !existsSync(terminalPath)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(terminalPath), "terminal receipt after exact-layer restore");
  const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
  assert.equal(terminal.proved, true);
  assert.ok(["restored", "already-restored"].includes(terminal.outcome));
  const dualAfter = JSON.parse(readFileSync(dualStatePath, "utf8"));
  assert.equal(dualAfter.script.observability, null);
  assert.ok(dualAfter.patch_count >= 1);

  try { process.kill(ready.pid, "SIGTERM"); } catch { /* gone */ }

  // Foreign conflict refusal inside a pinned-library CHILD (not the test parent,
  // and not the full guardian CLI). Labels stay honest: no SIGKILL claim.
  const foreignDir = join(dir, "foreign");
  mkdirSync(foreignDir, { recursive: true, mode: 0o700 });
  const foreignState = join(foreignDir, "dual-state.json");
  const foreignResultPath = join(foreignDir, "result.json");
  const foreignObs = { ...armed, head_sampling_rate: 0.25, logs: { ...armed.logs, head_sampling_rate: 0.25 } };
  writeFileSync(foreignState, JSON.stringify({
    script: { logpush: false, tags: [], tail_consumers: [], observability: foreignObs },
    effective: foreignObs,
    patch_count: 0,
  }));
  const foreignChild = join(foreignDir, "foreign-child.mjs");
  writeFileSync(foreignChild, `
import { readFileSync, writeFileSync } from "node:fs";
import {
  openExactLayerSettingsWindow,
  armRestorer,
  planExactLayerRestore,
  restoreExactLayerSettingsWindow,
  privacyArmedObservability,
  observabilitySha256,
} from ${JSON.stringify(join(ROOT, "tools/lib/worker_observability_settings.mjs"))};

const BASELINE = ${JSON.stringify(BASELINE)};
const ACCOUNT_SHA = ${JSON.stringify(ACCOUNT_SHA)};
const foreignState = ${JSON.stringify(foreignState)};
const armed = privacyArmedObservability(BASELINE);
const foreignDual = {
  async getDualView() {
    const state = JSON.parse(readFileSync(foreignState, "utf8"));
    return {
      script_override: state.script.observability,
      script_override_is_null: state.script.observability === null,
      effective: state.effective,
      effective_sha256: observabilitySha256(state.effective),
      script_settings_metadata: {
        logpush: false, tags: [], tail_consumers_len: 0,
        top_keys: Object.keys(state.script).sort(),
      },
    };
  },
  async restoreScriptOverrideToNull() {
    const state = JSON.parse(readFileSync(foreignState, "utf8"));
    state.patch_count += 1;
    writeFileSync(foreignState, JSON.stringify(state));
    throw new Error("foreign restore must not PATCH");
  },
};
let foreignWindow = openExactLayerSettingsWindow({
  effectiveBaseline: BASELINE,
  scriptOverrideBaseline: null,
  accountIdSha256: ACCOUNT_SHA,
  now: new Date().toISOString(),
  windowId: "supervised-foreign-1",
});
foreignWindow = armRestorer(foreignWindow, { now: new Date().toISOString(), restorerId: "r-foreign-child" });
foreignWindow = {
  ...foreignWindow,
  phase: "privacy_armed",
  owned_observability: armed,
  owned_sha256: observabilitySha256(armed),
};
const before = await foreignDual.getDualView();
const plan = planExactLayerRestore(before, foreignWindow);
const result = await restoreExactLayerSettingsWindow(foreignWindow, foreignDual, {
  now: new Date().toISOString(),
});
writeFileSync(${JSON.stringify(foreignResultPath)}, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  plan_action: plan.action,
  result_action: result.action,
  proved: result.proved,
  patch_count: JSON.parse(readFileSync(foreignState, "utf8")).patch_count,
  detection: "pinned-library-child-foreign-conflict",
  not_guardian_cli: true,
  not_automatic_sigkill: true,
}) + "\\n");
`, { mode: 0o600 });

  const foreignRun = spawnSync(process.execPath, [foreignChild], { encoding: "utf8" });
  assert.equal(foreignRun.status, 0, foreignRun.stderr || foreignRun.stdout);
  const foreignProof = JSON.parse(readFileSync(foreignResultPath, "utf8"));
  assert.equal(foreignProof.plan_action, "refuse-conflict");
  assert.equal(foreignProof.result_action, "refuse-conflict");
  assert.equal(foreignProof.proved, false);
  assert.equal(foreignProof.patch_count, 0);
  assert.equal(foreignProof.detection, "pinned-library-child-foreign-conflict");
  assert.equal(foreignProof.not_guardian_cli, true);
  assert.equal(foreignProof.not_automatic_sigkill, true);
  assert.ok(foreignProof.pid > 0);
  assert.notEqual(foreignProof.pid, process.pid);

  // Exact reinstall with manifest into a fresh state root; leave no assigned window.
  const reinstallRoot = join(dir, "reinstall-root");
  writeFileSync(join(dir, "fake-token"), "test-token\n", { mode: 0o600 });
  const install = spawnSync("bash", [join(ROOT, "tools/install_observability_settings_restorer.sh")], {
    env: {
      ...process.env,
      CITYSCROLL_OBSERVABILITY_RESTORER_STATE: reinstallRoot,
      CITYSCROLL_NODE: process.execPath,
      CLOUDFLARE_API_TOKEN_FILE: join(dir, "fake-token"),
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      HOME: dir,
    },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const manifest = JSON.parse(readFileSync(join(reinstallRoot, "install-manifest.json"), "utf8"));
  assert.equal(manifest.schema, INSTALL_MANIFEST_SCHEMA);
  assert.ok(manifest.files["run.mjs"]);
  assert.ok(manifest.files["lib/worker_observability_settings.mjs"]);
  assert.deepEqual(measureInstalledRuntimeShas(reinstallRoot), manifest.files);
  assert.equal(existsSync(join(reinstallRoot, "assigned-window.json")), false);
  assert.equal(existsSync(join(reinstallRoot, "restorer.pid")), false);

  rmSync(dir, { recursive: true, force: true });
});

test("restore readback-mismatch returns proved:false without throwing", async () => {
  const armed = privacyArmedObservability(BASELINE);
  const sticky = {
    async getObservability() { return structuredClone(armed); },
    async patchObservability() { return structuredClone(armed); }, // silent no-op vs baseline
  };
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    windowId: "restore-mismatch-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "rr-1" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
  };
  const result = await restoreSettingsWindow(window, sticky, { now: new Date().toISOString() });
  assert.equal(result.action, "restore-readback-mismatch");
  assert.equal(result.proved, false);
  assert.equal(result.window.owned_sha256, observabilitySha256(armed));
  assert.equal(result.receipt.config_revert_available, false);
  assert.equal(result.receipt.actuator_error_code, "config-revert-unavailable");
  assert.equal(result.receipt.ownership_preserved, true);
  assert.match(result.receipt.reason, /actuator unavailable|did not prove baseline/);
});

test("optional config-revert actuator restores after beta readback mismatch", async () => {
  const armed = privacyArmedObservability(BASELINE);
  let current = structuredClone(armed);
  let revertCalls = 0;
  const transport = {
    async getObservability() { return structuredClone(current); },
    async patchObservability() { /* beta no-op: leave armed */ return structuredClone(current); },
    async revertObservabilityToBaseline(baseline) {
      revertCalls += 1;
      current = normalizeObservability(baseline);
      return structuredClone(current);
    },
  };
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    windowId: "restore-actuator-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "rr-act" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
  };
  const result = await restoreSettingsWindow(window, transport, { now: new Date().toISOString() });
  assert.equal(revertCalls, 1);
  assert.equal(result.proved, true);
  assert.equal(result.action, "restored-via-config-revert");
  assert.equal(result.window.owned_sha256, null);
  assert.equal(observabilitySha256(result.after), observabilitySha256(BASELINE));
});

test("config-revert fallback refuses when post-patch GET shows foreign state", async () => {
  // Initial GET shows owned; beta PATCH; next GET shows foreign. Fallback must
  // be called 0 times, foreign state preserved, no baseline-success receipt.
  const armed = privacyArmedObservability(BASELINE);
  const foreign = {
    ...armed,
    head_sampling_rate: 0.25,
    logs: { ...armed.logs, head_sampling_rate: 0.25 },
  };
  let gets = 0;
  let revertCalls = 0;
  const transport = {
    async getObservability() {
      gets += 1;
      // 1st GET (plan): owned. 2nd GET (post-PATCH): foreign.
      return structuredClone(gets === 1 ? armed : foreign);
    },
    async patchObservability() { return structuredClone(armed); },
    async revertObservabilityToBaseline() {
      revertCalls += 1;
      throw new Error("config-revert must not run on foreign readback");
    },
  };
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    windowId: "restore-foreign-fallback-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "rr-foreign" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
  };
  const result = await restoreSettingsWindow(window, transport, { now: new Date().toISOString() });
  assert.equal(revertCalls, 0);
  assert.equal(result.action, "refuse-conflict");
  assert.equal(result.proved, false);
  assert.equal(result.receipt.config_revert_invoked, false);
  assert.equal(result.window.owned_sha256, observabilitySha256(armed));
  assert.equal(observabilitySha256(result.after), observabilitySha256(foreign));
  assert.match(result.receipt.reason, /foreign/);
});

test("restorerTick stays nonterminal on restore-readback-mismatch after controller death", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-mismatch-tick-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  clearKillSwitch(stateRoot);
  const armed = privacyArmedObservability(BASELINE);
  const store = createFileWindowStore(join(dir, "window.json"));
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    durationSeconds: 120,
    windowId: "mismatch-tick-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "mismatch-r" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  window = bindWindowToRestorer(window, {
    pid: process.pid,
    stateRoot,
    restorerId: window.restorer.restorer_id,
  });
  await store.write(window);
  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
  });
  const sticky = {
    async getObservability() { return structuredClone(armed); },
    async patchObservability() { return structuredClone(armed); },
  };
  const tick = await restorerTick({
    store,
    transport: sticky,
    stateRoot,
    now: new Date().toISOString(),
  });
  assert.equal(tick.action, "restore-readback-mismatch");
  assert.equal(tick.proved, false);
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  const heartbeat = JSON.parse(readFileSync(restorerPaths(stateRoot).heartbeatReceipt, "utf8"));
  assert.equal(heartbeat.outcome, "restore-readback-mismatch");
  assert.equal(heartbeat.proved, false);
  // Ownership retained for retry / config-revert actuator.
  const durable = await store.read();
  assert.equal(durable.owned_sha256, observabilitySha256(armed));
  rmSync(dir, { recursive: true, force: true });
});

test("startSupervisedRestorerProcess child self-evidence writes guardian-owned process-exit receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-stdio-"));
  const stateRoot = join(dir, "restorer");
  installDurableRunner(stateRoot);
  clearKillSwitch(stateRoot);
  // Crashing child installs evidence handlers and writes a coded diagnostic +
  // guardian-owned process-exit receipt. Raw stderr is not teed.
  const libUrl = pathToFileURL(join(stateRoot, "lib/worker_observability_restorer.mjs")).href;
  writeFileSync(join(stateRoot, "run.mjs"), `#!/usr/bin/env node
import {
  installRestorerProcessEvidenceHandlers,
  writeGuardianFailureReceipt,
  formatRestorerDiagnosticLine,
  appendBoundedRestorerLog,
  restorerPaths,
} from ${JSON.stringify(libUrl)};
const stateRoot = ${JSON.stringify(stateRoot)};
installRestorerProcessEvidenceHandlers(stateRoot, { windowId: "stdio-1" });
writeGuardianFailureReceipt(stateRoot, {
  code: "guardian-actuator-failure",
  stage: "synthetic",
  windowId: "stdio-1",
  fields: { proved: false, ownership_preserved: true, survived: false },
});
appendBoundedRestorerLog(
  restorerPaths(stateRoot).diagnosticLog,
  formatRestorerDiagnosticLine("guardian-actuator-failure", { stage: "synthetic", proved: false }),
);
process.exit(2);
`, { mode: 0o755 });
  const windowPath = join(dir, "window.json");
  const store = createFileWindowStore(windowPath);
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    windowId: "stdio-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "stdio-r" });
  await store.write(window);

  const started = startSupervisedRestorerProcess({
    windowPath,
    windowId: window.window_id,
    stateRoot,
    detached: true,
    env: { ...process.env },
  });
  assert.ok(started.pid > 0);
  assert.equal(existsSync(restorerPaths(stateRoot).logsDir), true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process-exit receipt timeout")), 5000);
    const poll = () => {
      if (existsSync(restorerPaths(stateRoot).processExitReceipt)) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
  const exitReceipt = JSON.parse(readFileSync(restorerPaths(stateRoot).processExitReceipt, "utf8"));
  assert.equal(exitReceipt.kind, "process-exit");
  assert.equal(exitReceipt.exit_code, 2);
  assert.match(String(exitReceipt.ownership_note || ""), /guardian-owned/);
  const failure = JSON.parse(readFileSync(restorerPaths(stateRoot).guardianFailureReceipt, "utf8"));
  assert.equal(failure.code, "guardian-actuator-failure");
  assert.equal(failure.ownership_preserved, true);
  const diagnostic = readBoundedRestorerLogTail(restorerPaths(stateRoot).diagnosticLog);
  assert.equal(diagnostic.present, true);
  assert.match(diagnostic.text, /restorer:code=guardian-actuator-failure/);
  assert.equal(typeof installRestorerProcessEvidenceHandlers, "function");
  rmSync(dir, { recursive: true, force: true });
});

test("restorer log allowlist drops secret-like stderr and exception bodies before durable write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-log-allow-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "logs"), { recursive: true, mode: 0o700 });
  const secret = "Authorization: Bearer super-secret-token-value-xyz";
  const tokenLine = "CLOUDFLARE_API_TOKEN=cf_secret_should_never_persist";
  const freeform = "guardian-actuator-failure: synthetic readback mismatch";
  const allowed = formatRestorerDiagnosticLine("guardian-actuator-failure", {
    stage: "synthetic",
    proved: false,
  });
  const noise = "raw stack Trace: Error: boom\n    at Object.<anonymous> (/tmp/x.mjs:1:1)";

  assert.equal(filterRestorerDiagnosticChunk(secret), "");
  assert.equal(filterRestorerDiagnosticChunk(tokenLine), "");
  assert.equal(filterRestorerDiagnosticChunk(noise), "");
  assert.equal(filterRestorerDiagnosticChunk(freeform), "");
  assert.match(filterRestorerDiagnosticChunk(allowed), /restorer:code=guardian-actuator-failure/);

  const logPath = restorerPaths(stateRoot).diagnosticLog;
  appendBoundedRestorerLog(logPath, `${secret}\n${tokenLine}\n${noise}\n${freeform}\n${allowed}`);
  const onDisk = readFileSync(logPath, "utf8");
  assert.equal(onDisk.includes("super-secret-token-value-xyz"), false);
  assert.equal(onDisk.includes("cf_secret_should_never_persist"), false);
  assert.equal(onDisk.includes("Bearer"), false);
  assert.equal(onDisk.includes("raw stack Trace"), false);
  assert.equal(onDisk.includes("synthetic readback mismatch"), false);
  assert.match(onDisk, /restorer:code=guardian-actuator-failure/);

  // Exception path: install handlers and throw a secret-bearing Error; durable
  // surfaces keep only coded name fields.
  const libUrl = pathToFileURL(join(ROOT, "tools/lib/worker_observability_restorer.mjs")).href;
  const child = join(dir, "throw-secret.mjs");
  writeFileSync(child, `#!/usr/bin/env node
import { installRestorerProcessEvidenceHandlers } from ${JSON.stringify(libUrl)};
const stateRoot = ${JSON.stringify(stateRoot)};
installRestorerProcessEvidenceHandlers(stateRoot, { windowId: "log-secret-1" });
console.error(${JSON.stringify(secret)});
console.error(${JSON.stringify(freeform)});
throw new Error("leak " + ${JSON.stringify(tokenLine)});
`, { mode: 0o755 });
  const run = spawnSync(process.execPath, [child], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  const afterThrow = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.equal(afterThrow.includes("super-secret-token-value-xyz"), false);
  assert.equal(afterThrow.includes("cf_secret_should_never_persist"), false);
  assert.equal(afterThrow.includes("Authorization"), false);
  const failure = JSON.parse(readFileSync(restorerPaths(stateRoot).guardianFailureReceipt, "utf8"));
  assert.equal(failure.code, "uncaught-exception");
  assert.equal(failure.error_name, "Error");
  assert.equal(JSON.stringify(failure).includes("cf_secret"), false);
  const exitReceipt = JSON.parse(readFileSync(restorerPaths(stateRoot).processExitReceipt, "utf8"));
  assert.equal(exitReceipt.kind, "process-exit");
  assert.equal(exitReceipt.code, "uncaught-exception");
  assert.equal(String(exitReceipt.error_name || "").includes("cf_secret"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("restore-readback-mismatch writes guardian failure and preserves ownership when actuator unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-actuator-miss-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  clearKillSwitch(stateRoot);
  const armed = privacyArmedObservability(BASELINE);
  const store = createFileWindowStore(join(dir, "window.json"));
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    durationSeconds: 120,
    windowId: "actuator-miss-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "actuator-miss-r" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  window = bindWindowToRestorer(window, {
    pid: process.pid,
    stateRoot,
    restorerId: window.restorer.restorer_id,
  });
  await store.write(window);
  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
  });
  const sticky = {
    async getObservability() { return structuredClone(armed); },
    async patchObservability() { return structuredClone(armed); },
    // no revertObservabilityToBaseline — beta-only transport
  };
  const tick = await restorerTick({
    store,
    transport: sticky,
    stateRoot,
    now: new Date().toISOString(),
  });
  assert.equal(tick.action, "restore-readback-mismatch");
  assert.equal(tick.proved, false);
  assert.equal(tick.receipt.config_revert_available, false);
  assert.equal(tick.receipt.config_revert_invoked, false);
  assert.equal(tick.receipt.actuator_error_code, "config-revert-unavailable");
  assert.equal(tick.receipt.ownership_preserved, true);
  assert.equal(existsSync(restorerPaths(stateRoot).terminalReceipt), false);
  const failure = JSON.parse(readFileSync(restorerPaths(stateRoot).guardianFailureReceipt, "utf8"));
  assert.equal(failure.code, "config-revert-unavailable");
  assert.equal(failure.ownership_preserved, true);
  assert.equal(failure.config_revert_available, false);
  const durable = await store.read();
  assert.equal(durable.owned_sha256, observabilitySha256(armed));
  rmSync(dir, { recursive: true, force: true });
});

test("custom secret-bearing error.name maps to unknown and never persists in any durable file", async () => {
  const secretName = "Bearer_super-secret-token-value-xyz";
  assert.equal(mapRestorerErrorName(secretName), "unknown");
  assert.equal(mapRestorerErrorName("TypeError"), "TypeError");
  assert.equal(mapRestorerErrorName("Error"), "Error");

  const dir = mkdtempSync(join(tmpdir(), "cc05-error-name-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, "logs"), { recursive: true, mode: 0o700 });
  clearKillSwitch(stateRoot);

  writeGuardianFailureReceipt(stateRoot, {
    code: "tick-throw",
    stage: "unit",
    windowId: "error-name-1",
    fields: {
      error_name: secretName,
      proved: false,
      ownership_preserved: true,
      survived: true,
    },
  });
  const guardian = JSON.parse(readFileSync(restorerPaths(stateRoot).guardianFailureReceipt, "utf8"));
  assert.equal(guardian.error_name, "unknown");

  // Tick-failure path: transport throws a custom-named Error.
  const store = createFileWindowStore(join(dir, "window.json"));
  let window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: new Date().toISOString(),
    durationSeconds: 120,
    windowId: "error-name-1",
  });
  window = armRestorer(window, { now: new Date().toISOString(), restorerId: "error-name-r" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: privacyArmedObservability(BASELINE),
    owned_sha256: observabilitySha256(privacyArmedObservability(BASELINE)),
  };
  window = bindWindowToRestorer(window, {
    pid: process.pid,
    stateRoot,
    restorerId: window.restorer.restorer_id,
  });
  await store.write(window);
  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
  });
  let ticks = 0;
  const throwing = {
    async getObservability() {
      const err = new Error("actuator boom");
      err.name = secretName;
      throw err;
    },
    async patchObservability() { return null; },
  };
  await runRestorerLoop({
    store,
    transport: throwing,
    stateRoot,
    pollMs: 10,
    expectedWindowId: window.window_id,
    shouldStop: () => {
      ticks += 1;
      return ticks > 1;
    },
  });
  const tickFailure = JSON.parse(readFileSync(restorerPaths(stateRoot).tickFailureReceipt, "utf8"));
  assert.equal(tickFailure.error_name, "unknown");
  const heartbeat = JSON.parse(readFileSync(restorerPaths(stateRoot).heartbeatReceipt, "utf8"));
  assert.equal(heartbeat.error_name, "unknown");

  // Child uncaughtException with custom name.
  const libUrl = pathToFileURL(join(ROOT, "tools/lib/worker_observability_restorer.mjs")).href;
  const child = join(dir, "throw-named.mjs");
  writeFileSync(child, `#!/usr/bin/env node
import { installRestorerProcessEvidenceHandlers } from ${JSON.stringify(libUrl)};
installRestorerProcessEvidenceHandlers(${JSON.stringify(stateRoot)}, { windowId: "error-name-1" });
const err = new Error("named");
err.name = ${JSON.stringify(secretName)};
throw err;
`, { mode: 0o755 });
  const run = spawnSync(process.execPath, [child], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  const exitReceipt = JSON.parse(readFileSync(restorerPaths(stateRoot).processExitReceipt, "utf8"));
  assert.equal(exitReceipt.error_name, "unknown");

  function assertNoSecretInTree(root) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, ent.name);
      if (ent.isDirectory()) {
        assertNoSecretInTree(full);
        continue;
      }
      const text = readFileSync(full, "utf8");
      assert.equal(text.includes(secretName), false, full);
      assert.equal(text.includes("super-secret-token-value-xyz"), false, full);
      assert.equal(text.includes("Bearer_"), false, full);
    }
  }
  assertNoSecretInTree(stateRoot);
  rmSync(dir, { recursive: true, force: true });
});

test("appendBoundedRestorerLog re-filters existing raw bytes before durable write", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-refilter-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(join(stateRoot, "logs"), { recursive: true, mode: 0o700 });
  const logPath = restorerPaths(stateRoot).diagnosticLog;
  const secret = "Authorization: Bearer legacy-raw-secret-should-scrub";
  writeFileSync(logPath, `${secret}\nraw stack Trace: boom\nCLOUDFLARE_API_TOKEN=cf_legacy\n`, { mode: 0o600 });
  assert.match(readFileSync(logPath, "utf8"), /legacy-raw-secret-should-scrub/);

  const allowed = formatRestorerDiagnosticLine("guardian-actuator-failure", {
    stage: "scrub",
    proved: false,
  });
  const result = appendBoundedRestorerLog(logPath, allowed);
  assert.equal(result.written, true);
  assert.equal(result.scrubbed_existing, true);
  const onDisk = readFileSync(logPath, "utf8");
  assert.equal(onDisk.includes("legacy-raw-secret-should-scrub"), false);
  assert.equal(onDisk.includes("Authorization"), false);
  assert.equal(onDisk.includes("raw stack"), false);
  assert.equal(onDisk.includes("cf_legacy"), false);
  assert.match(onDisk, /restorer:code=guardian-actuator-failure/);
  assert.match(onDisk, /stage=scrub/);
  rmSync(dir, { recursive: true, force: true });
});
