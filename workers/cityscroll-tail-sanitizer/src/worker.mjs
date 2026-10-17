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
  CPU_MS_BUCKETS,
  FORBIDDEN_PERSIST_KEYS,
  cpuMsBucket,
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
const TERMINAL_KEY = "terminal";
const META_KEY = "meta";
const COUNTERS_KEY = "counters";

function emptyCpuHistogram() {
  const h = Object.create(null);
  for (const b of CPU_MS_BUCKETS) h[b] = 0;
  return h;
}

function emptyCohortCpu() {
  return {
    cpu_ms_sum: 0,
    cpu_ms_count: 0,
    cpu_ms_unknown_count: 0,
    cpu_ms_histogram: emptyCpuHistogram(),
  };
}

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
    by_deployed_revision: Object.create(null),
    // Bounded real CPU sums — only finite numeric cpuTime contributes.
    cpu_ms_sum: 0,
    cpu_ms_count: 0,
    cpu_ms_unknown_count: 0,
    cpu_ms_histogram: emptyCpuHistogram(),
    by_cohort_cpu: {
      fetch: emptyCohortCpu(),
      scheduled: emptyCohortCpu(),
      queue: emptyCohortCpu(),
      other: emptyCohortCpu(),
      unknown: emptyCohortCpu(),
    },
  };
}

function eventsSeenOf(counters) {
  return (counters.events_accepted || 0) + (counters.events_rejected || 0);
}

function recordCpu(counters, clean) {
  const cohortKey = ["fetch", "scheduled", "queue", "other"].includes(clean.eventType)
    ? clean.eventType
    : "unknown";
  const cohort = counters.by_cohort_cpu[cohortKey] || (counters.by_cohort_cpu[cohortKey] = emptyCohortCpu());
  const ms = clean.cpuTime;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && clean.cpu_unknown !== true) {
    counters.cpu_ms_sum += ms;
    counters.cpu_ms_count += 1;
    cohort.cpu_ms_sum += ms;
    cohort.cpu_ms_count += 1;
    const bucket = cpuMsBucket(ms);
    if (bucket) {
      counters.cpu_ms_histogram[bucket] = (counters.cpu_ms_histogram[bucket] || 0) + 1;
      cohort.cpu_ms_histogram[bucket] = (cohort.cpu_ms_histogram[bucket] || 0) + 1;
    }
  } else {
    counters.cpu_ms_unknown_count += 1;
    cohort.cpu_ms_unknown_count += 1;
  }
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

  authorize(req) {
    const expected = this.env.READBACK_TOKEN;
    if (!expected || expected === "unset") return false;
    const got = req.headers.get(READBACK_HEADER) || "";
    return got === expected;
  }

  async readTerminal() {
    return await this.state.storage.get(TERMINAL_KEY);
  }

  /**
   * Open or load the active window. A durable terminal tombstone means the
   * window is closed forever for this sink id — never silently reopen.
   */
  async loadMeta({ allowCreate = false } = {}) {
    const terminal = await this.readTerminal();
    if (terminal && terminal.closed === true) {
      return {
        closed: true,
        from_tombstone: true,
        opened_at_ms: terminal.opened_at_ms ?? null,
        closed_at_ms: terminal.closed_at_ms ?? null,
        deadline_ms: terminal.deadline_ms ?? DEFAULT_DEADLINE_MS,
        max_events: terminal.max_events ?? MAX_EVENTS,
        cap_reached: terminal.cap_reached === true,
        rpc_count: terminal.rpc_count || 0,
      };
    }
    let meta = await this.state.storage.get(META_KEY);
    if (!meta) {
      if (!allowCreate) {
        return null;
      }
      meta = {
        opened_at_ms: Date.now(),
        deadline_ms: DEFAULT_DEADLINE_MS,
        max_events: MAX_EVENTS,
        closed: false,
        cap_reached: false,
        rpc_count: 0,
      };
      await this.state.storage.put(META_KEY, meta);
    }
    return meta;
  }

  async saveMeta(meta) {
    await this.state.storage.put(META_KEY, meta);
  }

  async loadCounters({ allowCreate = false } = {}) {
    let counters = await this.state.storage.get(COUNTERS_KEY);
    if (!counters) {
      if (!allowCreate) return null;
      counters = emptyCounters();
      await this.state.storage.put(COUNTERS_KEY, counters);
    }
    // Backfill newer fields for older in-memory fixtures.
    if (!counters.cpu_ms_histogram) counters.cpu_ms_histogram = emptyCpuHistogram();
    if (!counters.by_cohort_cpu) {
      counters.by_cohort_cpu = {
        fetch: emptyCohortCpu(),
        scheduled: emptyCohortCpu(),
        queue: emptyCohortCpu(),
        other: emptyCohortCpu(),
        unknown: emptyCohortCpu(),
      };
    }
    if (!counters.by_deployed_revision) counters.by_deployed_revision = Object.create(null);
    if (counters.cpu_ms_sum == null) counters.cpu_ms_sum = 0;
    if (counters.cpu_ms_count == null) counters.cpu_ms_count = 0;
    if (counters.cpu_ms_unknown_count == null) counters.cpu_ms_unknown_count = 0;
    return counters;
  }

  async saveCounters(counters) {
    await this.state.storage.put(COUNTERS_KEY, counters);
  }

  async fetch(req) {
    const url = new URL(req.url);

    // Auth-gated routes: authorize BEFORE any storage access so unauthenticated
    // polling never opens a window or creates cost.
    if (url.pathname === "/readback" && req.method === "GET") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      const meta = await this.loadMeta({ allowCreate: false });
      if (!meta) {
        return Response.json({
          ok: true,
          schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
          closed: false,
          opened: false,
          counters: emptyCounters(),
          events_seen: 0,
          cap_reached: false,
          note: "no window open",
        });
      }
      meta.rpc_count = (meta.rpc_count || 0) + 1;
      if (!meta.from_tombstone) await this.saveMeta(meta);
      else {
        // Persist rpc bump on tombstone only (no reopen).
        const terminal = await this.readTerminal();
        if (terminal) {
          terminal.rpc_count = meta.rpc_count;
          await this.state.storage.put(TERMINAL_KEY, terminal);
        }
      }
      const counters = (await this.loadCounters({ allowCreate: false })) || emptyCounters();
      const events_seen = eventsSeenOf(counters);
      const cap_reached = meta.cap_reached === true || events_seen >= (meta.max_events || MAX_EVENTS);
      return Response.json({
        ok: true,
        schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
        closed: meta.closed === true,
        from_tombstone: meta.from_tombstone === true,
        opened_at_ms: meta.opened_at_ms,
        closed_at_ms: meta.closed_at_ms ?? null,
        deadline_ms: meta.deadline_ms,
        max_events: meta.max_events,
        cap_reached,
        events_seen,
        counters: { ...counters, events_seen },
        overhead: {
          sink_cpu_ms: "UNKNOWN",
          sink_storage_bytes: "UNKNOWN",
          sink_rpc_count: meta.rpc_count,
          note: "sink overhead measured or UNKNOWN; aggregate counts are observed lower bounds",
        },
        notes: [
          "events_accepted is an observed/acknowledged lower bound",
          "events_seen counts accepted + rejected; the cap bounds all seen events",
          "cpu_ms_sum/count only include finite numeric cpuTime; missing/invalid stay UNKNOWN",
          "do not report CPU0 or cost0 from absent getters",
        ],
      });
    }

    if (url.pathname === "/cleanup" && req.method === "POST") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      const prior = await this.loadMeta({ allowCreate: false });
      const closedAt = Date.now();
      // Durable terminal tombstone AFTER clear so deleteAll cannot erase closure.
      await this.state.storage.deleteAll();
      const tombstone = {
        closed: true,
        closed_at_ms: closedAt,
        opened_at_ms: prior?.opened_at_ms ?? null,
        deadline_ms: prior?.deadline_ms ?? DEFAULT_DEADLINE_MS,
        max_events: prior?.max_events ?? MAX_EVENTS,
        cap_reached: prior?.cap_reached === true,
        rpc_count: (prior?.rpc_count || 0) + 1,
        schema: "cityscroll.tail_sanitizer_terminal_tombstone.v1",
      };
      await this.state.storage.put(TERMINAL_KEY, tombstone);
      return Response.json({
        ok: true,
        cleaned: true,
        counters_reset: true,
        closed: true,
        tombstone: true,
      });
    }

    if (url.pathname === "/apply" && req.method === "POST") {
      // Explicit CAS open: create meta only on apply when no tombstone.
      const terminal = await this.readTerminal();
      if (terminal && terminal.closed === true) {
        return Response.json(
          { acked: false, reason: "SINK_CLOSED", closed: true, from_tombstone: true },
          { status: 409 },
        );
      }
      const meta = await this.loadMeta({ allowCreate: true });
      meta.rpc_count = (meta.rpc_count || 0) + 1;
      await this.saveMeta(meta);

      if (meta.closed) {
        return Response.json({ acked: false, reason: "SINK_CLOSED" }, { status: 409 });
      }
      if (Date.now() - meta.opened_at_ms > meta.deadline_ms) {
        return Response.json({ acked: false, reason: "SINK_DEADLINE" }, { status: 409 });
      }

      const counters = await this.loadCounters({ allowCreate: true });
      const seenBefore = eventsSeenOf(counters);
      // Cap bounds ALL received/seen events. Concurrent applies may briefly
      // overshoot by at most concurrency−1; after cap_reached stop accepting.
      if (meta.cap_reached === true || seenBefore >= meta.max_events) {
        meta.cap_reached = true;
        await this.saveMeta(meta);
        return Response.json(
          {
            acked: false,
            reason: "SINK_CAP",
            cap_reached: true,
            events_seen: seenBefore,
            trigger_owned_detach: true,
          },
          { status: 409 },
        );
      }

      const finish = async (result) => {
        const events_seen = eventsSeenOf(counters);
        if (events_seen >= meta.max_events) {
          meta.cap_reached = true;
          result.cap_reached = true;
          result.trigger_owned_detach = true;
          await this.saveMeta(meta);
        }
        result.events_seen = events_seen;
        await this.saveCounters(counters);
        return Response.json(result);
      };

      const delta = await req.json().catch(() => null);
      if (!delta || typeof delta !== "object" || delta.accepted !== true) {
        counters.events_rejected += 1;
        return finish({ acked: false, reason: "not_accepted" });
      }
      for (const key of FORBIDDEN_PERSIST_KEYS) {
        if (Object.prototype.hasOwnProperty.call(delta, key)) {
          counters.events_rejected += 1;
          return finish({ acked: false, reason: "forbidden_key", key });
        }
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
      if (typeof clean.deployed_revision === "string" && clean.deployed_revision.length > 0) {
        counters.by_deployed_revision[clean.deployed_revision] =
          (counters.by_deployed_revision[clean.deployed_revision] || 0) + 1;
      }
      recordCpu(counters, clean);
      return finish({
        acked: true,
        events_accepted_lower_bound: counters.events_accepted,
        cpu_class: cpuClass,
        cpu_ms_sum: counters.cpu_ms_sum,
        cpu_ms_count: counters.cpu_ms_count,
        deployed_revision: clean.deployed_revision,
      });
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
      let delta;
      if (!isValidatedTailEventShape(item)) {
        delta = { accepted: false, reason: "not_validated_tail_event_shape" };
      } else {
        const projected = projectAllowlistedTailEvent(item);
        delta = serializeAllowlistedDelta(projected);
      }
      const res = await stub.fetch("https://sink/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delta),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = { acked: false, reason: "apply_response_unparsed" };
      }
      // Stop ingesting this batch on non-ACK (cap, closed, deadline, reject storm).
      if (!body || body.acked !== true) {
        break;
      }
    }
  },
};
