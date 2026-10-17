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
  ALLOWED_OUTCOMES,
  CPU_MS_BUCKETS,
  FIXED_COHORT_KEYS,
  FORBIDDEN_PERSIST_KEYS,
  cpuMsBucket,
  isValidatedTailEventShape,
  mapFixedCohort,
  mapPersistedOutcome,
  mapPersistedRevision,
  parseExpectedRevisionAllowlist,
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

const EVENT_TYPE_KEYS = Object.freeze(["fetch", "scheduled", "queue", "other", "unknown"]);

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

function emptyFixedCohortCpu() {
  const by = Object.create(null);
  for (const key of FIXED_COHORT_KEYS) by[key] = emptyCohortCpu();
  return by;
}

function emptyCounters() {
  const by_cpu_class = Object.create(null);
  for (const k of CPU_CLASS_KEYS) by_cpu_class[k] = 0;
  const by_event_type = Object.create(null);
  for (const k of EVENT_TYPE_KEYS) by_event_type[k] = 0;
  const by_outcome = Object.create(null);
  for (const k of ALLOWED_OUTCOMES) by_outcome[k] = 0;
  by_outcome.other = 0;
  by_outcome.null = 0;
  const by_deployed_revision = Object.create(null);
  by_deployed_revision.unknown = 0;
  by_deployed_revision.other = 0;
  return {
    events_accepted: 0,
    events_rejected: 0,
    events_dropped_after_cap: 0,
    deltas_acked: 0,
    apply_overshoot: 0,
    by_cpu_class,
    by_event_type,
    by_outcome,
    by_deployed_revision,
    cpu_ms_sum: 0,
    cpu_ms_count: 0,
    cpu_ms_unknown_count: 0,
    cpu_ms_histogram: emptyCpuHistogram(),
    by_cohort_cpu: emptyFixedCohortCpu(),
  };
}

function eventsSeenOf(counters) {
  return (counters.events_accepted || 0)
    + (counters.events_rejected || 0)
    + (counters.events_dropped_after_cap || 0);
}

function backfillCounters(counters) {
  if (!counters.cpu_ms_histogram) counters.cpu_ms_histogram = emptyCpuHistogram();
  if (!counters.by_cohort_cpu) counters.by_cohort_cpu = emptyFixedCohortCpu();
  for (const key of FIXED_COHORT_KEYS) {
    if (!counters.by_cohort_cpu[key]) counters.by_cohort_cpu[key] = emptyCohortCpu();
  }
  if (!counters.by_deployed_revision) {
    counters.by_deployed_revision = Object.create(null);
    counters.by_deployed_revision.unknown = 0;
    counters.by_deployed_revision.other = 0;
  }
  if (!counters.by_event_type) {
    counters.by_event_type = Object.create(null);
    for (const k of EVENT_TYPE_KEYS) counters.by_event_type[k] = 0;
  }
  if (!counters.by_outcome) {
    counters.by_outcome = Object.create(null);
    for (const k of ALLOWED_OUTCOMES) counters.by_outcome[k] = 0;
    counters.by_outcome.other = 0;
    counters.by_outcome.null = 0;
  }
  if (counters.cpu_ms_sum == null) counters.cpu_ms_sum = 0;
  if (counters.cpu_ms_count == null) counters.cpu_ms_count = 0;
  if (counters.cpu_ms_unknown_count == null) counters.cpu_ms_unknown_count = 0;
  if (counters.events_dropped_after_cap == null) counters.events_dropped_after_cap = 0;
  if (counters.apply_overshoot == null) counters.apply_overshoot = 0;
  return counters;
}

function recordCpu(counters, clean, cohortKey) {
  const cohort = counters.by_cohort_cpu[cohortKey]
    || (counters.by_cohort_cpu[cohortKey] = emptyCohortCpu());
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

function expectedRevisionSet(env) {
  return parseExpectedRevisionAllowlist(env?.EXPECTED_DEPLOYED_REVISIONS);
}

/**
 * Optional owned-detach actuator binding. Production collectors wire this to
 * the Tail-attachment emergency detach path; absent binding stays honest.
 */
export async function actuateOwnedDetachFromCapSignal(env, signal = {}) {
  if (!signal || signal.trigger_owned_detach !== true) {
    return { actuated: false, reason: "not_signaled" };
  }
  const actuator = env?.OWNED_DETACH_ACTUATOR;
  if (!actuator || typeof actuator.fetch !== "function") {
    return { actuated: false, reason: "no_actuator_bound" };
  }
  const res = await actuator.fetch("https://detach/owned-cap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reason: "sink_cap",
      events_seen: signal.events_seen ?? null,
      cap_reached: true,
    }),
  });
  return { actuated: true, status: res.status };
}

/**
 * Durable Object: fixed-key aggregate sink shared across isolates.
 * Never stores raw Tail items.
 *
 * Apply path parses the request body BEFORE the storage read-modify-write,
 * then runs the RMW inside storage.transaction so concurrent handlers cannot
 * interleave mid-update (input gates only cover awaits during storage I/O).
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

  async withStorageTransaction(fn) {
    const storage = this.state.storage;
    if (typeof storage.transaction === "function") {
      return storage.transaction((txn) => fn(txn));
    }
    // Local unit fakes may omit transaction; fall back to direct storage.
    return fn(storage);
  }

  async fetch(req) {
    const url = new URL(req.url);

    // Auth-gated routes: authorize BEFORE any storage access so unauthenticated
    // polling never opens a window or creates cost.
    if (url.pathname === "/readback" && req.method === "GET") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      return this.withStorageTransaction(async (txn) => {
        const terminal = await txn.get(TERMINAL_KEY);
        if (terminal && terminal.closed === true) {
          terminal.rpc_count = (terminal.rpc_count || 0) + 1;
          await txn.put(TERMINAL_KEY, terminal);
          return Response.json({
            ok: true,
            schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
            closed: true,
            from_tombstone: true,
            opened_at_ms: terminal.opened_at_ms ?? null,
            closed_at_ms: terminal.closed_at_ms ?? null,
            deadline_ms: terminal.deadline_ms ?? DEFAULT_DEADLINE_MS,
            max_events: terminal.max_events ?? MAX_EVENTS,
            cap_reached: terminal.cap_reached === true,
            events_seen: 0,
            counters: emptyCounters(),
            overhead: {
              sink_cpu_ms: "UNKNOWN",
              sink_storage_bytes: "UNKNOWN",
              sink_rpc_count: terminal.rpc_count,
              note: "sink overhead measured or UNKNOWN; aggregate counts are observed lower bounds",
            },
          });
        }
        let meta = await txn.get(META_KEY);
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
        await txn.put(META_KEY, meta);
        const counters = backfillCounters((await txn.get(COUNTERS_KEY)) || emptyCounters());
        const events_seen = eventsSeenOf(counters);
        const cap_reached = meta.cap_reached === true || events_seen >= (meta.max_events || MAX_EVENTS);
        return Response.json({
          ok: true,
          schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
          closed: meta.closed === true,
          from_tombstone: false,
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
            "events_seen counts accepted + rejected + dropped_after_cap",
            "cpu_ms_sum/count only include finite numeric cpuTime; missing/invalid stay UNKNOWN",
            "do not report CPU0 or cost0 from absent getters",
            "by_deployed_revision keys are the configured expected-version allowlist only",
          ],
        });
      });
    }

    if (url.pathname === "/cleanup" && req.method === "POST") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      return this.withStorageTransaction(async (txn) => {
        const prior = await txn.get(META_KEY);
        const priorTerminal = await txn.get(TERMINAL_KEY);
        const closedAt = Date.now();
        if (typeof txn.deleteAll === "function") await txn.deleteAll();
        else {
          await txn.delete?.(META_KEY);
          await txn.delete?.(COUNTERS_KEY);
          await txn.delete?.(TERMINAL_KEY);
        }
        const tombstone = {
          closed: true,
          closed_at_ms: closedAt,
          opened_at_ms: prior?.opened_at_ms ?? priorTerminal?.opened_at_ms ?? null,
          deadline_ms: prior?.deadline_ms ?? priorTerminal?.deadline_ms ?? DEFAULT_DEADLINE_MS,
          max_events: prior?.max_events ?? priorTerminal?.max_events ?? MAX_EVENTS,
          cap_reached: prior?.cap_reached === true || priorTerminal?.cap_reached === true,
          rpc_count: ((prior?.rpc_count || priorTerminal?.rpc_count || 0) + 1),
          schema: "cityscroll.tail_sanitizer_terminal_tombstone.v1",
        };
        await txn.put(TERMINAL_KEY, tombstone);
        return Response.json({
          ok: true,
          cleaned: true,
          counters_reset: true,
          closed: true,
          tombstone: true,
        });
      });
    }

    if (url.pathname === "/apply" && req.method === "POST") {
      // Parse payload BEFORE any storage RMW so concurrent handlers cannot
      // interleave mid-update across a body await.
      const delta = await req.json().catch(() => null);
      const expectedRevisions = expectedRevisionSet(this.env);

      return this.withStorageTransaction(async (txn) => {
        const terminal = await txn.get(TERMINAL_KEY);
        if (terminal && terminal.closed === true) {
          return Response.json(
            { acked: false, reason: "SINK_CLOSED", closed: true, from_tombstone: true },
            { status: 409 },
          );
        }

        let meta = await txn.get(META_KEY);
        if (!meta) {
          meta = {
            opened_at_ms: Date.now(),
            deadline_ms: DEFAULT_DEADLINE_MS,
            max_events: MAX_EVENTS,
            closed: false,
            cap_reached: false,
            rpc_count: 0,
          };
        }
        meta.rpc_count = (meta.rpc_count || 0) + 1;

        if (meta.closed) {
          await txn.put(META_KEY, meta);
          return Response.json({ acked: false, reason: "SINK_CLOSED" }, { status: 409 });
        }
        if (Date.now() - meta.opened_at_ms > meta.deadline_ms) {
          await txn.put(META_KEY, meta);
          return Response.json({ acked: false, reason: "SINK_DEADLINE" }, { status: 409 });
        }

        let counters = backfillCounters((await txn.get(COUNTERS_KEY)) || emptyCounters());
        const maxEvents = meta.max_events || MAX_EVENTS;
        const seenBefore = eventsSeenOf(counters);

        if (delta && typeof delta === "object" && delta.reason === "dropped_after_cap") {
          const n = Number.isFinite(delta.dropped_count) ? Math.max(0, Math.floor(delta.dropped_count)) : 0;
          counters.events_dropped_after_cap += n;
          meta.cap_reached = true;
          await txn.put(META_KEY, meta);
          await txn.put(COUNTERS_KEY, counters);
          return Response.json({
            acked: false,
            reason: "dropped_after_cap",
            cap_reached: true,
            events_seen: eventsSeenOf(counters),
            events_dropped_after_cap: counters.events_dropped_after_cap,
            trigger_owned_detach: true,
          });
        }

        if (meta.cap_reached === true || seenBefore >= maxEvents) {
          meta.cap_reached = true;
          // A late concurrent apply that still reaches the sink after the cap
          // is an explicit overshoot observation (counted, not accepted).
          counters.apply_overshoot += 1;
          counters.events_rejected += 1;
          await txn.put(META_KEY, meta);
          await txn.put(COUNTERS_KEY, counters);
          return Response.json(
            {
              acked: false,
              reason: "SINK_CAP",
              cap_reached: true,
              events_seen: eventsSeenOf(counters),
              apply_overshoot: counters.apply_overshoot,
              trigger_owned_detach: true,
            },
            { status: 409 },
          );
        }

        const persist = async (result) => {
          const events_seen = eventsSeenOf(counters);
          if (events_seen >= maxEvents) {
            meta.cap_reached = true;
            result.cap_reached = true;
            result.trigger_owned_detach = true;
          }
          result.events_seen = events_seen;
          await txn.put(META_KEY, meta);
          await txn.put(COUNTERS_KEY, counters);
          return Response.json(result);
        };

        if (!delta || typeof delta !== "object" || delta.accepted !== true) {
          counters.events_rejected += 1;
          return persist({ acked: false, reason: "not_accepted" });
        }
        for (const key of FORBIDDEN_PERSIST_KEYS) {
          if (Object.prototype.hasOwnProperty.call(delta, key)) {
            counters.events_rejected += 1;
            return persist({ acked: false, reason: "forbidden_key", key });
          }
        }

        const clean = serializeAllowlistedDelta(delta);
        const cpuClass = CPU_CLASS_KEYS.includes(clean.cpu_class) ? clean.cpu_class : "type_other";
        const eventType = EVENT_TYPE_KEYS.includes(clean.eventType) ? clean.eventType : "unknown";
        const outcome = mapPersistedOutcome(clean.outcome);
        const revisionKey = mapPersistedRevision(clean.deployed_revision, expectedRevisions);
        const cohortKey = mapFixedCohort({
          eventType,
          cron: clean.cron,
          cohort: clean.cohort,
        });

        counters.events_accepted += 1;
        counters.deltas_acked += 1;
        counters.by_cpu_class[cpuClass] = (counters.by_cpu_class[cpuClass] || 0) + 1;
        counters.by_event_type[eventType] = (counters.by_event_type[eventType] || 0) + 1;
        counters.by_outcome[outcome] = (counters.by_outcome[outcome] || 0) + 1;
        counters.by_deployed_revision[revisionKey] =
          (counters.by_deployed_revision[revisionKey] || 0) + 1;
        recordCpu(counters, clean, cohortKey);

        return persist({
          acked: true,
          events_accepted_lower_bound: counters.events_accepted,
          cpu_class: cpuClass,
          cpu_ms_sum: counters.cpu_ms_sum,
          cpu_ms_count: counters.cpu_ms_count,
          deployed_revision: revisionKey,
          cohort: cohortKey,
        });
      });
    }

    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
}

function sinkStub(env) {
  const id = env.AGG_SINK.idFromName(SINK_NAME);
  return env.AGG_SINK.get(id);
}

function isTerminalSinkRefusal(body) {
  return body
    && (body.reason === "SINK_CAP"
      || body.reason === "SINK_CLOSED"
      || body.reason === "SINK_DEADLINE"
      || body.reason === "dropped_after_cap"
      || body.cap_reached === true);
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
    let stopFurtherApply = false;
    let droppedAfterCap = 0;
    let detachSignal = null;
    const batchResults = [];

    for (const item of events) {
      // Classify every received item first — accepted or rejected shape.
      let delta;
      if (!isValidatedTailEventShape(item)) {
        delta = { accepted: false, reason: "not_validated_tail_event_shape" };
      } else {
        const projected = projectAllowlistedTailEvent(item);
        delta = serializeAllowlistedDelta(projected);
      }

      if (stopFurtherApply) {
        droppedAfterCap += 1;
        batchResults.push({ classified: true, applied: false, dropped_after_cap: true, delta });
        continue;
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
      batchResults.push({ classified: true, applied: true, body, delta });

      if (body?.trigger_owned_detach === true) {
        detachSignal = body;
      }
      // Keep applying rejects so they count toward all-seen. Stop only on
      // terminal sink refusal (cap/closed/deadline) so remaining items drop
      // without extra RPCs.
      if (isTerminalSinkRefusal(body)) {
        stopFurtherApply = true;
      }
    }

    if (droppedAfterCap > 0) {
      await stub.fetch("https://sink/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accepted: false,
          reason: "dropped_after_cap",
          dropped_count: droppedAfterCap,
        }),
      });
    }

    let detach = { actuated: false, reason: "not_signaled" };
    if (detachSignal) {
      detach = await actuateOwnedDetachFromCapSignal(env, detachSignal);
    }

    return {
      batch_size: events.length,
      classified: batchResults.length,
      dropped_after_cap: droppedAfterCap,
      owned_detach: detach,
    };
  },
};
