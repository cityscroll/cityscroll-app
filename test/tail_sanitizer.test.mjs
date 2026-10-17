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
  createNdjsonFramer,
  FORBIDDEN_PERSIST_KEYS,
  isValidatedTailEventShape,
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

test("hard cap refuses further accepts after maxEvents", () => {
  const sink = createAggregateDoSink({ sinkId: "cap", maxEvents: 2 });
  assert.equal(sink.applyAllowlistedDelta({
    accepted: true, cpu_class: "zero", outcome: "ok", eventType: "fetch",
  }).acked, true);
  assert.equal(sink.applyAllowlistedDelta({
    accepted: true, cpu_class: "positive", outcome: "ok", eventType: "fetch",
  }).acked, true);
  assert.throws(
    () => sink.applyAllowlistedDelta({
      accepted: true, cpu_class: "positive", outcome: "ok", eventType: "fetch",
    }),
    (err) => err.code === "SINK_CAP",
  );
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
