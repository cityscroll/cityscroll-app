import { createHash } from "node:crypto";

import { queueBatchFingerprint } from "../../worker/src/lib/cost_control_probe.mjs";
import {
  COST_METERS,
  OPERATION_METERS,
  REQUIRED_COST_COHORTS,
  TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY,
  WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
  buildWorkerCostProfile,
  evaluateWarehouseExperiment,
  parseColdStartFlagRaw,
  requireWarehouseColdStartFlagCapability,
  resolveWarehouseExperimentCohorts,
  sanitizeNativeInvocation,
} from "./worker_cost_control.mjs";

export const MAX_COLLECTOR_SECONDS = 30 * 60;
export const MAX_COLLECTOR_EVENTS = 10_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function applicationRecords(event, schema) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") {
      if (value.schema === schema) found.push(value);
      return;
    }
    if (typeof value === "string") {
      try { visit(JSON.parse(value)); } catch {}
    }
  };
  visit(event?.source);
  for (const log of event?.logs || event?.Logs || []) visit(log?.message ?? log?.Message);
  return found;
}

function matchingHttpReceipts(event, expectation) {
  const records = applicationRecords(event, "cityscroll.worker_cost_probe.v1");
  return records.filter((record) => (
    record.tag === expectation.header
    && record.series === expectation.series
    && record.cohort === expectation.probeCohort
    && record.workload_hash === expectation.workloadHash
    && record.result?.status === expectation.receipt.result?.status
    && record.result?.body_sha256 === expectation.receipt.result?.body_sha256
    && canonicalJson(record.result?.correctness) === canonicalJson(expectation.receipt.result?.correctness)
  ));
}

export function httpReceiptFromProviderEvent(event, expectation) {
  const records = matchingHttpReceipts(event, expectation);
  if (records.length !== 1) throw new Error("exactly one owned structured HTTP cost receipt is required");
  return records[0];
}

export function httpOperationsFromProviderEvent(event, expectation) {
  const operations = httpReceiptFromProviderEvent(event, expectation).operation_counts;
  if (!operations || Object.keys(operations).length !== OPERATION_METERS.length) {
    throw new Error("HTTP cost receipt does not contain the complete operation vector");
  }
  for (const meter of OPERATION_METERS) {
    const value = operations[meter];
    if (!value || !Number.isInteger(value.attempted) || !Number.isInteger(value.confirmed)) {
      throw new Error(`HTTP cost receipt is missing ${meter}`);
    }
  }
  return operations;
}

export async function queueFingerprintFromProviderEvent(event) {
  if (event?.$workers?.eventType !== "queue") throw new Error("provider batch evidence is not a queue invocation");
  const details = event.$workers.event;
  if (!details || !Array.isArray(details.messages) || details.messages.length !== details.batchSize) {
    throw new Error("authenticated provider batch evidence is unavailable");
  }
  const fingerprint = await queueBatchFingerprint({ queue: details.queue, messages: details.messages });
  if (!fingerprint) throw new Error("authenticated provider batch evidence is invalid");
  return fingerprint;
}

function boundedWindows(window) {
  const requested = Array.isArray(window?.windows) ? window.windows : [window];
  if (!requested.length || requested.length > 8) throw new Error("collector windows are invalid");
  const windows = requested.map((entry) => {
    const from = Date.parse(entry?.from);
    const to = Date.parse(entry?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("collector window is invalid");
    if (to - from > MAX_COLLECTOR_SECONDS * 1000) throw new Error("collector window exceeds 30 minutes");
    return { from, to };
  }).sort((left, right) => left.from - right.from);
  if (windows.at(-1).to - windows[0].from > 24 * 60 * 60 * 1000) throw new Error("collector windows exceed 24 hours");
  return windows;
}

function requireTransport(transport, methods) {
  for (const method of methods) {
    if (typeof transport?.[method] !== "function") throw new Error(`live provider transport is missing ${method}`);
  }
}

function httpRequest(event) {
  return event?.event?.request || event?.$workers?.event?.request || event?.request;
}

/**
 * Normalize classic `wrangler tail --format json` invocation objects into the
 * `$workers`-shaped envelope selectOwnedHttpEvent / sanitizeNativeInvocation expect.
 * Observability live-tail events that already carry `$workers.scriptVersion.id` pass through.
 */
export function normalizeWranglerTailEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.$workers?.scriptVersion?.id) return raw;
  const scriptVersion = raw.scriptVersion || null;
  if (!scriptVersion?.id) return null;
  const event = raw.event || null;
  const cpuTime = raw.cpuTime;
  return {
    ...raw,
    $workers: {
      cpuTimeMs: cpuTime,
      outcome: raw.outcome,
      scriptVersion,
      event,
      eventType: raw.eventType || (event?.request ? "fetch" : undefined),
    },
    $metadata: raw.$metadata || {},
    logs: raw.logs || [],
    exceptions: raw.exceptions || [],
    event,
    scriptVersion,
    cpuTime,
    outcome: raw.outcome,
  };
}

/**
 * Extract complete JSON values from a wrangler tail stdout buffer.
 * wrangler@4.x `--format json` may emit pretty-printed multi-line objects; a
 * line-oriented JSON.parse yields zero complete events (C6 Path B failure mode).
 * Accepts NDJSON one-object-per-line as well.
 */
export function parseWranglerTailJsonStream(text) {
  if (typeof text !== "string" || !text) return [];
  const values = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    if (text[i] !== "{" && text[i] !== "[") {
      // Skip non-JSON noise (wrangler banners) until the next value.
      const next = text.indexOf("{", i);
      if (next < 0) break;
      i = next;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          try {
            values.push(JSON.parse(text.slice(start, i)));
          } catch {
            /* skip malformed fragment */
          }
          break;
        }
      }
    }
    if (depth !== 0) break; // truncated trailing object
  }
  return values;
}

/** Parse + normalize a wrangler tail stdout capture into owned-matcher events. */
export function providerEventsFromWranglerTailStream(text) {
  return parseWranglerTailJsonStream(text)
    .map((raw) => normalizeWranglerTailEvent(raw))
    .filter(Boolean);
}

export function selectOwnedHttpEvent(events, expectation, cohort) {
  const coldStart = parseColdStartFlagRaw(cohort);
  const matches = events.filter((event) => {
    const request = httpRequest(event);
    const header = request?.headers?.["x-cityscroll-cost-probe"] || request?.headers?.["X-Cityscroll-Cost-Probe"];
    if (
      header !== expectation.header
      || request?.url !== expectation.outerUrl
      || request?.method !== "POST"
      || event?.$workers?.scriptVersion?.id !== expectation.providerVersionId
      || (coldStart !== null && event?.$metadata?.coldStart !== coldStart)
    ) return false;
    try { return Boolean(httpReceiptFromProviderEvent(event, expectation)); }
    catch { return false; }
  });
  if (matches.length !== 1) throw new Error(`${cohort} requires exactly one owned provider event`);
  return matches[0];
}

export async function acquireWorkerCostProfile({ revision, window, transport } = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(revision || ""))) throw new Error("revision must be a full commit SHA");
  requireTransport(transport, ["acquireDeployment", "executeFixedHttpWorkloads", "collectProviderEvents", "measurementPlan"]);
  const windows = boundedWindows(window);
  const bounds = { from: windows[0].from, to: windows.at(-1).to };
  const deployment = await transport.acquireDeployment(revision);
  const plan = await transport.measurementPlan({ revision, window: bounds });
  let httpExpectations = {};
  const baseLimit = Math.floor(MAX_COLLECTOR_EVENTS / windows.length);
  const collections = await Promise.all(windows.map((entry, index) => transport.collectProviderEvents({
    revision,
    from: entry.from,
    to: entry.to,
    limit: baseLimit + (index < MAX_COLLECTOR_EVENTS % windows.length ? 1 : 0),
    execute: index === 0 ? async (signal) => {
      httpExpectations = await transport.executeFixedHttpWorkloads({ revision, window: bounds, plan, deployment, signal });
    } : undefined,
  })));
  if (collections.some((events) => !Array.isArray(events))) throw new Error("provider event collection is unavailable");
  if (collections.some((events) => events.length > MAX_COLLECTOR_EVENTS)) throw new Error("provider collector run exceeds 10000 events");
  const events = collections.flat();
  if (events.length > MAX_COLLECTOR_EVENTS) throw new Error("provider event collection exceeds 10000 events");
  const samples = [];
  const reasons = [];
  for (const cohort of REQUIRED_COST_COHORTS) {
    try {
      if (cohort.startsWith("cron:")) {
        const cron = cohort.slice(5);
        const expectedTime = plan.scheduled_times?.[cron];
        const event = events.find((item) => item?.$workers?.eventType === "scheduled" && item?.$workers?.event?.cron === cron);
        if (!event) throw new Error("provider scheduled event is unavailable");
        samples.push(sanitizeNativeInvocation(event, {
          cohort, revision, providerDeployment: deployment, expectedCron: cron,
          expectedScheduledTime: expectedTime, expectedRunMarker: plan.run_marker,
          expectedWorkloadDigest: plan.workload_digest,
        }));
      } else if (cohort === "queue") {
        const event = events.find((item) => item?.$workers?.eventType === "queue" && item?.$workers?.event?.queue === plan.queue);
        if (!event) throw new Error("provider queue event is unavailable");
        const fingerprint = await queueFingerprintFromProviderEvent(event);
        samples.push(sanitizeNativeInvocation(event, {
          cohort, revision, providerDeployment: deployment, expectedQueue: plan.queue,
          expectedBatchSize: event.$workers.event.batchSize, expectedBatchFingerprint: fingerprint,
          expectedRunMarker: plan.run_marker, expectedWorkloadDigest: plan.workload_digest,
        }));
      } else {
        const expectation = httpExpectations?.[cohort]
          || Object.values(httpExpectations || {}).find((entry) => (
            entry?.probeCohort === cohort || entry?.receipt?.cohort === cohort
          ));
        if (!expectation) throw new Error("owned HTTP workload was not executed");
        const event = selectOwnedHttpEvent(events, expectation, cohort);
        samples.push(sanitizeNativeInvocation(event, {
          cohort, revision, providerDeployment: deployment,
          expectedHeaderValue: expectation.header, expectedUrl: expectation.outerUrl,
          expectedMethod: "POST", operations: httpOperationsFromProviderEvent(event, expectation),
          condition: { mode: "bounded-production-execution" },
        }));
      }
    } catch (error) {
      reasons.push({ cohort, reason: String(error?.message || error) });
    }
  }
  // Aggregate profile duration may span the multi-window measurement period
  // (up to 24h). Each live collector window remains ≤ MAX_COLLECTOR_SECONDS.
  const profile = buildWorkerCostProfile(samples, {
    revision, observedAt: new Date(bounds.to).toISOString(),
    durationSeconds: (bounds.to - bounds.from) / 1000, eventCount: events.length,
    providerDeployment: deployment, correctness: aggregateObservedCorrectness(httpExpectations),
  });
  return {
    schema: "cityscroll.worker_cost_acquisition.v1",
    status: profile.complete ? "complete" : "partial",
    reasons,
    profile,
  };
}

export function aggregateObservedCorrectness(expectations) {
  const entries = Object.entries(expectations || {})
    .filter(([, expectation]) => expectation?.receipt?.result?.correctness)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return {};
  const result = {};
  for (const field of ["input_digest", "joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]) {
    const values = entries.map(([cohort, expectation]) => {
      const value = expectation?.receipt?.result?.correctness?.[field];
      if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw new Error(`${cohort} is missing observed ${field}`);
      return [cohort, value];
    });
    result[field] = sha256(canonicalJson(values));
  }
  return result;
}

function resolveWarehouseAcquisitionCapability(transport, explicit) {
  if (explicit !== undefined && explicit !== null) {
    return requireWarehouseColdStartFlagCapability(explicit, "cold_start_flag_capability");
  }
  const declared = typeof transport?.warehouseColdStartFlagCapability === "function"
    ? transport.warehouseColdStartFlagCapability()
    : transport?.warehouseColdStartFlagCapability;
  if (declared !== undefined && declared !== null) {
    return requireWarehouseColdStartFlagCapability(
      declared,
      "transport.warehouseColdStartFlagCapability",
    );
  }
  // Permitted Tail source: never default carries_numeric_raw to true.
  return TAIL_WAREHOUSE_COLD_START_FLAG_CAPABILITY;
}

function warehouseRun({
  revision,
  deployment,
  observedAt,
  workloadId,
  cohorts,
  correctness,
  cold_start_flag_capability,
}) {
  const capability = requireWarehouseColdStartFlagCapability(
    cold_start_flag_capability,
    "cold_start_flag_capability",
  );
  const requiredCohorts = resolveWarehouseExperimentCohorts(capability);
  const meters = Object.fromEntries(COST_METERS.map((meter) => [meter, 0]));
  let errorCount = 0;
  let workloadCount = 0;
  for (const cohort of requiredCohorts) {
    const samples = cohorts[cohort];
    if (!Array.isArray(samples) || samples.length !== WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT) {
      throw new Error(`${cohort} does not contain the fixed sample population`);
    }
    for (const sample of samples) {
      workloadCount += 1;
      meters.native_cpu_ms += sample.native_cpu_ms;
      meters.collector_cpu_ms += sample.collector_cpu_ms;
      for (const meter of OPERATION_METERS) meters[meter] += sample.operations[meter].confirmed;
      errorCount += sample.error_count;
    }
  }
  return {
    schema: "cityscroll.warehouse_cost_experiment_run.v1", evidence_mode: "actual-production",
    deployed_revision: revision, observed_at: observedAt, workload_id: workloadId,
    workload_count: workloadCount, provider_deployment: deployment,
    cold_start_flag_capability: capability,
    // Retain every returned cohort key so fabricated raw partitions remain visible to the evaluator.
    cohorts: Object.fromEntries(Object.entries(cohorts).map(([name, samples]) => [name, { sample_count: samples.length, samples }])),
    meters, error_count: errorCount, correctness,
  };
}

/**
 * Matched warehouse experiment: ONE shared 30 min / 10,000-event budget across
 * BOTH arms (baseline then candidate). Remaining time/events are passed into
 * each collectWarehouseRun with the same AbortSignal. Exhausted budget is
 * blocked/UNKNOWN (fail closed), never a silent per-arm 60m/20k sum.
 */

function abortError(message = "shared warehouse collector budget exhausted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * Bounded race: a never-resolving callee must still stop when the signal
 * aborts. Passing signal alone is insufficient when the callee ignores it
 * (shared-deadline residual — race acquireSplitDeployments).
 */
export function raceAbortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError("deployment acquisition was cancelled"));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError("deployment acquisition was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Resolve provider event usage for the shared budget.
 * UNKNOWN is never coerced to zero.
 * Returns { kind: "known"|"lower_bound"|"unknown", used: number|null }.
 */
export function resolveProviderEventUsage(result) {
  if (!result || typeof result !== "object") {
    return { kind: "unknown", used: null };
  }
  const status = result.provider_event_count_status;
  if (status === "unknown") {
    const lower = result.provider_event_count_lower_bound;
    if (Number.isInteger(lower) && lower >= 0) {
      return { kind: "lower_bound", used: lower };
    }
    return { kind: "unknown", used: null };
  }
  if (result.provider_event_count == null && result.event_count == null
    && !Array.isArray(result.events)) {
    // Missing count after a blocked/incomplete arm: UNKNOWN, never invent 0.
    if (result.status && result.status !== "complete") {
      const lower = result.provider_event_count_lower_bound;
      if (Number.isInteger(lower) && lower >= 0) {
        return { kind: "lower_bound", used: lower };
      }
      return { kind: "unknown", used: null };
    }
  }
  const raw = result.provider_event_count
    ?? result.event_count
    ?? (Array.isArray(result.events) ? result.events.length : null);
  if (raw == null) return { kind: "unknown", used: null };
  const used = Number(raw);
  if (!Number.isFinite(used) || used < 0 || !Number.isInteger(used)) {
    return { kind: "unknown", used: null };
  }
  return { kind: "known", used };
}

export async function runMatchedWarehouseExperiment({
  baselineRevision,
  candidateRevision,
  transport,
  coldStartFlagCapability,
  signal: externalSignal = null,
  nowFn = () => Date.now(),
  maxCollectorSeconds = MAX_COLLECTOR_SECONDS,
  maxCollectorEvents = MAX_COLLECTOR_EVENTS,
} = {}) {
  requireTransport(transport, ["acquireSplitDeployments", "collectWarehouseRun"]);
  if (!Number.isFinite(maxCollectorSeconds) || maxCollectorSeconds <= 0 || maxCollectorSeconds > MAX_COLLECTOR_SECONDS) {
    throw new Error("shared warehouse collector time budget is invalid");
  }
  if (!Number.isInteger(maxCollectorEvents) || maxCollectorEvents <= 0 || maxCollectorEvents > MAX_COLLECTOR_EVENTS) {
    throw new Error("shared warehouse collector event budget is invalid");
  }

  // Whole-window deadline measured from invocation — controller/listener/timer
  // exist BEFORE acquisition so an abort during acquire cannot grant a fresh window.
  const startedMs = nowFn();
  const deadlineMs = startedMs + maxCollectorSeconds * 1000;
  const controller = new AbortController();
  const onExternalAbort = () => {
    try { controller.abort(); } catch { /* ignore */ }
  };
  if (externalSignal?.aborted) {
    return {
      schema: "cityscroll.warehouse_cost_acquisition.v1",
      status: "blocked",
      reason: "shared warehouse collector budget exhausted (cancelled before start)",
      shared_budget: {
        max_collector_seconds: maxCollectorSeconds,
        max_collector_events: maxCollectorEvents,
        events_remaining: maxCollectorEvents,
        deadline_at: new Date(deadlineMs).toISOString(),
        ledger: [],
        started_at: new Date(startedMs).toISOString(),
      },
    };
  }
  externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    try { controller.abort(); } catch { /* ignore */ }
  }, Math.max(0, deadlineMs - nowFn()));
  deadlineTimer.unref?.();

  const capability = resolveWarehouseAcquisitionCapability(transport, coldStartFlagCapability);
  const requiredCohorts = resolveWarehouseExperimentCohorts(capability);
  const workloadId = `fixed-warehouse-${sha256(requiredCohorts.join("\n"))}`;
  const budgetBase = () => ({
    max_collector_seconds: maxCollectorSeconds,
    max_collector_events: maxCollectorEvents,
    deadline_at: new Date(deadlineMs).toISOString(),
    started_at: new Date(startedMs).toISOString(),
  });

  try {
    let deployments;
    try {
      if (controller.signal.aborted || nowFn() >= deadlineMs) {
        return {
          schema: "cityscroll.warehouse_cost_acquisition.v1",
          status: "blocked",
          reason: "shared warehouse collector budget exhausted during deployment acquisition",
          shared_budget: { ...budgetBase(), events_remaining: maxCollectorEvents, ledger: [] },
        };
      }
      // Race the await against controller.signal so a signal-ignoring
      // transport cannot hang past the whole-window deadline.
      deployments = await raceAbortable(
        transport.acquireSplitDeployments({
          baselineRevision,
          candidateRevision,
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      return {
        schema: "cityscroll.warehouse_cost_acquisition.v1",
        status: "blocked",
        reason: controller.signal.aborted || /cancelled|aborted/i.test(String(error?.message || error))
          ? "shared warehouse collector budget exhausted during deployment acquisition"
          : String(error?.message || error),
        shared_budget: { ...budgetBase(), events_remaining: maxCollectorEvents, ledger: [] },
      };
    }
    // Abort during acquisition ⇒ NO arm starts.
    if (controller.signal.aborted || nowFn() >= deadlineMs) {
      return {
        schema: "cityscroll.warehouse_cost_acquisition.v1",
        status: "blocked",
        reason: "shared warehouse collector budget exhausted during deployment acquisition",
        shared_budget: { ...budgetBase(), events_remaining: maxCollectorEvents, ledger: [] },
      };
    }

    // Reserve matched cohort samples for later arms so baseline cannot consume the whole 10k.
    const minReservedPerArm = requiredCohorts.length * WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT;
    const arms = [
      ["baseline", baselineRevision],
      ["candidate", candidateRevision],
    ];
    const acquired = {};
    let eventsRemaining = maxCollectorEvents;
    const budgetLedger = [];

    for (let index = 0; index < arms.length; index += 1) {
      const [label, revision] = arms[index];
      if (controller.signal.aborted || nowFn() >= deadlineMs) {
        return {
          schema: "cityscroll.warehouse_cost_acquisition.v1",
          status: "blocked",
          reason: `shared warehouse collector budget exhausted before ${label}`,
          shared_budget: {
            ...budgetBase(),
            events_remaining: eventsRemaining,
            ledger: budgetLedger,
          },
        };
      }
      const laterArms = arms.length - index - 1;
      const reservedForLater = laterArms * minReservedPerArm;
      const armMaxEvents = eventsRemaining - reservedForLater;
      if (armMaxEvents < minReservedPerArm) {
        return {
          schema: "cityscroll.warehouse_cost_acquisition.v1",
          status: "blocked",
          reason: `shared warehouse collector event budget insufficient for ${label}`,
          shared_budget: {
            ...budgetBase(),
            events_remaining: eventsRemaining,
            reserved_for_later: reservedForLater,
            min_reserved_per_arm: minReservedPerArm,
            ledger: budgetLedger,
          },
        };
      }

      const result = await transport.collectWarehouseRun({
        label,
        revision,
        deployment: deployments[label],
        workloadId,
        cohorts: requiredCohorts,
        samplesPerCohort: WAREHOUSE_EXPERIMENT_SAMPLES_PER_COHORT,
        maxEvents: armMaxEvents,
        signal: controller.signal,
        deadlineAt: deadlineMs,
      });
      const usage = resolveProviderEventUsage(result);
      if (usage.kind === "unknown") {
        budgetLedger.push({
          label,
          max_events: armMaxEvents,
          provider_event_count: null,
          provider_event_count_status: "unknown",
          events_remaining_after: eventsRemaining,
          status: result?.status || null,
        });
        return {
          schema: "cityscroll.warehouse_cost_acquisition.v1",
          status: "blocked",
          reason: result?.reason
            ? `${result.reason}; provider event count UNKNOWN (fail-closed)`
            : `${label} provider event count UNKNOWN (fail-closed)`,
          shared_budget: {
            ...budgetBase(),
            events_remaining: eventsRemaining,
            ledger: budgetLedger,
          },
        };
      }
      const usedEvents = usage.used;
      eventsRemaining = Math.max(0, eventsRemaining - usedEvents);
      budgetLedger.push({
        label,
        max_events: armMaxEvents,
        provider_event_count: usedEvents,
        provider_event_count_status: usage.kind,
        events_remaining_after: eventsRemaining,
        status: result?.status || null,
      });

      if (!result || result.status !== "complete") {
        return {
          schema: "cityscroll.warehouse_cost_acquisition.v1",
          status: "blocked",
          reason: result?.reason || `${label} evidence unavailable`,
          shared_budget: {
            ...budgetBase(),
            events_remaining: eventsRemaining,
            ledger: budgetLedger,
          },
        };
      }
      acquired[label] = warehouseRun({
        revision,
        deployment: deployments[label],
        workloadId,
        cold_start_flag_capability: capability,
        ...result,
      });
    }

    return {
      schema: "cityscroll.warehouse_cost_acquisition.v1",
      status: "complete",
      baseline: acquired.baseline,
      candidate: acquired.candidate,
      decision: evaluateWarehouseExperiment({
        baseline: acquired.baseline,
        candidate: acquired.candidate,
        acquiredDeployments: deployments,
      }),
      shared_budget: {
        ...budgetBase(),
        events_remaining: eventsRemaining,
        ledger: budgetLedger,
      },
    };
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
  }
}
