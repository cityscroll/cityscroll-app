/**
 * In-memory aggregate sink contract for cityscroll-tail-sanitizer tests.
 * Mirrors the fixed-key Durable Object storage used by the Worker entrypoint.
 * Persist only allowlisted cohort counters — never raw Tail payloads.
 */

import {
  classifyCpuValue,
  CPU_CLASSES,
  FORBIDDEN_PERSIST_KEYS,
  projectAllowlistedTailEvent,
  serializeAllowlistedDelta,
} from "./projection.mjs";

export const AGGREGATE_SINK_SCHEMA = "cityscroll.tail_sanitizer_aggregate_sink.v1";
export const CPU_CLASS_COUNTER_KEYS = CPU_CLASSES;

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_DEADLINE_MS = 1_800_000; // 30 minutes

function emptyCounters() {
  const by_cpu_class = Object.create(null);
  for (const key of CPU_CLASS_COUNTER_KEYS) by_cpu_class[key] = 0;
  return {
    events_accepted: 0,
    events_rejected: 0,
    deltas_acked: 0,
    by_cpu_class,
    by_event_type: Object.create(null),
    by_outcome: Object.create(null),
  };
}

function eventsSeenOf(counters) {
  return (counters.events_accepted || 0) + (counters.events_rejected || 0);
}

export function createAggregateDoSink({
  sinkId = "local-tail-sanitizer-sink",
  maxEvents = DEFAULT_MAX_EVENTS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  nowMs = () => 1_700_000_000_000,
  readbackToken = null,
} = {}) {
  const openedAt = nowMs();
  let closed = false;
  let capReached = false;
  let counters = emptyCounters();
  let overhead = {
    sink_cpu_ms: "UNKNOWN",
    sink_storage_bytes: "UNKNOWN",
    sink_rpc_count: 0,
    note: "sink overhead measured or UNKNOWN; never invent billing totals",
  };
  /** Test-only: last applied serialized deltas (allowlisted shape only). */
  const appliedDeltas = [];

  const eventsSeen = () => eventsSeenOf(counters);

  const assertOpen = () => {
    if (closed) {
      const err = new Error("aggregate sink closed");
      err.code = "SINK_CLOSED";
      throw err;
    }
    if (nowMs() - openedAt > deadlineMs) {
      const err = new Error("aggregate sink deadline exceeded");
      err.code = "SINK_DEADLINE";
      throw err;
    }
    // Cap bounds ALL received/seen events (accepted + rejected). Concurrent
    // applies may briefly overshoot by at most concurrency−1; after cap_reached
    // stop accepting. Independent window expiry remains the detach fallback.
    if (capReached || eventsSeen() >= maxEvents) {
      const err = new Error("aggregate sink event cap reached");
      err.code = "SINK_CAP";
      err.cap_reached = true;
      throw err;
    }
  };

  const markCapIfReached = (result) => {
    if (eventsSeen() >= maxEvents) {
      capReached = true;
      result.cap_reached = true;
      result.trigger_owned_detach = true;
    }
    result.events_seen = eventsSeen();
    return result;
  };

  const authorize = (token) => {
    if (readbackToken == null) return true;
    return token === readbackToken;
  };

  return {
    schema: AGGREGATE_SINK_SCHEMA,
    sinkId,
    maxEvents,
    deadlineMs,
    openedAt,

    applyAllowlistedDelta(delta) {
      assertOpen();
      overhead.sink_rpc_count += 1;
      if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
        counters.events_rejected += 1;
        return markCapIfReached({ acked: false, reason: "not_object" });
      }
      for (const key of FORBIDDEN_PERSIST_KEYS) {
        if (Object.prototype.hasOwnProperty.call(delta, key)) {
          counters.events_rejected += 1;
          return markCapIfReached({ acked: false, reason: "forbidden_key", key });
        }
      }
      if (delta.accepted === false) {
        counters.events_rejected += 1;
        return markCapIfReached({ acked: false, reason: delta.reason || "not_accepted" });
      }
      if (delta.accepted !== true) {
        counters.events_rejected += 1;
        return markCapIfReached({ acked: false, reason: "not_accepted" });
      }
      const cpuClass = delta.cpu_class || classifyCpuValue(delta.cpuTime);
      if (!CPU_CLASS_COUNTER_KEYS.includes(cpuClass)) {
        counters.events_rejected += 1;
        return markCapIfReached({ acked: false, reason: "unknown_cpu_class", cpu_class: cpuClass });
      }
      const clean = serializeAllowlistedDelta({ ...delta, accepted: true, cpu_class: cpuClass });
      counters.events_accepted += 1;
      counters.deltas_acked += 1;
      counters.by_cpu_class[cpuClass] += 1;
      const eventType = typeof clean.eventType === "string" ? clean.eventType : "unknown";
      counters.by_event_type[eventType] = (counters.by_event_type[eventType] || 0) + 1;
      const outcome = clean.outcome == null ? "null" : String(clean.outcome);
      counters.by_outcome[outcome] = (counters.by_outcome[outcome] || 0) + 1;
      appliedDeltas.push(clean);
      return markCapIfReached({
        acked: true,
        events_accepted_lower_bound: counters.events_accepted,
        cpu_class: cpuClass,
      });
    },

    ingestSyntheticTailItem(item) {
      assertOpen();
      const projected = projectAllowlistedTailEvent(item);
      if (!projected.accepted) {
        counters.events_rejected += 1;
        overhead.sink_rpc_count += 1;
        return markCapIfReached({ acked: false, reason: projected.reason, projected });
      }
      const result = this.applyAllowlistedDelta(serializeAllowlistedDelta(projected));
      return { ...result, projected };
    },

    readback({ token } = {}) {
      overhead.sink_rpc_count += 1;
      if (!authorize(token)) {
        return { ok: false, reason: "unauthorized" };
      }
      const events_seen = eventsSeen();
      return {
        ok: true,
        schema: AGGREGATE_SINK_SCHEMA,
        sink_id: sinkId,
        closed,
        opened_at_ms: openedAt,
        now_ms: nowMs(),
        deadline_ms: deadlineMs,
        max_events: maxEvents,
        cap_reached: capReached || events_seen >= maxEvents,
        events_seen,
        counters: {
          ...structuredClone(counters),
          events_seen,
        },
        overhead: structuredClone(overhead),
        cpu_classes_contract: [...CPU_CLASSES],
        notes: [
          "events_accepted is an observed/acknowledged lower bound",
          "events_seen counts accepted + rejected; the cap bounds all seen events",
          "do not report CPU0 or cost0 from absent getters",
          "sink overhead is measured or UNKNOWN",
          "concurrent applies may briefly overshoot the cap by at most concurrency-1; after cap_reached stop accepting",
        ],
      };
    },

    cleanupOwned() {
      counters = emptyCounters();
      closed = true;
      capReached = false;
      appliedDeltas.length = 0;
      overhead.sink_rpc_count += 1;
      return {
        ok: true,
        cleaned: true,
        sink_id: sinkId,
        closed: true,
        counters_reset: true,
      };
    },

    snapshotForTest() {
      return {
        closed,
        cap_reached: capReached,
        events_seen: eventsSeen(),
        counters: structuredClone(counters),
        overhead: structuredClone(overhead),
        applied_deltas: structuredClone(appliedDeltas),
      };
    },
  };
}

export function createLocalTailToSinkBridge(sink) {
  return {
    async onTailBatch(events) {
      const results = [];
      for (const item of events) {
        results.push(sink.ingestSyntheticTailItem(item));
      }
      return {
        batch_size: events.length,
        acked: results.filter((r) => r.acked).length,
        rejected: results.filter((r) => !r.acked).length,
        results,
      };
    },
  };
}
