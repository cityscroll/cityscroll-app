/**
 * Characterization: procurement lifecycle coherence counters + metric.
 *
 * Named metrics:
 *   procurement_lifecycle_coherence_rate
 *     coherent_lifecycles / eligible_lifecycles
 *   award_solicitation_recovery_rate
 *     PIN-bearing awards with matched solicitation / PIN-bearing awards
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
import { enrichLifecycleWithPassport } from "../src/lib/passport_lifecycle.mjs";
import {
  COHERENCE_ISSUE_KINDS,
  LIFECYCLE_COHERENCE_VERSION,
  SOLICITATION_RECOVERY_SOURCES,
  attachLifecycleCoherence,
  buildLifecycleCoherence,
  datesComparableForOrder,
  detectLifecycleCoherenceIssues,
  measureAwardSolicitationRecoveryRate,
  measureProcurementLifecycleCoherenceRate,
  resolveCommitmentAmount,
  resolvePaidAmount,
  stageDay,
} from "../src/lib/lifecycle_coherence.mjs";
import { buildProcurementCoherenceCases } from "./fixtures/lifecycle-coherence/build_cases.mjs";

test("closed issue-kind registry is stable", () => {
  assert.equal(LIFECYCLE_COHERENCE_VERSION, "lifecycle_coherence_v2");
  assert.deepEqual(Object.keys(COHERENCE_ISSUE_KINDS).sort(), [
    "orphaned_award",
    "out_of_order_dates",
    "payment_exceeds_commitment",
  ]);
  assert.ok(SOLICITATION_RECOVERY_SOURCES.includes("city-record"));
  assert.ok(SOLICITATION_RECOVERY_SOURCES.includes("passport-public-rfx"));
  assert.ok(SOLICITATION_RECOVERY_SOURCES.includes("ocp-current-solicitations"));
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

test("detect orphaned_award when award matched and solicitation absent — honest named sources", () => {
  const lifecycle = {
    timeline: [
      { stage: "award", status: "matched", date: "2026-06-29", source: "city-record", detail: { amount: 100 } },
      {
        stage: "registered",
        status: "matched",
        date: "2026-06-22",
        source: "checkbook-contracts",
        detail: { current_amount: 100 },
      },
      { stage: "payment", status: "matched", detail: { total_spent: 0, payment_state: "verified_zero" } },
    ],
  };
  const findings = detectLifecycleCoherenceIssues(lifecycle);
  const orphan = findings.find((f) => f.kind === "orphaned_award");
  assert.ok(orphan, "orphaned_award expected");
  assert.equal(orphan.detail.class, "not_yet_ingested");
  assert.equal(orphan.detail.gap_kind, "solicitation_not_in_city_record");
  assert.ok(orphan.detail.sources_named.includes("city-record"));
  assert.ok(orphan.detail.sources_named.includes("passport-public-rfx"));
  assert.ok(orphan.detail.sources_named.includes("ocp-current-solicitations"));
  // Registration before CR award publication is a date-basis artifact — not out_of_order.
  assert.ok(!findings.some((f) => f.kind === "out_of_order_dates"));
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

test("CR publication vs Checkbook registration is NOT out_of_order", () => {
  const findings = detectLifecycleCoherenceIssues({
    timeline: [
      {
        stage: "solicitation",
        status: "matched",
        date: "2024-12-15",
        source: "ocp-current-solicitations",
        date_basis: "event",
      },
      {
        stage: "award",
        status: "matched",
        date: "2025-06-01",
        source: "city-record",
        date_basis: "publication",
        detail: { amount: 50 },
      },
      {
        stage: "registered",
        status: "matched",
        date: "2025-01-10",
        source: "checkbook-contracts",
        date_basis: "registration",
        detail: { current_amount: 50 },
      },
    ],
  });
  assert.ok(!findings.some((f) => f.kind === "out_of_order_dates"));
  assert.equal(
    datesComparableForOrder(
      { stage: "award", source: "city-record", date_basis: "publication" },
      { stage: "registered", source: "checkbook-contracts", date_basis: "registration" },
    ),
    false,
  );
});

test("detect real out_of_order_dates on comparable event basis", () => {
  const findings = detectLifecycleCoherenceIssues({
    timeline: [
      {
        stage: "solicitation",
        status: "matched",
        date: "2025-06-01",
        source: "city-record",
        date_basis: "publication",
      },
      {
        stage: "award",
        status: "matched",
        date: "2025-01-10",
        source: "city-record",
        date_basis: "publication",
        detail: { amount: 50 },
      },
    ],
  });
  assert.ok(findings.some((f) => f.kind === "out_of_order_dates"));
  const oo = findings.find((f) => f.kind === "out_of_order_dates");
  assert.equal(oo.detail.earlier_stage, "solicitation");
  assert.equal(oo.detail.later_stage, "award");
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

test("assembleLifecycle stamps coherence side-car with honest orphan detail", () => {
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
  assert.ok(!result.coherence.issue_kinds.includes("out_of_order_dates"),
    "CR pub vs registration must not flag out_of_order");
  const orphan = result.coherence.findings.find((f) => f.kind === "orphaned_award");
  assert.equal(orphan.detail.class, "not_yet_ingested");
  assert.ok(orphan.detail.sources_named.includes("passport-public-rfx"));
  assert.equal(result.solicitation_recovery.status, "unmatched");
  // Refresh path stays pure.
  const refreshed = attachLifecycleCoherence({ ...result, coherence: null });
  assert.equal(refreshed.coherence.coherent, false);
});

test("RFx recovery fills solicitation and drops orphaned_award", () => {
  const notice = {
    request_id: "20260623008",
    agency_name: "Transportation",
    type_of_notice_description: "Award",
    start_date: "2026-06-29",
    short_title: "Bridge design",
    pin: "84124P0003001",
    vendor_name: "HNTB",
    contract_amount: "100",
  };
  const base = assembleLifecycle(
    notice,
    [],
    [{
      id: "CT184120268807929", vendor: "HNTB", pin: "84124P0003001",
      current: 100, original: 100, spent: 0, registered: "2026-06-22", start: "2024-10-11",
    }],
    [],
    { lookupStatus: { pending: "ok", registered: "ok", spending: "ok" } },
  );
  assert.ok(base.coherence.issue_kinds.includes("orphaned_award"));

  const enriched = enrichLifecycleWithPassport(base, notice, {
    contracts: [],
    rfx: [{
      epin: "84124P0003",
      epin_norm: "84124P0003",
      procurement_name: "Bridge design RFx",
      agency: "Transportation",
      rfx_status: "Closed",
      release_date: "10/01/2024",
      due_date: "11/15/2024",
      rfp_id: "99999",
    }],
    lookupStatus: { contracts: "ok", rfx: "ok" },
  });

  const sol = enriched.timeline.find((e) => e.stage === "solicitation");
  assert.ok(sol, "RFx must inject solicitation stage");
  assert.equal(sol.source, "passport-public-rfx");
  assert.equal(sol.status, "matched");
  assert.equal(sol.date, "2024-10-01");
  assert.equal(enriched.solicitation_recovery.status, "matched");
  assert.equal(enriched.solicitation_recovery.source, "passport-public-rfx");
  assert.ok(!enriched.coherence.issue_kinds.includes("orphaned_award"));
  assert.equal(enriched.passport.rfx_join.method, "epin_prefix_of_pin");
});

test("procurement_lifecycle_coherence_rate on field fixtures is measurable and < 1", () => {
  const cases = buildProcurementCoherenceCases();
  assert.equal(cases.length, 6);

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
  assert.equal(measured.eligible, 6);
  assert.equal(measured.coherent, 3);
  assert.equal(measured.rate, 0.5);
  assert.ok(measured.issue_counts.orphaned_award >= 1);
  assert.ok(measured.issue_counts.payment_exceeds_commitment >= 1);
  assert.ok(measured.issue_counts.out_of_order_dates >= 1);

  // Metric moves: stripping issues raises the rate.
  const onlyCoherent = cases.filter((c) => c.expect_coherent);
  const raised = measureProcurementLifecycleCoherenceRate(onlyCoherent);
  assert.equal(raised.rate, 1);
  assert.ok(raised.rate > measured.rate, "rate must move when issue cases leave the set");
});

test("award_solicitation_recovery_rate rises when RFx/OCP fill solicitation", () => {
  const cases = buildProcurementCoherenceCases();
  const measured = measureAwardSolicitationRecoveryRate(cases);
  assert.equal(measured.metric, "award_solicitation_recovery_rate");
  assert.ok(measured.eligible >= 4, "modern award sample eligible");
  assert.ok(measured.rate > 0, "at least one recovery path in fixtures");
  assert.ok(measured.rate < 1, "orphaned award keeps rate below 1");
  // Recovery cases must name a source.
  const recovered = measured.cases.filter((c) => c.recovered);
  assert.ok(recovered.some((c) => c.source === "ocp-current-solicitations"
    || c.source === "passport-public-rfx"
    || c.source === "city-record"));
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
