import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROVIDER_OBSERVABILITY_CONCURRENCY,
  acknowledgePrivacyFields,
  armRestorer,
  assertMeasurementWindow,
  assertPrivacyArmed,
  classifyCurrentSettings,
  compareAndSwapObservability,
  createBetaWorkerObservabilityTransport,
  createFileWindowStore,
  markWindowExpiry,
  measurementWindowObservability,
  mutateOwnedWindowObservability,
  normalizeObservability,
  observabilityEquals,
  observabilitySha256,
  openSettingsWindow,
  planSettingsRestore,
  privacyArmedObservability,
  recordMutationIntent,
  restoreSettingsWindow,
  runIndependentRestorer,
} from "./lib/worker_observability_settings.mjs";

const ACCOUNT = "a".repeat(32);
const ACCOUNT_SHA = createHash("sha256").update(ACCOUNT).digest("hex");

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
    propagation_policy: "enforce",
  },
});

function memoryTransport(initial, { patchHook } = {}) {
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
      if (typeof patchHook === "function") {
        await patchHook({ current, observability, calls });
      }
      return structuredClone(current);
    },
    set(next) {
      current = normalizeObservability(next);
    },
    snapshot() {
      return structuredClone(current);
    },
  };
}

function tempStore(initialWindow) {
  const dir = mkdtempSync(join(tmpdir(), "cc05-obs-"));
  const path = join(dir, "window.json");
  const store = createFileWindowStore(path);
  return {
    dir,
    path,
    store,
    async seed(window) {
      await store.write(window);
      return window;
    },
    async read() {
      return store.read();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seededArmedWindow(baseline = BASELINE, extras = {}) {
  const fixture = tempStore();
  let window = openSettingsWindow({
    baseline,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: extras.windowId || "window-1",
    durationSeconds: extras.durationSeconds || 1800,
  });
  window = armRestorer(window, { now: "2026-10-16T00:00:01.000Z", restorerId: "restorer-1" });
  await fixture.seed(window);
  return { fixture, window };
}

test("acknowledgePrivacyFields rejects omitted persist destinations and redact", () => {
  assert.throws(
    () => acknowledgePrivacyFields({
      enabled: false,
      redact_query_string: true,
      logs: { enabled: false },
      traces: { enabled: false },
    }),
    /logs.persist must be present/,
  );
  assert.throws(
    () => acknowledgePrivacyFields({
      enabled: false,
      redact_query_string: true,
      logs: { enabled: false, persist: false, destinations: [] },
      traces: { enabled: false, persist: false },
    }),
    /traces.destinations must be present/,
  );
  assert.throws(
    () => acknowledgePrivacyFields({
      enabled: false,
      logs: { enabled: false, persist: false, destinations: [] },
      traces: { enabled: false, persist: false, destinations: [] },
    }),
    /redact_query_string must be present/,
  );
});

test("acknowledgePrivacyFields rejects wrong types and incomplete privacy values", () => {
  assert.throws(
    () => acknowledgePrivacyFields({
      enabled: false,
      redact_query_string: "true",
      logs: { enabled: false, persist: false, destinations: [] },
      traces: { enabled: false, persist: false, destinations: [] },
    }),
    /redact_query_string must be an explicit boolean/,
  );
  assert.throws(
    () => acknowledgePrivacyFields({
      enabled: false,
      redact_query_string: true,
      logs: { enabled: false, persist: false, destinations: "none" },
      traces: { enabled: false, persist: false, destinations: [] },
    }),
    /logs.destinations must be an explicit array/,
  );
  assert.throws(
    () => assertPrivacyArmed({
      enabled: false,
      redact_query_string: true,
      logs: { enabled: false, persist: true, destinations: [] },
      traces: { enabled: false, persist: false, destinations: [] },
    }),
    /logs.persist must be false/,
  );
});

test("privacy arming keeps flags disabled and preserves propagation_policy", () => {
  const armed = privacyArmedObservability(BASELINE);
  assertPrivacyArmed(armed);
  assert.equal(armed.enabled, false);
  assert.equal(armed.logs.enabled, false);
  assert.equal(armed.traces.enabled, false);
  assert.equal(armed.redact_query_string, true);
  assert.equal(armed.logs.persist, false);
  assert.equal(armed.traces.persist, false);
  assert.deepEqual(armed.logs.destinations, []);
  assert.deepEqual(armed.traces.destinations, []);
  assert.equal(armed.traces.propagation_policy, "enforce");
});

test("measurement window keeps persistence off and traces disabled", () => {
  const armed = privacyArmedObservability(BASELINE);
  const enabled = measurementWindowObservability(armed);
  assertMeasurementWindow(enabled);
  assert.equal(enabled.logs.persist, false);
  assert.equal(enabled.traces.enabled, false);
  assert.equal(enabled.redact_query_string, true);
  assert.equal(enabled.traces.propagation_policy, "enforce");
});

test("openSettingsWindow records concurrency limitation and null ownership", () => {
  const window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    durationSeconds: 1800,
    windowId: "window-open",
  });
  assert.equal(window.phase, "captured");
  assert.equal(window.expires_at, "2026-10-16T00:30:00.000Z");
  assert.equal(window.owned_observability, null);
  assert.equal(window.pending_mutation, null);
  assert.equal(window.concurrency_control.provider_conditional_update, false);
  assert.match(window.concurrency_control.limitation, /no documented conditional update/i);
  assert.deepEqual(window.concurrency_control, PROVIDER_OBSERVABILITY_CONCURRENCY);
});

test("mutation refuses without an armed independent restorer", async () => {
  const fixture = tempStore();
  const transport = memoryTransport(BASELINE);
  const window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "window-no-restorer",
  });
  await fixture.seed(window);
  await assert.rejects(
    () => mutateOwnedWindowObservability({
      transport,
      store: fixture.store,
      expectedSha256: window.baseline_sha256,
      nextObservability: privacyArmedObservability(BASELINE),
      phase: "privacy_armed",
      now: "2026-10-16T00:01:00.000Z",
    }),
    /independent restorer must be armed/,
  );
  fixture.cleanup();
});

test("write-ahead intent is durable before PATCH and apply-then-throw still restores", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, { windowId: "window-apply-throw" });
  let throwOnce = true;
  let patched = false;
  const transport = memoryTransport(BASELINE, {
    patchHook() {
      patched = true;
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transport ack failed after apply");
      }
    },
  });

  const result = await mutateOwnedWindowObservability({
    transport,
    store: fixture.store,
    expectedSha256: window.baseline_sha256,
    nextObservability: privacyArmedObservability(BASELINE),
    phase: "privacy_armed",
    now: "2026-10-16T00:01:00.000Z",
  });

  assert.equal(patched, true);
  assert.equal(result.ok, true);
  assert.equal(result.recovered_from_patch_throw, true);
  assertPrivacyArmed(result.after);
  assert.equal(result.window.phase, "privacy_armed");
  assert.equal(result.window.pending_mutation, null);
  assert.equal(result.window.owned_sha256, observabilitySha256(privacyArmedObservability(BASELINE)));

  // Durable store survived the throw path.
  const durable = await fixture.read();
  assert.equal(durable.phase, "privacy_armed");
  assert.equal(durable.owned_sha256, result.window.owned_sha256);

  const restored = await runIndependentRestorer({
    store: fixture.store,
    transport,
    now: "2026-10-16T00:02:00.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.proved, true);
  assert.ok(observabilityEquals(restored.after, BASELINE));
  fixture.cleanup();
});

test("apply-then-throw with failed GET leaves pending intent that restorer reconciles", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, { windowId: "window-get-fail" });
  let getCount = 0;
  const armed = privacyArmedObservability(BASELINE);
  const transport = {
    calls: [],
    async getObservability() {
      getCount += 1;
      this.calls.push({ method: "GET", n: getCount });
      if (getCount === 1) return structuredClone(BASELINE);
      if (getCount === 2) throw new Error("GET failed after PATCH");
      return structuredClone(this.current);
    },
    current: structuredClone(BASELINE),
    async patchObservability(observability) {
      this.calls.push({ method: "PATCH" });
      this.current = normalizeObservability(observability);
      return structuredClone(this.current);
    },
  };

  const result = await mutateOwnedWindowObservability({
    transport,
    store: fixture.store,
    expectedSha256: window.baseline_sha256,
    nextObservability: armed,
    phase: "privacy_armed",
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "readback-failed");
  assert.equal(result.window.pending_mutation.confirmed, false);
  assert.equal(result.window.owned_observability, null);

  const durable = await fixture.read();
  assert.ok(durable.pending_mutation);
  assert.equal(durable.pending_mutation.after_sha256, observabilitySha256(armed));

  // Later GET sees the applied pending-after state; restorer restores own mutation.
  const restored = await runIndependentRestorer({
    store: fixture.store,
    transport,
    now: "2026-10-16T00:02:00.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.classification.class, "pending-after");
  assert.ok(observabilityEquals(restored.after, BASELINE));
  assert.equal((await fixture.read()).pending_mutation, null);
  fixture.cleanup();
});

test("crash after write-ahead intent before PATCH: restorer finds pending-before and no-ops", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, { windowId: "window-crash-before-patch" });
  const armed = privacyArmedObservability(BASELINE);
  const withIntent = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:01:00.000Z",
  });
  await fixture.store.write(withIntent);

  const transport = memoryTransport(BASELINE);
  const restored = await runIndependentRestorer({
    store: fixture.store,
    transport,
    now: "2026-10-16T00:02:00.000Z",
  });
  assert.equal(restored.action, "already-restored");
  // pending-before digest equals baseline when the mutation never applied.
  assert.ok(["baseline", "pending-before"].includes(restored.classification.class));
  assert.equal(transport.calls.filter((call) => call.method === "PATCH").length, 0);
  assert.ok(withIntent.pending_mutation);
  assert.equal(withIntent.pending_mutation.before_sha256, window.baseline_sha256);
  fixture.cleanup();
});

test("expiry still restores an unacknowledged pending-after mutation", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, {
    windowId: "window-expiry-pending",
    durationSeconds: 60,
  });
  const armed = privacyArmedObservability(BASELINE);
  const withIntent = recordMutationIntent(window, {
    phase: "privacy_armed",
    beforeSha256: window.baseline_sha256,
    intendedObservability: armed,
    now: "2026-10-16T00:00:30.000Z",
  });
  await fixture.store.write(withIntent);

  const transport = memoryTransport(armed);
  const plan = planSettingsRestore(armed, withIntent, { now: "2026-10-16T00:02:00.000Z" });
  assert.equal(plan.action, "restore");
  assert.equal(plan.expired, true);
  assert.equal(plan.classification.class, "pending-after");

  const restored = await runIndependentRestorer({
    store: fixture.store,
    transport,
    now: "2026-10-16T00:02:05.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.expired, true);
  assert.equal(restored.window.phase, "expired-restored");
  assert.ok(observabilityEquals(restored.after, BASELINE));
  fixture.cleanup();
});

test("foreign conflict refuses restore even after expiry", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, {
    windowId: "window-foreign",
    durationSeconds: 60,
  });
  const transport = memoryTransport(BASELINE);
  const armedResult = await mutateOwnedWindowObservability({
    transport,
    store: fixture.store,
    expectedSha256: window.baseline_sha256,
    nextObservability: privacyArmedObservability(BASELINE),
    phase: "privacy_armed",
    now: "2026-10-16T00:00:30.000Z",
  });
  assert.equal(armedResult.ok, true);

  transport.set({
    enabled: true,
    head_sampling_rate: 1,
    redact_query_string: false,
    logs: { enabled: true, persist: true, destinations: ["foreign"] },
    traces: { enabled: true, persist: true, destinations: [] },
  });

  const restored = await runIndependentRestorer({
    store: fixture.store,
    transport,
    now: "2026-10-16T00:02:00.000Z",
  });
  assert.equal(restored.action, "refuse-conflict");
  assert.equal(restored.proved, false);
  assert.equal(transport.snapshot().logs.destinations[0], "foreign");
  fixture.cleanup();
});

test("settings-changed-underneath refuses PATCH (window-owned RMW, not provider CAS)", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, { windowId: "window-toc" });
  const transport = memoryTransport(BASELINE);
  transport.set({ ...BASELINE, redact_query_string: true });
  const result = await mutateOwnedWindowObservability({
    transport,
    store: fixture.store,
    expectedSha256: window.baseline_sha256,
    nextObservability: privacyArmedObservability(BASELINE),
    phase: "privacy_armed",
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "settings-changed-underneath");
  assert.equal(result.concurrency_control.provider_conditional_update, false);
  assert.equal(transport.calls.filter((call) => call.method === "PATCH").length, 0);
  fixture.cleanup();
});

test("createFileWindowStore fsyncs write-ahead intent to disk", async () => {
  const fixture = tempStore();
  const window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "window-fsync",
  });
  const armedWindow = armRestorer(window, { now: "2026-10-16T00:00:01.000Z" });
  const withIntent = recordMutationIntent(armedWindow, {
    phase: "privacy_armed",
    beforeSha256: armedWindow.baseline_sha256,
    intendedObservability: privacyArmedObservability(BASELINE),
    now: "2026-10-16T00:01:00.000Z",
  });
  await fixture.store.write(withIntent);
  const onDisk = JSON.parse(readFileSync(fixture.path, "utf8"));
  assert.equal(onDisk.pending_mutation.after_sha256, withIntent.pending_mutation.after_sha256);
  assert.equal(onDisk.pending_mutation.confirmed, false);
  assert.equal(onDisk.restorer.armed, true);
  fixture.cleanup();
});

test("privacy arm path proves GET before any enable", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, { windowId: "window-privacy" });
  const transport = memoryTransport(BASELINE);
  const result = await mutateOwnedWindowObservability({
    transport,
    store: fixture.store,
    expectedSha256: window.baseline_sha256,
    nextObservability: privacyArmedObservability(BASELINE),
    phase: "privacy_armed",
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(result.ok, true);
  assertPrivacyArmed(result.after);
  assert.equal(result.window.phase, "privacy_armed");
  const proved = assertPrivacyArmed(await transport.getObservability());
  assert.equal(observabilitySha256(proved), result.window.owned_sha256);
  assert.equal(proved.enabled, false);
  fixture.cleanup();
});

test("compareAndSwapObservability alias requires durable store semantics", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, { windowId: "window-alias" });
  const transport = memoryTransport(BASELINE);
  const result = await compareAndSwapObservability(transport, {
    expectedSha256: window.baseline_sha256,
    nextObservability: privacyArmedObservability(BASELINE),
    store: fixture.store,
    phase: "privacy_armed",
    now: "2026-10-16T00:01:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.concurrency_control.mode, "window-owned-read-modify-write");
  fixture.cleanup();
});

test("expiry receipt records and expired owned settings still restore", async () => {
  const { fixture, window } = await seededArmedWindow(BASELINE, {
    windowId: "window-expiry",
    durationSeconds: 60,
  });
  const transport = memoryTransport(BASELINE);
  const armedResult = await mutateOwnedWindowObservability({
    transport,
    store: fixture.store,
    expectedSha256: window.baseline_sha256,
    nextObservability: privacyArmedObservability(BASELINE),
    phase: "privacy_armed",
    now: "2026-10-16T00:00:30.000Z",
  });
  const expiry = markWindowExpiry(armedResult.window, {
    now: "2026-10-16T00:02:00.000Z",
    currentSha256: armedResult.window.owned_sha256,
  });
  assert.equal(expiry.receipt.outcome, "expired");
  await fixture.store.write(expiry.window);
  const restored = await restoreSettingsWindow(expiry.window, transport, {
    now: "2026-10-16T00:02:05.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.expired, true);
  assert.equal(restored.window.phase, "expired-restored");
  fixture.cleanup();
});

test("planSettingsRestore classifies baseline owned pending and conflict", () => {
  const window = openSettingsWindow({
    baseline: BASELINE,
    accountIdSha256: ACCOUNT_SHA,
    now: "2026-10-16T00:00:00.000Z",
    windowId: "window-plan",
  });
  const armed = privacyArmedObservability(BASELINE);
  const ownedWindow = {
    ...window,
    phase: "privacy_armed",
    owned_observability: armed,
    owned_sha256: observabilitySha256(armed),
  };
  assert.equal(classifyCurrentSettings(BASELINE, ownedWindow).class, "baseline");
  assert.equal(classifyCurrentSettings(armed, ownedWindow).class, "owned");
  assert.equal(classifyCurrentSettings({
    ...armed,
    redact_query_string: false,
  }, ownedWindow).class, "conflict");
  assert.equal(planSettingsRestore({
    ...armed,
    logs: { ...armed.logs, destinations: ["x"] },
  }, ownedWindow, { now: "2026-10-16T00:01:00.000Z" }).action, "refuse-conflict");
});

test("beta transport documents endpoint and concurrency limitation", async () => {
  const calls = [];
  const transport = createBetaWorkerObservabilityTransport({
    accountId: ACCOUNT,
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: {
              observability: init.method === "PATCH"
                ? JSON.parse(init.body).observability
                : BASELINE,
            },
          };
        },
      };
    },
  });
  assert.equal(transport.concurrency_control.provider_conditional_update, false);
  const got = await transport.getObservability();
  assert.ok(observabilityEquals(got, BASELINE));
  const patched = await transport.patchObservability(privacyArmedObservability(BASELINE));
  assertPrivacyArmed(patched);
  assert.match(calls[0].url, /\/accounts\/[a]+\/workers\/workers\/cityscroll-worker$/);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "PATCH");
});
