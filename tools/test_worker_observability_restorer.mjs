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
  createFileWindowStore,
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
  announceRestorerReady,
  assertRestorerReady,
  bindWindowToRestorer,
  clearKillSwitch,
  controllerDeathSignaled,
  engageKillSwitch,
  restorerPaths,
  restorerTick,
  runRestorerLoop,
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
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  window = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
    pending_mutation: null,
  };
  await store.write(window);
  assert.equal(controllerDeathSignaled(stateRoot), false);

  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: "2026-10-16T00:05:00.000Z",
  });
  assert.equal(controllerDeathSignaled(stateRoot), true);

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

test("process-kill fixture: restorer survives controller death and restores", async () => {
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

  // Controller process: starts restorer child, then exits (death).
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

  writeRestorerReceipt(restorerPaths(stateRoot).controllerDeathReceipt, {
    schema: "cityscroll.worker_observability_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    restorer_pid: spawned.restorer_pid,
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
