import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
  openSettingsWindow,
  privacyArmedObservability,
  recordMutationIntent,
  SETTINGS_SUCCESS_STATUSES,
  settingsCommandSucceeded,
} from "./lib/worker_observability_settings.mjs";
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
  // // Explicit bound controller-death receipt + memory provider (not SIGKILL).
  // While issued is unknown, baseline GET must not erase after-target or claim
  // terminal restored on the death path; repeated unresolved polls stay bounded.
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
  // Same UNKNOWN-issued obligation on the expired path.
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
  env: { ...process.env, CITYSCROLL_OBSERVABILITY_RESTORER_TRANSPORT_MODULE: transportUrl },
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
