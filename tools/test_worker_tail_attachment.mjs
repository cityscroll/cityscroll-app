import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  VERSION_GUARD_LABEL,
  WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA,
  adaptProviderTailConsumers,
  canonicalizeTailConsumer,
  canonicalizeTailConsumers,
  CAP_A2_REASON,
  CAP_CREDENTIAL_PROVENANCE,
  CAP_SIGNAL_REASON,
  TAIL_SINK_NAME,
  TAIL_SINK_READBACK_SCHEMA,
  bindCapObservationToWindowSnapshot,
  capObservationMatchesLiveWindow,
  createSinkReadbackCapSignal,
  establishCapReadbackIdentityBinding,
  projectCapIdentityBinding,
  projectCapSignalA2,
  projectSinkReadbackCapSignal,
  validateSinkReadbackBody,
  tailConsumersSha256,
  openTailAttachmentWindow,
  armTailAttachmentRestorer,
  createOwnedCapDetachActuator,
  recordTailAttachmentIntent,
  markTailAttachmentIssued,
  confirmTailAttachment,
  classifyTailAttachment,
  planTailAttachmentRestore,
  restoreTailAttachmentWindow,
  emergencyDetachTailAttachment,
  isParseableIsoTimestamp,
  createFileTailAttachmentStore,
  assertTailAttachmentWindowMutable,
} from "./lib/worker_tail_attachment.mjs";

const ACCOUNT_SHA = createHash("sha256").update("a".repeat(32)).digest("hex");
const VERSION_SHA = createHash("sha256").update("deployed-version-fixture").digest("hex");
const READBACK_URL = "https://example.test/readback";

/** Script-settings ConsumerScript identity: {service, environment, namespace}. */
const SANITIZER_A = Object.freeze({
  service: "cityscroll-cc05-r4-tail-sanitizer",
  environment: null,
  namespace: null,
});

/** Authoritative identity binding for cap-signal readiness tests. */
function testIdentityBinding(overrides = {}) {
  const established = establishCapReadbackIdentityBinding({
    window: {
      window_id: "cap-bind-win",
      account_id_sha256: ACCOUNT_SHA,
      version_evidence: {
        present: true,
        sha256: VERSION_SHA,
        consumer: SANITIZER_A,
      },
      owned_consumers: null,
    },
    desiredConsumer: SANITIZER_A,
    readbackUrl: READBACK_URL,
    credentialProvenance: CAP_CREDENTIAL_PROVENANCE.TEST_FIXTURE,
    sinkName: TAIL_SINK_NAME,
    ...overrides,
  });
  assert.equal(established.ok, true, "test identity binding must establish");
  return established.binding;
}

/** Honest AggregateSink unopened / FRESH body shape (mirrors Worker). */
function freshSinkReadbackBody(overrides = {}) {
  return {
    ok: true,
    schema: TAIL_SINK_READBACK_SCHEMA,
    sink_name: TAIL_SINK_NAME,
    closed: false,
    opened: false,
    deadline_ms: 1_800_000,
    max_events: 10_000,
    events_seen: 0,
    apply_overshoot: 0,
    counters: { apply_overshoot: 0 },
    cap_reached: false,
    a2: {
      pass: null,
      reason: "not_evaluated",
      events_seen: 0,
      apply_overshoot: 0,
    },
    note: "no window open",
    ...overrides,
  };
}
const SANITIZER_B = Object.freeze({
  service: "cityscroll-cc05-r4-tail-sanitizer",
  environment: null,
  namespace: "ns-bbb222",
});
const FOREIGN_SAME_COUNT = Object.freeze({
  service: "foreign-tail-consumer",
  environment: null,
  namespace: null,
});
const NAMESPACE_FOREIGN_A = Object.freeze({
  service: "same",
  environment: null,
  namespace: "foreign-A",
});
const NAMESPACE_FOREIGN_B = Object.freeze({
  service: "same",
  environment: null,
  namespace: "foreign-B",
});

/** Real retained R4 script-settings GET shape: service + environment, no revision/namespace. */
const R4_PROVIDER_SHAPE = Object.freeze({
  service: "cityscroll-cc05-r4-tail-sanitizer",
  environment: null,
});

function memoryAttachmentTransport(initial) {
  let current = initial == null ? null : canonicalizeTailConsumers(initial);
  const calls = [];
  return {
    calls,
    get current() { return current == null ? null : structuredClone(current); },
    setCurrent(next) {
      current = next == null ? null : canonicalizeTailConsumers(next);
    },
    async getTailConsumers() {
      calls.push({ method: "GET", consumers: current == null ? null : structuredClone(current) });
      return current == null ? null : structuredClone(current);
    },
    async patchTailConsumers(next) {
      const canonical = canonicalizeTailConsumers(next);
      calls.push({ method: "PATCH", consumers: structuredClone(canonical) });
      current = structuredClone(canonical);
      return structuredClone(current);
    },
  };
}

function fixtureCapDetachActuator(transport = null) {
  return createOwnedCapDetachActuator({
    transport: transport || {
      async getTailConsumers() { return []; },
      async patchTailConsumers() {
        throw new Error("fixture idle cap-detach must not PATCH");
      },
    },
    readCapSignal: async () => ({
      cap_reached: false,
      readback_ok: false,
      reason: "fixture_idle",
      events_seen: null,
      apply_overshoot: null,
    }),
  });
}

function openArmedWindow({
  windowId = "tail-win",
  baselineConsumers = [],
  now = "2026-10-17T11:00:00.000Z",
  restorerId = "tr-1",
  capDetachActuator = null,
} = {}) {
  let window = openTailAttachmentWindow({
    baselineConsumers,
    accountIdSha256: ACCOUNT_SHA,
    workerId: "cityscroll-cc05-r4-cpu-producer",
    now,
    windowId,
  });
  window = armTailAttachmentRestorer(window, {
    now: "2026-10-17T11:00:01.000Z",
    restorerId,
    capDetachActuator: capDetachActuator || fixtureCapDetachActuator(),
  });
  return window;
}

function attachConfirmed(window, consumers, {
  intentAt = "2026-10-17T11:00:02.000Z",
  issuedAt = "2026-10-17T11:00:03.000Z",
  confirmAt = "2026-10-17T11:00:04.000Z",
} = {}) {
  window = recordTailAttachmentIntent(window, {
    phase: "attach",
    beforeSha256: window.baseline_sha256,
    intendedConsumers: consumers,
    now: intentAt,
  });
  window = markTailAttachmentIssued(window, { now: issuedAt });
  window = confirmTailAttachment(window, {
    observedConsumers: consumers,
    now: confirmAt,
  });
  return window;
}

test("canonicalize binds exact service/environment/namespace identity, not list length", () => {
  const a = canonicalizeTailConsumers([
    { service: "b-service", environment: "production", namespace: "ns-2", extra: "drop-me" },
    { service: "a-service", script: "ignored-when-service-present", environment: null, namespace: "ns-1" },
  ]);
  assert.deepEqual(a, [
    { service: "a-service", environment: null, namespace: "ns-1" },
    { service: "b-service", environment: "production", namespace: "ns-2" },
  ]);
  const oneA = canonicalizeTailConsumers([SANITIZER_A]);
  const oneB = canonicalizeTailConsumers([SANITIZER_B]);
  assert.equal(oneA.length, oneB.length);
  assert.notEqual(tailConsumersSha256(oneA), tailConsumersSha256(oneB));
  assert.equal(
    canonicalizeTailConsumer({ script: "legacy-script-only" }).service,
    "legacy-script-only",
  );
  // Real R4 GET has no revision/namespace — bind namespace null, do not invent fields.
  assert.deepEqual(canonicalizeTailConsumer(R4_PROVIDER_SHAPE), {
    service: "cityscroll-cc05-r4-tail-sanitizer",
    environment: null,
    namespace: null,
  });
});

test("openTailAttachmentWindow records baseline identity digest for empty detach baseline", () => {
  const window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: "cityscroll-cc05-r4-cpu-producer",
    now: "2026-10-17T11:00:00.000Z",
    windowId: "tail-win-1",
  });
  assert.equal(window.schema, WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA);
  assert.equal(window.baseline_sha256, tailConsumersSha256([]));
  assert.deepEqual(window.baseline_consumers, []);
  assert.equal(window.owned_sha256, null);
  assert.equal(window.pending_mutation, null);
});

test("classify: same-count foreign replacement is conflict, not owned", async () => {
  let window = openArmedWindow({ windowId: "tail-win-2" });
  window = attachConfirmed(window, [SANITIZER_A]);
  assert.equal(window.owned_sha256, tailConsumersSha256([SANITIZER_A]));

  const owned = classifyTailAttachment([SANITIZER_A], window);
  assert.equal(owned.class, "owned");

  const foreign = classifyTailAttachment([FOREIGN_SAME_COUNT], window);
  assert.equal(foreign.class, "conflict");
  assert.equal(foreign.consumers.length, 1);
  assert.equal(foreign.consumers[0].service, "foreign-tail-consumer");
  assert.notEqual(foreign.sha256, window.owned_sha256);
});

test("issued-but-unacknowledged stays UNKNOWN/owned: baseline GET is not already-restored", () => {
  let window = openArmedWindow({ windowId: "tail-win-3", restorerId: "tr-2" });
  window = recordTailAttachmentIntent(window, {
    phase: "attach",
    beforeSha256: window.baseline_sha256,
    intendedConsumers: [SANITIZER_A],
    now: "2026-10-17T11:00:02.000Z",
  });
  window = markTailAttachmentIssued(window, { now: "2026-10-17T11:00:03.000Z" });
  assert.equal(window.pending_mutation.issued, true);
  assert.equal(window.pending_mutation.confirmed, false);

  const plan = planTailAttachmentRestore([], window, { now: "2026-10-17T11:00:04.000Z" });
  assert.notEqual(plan.action, "already-restored");
  assert.ok(["await-ack", "retain-owned-unknown"].includes(plan.action), plan.action);
  assert.equal(plan.proved, false);
  assert.equal(plan.ownership_unknown, true);
  assert.equal(plan.ownership_preserved, true);
});

test("planTailAttachmentRestore refuses same-count foreign and preserves it", async () => {
  let window = openArmedWindow({ windowId: "tail-win-4", restorerId: "tr-3" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };

  const transport = memoryAttachmentTransport([FOREIGN_SAME_COUNT]);
  const result = await restoreTailAttachmentWindow(window, transport, {
    now: "2026-10-17T11:00:05.000Z",
  });
  assert.equal(result.action, "refuse-conflict");
  assert.equal(result.proved, false);
  assert.equal(result.ownership_preserved, true);
  assert.deepEqual(result.after, canonicalizeTailConsumers([FOREIGN_SAME_COUNT]));
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(result.window.owned_sha256, window.owned_sha256);
});

test("restoreTailAttachmentWindow detaches to exact baseline identity when owned", async () => {
  let window = openArmedWindow({ windowId: "tail-win-5", restorerId: "tr-4" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const transport = memoryAttachmentTransport([SANITIZER_A]);
  const result = await restoreTailAttachmentWindow(window, transport, {
    now: "2026-10-17T11:00:06.000Z",
  });
  assert.equal(result.action, "restored");
  assert.equal(result.proved, true);
  assert.deepEqual(result.after, []);
  assert.equal(result.window.owned_sha256, null);
  assert.equal(result.window.phase, "restored");
  const patches = transport.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].consumers, []);
});

test("length-only equality is insufficient: metadata helper must not treat foreign same-count as equal", () => {
  const ownedDigest = tailConsumersSha256([SANITIZER_A]);
  const foreignDigest = tailConsumersSha256([FOREIGN_SAME_COUNT]);
  assert.equal(canonicalizeTailConsumers([SANITIZER_A]).length, 1);
  assert.equal(canonicalizeTailConsumers([FOREIGN_SAME_COUNT]).length, 1);
  assert.notEqual(ownedDigest, foreignDigest);
});

test("file window store round-trips a tail attachment window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-store-"));
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openArmedWindow({ windowId: "tail-win-store", restorerId: "tr-store" });
  const stamped = await store.write(window);
  assert.equal(stamped.window_generation, 1);
  const loaded = await store.read();
  assert.equal(loaded.schema, WORKER_TAIL_ATTACHMENT_WINDOW_SCHEMA);
  assert.equal(loaded.window_id, "tail-win-store");
  assert.equal(loaded.restorer.armed, true);
  assert.equal(loaded.window_generation, 1);
  rmSync(dir, { recursive: true, force: true });
});

// --- Negative tests for the six local counterexamples ---

test("negative 1: withLock is exclusive — concurrent callers never both enter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-lock-"));
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let inside = 0;
  let maxInside = 0;
  const hold = async () => {
    await store.withLock(async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inside -= 1;
    });
  };
  await Promise.all([hold(), hold(), hold()]);
  assert.equal(maxInside, 1, `exclusive lock must serialize; saw max concurrency ${maxInside}`);

  // Live holder is not stolen: a second short-timeout waiter fails while first holds.
  let firstEntered = false;
  const first = store.withLock(async () => {
    firstEntered = true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(firstEntered, true);
  await assert.rejects(
    () => store.withLock(async () => {}, { timeoutMs: 80 }),
    /timed out waiting for window lock/,
  );
  await first;
  rmSync(dir, { recursive: true, force: true });
});

test("negative 1b: exclusive lock refuses recursive mkdir — live foreign holder is not removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-lock-live-"));
  const storePath = join(dir, "tail-window.json");
  const store = createFileTailAttachmentStore(storePath);
  // Simulate a live foreign holder: lock dir + recent holder.json with this pid.
  mkdirSync(store.lockDir);
  writeFileSync(`${store.lockDir}/holder.json`, `${JSON.stringify({
    holder: "foreign-reviewer",
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => store.withLock(async () => "should-not-run", { timeoutMs: 100 }),
    /timed out waiting for window lock/,
  );
  // Lock dir must still exist — waiter must not delete a live holder's lock.
  assert.equal(existsSync(store.lockDir), true);
  rmSync(dir, { recursive: true, force: true });
});

test("negative 2: write CAS checks on-disk window, not only the incoming expectedWindowId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-cas-"));
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  const windowB = openArmedWindow({ windowId: "NEW-B", restorerId: "tr-b" });
  await store.write(windowB);
  const onDisk = await store.read();
  assert.equal(onDisk.window_id, "NEW-B");

  const staleA = openArmedWindow({ windowId: "STALE-A", restorerId: "tr-a" });
  await assert.rejects(
    () => store.write(staleA, { expectedWindowId: "STALE-A" }),
    /stale window identity rejected: on-disk NEW-B != expected STALE-A/,
  );
  const stillB = await store.read();
  assert.equal(stillB.window_id, "NEW-B");
  assert.equal(stillB.restorer.restorer_id, "tr-b");

  // Same-window stale generation must also refuse.
  const advanced = await store.write(
    { ...stillB, phase: "attached", owned_sha256: "a".repeat(64) },
    { expectedWindowId: "NEW-B", expectedGeneration: stillB.window_generation },
  );
  assert.equal(advanced.window_generation, stillB.window_generation + 1);
  await assert.rejects(
    () => store.write(
      { ...stillB, phase: "captured" },
      { expectedWindowId: "NEW-B", expectedGeneration: stillB.window_generation },
    ),
    /stale window generation rejected/,
  );
  const final = await store.read();
  assert.equal(final.phase, "attached");
  assert.equal(final.window_generation, advanced.window_generation);
  rmSync(dir, { recursive: true, force: true });
});

test("negative 3: terminal restored window refuses arm and intent before any mutation", async () => {
  let window = openArmedWindow({ windowId: "tail-win-terminal", restorerId: "tr-term" });
  window = {
    ...window,
    phase: "restored",
    owned_consumers: null,
    owned_sha256: null,
    pending_mutation: null,
  };
  assert.throws(
    () => armTailAttachmentRestorer(window, {
      now: "2026-10-17T11:01:00.000Z",
      restorerId: "tr-rearm",
      capDetachActuator: fixtureCapDetachActuator(),
    }),
    /window phase restored is closed/,
  );
  assert.throws(
    () => recordTailAttachmentIntent(window, {
      phase: "attach",
      beforeSha256: window.baseline_sha256,
      intendedConsumers: [SANITIZER_A],
      now: "2026-10-17T11:01:01.000Z",
    }),
    /window phase restored is closed/,
  );
  assert.throws(
    () => markTailAttachmentIssued(window, { now: "2026-10-17T11:01:02.000Z" }),
    /window phase restored is closed/,
  );
  assert.throws(
    () => confirmTailAttachment(window, {
      observedConsumers: [SANITIZER_A],
      now: "2026-10-17T11:01:03.000Z",
    }),
    /window phase restored is closed/,
  );
});

test("negative 4: revision is not a script-settings identity field — refuse invented fixture revisions", () => {
  assert.throws(
    () => canonicalizeTailConsumer({ service: "svc", environment: null, revision: { id: "A" } }),
    /revision is not a script-settings identity field/,
  );
  assert.throws(
    () => canonicalizeTailConsumer({ service: "svc", environment: null, revision: { id: "B" } }),
    /revision is not a script-settings identity field/,
  );
  assert.throws(
    () => canonicalizeTailConsumers([
      { service: "svc", revision: { id: "A" } },
    ]),
    /revision is not a script-settings identity field/,
  );
  assert.throws(
    () => canonicalizeTailConsumer({ service: "svc", revision: "rev-invented" }),
    /revision is not a script-settings identity field/,
  );
  assert.throws(
    () => canonicalizeTailConsumer({ service: "svc", version: "v1" }),
    /revision is not a script-settings identity field/,
  );
});

test("negative 5: confirm refuses unissued planned intent — planned ≠ issued ≠ confirmed", () => {
  let window = openArmedWindow({ windowId: "tail-win-confirm", restorerId: "tr-confirm" });
  window = recordTailAttachmentIntent(window, {
    phase: "attach",
    beforeSha256: window.baseline_sha256,
    intendedConsumers: [SANITIZER_A],
    now: "2026-10-17T11:00:02.000Z",
  });
  assert.equal(window.pending_mutation.issued, false);
  assert.throws(
    () => confirmTailAttachment(window, {
      observedConsumers: [SANITIZER_A],
      now: "2026-10-17T11:00:03.000Z",
    }),
    /cannot confirm an unissued planned attachment/,
  );
  // Happy path still works once issued.
  window = markTailAttachmentIssued(window, { now: "2026-10-17T11:00:03.000Z" });
  window = confirmTailAttachment(window, {
    observedConsumers: [SANITIZER_A],
    now: "2026-10-17T11:00:04.000Z",
  });
  assert.equal(window.phase, "attached");
  assert.equal(window.pending_mutation, null);
});

test("negative 6: missing provider list is not declared empty — plan does not already-restore", () => {
  let window = openArmedWindow({ windowId: "tail-win-missing", restorerId: "tr-missing" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };

  assert.throws(
    () => canonicalizeTailConsumers(null),
    /tail_consumers list is missing/,
  );
  assert.throws(
    () => canonicalizeTailConsumers(undefined),
    /tail_consumers list is missing/,
  );
  assert.throws(
    () => openTailAttachmentWindow({
      baselineConsumers: null,
      accountIdSha256: ACCOUNT_SHA,
      now: "2026-10-17T11:00:00.000Z",
      windowId: "tail-win-null-baseline",
    }),
    /baselineConsumers is missing/,
  );

  const missing = adaptProviderTailConsumers(null);
  assert.equal(missing.present, false);
  assert.equal(missing.reason, "missing");
  const malformed = adaptProviderTailConsumers({ not: "an-array" });
  assert.equal(malformed.present, false);
  assert.equal(malformed.reason, "malformed");
  const declaredEmpty = adaptProviderTailConsumers([]);
  assert.equal(declaredEmpty.present, true);
  assert.deepEqual(declaredEmpty.consumers, []);

  const planNull = planTailAttachmentRestore(null, window, { now: "2026-10-17T11:00:10.000Z" });
  assert.equal(planNull.action, "retain-owned-unknown");
  assert.equal(planNull.proved, false);
  assert.equal(planNull.ownership_preserved, true);
  assert.equal(planNull.ownership_unknown, true);
  assert.notEqual(planNull.action, "already-restored");

  const planUndef = planTailAttachmentRestore(undefined, window, { now: "2026-10-17T11:00:11.000Z" });
  assert.equal(planUndef.action, "retain-owned-unknown");
  assert.equal(planUndef.proved, false);

  // Declared empty list against empty baseline still proves already-restored.
  const emptyBaseline = openArmedWindow({ windowId: "tail-win-empty-ok", restorerId: "tr-empty" });
  const planEmpty = planTailAttachmentRestore([], emptyBaseline, { now: "2026-10-17T11:00:12.000Z" });
  assert.equal(planEmpty.action, "already-restored");
  assert.equal(planEmpty.proved, true);
});

test("negative 6b: restore transport missing GET retains ownership and does not release", async () => {
  let window = openArmedWindow({ windowId: "tail-win-get-fail", restorerId: "tr-get-fail" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const transport = memoryAttachmentTransport(null);
  const result = await restoreTailAttachmentWindow(window, transport, {
    now: "2026-10-17T11:00:13.000Z",
  });
  assert.equal(result.action, "retain-owned-unknown");
  assert.equal(result.proved, false);
  assert.equal(result.ownership_preserved, true);
  assert.equal(result.ownership_unknown, true);
  assert.equal(result.window.owned_sha256, window.owned_sha256);
  assert.equal(result.window.phase, "attached");
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("negative 7: expired window refuses arm and attach; restore and detach stay allowed", async () => {
  // Root variant: created 11:00:00Z with 1s duration; arm at 11:01:00Z must refuse.
  const window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: "cityscroll-cc05-r4-cpu-producer",
    now: "2026-10-17T11:00:00.000Z",
    durationSeconds: 1,
    windowId: "tail-win-expired-arm",
  });
  assert.equal(window.expires_at, "2026-10-17T11:00:01.000Z");
  assert.throws(
    () => assertTailAttachmentWindowMutable(window, "2026-10-17T11:01:00.000Z"),
    /tail attachment window has expired/,
  );
  assert.throws(
    () => armTailAttachmentRestorer(window, {
      now: "2026-10-17T11:01:00.000Z",
      restorerId: "tr-expired",
      capDetachActuator: fixtureCapDetachActuator(),
    }),
    /tail attachment window has expired/,
  );

  // Arm while still live, then refuse attach after expiry.
  let live = openArmedWindow({
    windowId: "tail-win-expired-attach",
    restorerId: "tr-live-then-expire",
  });
  // Force a short expiry while keeping restorer armed.
  live = {
    ...live,
    created_at: "2026-10-17T11:00:00.000Z",
    expires_at: "2026-10-17T11:00:01.000Z",
    duration_seconds: 1,
  };
  assert.throws(
    () => recordTailAttachmentIntent(live, {
      phase: "attach",
      beforeSha256: live.baseline_sha256,
      intendedConsumers: [SANITIZER_A],
      now: "2026-10-17T11:01:00.000Z",
    }),
    /tail attachment window has expired/,
  );

  // Detach intent on an expired owned window remains allowed.
  let ownedExpired = {
    ...live,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  ownedExpired = recordTailAttachmentIntent(ownedExpired, {
    phase: "detach",
    beforeSha256: ownedExpired.owned_sha256,
    intendedConsumers: [],
    now: "2026-10-17T11:01:00.000Z",
  });
  assert.equal(ownedExpired.phase, "intent-detach");
  assert.equal(ownedExpired.pending_mutation.phase, "detach");

  // Restoration after expiry still plans/proves.
  const restoreWindow = {
    ...live,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const transport = memoryAttachmentTransport([SANITIZER_A]);
  const restored = await restoreTailAttachmentWindow(restoreWindow, transport, {
    now: "2026-10-17T11:01:00.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.proved, true);
  assert.equal(restored.expired, true);
  assert.equal(restored.window.phase, "expired-restored");
});

test("negative 9: distinct namespaces must not collapse into the same consumer identity digest", () => {
  // Root counterexample on module 65e: namespace foreign-A / foreign-B both dropped,
  // yielding identical {service, environment, revision:null} digests.
  const a = canonicalizeTailConsumers([NAMESPACE_FOREIGN_A]);
  const b = canonicalizeTailConsumers([NAMESPACE_FOREIGN_B]);
  assert.equal(a.length, b.length);
  assert.deepEqual(a[0], {
    service: "same",
    environment: null,
    namespace: "foreign-A",
  });
  assert.deepEqual(b[0], {
    service: "same",
    environment: null,
    namespace: "foreign-B",
  });
  assert.notEqual(tailConsumersSha256(a), tailConsumersSha256(b));

  let window = openArmedWindow({ windowId: "tail-win-ns", restorerId: "tr-ns" });
  // Own namespace-A, then observe same-count foreign namespace-B → conflict.
  window = {
    ...window,
    phase: "attached",
    owned_consumers: a,
    owned_sha256: tailConsumersSha256(a),
    pending_mutation: null,
  };
  const owned = classifyTailAttachment(a, window);
  assert.equal(owned.class, "owned");
  const foreignNs = classifyTailAttachment(b, window);
  assert.equal(foreignNs.class, "conflict");
  assert.notEqual(foreignNs.sha256, window.owned_sha256);

  // Malformed namespace is refused (no silent String()/drop).
  assert.throws(
    () => canonicalizeTailConsumer({ service: "same", environment: null, namespace: { id: "x" } }),
    /namespace must be a string or null/,
  );
});

test("negative 8: adapter present:true without an actual consumers array stays UNKNOWN", () => {
  let window = openArmedWindow({ windowId: "tail-win-adapter-present", restorerId: "tr-adapter" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };

  for (const raw of [
    { present: true },
    { present: true, consumers: null },
    { present: true, consumers: undefined },
    { consumers: undefined },
  ]) {
    const adapted = adaptProviderTailConsumers(raw);
    assert.equal(adapted.present, false, `expected unproved for ${JSON.stringify(raw)}`);
    assert.equal(adapted.consumers, null);
    const plan = planTailAttachmentRestore(raw, window, { now: "2026-10-17T11:00:20.000Z" });
    assert.equal(plan.action, "retain-owned-unknown", `plan for ${JSON.stringify(raw)}`);
    assert.equal(plan.proved, false);
    assert.equal(plan.ownership_preserved, true);
    assert.equal(plan.ownership_unknown, true);
    assert.notEqual(plan.action, "already-restored");
  }

  // Declared empty array with present:true remains a valid empty proof path.
  const declared = adaptProviderTailConsumers({ present: true, consumers: [] });
  assert.equal(declared.present, true);
  assert.deepEqual(declared.consumers, []);
  const emptyBaseline = openArmedWindow({ windowId: "tail-win-adapter-empty-ok", restorerId: "tr-empty-ok" });
  const planEmpty = planTailAttachmentRestore(
    { present: true, consumers: [] },
    emptyBaseline,
    { now: "2026-10-17T11:00:21.000Z" },
  );
  assert.equal(planEmpty.action, "already-restored");
  assert.equal(planEmpty.proved, true);
});

test("isParseableIsoTimestamp accepts strict UTC ISO and rejects malformed suffixes", () => {
  assert.equal(isParseableIsoTimestamp("2026-10-17T14:11:05.000Z"), true);
  assert.equal(isParseableIsoTimestamp("2026-10-17T14:11:05Z"), true);
  assert.equal(isParseableIsoTimestamp("2026-10-17T14:11:05.3NZ"), false);
  assert.equal(isParseableIsoTimestamp("2026-10-17T14:11:05+00:00"), false);
  assert.equal(isParseableIsoTimestamp("not-a-timestamp"), false);
  assert.throws(
    () => openTailAttachmentWindow({
      baselineConsumers: [],
      accountIdSha256: ACCOUNT_SHA,
      workerId: "cityscroll-cc05-r4-cpu-producer",
      now: "2026-10-17T14:11:05.3NZ",
      windowId: "bad-iso",
    }),
    /now must be an ISO timestamp/,
  );
});

test("emergencyDetachTailAttachment refuses foreign same-count with 0 PATCH", async () => {
  let window = openArmedWindow({ windowId: "emerg-foreign", restorerId: "tr-emerg-foreign" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const transport = memoryAttachmentTransport([FOREIGN_SAME_COUNT]);
  const result = await emergencyDetachTailAttachment(window, transport, {
    now: "2026-10-17T11:00:30.000Z",
  });
  assert.equal(result.action, "refuse-conflict");
  assert.equal(result.proved, false);
  assert.equal(result.patch, null);
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.deepEqual(result.after, canonicalizeTailConsumers([FOREIGN_SAME_COUNT]));
});

test("emergencyDetachTailAttachment retains UNKNOWN when GET is null", async () => {
  let window = openArmedWindow({ windowId: "emerg-unknown", restorerId: "tr-emerg-unknown" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const transport = memoryAttachmentTransport(null);
  const result = await emergencyDetachTailAttachment(window, transport, {
    now: "2026-10-17T11:00:31.000Z",
  });
  assert.equal(result.action, "retain-owned-unknown");
  assert.equal(result.proved, false);
  assert.equal(result.patch, null);
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("emergencyDetachTailAttachment restores owned attach to baseline [] with 1 PATCH", async () => {
  let window = openArmedWindow({ windowId: "emerg-restore", restorerId: "tr-emerg-restore" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const transport = memoryAttachmentTransport([SANITIZER_A]);
  const result = await emergencyDetachTailAttachment(window, transport, {
    now: "2026-10-17T11:00:32.000Z",
  });
  assert.equal(result.action, "restored");
  assert.equal(result.proved, true);
  assert.deepEqual(result.after, []);
  const patches = transport.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].consumers, []);
  assert.equal(result.window.phase, "restored");
  assert.equal(result.window.owned_sha256, null);
});

test("emergencyDetachTailAttachment store generation mismatch → 0 PATCH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-emerg-gen-"));
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openArmedWindow({ windowId: "emerg-gen", restorerId: "tr-emerg-gen" });
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER_A]),
    owned_sha256: tailConsumersSha256([SANITIZER_A]),
    pending_mutation: null,
  };
  const stamped = await store.write(window);
  assert.equal(stamped.window_generation, 1);
  // Advance generation under the caller's feet.
  const advanced = await store.write(
    { ...stamped, phase: "attached" },
    { expectedWindowId: "emerg-gen", expectedGeneration: stamped.window_generation },
  );
  assert.equal(advanced.window_generation, 2);

  const transport = memoryAttachmentTransport([SANITIZER_A]);
  const result = await emergencyDetachTailAttachment(stamped, transport, {
    now: "2026-10-17T11:00:33.000Z",
    store,
    expectedGeneration: stamped.window_generation,
  });
  assert.equal(result.action, "refuse-stale");
  assert.equal(result.proved, false);
  assert.equal(result.reason, "window_generation mismatch");
  assert.equal(result.patch, null);
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("armTailAttachmentRestorer refuses without owned cap-detach actuator", () => {
  const window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: "cityscroll-cc05-r4-cpu-producer",
    now: "2026-10-17T11:00:00.000Z",
    windowId: "arm-refuse",
  });
  assert.throws(
    () => armTailAttachmentRestorer(window, {
      now: "2026-10-17T11:00:01.000Z",
      restorerId: "tr-no-actuator",
    }),
    /refuse to arm: owned cap-detach actuator required/,
  );
});

test("owned cap-detach actuator polls signal and runs generation-checked emergency detach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-cap-detach-"));
  const store = createFileTailAttachmentStore(join(dir, "window.json"));
  let signal = {
    cap_reached: false,
    readback_ok: true,
    events_seen: 0,
    apply_overshoot: 0,
    a2: { pass: true },
  };
  const transport = memoryAttachmentTransport([SANITIZER_A]);
  const actuator = createOwnedCapDetachActuator({
    transport,
    readCapSignal: async () => structuredClone(signal),
  });

  let window = openArmedWindow({
    windowId: "cap-detach-win",
    restorerId: "tr-cap",
    capDetachActuator: actuator,
  });
  window = attachConfirmed(window, [SANITIZER_A]);
  window = await store.write(window);
  assert.equal(window.restorer.cap_detach_actuator_bound, true);

  const idle = await actuator.pollAndDetachIfCapped({
    store,
    now: "2026-10-17T11:00:10.000Z",
  });
  assert.equal(idle.actuated, false);
  assert.equal(idle.reason, "cap_not_reached");
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);

  signal = {
    cap_reached: true,
    readback_ok: true,
    events_seen: 10_000,
    apply_overshoot: 0,
    a2: { pass: true, reason: "within_all_seen_cap" },
  };
  const fired = await actuator.pollAndDetachIfCapped({
    store,
    now: "2026-10-17T11:00:20.000Z",
  });
  assert.equal(fired.actuated, true);
  assert.equal(fired.proved, true);
  assert.ok(["restore", "restored", "already-restored"].includes(fired.action), fired.action);
  assert.ok(transport.calls.filter((c) => c.method === "PATCH").length >= 1);
  const after = await store.read();
  assert.ok(["restored", "expired-restored"].includes(after.phase), after.phase);
  assert.deepEqual(after.baseline_consumers, []);
  rmSync(dir, { recursive: true, force: true });
});

test("createSinkReadbackCapSignal: rejected fetch becomes UNKNOWN and never throws", async () => {
  const readCapSignal = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async (_url, init) => {
      assert.ok(init?.signal, "AbortSignal must be supplied to fetch");
      throw new Error("network down");
    },
  });
  const signal = await readCapSignal({ timeoutMs: 50 });
  assert.equal(signal.cap_reached, false);
  assert.equal(signal.readback_ok, false);
  assert.equal(signal.reason, "readback_error");
  assert.equal(signal.a2.pass, false);
  assert.equal("body" in signal, false);
});

test("createSinkReadbackCapSignal: stalled fetch aborts within bound (AbortSignal)", async () => {
  let sawAbortSignal = false;
  const readCapSignal = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async (_url, init) => {
      sawAbortSignal = Boolean(init?.signal);
      assert.equal(init.signal.aborted, false);
      await new Promise(() => {
        // never resolves; AbortSignal must win
      });
      return { ok: true, json: async () => ({ cap_reached: true }) };
    },
  });
  const started = Date.now();
  const signal = await readCapSignal({ timeoutMs: 30 });
  const elapsed = Date.now() - started;
  assert.equal(sawAbortSignal, true);
  assert.equal(signal.cap_reached, false);
  assert.equal(signal.readback_ok, false);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, "readback_timeout");
  assert.ok(elapsed < 2_000, `stalled poll must bound, elapsed=${elapsed}`);
});

test("createSinkReadbackCapSignal: unauthorized / malformed stay UNKNOWN", async () => {
  const unauthorized = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  const u = await unauthorized({ timeoutMs: 50 });
  assert.equal(u.readback_ok, false);
  assert.equal(u.reason, "readback_unauthorized");

  const malformed = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }),
  });
  const m = await malformed({ timeoutMs: 50 });
  assert.equal(m.readback_ok, false);
  assert.equal(m.reason, "readback_malformed");
});


test("createSinkReadbackCapSignal: empty {} / incomplete schema is UNKNOWN (refuses READY)", async () => {
  const empty = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }),
  });
  const e = await empty({ timeoutMs: 50 });
  assert.equal(e.readback_ok, false);
  assert.equal(e.reason, CAP_SIGNAL_REASON.READBACK_SCHEMA_INVALID);
  assert.equal("body" in e, false);

  const noA2 = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        schema: TAIL_SINK_READBACK_SCHEMA,
        sink_name: TAIL_SINK_NAME,
        cap_reached: false,
        events_seen: 0,
        apply_overshoot: 0,
        deadline_ms: 1800_000,
        max_events: 10_000,
      }),
    }),
  });
  const n = await noA2({ timeoutMs: 50 });
  assert.equal(n.readback_ok, false);
  assert.equal(n.reason, CAP_SIGNAL_REASON.READBACK_SCHEMA_INVALID);
});

test("createSinkReadbackCapSignal: valid unopened schema with events_seen 0 is READY-ok", async () => {
  const readCapSignal = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => freshSinkReadbackBody(),
    }),
  });
  const signal = await readCapSignal({ timeoutMs: 50 });
  assert.equal(signal.readback_ok, true);
  assert.equal(signal.cap_reached, false);
  assert.equal(signal.events_seen, 0);
  assert.equal(signal.opened, false);
  assert.equal(signal.a2.pass, null);
  assert.equal(signal.a2.reason, CAP_A2_REASON.NOT_EVALUATED);
  assert.equal("body" in signal, false);
  assert.equal(signal.identity_binding.window_id, "cap-bind-win");
  assert.equal(signal.identity_binding.desired_consumer_service, SANITIZER_A.service);
  assert.equal(signal.identity_binding.credential_provenance, CAP_CREDENTIAL_PROVENANCE.TEST_FIXTURE);
  // URL hash + sink_name are configured-readback provenance metadata only.
  assert.equal(signal.identity_binding.readback_target_provenance, "configured-url-hash");
  assert.equal(signal.identity_binding.sink_name_provenance, "configured-sink-name");
  assert.equal(typeof signal.identity_binding.readback_target_sha256, "string");
  assert.equal(signal.identity_binding.sink_name, TAIL_SINK_NAME);
});

test("createSinkReadbackCapSignal: missing identity binding refuses READY", async () => {
  const readCapSignal = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    // deliberately omit window / version / consumer binding
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => freshSinkReadbackBody(),
    }),
  });
  const signal = await readCapSignal({ timeoutMs: 50 });
  assert.equal(signal.readback_ok, false);
  assert.equal(signal.reason, CAP_SIGNAL_REASON.IDENTITY_BINDING_UNKNOWN);
});

test("createSinkReadbackCapSignal: deadline_ms/max_events alone are not identity", () => {
  const limitsOnly = establishCapReadbackIdentityBinding({
    window: { window_id: "w", account_id_sha256: ACCOUNT_SHA },
    // no consumer, no version evidence
    readbackUrl: READBACK_URL,
    credentialProvenance: CAP_CREDENTIAL_PROVENANCE.TEST_FIXTURE,
  });
  assert.equal(limitsOnly.ok, false);
  assert.equal(limitsOnly.reason, CAP_SIGNAL_REASON.IDENTITY_BINDING_UNKNOWN);
});

test("projectCapSignalA2 maps unknown reasons and drops raw fields", () => {
  const projected = projectCapSignalA2({
    pass: true,
    reason: "https://secret.example/token=abc leaked",
    events_seen: 0,
    apply_overshoot: 0,
    hostile: "drop-me",
    body: { raw: true },
  });
  assert.equal(projected.pass, true);
  assert.equal(projected.reason, CAP_A2_REASON.A2_REASON_UNKNOWN);
  assert.equal("hostile" in projected, false);
  assert.equal("body" in projected, false);

  const unevaluated = projectCapSignalA2({
    pass: null,
    reason: CAP_A2_REASON.NOT_EVALUATED,
    events_seen: 0,
    apply_overshoot: 0,
  });
  assert.equal(unevaluated.pass, null);
  assert.equal(unevaluated.reason, CAP_A2_REASON.NOT_EVALUATED);

  const nullWithoutReason = projectCapSignalA2({
    pass: null,
    reason: "within_all_seen_cap",
    events_seen: 0,
    apply_overshoot: 0,
  });
  assert.equal(nullWithoutReason.pass, false);
  assert.equal(nullWithoutReason.reason, CAP_A2_REASON.WITHIN_ALL_SEEN_CAP);
});

test("projectSinkReadbackCapSignal never includes raw body", () => {
  const projected = projectSinkReadbackCapSignal({
    cap_reached: false,
    events_seen: 0,
    apply_overshoot: 0,
    a2: { pass: null, reason: "not_evaluated", events_seen: 0, apply_overshoot: 0 },
    deadline_ms: 1_800_000,
    max_events: 10_000,
    opened: false,
    identityBinding: testIdentityBinding(),
  });
  assert.equal(projected.readback_ok, true);
  assert.equal("body" in projected, false);
  assert.equal(projected.a2.pass, null);
  assert.equal(projected.a2.reason, CAP_A2_REASON.NOT_EVALUATED);
});

test("createSinkReadbackCapSignal: hung body still settles UNKNOWN via outer race", async () => {
  const readCapSignal = createSinkReadbackCapSignal({
    url: READBACK_URL,
    token: "test-token",
    identityBinding: testIdentityBinding(),
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => new Promise(() => {
        // never settles; outer race must win
      }),
    }),
  });
  const started = Date.now();
  const signal = await readCapSignal({ timeoutMs: 30 });
  assert.equal(signal.readback_ok, false);
  assert.equal(signal.reason, CAP_SIGNAL_REASON.READBACK_TIMEOUT);
  assert.ok(Date.now() - started < 2_000);
});

test("pollCapSignal catch uses fixed allowlisted reason codes only", async () => {
  const transport = memoryAttachmentTransport([]);
  const actuator = createOwnedCapDetachActuator({
    transport,
    readCapSignal: async () => {
      throw new Error("https://secret.example/token=abc leaked");
    },
  });
  const signal = await actuator.pollCapSignal({ timeoutMs: 50 });
  assert.equal(signal.readback_ok, false);
  assert.equal(signal.reason, CAP_SIGNAL_REASON.READBACK_ERROR);
  assert.equal(String(signal.reason).includes("secret"), false);
  assert.equal(String(signal.reason).includes("token"), false);
});

test("validateSinkReadbackBody rejects non-boolean cap and negative counts", () => {
  assert.equal(validateSinkReadbackBody({}).ok, false);
  assert.equal(
    validateSinkReadbackBody({
      ok: true,
      schema: TAIL_SINK_READBACK_SCHEMA,
      sink_name: TAIL_SINK_NAME,
      cap_reached: "yes",
      events_seen: 0,
      apply_overshoot: 0,
      deadline_ms: 1000,
      max_events: 10,
      a2: { pass: true },
    }).ok,
    false,
  );
  assert.equal(
    validateSinkReadbackBody({
      ok: true,
      schema: TAIL_SINK_READBACK_SCHEMA,
      sink_name: TAIL_SINK_NAME,
      cap_reached: false,
      events_seen: -1,
      apply_overshoot: 0,
      deadline_ms: 1000,
      max_events: 10,
      a2: { pass: true },
    }).ok,
    false,
  );
  const okFresh = validateSinkReadbackBody(freshSinkReadbackBody(), {
    expectedSinkName: TAIL_SINK_NAME,
  });
  assert.equal(okFresh.ok, true);
  assert.equal(okFresh.a2.pass, null);
  assert.equal(okFresh.a2.reason, CAP_A2_REASON.NOT_EVALUATED);
  assert.equal(
    validateSinkReadbackBody(freshSinkReadbackBody({
      a2: { pass: null, reason: "within_all_seen_cap", events_seen: 0, apply_overshoot: 0 },
    }), {
      expectedSinkName: TAIL_SINK_NAME,
    }).ok,
    false,
  );
  assert.equal(
    validateSinkReadbackBody(freshSinkReadbackBody({ sink_name: "wrong-sink" }), {
      expectedSinkName: TAIL_SINK_NAME,
    }).ok,
    false,
  );
});

test("createOwnedCapDetachActuator forwards versionTransport into emergency detach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-cap-vt-forward-"));
  const store = createFileTailAttachmentStore(join(dir, "window.json"));
  const transport = memoryAttachmentTransport([SANITIZER_A]);
  let versionGets = 0;
  const versionTransport = {
    account_id_sha256: ACCOUNT_SHA,
    script_name: SANITIZER_A.service,
    consumer: SANITIZER_A,
    url: `https://api.example/accounts/a/workers/scripts/${SANITIZER_A.service}/deployments`,
    path: `/accounts/a/workers/scripts/${SANITIZER_A.service}/deployments`,
    async getLatestVersionEvidence() {
      versionGets += 1;
      return {
        present: true,
        versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
        sha256: "abc",
      };
    },
  };
  const actuator = createOwnedCapDetachActuator({
    transport,
    versionTransport,
    readCapSignal: async () => ({
      cap_reached: true,
      readback_ok: true,
      events_seen: 10_000,
      apply_overshoot: 0,
      a2: { pass: true },
    }),
  });
  assert.equal(actuator.version_transport_configured, true);

  let window = openArmedWindow({
    windowId: "cap-vt-forward",
    restorerId: "tr-vt",
    capDetachActuator: actuator,
  });
  // Bind version evidence so observeVersionGuard can match the transport.
  window = {
    ...window,
    version_evidence: {
      present: true,
      versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
      sha256: "abc",
      consumer: SANITIZER_A,
      account_id_sha256: ACCOUNT_SHA,
      get_target: {
        script_name: SANITIZER_A.service,
        url: versionTransport.url,
        path: versionTransport.path,
      },
    },
  };
  window = attachConfirmed(window, [SANITIZER_A]);
  window = await store.write(window);

  const fired = await actuator.pollAndDetachIfCapped({
    store,
    now: "2026-10-17T11:00:40.000Z",
  });
  assert.equal(fired.actuated, true);
  assert.ok(versionGets >= 1, "versionTransport must be invoked on detach");
  assert.ok(fired.version_guard || fired.result?.version_guard, "version_guard receipt required");
  const guard = fired.version_guard || fired.result.version_guard;
  assert.notEqual(guard.before_actuator, VERSION_GUARD_LABEL.NOT_PERFORMED);
  assert.ok(
    [VERSION_GUARD_LABEL.MATCH, VERSION_GUARD_LABEL.DRIFT, VERSION_GUARD_LABEL.FAILED]
      .includes(guard.before_actuator),
    guard.before_actuator,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("projectCapIdentityBinding labels URL hash and sink_name as provenance metadata", () => {
  const binding = testIdentityBinding();
  const projected = projectCapIdentityBinding(binding);
  assert.equal(projected.readback_target_provenance, "configured-url-hash");
  assert.equal(projected.sink_name_provenance, "configured-sink-name");
  assert.equal(typeof projected.readback_target_sha256, "string");
  assert.equal(projected.sink_name, TAIL_SINK_NAME);
});

test("bindCapObservationToWindowSnapshot + match refuse generation/window swap", () => {
  const snapshot = {
    window_id: "obs-A",
    window_generation: 3,
    owned_sha256: "aa".repeat(32),
    account_id_sha256: ACCOUNT_SHA,
    restorer: { restorer_id: "tr-A" },
  };
  const signal = {
    cap_reached: true,
    readback_ok: true,
    reason: CAP_SIGNAL_REASON.CAP_NOT_REACHED,
    identity_binding: {
      window_id: "obs-A",
      account_id_sha256: ACCOUNT_SHA,
      deployed_version_sha256: VERSION_SHA,
    },
  };
  const observation = bindCapObservationToWindowSnapshot(signal, snapshot);
  assert.ok(observation);
  assert.equal(observation.observed_at_window.window_id, "obs-A");
  assert.equal(observation.observed_at_window.window_generation, 3);

  assert.equal(capObservationMatchesLiveWindow(observation, snapshot), true);
  assert.equal(
    capObservationMatchesLiveWindow(observation, { ...snapshot, window_generation: 4 }),
    false,
  );
  assert.equal(
    capObservationMatchesLiveWindow(observation, { ...snapshot, window_id: "obs-B" }),
    false,
  );
  assert.equal(
    capObservationMatchesLiveWindow(observation, {
      ...snapshot,
      owned_sha256: "bb".repeat(32),
    }),
    false,
  );
  assert.equal(
    capObservationMatchesLiveWindow(observation, {
      ...snapshot,
      restorer: { restorer_id: "tr-B" },
    }),
    false,
  );
  assert.equal(capObservationMatchesLiveWindow(null, snapshot), false);
  assert.equal(capObservationMatchesLiveWindow(observation, null), false);
});

test("owned cap-detach: stale outside-lock observation refuses with 0 PATCH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-stale-cap-obs-"));
  const store = createFileTailAttachmentStore(join(dir, "window.json"));
  const transport = memoryAttachmentTransport([SANITIZER_A]);
  let pollCalls = 0;
  const actuator = createOwnedCapDetachActuator({
    transport,
    readCapSignal: async () => {
      pollCalls += 1;
      return {
        cap_reached: true,
        readback_ok: true,
        events_seen: 10_000,
        apply_overshoot: 0,
        a2: { pass: true, reason: "within_all_seen_cap" },
      };
    },
  });

  let window = openArmedWindow({
    windowId: "stale-obs-A",
    restorerId: "tr-stale",
    capDetachActuator: actuator,
  });
  window = attachConfirmed(window, [SANITIZER_A]);
  window = await store.write(window);
  const genA = window.window_generation;

  const signalA = {
    cap_reached: true,
    readback_ok: true,
    events_seen: 10_000,
    apply_overshoot: 0,
    a2: { pass: true, reason: "within_all_seen_cap" },
  };
  const observationA = bindCapObservationToWindowSnapshot(signalA, window);
  assert.ok(observationA);

  // Swap generation under the lock's live window (B) after observation of A.
  const swapped = await store.write(
    { ...window },
    { expectedWindowId: window.window_id, expectedGeneration: genA },
  );
  assert.equal(swapped.window_generation, genA + 1);
  assert.notEqual(swapped.window_generation, observationA.observed_at_window.window_generation);

  const beforeWrites = swapped.window_generation;
  const stale = await actuator.pollAndDetachIfCapped({
    store,
    now: "2026-10-17T11:00:30.000Z",
    capObservation: observationA,
    allowRepollUnderLock: false,
  });
  assert.equal(stale.actuated, false);
  assert.equal(stale.proved, false);
  assert.equal(stale.reason, CAP_SIGNAL_REASON.STALE_CAP_OBSERVATION);
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(pollCalls, 0, "must not re-poll under lock when observation is supplied");
  const after = await store.read();
  assert.equal(after.window_generation, beforeWrites, "stale path must not write replacement");
  assert.equal(after.phase, "attached");
  assert.ok(after.owned_sha256);

  // Absent prefetch + allowRepollUnderLock false → UNKNOWN, still 0 PATCH.
  const unknown = await actuator.pollAndDetachIfCapped({
    store,
    now: "2026-10-17T11:00:31.000Z",
    allowRepollUnderLock: false,
  });
  assert.equal(unknown.actuated, false);
  assert.equal(unknown.reason, CAP_SIGNAL_REASON.CAP_SIGNAL_UNKNOWN);
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(pollCalls, 0);

  // Matching observation still actuates (unchanged-window positive path).
  const live = await store.read();
  const matching = bindCapObservationToWindowSnapshot(signalA, live);
  const fired = await actuator.pollAndDetachIfCapped({
    store,
    now: "2026-10-17T11:00:32.000Z",
    capObservation: matching,
    allowRepollUnderLock: false,
  });
  assert.equal(fired.actuated, true);
  assert.equal(fired.proved, true);
  assert.ok(transport.calls.filter((c) => c.method === "PATCH").length >= 1);
  rmSync(dir, { recursive: true, force: true });
});
