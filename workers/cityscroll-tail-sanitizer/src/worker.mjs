/**
 * cityscroll-tail-sanitizer — production Tail consumer.
 *
 * Positive-allowlist projection only. Drop URLs, query strings, headers,
 * bodies, and identifiers before any persistence. Keep fixed cohort labels
 * plus native cpu/outcome/revision-presence and aggregate counts.
 * Reject empty {} and non-invocation events. Observability stays disabled
 * in wrangler.toml (no [observability] block). Authenticated aggregate
 * readback via Durable Object sink.
 */

import {
  FORBIDDEN_PERSIST_KEYS,
  isValidatedTailEventShape,
  projectAllowlistedTailEvent,
  serializeAllowlistedDelta,
} from "./projection.mjs";

const CPU_CLASS_KEYS = [
  "undefined",
  "null",
  "nan",
  "zero",
  "positive",
  "negative",
  "nonfinite",
  "type_other",
];

const MAX_EVENTS = 10_000;
const DEFAULT_DEADLINE_MS = 1_800_000;
const SINK_NAME = "cityscroll-tail-sanitizer-aggregate";
const READBACK_HEADER = "x-cityscroll-tail-readback-token";

function emptyCounters() {
  const by_cpu_class = Object.create(null);
  for (const k of CPU_CLASS_KEYS) by_cpu_class[k] = 0;
  return {
    events_accepted: 0,
    events_rejected: 0,
    deltas_acked: 0,
    by_cpu_class,
    by_event_type: Object.create(null),
    by_outcome: Object.create(null),
  };
}

/**
 * Durable Object: fixed-key aggregate sink shared across isolates.
 * Never stores raw Tail items.
 */
export class AggregateSink {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async ensureMeta() {
    let meta = await this.state.storage.get("meta");
    if (!meta) {
      meta = {
        opened_at_ms: Date.now(),
        deadline_ms: DEFAULT_DEADLINE_MS,
        max_events: MAX_EVENTS,
        closed: false,
        rpc_count: 0,
      };
      await this.state.storage.put("meta", meta);
    }
    return meta;
  }

  async ensureCounters() {
    let counters = await this.state.storage.get("counters");
    if (!counters) {
      counters = emptyCounters();
      await this.state.storage.put("counters", counters);
    }
    return counters;
  }

  authorize(req) {
    const expected = this.env.READBACK_TOKEN;
    if (!expected || expected === "unset") return false;
    const got = req.headers.get(READBACK_HEADER) || "";
    return got === expected;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const meta = await this.ensureMeta();
    meta.rpc_count = (meta.rpc_count || 0) + 1;
    await this.state.storage.put("meta", meta);

    if (url.pathname === "/apply" && req.method === "POST") {
      if (meta.closed) {
        return Response.json({ acked: false, reason: "SINK_CLOSED" }, { status: 409 });
      }
      if (Date.now() - meta.opened_at_ms > meta.deadline_ms) {
        return Response.json({ acked: false, reason: "SINK_DEADLINE" }, { status: 409 });
      }
      const delta = await req.json().catch(() => null);
      if (!delta || typeof delta !== "object" || delta.accepted !== true) {
        const counters = await this.ensureCounters();
        counters.events_rejected += 1;
        await this.state.storage.put("counters", counters);
        return Response.json({ acked: false, reason: "not_accepted" });
      }
      for (const key of FORBIDDEN_PERSIST_KEYS) {
        if (Object.prototype.hasOwnProperty.call(delta, key)) {
          const counters = await this.ensureCounters();
          counters.events_rejected += 1;
          await this.state.storage.put("counters", counters);
          return Response.json({ acked: false, reason: "forbidden_key", key });
        }
      }
      const counters = await this.ensureCounters();
      if (counters.events_accepted >= meta.max_events) {
        return Response.json({ acked: false, reason: "SINK_CAP" }, { status: 409 });
      }
      const clean = serializeAllowlistedDelta(delta);
      const cpuClass = CPU_CLASS_KEYS.includes(clean.cpu_class) ? clean.cpu_class : "type_other";
      counters.events_accepted += 1;
      counters.deltas_acked += 1;
      counters.by_cpu_class[cpuClass] = (counters.by_cpu_class[cpuClass] || 0) + 1;
      const eventType = typeof clean.eventType === "string" ? clean.eventType : "unknown";
      counters.by_event_type[eventType] = (counters.by_event_type[eventType] || 0) + 1;
      const outcome = clean.outcome == null ? "null" : String(clean.outcome);
      counters.by_outcome[outcome] = (counters.by_outcome[outcome] || 0) + 1;
      await this.state.storage.put("counters", counters);
      return Response.json({
        acked: true,
        events_accepted_lower_bound: counters.events_accepted,
        cpu_class: cpuClass,
      });
    }

    if (url.pathname === "/readback" && req.method === "GET") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      const counters = await this.ensureCounters();
      return Response.json({
        ok: true,
        schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
        closed: meta.closed === true,
        opened_at_ms: meta.opened_at_ms,
        deadline_ms: meta.deadline_ms,
        max_events: meta.max_events,
        counters,
        overhead: {
          sink_cpu_ms: "UNKNOWN",
          sink_storage_bytes: "UNKNOWN",
          sink_rpc_count: meta.rpc_count,
          note: "sink overhead measured or UNKNOWN; aggregate counts are observed lower bounds",
        },
        notes: [
          "events_accepted is an observed/acknowledged lower bound",
          "do not report CPU0 or cost0 from absent getters",
        ],
      });
    }

    if (url.pathname === "/cleanup" && req.method === "POST") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      await this.state.storage.put("counters", emptyCounters());
      meta.closed = true;
      await this.state.storage.put("meta", meta);
      await this.state.storage.deleteAll();
      return Response.json({ ok: true, cleaned: true, counters_reset: true, closed: true });
    }

    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
}

function sinkStub(env) {
  const id = env.AGG_SINK.idFromName(SINK_NAME);
  return env.AGG_SINK.get(id);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        worker: "cityscroll-tail-sanitizer",
        observability_config: "absent-disabled",
        note: "use /readback with authenticated header; allowlisted aggregate only",
      });
    }
    if (url.pathname === "/aggregate" || url.pathname === "/readback") {
      const stub = sinkStub(env);
      const token = req.headers.get(READBACK_HEADER) || "";
      return stub.fetch("https://sink/readback", {
        method: "GET",
        headers: { [READBACK_HEADER]: token },
      });
    }
    if (url.pathname === "/cleanup" && req.method === "POST") {
      const stub = sinkStub(env);
      const token = req.headers.get(READBACK_HEADER) || "";
      return stub.fetch("https://sink/cleanup", {
        method: "POST",
        headers: { [READBACK_HEADER]: token },
      });
    }
    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  },

  async tail(events, env) {
    const stub = sinkStub(env);
    for (const item of events) {
      // Reject empty {} / non-invocation before any sink write.
      if (!isValidatedTailEventShape(item)) {
        await stub.fetch("https://sink/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accepted: false, reason: "not_validated_tail_event_shape" }),
        });
        continue;
      }
      const projected = projectAllowlistedTailEvent(item);
      const delta = serializeAllowlistedDelta(projected);
      await stub.fetch("https://sink/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delta),
      });
    }
  },
};
