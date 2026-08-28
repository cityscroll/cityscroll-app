import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildGateAudit } from "../tools/merge_gate_audit.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/merge-throughput/gate-audit/source.json", import.meta.url), "utf8"));

test("audit scores every declared required check and ranks the evidence-backed actions", () => {
  const audit = buildGateAudit(fixture);
  assert.equal(audit.policy.grouping_strategy, "ALLGREEN");
  assert.equal(audit.policy.required_protection_unchanged, true);
  assert.deepEqual(audit.gates.map((gate) => gate.name), fixture.required_checks);

  const unit = audit.gates[0];
  assert.equal(unit.metrics.catches.value, 3);
  assert.equal(unit.metrics.elapsed_runner_minutes.value, 180);
  assert.equal(unit.metrics.ejection_jam_incidents.value, 3);
  assert.equal(unit.metrics.flake_rate.value, 1);
  assert.equal(unit.metrics.serialization.exclusive_elapsed_runner_minutes.value, 180);
  assert.equal(unit.recommendation.action, "retain-required");

  const accessibility = audit.gates[1];
  assert.equal(accessibility.metrics.catches.value, 1);
  assert.equal(accessibility.metrics.elapsed_runner_minutes.value, 24);
  assert.equal(accessibility.metrics.ejection_jam_incidents.value, 1);
  assert.equal(accessibility.metrics.flake_rate.value, 1);
  assert.equal(accessibility.recommendation.action, "path-filter");
  assert.match(accessibility.recommendation.retained_replacement_check_or_monitor, /path-filtered/i);
  assert.match(accessibility.recommendation.reliability_non_regression_condition, /preserve/i);

  const uninstrumented = audit.gates[2];
  assert.equal(uninstrumented.recommendation.action, "insufficient-evidence");
  assert.equal(uninstrumented.metrics.catches.value, null);
  assert.equal(uninstrumented.metrics.catches.measurement, "unknown");
  assert.equal(uninstrumented.metrics.elapsed_runner_minutes.value, null);
  assert.equal(uninstrumented.metrics.serialization.state, "unknown");
  assert.deepEqual(audit.ranked_recommendations.map((item) => item.action), ["path-filter", "retain-required", "insufficient-evidence"]);
  assert.deepEqual(audit.ranked_recommendations.map((item) => item.rank), [1, 2, 3]);
  assert.equal(audit.candidate_cards.length, 1);
  assert.equal(audit.candidate_cards[0].action, "path-filter");
  assert.equal(audit.candidate_cards[0].approval_required, true);
});

test("audit records the watermark as a separate serialization finding with tradeoffs", () => {
  const audit = buildGateAudit(fixture);
  const finding = audit.supplemental_findings.find((item) => item.gate_id === "architecture-watermark-serialization");
  assert.ok(finding);
  assert.equal(finding.metrics.jam_incidents.value, 4);
  assert.deepEqual(finding.recommendation.options.map((option) => option.id), [
    "merge-neutral-watermark",
    "per-module-split",
    "merge-driver",
  ]);
  assert.equal(finding.metrics.elapsed_runner_minutes.value, null);
  assert.equal(finding.metrics.elapsed_runner_minutes.measurement, "unknown");
});

test("replay is deterministic", () => {
  const first = buildGateAudit(fixture);
  const second = buildGateAudit(JSON.parse(JSON.stringify(fixture)));
  assert.deepEqual(first, second);
});

test("pending-only observations do not become zero catches", () => {
  const pending = JSON.parse(JSON.stringify(fixture));
  pending.checks.push({
    pull_request: 201,
    attempt: 1,
    name: "Reading-level ratchet gate (readable-or-else)",
    status: "pending",
    started_at: "2026-08-24T00:39:00Z",
    completed_at: null,
    source: { run_id: "audit-201-1", url: "https://github.com/cityscroll/cityscroll-app/actions/runs/2011" },
  });
  const reading = buildGateAudit(pending).gates[2];
  assert.equal(reading.metrics.catches.value, null);
  assert.equal(reading.metrics.catches.measurement, "unknown");
  assert.equal(reading.metrics.ejection_jam_incidents.value, null);
  assert.equal(reading.recommendation.action, "retain-required");
});
