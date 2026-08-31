import { createHash } from "node:crypto";

export const CANARY_SCHEMA = "cityscroll.cold_build_canary_receipt.v1";
export const POLICY_SCHEMA = "cityscroll.cold_build_canary_policy.v1";

function finiteSamples(samples, label) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must contain non-negative numeric samples`);
  }
  return [...samples].sort((a, b) => a - b);
}

export function percentile(samples, percentileValue) {
  const sorted = finiteSamples(samples, "samples");
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
    throw new Error("percentile must be between 0 and 1");
  }
  const rank = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[rank];
}

function distribution(samples) {
  const sorted = finiteSamples(samples, "timing distribution");
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min_seconds: sorted[0],
    median_seconds: percentile(sorted, 0.5),
    p95_seconds: percentile(sorted, 0.95),
    max_seconds: sorted[sorted.length - 1],
    mean_seconds: sum / sorted.length,
  };
}

export function auditTimingPolicy(policy) {
  if (policy?.schema !== POLICY_SCHEMA) throw new Error("invalid cold-build canary policy schema");
  const hit = distribution(policy.samples?.hit_seconds);
  const miss = distribution(policy.samples?.miss_seconds);
  const hitMax = Number(policy.thresholds?.hit_max_seconds);
  const missMax = Number(policy.thresholds?.miss_max_seconds);
  const calibration = policy.calibration;
  if (!Number.isFinite(hitMax) || hitMax <= 0) throw new Error("cache-hit threshold is missing or invalid");
  if (!Number.isFinite(missMax) || missMax <= 0) throw new Error("cache-miss threshold is missing or invalid");
  if (calibration?.mode !== "cache-miss") throw new Error("cold-build threshold must declare cache-miss calibration");
  if (!calibration?.source || !calibration?.rationale) throw new Error("cold-build threshold calibration evidence is incomplete");
  if (missMax < miss.p95_seconds) throw new Error(`cache-miss threshold ${missMax}s is below measured p95 ${miss.p95_seconds}s`);
  if (missMax <= hit.p95_seconds) throw new Error("cache-miss threshold is inherited from cache-hit timing");
  const observedUpper = Number(calibration.observed_cold_build_upper_seconds);
  const headroom = Number(calibration.headroom_seconds);
  if (!Number.isFinite(observedUpper) || !Number.isFinite(headroom) || observedUpper < miss.p95_seconds || headroom < 0) {
    throw new Error("cold-build calibration must cover the measured miss distribution");
  }
  if (missMax < observedUpper + headroom) throw new Error("cold-build threshold does not include declared headroom");
  return {
    schema: "cityscroll.cold_build_timing_audit.v1",
    distributions: { hit, miss },
    thresholds: {
      hit_max_seconds: hitMax,
      miss_max_seconds: missMax,
      miss_calibration: "cache-miss",
    },
    calibration: {
      source: calibration.source,
      rationale: calibration.rationale,
      observed_cold_build_upper_seconds: observedUpper,
      headroom_seconds: headroom,
    },
    verdict: "pass",
  };
}

export function classifyCacheMode({ artifactRestored = false, cacheHit = false, identityVerified = false } = {}) {
  if ((artifactRestored || cacheHit) && identityVerified) {
    return { mode: "hit", reason: "verified-reusable-artifact" };
  }
  if (artifactRestored || cacheHit) {
    return { mode: "miss", reason: "cache-candidate-rejected-and-rebuilt" };
  }
  return { mode: "miss", reason: "no-reusable-artifact" };
}

export function classifyBuildFailure({ status = 0, signal = null, spawnError = null } = {}) {
  if (spawnError || signal) {
    return {
      class: "environment",
      reason: spawnError?.code === "ETIMEDOUT" ? "build-timeout" : spawnError?.message || signal || "process did not complete",
    };
  }
  if (status !== 0) return { class: "product-build-regression", reason: `build exited with status ${status}` };
  return null;
}

export function buildCacheBustKey(inputIdentity, canaryId) {
  return createHash("sha256")
    .update(JSON.stringify({ input_identity: inputIdentity, canary_id: canaryId }))
    .digest("hex");
}

export function createCanaryReceipt({ identity, cache, result, failure = null, wallClockMs, timingAudit, stages, buildFamilies }) {
  return {
    schema: CANARY_SCHEMA,
    input: {
      build_input_identity: identity.build_input_identity,
      commit_sha: identity.commit_sha,
      tree_sha: identity.tree_sha,
      lockfile_sha256: identity.lockfile_sha256 || identity.lockfile?.sha256,
      node_version: identity.node_version || identity.tool?.version,
    },
    cache,
    result,
    failure,
    wall_clock_ms: Math.round(wallClockMs),
    threshold_seconds: timingAudit.thresholds.miss_max_seconds,
    timing_audit: timingAudit,
    stages: stages || [],
    build_families: buildFamilies || [],
  };
}

export function assertColdReceipt(receipt, policy) {
  if (receipt?.schema !== CANARY_SCHEMA) throw new Error("invalid cold-build canary receipt schema");
  if (receipt.cache?.mode !== "miss") throw new Error("cold-build canary evidence must come from a cache miss");
  if (receipt.cache?.strategy !== "isolated-output-no-restore") throw new Error("cold-build canary did not use isolated no-restore mode");
  if (!receipt.input?.build_input_identity || !receipt.input?.commit_sha || !receipt.input?.tree_sha || !receipt.input?.lockfile_sha256 || !receipt.input?.node_version) {
    throw new Error("cold-build canary input identity is incomplete");
  }
  if (!Number.isFinite(receipt.wall_clock_ms) || receipt.wall_clock_ms < 0) throw new Error("cold-build wall-clock is missing or invalid");
  if (!Array.isArray(receipt.stages) || receipt.stages.length === 0) throw new Error("cold-build stage timings are missing");
  if (!Array.isArray(receipt.build_families) || receipt.build_families.length === 0 || receipt.build_families.some((family) => !family.id || !Number.isFinite(family.duration_ms) || family.duration_ms < 0)) {
    throw new Error("cold-build family timings are missing or invalid");
  }
  if (receipt.result !== "pass") {
    const failure = receipt.failure?.class || "unknown";
    throw new Error(`cold-build canary failed (${failure}): ${receipt.failure?.reason || "no failure reason"}`);
  }
  const audit = auditTimingPolicy(policy);
  if (receipt.timing_audit?.verdict !== "pass") throw new Error("cold-build timing audit did not pass");
  if (Number(receipt.wall_clock_ms) > audit.thresholds.miss_max_seconds * 1000) {
    throw new Error(`cold-build canary exceeded calibrated threshold: ${(receipt.wall_clock_ms / 1000).toFixed(2)}s > ${audit.thresholds.miss_max_seconds}s`);
  }
  return audit;
}
