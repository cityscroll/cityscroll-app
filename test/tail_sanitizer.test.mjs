/**
 * cityscroll-tail-sanitizer allowlist + hostile-event regressions.
 * No Cloudflare deploy. Asserts secret/query/body/header values never persist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNonEmptyExpectedRevisionAllowlist,
  classifyCpuValue,
  cohortFromFetchPathname,
  cpuMsBucket,
  createNdjsonFramer,
  DEFAULT_COLLECTOR_SCRIPT_NAME,
  FIXED_COHORT_KEYS,
  FORBIDDEN_PERSIST_KEYS,
  isCollectorSelfTailItem,
  isValidatedTailEventShape,
  makeGetterOnlyTraceItem,
  makeLazyCpuTraceItem,
  mapFixedCohort,
  mapPersistedRevision,
  parseExpectedRevisionAllowlist,
  PATHNAME_COHORT_PREFIXES,
  projectAllowlistedTailEvent,
  projectNdjsonLine,
  serializeAllowlistedDelta,
} from "../workers/cityscroll-tail-sanitizer/src/projection.mjs";
import {
  AGGREGATE_SINK_SCHEMA,
  CPU_CLASS_COUNTER_KEYS,
  createAggregateDoSink,
  createLocalTailToSinkBridge,
} from "../workers/cityscroll-tail-sanitizer/src/aggregate_sink_logic.mjs";
import {
  AggregateSink,
  actuateOwnedDetachFromCapSignal,
  evaluateAllSeenCapA2,
} from "../workers/cityscroll-tail-sanitizer/src/worker.mjs";
import workerEntrypoint from "../workers/cityscroll-tail-sanitizer/src/worker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "workers/cityscroll-tail-sanitizer/wrangler.toml");

test("wrangler config names cityscroll-tail-sanitizer and omits observability", () => {
  const text = readFileSync(WRANGLER, "utf8");
  assert.match(text, /name\s*=\s*"cityscroll-tail-sanitizer"/);
  // Config table absent: comments may mention the word; only a real [observability] block fails.
  assert.equal(/^\[observability(?:\.[^\]]+)?\]/m.test(text), false);
  assert.match(text, /class_name\s*=\s*"AggregateSink"/);
  // Real binding tables only — comments may mention KV absence.
  assert.equal(/^\[\[kv_namespaces\]\]/m.test(text), false, "sanitizer must not declare kv_namespaces");
});

test("empty object and banner-like JSON are not validated Tail events", () => {
  assert.equal(isValidatedTailEventShape({}), false);
  assert.equal(isValidatedTailEventShape(null), false);
  assert.equal(isValidatedTailEventShape([]), false);
  assert.equal(isValidatedTailEventShape({ hello: "banner" }), false);
  const rejected = projectAllowlistedTailEvent({});
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "not_validated_tail_event_shape");
});

test("positive control: lazy cpuTime is read and classified; no URL fields in projection", () => {
  const item = makeLazyCpuTraceItem({ cpuTime: 7, outcome: "ok", eventType: "fetch" });
  assert.equal(Object.keys(item).includes("cpuTime"), false);
  assert.equal(item.cpuTime, 7);
  assert.equal(isValidatedTailEventShape(item), true);
  const projected = projectAllowlistedTailEvent(item);
  assert.equal(projected.accepted, true);
  assert.equal(projected.cpuTime, 7);
  assert.equal(projected.cpu_class, "positive");
  assert.equal(projected.outcome, "ok");
  assert.equal(projected.eventType, "fetch");
  assert.equal("url" in projected, false);
  assert.equal("headers" in projected, false);
  assert.equal("query" in projected, false);
  assert.equal("body" in projected, false);
  assert.equal("request" in projected, false);
  // Source event carried a secret URL; projection must not retain it.
  const serialized = JSON.stringify(serializeAllowlistedDelta(projected));
  assert.equal(serialized.includes("example.invalid"), false);
  assert.equal(serialized.includes("token=abc"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("cpu classes keep undefined/null/NaN/zero/positive distinct", () => {
  assert.equal(classifyCpuValue(undefined), "undefined");
  assert.equal(classifyCpuValue(null), "null");
  assert.equal(classifyCpuValue(Number.NaN), "nan");
  assert.equal(classifyCpuValue(0), "zero");
  assert.equal(classifyCpuValue(0.001), "positive");
  assert.equal(classifyCpuValue(-1), "negative");
  assert.equal(classifyCpuValue(Infinity), "nonfinite");
  assert.equal(classifyCpuValue("7"), "type_other");
});

test("hostile Tail event: secret, query, body, and header values never persist", async () => {
  const SECRET = "super-secret-token-VALUE-9f3a";
  const QUERY = "session=leak-me-please";
  const BODY = '{"password":"hunter2-not-for-disk"}';
  const HEADER = "Bearer sk_live_hostile_fixture";

  const hostile = {
    outcome: "ok",
    event: {
      request: {
        url: `https://api.example.invalid/v1/items?${QUERY}&token=${SECRET}`,
        method: "POST",
        headers: {
          authorization: HEADER,
          cookie: `sid=${SECRET}`,
          "content-type": "application/json",
        },
        body: BODY,
        cf: { rayId: "ray-hostile-001", colo: "EWR" },
      },
    },
    logs: [{ message: `user said ${SECRET}` }],
    exceptions: [{ name: "Error", message: SECRET }],
    get cpuTime() {
      return 11;
    },
    get wallTime() {
      return 20;
    },
    get scriptVersion() {
      return { id: "ver-hostile" };
    },
  };

  const sink = createAggregateDoSink({ sinkId: "hostile", readbackToken: "owned-token" });
  const bridge = createLocalTailToSinkBridge(sink);
  const batch = await bridge.onTailBatch([hostile]);
  assert.equal(batch.acked, 1);

  const snap = sink.snapshotForTest();
  assert.equal(snap.counters.events_accepted, 1);
  assert.equal(snap.applied_deltas.length, 1);
  const persisted = JSON.stringify(snap.applied_deltas);
  const readback = JSON.stringify(sink.readback({ token: "owned-token" }));
  const combined = `${persisted}\n${readback}`;

  for (const needle of [SECRET, QUERY, BODY, HEADER, "hunter2", "sk_live", "ray-hostile", "api.example.invalid"]) {
    assert.equal(
      combined.includes(needle),
      false,
      `hostile needle must not persist: ${needle.slice(0, 24)}`,
    );
  }
  for (const key of FORBIDDEN_PERSIST_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(snap.applied_deltas[0], key),
      false,
      `forbidden key persisted: ${key}`,
    );
  }
  assert.equal(snap.applied_deltas[0].cpu_class, "positive");
  assert.equal(snap.applied_deltas[0].eventType, "fetch");
});

test("sink rejects deltas that still carry forbidden keys", () => {
  const sink = createAggregateDoSink({ sinkId: "forbid" });
  const bad = sink.applyAllowlistedDelta({
    accepted: true,
    cpu_class: "positive",
    cpuTime: 1,
    outcome: "ok",
    eventType: "fetch",
    url: "https://example.invalid/secret",
  });
  assert.equal(bad.acked, false);
  assert.equal(bad.reason, "forbidden_key");
  assert.equal(sink.snapshotForTest().counters.events_rejected, 1);
  assert.equal(sink.snapshotForTest().counters.events_accepted, 0);
});

test("hard cap refuses further events after ALL-seen maxEvents (accept + reject)", () => {
  const sink = createAggregateDoSink({ sinkId: "cap", maxEvents: 3 });
  const first = sink.applyAllowlistedDelta({
    accepted: true, cpu_class: "zero", outcome: "ok", eventType: "fetch",
  });
  assert.equal(first.acked, true);
  assert.equal(first.trigger_owned_detach, undefined);

  const rejected = sink.applyAllowlistedDelta({
    accepted: false, reason: "not_validated_tail_event_shape",
  });
  assert.equal(rejected.acked, false);
  assert.equal(rejected.trigger_owned_detach, undefined);

  const hitting = sink.applyAllowlistedDelta({
    accepted: true, cpu_class: "positive", outcome: "ok", eventType: "fetch",
  });
  assert.equal(hitting.acked, true);
  assert.equal(hitting.cap_reached, true);
  assert.equal(hitting.trigger_owned_detach, true);
  assert.equal(hitting.events_seen, 3);

  assert.throws(
    () => sink.applyAllowlistedDelta({
      accepted: true, cpu_class: "positive", outcome: "ok", eventType: "fetch",
    }),
    (err) => err.code === "SINK_CAP" && err.cap_reached === true,
  );
  assert.throws(
    () => sink.applyAllowlistedDelta({ accepted: false, reason: "after-cap" }),
    (err) => err.code === "SINK_CAP",
  );

  const snap = sink.snapshotForTest();
  assert.equal(snap.counters.events_accepted, 2);
  assert.equal(snap.counters.events_rejected, 1);
  assert.equal(snap.events_seen, 3);
  assert.equal(snap.cap_reached, true);
  const readback = sink.readback();
  assert.equal(readback.events_seen, 3);
  assert.equal(readback.cap_reached, true);
  assert.equal(readback.counters.events_seen, 3);
});

test("rejected events count toward the ALL-seen cap", () => {
  const sink = createAggregateDoSink({ sinkId: "reject-cap", maxEvents: 2 });
  const r1 = sink.applyAllowlistedDelta({
    accepted: true,
    cpu_class: "positive",
    cpuTime: 1,
    outcome: "ok",
    eventType: "fetch",
    url: "https://example.invalid/secret",
  });
  assert.equal(r1.acked, false);
  assert.equal(r1.reason, "forbidden_key");
  assert.equal(r1.trigger_owned_detach, undefined);

  const r2 = sink.ingestSyntheticTailItem({});
  assert.equal(r2.acked, false);
  assert.equal(r2.cap_reached, true);
  assert.equal(r2.trigger_owned_detach, true);
  assert.equal(r2.events_seen, 2);

  assert.throws(
    () => sink.applyAllowlistedDelta({
      accepted: true, cpu_class: "zero", outcome: "ok", eventType: "fetch",
    }),
    (err) => err.code === "SINK_CAP",
  );
  const snap = sink.snapshotForTest();
  assert.equal(snap.counters.events_accepted, 0);
  assert.equal(snap.counters.events_rejected, 2);
  assert.equal(snap.events_seen, 2);
  assert.equal(snap.cap_reached, true);
});

test("deadline refuses applies after deadlineMs", () => {
  let now = 1_000;
  const sink = createAggregateDoSink({
    sinkId: "deadline",
    deadlineMs: 100,
    nowMs: () => now,
  });
  assert.equal(sink.applyAllowlistedDelta({
    accepted: true, cpu_class: "null", outcome: "ok", eventType: "fetch",
  }).acked, true);
  now = 1_200;
  assert.throws(
    () => sink.applyAllowlistedDelta({
      accepted: true, cpu_class: "null", outcome: "ok", eventType: "fetch",
    }),
    (err) => err.code === "SINK_DEADLINE",
  );
});

test("authenticated readback refuses wrong token; cleanup clears aggregate", () => {
  const sink = createAggregateDoSink({ sinkId: "auth", readbackToken: "owned-token" });
  sink.applyAllowlistedDelta({
    accepted: true, cpu_class: "undefined", outcome: "ok", eventType: "fetch",
  });
  assert.equal(sink.readback({ token: "wrong" }).ok, false);
  const ok = sink.readback({ token: "owned-token" });
  assert.equal(ok.ok, true);
  assert.equal(ok.schema, AGGREGATE_SINK_SCHEMA);
  assert.equal(ok.counters.events_accepted, 1);
  for (const key of CPU_CLASS_COUNTER_KEYS) {
    assert.equal(typeof ok.counters.by_cpu_class[key], "number");
  }
  const cleaned = sink.cleanupOwned();
  assert.equal(cleaned.cleaned, true);
  assert.equal(sink.snapshotForTest().closed, true);
  assert.equal(sink.snapshotForTest().counters.events_accepted, 0);
});

test("NDJSON framer and empty-line projector reject non-invocations", () => {
  const framer = createNdjsonFramer();
  assert.deepEqual(framer.push('{"outcome":"ok"'), []);
  const lines = framer.push('}\n{}\n');
  assert.equal(lines.length, 2);
  assert.equal(projectNdjsonLine(lines[0]).ok, true);
  assert.equal(projectNdjsonLine(lines[1]).ok, false);
  assert.equal(projectNdjsonLine("{}").ok, false);
});

test("absent cpuTime on validated event stays cpu_class undefined (never wall-time substitute)", () => {
  const item = {
    outcome: "ok",
    event: { request: { cf: {} } },
    wallTime: 12,
  };
  const projected = projectAllowlistedTailEvent(item);
  assert.equal(projected.accepted, true);
  assert.equal(projected.cpuTime, null);
  assert.equal(projected.cpu_class, "undefined");
  assert.notEqual(projected.cpu_class, "zero");
});

function createFakeStorage() {
  const map = new Map();
  let writes = 0;
  let txnChain = Promise.resolve();
  const api = {
    async get(key) {
      if (!map.has(key)) return undefined;
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      writes += 1;
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async deleteAll() {
      writes += 1;
      map.clear();
    },
    /**
     * Serialize transactional closures the way DO storage.transaction does for
     * a single object. Concurrent fetch handlers may still interleave outside
     * the transaction (e.g. while awaiting req.json before entering).
     */
    async transaction(fn) {
      const run = txnChain.then(() => fn(api));
      txnChain = run.then(() => undefined, () => undefined);
      return run;
    },
    writeCount() { return writes; },
    keys() { return [...map.keys()].sort(); },
  };
  return api;
}

const TEST_WINDOW_ID = "test-window-1";
const WINDOW_ID_HEADER = "x-cityscroll-tail-window-id";

function createFakeSinkEnv(storage, {
  readbackToken = "owned-readback",
  expectedRevisions = "rev-a,rev-b,rev-c,rev-cpu,rev-1,getter-only-revision",
  ownedDetachActuator = null,
  defaultWindowId = TEST_WINDOW_ID,
} = {}) {
  const env = {
    READBACK_TOKEN: readbackToken,
    EXPECTED_DEPLOYED_REVISIONS: expectedRevisions,
  };
  if (ownedDetachActuator) env.OWNED_DETACH_ACTUATOR = ownedDetachActuator;

  // Per-window DO namespace: idFromName(window_id) → independent AggregateSink storage.
  const instances = new Map();
  function instanceFor(name) {
    if (!instances.has(name)) {
      const store = name === defaultWindowId ? storage : createFakeStorage();
      const sink = new AggregateSink({ storage: store }, env);
      instances.set(name, {
        name,
        storage: store,
        sink,
        stub: {
          async fetch(url, init = {}) {
            const req = init && init.body !== undefined
              ? new Request(url, init)
              : (url instanceof Request ? url : new Request(url, init));
            return sink.fetch(req);
          },
        },
      });
    }
    return instances.get(name);
  }

  // Default sink used by direct AggregateSink unit tests.
  const primary = instanceFor(defaultWindowId);
  env.AGG_SINK = {
    idFromName(name) { return { name: String(name) }; },
    get(id) {
      const name = id?.name ?? defaultWindowId;
      return instanceFor(name).stub;
    },
  };
  return {
    sink: primary.sink,
    storage: primary.storage,
    env,
    instances,
    instanceFor,
    defaultWindowId,
  };
}

function authHeaders(token, windowId = TEST_WINDOW_ID) {
  return {
    "x-cityscroll-tail-readback-token": token,
    [WINDOW_ID_HEADER]: windowId,
  };
}

/** Arm the control DO so worker.tail() routes to the given window_id. */
async function armActiveWindow(env, token, windowId = TEST_WINDOW_ID) {
  const res = await workerEntrypoint.fetch(new Request("https://worker/arm", {
    method: "POST",
    headers: authHeaders(token, windowId),
  }), env);
  assert.equal(res.status, 200, "arm must succeed for tail routing");
  const body = await res.json();
  assert.equal(body.armed, true);
  assert.equal(body.window_id, windowId);
  return body;
}

function delayedJsonRequest(url, body, gate) {
  return {
    url,
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    async json() {
      await gate;
      return structuredClone(body);
    },
  };
}

function eventsSeenHelper(c) {
  return (c.events_accepted || 0) + (c.events_rejected || 0) + (c.events_dropped_after_cap || 0);
}

test("getter-only TraceItem validates by property reads; empty {} still fails", () => {
  const getterOnly = makeGetterOnlyTraceItem({
    cpuTime: 5,
    wallTime: 8,
    outcome: "ok",
    eventType: "fetch",
  });
  assert.equal(Object.keys(getterOnly).length, 0, "fixture must be non-enumerable getters only");
  assert.equal(getterOnly.outcome, "ok");
  assert.equal(getterOnly.cpuTime, 5);
  assert.equal(isValidatedTailEventShape(getterOnly), true);
  const projected = projectAllowlistedTailEvent(getterOnly);
  assert.equal(projected.accepted, true);
  assert.equal(projected.cpuTime, 5);
  assert.equal(projected.cpu_class, "positive");
  assert.equal(projected.outcome, "ok");
  assert.equal(projected.eventType, "fetch");
  assert.equal(projected.deployed_revision, "getter-only-revision");
  assert.equal(JSON.stringify(serializeAllowlistedDelta(projected)).includes("example.invalid"), false);

  assert.equal(isValidatedTailEventShape({}), false);
  assert.equal(projectAllowlistedTailEvent({}).accepted, false);

  const throwing = makeGetterOnlyTraceItem({ throwOn: "outcome" });
  assert.equal(isValidatedTailEventShape(throwing), false);
  assert.equal(projectAllowlistedTailEvent(throwing).accepted, false);
});

test("AggregateSink: unauthenticated readback is 401 with zero storage writes", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage);
  const res = await sink.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: { [WINDOW_ID_HEADER]: TEST_WINDOW_ID },
  }));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "unauthorized");
  assert.equal(storage.writeCount(), 0);
  assert.deepEqual(storage.keys(), []);
});

test("AggregateSink: authenticated FRESH/EMPTY /readback is honest unopened zero-event (bootstrap)", async () => {
  const { createHash } = await import("node:crypto");
  const {
    CAP_CREDENTIAL_PROVENANCE,
    CAP_SIGNAL_REASON,
    TAIL_SINK_NAME,
    createSinkReadbackCapSignal,
    establishCapReadbackIdentityBinding,
  } = await import("../tools/lib/worker_tail_attachment.mjs");
  const { loadCapDetachActuator } = await import("../tools/worker_tail_attachment_restorer.mjs");

  const storage = createFakeStorage();
  const { sink, env } = createFakeSinkEnv(storage, { readbackToken: "owned-readback" });

  // Actual Worker entrypoint with fake AGG_SINK binding + storage — not a hand mock.
  const entryRes = await workerEntrypoint.fetch(new Request("https://worker/readback", {
    method: "GET",
    headers: authHeaders("owned-readback", "bootstrap-win"),
  }), env);
  assert.equal(entryRes.status, 200);
  const body = await entryRes.json();
  assert.equal(body.ok, true);
  assert.equal(body.schema, "cityscroll.tail_sanitizer_aggregate_sink.v1");
  assert.equal(body.sink_name, "cityscroll-tail-sanitizer-aggregate");
  assert.equal(body.window_id, "bootstrap-win");
  assert.equal(body.opened, false);
  assert.equal(body.closed, false);
  assert.equal(body.events_seen, 0);
  assert.equal(body.cap_reached, false);
  assert.equal(body.deadline_ms, 1_800_000);
  assert.equal(body.max_events, 10_000);
  assert.equal(body.counters.apply_overshoot, 0);
  assert.equal(body.a2.pass, null);
  assert.equal(body.a2.reason, "not_evaluated");
  // Unopened readback must not open a window or invent meta (no READY↔attach deadlock).
  // bootstrap-win routes to its own DO (not the defaultWindowId primary storage).
  assert.deepEqual(storage.keys(), []);

  const accountSha = createHash("sha256").update("a".repeat(32)).digest("hex");
  const versionSha = createHash("sha256").update("bootstrap-version").digest("hex");
  const readbackUrl = "https://worker/readback";
  const window = {
    window_id: "bootstrap-win",
    account_id_sha256: accountSha,
    restorer: { armed: true, cap_detach_actuator_bound: true },
    version_evidence: {
      present: true,
      sha256: versionSha,
      consumer: { service: "cityscroll-cc05-r4-tail-sanitizer", environment: null, namespace: null },
    },
    owned_consumers: null,
  };
  const identity = establishCapReadbackIdentityBinding({
    window,
    desiredConsumer: { service: "cityscroll-cc05-r4-tail-sanitizer", environment: null, namespace: null },
    readbackUrl,
    credentialProvenance: CAP_CREDENTIAL_PROVENANCE.TEST_FIXTURE,
    sinkName: TAIL_SINK_NAME,
  });
  assert.equal(identity.ok, true);

  const sinkFetch = async (_url, init) => {
    const req = new Request(readbackUrl, {
      method: "GET",
      headers: init?.headers || {},
    });
    return workerEntrypoint.fetch(req, env);
  };

  // Strict reader against the ACTUAL entrypoint→AggregateSink FRESH body.
  const readCapSignal = createSinkReadbackCapSignal({
    url: readbackUrl,
    token: "owned-readback",
    identityBinding: identity.binding,
    fetchImpl: sinkFetch,
  });
  const signal = await readCapSignal({ timeoutMs: 200 });
  assert.equal(signal.readback_ok, true);
  assert.equal(signal.cap_reached, false);
  assert.equal(signal.events_seen, 0);
  assert.equal(signal.opened, false);
  assert.equal(signal.a2.pass, null);
  assert.equal(signal.a2.reason, "not_evaluated");
  assert.equal("body" in signal, false);
  assert.equal(signal.identity_binding.sink_name, TAIL_SINK_NAME);

  // Default loader readiness against the same real FRESH/EMPTY response.
  const actuator = await loadCapDetachActuator(
    {
      CITYSCROLL_TAIL_SINK_READBACK_URL: readbackUrl,
      CITYSCROLL_TAIL_SINK_READBACK_TOKEN: "owned-readback",
    },
    window,
    {
      store: null,
      transport: { getTailConsumers: async () => [] },
      versionTransport: null,
      fetchImpl: sinkFetch,
    },
  );
  assert.ok(actuator);
  assert.equal(typeof actuator.pollAndDetachIfCapped, "function");
  // Still no meta — READY before attach does not open the sink window.
  assert.deepEqual(storage.keys(), []);

  // Malformed {} still refuses READY.
  const empty = createSinkReadbackCapSignal({
    url: readbackUrl,
    token: "owned-readback",
    identityBinding: identity.binding,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }),
  });
  const emptySignal = await empty({ timeoutMs: 50 });
  assert.equal(emptySignal.readback_ok, false);
  assert.equal(emptySignal.reason, CAP_SIGNAL_REASON.READBACK_SCHEMA_INVALID);

  // Direct AggregateSink path stays consistent with the entrypoint.
  const direct = await sink.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: authHeaders("owned-readback"),
  }));
  const directBody = await direct.json();
  assert.equal(directBody.opened, false);
  assert.equal(directBody.deadline_ms, body.deadline_ms);
  assert.equal(directBody.max_events, body.max_events);
  assert.equal(directBody.a2.pass, null);
  assert.equal(directBody.a2.reason, "not_evaluated");
});

test("AggregateSink: ALL-seen cap + tail() classifies all items and drops after cap", async () => {
  const storage = createFakeStorage();
  let detachCalls = 0;
  const { env, sink } = createFakeSinkEnv(storage, {
    ownedDetachActuator: {
      async fetch() {
        detachCalls += 1;
        return new Response(null, { status: 204 });
      },
    },
  });
  const open = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true,
      cpu_class: "positive",
      cpuTime: 1,
      outcome: "ok",
      eventType: "fetch",
      deployed_revision: "rev-a",
    }),
  }));
  assert.equal((await open.json()).acked, true);
  const meta = await storage.get("meta");
  meta.max_events = 2;
  await storage.put("meta", meta);

  const second = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accepted: false, reason: "not_validated_tail_event_shape" }),
  }));
  const secondBody = await second.json();
  assert.equal(secondBody.acked, false);
  assert.equal(secondBody.cap_reached, true);
  assert.equal(secondBody.trigger_owned_detach, true);
  assert.equal(secondBody.events_seen, 2);

  const batch = [
    makeGetterOnlyTraceItem({ cpuTime: 1, scriptVersionId: "rev-b" }),
    makeGetterOnlyTraceItem({ cpuTime: 2, scriptVersionId: "rev-b" }),
    makeGetterOnlyTraceItem({ cpuTime: 3, scriptVersionId: "rev-b" }),
  ];
  await armActiveWindow(env, "owned-readback");
  const tailResult = await workerEntrypoint.tail(batch, env);
  assert.equal(tailResult.classified, 3);
  assert.ok(tailResult.dropped_after_cap >= 1);
  assert.equal(tailResult.owned_detach.actuated, true);
  assert.equal(detachCalls, 1);
  assert.equal(tailResult.active_window_id, TEST_WINDOW_ID);
  const counters = await storage.get("counters");
  assert.equal(counters.events_accepted, 1);
  assert.ok(counters.events_rejected >= 1);
  assert.ok(counters.events_dropped_after_cap >= 1);
  assert.ok(eventsSeenHelper(counters) >= 2);
});

test("AggregateSink: cleanup tombstone survives; readback never reopens", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, { readbackToken: "tok" });
  const applied = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 10, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-1",
    }),
  }));
  assert.equal((await applied.json()).acked, true);

  const cleaned = await sink.fetch(new Request("https://sink/cleanup", {
    method: "POST",
    headers: authHeaders("tok"),
  }));
  assert.equal(cleaned.status, 200);
  const cleanedBody = await cleaned.json();
  assert.equal(cleanedBody.closed, true);
  assert.equal(cleanedBody.tombstone, true);
  assert.deepEqual(storage.keys(), ["terminal"]);

  const readback = await sink.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: authHeaders("tok"),
  }));
  const rb = await readback.json();
  assert.equal(rb.ok, true);
  assert.equal(rb.closed, true);
  assert.equal(rb.from_tombstone, true);
  assert.deepEqual(storage.keys().sort(), ["terminal"]);
  assert.equal(storage.keys().includes("meta"), false);
  assert.equal(storage.keys().includes("counters"), false);

  const stale = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 1, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-x",
    }),
  }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).reason, "SINK_CLOSED");
  assert.deepEqual(storage.keys(), ["terminal"]);
});

test("AggregateSink: distinct cpuTime values produce distinct sums (not class-only)", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, {
    readbackToken: "tok",
    expectedRevisions: "rev-cpu",
  });
  for (const ms of [1, 100]) {
    const res = await sink.fetch(new Request("https://sink/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accepted: true,
        cpu_class: "positive",
        cpuTime: ms,
        cpu_unknown: false,
        outcome: "ok",
        eventType: "fetch",
        deployed_revision: "rev-cpu",
      }),
    }));
    assert.equal((await res.json()).acked, true);
  }
  const rb = await (await sink.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: authHeaders("tok"),
  }))).json();
  assert.equal(rb.counters.by_cpu_class.positive, 2);
  assert.equal(rb.counters.cpu_ms_sum, 101);
  assert.equal(rb.counters.cpu_ms_count, 2);
  assert.equal(rb.counters.cpu_ms_histogram["0_1"], 1);
  assert.equal(rb.counters.cpu_ms_histogram["10_100"], 1);
  assert.equal(rb.counters.by_cohort_cpu.http.cpu_ms_sum, 101);
  assert.equal(rb.counters.by_deployed_revision["rev-cpu"], 2);
  assert.equal(cpuMsBucket(1), "0_1");
  assert.equal(cpuMsBucket(100), "10_100");
  for (const key of FIXED_COHORT_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(rb.counters.by_cohort_cpu, key), key);
  }
});

test("AggregateSink: root delayed-body race — ACK count matches persisted accepted", async () => {
  // Root reproduction at 00bc4aa2: first /apply paused at req.json AFTER reading
  // counters; second completed; first resumed. Both ACK'd but accepted stayed 2
  // after a seed of 1 (3 ACKs total). Fix: parse body before transactional RMW.
  const storage = createFakeStorage();
  const sink = new AggregateSink({ storage }, {
    READBACK_TOKEN: "tok",
    EXPECTED_DEPLOYED_REVISIONS: "rev-a",
  });

  const seed = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 1, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-a",
    }),
  }));
  assert.equal((await seed.json()).acked, true);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayed = delayedJsonRequest("https://sink/apply", {
    accepted: true, cpu_class: "positive", cpuTime: 1, outcome: "ok",
    eventType: "fetch", deployed_revision: "rev-a",
  }, gate);
  const second = new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 1, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-a",
    }),
  });

  const p1 = sink.fetch(delayed);
  await new Promise((r) => setTimeout(r, 20));
  const r2 = await (await sink.fetch(second)).json();
  release();
  const r1 = await (await p1).json();
  const counters = await storage.get("counters");

  const acks = [r1.acked, r2.acked].filter(Boolean).length;
  assert.equal(acks, 2, "both concurrent applies after seed should ACK under atomic RMW");
  assert.equal(counters.events_accepted, 3, "persisted accepted must equal seed+2 ACKs");
  assert.equal(counters.cpu_ms_sum, 3);
  assert.ok(
    r1.events_accepted_lower_bound === 3 || r2.events_accepted_lower_bound === 3,
    "at least one ACK reports the final lower bound",
  );
});

test("AggregateSink: cleanup versus in-flight apply keeps tombstone closed", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, { readbackToken: "tok", expectedRevisions: "rev-a" });
  await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 1, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-a",
    }),
  }));

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayedApply = delayedJsonRequest("https://sink/apply", {
    accepted: true, cpu_class: "positive", cpuTime: 2, outcome: "ok",
    eventType: "fetch", deployed_revision: "rev-a",
  }, gate);

  const applyPromise = sink.fetch(delayedApply);
  await new Promise((r) => setTimeout(r, 20));
  const cleaned = await sink.fetch(new Request("https://sink/cleanup", {
    method: "POST",
    headers: authHeaders("tok"),
  }));
  assert.equal((await cleaned.json()).tombstone, true);
  release();
  const applyBody = await (await applyPromise).json();
  assert.equal(applyBody.acked, false);
  assert.equal(applyBody.reason, "SINK_CLOSED");
  assert.deepEqual(storage.keys(), ["terminal"]);

  const rb = await (await sink.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: authHeaders("tok"),
  }))).json();
  assert.equal(rb.closed, true);
  assert.equal(rb.from_tombstone, true);
});

test("AggregateSink: concurrent applies under transactional RMW bound the cap", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, { expectedRevisions: "rev-c" });
  await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true, cpu_class: "zero", cpuTime: 0, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-c",
    }),
  }));
  const meta = await storage.get("meta");
  meta.max_events = 5;
  await storage.put("meta", meta);

  const payloads = Array.from({ length: 8 }, (_, i) => ({
    accepted: true,
    cpu_class: "positive",
    cpuTime: i + 1,
    outcome: "ok",
    eventType: "fetch",
    deployed_revision: "rev-c",
  }));
  const results = await Promise.all(payloads.map((body) => sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).then((r) => r.json())));
  const counters = await storage.get("counters");
  const acked = results.filter((r) => r.acked).length;
  const refused = results.filter((r) => r.acked === false && r.reason === "SINK_CAP");
  assert.equal(acked, 4);
  assert.equal(refused.length, 4);
  assert.equal(counters.events_accepted, 5);
  assert.equal(counters.apply_overshoot, 4);
  assert.equal(eventsSeenHelper(counters), 5 + 4);
});

test("AggregateSink: revision keys stay on expected allowlist; unknown cohort stays unknown", () => {
  const expected = parseExpectedRevisionAllowlist("rev-a,rev-b");
  assert.equal(mapPersistedRevision("rev-a", expected), "rev-a");
  assert.equal(mapPersistedRevision("foreign-rev", expected), "other");
  assert.equal(mapPersistedRevision("rev-a", new Set()), "unknown");
  assert.equal(mapFixedCohort({ eventType: "fetch" }), "http");
  assert.equal(mapFixedCohort({ eventType: "scheduled", cron: "0 8 * * *" }), "cron_0800");
  assert.equal(mapFixedCohort({ eventType: "scheduled", cron: "0 1 * * *" }), "cron_unknown");
  assert.equal(mapFixedCohort({ eventType: "queue" }), "queue");
  assert.equal(mapFixedCohort({ cohort: "search" }), "search");
  assert.equal(mapFixedCohort({ cohort: "not-a-real-cohort" }), "unknown");
  assert.ok(FIXED_COHORT_KEYS.includes("rum_batch_16"));
  assert.equal(FIXED_COHORT_KEYS.includes("rum_01"), false);
  assert.ok(FIXED_COHORT_KEYS.includes("collector"));
  assert.ok(FIXED_COHORT_KEYS.includes("cold_start_flag_raw_0"));
});

test("AggregateSink cost_vector counts collector DO requests and storage ops", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, {
    readbackToken: "tok-cost",
    expectedRevisions: "rev-a",
  });
  const apply = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true,
      cpu_class: "positive",
      cpuTime: 3,
      outcome: "ok",
      eventType: "fetch",
      deployed_revision: "rev-a",
    }),
  }));
  assert.equal(apply.status, 200);
  const applyBody = await apply.json();
  assert.ok(applyBody.cost_vector.collector_do_requests >= 1);
  assert.ok(applyBody.cost_vector.collector_storage_ops >= 1);
  assert.equal(applyBody.cost_vector.collector_cpu_ms, "UNKNOWN");
  assert.equal(applyBody.a2.pass, true);

  const readback = await sink.fetch(new Request("https://sink/readback", {
    headers: authHeaders("tok-cost"),
  }));
  assert.equal(readback.status, 200);
  const body = await readback.json();
  assert.ok(body.cost_vector.collector_do_requests >= 2);
  assert.ok(body.overhead.collector_storage_ops >= 1);
  assert.equal(body.overhead.collector_cpu_ms, "UNKNOWN");
  assert.equal(body.a2.pass, true);
});

test("evaluateAllSeenCapA2 fails above all-seen cap or unknown overshoot", () => {
  assert.equal(evaluateAllSeenCapA2({
    events_seen: 10_001,
    cap_reached: true,
    apply_overshoot: 1,
  }).pass, false);
  assert.equal(evaluateAllSeenCapA2({
    events_seen: 10_000,
    cap_reached: true,
    apply_overshoot: null,
  }).reason, "overshoot_unknown_unbounded");
  assert.equal(evaluateAllSeenCapA2({
    events_seen: 9_999,
    cap_reached: false,
    apply_overshoot: 0,
  }).pass, true);
  const unevaluated = evaluateAllSeenCapA2({
    events_seen: 0,
    cap_reached: false,
    apply_overshoot: 0,
  }, { opened: false });
  assert.equal(unevaluated.pass, null);
  assert.equal(unevaluated.reason, "not_evaluated");
  assert.equal(unevaluated.events_seen, 0);
});

test("actuateOwnedDetachFromCapSignal requires binding and signal", async () => {
  const none = await actuateOwnedDetachFromCapSignal({}, { trigger_owned_detach: true });
  assert.equal(none.actuated, false);
  assert.equal(none.reason, "no_actuator_bound");
  const skipped = await actuateOwnedDetachFromCapSignal({ OWNED_DETACH_ACTUATOR: { fetch() {} } }, {});
  assert.equal(skipped.actuated, false);
  let called = false;
  const ok = await actuateOwnedDetachFromCapSignal({
    OWNED_DETACH_ACTUATOR: {
      async fetch() {
        called = true;
        return new Response(null, { status: 204 });
      },
    },
  }, { trigger_owned_detach: true, events_seen: 10 });
  assert.equal(ok.actuated, true);
  assert.equal(called, true);
});

test("pathname cohort prefixes map search/nearby/performance-events/events/health; unknown → http", () => {
  assert.ok(Object.isFrozen(PATHNAME_COHORT_PREFIXES));
  assert.ok(FIXED_COHORT_KEYS.includes("http_events"));
  assert.equal(cohortFromFetchPathname("/search"), "search");
  assert.equal(cohortFromFetchPathname("/search/housing"), "search");
  assert.equal(cohortFromFetchPathname("/search/candidates"), "search");
  assert.equal(cohortFromFetchPathname("/near-you"), "nearby");
  assert.equal(cohortFromFetchPathname("/near-you/midwood"), "nearby");
  assert.equal(cohortFromFetchPathname("/performance-events"), "rum_batch_16");
  assert.equal(cohortFromFetchPathname("/performance-events/batch"), "rum_batch_16");
  assert.equal(cohortFromFetchPathname("/events"), "http_events");
  assert.equal(cohortFromFetchPathname("/events/batch"), "http_events");
  assert.equal(cohortFromFetchPathname("/health"), "http");
  assert.equal(cohortFromFetchPathname("/agencies"), "http");
  assert.equal(cohortFromFetchPathname("/searching"), "http");
  assert.equal(cohortFromFetchPathname(""), "http");
});

test("PATHNAME_COHORT_PREFIXES are real producer routes in worker/src/worker.mjs", () => {
  const producerRouter = readFileSync(path.join(ROOT, "worker/src/worker.mjs"), "utf8");
  // Exact equality routes: pathname === "/…"
  const exactRoutes = new Set(
    [...producerRouter.matchAll(/pathname\s*===\s*"(\/[^"]+)"/g)].map((m) => m[1]),
  );
  // Capability registry path: "/…" entries (health/search/nearby/events/performance-events).
  const registryPaths = new Set(
    [...producerRouter.matchAll(/\bpath:\s*"(\/[^"]+)"/g)].map((m) => m[1]),
  );
  const producerPaths = new Set([...exactRoutes, ...registryPaths]);
  assert.ok(producerPaths.has("/events"), "producer must route /events");
  assert.ok(producerPaths.has("/performance-events"), "producer must route /performance-events");
  for (const { prefix, cohort } of PATHNAME_COHORT_PREFIXES) {
    assert.ok(
      producerPaths.has(prefix),
      `PATHNAME_COHORT_PREFIXES prefix ${prefix} → ${cohort} must be a real producer route`,
    );
  }
  // RUM must not be mis-bound to analytics /events.
  const rum = PATHNAME_COHORT_PREFIXES.find((e) => e.cohort === "rum_batch_16");
  assert.equal(rum?.prefix, "/performance-events");
  const analytics = PATHNAME_COHORT_PREFIXES.find((e) => e.prefix === "/events");
  assert.equal(analytics?.cohort, "http_events");
});

test("fetch pathname cohort: /search?secret=x → search; secret never in serialized delta", () => {
  const SECRET = "pathname-secret-VALUE-7c2e";
  const item = {
    outcome: "ok",
    event: {
      request: {
        url: `https://cityscroll.org/search?q=housing&token=${SECRET}`,
        headers: { authorization: `Bearer ${SECRET}` },
      },
    },
    cpuTime: 9,
  };
  const projected = projectAllowlistedTailEvent(item);
  assert.equal(projected.accepted, true);
  assert.equal(projected.cohort, "search");
  assert.equal("url" in projected, false);
  assert.equal("request" in projected, false);
  const serialized = JSON.stringify(serializeAllowlistedDelta(projected));
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("housing"), false);
  assert.equal(serialized.includes("/search"), false);
  assert.match(serialized, /"cohort":"search"/);
});

test("hostile query/path/header values never reach AggregateSink storage JSON", async () => {
  const SECRET = "storage-leak-token-PATH-9aa1";
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, {
    readbackToken: "tok-path",
    expectedRevisions: "rev-path",
  });
  const projected = projectAllowlistedTailEvent({
    outcome: "ok",
    event: {
      request: {
        url: `https://cityscroll.org/near-you/midwood?geo=${SECRET}&token=${SECRET}`,
        headers: { cookie: `sid=${SECRET}`, "x-secret": SECRET },
      },
    },
    cpuTime: 4,
    scriptVersion: { id: "rev-path" },
  });
  assert.equal(projected.cohort, "nearby");
  const apply = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serializeAllowlistedDelta(projected)),
  }));
  assert.equal((await apply.json()).acked, true);
  const counters = await storage.get("counters");
  const meta = await storage.get("meta");
  const combined = `${JSON.stringify(counters)}\n${JSON.stringify(meta)}`;
  assert.equal(combined.includes(SECRET), false);
  assert.equal(counters.by_cohort_cpu.nearby.cpu_ms_sum, 4);
  assert.equal(counters.by_cohort_cpu.http.cpu_ms_count, 0);
});
test("unknown fetch path → http cohort", () => {
  const projected = projectAllowlistedTailEvent({
    outcome: "ok",
    event: { request: { url: "https://cityscroll.org/agencies/office-of-the-mayor/" } },
    cpuTime: 2,
  });
  assert.equal(projected.cohort, "http");
  assert.equal(serializeAllowlistedDelta(projected).cohort, "http");
});

test("coldStart 0|1 dual-records cold cohort without inventing absent zeros", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, {
    readbackToken: "tok-cold",
    expectedRevisions: "rev-cold",
  });
  const withFlag = projectAllowlistedTailEvent({
    outcome: "ok",
    event: { request: { url: "https://cityscroll.org/search?q=x" } },
    cpuTime: 10,
    coldStart: 1,
    scriptVersion: { id: "rev-cold" },
  });
  assert.equal(withFlag.cohort, "search");
  assert.equal(withFlag.cold_start_flag_raw, 1);
  assert.equal("cold_start" in withFlag, false);

  const absent = projectAllowlistedTailEvent({
    outcome: "ok",
    event: { request: { url: "https://cityscroll.org/search" } },
    cpuTime: 5,
    scriptVersion: { id: "rev-cold" },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(absent, "cold_start_flag_raw"), false);

  await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serializeAllowlistedDelta(withFlag)),
  }));
  await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(serializeAllowlistedDelta(absent)),
  }));

  const counters = await storage.get("counters");
  assert.equal(counters.events_accepted, 2);
  assert.equal(counters.cpu_ms_sum, 15, "globals must not double-count cold dual-record");
  assert.equal(counters.by_cohort_cpu.search.cpu_ms_sum, 15);
  assert.equal(counters.by_cohort_cpu.cold_start_flag_raw_1.cpu_ms_sum, 10);
  assert.equal(counters.by_cohort_cpu.cold_start_flag_raw_1.cpu_ms_count, 1);
  assert.equal(counters.by_cohort_cpu.cold_start_flag_raw_0.cpu_ms_count, 0);
  assert.equal(counters.by_cohort_cpu.cold_start_unknown.cpu_ms_count, 0);
});

test("assertNonEmptyExpectedRevisionAllowlist refuses empty allowlist", () => {
  assert.equal(assertNonEmptyExpectedRevisionAllowlist("").ok, false);
  assert.equal(assertNonEmptyExpectedRevisionAllowlist("  ,  ").ok, false);
  assert.equal(assertNonEmptyExpectedRevisionAllowlist(null).ok, false);
  const ok = assertNonEmptyExpectedRevisionAllowlist("rev-a,rev-b");
  assert.equal(ok.ok, true);
  assert.equal(ok.expected.has("rev-a"), true);
  assert.equal(mapPersistedRevision("rev-a", new Set()), "unknown");
});

test("isCollectorSelfTailItem matches scriptName / COLLECTOR_SCRIPT_NAME", () => {
  assert.equal(isCollectorSelfTailItem({ scriptName: DEFAULT_COLLECTOR_SCRIPT_NAME }, {}), true);
  assert.equal(isCollectorSelfTailItem({ scriptName: "cityscroll-worker" }, {}), false);
  assert.equal(isCollectorSelfTailItem({ scriptName: "custom-sanitizer" }, {
    COLLECTOR_SCRIPT_NAME: "custom-sanitizer",
  }), true);
  assert.equal(isCollectorSelfTailItem({ outcome: "ok" }, {}), false);
});

test("AggregateSink collector_overhead records CPU without events_seen; preserves across apply", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage, {
    readbackToken: "tok-coll",
    expectedRevisions: "rev-a",
  });

  const overhead = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true,
      collector_overhead: true,
      cpuTime: 12,
      cpu_class: "positive",
      cpu_unknown: false,
      outcome: "ok",
      eventType: "fetch",
      cohort: "collector",
    }),
  }));
  const overheadBody = await overhead.json();
  assert.equal(overheadBody.acked, true);
  assert.equal(overheadBody.collector_overhead, true);
  assert.equal(overheadBody.events_seen, 0);
  assert.equal(overheadBody.collector_cpu_ms, 12);

  let counters = await storage.get("counters");
  assert.equal(counters.events_accepted, 0);
  assert.equal(counters.events_rejected, 0);
  assert.equal(counters.collector_cpu_ms, 12);
  assert.equal(counters.by_cohort_cpu.collector.cpu_ms_sum, 12);
  assert.equal(counters.cpu_ms_sum, 0, "collector overhead must not inflate producer cpu_ms_sum");

  const producer = await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accepted: true,
      cpu_class: "positive",
      cpuTime: 3,
      outcome: "ok",
      eventType: "fetch",
      deployed_revision: "rev-a",
    }),
  }));
  const producerBody = await producer.json();
  assert.equal(producerBody.acked, true);
  assert.equal(producerBody.cost_vector.collector_cpu_ms, 12, "ordinary apply must not wipe measured collector CPU");

  counters = await storage.get("counters");
  assert.equal(counters.events_accepted, 1);
  assert.equal(counters.collector_cpu_ms, 12);
  assert.equal(counters.cpu_ms_sum, 3);

  const rb = await (await sink.fetch(new Request("https://sink/readback", {
    headers: authHeaders("tok-coll"),
  }))).json();
  assert.equal(rb.counters.collector_cpu_ms, 12);
  assert.equal(rb.overhead.collector_cpu_ms, 12);
  assert.equal(rb.events_seen, 1);
});

test("tail() self-observation posts collector_overhead without producer caps", async () => {
  const storage = createFakeStorage();
  const { env } = createFakeSinkEnv(storage, {
    readbackToken: "tok-self",
    expectedRevisions: "rev-self",
  });
  await armActiveWindow(env, "tok-self");
  const selfItem = {
    scriptName: "cityscroll-tail-sanitizer",
    outcome: "ok",
    event: { request: { url: "https://sink/apply?token=should-never-persist" } },
    get cpuTime() { return 8; },
  };
  const producerItem = {
    scriptName: "cityscroll-worker",
    outcome: "ok",
    event: { request: { url: "https://cityscroll.org/performance-events" } },
    cpuTime: 20,
    scriptVersion: { id: "rev-self" },
  };
  const batch = await workerEntrypoint.tail([selfItem, producerItem], env);
  assert.equal(batch.batch_size, 2);
  assert.equal(batch.classified, 2);
  assert.equal(batch.active_window_id, TEST_WINDOW_ID);

  const counters = await storage.get("counters");
  assert.equal(counters.events_accepted, 1);
  assert.equal(counters.collector_cpu_ms, 8);
  assert.equal(counters.by_cohort_cpu.collector.cpu_ms_sum, 8);
  assert.equal(counters.by_cohort_cpu.rum_batch_16.cpu_ms_sum, 20);
  const dumped = JSON.stringify(counters);
  assert.equal(dumped.includes("should-never-persist"), false);
  assert.equal(dumped.includes("token="), false);
});

test("per-window DO identity: new window is FRESH; old tombstone stays readable; mismatch refuses", async () => {
  const storage = createFakeStorage();
  const { env, instanceFor } = createFakeSinkEnv(storage, { readbackToken: "tok-win" });
  const winA = "window-A";
  const winB = "window-B";

  await armActiveWindow(env, "tok-win", winA);
  const sinkA = instanceFor(winA).sink;
  const applied = await sinkA.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json", [WINDOW_ID_HEADER]: winA },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 4, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-a",
    }),
  }));
  assert.equal((await applied.json()).acked, true);

  const cleaned = await workerEntrypoint.fetch(new Request("https://worker/cleanup", {
    method: "POST",
    headers: authHeaders("tok-win", winA),
  }), env);
  assert.equal(cleaned.status, 200);
  assert.equal((await cleaned.json()).tombstone, true);

  const oldRb = await (await workerEntrypoint.fetch(new Request("https://worker/readback", {
    method: "GET",
    headers: authHeaders("tok-win", winA),
  }), env)).json();
  assert.equal(oldRb.from_tombstone, true);
  assert.equal(oldRb.closed, true);
  assert.equal(oldRb.window_id, winA);

  const freshRb = await (await workerEntrypoint.fetch(new Request("https://worker/readback", {
    method: "GET",
    headers: authHeaders("tok-win", winB),
  }), env)).json();
  assert.equal(freshRb.opened, false);
  assert.equal(freshRb.closed, false);
  assert.equal(freshRb.window_id, winB);
  assert.equal(freshRb.a2.pass, null);
  assert.equal(freshRb.a2.reason, "not_evaluated");

  // Same DO storage with a mismatched window_id header refuses.
  const mismatch = await sinkA.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: authHeaders("tok-win", winB),
  }));
  assert.equal(mismatch.status, 409);
  const mismatchBody = await mismatch.json();
  assert.equal(mismatchBody.reason, "window_id_mismatch");
  assert.equal(mismatchBody.expected_window_id, winA);
});

test("closeOwnedSinkWindow: authenticated cleanup leaves TERMINAL tombstone", async () => {
  const {
    cleanupUrlFromReadbackUrl,
    closeOwnedSinkWindow,
  } = await import("../tools/lib/worker_tail_attachment.mjs");
  const storage = createFakeStorage();
  const { env, instanceFor } = createFakeSinkEnv(storage, { readbackToken: "tok-close" });
  const windowId = "close-win-1";
  await armActiveWindow(env, "tok-close", windowId);
  const sink = instanceFor(windowId).sink;
  await sink.fetch(new Request("https://sink/apply", {
    method: "POST",
    headers: { "content-type": "application/json", [WINDOW_ID_HEADER]: windowId },
    body: JSON.stringify({
      accepted: true, cpu_class: "positive", cpuTime: 2, outcome: "ok",
      eventType: "fetch", deployed_revision: "rev-a",
    }),
  }));

  const cleanupUrl = cleanupUrlFromReadbackUrl("https://worker/readback");
  assert.equal(cleanupUrl, "https://worker/cleanup");
  const closed = await closeOwnedSinkWindow({
    url: cleanupUrl,
    token: "tok-close",
    windowId,
    fetchImpl: (url, init) => workerEntrypoint.fetch(new Request(url, init), env),
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.cleaned, true);
  assert.equal(closed.tombstone, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.window_id, windowId);

  const rb = await (await workerEntrypoint.fetch(new Request("https://worker/readback", {
    method: "GET",
    headers: authHeaders("tok-close", windowId),
  }), env)).json();
  assert.equal(rb.from_tombstone, true);
  assert.equal(rb.opened == null || rb.opened === false || rb.closed === true, true);
  assert.equal(rb.closed, true);
});
