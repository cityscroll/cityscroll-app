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
  classifyCpuValue,
  cpuMsBucket,
  isCollectorSelfTailItem,
  isValidatedTailEventShape,
  mapFixedCohort,
  mapPersistedOutcome,
  mapPersistedRevision,
  parseExpectedRevisionAllowlist,
  projectAllowlistedTailEvent,
  serializeAllowlistedDelta,
} from "./projection.mjs";

export {
  assertNonEmptyExpectedRevisionAllowlist,
  cohortFromFetchPathname,
  DEFAULT_COLLECTOR_SCRIPT_NAME,
  isCollectorSelfTailItem,
  PATHNAME_COHORT_PREFIXES,
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
/** Product/schema sink name (identity binding). Per-window DO ids use window_id. */
const SINK_NAME = "cityscroll-tail-sanitizer-aggregate";
/** Fixed control DO name: stores the currently armed active window_id for Tail routing. */
const CONTROL_NAME = "cityscroll-tail-sanitizer-control";
const READBACK_HEADER = "x-cityscroll-tail-readback-token";
const WINDOW_ID_HEADER = "x-cityscroll-tail-window-id";
const TERMINAL_KEY = "terminal";
const META_KEY = "meta";
const COUNTERS_KEY = "counters";
const ACTIVE_WINDOW_KEY = "active_window";

/** Bound window_id for DO naming and auth headers. */
function parseWindowId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  // Control DO name is reserved; never treat it as a collection window.
  if (id === CONTROL_NAME) return null;
  return id;
}

function windowIdFromRequest(req) {
  return parseWindowId(req.headers.get(WINDOW_ID_HEADER) || "");
}

function windowIdMismatchResponse(expected, got) {
  return Response.json(
    {
      ok: false,
      reason: "window_id_mismatch",
      expected_window_id: expected ?? null,
      got_window_id: got ?? null,
    },
    { status: 409 },
  );
}

function windowIdRequiredResponse() {
  return Response.json(
    { ok: false, reason: "window_id_required" },
    { status: 400 },
  );
}

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
    collector_do_requests: 0,
    collector_storage_ops: 0,
    collector_cpu_ms: "UNKNOWN",
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

/**
 * A2: all-seen hard bound. events_seen above maxEvents fails; an observed
 * overshoot that was not counted (unknown/unbounded) also fails. Missing
 * samples stay UNKNOWN — never CPU 0 / never a pass from absence.
 *
 * When no collection window has been opened (`opened: false` FRESH/EMPTY
 * readback), A2 is `not_evaluated` with `pass: null` — zero events is not a
 * pass.
 */
export function evaluateAllSeenCapA2(snapshot, {
  maxEvents = MAX_EVENTS,
  opened = true,
} = {}) {
  const eventsSeen = Number(snapshot?.events_seen);
  const overshoot = snapshot?.counters?.apply_overshoot ?? snapshot?.apply_overshoot;
  const capReached = snapshot?.cap_reached === true;
  if (opened === false) {
    return {
      pass: null,
      reason: "not_evaluated",
      events_seen: Number.isFinite(eventsSeen) ? eventsSeen : (snapshot?.events_seen ?? null),
      apply_overshoot: Number.isFinite(Number(overshoot)) ? Number(overshoot) : 0,
    };
  }
  if (!Number.isFinite(eventsSeen)) {
    return {
      pass: false,
      reason: "events_seen_unknown",
      events_seen: snapshot?.events_seen ?? null,
      apply_overshoot: overshoot ?? null,
    };
  }
  if (eventsSeen > maxEvents) {
    return {
      pass: false,
      reason: "events_seen_above_all_seen_cap",
      events_seen: eventsSeen,
      max_events: maxEvents,
      apply_overshoot: Number.isFinite(overshoot) ? overshoot : null,
    };
  }
  if (capReached && (overshoot == null || !Number.isFinite(Number(overshoot)))) {
    return {
      pass: false,
      reason: "overshoot_unknown_unbounded",
      events_seen: eventsSeen,
      apply_overshoot: overshoot ?? null,
    };
  }
  return {
    pass: true,
    reason: "within_all_seen_cap",
    events_seen: eventsSeen,
    apply_overshoot: Number.isFinite(Number(overshoot)) ? Number(overshoot) : 0,
  };
}

function costVectorFrom(counters, rpcCount = null) {
  return {
    collector_do_requests: counters.collector_do_requests || 0,
    collector_storage_ops: counters.collector_storage_ops || 0,
    collector_cpu_ms: counters.collector_cpu_ms === "UNKNOWN" || counters.collector_cpu_ms == null
      ? "UNKNOWN"
      : counters.collector_cpu_ms,
    sink_rpc_count: rpcCount == null ? (counters.collector_do_requests || 0) : rpcCount,
    note: "collector DO requests/storage ops are measured ACK lower bounds; collector_cpu_ms is self-Tail sum or UNKNOWN",
  };
}

function instrumentStorage(txn, counters) {
  const bump = () => {
    counters.collector_storage_ops = (counters.collector_storage_ops || 0) + 1;
  };
  return {
    get: async (key) => {
      bump();
      return txn.get(key);
    },
    put: async (key, value) => {
      bump();
      return txn.put(key, value);
    },
    delete: async (key) => {
      bump();
      return txn.delete(key);
    },
    deleteAll: async () => {
      bump();
      return txn.deleteAll();
    },
    transaction: typeof txn.transaction === "function"
      ? (fn) => txn.transaction(fn)
      : undefined,
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
  if (counters.collector_do_requests == null) counters.collector_do_requests = 0;
  if (counters.collector_storage_ops == null) counters.collector_storage_ops = 0;
  // Preserve a measured numeric collector_cpu_ms; only default when absent.
  if (counters.collector_cpu_ms == null) counters.collector_cpu_ms = "UNKNOWN";
  return counters;
}

/**
 * Record CPU into a cohort. When includeGlobals is false (cold dual-record or
 * collector overhead), only the cohort bucket is updated — globals stay intact.
 */
function recordCpu(counters, clean, cohortKey, { includeGlobals = true } = {}) {
  const cohort = counters.by_cohort_cpu[cohortKey]
    || (counters.by_cohort_cpu[cohortKey] = emptyCohortCpu());
  const ms = clean.cpuTime;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && clean.cpu_unknown !== true) {
    if (includeGlobals) {
      counters.cpu_ms_sum += ms;
      counters.cpu_ms_count += 1;
      const bucket = cpuMsBucket(ms);
      if (bucket) {
        counters.cpu_ms_histogram[bucket] = (counters.cpu_ms_histogram[bucket] || 0) + 1;
      }
    }
    cohort.cpu_ms_sum += ms;
    cohort.cpu_ms_count += 1;
    const bucket = cpuMsBucket(ms);
    if (bucket) {
      cohort.cpu_ms_histogram[bucket] = (cohort.cpu_ms_histogram[bucket] || 0) + 1;
    }
  } else if (includeGlobals) {
    counters.cpu_ms_unknown_count += 1;
    cohort.cpu_ms_unknown_count += 1;
  } else {
    cohort.cpu_ms_unknown_count += 1;
  }
}

/** Add measured collector self-Tail CPU; never invent 0 from absence; never use wall. */
function addCollectorCpuMs(counters, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  if (counters.collector_cpu_ms === "UNKNOWN" || counters.collector_cpu_ms == null) {
    counters.collector_cpu_ms = 0;
  }
  counters.collector_cpu_ms += ms;
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

    // Control-plane active-window routes (same AggregateSink class, CONTROL_NAME DO).
    if (url.pathname === "/active-window") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      if (req.method === "GET") {
        return this.withStorageTransaction(async (txn) => {
          const active = await txn.get(ACTIVE_WINDOW_KEY);
          const windowId = typeof active?.window_id === "string" ? active.window_id : null;
          return Response.json({
            ok: true,
            window_id: windowId,
            armed: Boolean(windowId),
            armed_at_ms: active?.armed_at_ms ?? null,
          });
        });
      }
      if (req.method === "PUT" || req.method === "POST") {
        const windowId = windowIdFromRequest(req);
        if (!windowId) return windowIdRequiredResponse();
        return this.withStorageTransaction(async (txn) => {
          const record = { window_id: windowId, armed_at_ms: Date.now() };
          await txn.put(ACTIVE_WINDOW_KEY, record);
          return Response.json({ ok: true, armed: true, window_id: windowId });
        });
      }
      if (req.method === "DELETE") {
        const windowId = windowIdFromRequest(req);
        if (!windowId) return windowIdRequiredResponse();
        return this.withStorageTransaction(async (txn) => {
          const active = await txn.get(ACTIVE_WINDOW_KEY);
          const current = typeof active?.window_id === "string" ? active.window_id : null;
          if (current && current !== windowId) {
            return Response.json({
              ok: true,
              cleared: false,
              reason: "active_window_mismatch",
              active_window_id: current,
            });
          }
          if (typeof txn.delete === "function") await txn.delete(ACTIVE_WINDOW_KEY);
          else await txn.put(ACTIVE_WINDOW_KEY, null);
          return Response.json({ ok: true, cleared: true, window_id: windowId });
        });
      }
      return Response.json({ ok: false, reason: "method_not_allowed" }, { status: 405 });
    }

    // Auth-gated routes: authorize BEFORE any storage access so unauthenticated
    // polling never opens a window or creates cost. window_id is required so
    // each collection window maps to its own DO (idFromName(window_id)).
    if (url.pathname === "/readback" && req.method === "GET") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      const requestWindowId = windowIdFromRequest(req);
      if (!requestWindowId) return windowIdRequiredResponse();
      return this.withStorageTransaction(async (rawTxn) => {
        const scratch = emptyCounters();
        const txn = instrumentStorage(rawTxn, scratch);
        const terminal = await txn.get(TERMINAL_KEY);
        if (terminal && terminal.closed === true) {
          if (
            typeof terminal.window_id === "string"
            && terminal.window_id
            && terminal.window_id !== requestWindowId
          ) {
            return windowIdMismatchResponse(terminal.window_id, requestWindowId);
          }
          terminal.rpc_count = (terminal.rpc_count || 0) + 1;
          if (!terminal.window_id) terminal.window_id = requestWindowId;
          await txn.put(TERMINAL_KEY, terminal);
          const tombCounters = emptyCounters();
          tombCounters.collector_do_requests = terminal.rpc_count;
          tombCounters.collector_storage_ops = scratch.collector_storage_ops;
          const snapshot = {
            ok: true,
            schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
            sink_name: SINK_NAME,
            window_id: terminal.window_id || requestWindowId,
            closed: true,
            from_tombstone: true,
            opened_at_ms: terminal.opened_at_ms ?? null,
            closed_at_ms: terminal.closed_at_ms ?? null,
            deadline_ms: terminal.deadline_ms ?? DEFAULT_DEADLINE_MS,
            max_events: terminal.max_events ?? MAX_EVENTS,
            cap_reached: terminal.cap_reached === true,
            events_seen: 0,
            counters: tombCounters,
            cost_vector: costVectorFrom(tombCounters, terminal.rpc_count),
            overhead: {
              sink_cpu_ms: "UNKNOWN",
              sink_storage_bytes: "UNKNOWN",
              sink_rpc_count: terminal.rpc_count,
              collector_do_requests: terminal.rpc_count,
              collector_storage_ops: scratch.collector_storage_ops,
              collector_cpu_ms: "UNKNOWN",
              note: "collector DO cost counted as ACK lower bounds; CPU stays UNKNOWN unless measured",
            },
            a2: evaluateAllSeenCapA2({
              events_seen: 0,
              cap_reached: terminal.cap_reached === true,
              apply_overshoot: 0,
            }, { maxEvents: terminal.max_events ?? MAX_EVENTS }),
          };
          return Response.json(snapshot);
        }
        let meta = await txn.get(META_KEY);
        if (!meta) {
          // Honest unopened / FRESH response: configured limits + known-0
          // counters + A2, bound to the requested window_id DO. Guardian READY
          // polls this before producer attach; do not require traffic or meta.
          const freshCounters = emptyCounters();
          return Response.json({
            ok: true,
            schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
            sink_name: SINK_NAME,
            window_id: requestWindowId,
            closed: false,
            opened: false,
            deadline_ms: DEFAULT_DEADLINE_MS,
            max_events: MAX_EVENTS,
            counters: freshCounters,
            events_seen: 0,
            apply_overshoot: 0,
            cap_reached: false,
            cost_vector: costVectorFrom(freshCounters, 0),
            a2: evaluateAllSeenCapA2({
              events_seen: 0,
              cap_reached: false,
              apply_overshoot: 0,
            }, { maxEvents: MAX_EVENTS, opened: false }),
            note: "no window open",
          });
        }
        if (
          typeof meta.window_id === "string"
          && meta.window_id
          && meta.window_id !== requestWindowId
        ) {
          return windowIdMismatchResponse(meta.window_id, requestWindowId);
        }
        if (!meta.window_id) meta.window_id = requestWindowId;
        meta.rpc_count = (meta.rpc_count || 0) + 1;
        const counters = backfillCounters((await txn.get(COUNTERS_KEY)) || emptyCounters());
        counters.collector_do_requests = meta.rpc_count;
        counters.collector_storage_ops = (counters.collector_storage_ops || 0) + scratch.collector_storage_ops;
        // Never reset a measured collector_cpu_ms back to UNKNOWN on readback.
        await txn.put(META_KEY, meta);
        await txn.put(COUNTERS_KEY, counters);
        const events_seen = eventsSeenOf(counters);
        const maxEvents = meta.max_events || MAX_EVENTS;
        const cap_reached = meta.cap_reached === true || events_seen >= maxEvents;
        const a2 = evaluateAllSeenCapA2({
          events_seen,
          cap_reached,
          apply_overshoot: counters.apply_overshoot,
          counters,
        }, { maxEvents });
        const collectorCpu = counters.collector_cpu_ms === "UNKNOWN" || counters.collector_cpu_ms == null
          ? "UNKNOWN"
          : counters.collector_cpu_ms;
        return Response.json({
          ok: true,
          schema: "cityscroll.tail_sanitizer_aggregate_sink.v1",
          sink_name: SINK_NAME,
          window_id: meta.window_id || requestWindowId,
          closed: meta.closed === true,
          from_tombstone: false,
          opened_at_ms: meta.opened_at_ms,
          closed_at_ms: meta.closed_at_ms ?? null,
          deadline_ms: meta.deadline_ms,
          max_events: maxEvents,
          cap_reached,
          events_seen,
          counters: { ...counters, events_seen },
          cost_vector: costVectorFrom(counters, meta.rpc_count),
          a2,
          overhead: {
            sink_cpu_ms: "UNKNOWN",
            sink_storage_bytes: "UNKNOWN",
            sink_rpc_count: meta.rpc_count,
            collector_do_requests: counters.collector_do_requests,
            collector_storage_ops: counters.collector_storage_ops,
            collector_cpu_ms: collectorCpu,
            note: "collector DO cost counted as ACK lower bounds; collector CPU is measured self-Tail sum or UNKNOWN",
          },
          notes: [
            "events_accepted is an observed/acknowledged lower bound",
            "events_seen counts accepted + rejected + dropped_after_cap",
            "cpu_ms_sum/count only include finite numeric cpuTime; missing/invalid stay UNKNOWN",
            "do not report CPU0 or cost0 from absent getters",
            "collector observed_count 0 is measured zero; missing provider/queue/cohort samples stay UNKNOWN",
            "by_deployed_revision keys are the configured expected-version allowlist only",
            "A2 fails when events_seen exceeds the all-seen cap or overshoot is unknown/unbounded",
            "collector_overhead applies bump collector_cpu_ms and collector cohort without events_seen",
          ],
        });
      });
    }

    if (url.pathname === "/cleanup" && req.method === "POST") {
      if (!this.authorize(req)) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      const requestWindowId = windowIdFromRequest(req);
      if (!requestWindowId) return windowIdRequiredResponse();
      return this.withStorageTransaction(async (txn) => {
        const prior = await txn.get(META_KEY);
        const priorTerminal = await txn.get(TERMINAL_KEY);
        if (
          typeof prior?.window_id === "string"
          && prior.window_id
          && prior.window_id !== requestWindowId
        ) {
          return windowIdMismatchResponse(prior.window_id, requestWindowId);
        }
        if (
          typeof priorTerminal?.window_id === "string"
          && priorTerminal.window_id
          && priorTerminal.window_id !== requestWindowId
        ) {
          return windowIdMismatchResponse(priorTerminal.window_id, requestWindowId);
        }
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
          window_id: prior?.window_id || priorTerminal?.window_id || requestWindowId,
          schema: "cityscroll.tail_sanitizer_terminal_tombstone.v1",
        };
        await txn.put(TERMINAL_KEY, tombstone);
        return Response.json({
          ok: true,
          cleaned: true,
          counters_reset: true,
          closed: true,
          tombstone: true,
          window_id: tombstone.window_id,
        });
      });
    }

    if (url.pathname === "/apply" && req.method === "POST") {
      // Parse payload BEFORE any storage RMW so concurrent handlers cannot
      // interleave mid-update across a body await.
      const delta = await req.json().catch(() => null);
      const expectedRevisions = expectedRevisionSet(this.env);
      const applyWindowId = windowIdFromRequest(req);

      return this.withStorageTransaction(async (rawTxn) => {
        const storageScratch = emptyCounters();
        const txn = instrumentStorage(rawTxn, storageScratch);
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
            window_id: applyWindowId || null,
          };
        } else if (
          applyWindowId
          && typeof meta.window_id === "string"
          && meta.window_id
          && meta.window_id !== applyWindowId
        ) {
          return windowIdMismatchResponse(meta.window_id, applyWindowId);
        } else if (applyWindowId && !meta.window_id) {
          meta.window_id = applyWindowId;
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
        counters.collector_do_requests = meta.rpc_count;
        counters.collector_storage_ops = (counters.collector_storage_ops || 0)
          + storageScratch.collector_storage_ops;
        // Preserve measured collector_cpu_ms across ordinary applies.
        // Reset scratch so subsequent instrumented ops in this txn are added once more at persist.
        storageScratch.collector_storage_ops = 0;
        const maxEvents = meta.max_events || MAX_EVENTS;
        const seenBefore = eventsSeenOf(counters);

        // Collector self-Tail overhead: record CPU without producer event caps.
        if (delta && typeof delta === "object" && delta.collector_overhead === true) {
          for (const key of FORBIDDEN_PERSIST_KEYS) {
            if (Object.prototype.hasOwnProperty.call(delta, key)) {
              counters.collector_storage_ops = (counters.collector_storage_ops || 0)
                + storageScratch.collector_storage_ops;
              storageScratch.collector_storage_ops = 0;
              await txn.put(META_KEY, meta);
              await txn.put(COUNTERS_KEY, counters);
              return Response.json({ acked: false, reason: "forbidden_key", key, collector_overhead: true });
            }
          }
          if (delta.accepted === true) {
            const ms = delta.cpuTime;
            if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && delta.cpu_unknown !== true) {
              addCollectorCpuMs(counters, ms);
            }
            recordCpu(counters, {
              cpuTime: delta.cpuTime,
              cpu_unknown: delta.cpu_unknown === true,
            }, "collector", { includeGlobals: false });
          }
          counters.collector_storage_ops = (counters.collector_storage_ops || 0)
            + storageScratch.collector_storage_ops;
          storageScratch.collector_storage_ops = 0;
          counters.collector_do_requests = meta.rpc_count;
          await txn.put(META_KEY, meta);
          await txn.put(COUNTERS_KEY, counters);
          const events_seen = eventsSeenOf(counters);
          return Response.json({
            acked: delta.accepted === true,
            collector_overhead: true,
            events_seen,
            collector_cpu_ms: counters.collector_cpu_ms,
            cost_vector: costVectorFrom(counters, meta.rpc_count),
            a2: evaluateAllSeenCapA2({
              events_seen,
              cap_reached: meta.cap_reached === true,
              apply_overshoot: counters.apply_overshoot,
              counters,
            }, { maxEvents }),
          });
        }

        if (delta && typeof delta === "object" && delta.reason === "dropped_after_cap") {
          const n = Number.isFinite(delta.dropped_count) ? Math.max(0, Math.floor(delta.dropped_count)) : 0;
          counters.events_dropped_after_cap += n;
          meta.cap_reached = true;
          counters.collector_storage_ops = (counters.collector_storage_ops || 0)
            + storageScratch.collector_storage_ops;
          storageScratch.collector_storage_ops = 0;
          await txn.put(META_KEY, meta);
          await txn.put(COUNTERS_KEY, counters);
          const events_seen = eventsSeenOf(counters);
          return Response.json({
            acked: false,
            reason: "dropped_after_cap",
            cap_reached: true,
            events_seen,
            events_dropped_after_cap: counters.events_dropped_after_cap,
            trigger_owned_detach: true,
            cost_vector: costVectorFrom(counters, meta.rpc_count),
            a2: evaluateAllSeenCapA2({
              events_seen,
              cap_reached: true,
              apply_overshoot: counters.apply_overshoot,
              counters,
            }, { maxEvents }),
          });
        }

        if (meta.cap_reached === true || seenBefore >= maxEvents) {
          meta.cap_reached = true;
          // A late concurrent apply that still reaches the sink after the cap
          // is an explicit overshoot observation (counted, not accepted).
          counters.apply_overshoot += 1;
          counters.events_rejected += 1;
          counters.collector_storage_ops = (counters.collector_storage_ops || 0)
            + storageScratch.collector_storage_ops;
          storageScratch.collector_storage_ops = 0;
          await txn.put(META_KEY, meta);
          await txn.put(COUNTERS_KEY, counters);
          const events_seen = eventsSeenOf(counters);
          return Response.json(
            {
              acked: false,
              reason: "SINK_CAP",
              cap_reached: true,
              events_seen,
              apply_overshoot: counters.apply_overshoot,
              trigger_owned_detach: true,
              cost_vector: costVectorFrom(counters, meta.rpc_count),
              a2: evaluateAllSeenCapA2({
                events_seen,
                cap_reached: true,
                apply_overshoot: counters.apply_overshoot,
                counters,
              }, { maxEvents }),
            },
            { status: 409 },
          );
        }

        const persist = async (result) => {
          counters.collector_storage_ops = (counters.collector_storage_ops || 0)
            + storageScratch.collector_storage_ops;
          storageScratch.collector_storage_ops = 0;
          counters.collector_do_requests = meta.rpc_count;
          // Preserve measured collector_cpu_ms; never wipe to UNKNOWN here.
          const events_seen = eventsSeenOf(counters);
          if (events_seen >= maxEvents) {
            meta.cap_reached = true;
            result.cap_reached = true;
            result.trigger_owned_detach = true;
          }
          result.events_seen = events_seen;
          result.cost_vector = costVectorFrom(counters, meta.rpc_count);
          result.a2 = evaluateAllSeenCapA2({
            events_seen,
            cap_reached: meta.cap_reached === true,
            apply_overshoot: counters.apply_overshoot,
            counters,
          }, { maxEvents });
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
        // Dual-record raw coldStart partition without replacing the primary cohort.
        if (clean.cold_start_flag_raw === 0 || clean.cold_start_flag_raw === 1) {
          const coldKey = clean.cold_start_flag_raw === 0
            ? "cold_start_flag_raw_0"
            : "cold_start_flag_raw_1";
          recordCpu(counters, clean, coldKey, { includeGlobals: false });
        }

        return persist({
          acked: true,
          events_accepted_lower_bound: counters.events_accepted,
          cpu_class: cpuClass,
          cpu_ms_sum: counters.cpu_ms_sum,
          cpu_ms_count: counters.cpu_ms_count,
          deployed_revision: revisionKey,
          cohort: cohortKey,
          cold_start_flag_raw: (clean.cold_start_flag_raw === 0 || clean.cold_start_flag_raw === 1)
            ? clean.cold_start_flag_raw
            : null,
        });
      });
    }

    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
}

function sinkStub(env, windowId) {
  const id = env.AGG_SINK.idFromName(windowId);
  return env.AGG_SINK.get(id);
}

function controlStub(env) {
  const id = env.AGG_SINK.idFromName(CONTROL_NAME);
  return env.AGG_SINK.get(id);
}

async function resolveActiveWindowId(env) {
  const stub = controlStub(env);
  const token = env.READBACK_TOKEN || "";
  const res = await stub.fetch("https://sink/active-window", {
    method: "GET",
    headers: { [READBACK_HEADER]: token },
  });
  if (!res || res.ok !== true) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return parseWindowId(body?.window_id || "");
}

async function setActiveWindowId(env, windowId, token) {
  const stub = controlStub(env);
  return stub.fetch("https://sink/active-window", {
    method: "PUT",
    headers: {
      [READBACK_HEADER]: token,
      [WINDOW_ID_HEADER]: windowId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ window_id: windowId }),
  });
}

async function clearActiveWindowIdIfMatch(env, windowId, token) {
  const stub = controlStub(env);
  return stub.fetch("https://sink/active-window", {
    method: "DELETE",
    headers: {
      [READBACK_HEADER]: token,
      [WINDOW_ID_HEADER]: windowId,
    },
  });
}

function applyHeaders(windowId) {
  const headers = { "content-type": "application/json" };
  if (windowId) headers[WINDOW_ID_HEADER] = windowId;
  return headers;
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
        note: "use /readback with authenticated header + window_id; allowlisted aggregate only",
      });
    }
    if (url.pathname === "/arm" && req.method === "POST") {
      const token = req.headers.get(READBACK_HEADER) || "";
      const windowId = windowIdFromRequest(req);
      if (!windowId) return windowIdRequiredResponse();
      // Authorize via control DO (same token contract as readback).
      const armed = await setActiveWindowId(env, windowId, token);
      if (armed.status === 401) {
        return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
      }
      // Touch the per-window DO so a subsequent readback is FRESH for this id.
      const stub = sinkStub(env, windowId);
      await stub.fetch("https://sink/readback", {
        method: "GET",
        headers: {
          [READBACK_HEADER]: token,
          [WINDOW_ID_HEADER]: windowId,
        },
      });
      let body = null;
      try {
        body = await armed.json();
      } catch {
        body = { ok: false, reason: "arm_response_unparsed" };
      }
      return Response.json(
        { ok: body?.ok === true, armed: body?.armed === true, window_id: windowId },
        { status: armed.status },
      );
    }
    if (url.pathname === "/aggregate" || url.pathname === "/readback") {
      const windowId = windowIdFromRequest(req);
      if (!windowId) return windowIdRequiredResponse();
      const stub = sinkStub(env, windowId);
      const token = req.headers.get(READBACK_HEADER) || "";
      return stub.fetch("https://sink/readback", {
        method: "GET",
        headers: {
          [READBACK_HEADER]: token,
          [WINDOW_ID_HEADER]: windowId,
        },
      });
    }
    if (url.pathname === "/cleanup" && req.method === "POST") {
      const windowId = windowIdFromRequest(req);
      if (!windowId) return windowIdRequiredResponse();
      const stub = sinkStub(env, windowId);
      const token = req.headers.get(READBACK_HEADER) || "";
      const cleaned = await stub.fetch("https://sink/cleanup", {
        method: "POST",
        headers: {
          [READBACK_HEADER]: token,
          [WINDOW_ID_HEADER]: windowId,
        },
      });
      if (cleaned.ok) {
        // Best-effort: clear control active pointer when it still names this window.
        await clearActiveWindowIdIfMatch(env, windowId, token);
      }
      return cleaned;
    }
    if (url.pathname === "/active-window") {
      const stub = controlStub(env);
      const token = req.headers.get(READBACK_HEADER) || "";
      const windowId = req.headers.get(WINDOW_ID_HEADER) || "";
      const headers = { [READBACK_HEADER]: token };
      if (windowId) headers[WINDOW_ID_HEADER] = windowId;
      return stub.fetch(`https://sink/active-window`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.text(),
      });
    }
    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  },

  async tail(events, env) {
    const activeWindowId = await resolveActiveWindowId(env);
    if (!activeWindowId) {
      return {
        batch_size: events.length,
        classified: 0,
        dropped_after_cap: 0,
        dropped_no_active_window: true,
        owned_detach: { actuated: false, reason: "no_active_window" },
      };
    }
    const stub = sinkStub(env, activeWindowId);
    let stopFurtherApply = false;
    let droppedAfterCap = 0;
    let detachSignal = null;
    const batchResults = [];

    for (const item of events) {
      // Collector self-Tail: allowlisted cpu/outcome only → collector_overhead.
      // Does not count toward producer events_seen / events_accepted caps.
      if (isCollectorSelfTailItem(item, env)) {
        let cpuTime;
        let cpuThrown = false;
        try {
          cpuTime = item.cpuTime;
        } catch {
          cpuThrown = true;
          cpuTime = undefined;
        }
        const cpuClass = cpuThrown ? "undefined" : classifyCpuValue(cpuTime);
        let outcomeRaw = null;
        try {
          outcomeRaw = item.outcome ?? item.Outcome;
        } catch {
          outcomeRaw = null;
        }
        let eventType = "unknown";
        try {
          const event = item.event ?? item.Event;
          if (event && typeof event === "object") {
            if ("request" in event) eventType = "fetch";
            else if ("cron" in event || "scheduledTime" in event) eventType = "scheduled";
            else if ("queue" in event || "batchSize" in event) eventType = "queue";
            else eventType = "other";
          }
        } catch {
          eventType = "unknown";
        }
        const selfDelta = {
          accepted: true,
          collector_overhead: true,
          cpuTime: (!cpuThrown && typeof cpuTime === "number" && Number.isFinite(cpuTime))
            ? cpuTime
            : null,
          cpu_class: cpuClass,
          cpu_unknown: cpuThrown || !(typeof cpuTime === "number" && Number.isFinite(cpuTime)),
          outcome: ALLOWED_OUTCOMES.has(outcomeRaw)
            ? outcomeRaw
            : (outcomeRaw == null ? null : "other"),
          eventType,
          cohort: "collector",
        };
        const selfRes = await stub.fetch("https://sink/apply", {
          method: "POST",
          headers: applyHeaders(activeWindowId),
          body: JSON.stringify(selfDelta),
        });
        let selfBody = null;
        try {
          selfBody = await selfRes.json();
        } catch {
          selfBody = { acked: false, reason: "apply_response_unparsed" };
        }
        batchResults.push({
          classified: true,
          applied: true,
          collector_overhead: true,
          body: selfBody,
          delta: selfDelta,
        });
        // Self-overhead never triggers producer cap detach or stopFurtherApply.
        continue;
      }

      // Classify every received producer item — accepted or rejected shape.
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
        headers: applyHeaders(activeWindowId),
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
        headers: applyHeaders(activeWindowId),
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
      active_window_id: activeWindowId,
      owned_detach: detach,
    };
  },
};
