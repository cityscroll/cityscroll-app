/**
 * Characterization: procurement lifecycle coherence counters + metric.
 *
 * Named metric: procurement_lifecycle_coherence_rate
 *   coherent_lifecycles / eligible_lifecycles
 *
 * Issue kinds: orphaned_award, payment_exceeds_commitment, out_of_order_dates
 *
 * verify:
 *   node --test worker/test/lifecycle_coherence.test.mjs
 *   node worker/scripts/lifecycle-coherence-scorecard.mjs --fixtures worker/test/fixtures/lifecycle-coherence --check
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleLifecycle } from "../src/lib/checkbook_lifecycle.mjs";
import {
  COHERENCE_ISSUE_KINDS,
  LIFECYCLE_COHERENCE_VERSION,
  attachLifecycleCoherence,
  buildLifecycleCoherence,
  detectLifecycleCoherenceIssues,
  measureProcurementLifecycleCoherenceRate,
  resolveCommitmentAmount,
  resolvePaidAmount,
  stageDay,
} from "../src/lib/lifecycle_coherence.mjs";
import { buildProcurementCoherenceCases } from "./fixtures/lifecycle-coherence/build_cases.mjs";

test("closed issue-kind registry is stable", () => {
  assert.equal(LIFECYCLE_COHERENCE_VERSION, "lifecycle_coherence_v1");
  assert.deepEqual(Object.keys(COHERENCE_ISSUE_KINDS).sort(), [
    "orphaned_award",
    "out_of_order_dates",
    "payment_exceeds_commitment",
  ]);
});

test("helpers: commitment, paid amount, stage day", () => {
  const stages = new Map([
    ["award", { status: "matched", detail: { amount: 100 } }],
    ["registered", { status: "matched", detail: { current_amount: 150, original_amount: 100 } }],
  ]);
  assert.equal(resolveCommitmentAmount(stages), 150);
  assert.equal(
    resolvePaidAmount({ status: "matched", detail: { total_spent: 40, payment_state: "paid" } }),
    40,
  );
  assert.equal(
    resolvePaidAmount({ status: "matched", detail: { total_spent: null, payment_state: "unavailable" } }),
    null,
  );
  assert.equal(stageDay({ status: "matched", date: "2025-04-01" }), Date.parse("2025-04-01T00:00:00Z") / 86400000);
  assert.equal(stageDay({ status: "unmatched", date: "2025-04-01" }), null);
});

test("detect orphaned_award when award matched and solicitation absent", () => {
  const lifecycle = {
    timeline: [
      { stage: "award", status: "matched", date: "2026-06-29", detail: { amount: 100 } },
      { stage: "registered", status: "matched", date: "2026-06-22", detail: { current_amount: 100 } },
      { stage: "payment", status: "matched", detail: { total_spent: 0, payment_state: "verified_zero" } },
    ],
  };
  const findings = detectLifecycleCoherenceIssues(lifecycle);
  assert.ok(findings.some((f) => f.kind === "orphaned_award"));
  // Registration before award also fires out_of_order.
  assert.ok(findings.some((f) => f.kind === "out_of_order_dates"));
});

test("detect payment_exceeds_commitment", () => {
  const findings = detectLifecycleCoherenceIssues({
    timeline: [
      { stage: "solicitation", status: "matched", date: "2024-01-01" },
      { stage: "award", status: "matched", date: "2025-01-15", detail: { amount: 100000 } },
      {
        stage: "registered",
        status: "matched",
        date: "2025-02-01",
        detail: { current_amount: 100000, original_amount: 100000 },
      },
      {
        stage: "payment",
        status: "matched",
        date: "2025-04-01",
        detail: { total_spent: 250000, payment_state: "paid" },
      },
    ],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "payment_exceeds_commitment");
  assert.equal(findings[0].detail.paid, 250000);
  assert.equal(findings[0].detail.commitment, 100000);
});

test("detect out_of_order_dates across matched stages", () => {
  const findings = detectLifecycleCoherenceIssues({
    timeline: [
      { stage: "solicitation", status: "matched", date: "2024-12-15" },
      { stage: "award", status: "matched", date: "2025-06-01", detail: { amount: 50 } },
      {
        stage: "registered",
        status: "matched",
        date: "2025-01-10",
        detail: { current_amount: 50 },
      },
    ],
  });
  assert.ok(findings.some((f) => f.kind === "out_of_order_dates"));
  const oo = findings.find((f) => f.kind === "out_of_order_dates");
  assert.equal(oo.detail.earlier_stage, "award");
  assert.equal(oo.detail.later_stage, "registered");
});

test("coherent clean path has empty findings", () => {
  const findings = detectLifecycleCoherenceIssues({
    timeline: [
      { stage: "solicitation", status: "matched", date: "2025-01-10" },
      { stage: "pending", status: "passed", date: null },
      {
        stage: "registered",
        status: "matched",
        date: "2025-04-01",
        detail: { current_amount: 5000000, original_amount: 5000000 },
      },
      {
        stage: "payment",
        status: "matched",
        date: "2025-08-20",
        detail: { total_spent: 1500000, payment_state: "paid" },
      },
    ],
  });
  assert.deepEqual(findings, []);
  assert.equal(buildLifecycleCoherence({
    timeline: [
      { stage: "solicitation", status: "matched", date: "2025-01-10" },
      {
        stage: "registered",
        status: "matched",
        date: "2025-04-01",
        detail: { current_amount: 5000000 },
      },
    ],
  }).coherent, true);
});

test("assembleLifecycle stamps coherence side-car", () => {
  const result = assembleLifecycle(
    {
      request_id: "X1",
      agency_name: "A",
      type_of_notice_description: "Award",
      start_date: "2025-06-01",
      short_title: "S",
      pin: "84124P0003001",
      vendor_name: "V",
      contract_amount: "100",
    },
    [],
    [{
      id: "CT1", vendor: "V", current: 100, original: 100, spent: 0, registered: "2025-01-01",
    }],
    [],
    { lookupStatus: { pending: "ok", registered: "ok", spending: "ok" } },
  );
  assert.ok(result.coherence);
  assert.equal(result.coherence.version, LIFECYCLE_COHERENCE_VERSION);
  assert.equal(result.coherence.coherent, false);
  assert.ok(result.coherence.issue_kinds.includes("orphaned_award"));
  // Refresh path stays pure.
  const refreshed = attachLifecycleCoherence({ ...result, coherence: null });
  assert.equal(refreshed.coherence.coherent, false);
});

test("procurement_lifecycle_coherence_rate on field fixtures is measurable and < 1", () => {
  const cases = buildProcurementCoherenceCases();
  assert.equal(cases.length, 5);

  for (const row of cases) {
    assert.ok(row.lifecycle, `lifecycle missing for ${row.id}`);
    const kinds = detectLifecycleCoherenceIssues(row.lifecycle).map((f) => f.kind);
    for (const expected of row.expect_kinds) {
      assert.ok(
        kinds.includes(expected),
        `${row.id}: expected kind ${expected}, got [${kinds.join(", ")}]`,
      );
    }
    if (row.expect_coherent) {
      assert.equal(kinds.length, 0, `${row.id}: expected coherent, got ${kinds.join(", ")}`);
    } else {
      assert.ok(kinds.length >= 1, `${row.id}: expected issues`);
    }
  }

  const measured = measureProcurementLifecycleCoherenceRate(cases);
  assert.equal(measured.metric, "procurement_lifecycle_coherence_rate");
  assert.equal(measured.version, LIFECYCLE_COHERENCE_VERSION);
  assert.equal(measured.eligible, 5);
  assert.equal(measured.coherent, 2);
  assert.equal(measured.rate, 0.4);
  assert.ok(measured.issue_counts.orphaned_award >= 1);
  assert.ok(measured.issue_counts.payment_exceeds_commitment >= 1);
  assert.ok(measured.issue_counts.out_of_order_dates >= 1);

  // Metric moves: stripping issues raises the rate.
  const onlyCoherent = cases.filter((c) => c.expect_coherent);
  const raised = measureProcurementLifecycleCoherenceRate(onlyCoherent);
  assert.equal(raised.rate, 1);
  assert.ok(raised.rate > measured.rate, "rate must move when issue cases leave the set");
});

test("ineligible rows do not inflate the rate", () => {
  const measured = measureProcurementLifecycleCoherenceRate([
    { id: "empty", lifecycle: { timeline: [] } },
    { id: "no-match", lifecycle: { timeline: [{ stage: "pending", status: "unmatched" }] } },
    { id: "missing" },
  ]);
  assert.equal(measured.eligible, 0);
  assert.equal(measured.rate, 0);
});
