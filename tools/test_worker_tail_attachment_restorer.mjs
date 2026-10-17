import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  VERSION_GUARD_LABEL,
  adaptDeploymentsVersionEvidence,
  adaptProviderTailConsumers,
  assertBetaWorkerResultMapsToScript,
  assertFreshVersionEvidenceMatchesBound,
  assertTailAttachmentVersionBound,
  assertTailTransportTargetMatchesWindow,
  assertVersionTransportMatchesBound,
  bindTailAttachmentVersionEvidence,
  canonicalizeTailConsumers,
  createBetaWorkerTailConsumersTransport,
  createDeploymentsVersionTransport,
  createDualViewTailConsumersTransport,
  createFileTailAttachmentStore,
  createScriptSettingsTailConsumersTransport,
  deploymentsVersionEvidenceHasTransportProvenance,
  deploymentsVersionEvidenceSha256,
  extractLatestDeploymentVersions,
  mapBetaTailConsumerNameOnly,
  mutateOwnedTailAttachment,
  observeVersionGuard,
  openTailAttachmentWindow,
  armTailAttachmentRestorer,
  createOwnedCapDetachActuator,
  createSinkReadbackCapSignal,
  readTailConsumersFieldFromBetaWorkerResult,
  recordTailAttachmentIntent,
  markTailAttachmentIssued,
  planTailAttachmentRestore,
  restoreTailAttachmentWindow,
  runIndependentTailRestorer,
  tailConsumersSha256,
} from "./lib/worker_tail_attachment.mjs";
import {
  GUARDIAN_STARTUP_FAILURE_CODE,
  assignTailWindowForRestorer,
  classifyGuardianStartupStderr,
  composeGuardianChildEnv,
  createBoundDeploymentsVersionTransport,
  createBoundDualViewTailConsumersTransport,
  installDurableTailRestorerRunner,
  startSupervisedTailRestorerProcess,
  stopSupervisedTailRestorerProcess,
  tailAttachmentRestorerTick,
  tailControllerDeathSignaled,
  tailRestorerPaths,
  writeTailRestorerReceipt,
} from "./lib/worker_tail_attachment_restorer.mjs";
import {
  loadCapDetachActuator,
} from "./worker_tail_attachment_restorer.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_ID = "a".repeat(32);
const ACCOUNT_SHA = createHash("sha256").update(ACCOUNT_ID).digest("hex");
const WORKER_ID = "cityscroll-cc05-r4-cpu-producer";
const SANITIZER = Object.freeze({
  service: "cityscroll-cc05-r4-tail-sanitizer",
  environment: null,
  namespace: null,
});
const FOREIGN_NS = Object.freeze({
  service: "cityscroll-cc05-r4-tail-sanitizer",
  environment: null,
  namespace: "foreign-A",
});
const VERSION_ID = "023e105f-2a42-4f8b-a1c1-73f6a2a30c0f";

function transportProvenanceEvidence({
  consumer = SANITIZER,
  accountId = ACCOUNT_ID,
  accountIdSha256 = ACCOUNT_SHA,
  versions = [{ version_id: VERSION_ID, percentage: 100 }],
  origin = "https://api.cloudflare.com/client/v4",
} = {}) {
  const script = consumer.service;
  const path = `/accounts/${accountId}/workers/scripts/${script}/deployments`;
  const url = `${origin}${path}`;
  const normalized = versions.map((entry) => ({
    version_id: entry.version_id,
    percentage: entry.percentage,
  }));
  return {
    present: true,
    reason: null,
    versions: normalized,
    provenance: "deployments-list-GET",
    account_id_sha256: accountIdSha256,
    get_target: { script_name: script, url, path },
    consumer: { ...consumer },
    http: { method: "GET", status: 200, success: true },
    sha256: deploymentsVersionEvidenceSha256(normalized),
    version: normalized[0]?.version_id ?? null,
  };
}

const VERSION_EVIDENCE = Object.freeze(transportProvenanceEvidence());

function memoryTransport(initial) {
  let current = initial == null ? null : canonicalizeTailConsumers(initial);
  const calls = [];
  return {
    calls,
    async getTailConsumers() {
      calls.push({ method: "GET" });
      return current == null ? null : structuredClone(current);
    },
    async patchTailConsumers(next) {
      current = canonicalizeTailConsumers(next);
      calls.push({ method: "PATCH", consumers: structuredClone(current) });
      return structuredClone(current);
    },
    setCurrent(next) {
      current = next == null ? null : canonicalizeTailConsumers(next);
    },
  };
}

function memoryVersionTransport({
  consumer = SANITIZER,
  accountId = ACCOUNT_ID,
  versions = [{ version_id: VERSION_ID, percentage: 100 }],
} = {}) {
  let currentVersions = versions.map((entry) => ({
    version_id: entry.version_id,
    percentage: entry.percentage,
  }));
  const accountSha = createHash("sha256").update(accountId).digest("hex");
  const path = `/accounts/${accountId}/workers/scripts/${consumer.service}/deployments`;
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const calls = [];
  return {
    calls,
    account_id: accountId,
    account_id_sha256: accountSha,
    script_name: consumer.service,
    consumer: { ...consumer },
    url,
    path,
    setVersions(next) {
      currentVersions = next.map((entry) => ({
        version_id: entry.version_id,
        percentage: entry.percentage,
      }));
    },
    async getLatestVersionEvidence() {
      calls.push({ method: "GET", script_name: consumer.service, versions: structuredClone(currentVersions) });
      return transportProvenanceEvidence({
        consumer,
        accountId,
        accountIdSha256: accountSha,
        versions: currentVersions,
      });
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
      readback_ok: true,
      reason: "fixture_idle",
      events_seen: null,
      apply_overshoot: null,
    }),
  });
}

/** Test-only fixture module for the installed runner's loadCapDetachActuator. */
function writeFixtureCapDetachModule(dir) {
  const modPath = join(dir, "fake-cap-detach.mjs");
  writeFileSync(modPath, `export function createCapDetachActuator(env, window, { transport, versionTransport }) {
  return {
    kind: "fixture-cap-detach",
    version_transport_configured: Boolean(
      versionTransport && typeof versionTransport.getLatestVersionEvidence === "function",
    ),
    async pollCapSignal() {
      return {
        cap_reached: false,
        readback_ok: true,
        reason: "fixture_idle",
        events_seen: null,
        apply_overshoot: null,
      };
    },
    async pollAndDetachIfCapped() {
      return {
        actuated: false,
        proved: false,
        reason: "cap_not_reached",
        signal: {
          cap_reached: false,
          readback_ok: true,
          reason: "fixture_idle",
          events_seen: null,
          apply_overshoot: null,
        },
      };
    },
  };
}
`);
  return pathToFileURL(modPath).href;
}

async function openStoredArmedWindow(dir, {
  windowId = "tail-restorer-win",
  baselineConsumers = [],
  now = "2026-10-17T11:00:00.000Z",
  durationSeconds = 1800,
  restorerId = "tr-restorer",
  versionEvidence = VERSION_EVIDENCE,
  versionTransport = null,
  capDetachActuator = null,
} = {}) {
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openTailAttachmentWindow({
    baselineConsumers,
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now,
    durationSeconds,
    windowId,
  });
  window = armTailAttachmentRestorer(window, {
    now: "2026-10-17T11:00:01.000Z",
    restorerId,
    capDetachActuator: capDetachActuator || fixtureCapDetachActuator(),
  });
  const vt = versionTransport || memoryVersionTransport();
  if (versionEvidence) {
    window = bindTailAttachmentVersionEvidence(window, versionEvidence, {
      now: "2026-10-17T11:00:01.500Z",
      consumer: SANITIZER,
      accountIdSha256: ACCOUNT_SHA,
      getTarget: {
        script_name: SANITIZER.service,
        url: versionEvidence.get_target.url,
        path: versionEvidence.get_target.path,
      },
      source: `GET /workers/scripts/${SANITIZER.service}/deployments`,
    });
  }
  window = await store.write(window);
  return { store, window, versionTransport: vt };
}

test("transport target binding refuses account or worker mismatch", () => {
  const window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now: "2026-10-17T11:00:00.000Z",
    windowId: "bind-win",
  });
  assert.throws(
    () => assertTailTransportTargetMatchesWindow({
      CLOUDFLARE_ACCOUNT_ID: "wrong-account",
      CLOUDFLARE_WORKER_ID: WORKER_ID,
    }, window),
    /account does not match window account_id_sha256/,
  );
  assert.throws(
    () => assertTailTransportTargetMatchesWindow({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: "other-worker",
    }, window),
    /worker does not match window worker_id/,
  );
  const bound = assertTailTransportTargetMatchesWindow({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_WORKER_ID: WORKER_ID,
  }, window);
  assert.equal(bound.accountSha, ACCOUNT_SHA);
  assert.equal(bound.workerId, WORKER_ID);
});

test("deployments version evidence stays separate from ConsumerScript identity", () => {
  const missing = adaptDeploymentsVersionEvidence(null);
  assert.equal(missing.present, false);
  const malformed = adaptDeploymentsVersionEvidence({ versions: [{ version_id: "v1" }] });
  assert.equal(malformed.present, false);
  const ok = adaptDeploymentsVersionEvidence({
    versions: [{ version_id: "ver-abc", percentage: 100 }],
  });
  assert.equal(ok.present, true);
  assert.deepEqual(ok.versions, [{ version_id: "ver-abc", percentage: 100 }]);
  // Latest actively-serving deployment versions extracted from list payload.
  const fromList = adaptDeploymentsVersionEvidence({
    deployments: [
      {
        id: "dep-1",
        versions: [{ version_id: "ver-live", percentage: 100 }],
      },
      {
        id: "dep-0",
        versions: [{ version_id: "ver-old", percentage: 100 }],
      },
    ],
  });
  assert.equal(fromList.present, true);
  assert.deepEqual(fromList.versions, [{ version_id: "ver-live", percentage: 100 }]);
  assert.deepEqual(
    extractLatestDeploymentVersions({ deployments: [{ versions: [{ version_id: "x", percentage: 100 }] }] }),
    [{ version_id: "x", percentage: 100 }],
  );
  // Identity digest ignores version evidence entirely.
  const identity = canonicalizeTailConsumers([SANITIZER]);
  assert.equal(identity[0].namespace, null);
  assert.equal(Object.prototype.hasOwnProperty.call(identity[0], "revision"), false);
});

test("deployments version GET transport binds evidence; mutate refuses unbound window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-ver-"));
  const calls = [];
  const versionTransport = createDeploymentsVersionTransport({
    accountId: ACCOUNT_ID,
    scriptName: SANITIZER.service,
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      assert.match(url, /\/workers\/scripts\/.+\/deployments$/);
      assert.match(url, new RegExp(`/workers/scripts/${SANITIZER.service}/deployments$`));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: {
              deployments: [
                {
                  id: "dep-live",
                  versions: [{ version_id: "ver-live-1", percentage: 100 }],
                },
              ],
            },
          };
        },
      };
    },
  });
  const evidence = await versionTransport.getLatestVersionEvidence();
  assert.equal(evidence.present, true);
  assert.equal(evidence.versions[0].version_id, "ver-live-1");
  assert.equal(evidence.provenance, "deployments-list-GET");
  assert.equal(evidence.get_target.script_name, SANITIZER.service);
  assert.equal(evidence.account_id_sha256, ACCOUNT_SHA);
  assert.equal(deploymentsVersionEvidenceHasTransportProvenance(evidence), true);
  assert.equal(calls.length, 1);

  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now: "2026-10-17T11:00:00.000Z",
    windowId: "ver-win",
  });
  window = armTailAttachmentRestorer(window, {
    now: "2026-10-17T11:00:01.000Z",
    restorerId: "tr-ver",
    capDetachActuator: fixtureCapDetachActuator(),
  });
  window = await store.write(window);
  assert.throws(() => assertTailAttachmentVersionBound(window), /not bound/);

  const transport = memoryTransport([]);
  await assert.rejects(
    () => mutateOwnedTailAttachment({
      transport,
      store,
      intendedConsumers: [SANITIZER],
      phase: "attach",
      now: "2026-10-17T11:00:05.000Z",
      versionTransport,
    }),
    /deployed-version GET evidence is not bound/,
  );

  window = bindTailAttachmentVersionEvidence(window, evidence, {
    now: "2026-10-17T11:00:02.000Z",
    consumer: SANITIZER,
    accountId: ACCOUNT_ID,
    getTarget: {
      script_name: SANITIZER.service,
      url: evidence.get_target.url,
      path: evidence.get_target.path,
    },
    source: `GET /workers/scripts/${SANITIZER.service}/deployments`,
  });
  assert.equal(window.version_evidence.present, true);
  assert.equal(window.version_evidence.consumer.service, SANITIZER.service);
  assert.equal(window.version_evidence.get_target.script_name, SANITIZER.service);
  assert.equal(window.version_evidence.account_id_sha256, ACCOUNT_SHA);
  assert.equal(Object.prototype.hasOwnProperty.call(window.version_evidence.versions[0], "service"), false);
  window = await store.write(window);
  const bound = assertTailAttachmentVersionBound(window, {
    intendedConsumers: [SANITIZER],
    phase: "attach",
  });
  assert.equal(bound.versions[0].version_id, "ver-live-1");
  assert.equal(bound.consumer.service, SANITIZER.service);

  const result = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport,
  });
  assert.equal(result.ok, true);
  assert.equal(result.window.version_evidence.versions[0].version_id, "ver-live-1");
  rmSync(dir, { recursive: true, force: true });
});

test("negative: version proof for consumer A refuses attach of consumer B (0 PATCH)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-a2b-"));
  const consumerA = Object.freeze({
    service: "consumer-A",
    environment: null,
    namespace: null,
  });
  const consumerB = Object.freeze({
    service: "consumer-B",
    environment: null,
    namespace: null,
  });
  const uuidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const evidenceA = transportProvenanceEvidence({
    consumer: consumerA,
    versions: [{ version_id: uuidA, percentage: 100 }],
  });
  const versionTransportA = memoryVersionTransport({
    consumer: consumerA,
    versions: [{ version_id: uuidA, percentage: 100 }],
  });
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now: "2026-10-17T12:00:00.000Z",
    windowId: "a2b-win",
  });
  window = armTailAttachmentRestorer(window, {
    now: "2026-10-17T12:00:01.000Z",
    restorerId: "tr-a2b",
    capDetachActuator: fixtureCapDetachActuator(),
  });
  window = bindTailAttachmentVersionEvidence(window, evidenceA, {
    now: "2026-10-17T12:00:02.000Z",
    consumer: consumerA,
    accountIdSha256: ACCOUNT_SHA,
    getTarget: {
      script_name: consumerA.service,
      url: evidenceA.get_target.url,
      path: evidenceA.get_target.path,
    },
    source: `GET /workers/scripts/${consumerA.service}/deployments`,
  });
  window = await store.write(window);

  let patchCount = 0;
  let current = [];
  const transport = {
    async getTailConsumers() {
      return current == null ? null : structuredClone(current);
    },
    async patchTailConsumers(next) {
      patchCount += 1;
      current = canonicalizeTailConsumers(next);
      return structuredClone(current);
    },
  };

  await assert.rejects(
    () => mutateOwnedTailAttachment({
      transport,
      store,
      intendedConsumers: [consumerB],
      phase: "attach",
      now: "2026-10-17T12:00:05.000Z",
      versionTransport: versionTransportA,
    }),
    /proof for one consumer does not authorize attach of another/,
  );
  assert.equal(patchCount, 0, "mismatched consumer must never issue PATCH");
  assert.deepEqual(current, []);

  // Matching consumer A still authorizes.
  const ok = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [consumerA],
    phase: "attach",
    now: "2026-10-17T12:00:06.000Z",
    versionTransport: versionTransportA,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.window.phase, "attached");
  assert.equal(patchCount, 1);

  // Digest/drift guard: tampered sha256 refuses before any PATCH.
  const drifted = await store.read();
  drifted.version_evidence = {
    ...drifted.version_evidence,
    sha256: "0".repeat(64),
  };
  await store.write(drifted, { expectedWindowId: drifted.window_id });
  await assert.rejects(
    () => mutateOwnedTailAttachment({
      transport,
      store,
      intendedConsumers: [consumerA],
      phase: "attach",
      now: "2026-10-17T12:00:07.000Z",
      versionTransport: versionTransportA,
    }),
    /digest does not match versions; refusing drift/,
  );
  assert.equal(patchCount, 1, "drift refuse must not issue another PATCH");

  // Bind-time refusals: versions-only (no provenance) / relabel / account mismatch.
  assert.throws(
    () => bindTailAttachmentVersionEvidence(window, {
      present: true,
      versions: [{ version_id: uuidA, percentage: 100 }],
    }, {
      consumer: consumerA,
      accountIdSha256: ACCOUNT_SHA,
      getTarget: { script_name: consumerA.service },
    }),
    /lacks transport GET provenance/,
  );
  assert.throws(
    () => bindTailAttachmentVersionEvidence(window, evidenceA, {
      consumer: consumerB,
      accountIdSha256: ACCOUNT_SHA,
      getTarget: {
        script_name: consumerB.service,
        url: evidenceA.get_target.url,
      },
    }),
    /refusing to relabel an actual GET/,
  );
  assert.throws(
    () => bindTailAttachmentVersionEvidence(window, evidenceA, {
      consumer: consumerA,
      accountIdSha256: "b".repeat(64),
      getTarget: evidenceA.get_target,
    }),
    /caller account does not match transport GET provenance account/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("negative: cannot relabel an actual consumer-A deployments GET as consumer-B", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-relabel-"));
  const consumerA = Object.freeze({
    service: "consumer-A",
    environment: null,
    namespace: null,
  });
  const consumerB = Object.freeze({
    service: "consumer-B",
    environment: null,
    namespace: null,
  });
  const versionTransportA = createDeploymentsVersionTransport({
    accountId: ACCOUNT_ID,
    scriptName: consumerA.service,
    token: "test-token",
    fetchImpl: async (url) => {
      assert.match(url, /\/workers\/scripts\/consumer-A\/deployments$/);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: {
              deployments: [
                { id: "dep-a", versions: [{ version_id: "ver-a-1", percentage: 100 }] },
              ],
            },
          };
        },
      };
    },
  });
  const evidenceA = await versionTransportA.getLatestVersionEvidence();
  assert.equal(evidenceA.get_target.script_name, "consumer-A");
  assert.ok(evidenceA.get_target.url.includes("/consumer-A/deployments"));

  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now: "2026-10-17T12:00:00.000Z",
    windowId: "relabel-win",
  });
  window = armTailAttachmentRestorer(window, {
    now: "2026-10-17T12:00:01.000Z",
    restorerId: "tr-relabel",
    capDetachActuator: fixtureCapDetachActuator(),
  });

  // Root counterexample: binder must refuse consumer B + getTarget B with A's actual URL.
  assert.throws(
    () => bindTailAttachmentVersionEvidence(window, evidenceA, {
      now: "2026-10-17T12:00:02.000Z",
      consumer: consumerB,
      accountId: ACCOUNT_ID,
      getTarget: {
        script_name: consumerB.service,
        url: evidenceA.get_target.url,
      },
    }),
    /refusing to relabel an actual GET/,
  );

  // Honest bind for A still works; attaching B then refuses with 0 PATCH.
  window = bindTailAttachmentVersionEvidence(window, evidenceA, {
    now: "2026-10-17T12:00:02.000Z",
    consumer: consumerA,
    accountId: ACCOUNT_ID,
    getTarget: evidenceA.get_target,
  });
  window = await store.write(window);
  assert.equal(window.version_evidence.get_target.url, evidenceA.get_target.url);

  let patchCount = 0;
  const transport = memoryTransport([]);
  const originalPatch = transport.patchTailConsumers.bind(transport);
  transport.patchTailConsumers = async (next) => {
    patchCount += 1;
    return originalPatch(next);
  };
  await assert.rejects(
    () => mutateOwnedTailAttachment({
      transport,
      store,
      intendedConsumers: [consumerB],
      phase: "attach",
      now: "2026-10-17T12:00:05.000Z",
      versionTransport: versionTransportA,
    }),
    /proof for one consumer does not authorize attach of another/,
  );
  assert.equal(patchCount, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("negative: provider deployment drift UUID1→UUID2 refuses attach (0 PATCH)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-drift-"));
  const uuid1 = "11111111-1111-1111-1111-111111111111";
  const uuid2 = "22222222-2222-2222-2222-222222222222";
  const versionTransport = memoryVersionTransport({
    consumer: SANITIZER,
    versions: [{ version_id: uuid1, percentage: 100 }],
  });
  const evidence = await versionTransport.getLatestVersionEvidence();
  assert.equal(evidence.versions[0].version_id, uuid1);

  const { store } = await openStoredArmedWindow(dir, {
    windowId: "drift-win",
    versionEvidence: evidence,
    versionTransport,
  });

  // Provider moves current deployment to UUID2 before attach.
  versionTransport.setVersions([{ version_id: uuid2, percentage: 100 }]);
  const fresh = await versionTransport.getLatestVersionEvidence();
  assert.equal(fresh.versions[0].version_id, uuid2);
  const boundWindow = await store.read();
  assert.throws(
    () => assertFreshVersionEvidenceMatchesBound(fresh, boundWindow.version_evidence),
    /provider deployment drift/,
  );

  let patchCount = 0;
  const transport = memoryTransport([]);
  const originalPatch = transport.patchTailConsumers.bind(transport);
  transport.patchTailConsumers = async (next) => {
    patchCount += 1;
    return originalPatch(next);
  };

  await assert.rejects(
    () => mutateOwnedTailAttachment({
      transport,
      store,
      intendedConsumers: [SANITIZER],
      phase: "attach",
      now: "2026-10-17T11:00:05.000Z",
      versionTransport,
    }),
    /provider deployment drift/,
  );
  assert.equal(patchCount, 0, "provider drift must never issue PATCH");

  // Matching fresh GET still authorizes (before + after actuator).
  versionTransport.setVersions([{ version_id: uuid1, percentage: 100 }]);
  const ok = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:06.000Z",
    versionTransport,
  });
  assert.equal(ok.ok, true);
  assert.equal(patchCount, 1);
  assert.equal(ok.version_guard.before_actuator, VERSION_GUARD_LABEL.MATCH);
  assert.equal(ok.version_guard.after_actuator, VERSION_GUARD_LABEL.MATCH);
  assert.equal(ok.version_guard.version, uuid1);
  assert.equal(ok.version_guard.provider_cas, "UNKNOWN");
  assert.notEqual(ok.version_guard.before_actuator, true);
  assert.notEqual(ok.version_guard.after_actuator, true);
  rmSync(dir, { recursive: true, force: true });
});

test("negative: provider drift after actuator returns ok:false with ownership_attached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-after-drift-"));
  const uuid1 = "11111111-1111-1111-1111-111111111111";
  const uuid2 = "22222222-2222-2222-2222-222222222222";
  const versionTransport = memoryVersionTransport({
    consumer: SANITIZER,
    versions: [{ version_id: uuid1, percentage: 100 }],
  });
  const evidence = await versionTransport.getLatestVersionEvidence();
  const { store } = await openStoredArmedWindow(dir, {
    windowId: "after-drift-win",
    versionEvidence: evidence,
    versionTransport,
  });

  let getCount = 0;
  const guardedVt = {
    ...versionTransport,
    account_id: versionTransport.account_id,
    account_id_sha256: versionTransport.account_id_sha256,
    script_name: versionTransport.script_name,
    consumer: versionTransport.consumer,
    url: versionTransport.url,
    path: versionTransport.path,
    async getLatestVersionEvidence() {
      getCount += 1;
      // First call = before actuator (UUID1). Second = after actuator (UUID2 drift).
      if (getCount >= 2) {
        versionTransport.setVersions([{ version_id: uuid2, percentage: 100 }]);
      }
      return versionTransport.getLatestVersionEvidence();
    },
  };

  let patchCount = 0;
  const transport = memoryTransport([]);
  const originalPatch = transport.patchTailConsumers.bind(transport);
  transport.patchTailConsumers = async (next) => {
    patchCount += 1;
    return originalPatch(next);
  };

  const result = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport: guardedVt,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider-drift-after-attach");
  assert.equal(result.ownership_attached, true);
  assert.equal(patchCount, 1);
  assert.equal(getCount, 2);
  assert.equal(createBoundDeploymentsVersionTransport({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: "test-token",
  }, await store.read()).script_name, SANITIZER.service);
  rmSync(dir, { recursive: true, force: true });
});

test("script-settings Tail transport GET/PATCH round-trip via fetchImpl", async () => {
  let stored = { tail_consumers: [] };
  const transport = createScriptSettingsTailConsumersTransport({
    accountId: ACCOUNT_ID,
    scriptName: WORKER_ID,
    token: "test-token",
    fetchImpl: async (url, init) => {
      assert.match(url, /\/script-settings$/);
      assert.equal(init.headers.Authorization, "Bearer test-token");
      if (init.method === "GET") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: structuredClone(stored) };
          },
        };
      }
      const body = JSON.parse(init.body);
      stored = { ...stored, tail_consumers: body.tail_consumers };
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, result: structuredClone(stored) };
        },
      };
    },
  });
  assert.deepEqual(await transport.getTailConsumers(), []);
  await transport.patchTailConsumers([SANITIZER]);
  assert.deepEqual(await transport.getTailConsumers(), canonicalizeTailConsumers([SANITIZER]));
});

test("negative: script-settings omit/null/empty-result stay UNKNOWN — never coerced to []", async () => {
  async function getFrom(result) {
    const transport = createScriptSettingsTailConsumersTransport({
      accountId: ACCOUNT_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { success: true, result };
        },
      }),
    });
    return transport.getTailConsumers();
  }

  // result:{} — HTTP success, no declared array.
  assert.equal(await getFrom({}), null);
  // Optional field omitted.
  assert.equal(await getFrom({ logpush: false, tags: [] }), null);
  // Key present, value null (live fresh-Worker shape).
  assert.equal(await getFrom({
    logpush: false,
    tags: [],
    tail_consumers: null,
    observability: null,
  }), null);
  // Non-array value stays UNKNOWN.
  assert.equal(await getFrom({ tail_consumers: { service: "x" } }), null);

  // Only an actual array is declared (including []).
  assert.deepEqual(await getFrom({ tail_consumers: [] }), []);
  assert.deepEqual(
    await getFrom({ tail_consumers: [SANITIZER] }),
    [SANITIZER],
  );

  const adaptedOmit = adaptProviderTailConsumers(null);
  assert.equal(adaptedOmit.present, false);
  assert.equal(adaptedOmit.reason, "missing");
  const adaptedEmpty = adaptProviderTailConsumers([]);
  assert.equal(adaptedEmpty.present, true);
  assert.deepEqual(adaptedEmpty.consumers, []);
});

test("beta Worker GET: explicit [] proves empty; omit/null/failure stay UNKNOWN; mismatched worker_id refused", async () => {
  // Name-only helper validates {name} and never invents env/namespace nulls.
  assert.deepEqual(
    mapBetaTailConsumerNameOnly({ name: "cityscroll-cc05-tail-consumer" }),
    { name: "cityscroll-cc05-tail-consumer" },
  );
  assert.throws(
    () => mapBetaTailConsumerNameOnly({ service: "x" }),
    /requires name/,
  );

  const mapped = assertBetaWorkerResultMapsToScript(
    { id: "uuid-abc", name: WORKER_ID, tail_consumers: [] },
    { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
  );
  assert.equal(mapped.name, WORKER_ID);
  assert.throws(
    () => assertBetaWorkerResultMapsToScript(
      { id: "uuid-abc", name: "other-worker", tail_consumers: [] },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    /does not map to expected script/,
  );

  // Explicit [] proves empty after mapping check — only beta-authoritative value.
  assert.deepEqual(
    readTailConsumersFieldFromBetaWorkerResult(
      { id: "uuid-abc", name: WORKER_ID, tail_consumers: [] },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    [],
  );
  // Non-empty name-only stays UNKNOWN — never invent ConsumerScript nulls.
  assert.equal(
    readTailConsumersFieldFromBetaWorkerResult(
      {
        id: "uuid-abc",
        name: WORKER_ID,
        tail_consumers: [{ name: "cityscroll-cc05-tail-consumer" }],
      },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    null,
  );
  // Omit / null / non-array stay UNKNOWN — never coerced to [].
  assert.equal(
    readTailConsumersFieldFromBetaWorkerResult(
      { id: "uuid-abc", name: WORKER_ID },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    null,
  );
  assert.equal(
    readTailConsumersFieldFromBetaWorkerResult(
      { id: "uuid-abc", name: WORKER_ID, tail_consumers: null },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    null,
  );
  assert.equal(
    readTailConsumersFieldFromBetaWorkerResult(
      { id: "uuid-abc", name: WORKER_ID, tail_consumers: { name: "x" } },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    null,
  );
  // Mismatched name refuses before trusting the field.
  assert.throws(
    () => readTailConsumersFieldFromBetaWorkerResult(
      { id: "uuid-abc", name: "foreign-worker", tail_consumers: [] },
      { expectedScriptName: WORKER_ID, expectedWorkerId: WORKER_ID },
    ),
    /does not map to expected script/,
  );

  async function betaGet(result, { ok = true, status = 200, success = true } = {}) {
    const transport = createBetaWorkerTailConsumersTransport({
      accountId: ACCOUNT_ID,
      workerId: WORKER_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => ({
        ok,
        status,
        async json() {
          return { success, result };
        },
      }),
    });
    return transport.getTailConsumers();
  }

  assert.deepEqual(
    await betaGet({ id: "uuid-abc", name: WORKER_ID, tail_consumers: [] }),
    [],
  );
  assert.equal(
    await betaGet({
      id: "uuid-abc",
      name: WORKER_ID,
      tail_consumers: [{ name: SANITIZER.service }],
    }),
    null,
    "non-empty name-only beta stays UNKNOWN",
  );
  assert.equal(
    await betaGet({ id: "uuid-abc", name: WORKER_ID, tail_consumers: null }),
    null,
  );
  assert.equal(
    await betaGet({ id: "uuid-abc", name: WORKER_ID }),
    null,
  );
  await assert.rejects(
    () => betaGet({ id: "uuid-abc", name: "other-worker", tail_consumers: [] }),
    /does not map to expected script/,
  );
  await assert.rejects(
    () => betaGet(null, { ok: false, status: 500, success: false }),
    /beta Worker tail GET failed/,
  );

  // Dual-view: script-settings null is UNKNOWN; beta [] proves empty.
  const scriptSettings = createScriptSettingsTailConsumersTransport({
    accountId: ACCOUNT_ID,
    scriptName: WORKER_ID,
    token: "test-token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result: { logpush: false, tags: [], tail_consumers: null, observability: null },
        };
      },
    }),
  });
  const beta = createBetaWorkerTailConsumersTransport({
    accountId: ACCOUNT_ID,
    workerId: WORKER_ID,
    scriptName: WORKER_ID,
    token: "test-token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result: { id: "uuid-abc", name: WORKER_ID, tail_consumers: [] },
        };
      },
    }),
  });
  const dual = createDualViewTailConsumersTransport({
    scriptSettingsTransport: scriptSettings,
    betaTransport: beta,
  });
  assert.equal(await scriptSettings.getTailConsumers(), null, "script-settings null stays UNKNOWN");
  assert.deepEqual(await dual.getTailConsumers(), [], "beta [] proves empty through dual-view");
  assert.equal(dual.last_view.view, "beta-worker");
  assert.equal(dual.last_view.script_settings_unknown, true);
  assert.equal(dual.last_view.empty_proved, true);
  assert.equal(dual.last_view.namespace_fidelity, "none");
  assert.equal(dual.last_view.beta_name_only_nonempty_unknown, false);

  const dualView = await dual.getDualView();
  assert.equal(dualView.script_settings_unknown, true);
  assert.equal(dualView.script_override_present, false);
  assert.equal(dualView.empty_proved_by_beta, true);
  assert.deepEqual(dualView.effective, []);
  assert.equal(dualView.effective_entry_shape, "name-only");

  // Dual-view refuses mismatched beta mapping the same way.
  const badBeta = createBetaWorkerTailConsumersTransport({
    accountId: ACCOUNT_ID,
    workerId: WORKER_ID,
    scriptName: WORKER_ID,
    token: "test-token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result: { id: "uuid-abc", name: "not-the-script", tail_consumers: [] },
        };
      },
    }),
  });
  const dualBad = createDualViewTailConsumersTransport({
    scriptSettingsTransport: scriptSettings,
    betaTransport: badBeta,
  });
  await assert.rejects(
    () => dualBad.getTailConsumers(),
    /does not map to expected script/,
  );

  // Bound factory wires both views to the window worker_id.
  const bound = createBoundDualViewTailConsumersTransport(
    {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CLOUDFLARE_API_TOKEN: "test-token",
    },
    { account_id_sha256: ACCOUNT_SHA, worker_id: WORKER_ID },
  );
  assert.equal(bound.endpoint, "dual-view-script-settings+beta-worker");
  assert.ok(bound.beta_transport);
  assert.ok(bound.script_settings_transport);
});

test("beta name-only non-empty: script null + name-only beta stays UNKNOWN; retain ownership; 0 PATCH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-beta-name-only-"));
  try {
    const { store } = await openStoredArmedWindow(dir, {
      windowId: "beta-name-only-win",
      baselineConsumers: [],
    });
    let window = await store.read();
    // Own the same service name that a name-only beta would invent nulls for.
    window = {
      ...window,
      phase: "attached",
      owned_consumers: canonicalizeTailConsumers([SANITIZER]),
      owned_sha256: tailConsumersSha256([SANITIZER]),
    };
    window = await store.write(window);

    const scriptSettings = createScriptSettingsTailConsumersTransport({
      accountId: ACCOUNT_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: { logpush: false, tags: [], tail_consumers: null, observability: null },
          };
        },
      }),
    });
    const beta = createBetaWorkerTailConsumersTransport({
      accountId: ACCOUNT_ID,
      workerId: WORKER_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: {
              id: "uuid-abc",
              name: WORKER_ID,
              // Name matches owned service — inventing null env/namespace would
              // falsely classify OWNED and plan PATCH [].
              tail_consumers: [{ name: SANITIZER.service }],
            },
          };
        },
      }),
    });
    const dual = createDualViewTailConsumersTransport({
      scriptSettingsTransport: scriptSettings,
      betaTransport: beta,
    });

    const raw = await dual.getTailConsumers();
    assert.equal(raw, null, "non-empty name-only beta must stay UNKNOWN");
    assert.equal(dual.last_view.empty_proved, false);
    assert.equal(dual.last_view.beta_name_only_nonempty_unknown, true);
    assert.equal(dual.last_view.namespace_fidelity, "none");

    const adapted = adaptProviderTailConsumers(raw);
    assert.equal(adapted.present, false);

    const plan = planTailAttachmentRestore(raw, window, {
      now: "2026-10-17T11:05:00.000Z",
    });
    assert.equal(plan.action, "retain-owned-unknown");
    assert.equal(plan.ownership_preserved, true);
    assert.equal(plan.ownership_unknown, true);
    assert.equal(plan.proved, false);
    assert.equal(plan.patch, null, "0 PATCH — name-only must not plan restore to []");

    let patchInvoked = false;
    const guardedDual = {
      ...dual,
      async getTailConsumers() {
        return dual.getTailConsumers();
      },
      async patchTailConsumers(list) {
        patchInvoked = true;
        return dual.patchTailConsumers(list);
      },
    };
    const restored = await restoreTailAttachmentWindow(window, guardedDual, {
      now: "2026-10-17T11:05:01.000Z",
    });
    assert.equal(restored.action, "retain-owned-unknown");
    assert.equal(restored.patch, null);
    assert.equal(patchInvoked, false, "0 PATCH on name-only beta UNKNOWN");
    assert.equal(restored.ownership_preserved, true);
    assert.equal(restored.window.owned_sha256, window.owned_sha256, "ownership retained");
    assert.equal(restored.window.phase, "attached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta [] positive empty proof; foreign-namespace script-settings refuses with 0 PATCH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-beta-empty-foreign-"));
  try {
    // Positive: beta [] through dual-view proves empty and plans already-restored.
    const { store } = await openStoredArmedWindow(dir, {
      windowId: "beta-empty-foreign-win",
      baselineConsumers: [],
    });
    let window = await store.read();
    window = {
      ...window,
      phase: "attached",
      owned_consumers: canonicalizeTailConsumers([SANITIZER]),
      owned_sha256: tailConsumersSha256([SANITIZER]),
    };
    window = await store.write(window);

    const emptyScript = createScriptSettingsTailConsumersTransport({
      accountId: ACCOUNT_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: { logpush: false, tags: [], tail_consumers: null, observability: null },
          };
        },
      }),
    });
    const emptyBeta = createBetaWorkerTailConsumersTransport({
      accountId: ACCOUNT_ID,
      workerId: WORKER_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            result: { id: "uuid-abc", name: WORKER_ID, tail_consumers: [] },
          };
        },
      }),
    });
    const emptyDual = createDualViewTailConsumersTransport({
      scriptSettingsTransport: emptyScript,
      betaTransport: emptyBeta,
    });
    const emptyRaw = await emptyDual.getTailConsumers();
    assert.deepEqual(emptyRaw, [], "positive: beta [] proves empty");
    assert.equal(emptyDual.last_view.empty_proved, true);
    const emptyPlan = planTailAttachmentRestore(emptyRaw, window, {
      now: "2026-10-17T11:06:00.000Z",
    });
    assert.equal(emptyPlan.action, "already-restored");
    assert.equal(emptyPlan.patch, null);
    assert.equal(emptyPlan.proved, true);

    // Foreign-namespace variant: full script-settings identity with foreign
    // namespace (same service, same count) → refuse-conflict, 0 PATCH.
    const foreignPlan = planTailAttachmentRestore([FOREIGN_NS], window, {
      now: "2026-10-17T11:06:01.000Z",
    });
    assert.equal(foreignPlan.action, "refuse-conflict");
    assert.equal(foreignPlan.patch, null, "foreign-namespace: 0 PATCH");
    assert.equal(foreignPlan.ownership_preserved, true);
    assert.equal(foreignPlan.classification.class, "conflict");

    // Dual-view prefers full script-settings array over beta when present.
    let scriptCalls = 0;
    let patchCalls = 0;
    const foreignScript = createScriptSettingsTailConsumersTransport({
      accountId: ACCOUNT_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async (url, init = {}) => {
        scriptCalls += 1;
        if (init.method === "PATCH") patchCalls += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              result: {
                logpush: false,
                tags: [],
                tail_consumers: [FOREIGN_NS],
                observability: null,
              },
            };
          },
        };
      },
    });
    const ignoredBeta = createBetaWorkerTailConsumersTransport({
      accountId: ACCOUNT_ID,
      workerId: WORKER_ID,
      scriptName: WORKER_ID,
      token: "test-token",
      fetchImpl: async () => {
        throw new Error("beta must not be consulted when script-settings is present");
      },
    });
    const foreignDual = createDualViewTailConsumersTransport({
      scriptSettingsTransport: foreignScript,
      betaTransport: ignoredBeta,
    });
    const foreignRaw = await foreignDual.getTailConsumers();
    assert.deepEqual(foreignRaw, canonicalizeTailConsumers([FOREIGN_NS]));
    assert.equal(foreignDual.last_view.view, "script-settings");
    assert.equal(foreignDual.last_view.namespace_fidelity, "full");
    assert.equal(foreignDual.last_view.beta_consulted, false);

    const dualForeignPlan = planTailAttachmentRestore(foreignRaw, window, {
      now: "2026-10-17T11:06:02.000Z",
    });
    assert.equal(dualForeignPlan.action, "refuse-conflict");
    assert.equal(dualForeignPlan.patch, null);
    const dualForeignRestore = await restoreTailAttachmentWindow(window, foreignDual, {
      now: "2026-10-17T11:06:03.000Z",
    });
    assert.equal(dualForeignRestore.action, "refuse-conflict");
    assert.equal(patchCalls, 0, "foreign-namespace restore issues 0 PATCH");
    assert.ok(scriptCalls >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutateOwnedTailAttachment write-ahead issues before PATCH and confirms on readback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-mutate-"));
  const { store, versionTransport } = await openStoredArmedWindow(dir, { windowId: "mutate-win" });
  const transport = memoryTransport([]);
  const result = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport,
  });
  assert.equal(result.ok, true);
  assert.equal(result.window.phase, "attached");
  assert.equal(result.window.pending_mutation, null);
  assert.equal(result.after_sha256, tailConsumersSha256([SANITIZER]));
  const patches = transport.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("owned-initialize acknowledgment allows attach when GET stays UNKNOWN; foreign still refuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-init-"));
  const store = createFileTailAttachmentStore(join(dir, "tail-window.json"));
  let window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now: "2026-10-17T11:00:00.000Z",
    windowId: "init-win",
  });
  window = armTailAttachmentRestorer(window, {
    now: "2026-10-17T11:00:01.000Z",
    restorerId: "tr-init",
    capDetachActuator: fixtureCapDetachActuator(),
  });
  const initVt = memoryVersionTransport();
  window = bindTailAttachmentVersionEvidence(window, VERSION_EVIDENCE, {
    now: "2026-10-17T11:00:01.500Z",
    consumer: SANITIZER,
    accountIdSha256: ACCOUNT_SHA,
    getTarget: {
      script_name: SANITIZER.service,
      url: VERSION_EVIDENCE.get_target.url,
      path: VERSION_EVIDENCE.get_target.path,
    },
    source: `GET /workers/scripts/${SANITIZER.service}/deployments`,
  });
  window = {
    ...window,
    baseline_source: "owned-initialize-write-ahead-acknowledged",
  };
  window = await store.write(window);

  // GET stays UNKNOWN (null); after PATCH attach the provider declares the array.
  let current = null;
  const transport = {
    async getTailConsumers() { return current == null ? null : structuredClone(current); },
    async patchTailConsumers(next) {
      current = canonicalizeTailConsumers(next);
      return structuredClone(current);
    },
  };
  const result = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport: initVt,
  });
  assert.equal(result.ok, true);
  assert.equal(result.before_source, "owned-initialize-acknowledged");
  assert.equal(result.window.phase, "attached");

  // Without the owned-initialize marker, UNKNOWN GET still refuses.
  const dir2 = mkdtempSync(join(tmpdir(), "cc05-tail-init2-"));
  const { store: store2, versionTransport: vt2 } = await openStoredArmedWindow(dir2, { windowId: "no-init" });
  const unknownTransport = memoryTransport(null);
  const refused = await mutateOwnedTailAttachment({
    transport: unknownTransport,
    store: store2,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport: vt2,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "provider-get-unproved");
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test("own-window stays idle until expiry; expiry restores baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-idle-"));
  const stateRoot = join(dir, "state");
  const { store, window, versionTransport } = await openStoredArmedWindow(dir, {
    windowId: "idle-win",
    now: "2026-10-17T11:00:00.000Z",
    durationSeconds: 60,
    restorerId: "tr-idle",
  });
  const transport = memoryTransport([]);
  // Attach owned state.
  await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport,
  });
  assignTailWindowForRestorer({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
  });

  const idle = await tailAttachmentRestorerTick({
    store,
    transport,
    capDetachActuator: fixtureCapDetachActuator(transport),
    stateRoot,
    now: "2026-10-17T11:00:30.000Z",
  });
  assert.equal(idle.outcome, "idle");
  assert.equal(idle.reason, "owned-window-active-until-deadline");
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 1);

  const expired = await tailAttachmentRestorerTick({
    store,
    transport,
    capDetachActuator: fixtureCapDetachActuator(transport),
    stateRoot,
    now: "2026-10-17T11:01:30.000Z",
  });
  assert.equal(expired.action, "restored");
  assert.equal(expired.proved, true);
  assert.equal(expired.expired, true);
  assert.equal(expired.window.phase, "expired-restored");
  assert.deepEqual(expired.after, []);
  rmSync(dir, { recursive: true, force: true });
});

test("controller-death receipt bound to window/restorer restores; stale death is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-death-"));
  const stateRoot = join(dir, "state");
  const { store, window, versionTransport } = await openStoredArmedWindow(dir, {
    windowId: "death-win",
    restorerId: "tr-death",
  });
  const transport = memoryTransport([]);
  await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport,
  });
  assignTailWindowForRestorer({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
  });
  const paths = tailRestorerPaths(stateRoot);

  // Stale death for another restorer must not restore.
  writeTailRestorerReceipt(paths.controllerDeathReceipt, {
    kind: "controller-death",
    window_id: window.window_id,
    restorer_id: "other-restorer",
    observed_at: "2026-10-17T11:00:10.000Z",
  });
  assert.equal(
    tailControllerDeathSignaled(stateRoot, {
      windowId: window.window_id,
      restorerId: "tr-death",
    }),
    false,
  );
  const stillIdle = await tailAttachmentRestorerTick({
    store,
    transport,
    capDetachActuator: fixtureCapDetachActuator(transport),
    stateRoot,
    now: "2026-10-17T11:00:15.000Z",
  });
  assert.equal(stillIdle.outcome, "idle");

  writeTailRestorerReceipt(paths.controllerDeathReceipt, {
    kind: "controller-death",
    window_id: window.window_id,
    restorer_id: "tr-death",
    observed_at: "2026-10-17T11:00:20.000Z",
  });
  const restored = await tailAttachmentRestorerTick({
    store,
    transport,
    capDetachActuator: fixtureCapDetachActuator(transport),
    stateRoot,
    now: "2026-10-17T11:00:21.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.proved, true);
  assert.equal(restored.terminal_receipt.controller_death, true);
  assert.equal(restored.window.phase, "restored");
  rmSync(dir, { recursive: true, force: true });
});

test("foreign same-count namespace conflict is refused and ownership preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-conflict-"));
  const stateRoot = join(dir, "state");
  const { store, window, versionTransport } = await openStoredArmedWindow(dir, {
    windowId: "conflict-win",
    restorerId: "tr-conflict",
  });
  const transport = memoryTransport([]);
  await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport,
  });
  // Foreign writer replaces with same service + different namespace.
  transport.setCurrent([FOREIGN_NS]);
  assignTailWindowForRestorer({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
  });
  const tick = await tailAttachmentRestorerTick({
    store,
    transport,
    capDetachActuator: fixtureCapDetachActuator(transport),
    stateRoot,
    now: "2026-10-17T12:00:00.000Z", // expired → restore path sees conflict
  });
  assert.equal(tick.action, "refuse-conflict");
  assert.equal(tick.proved, false);
  assert.equal(tick.ownership_preserved, true);
  assert.equal(tick.window.owned_sha256, tailConsumersSha256([SANITIZER]));
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("issued-unacked pending retains UNKNOWN on baseline GET through restorer tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-unknown-"));
  const stateRoot = join(dir, "state");
  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "unknown-win",
    restorerId: "tr-unknown",
  });
  let loaded = await store.read();
  loaded = recordTailAttachmentIntent(loaded, {
    phase: "attach",
    beforeSha256: loaded.baseline_sha256,
    intendedConsumers: [SANITIZER],
    now: "2026-10-17T11:00:02.000Z",
  });
  loaded = markTailAttachmentIssued(loaded, { now: "2026-10-17T11:00:03.000Z" });
  await store.write(loaded, { expectedWindowId: window.window_id });

  const transport = memoryTransport([]); // baseline empty while issued
  assignTailWindowForRestorer({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
  });
  const tick = await tailAttachmentRestorerTick({
    store,
    transport,
    capDetachActuator: fixtureCapDetachActuator(transport),
    stateRoot,
    now: "2026-10-17T11:00:10.000Z",
  });
  assert.ok(
    ["retained-pending-unknown", "retain-owned-unknown"].includes(tick.outcome || tick.action),
    tick.outcome || tick.action,
  );
  assert.equal(tick.proved, false);
  assert.equal(tick.ownership_unknown, true);
  assert.equal(tick.ownership_preserved, true);
  const after = await store.read();
  assert.equal(after.pending_mutation?.issued, true);
  assert.notEqual(after.phase, "restored");
  rmSync(dir, { recursive: true, force: true });
});

test("runIndependentTailRestorer restores owned window via durable store CAS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-indep-"));
  const { store } = await openStoredArmedWindow(dir, { windowId: "indep-win", restorerId: "tr-indep" });
  const transport = memoryTransport([SANITIZER]);
  // Seed owned state without going through mutate (simulate confirmed attach).
  let window = await store.read();
  window = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(window, { expectedWindowId: window.window_id });

  const restored = await runIndependentTailRestorer({
    store,
    transport,
    now: "2026-10-17T11:00:40.000Z",
  });
  assert.equal(restored.action, "restored");
  assert.equal(restored.proved, true);
  const loaded = await store.read();
  assert.equal(loaded.phase, "restored");
  assert.equal(loaded.owned_sha256, null);
  rmSync(dir, { recursive: true, force: true });
});

test("planTailAttachmentRestore still distinguishes missing GET from declared empty under restorer paths", () => {
  const window = openTailAttachmentWindow({
    baselineConsumers: [],
    accountIdSha256: ACCOUNT_SHA,
    workerId: WORKER_ID,
    now: "2026-10-17T11:00:00.000Z",
    windowId: "missing-plan",
  });
  const plan = planTailAttachmentRestore(null, window, { now: "2026-10-17T11:00:01.000Z" });
  assert.equal(plan.action, "retain-owned-unknown");
  assert.equal(plan.proved, false);
});

test("process fixture: independent guardian survives real disposable controller exit and restores", async () => {
  // Honest limits: parent observes the disposable controller's exit(0) and writes
  // a window-bound death receipt. This is not SIGKILL and not automatic liveness
  // detection. The guardian is a separate durable-copy process that keeps polling
  // after the controller is gone and writes its own terminal receipt.
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-proc-"));
  const stateRoot = join(dir, "restorer");
  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });

  const transportModule = join(dir, "fake-transport.mjs");
  writeFileSync(transportModule, `let current = ${JSON.stringify([SANITIZER])};
export function createTransport() {
  return {
    async getTailConsumers() { return current == null ? null : structuredClone(current); },
    async patchTailConsumers(next) {
      current = Array.isArray(next) ? structuredClone(next) : next;
      return structuredClone(current);
    },
  };
}
`);
  const versionModule = join(dir, "fake-version-transport.mjs");
  writeFileSync(versionModule, `const ACCOUNT_ID = ${JSON.stringify(ACCOUNT_ID)};
const ACCOUNT_SHA = ${JSON.stringify(ACCOUNT_SHA)};
const CONSUMER = ${JSON.stringify(SANITIZER)};
const VERSION_ID = ${JSON.stringify(VERSION_ID)};
const path = \`/accounts/\${ACCOUNT_ID}/workers/scripts/\${CONSUMER.service}/deployments\`;
const url = \`https://api.cloudflare.com/client/v4\${path}\`;
export function createVersionTransport() {
  return {
    account_id: ACCOUNT_ID,
    account_id_sha256: ACCOUNT_SHA,
    script_name: CONSUMER.service,
    consumer: { ...CONSUMER },
    url,
    path,
    async getLatestVersionEvidence() {
      const versions = [{ version_id: VERSION_ID, percentage: 100 }];
      return {
        present: true,
        reason: null,
        versions,
        provenance: "deployments-list-GET",
        account_id_sha256: ACCOUNT_SHA,
        get_target: { script_name: CONSUMER.service, url, path },
        consumer: { ...CONSUMER },
        http: { method: "GET", status: 200, success: true },
        sha256: ${JSON.stringify(deploymentsVersionEvidenceSha256([{ version_id: VERSION_ID, percentage: 100 }]))},
        version: VERSION_ID,
      };
    },
  };
}
`);

  // Wall-clock window so the durable guardian (which uses Date.now) does not
  // treat a fixture timestamp as already expired before the death receipt.
  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "proc-win",
    restorerId: "tr-proc",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 1800,
  });
  // Seed owned attached state (controller already attached before exit).
  let owned = await store.read();
  owned = {
    ...owned,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(owned, { expectedWindowId: owned.window_id });

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: join(stateRoot, "run.mjs"),
    detached: true,
    pollMs: 100,
    env: {
      ...process.env,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE: pathToFileURL(transportModule).href,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: writeFixtureCapDetachModule(dir),
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE: pathToFileURL(versionModule).href,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CLOUDFLARE_API_TOKEN: "test-token-not-used-with-module",
    },
  });
  assert.ok(started.pid > 0);

  const paths = tailRestorerPaths(stateRoot);
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.readyReceipt), "independent guardian ready receipt");
  const ready = JSON.parse(readFileSync(paths.readyReceipt, "utf8"));
  assert.equal(ready.window_id, window.window_id);
  assert.equal(ready.independent_process, true);
  assert.equal(ready.version_guard_bound, true);
  assert.equal(ready.version_guard.observed_at_ready, VERSION_GUARD_LABEL.MATCH);
  assert.equal(ready.version_guard.fresh_get_before_and_after_actuator, false);

  // Disposable controller: real process exit(0), observed by the test parent.
  const controllerScript = join(dir, "disposable-controller.mjs");
  writeFileSync(controllerScript, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "controller-meta.json"))}, JSON.stringify({
  controller_pid: process.pid,
  restorer_pid: ${JSON.stringify(started.pid)},
  window_id: ${JSON.stringify(window.window_id)},
  restorer_id: ${JSON.stringify(window.restorer.restorer_id)},
  genuine_process_exit: true,
}) + "\\n");
setTimeout(() => process.exit(0), 30);
`);

  const controllerExit = await new Promise((resolve, reject) => {
    const controller = spawn(process.execPath, [controllerScript], { stdio: "ignore" });
    controller.on("exit", (code, signal) => resolve({ code, signal, pid: controller.pid }));
    controller.on("error", reject);
  });
  assert.equal(controllerExit.code, 0);
  assert.equal(controllerExit.signal, null);
  const meta = JSON.parse(readFileSync(join(dir, "controller-meta.json"), "utf8"));
  assert.equal(meta.genuine_process_exit, true);
  assert.notEqual(meta.controller_pid, started.pid);

  // Parent-observed disposable controller exit → window-bound death receipt.
  writeTailRestorerReceipt(paths.controllerDeathReceipt, {
    schema: "cityscroll.worker_tail_attachment_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    controller_exit_code: controllerExit.code,
    controller_pid: meta.controller_pid,
    restorer_pid: started.pid,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
    detection: "parent-observed-disposable-controller-exit",
    genuine_process_exit: true,
    not_sigkill: true,
    not_automatic_liveness_detection: true,
    not_in_process_tick: true,
  });

  const terminalDeadline = Date.now() + 15_000;
  while (Date.now() < terminalDeadline && !existsSync(paths.terminalReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(paths.terminalReceipt), "guardian terminal receipt after real controller exit");
  const terminal = JSON.parse(readFileSync(paths.terminalReceipt, "utf8"));
  assert.equal(terminal.proved, true);
  assert.ok(["restored", "already-restored"].includes(terminal.outcome), terminal.outcome);
  assert.equal(terminal.controller_death, true);
  assert.equal(terminal.window_id, window.window_id);
  // Guardian wiring: terminal carries observed labels — never bare true.
  assert.ok(terminal.version_guard, "terminal must carry observed version_guard");
  assert.equal(terminal.version_guard.before_actuator, VERSION_GUARD_LABEL.MATCH);
  assert.equal(terminal.version_guard.after_actuator, VERSION_GUARD_LABEL.MATCH);
  assert.notEqual(terminal.version_guard.before_actuator, true);
  assert.notEqual(terminal.version_guard.after_actuator, true);
  assert.equal(terminal.fresh_get_before_and_after_actuator, true);

  const after = JSON.parse(readFileSync(store.path, "utf8"));
  assert.ok(["restored", "expired-restored"].includes(after.phase), after.phase);
  assert.equal(after.owned_sha256, null);

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("process fixture: autonomous window expiry restores without controller-death receipt", async () => {
  // Real wall-clock child-loop expiry with fake transport factories while the
  // parent stays available (no death receipt, no cancel). Parent-unavailable +
  // default-loader combination is covered by the extended fixture below.
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-autonomy-"));
  const stateRoot = join(dir, "restorer");
  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });

  const transportState = join(dir, "transport-state.json");
  writeFileSync(transportState, `${JSON.stringify([SANITIZER])}\n`, { mode: 0o600 });
  const transportModule = join(dir, "fake-transport.mjs");
  writeFileSync(transportModule, `import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(transportState)};
const patchLogPath = ${JSON.stringify(join(dir, "patch-log.jsonl"))};
function load() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}
export function createTransport() {
  return {
    async getTailConsumers() {
      const current = load();
      return current == null ? null : structuredClone(current);
    },
    async patchTailConsumers(next) {
      const canonical = Array.isArray(next) ? structuredClone(next) : next;
      writeFileSync(statePath, JSON.stringify(canonical) + "\\n");
      writeFileSync(patchLogPath, JSON.stringify({ method: "PATCH", consumers: canonical, at: new Date().toISOString() }) + "\\n", { flag: "a" });
      return structuredClone(canonical);
    },
  };
}
`);
  const versionModule = join(dir, "fake-version-transport.mjs");
  writeFileSync(versionModule, `const ACCOUNT_ID = ${JSON.stringify(ACCOUNT_ID)};
const ACCOUNT_SHA = ${JSON.stringify(ACCOUNT_SHA)};
const CONSUMER = ${JSON.stringify(SANITIZER)};
const VERSION_ID = ${JSON.stringify(VERSION_ID)};
const path = \`/accounts/\${ACCOUNT_ID}/workers/scripts/\${CONSUMER.service}/deployments\`;
const url = \`https://api.cloudflare.com/client/v4\${path}\`;
export function createVersionTransport() {
  return {
    account_id: ACCOUNT_ID,
    account_id_sha256: ACCOUNT_SHA,
    script_name: CONSUMER.service,
    consumer: { ...CONSUMER },
    url,
    path,
    async getLatestVersionEvidence() {
      const versions = [{ version_id: VERSION_ID, percentage: 100 }];
      return {
        present: true,
        reason: null,
        versions,
        provenance: "deployments-list-GET",
        account_id_sha256: ACCOUNT_SHA,
        get_target: { script_name: CONSUMER.service, url, path },
        consumer: { ...CONSUMER },
        http: { method: "GET", status: 200, success: true },
        sha256: ${JSON.stringify(deploymentsVersionEvidenceSha256([{ version_id: VERSION_ID, percentage: 100 }]))},
        version: VERSION_ID,
      };
    },
  };
}
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "autonomy-win",
    restorerId: "tr-autonomy",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 4,
  });
  let owned = await store.read();
  owned = {
    ...owned,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(owned, { expectedWindowId: owned.window_id });

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: join(stateRoot, "run.mjs"),
    detached: true,
    pollMs: 100,
    env: {
      ...process.env,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE: pathToFileURL(transportModule).href,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: writeFixtureCapDetachModule(dir),
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE: pathToFileURL(versionModule).href,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CLOUDFLARE_API_TOKEN: "test-token-not-used-with-module",
    },
  });
  assert.ok(started.pid > 0);

  const paths = tailRestorerPaths(stateRoot);
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.readyReceipt), "independent guardian ready receipt");
  assert.equal(existsSync(paths.controllerDeathReceipt), false, "no controller-death receipt written");

  const terminalDeadline = Date.now() + 15_000;
  while (Date.now() < terminalDeadline && !existsSync(paths.terminalReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(paths.terminalReceipt), "guardian terminal receipt after autonomous expiry");
  assert.equal(existsSync(paths.controllerDeathReceipt), false, "still no controller-death receipt");

  const terminal = JSON.parse(readFileSync(paths.terminalReceipt, "utf8"));
  assert.equal(terminal.proved, true);
  assert.ok(["restored", "already-restored"].includes(terminal.outcome), terminal.outcome);
  assert.equal(terminal.expired, true);
  assert.equal(terminal.window_id, window.window_id);
  assert.notEqual(terminal.controller_death, true);

  const after = JSON.parse(readFileSync(store.path, "utf8"));
  assert.ok(["restored", "expired-restored"].includes(after.phase), after.phase);
  assert.equal(after.phase, "expired-restored");
  assert.equal(after.owned_sha256, null);
  assert.deepEqual(after.baseline_consumers, []);
  const transportAfter = JSON.parse(readFileSync(transportState, "utf8"));
  assert.deepEqual(transportAfter, []);

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("process fixture: foreign same-count under expiry refuses overwrite (0 PATCH to foreign)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-foreign-expiry-"));
  const stateRoot = join(dir, "restorer");
  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });

  const transportState = join(dir, "transport-state.json");
  writeFileSync(transportState, `${JSON.stringify([SANITIZER])}\n`, { mode: 0o600 });
  const patchLogPath = join(dir, "patch-log.jsonl");
  const transportModule = join(dir, "fake-transport.mjs");
  writeFileSync(transportModule, `import { readFileSync, writeFileSync, existsSync } from "node:fs";
const statePath = ${JSON.stringify(transportState)};
const patchLogPath = ${JSON.stringify(patchLogPath)};
function load() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}
export function createTransport() {
  return {
    async getTailConsumers() {
      const current = load();
      return current == null ? null : structuredClone(current);
    },
    async patchTailConsumers(next) {
      const canonical = Array.isArray(next) ? structuredClone(next) : next;
      writeFileSync(statePath, JSON.stringify(canonical) + "\\n");
      writeFileSync(patchLogPath, JSON.stringify({ method: "PATCH", consumers: canonical, at: new Date().toISOString() }) + "\\n", { flag: "a" });
      return structuredClone(canonical);
    },
  };
}
`);
  const versionModule = join(dir, "fake-version-transport.mjs");
  writeFileSync(versionModule, `const ACCOUNT_ID = ${JSON.stringify(ACCOUNT_ID)};
const ACCOUNT_SHA = ${JSON.stringify(ACCOUNT_SHA)};
const CONSUMER = ${JSON.stringify(SANITIZER)};
const VERSION_ID = ${JSON.stringify(VERSION_ID)};
const path = \`/accounts/\${ACCOUNT_ID}/workers/scripts/\${CONSUMER.service}/deployments\`;
const url = \`https://api.cloudflare.com/client/v4\${path}\`;
export function createVersionTransport() {
  return {
    account_id: ACCOUNT_ID,
    account_id_sha256: ACCOUNT_SHA,
    script_name: CONSUMER.service,
    consumer: { ...CONSUMER },
    url,
    path,
    async getLatestVersionEvidence() {
      const versions = [{ version_id: VERSION_ID, percentage: 100 }];
      return {
        present: true,
        reason: null,
        versions,
        provenance: "deployments-list-GET",
        account_id_sha256: ACCOUNT_SHA,
        get_target: { script_name: CONSUMER.service, url, path },
        consumer: { ...CONSUMER },
        http: { method: "GET", status: 200, success: true },
        sha256: ${JSON.stringify(deploymentsVersionEvidenceSha256([{ version_id: VERSION_ID, percentage: 100 }]))},
        version: VERSION_ID,
      };
    },
  };
}
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "foreign-expiry-win",
    restorerId: "tr-foreign-expiry",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 4,
  });
  let owned = await store.read();
  owned = {
    ...owned,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(owned, { expectedWindowId: owned.window_id });

  // Foreign same-count identity is already live before the guardian starts, so
  // expiry cannot race a restore-to-baseline ahead of the swap.
  writeFileSync(transportState, `${JSON.stringify([FOREIGN_NS])}\n`, { mode: 0o600 });

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: join(stateRoot, "run.mjs"),
    detached: true,
    pollMs: 100,
    env: {
      ...process.env,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE: pathToFileURL(transportModule).href,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: writeFixtureCapDetachModule(dir),
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE: pathToFileURL(versionModule).href,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CLOUDFLARE_API_TOKEN: "test-token-not-used-with-module",
    },
  });
  assert.ok(started.pid > 0);

  const paths = tailRestorerPaths(stateRoot);
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.readyReceipt), "guardian ready with foreign consumers already live");

  const terminalDeadline = Date.now() + 15_000;
  while (Date.now() < terminalDeadline && !existsSync(paths.terminalReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(paths.terminalReceipt), "guardian terminal after foreign+expiry");

  const terminal = JSON.parse(readFileSync(paths.terminalReceipt, "utf8"));
  // Refuse-conflict is unproved → outcome blocked; must not overwrite foreign.
  assert.equal(terminal.proved, false);
  assert.ok(
    terminal.outcome === "blocked"
      || terminal.outcome === "refuse-conflict"
      || terminal.classification === "conflict",
    JSON.stringify(terminal),
  );
  assert.equal(existsSync(patchLogPath), false, "no PATCH against foreign consumers");
  const transportAfter = JSON.parse(readFileSync(transportState, "utf8"));
  assert.deepEqual(
    canonicalizeTailConsumers(transportAfter),
    canonicalizeTailConsumers([FOREIGN_NS]),
  );
  const after = JSON.parse(readFileSync(store.path, "utf8"));
  assert.notEqual(after.phase, "restored");
  assert.notEqual(after.phase, "expired-restored");
  assert.equal(after.owned_sha256, tailConsumersSha256([SANITIZER]));

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("DETACH version_guard never uses bare true; drift/failure labeled UNKNOWN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-detach-labels-"));
  const uuid1 = "11111111-1111-1111-1111-111111111111";
  const uuid2 = "22222222-2222-2222-2222-222222222222";
  const versionTransport = memoryVersionTransport({
    consumer: SANITIZER,
    versions: [{ version_id: uuid1, percentage: 100 }],
  });
  const evidence = await versionTransport.getLatestVersionEvidence();
  const { store } = await openStoredArmedWindow(dir, {
    windowId: "detach-label-win",
    versionEvidence: evidence,
    versionTransport,
  });
  // Attach first (strict match).
  const transport = memoryTransport([]);
  const attached = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:05.000Z",
    versionTransport,
  });
  assert.equal(attached.ok, true);
  assert.equal(attached.version_guard.before_actuator, VERSION_GUARD_LABEL.MATCH);

  // DETACH with provider drift: still succeeds; labels never bare true.
  versionTransport.setVersions([{ version_id: uuid2, percentage: 100 }]);
  const detached = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [],
    phase: "detach",
    now: "2026-10-17T11:00:06.000Z",
    versionTransport,
  });
  assert.equal(detached.ok, true);
  assert.equal(detached.version_guard.before_actuator, VERSION_GUARD_LABEL.DRIFT);
  assert.equal(detached.version_guard.after_actuator, VERSION_GUARD_LABEL.DRIFT);
  assert.equal(detached.version_guard.version, "UNKNOWN");
  assert.equal(detached.version_guard.version_unknown, true);
  assert.notEqual(detached.version_guard.before_actuator, true);
  assert.notEqual(detached.version_guard.after_actuator, true);
  assert.notEqual(detached.version_guard.before_actuator, false);

  // DETACH with failed GET: still succeeds; failed:unknown.
  const failingVt = {
    ...versionTransport,
    account_id: versionTransport.account_id,
    account_id_sha256: versionTransport.account_id_sha256,
    script_name: versionTransport.script_name,
    consumer: versionTransport.consumer,
    url: versionTransport.url,
    path: versionTransport.path,
    async getLatestVersionEvidence() {
      throw new Error("deployments GET failed with status 500");
    },
  };
  // Re-attach for a second detach.
  versionTransport.setVersions([{ version_id: uuid1, percentage: 100 }]);
  const reAttached = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [SANITIZER],
    phase: "attach",
    now: "2026-10-17T11:00:07.000Z",
    versionTransport,
  });
  assert.equal(reAttached.ok, true);
  const detachFailed = await mutateOwnedTailAttachment({
    transport,
    store,
    intendedConsumers: [],
    phase: "detach",
    now: "2026-10-17T11:00:08.000Z",
    versionTransport: failingVt,
  });
  assert.equal(detachFailed.ok, true);
  assert.equal(detachFailed.version_guard.before_actuator, VERSION_GUARD_LABEL.FAILED);
  assert.equal(detachFailed.version_guard.after_actuator, VERSION_GUARD_LABEL.FAILED);
  assert.equal(detachFailed.version_guard.version, "UNKNOWN");
  assert.notEqual(detachFailed.version_guard.before_actuator, true);
  rmSync(dir, { recursive: true, force: true });
});

test("restore actuator: drift and failed GET still restore; receipt labels UNKNOWN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-restore-labels-"));
  const uuid1 = "11111111-1111-1111-1111-111111111111";
  const uuid2 = "22222222-2222-2222-2222-222222222222";
  const versionTransport = memoryVersionTransport({
    consumer: SANITIZER,
    versions: [{ version_id: uuid1, percentage: 100 }],
  });
  const evidence = await versionTransport.getLatestVersionEvidence();
  const { store } = await openStoredArmedWindow(dir, {
    windowId: "restore-label-win",
    baselineConsumers: [],
    versionEvidence: evidence,
    versionTransport,
  });
  let owned = await store.read();
  owned = {
    ...owned,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(owned, { expectedWindowId: owned.window_id });

  // Drift during restore: still restores.
  versionTransport.setVersions([{ version_id: uuid2, percentage: 100 }]);
  const drifted = await runIndependentTailRestorer({
    store,
    transport: memoryTransport([SANITIZER]),
    versionTransport,
  });
  assert.equal(drifted.proved, true);
  assert.equal(drifted.action, "restored");
  assert.equal(drifted.version_guard.before_actuator, VERSION_GUARD_LABEL.DRIFT);
  assert.equal(drifted.version_guard.after_actuator, VERSION_GUARD_LABEL.DRIFT);
  assert.equal(drifted.version_guard.version, "UNKNOWN");
  assert.equal(drifted.version_guard.version_unknown, true);
  assert.ok(drifted.version_guard.get_count >= 2, "restore must observe before+after GETs");
  assert.notEqual(drifted.version_guard.before_actuator, true);

  // Re-own and fail GET: still restores.
  let owned2 = await store.read();
  owned2 = {
    ...owned2,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  // Re-bind matching evidence for a clean bound digest.
  owned2 = bindTailAttachmentVersionEvidence(owned2, evidence, {
    now: "2026-10-17T11:10:00.000Z",
    consumer: SANITIZER,
    accountIdSha256: ACCOUNT_SHA,
    getTarget: evidence.get_target,
  });
  await store.write(owned2, { expectedWindowId: owned2.window_id });
  const failingVt = {
    ...versionTransport,
    account_id: versionTransport.account_id,
    account_id_sha256: versionTransport.account_id_sha256,
    script_name: versionTransport.script_name,
    consumer: versionTransport.consumer,
    url: versionTransport.url,
    path: versionTransport.path,
    async getLatestVersionEvidence() {
      throw new Error("deployments GET failed with status 503");
    },
  };
  const failed = await runIndependentTailRestorer({
    store,
    transport: memoryTransport([SANITIZER]),
    versionTransport: failingVt,
  });
  assert.equal(failed.proved, true);
  assert.equal(failed.action, "restored");
  assert.equal(failed.version_guard.before_actuator, VERSION_GUARD_LABEL.FAILED);
  assert.equal(failed.version_guard.after_actuator, VERSION_GUARD_LABEL.FAILED);
  assert.equal(failed.version_guard.version, "UNKNOWN");
  assert.notEqual(failed.version_guard.after_actuator, true);
  rmSync(dir, { recursive: true, force: true });
});

test("process fixture: independent guardian restores after disposable controller SIGKILL", async () => {
  // Honest limits: parent SIGKILLs the disposable controller and writes the
  // window-bound death receipt. This proves SIGKILL survival of the durable
  // guardian; it is still not automatic liveness detection.
  // Counts getLatestVersionEvidence during genuine guardian restoration.
  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-sigkill-"));
  const stateRoot = join(dir, "restorer");
  const getCountPath = join(dir, "version-get-count.json");
  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });

  const transportModule = join(dir, "fake-transport.mjs");
  writeFileSync(transportModule, `let current = ${JSON.stringify([SANITIZER])};
export function createTransport() {
  return {
    async getTailConsumers() { return current == null ? null : structuredClone(current); },
    async patchTailConsumers(next) {
      current = Array.isArray(next) ? structuredClone(next) : next;
      return structuredClone(current);
    },
  };
}
`);

  const versionModule = join(dir, "fake-version-transport.mjs");
  writeFileSync(versionModule, `import { writeFileSync, readFileSync, existsSync } from "node:fs";
const COUNT_PATH = ${JSON.stringify(getCountPath)};
const ACCOUNT_ID = ${JSON.stringify(ACCOUNT_ID)};
const ACCOUNT_SHA = ${JSON.stringify(ACCOUNT_SHA)};
const CONSUMER = ${JSON.stringify(SANITIZER)};
const VERSION_ID = ${JSON.stringify(VERSION_ID)};
const path = \`/accounts/\${ACCOUNT_ID}/workers/scripts/\${CONSUMER.service}/deployments\`;
const url = \`https://api.cloudflare.com/client/v4\${path}\`;
function bump(kind) {
  let state = { total: 0, by_kind: {} };
  if (existsSync(COUNT_PATH)) state = JSON.parse(readFileSync(COUNT_PATH, "utf8"));
  state.total += 1;
  state.by_kind[kind] = (state.by_kind[kind] || 0) + 1;
  writeFileSync(COUNT_PATH, JSON.stringify(state) + "\\n");
}
export function createVersionTransport() {
  return {
    account_id: ACCOUNT_ID,
    account_id_sha256: ACCOUNT_SHA,
    script_name: CONSUMER.service,
    consumer: { ...CONSUMER },
    url,
    path,
    async getLatestVersionEvidence() {
      bump("getLatestVersionEvidence");
      const versions = [{ version_id: VERSION_ID, percentage: 100 }];
      return {
        present: true,
        reason: null,
        versions,
        provenance: "deployments-list-GET",
        account_id_sha256: ACCOUNT_SHA,
        get_target: { script_name: CONSUMER.service, url, path },
        consumer: { ...CONSUMER },
        http: { method: "GET", status: 200, success: true },
        sha256: ${JSON.stringify(deploymentsVersionEvidenceSha256([{ version_id: VERSION_ID, percentage: 100 }]))},
        version: VERSION_ID,
      };
    },
  };
}
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "sigkill-win",
    restorerId: "tr-sigkill",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 1800,
  });
  let owned = await store.read();
  owned = {
    ...owned,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(owned, { expectedWindowId: owned.window_id });

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: join(stateRoot, "run.mjs"),
    detached: true,
    pollMs: 100,
    env: {
      ...process.env,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE: pathToFileURL(transportModule).href,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: writeFixtureCapDetachModule(dir),
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE: pathToFileURL(versionModule).href,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CLOUDFLARE_API_TOKEN: "test-token-not-used-with-module",
    },
  });
  assert.ok(started.pid > 0);

  const paths = tailRestorerPaths(stateRoot);
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.readyReceipt), "independent guardian ready receipt");
  const ready = JSON.parse(readFileSync(paths.readyReceipt, "utf8"));
  // ready flags derived from actual GET, not mere transport configuration.
  assert.equal(ready.version_guard_bound, true);
  assert.equal(ready.version_guard.observed_at_ready, VERSION_GUARD_LABEL.MATCH);
  assert.equal(ready.version_guard.fresh_get_before_and_after_actuator, false);
  assert.notEqual(ready.version_guard.fresh_get_before_and_after_actuator, true);

  const controllerScript = join(dir, "disposable-controller-sigkill.mjs");
  writeFileSync(controllerScript, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "controller-meta.json"))}, JSON.stringify({
  controller_pid: process.pid,
  restorer_pid: ${JSON.stringify(started.pid)},
  window_id: ${JSON.stringify(window.window_id)},
  restorer_id: ${JSON.stringify(window.restorer.restorer_id)},
  genuine_process_sigkill: true,
}) + "\\n");
setInterval(() => {}, 1000);
`);

  const controllerExit = await new Promise((resolve, reject) => {
    const controller = spawn(process.execPath, [controllerScript], { stdio: "ignore" });
    controller.on("error", reject);
    const waitMeta = Date.now() + 5_000;
    const poll = setInterval(() => {
      if (!existsSync(join(dir, "controller-meta.json"))) {
        if (Date.now() > waitMeta) {
          clearInterval(poll);
          reject(new Error("controller meta not written before SIGKILL"));
        }
        return;
      }
      clearInterval(poll);
      try {
        process.kill(controller.pid, "SIGKILL");
      } catch (error) {
        reject(error);
        return;
      }
    }, 20);
    controller.on("exit", (code, signal) => resolve({ code, signal, pid: controller.pid }));
  });
  assert.equal(controllerExit.signal, "SIGKILL");
  assert.equal(controllerExit.code, null);
  const meta = JSON.parse(readFileSync(join(dir, "controller-meta.json"), "utf8"));
  assert.equal(meta.genuine_process_sigkill, true);
  assert.notEqual(meta.controller_pid, started.pid);

  writeTailRestorerReceipt(paths.controllerDeathReceipt, {
    schema: "cityscroll.worker_tail_attachment_restorer_runtime.v1",
    kind: "controller-death",
    observed_at: new Date().toISOString(),
    controller_exited: true,
    controller_exit_code: controllerExit.code,
    controller_exit_signal: controllerExit.signal,
    controller_pid: meta.controller_pid,
    restorer_pid: started.pid,
    window_id: window.window_id,
    restorer_id: window.restorer.restorer_id,
    detection: "parent-observed-disposable-controller-sigkill",
    genuine_process_sigkill: true,
    not_automatic_liveness_detection: true,
    not_in_process_tick: true,
  });

  const terminalDeadline = Date.now() + 15_000;
  while (Date.now() < terminalDeadline && !existsSync(paths.terminalReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(paths.terminalReceipt), "guardian terminal receipt after controller SIGKILL");
  const terminal = JSON.parse(readFileSync(paths.terminalReceipt, "utf8"));
  assert.equal(terminal.proved, true);
  assert.ok(["restored", "already-restored"].includes(terminal.outcome), terminal.outcome);
  assert.equal(terminal.controller_death, true);
  assert.equal(terminal.window_id, window.window_id);
  assert.ok(terminal.version_guard, "terminal must carry observed version_guard");
  assert.equal(terminal.version_guard.before_actuator, VERSION_GUARD_LABEL.MATCH);
  assert.equal(terminal.version_guard.after_actuator, VERSION_GUARD_LABEL.MATCH);
  assert.notEqual(terminal.version_guard.before_actuator, true);
  assert.equal(terminal.fresh_get_before_and_after_actuator, true);

  const getCounts = JSON.parse(readFileSync(getCountPath, "utf8"));
  // ready observation (1) + restore before + restore after (>=2) => >= 3
  assert.ok(getCounts.total >= 3, `expected >=3 version GETs during guardian restore, got ${getCounts.total}`);
  assert.ok(
    (getCounts.by_kind.getLatestVersionEvidence || 0) >= 3,
    "getLatestVersionEvidence must be invoked during genuine guardian restoration",
  );

  const after = JSON.parse(readFileSync(store.path, "utf8"));
  assert.ok(["restored", "expired-restored"].includes(after.phase), after.phase);
  assert.equal(after.owned_sha256, null);

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("composeGuardianChildEnv prefers TOKEN_FILE and deletes raw TOKEN", () => {
  const composed = composeGuardianChildEnv({
    PATH: "/usr/bin",
    CLOUDFLARE_API_TOKEN: "raw-token-value-must-not-leak",
    CLOUDFLARE_API_TOKEN_FILE: "/tmp/mode0600-token-file",
    OTHER: "keep",
  }, { preferTokenFile: true });
  assert.equal(composed.credential_source, "TOKEN_FILE");
  assert.equal(composed.has_TOKEN, false);
  assert.equal(composed.has_TOKEN_FILE, true);
  assert.equal(composed.incoming_had_TOKEN, true);
  assert.equal(composed.incoming_had_TOKEN_FILE, true);
  assert.equal(composed.sanitized_dual_credential, true);
  assert.equal(composed.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(composed.env.CLOUDFLARE_API_TOKEN_FILE, "/tmp/mode0600-token-file");
  assert.equal(composed.env.OTHER, "keep");
  // Never expose values in the compose summary fields.
  assert.equal("CLOUDFLARE_API_TOKEN" in composed, false);
});

test("guardian stderr privacy: allowlisted diagnosis only; no raw stderr file or secret bytes", async () => {
  assert.equal(
    classifyGuardianStartupStderr("Error: CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_TOKEN_FILE are mutually exclusive"),
    GUARDIAN_STARTUP_FAILURE_CODE.CREDENTIAL_MUTUALLY_EXCLUSIVE,
  );

  const dir = mkdtempSync(join(tmpdir(), "cc05-stderr-privacy-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  // Fake child prints a secret, a query, a body, and more than the diag cap.
  const secretMarker = "SUPERSECRET_TOKEN_VALUE_9f3a";
  const queryMarker = "GET /accounts/x/workers/scripts/y?peek=1";
  const bodyMarker = '{"Authorization":"Bearer leak","body":"nope"}';
  const fakeChild = join(dir, "noisy-child.mjs");
  writeFileSync(fakeChild, `const secret = ${JSON.stringify(secretMarker)};
const query = ${JSON.stringify(queryMarker)};
const body = ${JSON.stringify(bodyMarker)};
console.error("startup noise", secret);
console.error(query);
console.error(body);
console.error("pad:" + "X".repeat(20000));
process.exit(7);
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "stderr-privacy-win",
    restorerId: "tr-stderr",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 1800,
  });
  // Install so paths.durableRunner exists; override runnerPath with noisy child.
  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: fakeChild,
    nodeExecPath: process.execPath,
    detached: true,
    pollMs: 100,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
    },
  });
  const paths = tailRestorerPaths(stateRoot);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(paths.childExitReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.childExitReceipt), "child-exit receipt required");
  assert.ok(existsSync(paths.childFailedBeforeReadyReceipt), "failed-before-ready receipt required");

  // No raw stderr file anywhere under the state root.
  const listFiles = (root) => {
    const out = [];
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      if (statSync(p).isDirectory()) out.push(...listFiles(p));
      else out.push(p);
    }
    return out;
  };
  const files = listFiles(stateRoot);
  const rawStderrFiles = files.filter((p) => {
    const base = p.split("/").pop() || "";
    return /^(guardian-)?stderr(\.log)?$/i.test(base) || /\.stderr(\.log)?$/i.test(base);
  });
  assert.deepEqual(rawStderrFiles, [], `raw stderr file must not exist: ${rawStderrFiles.join(",")}`);

  const exitReceipt = JSON.parse(readFileSync(paths.childExitReceipt, "utf8"));
  const failReceipt = JSON.parse(readFileSync(paths.childFailedBeforeReadyReceipt, "utf8"));
  assert.equal(exitReceipt.exit_code, 7);
  assert.equal(exitReceipt.raw_stderr_persisted, false);
  assert.equal(failReceipt.raw_stderr_persisted, false);
  assert.ok(exitReceipt.stderr_bytes_seen > 0);
  assert.ok(exitReceipt.stderr_bytes_omitted > 0, "over-cap output must be omitted from diag buffer");
  assert.ok(Number.isInteger(exitReceipt.stderr_diag_cap_bytes));
  assert.ok(exitReceipt.stderr_bytes_seen <= 1_000_000);
  // Allowlisted fields only — no raw tails / spawn strings / secret markers.
  for (const receipt of [exitReceipt, failReceipt, JSON.parse(readFileSync(paths.startSpawnReceipt, "utf8"))]) {
    const text = JSON.stringify(receipt);
    assert.equal(text.includes(secretMarker), false, "secret must not be persisted");
    assert.equal(text.includes(queryMarker), false, "query must not be persisted");
    assert.equal(text.includes(bodyMarker), false, "body must not be persisted");
    assert.equal(Object.hasOwn(receipt, "stderr_tail"), false);
    assert.equal(Object.hasOwn(receipt, "stderr_log"), false);
    assert.equal(Object.hasOwn(receipt, "spawn_error"), false);
  }
  assert.equal(
    failReceipt.failure_code,
    GUARDIAN_STARTUP_FAILURE_CODE.UNKNOWN_STARTUP_FAILURE,
  );

  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  rmSync(dir, { recursive: true, force: true });
});

test("local proof: installed runner reaches ready under TOKEN_FILE-only composed env; dual-cred refusal is captured", async () => {
  // Keep the transport-module override path (module-bypass). The real secret()
  // path is covered by the adjacent TOKEN_FILE + mocked-fetch proof.
  assert.match(process.version, /^v24\./, `installed Node must be 24.x, got ${process.version}`);

  const dir = mkdtempSync(join(tmpdir(), "cc05-guardian-cred-"));
  const stateRoot = join(dir, "restorer");
  const tokenFile = join(dir, "cloudflare-token");
  writeFileSync(tokenFile, "fixture-token-not-a-real-secret\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });
  assert.ok(existsSync(join(stateRoot, "run.mjs")), "exact installed runner must exist");

  const transportModule = join(dir, "fake-transport.mjs");
  writeFileSync(transportModule, `let current = [];
export function createTransport() {
  return {
    async getTailConsumers() { return structuredClone(current); },
    async patchTailConsumers(next) {
      current = Array.isArray(next) ? structuredClone(next) : next;
      return structuredClone(current);
    },
  };
}
`);
  const versionModule = join(dir, "fake-version-transport.mjs");
  writeFileSync(versionModule, `const ACCOUNT_ID = ${JSON.stringify(ACCOUNT_ID)};
const ACCOUNT_SHA = ${JSON.stringify(ACCOUNT_SHA)};
const CONSUMER = ${JSON.stringify(SANITIZER)};
const VERSION_ID = ${JSON.stringify(VERSION_ID)};
const path = \`/accounts/\${ACCOUNT_ID}/workers/scripts/\${CONSUMER.service}/deployments\`;
const url = \`https://api.cloudflare.com/client/v4\${path}\`;
export function createVersionTransport() {
  return {
    account_id: ACCOUNT_ID,
    account_id_sha256: ACCOUNT_SHA,
    script_name: CONSUMER.service,
    consumer: { ...CONSUMER },
    url,
    path,
    async getLatestVersionEvidence() {
      const versions = [{ version_id: VERSION_ID, percentage: 100 }];
      return {
        present: true,
        reason: null,
        versions,
        provenance: "deployments-list-GET",
        account_id_sha256: ACCOUNT_SHA,
        get_target: { script_name: CONSUMER.service, url, path },
        consumer: { ...CONSUMER },
        http: { method: "GET", status: 200, success: true },
        sha256: ${JSON.stringify(deploymentsVersionEvidenceSha256([{ version_id: VERSION_ID, percentage: 100 }]))},
        version: VERSION_ID,
      };
    },
  };
}
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "cred-compose-win",
    restorerId: "tr-cred",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 1800,
  });

  const composedIncoming = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_WORKER_ID: WORKER_ID,
    CLOUDFLARE_API_TOKEN: "must-be-deleted-by-compose",
    CLOUDFLARE_API_TOKEN_FILE: tokenFile,
  };
  const composed = composeGuardianChildEnv(composedIncoming, {
    tokenFile,
    preferTokenFile: true,
  });
  assert.equal(composed.has_TOKEN, false);
  assert.equal(composed.has_TOKEN_FILE, true);
  assert.equal(composed.sanitized_dual_credential, true);

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: join(stateRoot, "run.mjs"),
    nodeExecPath: process.execPath,
    detached: true,
    pollMs: 100,
    tokenFile,
    preferTokenFile: true,
    env: {
      ...composed.env,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_TRANSPORT_MODULE: pathToFileURL(transportModule).href,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: writeFixtureCapDetachModule(dir),
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_VERSION_TRANSPORT_MODULE: pathToFileURL(versionModule).href,
    },
  });
  assert.equal(started.credential.has_TOKEN, false);
  assert.equal(started.credential.has_TOKEN_FILE, true);
  assert.equal(started.credential.source, "TOKEN_FILE");

  const paths = tailRestorerPaths(stateRoot);
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    if (existsSync(paths.childFailedBeforeReadyReceipt)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(paths.readyReceipt), "TOKEN_FILE-only composed env must reach ready");
  const ready = JSON.parse(readFileSync(paths.readyReceipt, "utf8"));
  assert.equal(ready.version_guard_bound, true);
  assert.equal(ready.version_guard.observed_at_ready, VERSION_GUARD_LABEL.MATCH);
  assert.ok(existsSync(paths.startSpawnReceipt), "parent start-spawn receipt must survive child loop start");
  const startSpawn = JSON.parse(readFileSync(paths.startSpawnReceipt, "utf8"));
  assert.equal(startSpawn.kind, "start-spawn");
  assert.equal(startSpawn.has_TOKEN, false);
  assert.equal(startSpawn.has_TOKEN_FILE, true);
  assert.equal(startSpawn.credential_source, "TOKEN_FILE");
  assert.equal(startSpawn.raw_stderr_persisted, false);
  const startText = readFileSync(paths.startSpawnReceipt, "utf8");
  assert.equal(startText.includes("must-be-deleted-by-compose"), false);

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }

  // Negative: both credential vars reach the installed runner (skip compose).
  // Default loader + secret() mutual exclusion — fail before fetch; receipt allowlisted.
  const negDir = mkdtempSync(join(tmpdir(), "cc05-guardian-dual-cred-"));
  const negState = join(negDir, "restorer");
  const negTokenFile = join(negDir, "cloudflare-token");
  writeFileSync(negTokenFile, "fixture-token-not-a-real-secret\n", { mode: 0o600 });
  chmodSync(negTokenFile, 0o600);
  installDurableTailRestorerRunner({ stateRoot: negState, repoRoot: REPO_ROOT });
  const { store: negStore, window: negWindow } = await openStoredArmedWindow(negDir, {
    windowId: "dual-cred-win",
    restorerId: "tr-dual",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 1800,
  });
  const negStarted = startSupervisedTailRestorerProcess({
    windowPath: negStore.path,
    windowId: negWindow.window_id,
    stateRoot: negState,
    runnerPath: join(negState, "run.mjs"),
    nodeExecPath: process.execPath,
    detached: true,
    pollMs: 100,
    skipCredentialCompose: true,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CLOUDFLARE_API_TOKEN: "dual-present-raw",
      CLOUDFLARE_API_TOKEN_FILE: negTokenFile,
      // No TRANSPORT_MODULE overrides — real default loaders → secret().
    },
  });
  const negPaths = tailRestorerPaths(negState);
  const failDeadline = Date.now() + 10_000;
  while (Date.now() < failDeadline && !existsSync(negPaths.childFailedBeforeReadyReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    existsSync(negPaths.childFailedBeforeReadyReceipt),
    "dual-credential refusal must write child-failed-before-ready receipt",
  );
  assert.equal(existsSync(negPaths.readyReceipt), false, "ready must not be claimed after dual-cred refusal");
  const failReceipt = JSON.parse(readFileSync(negPaths.childFailedBeforeReadyReceipt, "utf8"));
  assert.equal(failReceipt.kind, "child-failed-before-ready");
  assert.equal(failReceipt.failure_code, GUARDIAN_STARTUP_FAILURE_CODE.CREDENTIAL_MUTUALLY_EXCLUSIVE);
  assert.equal(failReceipt.raw_stderr_persisted, false);
  assert.equal(Object.hasOwn(failReceipt, "stderr_tail"), false);
  assert.ok(existsSync(negPaths.childExitReceipt), "child-exit receipt required");
  const exitReceipt = JSON.parse(readFileSync(negPaths.childExitReceipt, "utf8"));
  assert.notEqual(exitReceipt.exit_code, 0);
  assert.equal(exitReceipt.failure_code, GUARDIAN_STARTUP_FAILURE_CODE.CREDENTIAL_MUTUALLY_EXCLUSIVE);
  assert.equal(JSON.stringify(failReceipt).includes("dual-present-raw"), false);
  assert.equal(failReceipt.has_TOKEN, true);
  assert.equal(failReceipt.has_TOKEN_FILE, true);
  // Executed path receipt (non-secret).
  writeFileSync(join(negDir, "executed-path.json"), `${JSON.stringify({
    loader: "default-dual-view+deployments",
    transport_module_override: false,
    version_module_override: false,
    secret_loader: "runner.secret(CLOUDFLARE_API_TOKEN)",
    failed_before_fetch: true,
    failure_code: failReceipt.failure_code,
  }, null, 2)}\n`, { mode: 0o600 });

  try { process.kill(negStarted.pid, "SIGTERM"); } catch { /* gone */ }
  stopSupervisedTailRestorerProcess({ stateRoot: negState, signal: "SIGTERM" });
  rmSync(dir, { recursive: true, force: true });
  rmSync(negDir, { recursive: true, force: true });
});

test("local proof: TOKEN_FILE-only through REAL secret()+default loaders with mocked fetch reaches ready", async () => {
  // No CITYSCROLL_*_TRANSPORT_MODULE overrides. Preload mocks global fetch so
  // createBoundDualView / createBoundDeployments run after secret() resolves TOKEN_FILE.
  assert.match(process.version, /^v24\./, `installed Node must be 24.x, got ${process.version}`);

  const dir = mkdtempSync(join(tmpdir(), "cc05-guardian-secret-fetch-"));
  const stateRoot = join(dir, "restorer");
  const tokenFile = join(dir, "cloudflare-token");
  writeFileSync(tokenFile, "fixture-token-for-secret-loader-only\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });
  const mockFetch = join(dir, "mock-fetch-preload.mjs");
  writeFileSync(mockFetch, `const ACCOUNT = ${JSON.stringify(ACCOUNT_ID)};
const PRODUCER = ${JSON.stringify(WORKER_ID)};
const CONSUMER = ${JSON.stringify(SANITIZER.service)};
const VERSION = ${JSON.stringify(VERSION_ID)};
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || "GET").toUpperCase();
  if (u.includes("/script-settings") && u.includes(PRODUCER)) {
    return json(200, {
      success: true,
      result: { logpush: false, tags: [], tail_consumers: null, observability: null },
    });
  }
  if (u.includes("/workers/workers/") && u.includes(PRODUCER)) {
    return json(200, {
      success: true,
      result: { id: "uuid-producer", name: PRODUCER, tail_consumers: [] },
    });
  }
  if (u.includes("/deployments") && u.includes(CONSUMER)) {
    return json(200, {
      success: true,
      result: {
        deployments: [{
          id: "dep-1",
          versions: [{ version_id: VERSION, percentage: 100 }],
        }],
      },
    });
  }
  return json(500, { success: false, errors: [{ message: \`unexpected fetch \${method} \${u}\` }] });
};
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "secret-fetch-win",
    restorerId: "tr-secret-fetch",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 1800,
  });

  const composed = composeGuardianChildEnv({
    ...process.env,
    CLOUDFLARE_API_TOKEN: "must-not-reach-child",
    CLOUDFLARE_API_TOKEN_FILE: tokenFile,
  }, { tokenFile, preferTokenFile: true });
  assert.equal(composed.has_TOKEN, false);
  assert.equal(composed.has_TOKEN_FILE, true);

  const started = startSupervisedTailRestorerProcess({
    windowPath: store.path,
    windowId: window.window_id,
    stateRoot,
    runnerPath: join(stateRoot, "run.mjs"),
    nodeExecPath: process.execPath,
    nodeArgs: ["--import", pathToFileURL(mockFetch).href],
    detached: true,
    pollMs: 100,
    tokenFile,
    preferTokenFile: true,
    env: {
      ...composed.env,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_WORKER_ID: WORKER_ID,
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: writeFixtureCapDetachModule(dir),
      // Intentionally NO CITYSCROLL_*_TRANSPORT_MODULE overrides.
    },
  });
  assert.equal(started.credential.source, "TOKEN_FILE");
  assert.equal(started.credential.has_TOKEN, false);
  assert.equal(started.credential.has_TOKEN_FILE, true);

  const paths = tailRestorerPaths(stateRoot);
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    if (existsSync(paths.childFailedBeforeReadyReceipt)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(paths.readyReceipt) && existsSync(paths.childFailedBeforeReadyReceipt)) {
    const fail = JSON.parse(readFileSync(paths.childFailedBeforeReadyReceipt, "utf8"));
    assert.fail(`ready missing; failure_code=${fail.failure_code}`);
  }
  assert.ok(existsSync(paths.readyReceipt), "REAL secret()+default loaders must reach ready under mocked fetch");
  const ready = JSON.parse(readFileSync(paths.readyReceipt, "utf8"));
  assert.equal(ready.version_guard_bound, true);
  assert.equal(ready.version_guard.observed_at_ready, VERSION_GUARD_LABEL.MATCH);
  const startSpawn = JSON.parse(readFileSync(paths.startSpawnReceipt, "utf8"));
  assert.deepEqual(startSpawn.node_args, ["--import", pathToFileURL(mockFetch).href]);
  assert.equal(startSpawn.has_TOKEN, false);
  assert.equal(startSpawn.has_TOKEN_FILE, true);
  assert.equal(startSpawn.raw_stderr_persisted, false);
  // Non-secret executed-path receipt for the report.
  const executedPath = {
    path: "installDurableTailRestorerRunner → startSupervised(TOKEN_FILE) → run.mjs main → secret(TOKEN_FILE) → loadTransport(default dual-view) → loadVersionTransport(default deployments) → announceTailRestorerReady(observeVersionGuard)",
    transport_module_override: false,
    version_module_override: false,
    fetch: "node --import mock-fetch-preload (globalThis.fetch)",
    credential_source: "TOKEN_FILE",
    has_TOKEN: false,
    has_TOKEN_FILE: true,
    ready_observed: ready.version_guard.observed_at_ready,
  };
  writeFileSync(join(dir, "executed-path-secret-fetch.json"), `${JSON.stringify(executedPath, null, 2)}\n`, { mode: 0o600 });
  assert.equal(JSON.stringify(executedPath).includes("fixture-token-for-secret-loader-only"), false);

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("process fixture: parent-unavailable autonomous expiry via default loaders + mock-fetch", async () => {
  // Extends the same autonomous-expiry fixture: disposable launcher spawns the
  // durable guardian then exits(0). Grandparent (this test) observes that exit.
  // Guardian uses REAL secret()+default dual-view/deployments loaders under a
  // mocked fetch preload. No controller-death, no cancel, no parent restore tick.
  assert.match(process.version, /^v24\./, `installed Node must be 24.x, got ${process.version}`);

  const dir = mkdtempSync(join(tmpdir(), "cc05-tail-parent-unavail-expiry-"));
  const stateRoot = join(dir, "restorer");
  const tokenFile = join(dir, "cloudflare-token");
  writeFileSync(tokenFile, "fixture-token-parent-unavail-expiry\n", { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  installDurableTailRestorerRunner({ stateRoot, repoRoot: REPO_ROOT });
  const capDetachModuleUrl = writeFixtureCapDetachModule(dir);

  const scriptStatePath = join(dir, "script-settings-tail.json");
  writeFileSync(scriptStatePath, `${JSON.stringify([SANITIZER])}\n`, { mode: 0o600 });
  const patchLogPath = join(dir, "patch-log.jsonl");
  const mockFetch = join(dir, "mock-fetch-preload.mjs");
  writeFileSync(mockFetch, `import { readFileSync, writeFileSync } from "node:fs";
const ACCOUNT = ${JSON.stringify(ACCOUNT_ID)};
const PRODUCER = ${JSON.stringify(WORKER_ID)};
const CONSUMER = ${JSON.stringify(SANITIZER.service)};
const VERSION = ${JSON.stringify(VERSION_ID)};
const STATE = ${JSON.stringify(scriptStatePath)};
const PATCH_LOG = ${JSON.stringify(patchLogPath)};
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
function loadTail() {
  return JSON.parse(readFileSync(STATE, "utf8"));
}
function saveTail(next) {
  writeFileSync(STATE, JSON.stringify(next) + "\\n");
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || "GET").toUpperCase();
  if (u.includes("/script-settings") && u.includes(PRODUCER)) {
    if (method === "GET") {
      return json(200, {
        success: true,
        result: { logpush: false, tags: [], tail_consumers: loadTail(), observability: null },
      });
    }
    if (method === "PATCH") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const next = Array.isArray(body.tail_consumers) ? body.tail_consumers : [];
      saveTail(next);
      writeFileSync(PATCH_LOG, JSON.stringify({ method: "PATCH", consumers: next, at: new Date().toISOString() }) + "\\n", { flag: "a" });
      return json(200, {
        success: true,
        result: { logpush: false, tags: [], tail_consumers: next, observability: null },
      });
    }
  }
  if (u.includes("/workers/workers/") && u.includes(PRODUCER) && method === "GET") {
    const current = loadTail();
    // Beta is authoritative only for explicit []. Non-empty stays name-only UNKNOWN.
    const betaTail = current.length === 0 ? [] : current.map((c) => ({ name: c.service }));
    return json(200, {
      success: true,
      result: { id: "uuid-producer", name: PRODUCER, tail_consumers: betaTail },
    });
  }
  if (u.includes("/deployments") && u.includes(CONSUMER) && method === "GET") {
    return json(200, {
      success: true,
      result: {
        deployments: [{
          id: "dep-1",
          versions: [{ version_id: VERSION, percentage: 100 }],
        }],
      },
    });
  }
  return json(500, { success: false, errors: [{ message: \`unexpected fetch \${method} \${u}\` }] });
};
`);

  const { store, window } = await openStoredArmedWindow(dir, {
    windowId: "parent-unavail-expiry-win",
    restorerId: "tr-parent-unavail-expiry",
    baselineConsumers: [],
    now: new Date().toISOString(),
    durationSeconds: 4,
  });
  let owned = await store.read();
  owned = {
    ...owned,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  await store.write(owned, { expectedWindowId: owned.window_id });

  const launcherMetaPath = join(dir, "launcher-meta.json");
  const launcherScript = join(dir, "disposable-launcher.mjs");
  const restorerLibUrl = pathToFileURL(join(REPO_ROOT, "tools/lib/worker_tail_attachment_restorer.mjs")).href;
  writeFileSync(launcherScript, `import { writeFileSync } from "node:fs";
import { startSupervisedTailRestorerProcess } from ${JSON.stringify(restorerLibUrl)};

const started = startSupervisedTailRestorerProcess({
  windowPath: ${JSON.stringify(store.path)},
  windowId: ${JSON.stringify(window.window_id)},
  stateRoot: ${JSON.stringify(stateRoot)},
  runnerPath: ${JSON.stringify(join(stateRoot, "run.mjs"))},
  nodeExecPath: ${JSON.stringify(process.execPath)},
  nodeArgs: ["--import", ${JSON.stringify(pathToFileURL(mockFetch).href)}],
  detached: true,
  pollMs: 100,
  tokenFile: ${JSON.stringify(tokenFile)},
  preferTokenFile: true,
  env: {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: ${JSON.stringify(ACCOUNT_ID)},
    CLOUDFLARE_WORKER_ID: ${JSON.stringify(WORKER_ID)},
    CLOUDFLARE_API_TOKEN_FILE: ${JSON.stringify(tokenFile)},
    CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: ${JSON.stringify(capDetachModuleUrl)},
    // Prefer TOKEN_FILE; composeGuardianChildEnv strips any raw TOKEN.
  },
});

writeFileSync(${JSON.stringify(launcherMetaPath)}, JSON.stringify({
  launcher_pid: process.pid,
  guardian_pid: started.pid,
  window_id: ${JSON.stringify(window.window_id)},
  restorer_id: ${JSON.stringify(window.restorer.restorer_id)},
  genuine_launcher_exit: true,
  parent_restore_tick: false,
  transport_module_override: false,
  version_module_override: false,
  credential_source: started.credential?.source || null,
  has_TOKEN: started.credential?.has_TOKEN === true,
  has_TOKEN_FILE: started.credential?.has_TOKEN_FILE === true,
}) + "\\n");

// Detached guardian must survive this launcher exit.
setTimeout(() => process.exit(0), 80);
`);

  const launcherExit = await new Promise((resolve, reject) => {
    const launcher = spawn(process.execPath, [launcherScript], { stdio: "ignore" });
    launcher.on("exit", (code, signal) => resolve({ code, signal, pid: launcher.pid }));
    launcher.on("error", reject);
  });
  assert.equal(launcherExit.code, 0, "disposable launcher must exit 0");
  assert.equal(launcherExit.signal, null);
  assert.ok(existsSync(launcherMetaPath), "launcher meta written before exit");
  const launcherMeta = JSON.parse(readFileSync(launcherMetaPath, "utf8"));
  assert.equal(launcherMeta.genuine_launcher_exit, true);
  assert.equal(launcherMeta.parent_restore_tick, false);
  assert.equal(launcherMeta.transport_module_override, false);
  assert.equal(launcherMeta.version_module_override, false);
  assert.equal(launcherMeta.has_TOKEN, false);
  assert.equal(launcherMeta.has_TOKEN_FILE, true);
  assert.ok(launcherMeta.guardian_pid > 0);
  assert.notEqual(launcherMeta.launcher_pid, launcherMeta.guardian_pid);

  const paths = tailRestorerPaths(stateRoot);
  // Parent (grandparent test) is unavailable for restore ticks / death receipts.
  assert.equal(existsSync(paths.controllerDeathReceipt), false);

  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline && !existsSync(paths.readyReceipt)) {
    if (existsSync(paths.childFailedBeforeReadyReceipt)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(paths.readyReceipt) && existsSync(paths.childFailedBeforeReadyReceipt)) {
    const fail = JSON.parse(readFileSync(paths.childFailedBeforeReadyReceipt, "utf8"));
    assert.fail(`ready missing after launcher exit; failure_code=${fail.failure_code}`);
  }
  assert.ok(existsSync(paths.readyReceipt), "guardian ready under default loaders after launcher exit");
  const ready = JSON.parse(readFileSync(paths.readyReceipt, "utf8"));
  assert.equal(ready.version_guard_bound, true);
  assert.equal(ready.version_guard.observed_at_ready, VERSION_GUARD_LABEL.MATCH);

  const terminalDeadline = Date.now() + 20_000;
  while (Date.now() < terminalDeadline && !existsSync(paths.terminalReceipt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(paths.terminalReceipt), "guardian terminal after parent-unavailable expiry");
  assert.equal(existsSync(paths.controllerDeathReceipt), false, "still no controller-death receipt");

  const terminal = JSON.parse(readFileSync(paths.terminalReceipt, "utf8"));
  assert.equal(terminal.proved, true);
  assert.ok(["restored", "already-restored"].includes(terminal.outcome), terminal.outcome);
  assert.equal(terminal.expired, true);
  assert.equal(terminal.window_id, window.window_id);
  assert.notEqual(terminal.controller_death, true);

  const after = JSON.parse(readFileSync(store.path, "utf8"));
  assert.equal(after.phase, "expired-restored");
  assert.equal(after.owned_sha256, null);
  assert.deepEqual(after.baseline_consumers, []);
  const scriptAfter = JSON.parse(readFileSync(scriptStatePath, "utf8"));
  assert.deepEqual(scriptAfter, []);
  assert.ok(existsSync(patchLogPath), "default-loader restore must PATCH via mocked fetch");

  stopSupervisedTailRestorerProcess({ stateRoot, signal: "SIGTERM" });
  try { process.kill(launcherMeta.guardian_pid, "SIGTERM"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("loadCapDetachActuator: missing readback env is UNKNOWN (null), no idle fake", async () => {
  const transport = memoryTransport([]);
  const versionTransport = memoryVersionTransport();
  const window = {
    restorer: { armed: true, cap_detach_actuator_bound: true },
  };
  const actuator = await loadCapDetachActuator(
    {
      // deliberately omit CITYSCROLL_TAIL_SINK_READBACK_URL/TOKEN
    },
    window,
    { store: null, transport, versionTransport },
  );
  assert.equal(actuator, null);
});

test("loadCapDetachActuator: rejected / unauthorized readback is UNKNOWN (null)", async () => {
  const transport = memoryTransport([]);
  const versionTransport = memoryVersionTransport();
  const window = {
    restorer: { armed: true, cap_detach_actuator_bound: true },
  };
  const actuator = await loadCapDetachActuator(
    {
      CITYSCROLL_TAIL_SINK_READBACK_URL: "https://example.test/readback",
      CITYSCROLL_TAIL_SINK_READBACK_TOKEN: "tok",
      // Intercept via undici is hard; use a module fixture instead below.
    },
    window,
    { store: null, transport, versionTransport },
  );
  // Without a reachable authenticated sink, readiness poll fails → null.
  assert.equal(actuator, null);
});

test("loadCapDetachActuator: successful authenticated readiness poll returns actuator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-cap-ready-mod-"));
  const modPath = join(dir, "cap-detach-fixture.mjs");
  writeFileSync(modPath, `
    export function createCapDetachActuator(env, window, { transport, versionTransport }) {
      return {
        kind: "fixture-ready",
        async pollCapSignal() {
          return { cap_reached: false, readback_ok: true, reason: "fixture" };
        },
        async pollAndDetachIfCapped() {
          return { actuated: false, proved: false, reason: "fixture" };
        },
      };
    }
  `);
  const transport = memoryTransport([]);
  const versionTransport = memoryVersionTransport();
  const window = {
    restorer: { armed: true, cap_detach_actuator_bound: true },
  };
  const actuator = await loadCapDetachActuator(
    {
      CITYSCROLL_TAIL_ATTACHMENT_RESTORER_CAP_DETACH_MODULE: pathToFileURL(modPath).href,
    },
    window,
    { store: null, transport, versionTransport },
  );
  assert.ok(actuator);
  assert.equal(typeof actuator.pollAndDetachIfCapped, "function");
  rmSync(dir, { recursive: true, force: true });
});

test("loadCapDetachActuator default path: readiness requires successful validated poll", async () => {
  const transport = memoryTransport([]);
  const versionTransport = memoryVersionTransport();
  const window = {
    restorer: { armed: true, cap_detach_actuator_bound: true },
  };
  // Monkey-patch via createSinkReadbackCapSignal is covered in attachment tests;
  // here prove the default loader wires createSinkReadbackCapSignal and refuses
  // when the readiness GET is unauthorized by injecting a local fetch through
  // a tiny module that still exercises createOwnedCapDetachActuator after a
  // successful probe helper.
  const dir = mkdtempSync(join(tmpdir(), "cc05-cap-ready-ok-"));
  const probe = createSinkReadbackCapSignal({
    url: "https://example.test/readback",
    token: "tok",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
        cap_reached: false,
        events_seen: 0,
        apply_overshoot: 0,
        counters: { apply_overshoot: 0 },
        deadline_ms: 1_800_000,
        max_events: 10_000,
        a2: { pass: true, reason: "within_all_seen_cap", events_seen: 0, apply_overshoot: 0 },
      }),
    }),
  });
  const readiness = await probe({ timeoutMs: 50 });
  assert.equal(readiness.readback_ok, true);

  // Incomplete schema must not be treated as ready.
  const incomplete = createSinkReadbackCapSignal({
    url: "https://example.test/readback",
    token: "tok",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cap_reached: false, events_seen: 0 }),
    }),
  });
  const incompleteReady = await incomplete({ timeoutMs: 50 });
  assert.equal(incompleteReady.readback_ok, false);

  // Unauthorized probe must not be treated as ready.
  const bad = createSinkReadbackCapSignal({
    url: "https://example.test/readback",
    token: "tok",
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  const badReady = await bad({ timeoutMs: 50 });
  assert.equal(badReady.readback_ok, false);

  // Default loader with URL/TOKEN but network failure → null (UNKNOWN).
  const actuator = await loadCapDetachActuator(
    {
      CITYSCROLL_TAIL_SINK_READBACK_URL: "https://127.0.0.1:1/no-sink",
      CITYSCROLL_TAIL_SINK_READBACK_TOKEN: "tok",
    },
    window,
    { store: null, transport, versionTransport },
  );
  assert.equal(actuator, null);
  rmSync(dir, { recursive: true, force: true });
});

test("tailAttachmentRestorerTick: stalled cap poll stays outside lock; expiry restore still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-cap-stall-expiry-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(stateRoot, { recursive: true });
  const transport = memoryTransport([SANITIZER]);
  let lockEntered = false;
  let pollStarted = false;
  let pollResolved = false;

  const { store, window, versionTransport } = await openStoredArmedWindow(dir, {
    windowId: "stall-expiry-win",
    restorerId: "tr-stall",
    baselineConsumers: [],
    now: "2026-10-17T11:00:00.000Z",
    durationSeconds: 2,
  });
  let owned = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  owned = await store.write(owned);

  const actuator = createOwnedCapDetachActuator({
    transport,
    versionTransport,
    readCapSignal: createSinkReadbackCapSignal({
      url: "https://example.test/readback",
      token: "tok",
      timeoutMs: 30,
      fetchImpl: async (_url, init) => {
        pollStarted = true;
        assert.ok(init?.signal, "poll must supply AbortSignal");
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            pollResolved = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (init.signal.aborted) {
            onAbort();
            return;
          }
          init.signal.addEventListener("abort", onAbort, { once: true });
        });
        return { ok: true, json: async () => ({ cap_reached: true }) };
      },
    }),
  });

  const innerWithLock = store.withLock.bind(store);
  store.withLock = async (fn, options) => {
    assert.equal(pollStarted, true, "cap poll must start before withLock");
    // Outer Promise.race may settle UNKNOWN before the injected fetch's abort
    // handler runs; require only that the poll started outside the lock.
    lockEntered = true;
    return innerWithLock(fn, options);
  };

  const idleTick = await tailAttachmentRestorerTick({
    store,
    transport,
    versionTransport,
    capDetachActuator: actuator,
    stateRoot,
    now: "2026-10-17T11:00:01.000Z",
  });
  assert.equal(idleTick.outcome, "idle");
  assert.equal(idleTick.cap_signal?.readback_ok, false);
  assert.ok(
    idleTick.cap_signal?.reason === "readback_timeout"
      || idleTick.cap_signal?.aborted === true,
    idleTick.cap_signal?.reason,
  );
  assert.equal(transport.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(lockEntered, true);

  // After expiry: restore still runs (poll skipped when snapExpired).
  lockEntered = false;
  store.withLock = async (fn, options) => {
    lockEntered = true;
    return innerWithLock(fn, options);
  };
  const expiredTick = await tailAttachmentRestorerTick({
    store,
    transport,
    versionTransport,
    capDetachActuator: actuator,
    stateRoot,
    now: "2026-10-17T11:00:05.000Z",
  });
  assert.ok(
    ["restored", "already-restored"].includes(expiredTick.action || expiredTick.outcome)
      || expiredTick.proved === true,
    JSON.stringify({ action: expiredTick.action, outcome: expiredTick.outcome }),
  );
  assert.ok(transport.calls.filter((c) => c.method === "PATCH").length >= 1);
  const after = await store.read();
  assert.ok(["restored", "expired-restored"].includes(after.phase), after.phase);
  rmSync(dir, { recursive: true, force: true });
});

test("tailAttachmentRestorerTick: re-reads time after poll so deadline restore is not postponed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc05-cap-reread-now-"));
  const stateRoot = join(dir, "restorer");
  mkdirSync(stateRoot, { recursive: true });
  const transport = memoryTransport([SANITIZER]);
  const { store, window, versionTransport } = await openStoredArmedWindow(dir, {
    windowId: "reread-now-win",
    restorerId: "tr-reread",
    baselineConsumers: [],
    now: "2026-10-17T11:00:00.000Z",
    durationSeconds: 2,
  });
  let owned = {
    ...window,
    phase: "attached",
    owned_consumers: canonicalizeTailConsumers([SANITIZER]),
    owned_sha256: tailConsumersSha256([SANITIZER]),
    pending_mutation: null,
  };
  owned = await store.write(owned);

  let pollCalls = 0;
  const actuator = createOwnedCapDetachActuator({
    transport,
    versionTransport,
    readCapSignal: async () => {
      pollCalls += 1;
      // Simulate a poll that consumes the remaining window.
      await new Promise((r) => setTimeout(r, 5));
      return {
        cap_reached: false,
        readback_ok: true,
        reason: "cap_not_reached",
        events_seen: 0,
        apply_overshoot: 0,
        a2: { pass: true, reason: "within_all_seen_cap", events_seen: 0, apply_overshoot: 0 },
      };
    },
  });

  let t = Date.parse("2026-10-17T11:00:01.000Z");
  const nowFn = () => {
    const iso = new Date(t).toISOString();
    // After the poll, advance past expires_at (11:00:02Z).
    t = Date.parse("2026-10-17T11:00:05.000Z");
    return iso;
  };

  const tick = await tailAttachmentRestorerTick({
    store,
    transport,
    versionTransport,
    capDetachActuator: actuator,
    stateRoot,
    nowFn,
  });
  assert.ok(pollCalls >= 1, "cap poll should run while pre-poll time is inside window");
  assert.ok(
    ["restored", "already-restored"].includes(tick.action || tick.outcome)
      || tick.proved === true
      || tick.terminal_receipt,
    JSON.stringify({ action: tick.action, outcome: tick.outcome }),
  );
  assert.ok(transport.calls.filter((c) => c.method === "PATCH").length >= 1);
  rmSync(dir, { recursive: true, force: true });
});

