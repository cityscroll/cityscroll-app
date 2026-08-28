import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildTelemetry, canonicalJson } from "../tools/merge_throughput_telemetry.mjs";

const source = JSON.parse(fs.readFileSync(new URL("./fixtures/merge-throughput/source.json", import.meta.url), "utf8"));

test("daily telemetry keeps Little's Law fields on one observation window", () => {
  const result = buildTelemetry(source);
  const gauges = result.dailyGauges;

  assert.equal(gauges.window.started_at, source.window.started_at);
  assert.equal(gauges.window.ended_at, source.window.ended_at);
  assert.equal(result.receipt.source_measurement, "estimated");
  assert.equal(gauges.totals.arrivals.value, 4);
  assert.equal(gauges.totals.successful_dequeues.value, 3);
  assert.equal(gauges.diagnosis.inventory_growth.state, "arrivals_exceed_successful_dequeues");
  assert.equal(gauges.rates.arrival_rate_per_day.denominator, gauges.queueing_decomposition.denominators.arrival_prs);
  assert.equal(gauges.queueing_decomposition.identity_holds, true);
  assert.equal(gauges.queueing_decomposition.residual.value, 0);
});

test("attempt and check receipts preserve ejections, identity, and unknown observations", () => {
  const result = buildTelemetry(source);
  const ejected = result.attemptReceipts.filter((attempt) => attempt.ejection.count === 1);
  assert.deepEqual(ejected.map((attempt) => attempt.ejection.cause), ["failed_checks", "merge_conflict"]);
  assert.equal(ejected[0].failure_class, "flaky-shard-ejection");
  assert.equal(ejected[1].failure_class, "generated-file-conflict");
  assert.equal(result.checkReceipts.length, result.attemptReceipts.length * source.required_checks.length);

  const unavailable = result.checkReceipts.filter((check) => check.status === "unavailable");
  const pending = result.checkReceipts.filter((check) => check.status === "pending");
  assert.equal(unavailable.length, 5);
  assert.equal(pending.length, 1);
  assert.ok(unavailable.every((check) => check.duration_seconds.value === null));
  assert.ok(unavailable.every((check) => check.failure.value === null && check.failure.measurement === "unknown"));
  assert.ok(pending.every((check) => check.failure.value === null && check.failure.measurement === "unknown"));
  assert.equal(result.checkGauges.find((check) => check.required_check.startsWith("Accessibility")).flake_rate.value, 1);
});

test("fixture replay is idempotent and dashboard exposes provenance and incomplete state", () => {
  const first = buildTelemetry(source);
  const second = buildTelemetry(JSON.parse(JSON.stringify(source)));
  assert.equal(canonicalJson(first.receipt), canonicalJson(second.receipt));
  assert.equal(first.dashboard, second.dashboard);
  assert.match(first.dashboard, /Receipt hash:/);
  assert.match(first.dashboard, /2026-08-24T00:00:00Z through 2026-08-27T00:00:00Z/);
  assert.match(first.dashboard, /Denominators:/);
  assert.match(first.dashboard, /incomplete data/);
  assert.match(first.dashboard, /candidate service-loss signal/);
});

test("invalid failure class is rejected instead of becoming an unclassified signal", () => {
  const invalid = JSON.parse(JSON.stringify(source));
  invalid.attempts[1].failure_class = "not-a-taxonomy-class";
  assert.throws(() => buildTelemetry(invalid), /unknown class/);
});
