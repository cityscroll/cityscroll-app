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
  classifyCpuValue,
  cpuMsBucket,
  createNdjsonFramer,
  FORBIDDEN_PERSIST_KEYS,
  isValidatedTailEventShape,
  makeGetterOnlyTraceItem,
  makeLazyCpuTraceItem,
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
  return {
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
    writeCount() { return writes; },
    keys() { return [...map.keys()].sort(); },
  };
}

/**
 * Durable Object request handling is single-threaded per object. Serialize
 * stub.fetch so concurrent Promise.all exercises the ALL-seen cap under the
 * same queueing semantics instead of last-write-wins on shared Map state.
 */
function createSerializedSink(sink) {
  let chain = Promise.resolve();
  return {
    async fetch(req) {
      const run = chain.then(() => sink.fetch(req));
      // Keep the queue alive even when a handler rejects.
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

function createFakeSinkEnv(storage, { readbackToken = "owned-readback" } = {}) {
  const sink = new AggregateSink({ storage }, { READBACK_TOKEN: readbackToken });
  const serialized = createSerializedSink(sink);
  const stub = {
    async fetch(url, init = {}) {
      const req = new Request(url, init);
      return serialized.fetch(req);
    },
  };
  return {
    sink: serialized,
    storage,
    env: {
      READBACK_TOKEN: readbackToken,
      AGG_SINK: {
        idFromName() { return { name: "cityscroll-tail-sanitizer-aggregate" }; },
        get() { return stub; },
      },
    },
  };
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
  const res = await sink.fetch(new Request("https://sink/readback", { method: "GET" }));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "unauthorized");
  assert.equal(storage.writeCount(), 0);
  assert.deepEqual(storage.keys(), []);
});

test("AggregateSink: ALL-seen cap + tail() stops on non-ACK", async () => {
  const storage = createFakeStorage();
  const { env, sink } = createFakeSinkEnv(storage);
  // Seed max_events=2 via first opens, then force small cap by applying through sink
  // with a custom meta — open via apply then patch meta.
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
  // Shrink cap to 2 for the rest of the test.
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

  const writesBeforeTail = storage.writeCount();
  const batch = [
    makeGetterOnlyTraceItem({ cpuTime: 1, scriptVersionId: "rev-b" }),
    makeGetterOnlyTraceItem({ cpuTime: 2, scriptVersionId: "rev-b" }),
    makeGetterOnlyTraceItem({ cpuTime: 3, scriptVersionId: "rev-b" }),
  ];
  await workerEntrypoint.tail(batch, env);
  // Cap already reached: tail should stop after first non-ACK without counting three accepts.
  const counters = await storage.get("counters");
  assert.equal(counters.events_accepted, 1);
  assert.equal(counters.events_rejected, 1);
  assert.equal(eventsSeenHelper(counters), 2);
  // Some apply attempts may write meta/counters on SINK_CAP; must not accept more.
  assert.ok(storage.writeCount() >= writesBeforeTail);
});

function eventsSeenHelper(c) {
  return (c.events_accepted || 0) + (c.events_rejected || 0);
}

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
    headers: { "x-cityscroll-tail-readback-token": "tok" },
  }));
  assert.equal(cleaned.status, 200);
  const cleanedBody = await cleaned.json();
  assert.equal(cleanedBody.closed, true);
  assert.equal(cleanedBody.tombstone, true);
  assert.deepEqual(storage.keys(), ["terminal"]);

  const readback = await sink.fetch(new Request("https://sink/readback", {
    method: "GET",
    headers: { "x-cityscroll-tail-readback-token": "tok" },
  }));
  const rb = await readback.json();
  assert.equal(rb.ok, true);
  assert.equal(rb.closed, true);
  assert.equal(rb.from_tombstone, true);
  assert.deepEqual(storage.keys().sort(), ["terminal"]);
  assert.equal(storage.keys().includes("meta"), false);
  assert.equal(storage.keys().includes("counters"), false);

  // Stale apply must not reopen.
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
  const { sink } = createFakeSinkEnv(storage, { readbackToken: "tok" });
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
    headers: { "x-cityscroll-tail-readback-token": "tok" },
  }))).json();
  assert.equal(rb.counters.by_cpu_class.positive, 2);
  assert.equal(rb.counters.cpu_ms_sum, 101);
  assert.equal(rb.counters.cpu_ms_count, 2);
  assert.equal(rb.counters.cpu_ms_histogram["0_1"], 1);
  assert.equal(rb.counters.cpu_ms_histogram["10_100"], 1);
  assert.equal(rb.counters.by_cohort_cpu.fetch.cpu_ms_sum, 101);
  assert.equal(rb.counters.by_deployed_revision["rev-cpu"], 2);
  assert.equal(cpuMsBucket(1), "0_1");
  assert.equal(cpuMsBucket(100), "10_100");
});

test("AggregateSink: concurrent applies honor ALL-seen cap with bounded overshoot", async () => {
  const storage = createFakeStorage();
  const { sink } = createFakeSinkEnv(storage);
  // Open + set cap 5.
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
  const seen = eventsSeenHelper(counters);
  // Serialized DO queue: seed(1) + 4 accepts fill cap 5; remaining get SINK_CAP.
  // The accept that fills the cap returns acked=true with cap_reached=true.
  assert.equal(seen, 5, `seen=${seen}`);
  const acked = results.filter((r) => r.acked).length;
  assert.equal(acked, 4);
  const cappedRefused = results.filter((r) => r.acked === false && (r.reason === "SINK_CAP" || r.cap_reached === true));
  assert.equal(cappedRefused.length, 4);
  assert.equal(results.filter((r) => r.acked === true && r.cap_reached === true).length, 1);
});
