#!/usr/bin/env node

/**
 * Build deterministic merge-queue telemetry from a normalized source snapshot.
 *
 * The collector deliberately has no wall-clock default. A scheduled caller
 * supplies an observed_at value in the source snapshot; replaying that same
 * snapshot therefore produces byte-identical receipts and dashboard output.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const CLASS_IDS = new Set([
  "arm-time-thrash",
  "flaky-shard-ejection",
  "generated-file-conflict",
  "live-external-coupling",
  "long-pole-serial-check",
  "runner-pool-contention",
  "shared-gate-rot",
]);
const SOURCE_SCHEMA = "cityscroll.merge-throughput.source.v1";
const TELEMETRY_SCHEMA = "cityscroll.merge-throughput.telemetry.v1";
const RECEIPT_SCHEMA = "cityscroll.merge-throughput.telemetry.receipt.v1";

function fail(message) {
  throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : canonicalJson(value));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function timestamp(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (!isIso(value)) fail(`${label}: expected an ISO timestamp`);
  return Date.parse(value);
}

function number(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}: expected a finite number`);
  return value;
}

function metric(value, measurement, basis, extra = {}) {
  return { value, measurement, basis, ...extra };
}

function round(value, digits = 4) {
  if (value == null) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function inWindow(ms, start, end) {
  return ms >= start && ms < end;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}: expected a non-empty string`);
  return value;
}

function validateSource(source) {
  if (source?.schema !== SOURCE_SCHEMA) fail(`invalid source schema: expected ${SOURCE_SCHEMA}`);
  requireString(source.repository, "repository");
  requireString(source.source_run_id, "source_run_id");
  const observedAt = timestamp(source.observed_at, "observed_at");
  const sourceMeasurement = source.measurement ?? "measured";
  if (!["measured", "estimated"].includes(sourceMeasurement)) fail("measurement must be measured or estimated");
  const windowStart = timestamp(source.window?.started_at, "window.started_at");
  const windowEnd = timestamp(source.window?.ended_at, "window.ended_at");
  if (windowEnd <= windowStart) fail("window must end after it starts");
  if (observedAt < windowEnd) fail("observed_at must be at or after the observation window");

  const requiredChecks = source.required_checks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) fail("required_checks must be non-empty");
  if (new Set(requiredChecks).size !== requiredChecks.length || requiredChecks.some((name) => !String(name).trim())) {
    fail("required_checks must contain unique non-empty names");
  }

  if (!Array.isArray(source.pull_requests) || source.pull_requests.length === 0) fail("pull_requests must be non-empty");
  const prs = new Map();
  for (const [index, pr] of source.pull_requests.entries()) {
    const label = `pull_requests[${index}]`;
    if (!Number.isInteger(pr.number) || pr.number <= 0) fail(`${label}.number: expected positive integer`);
    if (prs.has(pr.number)) fail(`${label}: duplicate pull request`);
    prs.set(pr.number, pr);
    requireString(pr.url, `${label}.url`);
    timestamp(pr.opened_at, `${label}.opened_at`);
    timestamp(pr.queued_at, `${label}.queued_at`);
    timestamp(pr.dequeued_at, `${label}.dequeued_at`, { nullable: true });
    timestamp(pr.merged_at, `${label}.merged_at`, { nullable: true });
    if (pr.dequeued_at && Date.parse(pr.dequeued_at) < Date.parse(pr.queued_at)) fail(`${label}: dequeued_at precedes queued_at`);
  }

  if (!Array.isArray(source.attempts) || source.attempts.length === 0) fail("attempts must be non-empty");
  const attempts = new Map();
  for (const [index, attempt] of source.attempts.entries()) {
    const label = `attempts[${index}]`;
    if (!prs.has(attempt.pull_request)) fail(`${label}: unknown pull request`);
    if (!Number.isInteger(attempt.attempt) || attempt.attempt <= 0) fail(`${label}.attempt: expected positive integer`);
    const key = `${attempt.pull_request}:${attempt.attempt}`;
    if (attempts.has(key)) fail(`${label}: duplicate attempt`);
    attempts.set(key, attempt);
    timestamp(attempt.queued_at, `${label}.queued_at`);
    timestamp(attempt.dequeued_at, `${label}.dequeued_at`, { nullable: true });
    timestamp(attempt.ejected_at, `${label}.ejected_at`, { nullable: true });
    if (attempt.ejection_cause != null) requireString(attempt.ejection_cause, `${label}.ejection_cause`);
    if (attempt.failure_class != null && !CLASS_IDS.has(attempt.failure_class)) fail(`${label}.failure_class: unknown class`);
  }

  if (!Array.isArray(source.checks)) fail("checks must be an array");
  const checks = new Set();
  for (const [index, check] of source.checks.entries()) {
    const label = `checks[${index}]`;
    const key = `${check.pull_request}:${check.attempt}:${check.name}`;
    if (!attempts.has(`${check.pull_request}:${check.attempt}`)) fail(`${label}: unknown attempt`);
    if (!requiredChecks.includes(check.name)) fail(`${label}.name: not a required check`);
    if (checks.has(key)) fail(`${label}: duplicate check observation`);
    checks.add(key);
    if (!["success", "failure", "pending"].includes(check.status)) fail(`${label}.status: expected success, failure, or pending`);
    timestamp(check.started_at, `${label}.started_at`, { nullable: true });
    timestamp(check.completed_at, `${label}.completed_at`, { nullable: true });
    if (check.status === "success" && check.completed_at == null) fail(`${label}: success needs completed_at`);
    if (check.status === "failure" && check.completed_at == null) fail(`${label}: failure needs completed_at`);
  }

  if (!Array.isArray(source.source_documents)) fail("source_documents must be an array");
  for (const [index, document] of source.source_documents.entries()) {
    requireString(document.id, `source_documents[${index}].id`);
    requireString(document.path, `source_documents[${index}].path`);
    if (!/^[0-9a-f]{64}$/.test(document.sha256)) fail(`source_documents[${index}].sha256: malformed digest`);
  }
  if (!source.source_documents.some((document) => document.id === "incident-corpus")) {
    fail("source_documents must include the mt-0 incident-corpus receipt");
  }
  return { observedAt, windowStart, windowEnd, requiredChecks, prs, attempts, sourceMeasurement };
}

function sourceDocumentReceipts(source) {
  return source.source_documents.map((document) => {
    const absolutePath = path.resolve(ROOT, document.path);
    if (!fs.existsSync(absolutePath)) {
      return { ...document, verification: "unavailable" };
    }
    const actualDigest = sha256(fs.readFileSync(absolutePath));
    if (actualDigest !== document.sha256) {
      fail(`source document digest drift: ${document.path}`);
    }
    return { ...document, verification: "verified" };
  });
}

function durationMetric(startValue, endValue, observedAt, label) {
  const start = timestamp(startValue, `${label}.start`);
  const end = endValue == null ? observedAt : timestamp(endValue, `${label}.end`);
  if (end < start) fail(`${label}: end precedes start`);
  return metric(round((end - start) / 60000), endValue == null ? "measured" : "measured", endValue == null ? "censored at observed_at" : "source timestamps", { censored: endValue == null });
}

function checkDuration(check) {
  if (check.status === "pending" || check.started_at == null || check.completed_at == null) return null;
  const start = timestamp(check.started_at, "check.started_at");
  const end = timestamp(check.completed_at, "check.completed_at");
  if (end < start) fail("check.completed_at precedes check.started_at");
  return round((end - start) / 1000);
}

function checkRerunClearsIt(check, sourceChecks, attemptNumber) {
  if (check.status !== "failure") return null;
  const next = sourceChecks.find((candidate) => candidate.pull_request === check.pull_request
    && candidate.name === check.name && candidate.attempt > attemptNumber && candidate.status === "success");
  return next ? true : null;
}

function buildCheckReceipts(source, context) {
  const rows = [];
  const sortedAttempts = [...source.attempts].sort((a, b) => a.pull_request - b.pull_request || a.attempt - b.attempt);
  for (const attempt of sortedAttempts) {
    for (const name of context.requiredChecks) {
      const observed = source.checks.find((check) => check.pull_request === attempt.pull_request
        && check.attempt === attempt.attempt && check.name === name);
      const status = observed?.status ?? "unavailable";
      const durationSeconds = observed ? checkDuration(observed) : null;
      const rerunClears = observed ? checkRerunClearsIt(observed, source.checks, attempt.attempt) : null;
      const failureValue = status === "failure" ? 1 : status === "success" ? 0 : null;
      rows.push({
        schema: "cityscroll.merge-throughput.required-check-receipt.v1",
        id: `pr-${attempt.pull_request}-attempt-${attempt.attempt}-${name}`,
        source_run_id: source.source_run_id,
        pull_request: attempt.pull_request,
        attempt: attempt.attempt,
        required_check: name,
        status,
        duration_seconds: metric(durationSeconds, durationSeconds == null ? "unknown" : "measured", durationSeconds == null ? "missing or non-terminal source observation; not zero" : "source timestamps", { denominator: durationSeconds == null ? 0 : 1 }),
        failure: metric(failureValue, failureValue == null ? "unknown" : "measured", failureValue == null ? "non-terminal or unavailable check observation" : "source conclusion", { denominator: failureValue == null ? 0 : 1 }),
        rerun_clears_it: metric(rerunClears, rerunClears == null ? "unknown" : "measured", rerunClears == null ? "no succeeding rerun observed" : "later attempt for same PR and check"),
        source: observed?.source ?? null,
      });
    }
  }
  return rows;
}

function buildAttemptReceipts(source, context, checkReceipts) {
  return [...source.attempts]
    .sort((a, b) => a.pull_request - b.pull_request || a.attempt - b.attempt)
    .map((attempt) => {
      const pr = context.prs.get(attempt.pull_request);
      const checks = checkReceipts.filter((row) => row.pull_request === attempt.pull_request && row.attempt === attempt.attempt);
      return {
        schema: "cityscroll.merge-throughput.merge-group-attempt-receipt.v1",
        id: `pr-${attempt.pull_request}-attempt-${attempt.attempt}`,
        source_run_id: source.source_run_id,
        pull_request: attempt.pull_request,
        pull_request_url: pr.url,
        attempt: attempt.attempt,
        timestamps: {
          queued_at: attempt.queued_at,
          ejected_at: attempt.ejected_at ?? null,
          dequeued_at: attempt.dequeued_at ?? null,
        },
        ejection: {
          count: attempt.ejection_cause ? 1 : 0,
          cause: attempt.ejection_cause ?? null,
          measurement: attempt.ejection_cause ? "measured" : "measured",
          basis: attempt.ejection_cause ? "source merge-queue attempt" : "no ejection event on this attempt",
        },
        failure_class: attempt.failure_class ?? null,
        required_checks: checks.map((row) => row.required_check),
        data_quality: {
          state: checks.some((row) => row.status === "unavailable" || row.status === "pending") ? "incomplete" : "complete",
          unavailable_required_checks: checks.filter((row) => row.status === "unavailable").map((row) => row.required_check),
          pending_required_checks: checks.filter((row) => row.status === "pending").map((row) => row.required_check),
        },
      };
    });
}

function buildPrReceipts(source, context, attemptReceipts) {
  return [...context.prs.values()].sort((a, b) => a.number - b.number).map((pr) => {
    const attempts = attemptReceipts.filter((row) => row.pull_request === pr.number);
    const ejectionCauses = attempts.flatMap((row) => row.ejection.cause ? [row.ejection.cause] : []);
    return {
      schema: "cityscroll.merge-throughput.pull-request-receipt.v1",
      id: `pr-${pr.number}`,
      source_run_id: source.source_run_id,
      pull_request: pr.number,
      pull_request_url: pr.url,
      timestamps: {
        opened_at: pr.opened_at,
        queued_at: pr.queued_at,
        dequeued_at: pr.dequeued_at ?? null,
        merged_at: pr.merged_at ?? null,
        observed_at: source.observed_at,
      },
      state: pr.dequeued_at ? "dequeued" : "open",
      attempt_count: attempts.length,
      ejection_count: ejectionCauses.length,
      ejection_causes: ejectionCauses,
      time_open_minutes: durationMetric(pr.opened_at, pr.merged_at, context.observedAt, `pr-${pr.number}.time_open`),
      time_in_queue_minutes: durationMetric(pr.queued_at, pr.dequeued_at, context.observedAt, `pr-${pr.number}.time_in_queue`),
      measurement_note: pr.dequeued_at ? "elapsed source timestamps" : "right-censored at observed_at; not a completed queue time",
      data_quality: {
        state: attempts.some((row) => row.data_quality.state === "incomplete") ? "incomplete" : "complete",
      },
    };
  });
}

function intervalOverlap(start, end, rangeStart, rangeEnd) {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart));
}

function buildDailyGauges(source, context, prReceipts, attemptReceipts) {
  const durationDays = (context.windowEnd - context.windowStart) / DAY_MS;
  const queueIntervals = prReceipts.map((pr) => ({
    start: timestamp(pr.timestamps.queued_at, "pr.queued_at"),
    end: timestamp(pr.timestamps.dequeued_at ?? source.observed_at, "pr.queue.end"),
    pr,
  }));
  const completedOrObserved = prReceipts.filter((pr) => inWindow(timestamp(pr.timestamps.queued_at, "pr.queued_at"), context.windowStart, context.windowEnd));
  const totalQueueMinutes = completedOrObserved.reduce((sum, pr) => sum + pr.time_in_queue_minutes.value, 0);
  const arrivals = prReceipts.filter((pr) => inWindow(timestamp(pr.timestamps.opened_at, "pr.opened_at"), context.windowStart, context.windowEnd));
  const successfulDequeues = prReceipts.filter((pr) => pr.timestamps.dequeued_at && inWindow(timestamp(pr.timestamps.dequeued_at, "pr.dequeued_at"), context.windowStart, context.windowEnd));
  const daily = [];
  for (let start = context.windowStart; start < context.windowEnd; start += DAY_MS) {
    const end = Math.min(start + DAY_MS, context.windowEnd);
    const dayArrivals = arrivals.filter((pr) => inWindow(timestamp(pr.timestamps.opened_at, "pr.opened_at"), start, end));
    const dayDequeues = successfulDequeues.filter((pr) => inWindow(timestamp(pr.timestamps.dequeued_at, "pr.dequeued_at"), start, end));
    const dayAttempts = attemptReceipts.filter((attempt) => attempt.timestamps.ejected_at && inWindow(timestamp(attempt.timestamps.ejected_at, "attempt.ejected_at"), start, end));
    const queuePrDays = queueIntervals.reduce((sum, interval) => sum + intervalOverlap(interval.start, interval.end, start, end) / DAY_MS, 0);
    // Boundary convention: inventory at a window/day start is the state just
    // before arrivals at that boundary; a right-censored PR is still open at
    // observed_at and therefore remains in the final inventory point.
    const activeAtStart = queueIntervals.filter((interval) => interval.start < start && interval.end > start).length;
    const activeAtEnd = queueIntervals.filter((interval) => interval.start < end
      && (interval.end > end || (interval.end === end && !interval.pr.timestamps.dequeued_at))).length;
    const endingToday = queueIntervals.filter((interval) => interval.end > start && interval.end <= end);
    daily.push({
      schema: "cityscroll.merge-throughput.daily-gauge.v1",
      source_run_id: source.source_run_id,
      date: iso(start).slice(0, 10),
      window: { started_at: iso(start), ended_at: iso(end) },
      open_pr_inventory: {
        start: activeAtStart,
        end: activeAtEnd,
        average: metric(round(queuePrDays / ((end - start) / DAY_MS)), "measured", "time-weighted queued PR interval"),
      },
      arrivals: metric(dayArrivals.length, "measured", "PR opened_at timestamps", { denominator: dayArrivals.length }),
      successful_dequeues: metric(dayDequeues.length, "measured", "PR dequeued_at timestamps", { denominator: dayDequeues.length }),
      arrival_rate_per_day: metric(round(dayArrivals.length / ((end - start) / DAY_MS)), "measured", "arrivals divided by this day window"),
      successful_dequeue_service_rate_per_day: metric(round(dayDequeues.length / ((end - start) / DAY_MS)), "measured", "successful dequeues divided by this day window"),
      ejections: metric(dayAttempts.length, "measured", "attempt ejection timestamps", { denominator: dayAttempts.length }),
      time_in_queue_minutes: metric(
        endingToday.length ? round(endingToday.reduce((sum, interval) => sum + interval.pr.time_in_queue_minutes.value, 0) / endingToday.length) : null,
        endingToday.length ? "measured" : "unknown",
        endingToday.length ? "PR queue intervals ending in this day" : "no queue interval ended in this day",
        { denominator: endingToday.length },
      ),
    });
  }
  const meanQueueDays = totalQueueMinutes / 1440 / completedOrObserved.length;
  const arrivalRate = arrivals.length / durationDays;
  const observedInventory = totalQueueMinutes / 1440 / durationDays;
  const impliedInventory = arrivalRate * meanQueueDays;
  const netInventoryChange = (daily.at(-1)?.open_pr_inventory.end ?? 0) - (daily[0]?.open_pr_inventory.start ?? 0);
  const checkSignals = buildCheckGauges(source, context, attemptReceipts);
  return {
    schema: "cityscroll.merge-throughput.daily-gauges.v1",
    source_run_id: source.source_run_id,
    window: { started_at: source.window.started_at, ended_at: source.window.ended_at },
    days: daily,
    totals: {
      arrivals: metric(arrivals.length, "measured", "PR opened_at timestamps"),
      successful_dequeues: metric(successfulDequeues.length, "measured", "PR dequeued_at timestamps"),
      ejections: metric(attemptReceipts.reduce((sum, row) => sum + row.ejection.count, 0), "measured", "attempt ejection receipts"),
      open_pr_inventory_start: metric(daily[0]?.open_pr_inventory.start ?? 0, "measured", "queue interval state at window start"),
      open_pr_inventory_end: metric(daily.at(-1)?.open_pr_inventory.end ?? 0, "measured", "queue interval state at window end"),
      net_inventory_change: metric(netInventoryChange, "measured", "window-end inventory minus window-start inventory"),
    },
    rates: {
      arrival_rate_per_day: metric(round(arrivalRate), "measured", "arrivals divided by the shared observation window", { denominator: arrivals.length, window_days: durationDays }),
      successful_dequeue_service_rate_per_day: metric(round(successfulDequeues.length / durationDays), "measured", "successful dequeues divided by the shared observation window", { denominator: successfulDequeues.length, window_days: durationDays }),
    },
    queueing_decomposition: {
      model: "Little's Law",
      observation_window_days: durationDays,
      queue_inventory_pr_days: metric(round(totalQueueMinutes / 1440), "measured", "sum of each PR queued interval, right-censored at observed_at"),
      average_open_pr_inventory: metric(round(observedInventory), "measured", "queue inventory PR-days divided by the shared observation window"),
      average_time_in_queue_days: metric(round(meanQueueDays), "measured", "mean queued interval over the same PR cohort"),
      arrival_rate_per_day: metric(round(arrivalRate), "measured", "same-window arrivals divided by window days"),
      implied_inventory: metric(round(impliedInventory), "derived", "arrival rate multiplied by mean queue time"),
      residual: metric(round(observedInventory - impliedInventory, 6), "derived", "observed inventory minus Little's Law implied inventory"),
      identity_holds: Math.abs(observedInventory - impliedInventory) < 0.0001,
      denominators: {
        arrival_prs: arrivals.length,
        queue_intervals: completedOrObserved.length,
        window_days: durationDays,
      },
    },
    diagnosis: {
      inventory_growth: {
        state: netInventoryChange > 0 ? "arrivals_exceed_successful_dequeues" : netInventoryChange < 0 ? "successful_dequeues_exceed_arrivals" : "balanced",
        measurement: "measured",
        basis: "compare arrivals with successful dequeues in the same observation window",
        net_change: netInventoryChange,
      },
      gate_service_rate_signal: {
        state: checkSignals.some((row) => row.failure_count.value > 0) ? "particular_gate_candidate_observed" : "no_failure_signal_observed",
        measurement: checkSignals.some((row) => row.failure_count.value > 0) ? "measured" : "unknown",
        attribution: "candidate signal only; a failed check or ejection is not by itself proof of root cause",
        candidates: checkSignals.filter((row) => row.failure_count.value > 0).map((row) => row.required_check),
      },
    },
  };
}

function buildCheckGauges(source, context, attemptReceipts) {
  const checkReceipts = buildCheckReceipts(source, context);
  return context.requiredChecks.map((name) => {
    const rows = checkReceipts.filter((row) => row.required_check === name);
    const completed = rows.filter((row) => row.status === "success" || row.status === "failure");
    const failures = rows.filter((row) => row.status === "failure");
    const flakes = failures.filter((row) => row.rerun_clears_it.value === true);
    const durations = rows.map((row) => row.duration_seconds.value).filter((value) => value != null);
    const ejectionAttempts = rows.filter((row) => row.status === "failure"
      && attemptReceipts.some((attempt) => attempt.pull_request === row.pull_request
        && attempt.attempt === row.attempt && attempt.ejection.count > 0)).length;
    return {
      schema: "cityscroll.merge-throughput.required-check-gauge.v1",
      source_run_id: source.source_run_id,
      required_check: name,
      attempts_total: metric(rows.length, "measured", "one receipt per PR attempt and required check"),
      completed_attempts: metric(completed.length, "measured", "success or failure conclusions"),
      unavailable_attempts: metric(rows.filter((row) => row.status === "unavailable").length, "measured", "required check absent from source attempt"),
      pending_attempts: metric(rows.filter((row) => row.status === "pending").length, "measured", "source reports a pending check"),
      duration_seconds: {
        mean: metric(durations.length ? round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null, durations.length ? "measured" : "unknown", durations.length ? "completed source timestamps" : "no completed duration observations", { denominator: durations.length }),
        max: metric(durations.length ? Math.max(...durations) : null, durations.length ? "measured" : "unknown", durations.length ? "completed source timestamps" : "no completed duration observations", { denominator: durations.length }),
      },
      failure_count: metric(failures.length, "measured", "failure conclusions", { denominator: completed.length }),
      failure_rate: metric(completed.length ? round(failures.length / completed.length) : null, completed.length ? "measured" : "unknown", completed.length ? "failures divided by completed attempts" : "no completed denominator", { numerator: failures.length, denominator: completed.length }),
      flake_count: metric(flakes.length, flakes.length ? "measured" : failures.length ? "measured" : "unknown", failures.length ? "failure followed by a successful later attempt for the same PR and check" : "no failure denominator", { denominator: failures.length }),
      flake_rate: metric(failures.length ? round(flakes.length / failures.length) : null, failures.length ? "measured" : "unknown", failures.length ? "rerun-clears-it divided by failures" : "no failure denominator", { numerator: flakes.length, denominator: failures.length }),
      rerun_clears_it_count: metric(flakes.length, flakes.length ? "measured" : failures.length ? "measured" : "unknown", "later same-PR check conclusion", { denominator: failures.length }),
      rerun_clears_it_rate: metric(failures.length ? round(flakes.length / failures.length) : null, failures.length ? "measured" : "unknown", failures.length ? "rerun-clears-it divided by failures" : "no failure denominator", { numerator: flakes.length, denominator: failures.length }),
      ejection_attempts_with_check: metric(ejectionAttempts, "measured", "ejected attempts carrying this required-check identity"),
      data_quality: { state: rows.some((row) => row.status === "unavailable" || row.status === "pending") ? "incomplete" : "complete" },
    };
  });
}

function renderDashboard({ receipt, prReceipts, checkGauges, dailyGauges }) {
  const quality = receipt.data_quality.state === "incomplete"
    ? "incomplete data — some source observations are unavailable or pending"
    : "complete";
  const dailyRows = dailyGauges.days.map((day) => `<tr><td>${day.date}</td><td>${day.open_pr_inventory.start} → ${day.open_pr_inventory.end}</td><td>${day.arrivals.value}</td><td>${day.successful_dequeues.value}</td><td>${day.arrival_rate_per_day.value}</td><td>${day.successful_dequeue_service_rate_per_day.value}</td><td>${day.time_in_queue_minutes.value ?? "unknown"}</td></tr>`).join("\n");
  const checkRows = checkGauges.map((check) => `<tr><td>${escapeHtml(check.required_check)}</td><td>${check.duration_seconds.mean.value ?? "unknown"}</td><td>${check.failure_rate.value ?? "unknown"}</td><td>${check.flake_rate.value ?? "unknown"}</td><td>${check.rerun_clears_it_rate.value ?? "unknown"}</td><td>${check.completed_attempts.value}/${check.attempts_total.value}</td></tr>`).join("\n");
  const prRows = prReceipts.map((pr) => `<tr><td><a href="${escapeHtml(pr.pull_request_url)}">#${pr.pull_request}</a></td><td>${pr.state}</td><td>${pr.attempt_count}</td><td>${pr.ejection_count}</td><td>${pr.time_open_minutes.value}</td><td>${pr.time_in_queue_minutes.value}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Merge-throughput queue telemetry</title>
<style>
:root{color-scheme:light;--ink:#17212b;--muted:#5c6b78;--line:#d9e1e7;--blue:#0b5cad;--amber:#9a5b00;--paper:#f7f9fb}*{box-sizing:border-box}body{font:15px/1.45 system-ui,sans-serif;color:var(--ink);background:var(--paper);margin:0}main{max-width:1100px;margin:0 auto;padding:32px 20px}h1{margin:0 0 8px;font-size:28px}h2{margin:28px 0 10px;font-size:19px}.lede,.meta{color:var(--muted)}.status{display:inline-block;border:1px solid #d79532;background:#fff4df;color:var(--amber);border-radius:999px;padding:4px 10px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.card{background:white;border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.value{font-size:24px;font-weight:700;margin-top:4px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;background:white;border:1px solid var(--line);font-size:14px}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#eef3f7;color:#394b5a;font-size:12px;text-transform:uppercase;letter-spacing:.03em}tr:last-child td{border-bottom:0}.note{border-left:4px solid var(--blue);background:#eaf3ff;padding:12px 14px;margin:14px 0}.small{font-size:13px;color:var(--muted)}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}table{display:block;overflow-x:auto;white-space:nowrap}}
</style></head><body><main>
<h1>Merge-throughput queue telemetry</h1>
<p class="lede">A queueing view of arrivals, successful service, PR age, ejections, and required-check behavior.</p>
<p><span class="status">${escapeHtml(quality)}</span></p>
<p class="meta">Receipt hash: <code>${receipt.receipt_sha256}</code><br>Source run: <code>${escapeHtml(receipt.source_run_id)}</code><br>Window: ${escapeHtml(receipt.window.started_at)} through ${escapeHtml(receipt.window.ended_at)}<br>Denominators: ${dailyGauges.queueing_decomposition.denominators.arrival_prs} arrivals; ${dailyGauges.queueing_decomposition.denominators.queue_intervals} queue intervals; ${dailyGauges.queueing_decomposition.denominators.window_days} days</p>
<div class="grid">
<div class="card"><div class="label">Open inventory</div><div class="value">${dailyGauges.totals.open_pr_inventory_start.value} → ${dailyGauges.totals.open_pr_inventory_end.value}</div><div class="small">net ${dailyGauges.totals.net_inventory_change.value}</div></div>
<div class="card"><div class="label">Arrival rate</div><div class="value">${dailyGauges.rates.arrival_rate_per_day.value}/day</div><div class="small">${dailyGauges.rates.arrival_rate_per_day.denominator} arrivals</div></div>
<div class="card"><div class="label">Service rate</div><div class="value">${dailyGauges.rates.successful_dequeue_service_rate_per_day.value}/day</div><div class="small">${dailyGauges.rates.successful_dequeue_service_rate_per_day.denominator} successful dequeues</div></div>
<div class="card"><div class="label">Mean queue time</div><div class="value">${dailyGauges.queueing_decomposition.average_time_in_queue_days.value} days</div><div class="small">Little's Law holds: ${dailyGauges.queueing_decomposition.identity_holds}</div></div>
</div>
<div class="note"><strong>Decomposition:</strong> inventory state is <code>${dailyGauges.diagnosis.inventory_growth.state}</code>. Gate signal is <code>${dailyGauges.diagnosis.gate_service_rate_signal.state}</code> for ${dailyGauges.diagnosis.gate_service_rate_signal.candidates.join(", ") || "no named check"}. This is a candidate service-loss signal, not proof of root cause.</div>
<h2>Daily gauges</h2><table><thead><tr><th>Date</th><th>Inventory</th><th>Arrivals</th><th>Successful dequeues</th><th>Arrival/day</th><th>Service/day</th><th>Mean queue min</th></tr></thead><tbody>${dailyRows}</tbody></table>
<h2>Required-check gauges</h2><table><thead><tr><th>Required check</th><th>Mean duration sec</th><th>Failure rate</th><th>Flake rate</th><th>Rerun clears it</th><th>Completed / total</th></tr></thead><tbody>${checkRows}</tbody></table>
<h2>Per-PR receipts</h2><table><thead><tr><th>PR</th><th>State</th><th>Attempts</th><th>Ejections</th><th>Time open min</th><th>Time in queue min</th></tr></thead><tbody>${prRows}</tbody></table>
<p class="small">Source receipts: ${receipt.source_documents.map((document) => `${escapeHtml(document.id)} (${escapeHtml(document.path)})`).join("; ")}</p>
</main></body></html>\n`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

export function buildTelemetry(source) {
  const context = validateSource(source);
  const checkReceipts = buildCheckReceipts(source, context);
  const attemptReceipts = buildAttemptReceipts(source, context, checkReceipts);
  const prReceipts = buildPrReceipts(source, context, attemptReceipts);
  const dailyGauges = buildDailyGauges(source, context, prReceipts, attemptReceipts);
  const checkGauges = buildCheckGauges(source, context, attemptReceipts);
  const sourceDocuments = sourceDocumentReceipts(source);
  const quality = {
    state: checkReceipts.some((row) => row.status === "unavailable" || row.status === "pending")
      || sourceDocuments.some((document) => document.verification !== "verified") ? "incomplete" : "complete",
    unavailable_required_check_receipts: checkReceipts.filter((row) => row.status === "unavailable").length,
    pending_required_check_receipts: checkReceipts.filter((row) => row.status === "pending").length,
    unavailable_source_documents: sourceDocuments.filter((document) => document.verification !== "verified").map((document) => document.id),
    note: "Missing, pending, and unavailable observations are not zero or success.",
  };
  const artifacts = {
    per_pr: prReceipts,
    per_attempt: attemptReceipts,
    per_required_check: checkReceipts,
    required_check_gauges: checkGauges,
    daily_gauges: dailyGauges,
  };
  const artifactHashes = Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, sha256(value)]));
  const receiptBase = {
    schema: RECEIPT_SCHEMA,
    telemetry_schema: TELEMETRY_SCHEMA,
    repository: source.repository,
    source_run_id: source.source_run_id,
    observed_at: source.observed_at,
    source_measurement: source.measurement ?? "measured",
    window: source.window,
    source_documents: sourceDocuments,
    artifact_hashes: artifactHashes,
    denominators: {
      pull_requests: prReceipts.length,
      attempts: attemptReceipts.length,
      required_check_receipts: checkReceipts.length,
      daily_gauges: dailyGauges.days.length,
    },
    data_quality: quality,
    validation: "passed",
  };
  const receipt = { ...receiptBase, receipt_sha256: sha256(receiptBase) };
  const dashboard = renderDashboard({ receipt, prReceipts, checkGauges, dailyGauges });
  return { receipt, prReceipts, attemptReceipts, checkReceipts, checkGauges, dailyGauges, dashboard };
}

function outputFiles(result) {
  return {
    "receipt.json": result.receipt,
    "per-pr-receipts.json": { schema: "cityscroll.merge-throughput.per-pr-receipts.v1", source_run_id: result.receipt.source_run_id, receipts: result.prReceipts },
    "per-attempt-receipts.json": { schema: "cityscroll.merge-throughput.per-attempt-receipts.v1", source_run_id: result.receipt.source_run_id, receipts: result.attemptReceipts },
    "per-required-check-receipts.json": { schema: "cityscroll.merge-throughput.per-required-check-receipts.v1", source_run_id: result.receipt.source_run_id, receipts: result.checkReceipts },
    "required-check-gauges.json": { schema: "cityscroll.merge-throughput.required-check-gauges.v1", source_run_id: result.receipt.source_run_id, gauges: result.checkGauges },
    "daily-gauges.json": result.dailyGauges,
    "dashboard.html": result.dashboard,
  };
}

function compareOutputs(directory, result) {
  for (const [name, expected] of Object.entries(outputFiles(result))) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) fail(`missing expected telemetry artifact: ${file}`);
    const actual = name.endsWith(".html") ? fs.readFileSync(file, "utf8") : readJson(file);
    const expectedValue = name.endsWith(".html") ? expected : canonicalJson(expected);
    const actualValue = name.endsWith(".html") ? actual : canonicalJson(actual);
    if (actualValue !== expectedValue) fail(`telemetry artifact drift: ${name}`);
  }
}

export function writeTelemetry(directory, result) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(outputFiles(result))) {
    if (name.endsWith(".html")) fs.writeFileSync(path.join(directory, name), value);
    else writeJson(path.join(directory, name), value);
  }
}

function parseArgs(argv) {
  const args = { fixture: null, output: null, check: false, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") args.fixture = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--check") args.check = true;
    else if (value === "--write") args.write = true;
    else if (value === "--help") {
      console.log("Usage: node tools/merge_throughput_telemetry.mjs --fixture DIR [--check | --write] [--output DIR]");
      process.exit(0);
    } else fail(`unknown argument: ${value}`);
  }
  if (!args.fixture) fail("--fixture DIR is required");
  if (!args.check && !args.write) fail("choose --check or --write");
  if (args.check && args.write) fail("--check and --write are mutually exclusive");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const fixture = path.resolve(args.fixture);
    const source = readJson(path.join(fixture, "source.json"));
    const result = buildTelemetry(source);
    const output = path.resolve(args.output ?? path.join(fixture, "expected"));
    if (args.check) compareOutputs(output, result);
    else writeTelemetry(output, result);
    console.log(`merge-throughput telemetry ${args.check ? "valid" : "written"}: ${result.receipt.receipt_sha256}`);
    return 0;
  } catch (error) {
    console.error(`merge-throughput telemetry invalid: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
