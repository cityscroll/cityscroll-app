import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_COST_COHORTS,
  buildWorkerCostProfile,
  sanitizeNativeInvocation,
  validateWorkerCostProfile,
} from "./lib/worker_cost_control.mjs";

const revision = "a".repeat(40);
function event(cpuTime = 4) {
  return {
    cpuTime,
    wallTime: 999,
    outcome: "ok",
    scriptVersion: { id: "provider-version" },
    exceptions: [],
    event: { request: {
      url: "https://example.invalid/health",
      method: "GET",
      headers: { "x-cityscroll-cost-probe": "owned" },
    } },
  };
}
function sample(cohort, cpu = 4) {
  return sanitizeNativeInvocation(event(cpu), {
    cohort,
    revision,
    expectedHeaderValue: "owned",
    expectedUrl: "https://example.invalid/health",
    condition: cohort.endsWith(":cold") || cohort.endsWith(":warm")
      ? {
        mode: "provider-observed",
        source: "$metadata.coldStart",
        cold_start: cohort.endsWith(":cold"),
      }
      : { mode: "bounded-production-execution" },
    operations: { kv_writes: { attempted: 1, confirmed: 1 } },
  });
}

test("owned tail events retain provider-native CPU and discard raw request material", () => {
  const retained = sample("health:cold", 0);
  assert.equal(retained.native_cpu_ms, 0);
  assert.equal(retained.native_cpu_source.field, "cpuTime");
  assert.equal("wallTime" in retained, false);
  assert.equal("request" in retained, false);
});

test("literal header, URL and method ownership are all required before persistence", () => {
  for (const override of [
    { expectedHeaderValue: "other" },
    { expectedUrl: "https://example.invalid/other" },
    { expectedMethod: "POST" },
  ]) assert.throws(() => sanitizeNativeInvocation(event(), {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: true },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health", ...override,
  }));
});

test("complete bounded profiles cover routes, three crons, queue and collector overhead", () => {
  const samples = REQUIRED_COST_COHORTS.map((cohort, index) => sample(cohort, index));
  const profile = buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: samples.length,
  });
  assert.equal(profile.complete, true);
  assert.deepEqual(validateWorkerCostProfile(profile), { ok: true, complete: true });
});

test("profiles retain and enforce every sample revision", () => {
  const samples = REQUIRED_COST_COHORTS.map((cohort) => sample(cohort));
  samples[0].revision = "b".repeat(40);
  assert.throws(() => buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: samples.length,
  }), /sample revision/);
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: samples.length,
  });
  profile.cohorts["health:cold"].revision = "b".repeat(40);
  assert.throws(() => validateWorkerCostProfile(profile), /revision does not match/);
});

test("imported profile windows fail closed on invalid bounds", () => {
  const profile = buildWorkerCostProfile(REQUIRED_COST_COHORTS.map((cohort) => sample(cohort)), {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 120, eventCount: REQUIRED_COST_COHORTS.length,
  });
  for (const [field, value] of [["duration_seconds", undefined], ["duration_seconds", -1], ["event_count", "25"]]) {
    const invalid = structuredClone(profile);
    invalid.window[field] = value;
    assert.throws(() => validateWorkerCostProfile(invalid), /finite non-negative/);
  }
});

test("missing samples stay unknown and cannot masquerade as zero", () => {
  const profile = buildWorkerCostProfile([sample("health:cold", 0)], {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1, eventCount: 1,
  });
  assert.equal(profile.cohorts["health:warm"].status, "unknown");
  assert.equal(profile.cohorts["health:warm"].native_cpu_ms, null);
  assert.throws(() => validateWorkerCostProfile(profile), /unknown/);
});

test("wall time without a native CPU field is rejected", () => {
  const raw = event();
  delete raw.cpuTime;
  assert.throws(() => sanitizeNativeInvocation(raw, {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: true },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /provider-native CPU/);
});

test("cold and warm labels require matching provider coldStart evidence", () => {
  assert.throws(() => sanitizeNativeInvocation(event(), {
    cohort: "health:cold", revision,
    condition: { mode: "provider-observed", source: "$metadata.coldStart", cold_start: false },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /does not match cohort/);
  assert.throws(() => sanitizeNativeInvocation(event(), {
    cohort: "health:warm", revision,
    condition: { mode: "request-order", cold_start: false },
    expectedHeaderValue: "owned", expectedUrl: "https://example.invalid/health",
  }), /provider \$metadata\.coldStart/);
});

test("attempted writes cannot be represented as confirmed", () => {
  const bad = sample("health:cold");
  bad.operations = { kv_writes: { attempted: 0, confirmed: 1 } };
  const samples = REQUIRED_COST_COHORTS.map((cohort) => sample(cohort));
  samples[0] = bad;
  const profile = buildWorkerCostProfile(samples, {
    revision, observedAt: "2026-10-08T23:30:00Z", durationSeconds: 1, eventCount: samples.length,
  });
  assert.throws(() => validateWorkerCostProfile(profile), /confirmed exceeds attempted/);
});
