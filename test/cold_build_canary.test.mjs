import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertColdReceipt,
  auditTimingPolicy,
  buildCacheBustKey,
  classifyBuildFailure,
  classifyCacheMode,
  createCanaryReceipt,
  percentile,
} from "../tools/lib/cold_build_canary.mjs";

const policy = JSON.parse(readFileSync(new URL("../tools/cold_build_canary_policy.json", import.meta.url)));
const timingFixture = JSON.parse(readFileSync(new URL("./fixtures/cold-build-canary/timing-distribution.v1.json", import.meta.url)));

test("classifies only verified reusable output as a cache hit", () => {
  assert.deepEqual(classifyCacheMode({ artifactRestored: true, cacheHit: true, identityVerified: true }), {
    mode: "hit",
    reason: "verified-reusable-artifact",
  });
  assert.deepEqual(classifyCacheMode({ artifactRestored: true, cacheHit: true, identityVerified: false }), {
    mode: "miss",
    reason: "cache-candidate-rejected-and-rebuilt",
  });
  assert.equal(classifyCacheMode().mode, "miss");
});

test("audits hit and miss distributions against an explicit cold calibration", () => {
  const audit = auditTimingPolicy({ ...policy, samples: {
    hit_seconds: timingFixture.hit_seconds,
    miss_seconds: timingFixture.miss_seconds,
  } });
  assert.equal(audit.distributions.hit.p95_seconds, 6.1);
  assert.equal(audit.distributions.miss.p95_seconds, 1062);
  assert.equal(audit.thresholds.miss_max_seconds, 1200);
  assert.equal(audit.calibration.observed_cold_build_upper_seconds, 1062);
  assert.equal(audit.verdict, "pass");
});

test("rejects a threshold copied from cache-hit timings", () => {
  const bad = structuredClone(policy);
  bad.thresholds.miss_max_seconds = 30;
  assert.throws(() => auditTimingPolicy(bad), /cache-miss threshold/);
});

test("reports product failures separately from environment failures", () => {
  assert.deepEqual(classifyBuildFailure({ status: 2 }), {
    class: "product-build-regression",
    reason: "build exited with status 2",
  });
  assert.equal(classifyBuildFailure({ signal: "SIGTERM" }).class, "environment");
  assert.equal(classifyBuildFailure({ spawnError: { code: "ETIMEDOUT", message: "timed out" } }).class, "environment");
  assert.equal(classifyBuildFailure({ status: 0 }), null);
});

test("cold receipts cannot claim a cache-hit path as cold evidence", () => {
  const receipt = {
    schema: "cityscroll.cold_build_canary_receipt.v1",
    input: { build_input_identity: "a", commit_sha: "b", tree_sha: "c" },
    cache: { mode: "hit", strategy: "isolated-output-no-restore" },
    result: "pass",
    wall_clock_ms: 1000,
    stages: [{ stage: "build", duration_ms: 900, result: "pass" }],
    timing_audit: { verdict: "pass" },
  };
  assert.throws(() => assertColdReceipt(receipt, policy), /cache miss/);
});

test("generates a durable receipt with identity, cache mode, result, and timings", () => {
  const audit = auditTimingPolicy(policy);
  const receipt = createCanaryReceipt({
    identity: { build_input_identity: "input", commit_sha: "commit", tree_sha: "tree", lockfile_sha256: "lock", node_version: "v22" },
    cache: { mode: "miss", strategy: "isolated-output-no-restore", cache_bust_key: "bust", canary_id: "run-1" },
    result: "pass",
    wallClockMs: 1062000,
    timingAudit: audit,
    stages: [{ stage: "derived_json_build_boundary.mjs", duration_ms: 1060000, result: "pass" }],
    buildFamilies: [{ id: "keyword-index", duration_ms: 200000 }],
  });
  assert.equal(receipt.schema, "cityscroll.cold_build_canary_receipt.v1");
  assert.equal(receipt.input.build_input_identity, "input");
  assert.equal(receipt.cache.mode, "miss");
  assert.equal(receipt.result, "pass");
  assert.equal(receipt.wall_clock_ms, 1062000);
  assert.equal(receipt.stages[0].duration_ms, 1060000);
  assert.equal(receipt.build_families[0].id, "keyword-index");
});

test("cache-bust keys vary by canary run while input identity stays explicit", () => {
  assert.notEqual(buildCacheBustKey("input-a", "run-1"), buildCacheBustKey("input-a", "run-2"));
  assert.equal(percentile([5, 1, 3], 0.95), 5);
});
