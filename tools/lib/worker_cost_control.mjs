export const REQUIRED_COST_COHORTS = Object.freeze([
  "health:cold", "health:warm",
  "unknown-route:cold", "unknown-route:warm",
  "events:cold", "events:warm",
  "rum-16:cold", "rum-16:warm",
  "search:cold", "search:warm",
  "nearby:cold", "nearby:warm",
  "browse:cold", "browse:warm",
  "zap-bbl:cold", "zap-bbl:warm",
  "zap-project:cold", "zap-project:warm",
  "doing-business:cold", "doing-business:warm",
  "cron:0 8 * * *", "cron:0 10 * * *", "cron:0 13 * * *", "queue", "collector-overhead",
]);

export const COST_METERS = Object.freeze([
  "native_cpu_ms", "collector_cpu_ms", "kv_reads", "kv_writes",
  "d1_rows_read", "d1_rows_written", "storage_bytes",
]);

const OPERATION_METERS = Object.freeze(["kv_reads", "kv_writes", "d1_rows_read", "d1_rows_written", "storage_bytes"]);

const FORBIDDEN_RETAINED_KEYS = /(?:^|_)(?:url|query|headers?|body|token|credential|email|ip|account_id|user_agent|identifier)(?:_|$)/i;

function fail(message) {
  throw new Error(message);
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be a finite non-negative number`);
  return value;
}

function finiteNonNegativeInteger(value, name) {
  finiteNonNegative(value, name);
  if (!Number.isInteger(value)) fail(`${name} must be an integer`);
  return value;
}

function requireActualWindow(value, label) {
  if (value?.evidence_mode !== "actual-production") fail(`${label} must be actual production evidence`);
  if (!/^[a-f0-9]{40}$/.test(String(value?.deployed_revision || ""))) fail(`${label} deployed_revision must be a full commit SHA`);
  if (!Number.isFinite(Date.parse(value?.observed_at))) fail(`${label} observed_at is invalid`);
  if (typeof value?.workload_id !== "string" || !value.workload_id.trim()) fail(`${label} workload_id is required`);
  finiteNonNegativeInteger(value?.workload_count, `${label}.workload_count`);
  if (value.workload_count < 1) fail(`${label}.workload_count must be positive`);
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

function validateCondition(cohort, condition, path) {
  if (!condition || typeof condition !== "object" || !condition.mode) fail(`${path} controlled condition evidence is required`);
  if (cohort.endsWith(":cold") || cohort.endsWith(":warm")) {
    if (condition.source !== "$metadata.coldStart" || typeof condition.cold_start !== "boolean") {
      fail(`${path} must use provider $metadata.coldStart evidence`);
    }
    if (condition.cold_start !== cohort.endsWith(":cold")) fail(`${path} coldStart does not match cohort`);
  }
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
  validateCondition(cohort, condition, "condition");
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
  if (!operations || typeof operations !== "object") fail(`${path} is required`);
  for (const name of OPERATION_METERS) {
    const count = operations[name];
    if (!count || typeof count !== "object") fail(`${path}.${name} must separate attempted and confirmed`);
    finiteNonNegativeInteger(count.attempted, `${path}.${name}.attempted`);
    finiteNonNegativeInteger(count.confirmed, `${path}.${name}.confirmed`);
    if (count.confirmed > count.attempted) fail(`${path}.${name} confirmed exceeds attempted`);
  }
  for (const name of Object.keys(operations)) {
    if (!OPERATION_METERS.includes(name)) fail(`${path}.${name} is not a supported operation meter`);
  }
}

function retainedSample(sample) {
  return {
    revision: sample.revision,
    native_cpu_ms: sample.native_cpu_ms,
    native_cpu_source: sample.native_cpu_source,
    condition: sample.condition,
    operations: sample.operations || {},
    error_count: sample.error_count,
  };
}

function validateRetainedSample(sample, cohort, revision, path) {
  if (!sample || typeof sample !== "object") fail(`${path} is required`);
  if (sample.revision !== revision) fail(`${path}.revision does not match profile revision`);
  finiteNonNegative(sample.native_cpu_ms, `${path}.native_cpu_ms`);
  if (!["cpuTime", "$workers.cpuTimeMs"].includes(sample.native_cpu_source?.field)) {
    fail(`${path} does not use provider-native invocation CPU`);
  }
  validateCondition(cohort, sample.condition, `${path}.condition`);
  validateOperationCounts(sample.operations, `${path}.operations`);
  finiteNonNegativeInteger(sample.error_count, `${path}.error_count`);
}

export function buildWorkerCostProfile(samples, {
  revision,
  observedAt,
  durationSeconds,
  eventCount,
  trafficMix = "fixed-controlled-v1",
  correctness = {},
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(revision || ""))) fail("profile revision must be a full commit SHA");
  finiteNonNegative(durationSeconds, "duration_seconds");
  finiteNonNegativeInteger(eventCount, "event_count");
  if (durationSeconds > 30 * 60) fail("collection exceeded the 30 minute bound");
  if (eventCount > 10_000) fail("collection exceeded the 10000 event bound");
  const cohorts = {};
  for (const name of REQUIRED_COST_COHORTS) {
    const owned = samples.filter((sample) => sample.cohort === name);
    for (const sample of owned) {
      if (sample.revision !== revision) fail(`${name} sample revision does not match profile revision`);
      validateRetainedSample(sample, name, revision, `${name}.sample`);
    }
    cohorts[name] = owned.length
      ? {
        status: "measured",
        revision,
        sample_count: owned.length,
        native_cpu_ms: owned.map((sample) => sample.native_cpu_ms),
        native_cpu_source: owned[0].native_cpu_source,
        condition: owned[0].condition,
        operations: owned.map((sample) => sample.operations),
        error_count: owned.reduce((sum, sample) => sum + sample.error_count, 0),
        samples: owned.map(retainedSample),
      }
      : { status: "unknown", sample_count: null, native_cpu_ms: null, reason: "missing-provider-sample" };
  }
  if (eventCount < samples.length) fail("event_count cannot be less than retained sample count");
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
  assertSanitized(profile);
  if (profile?.schema !== "cityscroll.worker_cost_profile.v1" || profile.kind !== "provider-native-bounded") fail("unsupported worker cost profile");
  if (!/^[a-f0-9]{40}$/.test(String(profile.revision || ""))) fail("profile revision must be a full commit SHA");
  if (!Number.isFinite(Date.parse(profile.observed_at))) fail("profile observed_at is invalid");
  finiteNonNegative(profile.window?.duration_seconds, "profile.window.duration_seconds");
  finiteNonNegativeInteger(profile.window?.event_count, "profile.window.event_count");
  if (profile.window?.duration_seconds > profile.window?.max_seconds || profile.window?.max_seconds !== 1800) fail("profile exceeds duration bound");
  if (profile.window?.event_count > profile.window?.max_events || profile.window?.max_events !== 10_000) fail("profile exceeds event bound");
  let retainedSampleCount = 0;
  for (const name of REQUIRED_COST_COHORTS) {
    const cohort = profile.cohorts?.[name];
    if (!cohort) fail(`profile is missing cohort ${name}`);
    if (cohort.status === "unknown") {
      if (cohort.sample_count === 0 || cohort.native_cpu_ms === 0) fail(`${name} represents missing evidence as zero`);
      if (requireComplete) fail(`profile cohort ${name} is unknown`);
      continue;
    }
    if (cohort.status !== "measured" || !Number.isInteger(cohort.sample_count) || cohort.sample_count < 1) fail(`${name} has invalid samples`);
    retainedSampleCount += cohort.sample_count;
    if (cohort.revision !== profile.revision) fail(`${name} revision does not match profile revision`);
    if (!Array.isArray(cohort.native_cpu_ms) || cohort.native_cpu_ms.length !== cohort.sample_count) fail(`${name} CPU samples do not match sample_count`);
    if (!Array.isArray(cohort.samples) || cohort.samples.length !== cohort.sample_count) fail(`${name} retained samples do not match sample_count`);
    cohort.native_cpu_ms.forEach((value, index) => {
      finiteNonNegative(value, `${name}.native_cpu_ms`);
      validateRetainedSample(cohort.samples[index], name, profile.revision, `${name}.samples[${index}]`);
      if (cohort.samples[index].native_cpu_ms !== value) fail(`${name}.samples[${index}] CPU does not match aggregate`);
    });
    if (!["cpuTime", "$workers.cpuTimeMs"].includes(cohort.native_cpu_source?.field)) fail(`${name} does not use provider-native invocation CPU`);
    validateCondition(name, cohort.condition, `${name}.condition`);
    (cohort.operations || []).forEach((operations, index) => validateOperationCounts(operations, `${name}.operations[${index}]`));
  }
  if (profile.window.event_count < retainedSampleCount) fail("profile event_count cannot be less than retained sample count");
  return { ok: true, complete: profile.complete === true };
}

export function profileMeterTotals(profile) {
  validateWorkerCostProfile(profile);
  const totals = {
    native_cpu_ms: 0,
    collector_cpu_ms: 0,
    kv_reads: 0,
    kv_writes: 0,
    d1_rows_read: 0,
    d1_rows_written: 0,
    storage_bytes: 0,
    errors: 0,
  };
  for (const [cohortName, cohort] of Object.entries(profile.cohorts)) {
    for (const sample of cohort.samples) {
      if (cohortName === "collector-overhead") totals.collector_cpu_ms += sample.native_cpu_ms;
      else totals.native_cpu_ms += sample.native_cpu_ms;
      totals.errors += sample.error_count;
      for (const meter of OPERATION_METERS) {
        totals[meter] += sample.operations[meter].confirmed;
      }
    }
  }
  return totals;
}

export const WAREHOUSE_EXPERIMENT_COHORTS = Object.freeze([
  "zap-bbl:cold", "zap-bbl:warm",
  "zap-project:cold", "zap-project:warm",
  "doing-business:cold", "doing-business:warm",
  "health:cold", "health:warm",
  "browse:cold", "browse:warm",
]);

function normalizedMeters(run) {
  const workload = finiteNonNegativeInteger(run?.workload_count, "workload_count");
  if (workload < 1) fail("workload_count must be positive");
  return Object.fromEntries(COST_METERS.map((meter) => {
    const value = meter.endsWith("_ms")
      ? finiteNonNegative(run?.meters?.[meter], meter)
      : finiteNonNegativeInteger(run?.meters?.[meter], meter);
    return [meter, value / workload];
  }));
}

export function evaluateWarehouseExperiment({ baseline, candidate } = {}) {
  assertSanitized({ baseline, candidate });
  for (const [label, run] of Object.entries({ baseline, candidate })) {
    if (!run || run.schema !== "cityscroll.warehouse_cost_experiment_run.v1") fail(`invalid ${label} experiment run`);
    requireActualWindow(run, label);
    if (run.workload_id !== baseline.workload_id || run.workload_count !== baseline.workload_count) fail("experiment workloads are not matched");
    for (const cohort of WAREHOUSE_EXPERIMENT_COHORTS) {
      const evidence = run.cohorts?.[cohort];
      if (!evidence) fail(`${label} is missing ${cohort}`);
      finiteNonNegativeInteger(evidence.sample_count, `${label}.${cohort}.sample_count`);
      if (evidence.sample_count < 1) fail(`${label}.${cohort}.sample_count must be positive`);
      if (label === "candidate" && evidence.sample_count !== baseline.cohorts?.[cohort]?.sample_count) {
        fail(`experiment cohort ${cohort} sample counts are not matched`);
      }
      if (evidence.cpu_source !== "provider-native-invocation") fail(`${label} ${cohort} does not use invocation CPU`);
      validateCondition(cohort, evidence.condition, `${label}.${cohort}.condition`);
    }
    finiteNonNegativeInteger(run.error_count, `${label}.error_count`);
    for (const field of ["input_digest", "joins_digest", "provenance_digest", "miss_digest", "freshness_digest"]) {
      if (!run.correctness?.[field]) fail(`${label} is missing ${field}`);
      if (run.correctness[field] !== baseline.correctness[field]) fail(`candidate changed ${field}`);
    }
  }
  if (baseline.deployed_revision === candidate.deployed_revision) fail("experiment revisions must be distinct");
  if (Date.parse(candidate.observed_at) <= Date.parse(baseline.observed_at)) fail("candidate observation must follow baseline");
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
    operation_recommendation: accepted ? "retain-candidate" : "retain-baseline",
    financial_savings_confirmed: false,
    matched_workload_count: baseline.workload_count,
    baseline_normalized: baselineMeters,
    candidate_normalized: candidateMeters,
    regressions,
    improvements,
  };
}

export function evaluateAllMeterRelease({ baseline, candidate } = {}) {
  if (!baseline || !candidate) fail("baseline and candidate release evidence are required");
  assertSanitized({ baseline, candidate });
  for (const [label, receipt] of Object.entries({ baseline, candidate })) {
    if (receipt.schema !== "cityscroll.all_meter_release.v1") fail(`invalid ${label} all-meter receipt`);
    requireActualWindow(receipt, label);
    if (receipt.d1?.authority !== "independent" || receipt.d1?.complete !== true) fail(`${label} collapses independent D1 authority`);
    validateWorkerCostProfile(receipt.profile);
    if (receipt.profile.revision !== receipt.deployed_revision) fail(`${label} profile revision does not match deployment`);
    finiteNonNegativeInteger(receipt.errors, `${label}.errors`);
    normalizedMeters(receipt);
    const profileTotals = profileMeterTotals(receipt.profile);
    for (const meter of COST_METERS) {
      if (receipt.meters?.[meter] !== profileTotals[meter]) fail(`${label}.${meter} does not match provider profile samples`);
    }
    if (receipt.errors !== profileTotals.errors) fail(`${label}.errors does not match provider profile samples`);
  }
  if (baseline.workload_id !== candidate.workload_id || baseline.workload_count !== candidate.workload_count) fail("all-meter workloads are not equivalent");
  for (const cohort of REQUIRED_COST_COHORTS) {
    if (baseline.profile.cohorts[cohort].sample_count !== candidate.profile.cohorts[cohort].sample_count) {
      fail(`all-meter cohort ${cohort} sample counts are not matched`);
    }
  }
  if (baseline.deployed_revision === candidate.deployed_revision) fail("all-meter revisions must be distinct");
  if (Date.parse(candidate.observed_at) <= Date.parse(baseline.observed_at)) fail("candidate observation must follow baseline");
  if (candidate.publication?.unchanged?.route_key_puts !== 0 || candidate.publication?.unchanged?.manifest_puts !== 0) fail("candidate unchanged publication is not a zero-write control");
  const rumPuts = candidate.rum?.full_batch?.kv_puts;
  if (
    candidate.rum?.full_batch?.accepted !== 16
    || !Number.isInteger(rumPuts)
    || rumPuts < 0
    || rumPuts > 3
  ) fail("candidate weighted RUM control is incomplete");
  const baselineNormalized = normalizedMeters(baseline);
  const candidateNormalized = normalizedMeters(candidate);
  const regressions = COST_METERS.filter((meter) => candidateNormalized[meter] > baselineNormalized[meter]);
  if (candidate.errors > baseline.errors) regressions.push("errors");
  return {
    schema: "cityscroll.all_meter_release_decision.v1",
    pass: regressions.length === 0,
    regressions,
    tariff_free: true,
    baseline_normalized: baselineNormalized,
    candidate_normalized: candidateNormalized,
  };
}
