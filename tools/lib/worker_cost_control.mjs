export const REQUIRED_COST_COHORTS = Object.freeze([
  "http.health.cold", "http.health.warm",
  "http.unknown-route.cold", "http.unknown-route.warm",
  "http.events.cold", "http.events.warm",
  "http.rum-full.cold", "http.rum-full.warm",
  "http.search.cold", "http.search.warm",
  "http.nearby.cold", "http.nearby.warm",
  "cron.0-8", "cron.0-10", "cron.0-13", "queue.digest", "collector.overhead",
]);

export const COST_METERS = Object.freeze([
  "native_cpu_ms", "kv_reads", "kv_writes", "d1_rows_written", "storage_bytes", "collector_cpu_ms",
]);

const FORBIDDEN_RETAINED_KEYS = /(?:^|_)(?:url|query|headers?|body|token|credential|email|ip|account_id|user_agent|identifier)(?:_|$)/i;

function fail(message) {
  throw new Error(message);
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be a finite non-negative number`);
  return value;
}

function assertSanitized(value, path = "receipt") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertSanitized(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RETAINED_KEYS.test(key)) fail(`${path}.${key} is forbidden in retained cost evidence`);
    assertSanitized(child, `${path}.${key}`);
  }
}

function requestFromTailEvent(event) {
  return event?.event?.request || event?.request || null;
}

/**
 * Convert one owned provider event into the narrow retained shape. Ownership is
 * checked against the literal probe header and exact URL/method before any raw
 * request material crosses the persistence boundary.
 */
export function sanitizeNativeInvocation(event, {
  cohort,
  condition,
  revision,
  expectedHeaderValue,
  expectedUrl,
  expectedMethod = "GET",
  operations,
} = {}) {
  if (!REQUIRED_COST_COHORTS.includes(cohort)) fail(`unknown cost cohort ${cohort}`);
  const request = requestFromTailEvent(event);
  const headers = request?.headers || {};
  const ownedHeader = headers["x-cityscroll-cost-probe"] || headers["X-Cityscroll-Cost-Probe"];
  if (!expectedHeaderValue || ownedHeader !== expectedHeaderValue) fail("provider event is not owned by the literal probe header");
  if (request?.url !== expectedUrl || request?.method !== expectedMethod) fail("provider event does not match the expected URL and method");
  const cpu = event?.cpuTime ?? event?.$workers?.cpuTimeMs;
  const sourceField = event?.cpuTime !== undefined ? "cpuTime" : "$workers.cpuTimeMs";
  finiteNonNegative(cpu, "provider-native CPU");
  if (!condition || typeof condition !== "object" || !condition.mode) fail("controlled condition evidence is required");
  if (!/^[a-f0-9]{40}$/.test(String(revision || ""))) fail("revision must be a full commit SHA");
  const sample = {
    cohort,
    condition,
    revision,
    native_cpu_ms: cpu,
    native_cpu_source: { field: sourceField, unit: "milliseconds", precision: Number.isInteger(cpu) ? "integer" : "provider" },
    outcome: String(event?.outcome || "unknown"),
    script_version_id: event?.scriptVersion?.id || null,
    operations: operations || {},
    error_count: Array.isArray(event?.exceptions) ? event.exceptions.length : Number(event?.exception_count || 0),
  };
  assertSanitized(sample);
  return sample;
}

function validateOperationCounts(operations, path) {
  for (const [name, count] of Object.entries(operations || {})) {
    if (!count || typeof count !== "object") fail(`${path}.${name} must separate attempted and confirmed`);
    finiteNonNegative(count.attempted, `${path}.${name}.attempted`);
    finiteNonNegative(count.confirmed, `${path}.${name}.confirmed`);
    if (count.confirmed > count.attempted) fail(`${path}.${name} confirmed exceeds attempted`);
  }
}

export function buildWorkerCostProfile(samples, {
  revision,
  observedAt,
  durationSeconds,
  eventCount,
  trafficMix = "fixed-controlled-v1",
  correctness = {},
} = {}) {
  finiteNonNegative(durationSeconds, "duration_seconds");
  finiteNonNegative(eventCount, "event_count");
  if (durationSeconds > 30 * 60) fail("collection exceeded the 30 minute bound");
  if (eventCount > 10_000) fail("collection exceeded the 10000 event bound");
  const cohorts = {};
  for (const name of REQUIRED_COST_COHORTS) {
    const owned = samples.filter((sample) => sample.cohort === name);
    cohorts[name] = owned.length
      ? {
        status: "measured",
        sample_count: owned.length,
        native_cpu_ms: owned.map((sample) => sample.native_cpu_ms),
        native_cpu_source: owned[0].native_cpu_source,
        condition: owned[0].condition,
        operations: owned.map((sample) => sample.operations),
        error_count: owned.reduce((sum, sample) => sum + sample.error_count, 0),
      }
      : { status: "unknown", sample_count: null, native_cpu_ms: null, reason: "missing-provider-sample" };
  }
  const profile = {
    schema: "cityscroll.worker_cost_profile.v1",
    kind: "provider-native-bounded",
    revision,
    observed_at: observedAt,
    window: { duration_seconds: durationSeconds, event_count: eventCount, max_seconds: 1800, max_events: 10_000 },
    traffic_mix: trafficMix,
    cohorts,
    correctness,
  };
  profile.complete = REQUIRED_COST_COHORTS.every((name) => cohorts[name].status === "measured");
  assertSanitized(profile);
  return profile;
}

export function validateWorkerCostProfile(profile, { requireComplete = true } = {}) {
  if (profile?.schema !== "cityscroll.worker_cost_profile.v1" || profile.kind !== "provider-native-bounded") fail("unsupported worker cost profile");
  if (!/^[a-f0-9]{40}$/.test(String(profile.revision || ""))) fail("profile revision must be a full commit SHA");
  if (!Number.isFinite(Date.parse(profile.observed_at))) fail("profile observed_at is invalid");
  if (profile.window?.duration_seconds > profile.window?.max_seconds || profile.window?.max_seconds !== 1800) fail("profile exceeds duration bound");
  if (profile.window?.event_count > profile.window?.max_events || profile.window?.max_events !== 10_000) fail("profile exceeds event bound");
  for (const name of REQUIRED_COST_COHORTS) {
    const cohort = profile.cohorts?.[name];
    if (!cohort) fail(`profile is missing cohort ${name}`);
    if (cohort.status === "unknown") {
      if (cohort.sample_count === 0 || cohort.native_cpu_ms === 0) fail(`${name} represents missing evidence as zero`);
      if (requireComplete) fail(`profile cohort ${name} is unknown`);
      continue;
    }
    if (cohort.status !== "measured" || !Number.isInteger(cohort.sample_count) || cohort.sample_count < 1) fail(`${name} has invalid samples`);
    if (!Array.isArray(cohort.native_cpu_ms) || cohort.native_cpu_ms.length !== cohort.sample_count) fail(`${name} CPU samples do not match sample_count`);
    cohort.native_cpu_ms.forEach((value) => finiteNonNegative(value, `${name}.native_cpu_ms`));
    if (!["cpuTime", "$workers.cpuTimeMs"].includes(cohort.native_cpu_source?.field)) fail(`${name} does not use provider-native invocation CPU`);
    if (!cohort.condition?.mode) fail(`${name} lacks controlled condition evidence`);
    (cohort.operations || []).forEach((operations, index) => validateOperationCounts(operations, `${name}.operations[${index}]`));
  }
  assertSanitized(profile);
  return { ok: true, complete: profile.complete === true };
}

export const WAREHOUSE_EXPERIMENT_COHORTS = Object.freeze([
  "lookup.zap-bbl.cold", "lookup.zap-bbl.warm",
  "lookup.zap-project.cold", "lookup.zap-project.warm",
  "lookup.doing-business.cold", "lookup.doing-business.warm",
  "control.health.cold", "control.health.warm",
  "control.browse.cold", "control.browse.warm",
]);

function normalizedMeters(run) {
  const workload = finiteNonNegative(run?.workload_count, "workload_count");
  if (workload < 1) fail("workload_count must be positive");
  return Object.fromEntries(COST_METERS.map((meter) => [meter, finiteNonNegative(run?.meters?.[meter], meter) / workload]));
}

export function evaluateWarehouseExperiment({ baseline, candidate } = {}) {
  for (const [label, run] of Object.entries({ baseline, candidate })) {
    if (!run || run.schema !== "cityscroll.warehouse_cost_experiment_run.v1") fail(`invalid ${label} experiment run`);
    if (run.workload_count !== baseline.workload_count) fail("experiment workloads are not matched");
    for (const cohort of WAREHOUSE_EXPERIMENT_COHORTS) {
      if (!run.cohorts?.[cohort]?.sample_count) fail(`${label} is missing ${cohort}`);
      if (run.cohorts[cohort].cpu_source !== "provider-native-invocation") fail(`${label} ${cohort} does not use invocation CPU`);
    }
    for (const field of ["input_digest", "joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]) {
      if (!run.correctness?.[field]) fail(`${label} is missing ${field}`);
      if (run.correctness[field] !== baseline.correctness[field]) fail(`candidate changed ${field}`);
    }
  }
  const baselineMeters = normalizedMeters(baseline);
  const candidateMeters = normalizedMeters(candidate);
  const regressions = COST_METERS.filter((meter) => candidateMeters[meter] > baselineMeters[meter]);
  if (candidate.error_count > baseline.error_count) regressions.push("error_count");
  const improvements = COST_METERS.filter((meter) => candidateMeters[meter] < baselineMeters[meter]);
  const accepted = regressions.length === 0 && improvements.length > 0;
  return {
    schema: "cityscroll.warehouse_cost_experiment.v1",
    decision: accepted ? "candidate-retained" : "candidate-rejected",
    retained: accepted ? "candidate" : "baseline",
    shipped_savings: accepted,
    matched_workload_count: baseline.workload_count,
    baseline_normalized: baselineMeters,
    candidate_normalized: candidateMeters,
    regressions,
    improvements,
  };
}

export function evaluateAllMeterRelease({ baseline, candidate } = {}) {
  if (!baseline || !candidate) fail("baseline and candidate release evidence are required");
  for (const [label, receipt] of Object.entries({ baseline, candidate })) {
    if (receipt.schema !== "cityscroll.all_meter_release.v1") fail(`invalid ${label} all-meter receipt`);
    if (receipt.publication?.unchanged?.route_key_puts !== 0 || receipt.publication?.unchanged?.manifest_puts !== 0) fail(`${label} unchanged publication is not a zero-write control`);
    if (receipt.rum?.full_batch?.accepted !== 16 || receipt.rum?.full_batch?.kv_puts > 3) fail(`${label} weighted RUM control is incomplete`);
    if (receipt.d1?.authority !== "independent" || receipt.d1?.complete !== true) fail(`${label} collapses independent D1 authority`);
    validateWorkerCostProfile(receipt.profile);
    for (const meter of COST_METERS) finiteNonNegative(receipt.meters?.[meter], `${label}.${meter}`);
  }
  if (baseline.workload_id !== candidate.workload_id) fail("all-meter workloads are not equivalent");
  const regressions = COST_METERS.filter((meter) => candidate.meters[meter] > baseline.meters[meter]);
  if (candidate.errors > baseline.errors) regressions.push("errors");
  return {
    schema: "cityscroll.all_meter_release_decision.v1",
    pass: regressions.length === 0,
    regressions,
    tariff_free: true,
  };
}
