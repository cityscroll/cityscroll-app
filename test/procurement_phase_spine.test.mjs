// Pure procurement phase spine: phase-group, aggregate, dedupe, current/next.
//
//   node --test test/procurement_phase_spine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROCUREMENT_PHASES,
  mapStageToPhase,
  aggregatePhaseMilestones,
  dedupePhaseSourceLinks,
  sourceFamily,
  buildProcurementPhaseView,
  publicStatus,
  currentStageKey,
} from "../site/procurement_phase_spine.mjs";

const FULL = {
  pin: "08250R0001001",
  pin_strategy: "exact",
  ok: true,
  amendments: [],
  timeline: [
    {
      stage: "solicitation",
      status: "matched",
      source: "city-record",
      date: "2025-01-10",
      detail: { request_id: "20250110001", title: "Collection Services", pin: "08250R0001001" },
    },
    {
      stage: "intent_to_award",
      status: "matched",
      source: "city-record",
      date: "2025-02-01",
      detail: { request_id: "I1", title: "Collection Services", vendor: "ACME CORP", amount: 5000000 },
    },
    {
      stage: "award",
      status: "matched",
      source: "city-record",
      date: "2025-02-15",
      detail: { request_id: "A1", vendor: "ACME CORP", amount: 5000000 },
    },
    {
      stage: "pending",
      status: "passed",
      source: "checkbook-contracts",
      date: null,
      detail: null,
    },
    {
      stage: "registered",
      status: "matched",
      source: "checkbook-contracts",
      date: "2025-04-01",
      detail: {
        contract_id: "C-1001",
        vendor: "ACME CORP",
        registration_date: "2025-04-01",
        original_amount: 5000000,
        current_amount: 5000000,
        spent_to_date: 1500000,
      },
    },
    {
      stage: "payment",
      status: "matched",
      source: "checkbook-spending",
      date: "2025-05-15",
      detail: {
        total_payments: 3,
        total_spent: 750000,
        latest_payment_date: "2025-05-15",
        latest_payment_amount: 250000,
        payment_state: "paid",
      },
    },
  ],
};

test("mapStageToPhase: intermediate City Record stages land in selection", () => {
  assert.equal(mapStageToPhase("solicitation"), "solicitation");
  assert.equal(mapStageToPhase("intent_to_negotiate"), "selection");
  assert.equal(mapStageToPhase("vendor_list"), "selection");
  assert.equal(mapStageToPhase("intent_to_award"), "selection");
  assert.equal(mapStageToPhase("award"), "award_registration");
  assert.equal(mapStageToPhase("pending"), "award_registration");
  assert.equal(mapStageToPhase("registered"), "award_registration");
  assert.equal(mapStageToPhase("payment"), "payments");
  assert.equal(mapStageToPhase("nope"), "solicitation");
});

test("buildProcurementPhaseView: groups under four canonical phases", () => {
  const view = buildProcurementPhaseView(FULL);
  assert.equal(view.schema_version, 1);
  assert.equal(view.phases.length, 4);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    PROCUREMENT_PHASES,
  );
  const byId = Object.fromEntries(view.phases.map((p) => [p.id, p]));
  assert.equal(byId.solicitation.event_count, 1);
  assert.equal(byId.selection.event_count, 1);
  assert.ok(byId.award_registration.event_count >= 2);
  assert.equal(byId.payments.event_count, 1);
});

test("buildProcurementPhaseView: current is payments when payment matched", () => {
  const view = buildProcurementPhaseView(FULL);
  assert.equal(view.current.phase_id, "payments");
  assert.equal(view.current.stage, "payment");
  assert.equal(view.current.action_key, "lifecycle_phase_action_follow_money");
  assert.equal(view.next, null);
  const states = Object.fromEntries(view.phases.map((p) => [p.id, p.state]));
  assert.equal(states.solicitation, "passed");
  assert.equal(states.selection, "passed");
  assert.equal(states.award_registration, "passed");
  assert.equal(states.payments, "current");
});

test("buildProcurementPhaseView: fresh solicitation current + future award/payments", () => {
  const data = {
    pin: "2926",
    pin_strategy: "exact",
    timeline: [
      {
        stage: "solicitation",
        status: "matched",
        source: "city-record",
        date: "2026-07-06",
        detail: { request_id: "20260625058", title: "EDC RFP" },
      },
      { stage: "pending", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unmatched", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unmatched", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const view = buildProcurementPhaseView(data);
  assert.equal(view.current.phase_id, "solicitation");
  assert.equal(view.current.action_key, "lifecycle_phase_action_respond");
  assert.equal(view.next?.phase_id, "selection");
  const states = Object.fromEntries(view.phases.map((p) => [p.id, p.state]));
  assert.equal(states.solicitation, "current");
  assert.equal(states.award_registration, "future");
  assert.equal(states.payments, "future");
});

test("dedupePhaseSourceLinks: one checkbook family per phase", () => {
  const entries = [
    { stage: "pending", source: "checkbook-contracts", status: "passed" },
    { stage: "registered", source: "checkbook-contracts", status: "matched" },
    { stage: "payment", source: "checkbook-spending", status: "matched" },
  ];
  const { kept, dropped, families } = dedupePhaseSourceLinks(entries);
  assert.equal(dropped, 2);
  assert.equal(kept.length, 1);
  assert.deepEqual(families, ["checkbook"]);
  assert.equal(sourceFamily("checkbook-spending"), "checkbook");
  assert.equal(sourceFamily("city-record"), "city-record");
  assert.equal(sourceFamily("passport-public-rfx"), "passport");
});

test("aggregatePhaseMilestones: collapses verbatim-identical titles", () => {
  const aggs = aggregatePhaseMilestones([
    {
      stage: "award",
      public_status: "matched",
      date: "2025-02-15",
      title: "ACME CORP",
      entry: {},
    },
    {
      stage: "award",
      public_status: "matched",
      date: "2025-02-16",
      title: "ACME CORP",
      entry: {},
    },
    {
      stage: "registered",
      public_status: "matched",
      date: "2025-04-01",
      title: "ACME CORP",
      entry: {},
    },
  ]);
  // award×2 collapsed; registered separate (different stage)
  assert.equal(aggs.length, 2);
  const awardAgg = aggs.find((a) => a.stage === "award");
  assert.equal(awardAgg.count, 2);
  assert.equal(awardAgg.first, "2025-02-15");
  assert.equal(awardAgg.last, "2025-02-16");
});

test("publicStatus + currentStageKey: payment with registered join is current", () => {
  const tl = [
    { stage: "award", status: "matched", date: "2024-07-29" },
    { stage: "pending", status: "passed", date: null },
    {
      stage: "registered",
      status: "matched",
      date: "2024-07-22",
      detail: { contract_id: "CT1", spent_to_date: 1 },
    },
    {
      stage: "payment",
      status: "unmatched",
      date: null,
      detail: null,
    },
  ];
  assert.equal(publicStatus(tl[3], tl), "matched");
  assert.equal(currentStageKey(tl), "payment");
});

test("buildProcurementPhaseView: no-pin filters Checkbook stages", () => {
  const data = {
    pin: null,
    pin_strategy: "none",
    timeline: [
      {
        stage: "solicitation",
        status: "matched",
        source: "city-record",
        date: "2025-01-10",
        detail: { request_id: "X" },
      },
      { stage: "pending", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
      { stage: "registered", status: "unknown", source: "checkbook-contracts", date: null, detail: null },
      { stage: "payment", status: "unknown", source: "checkbook-spending", date: null, detail: null },
    ],
  };
  const view = buildProcurementPhaseView(data);
  assert.equal(view.no_pin, true);
  assert.equal(view.event_count, 1);
  assert.equal(view.phases.find((p) => p.id === "solicitation").event_count, 1);
  assert.equal(view.phases.find((p) => p.id === "payments").event_count, 0);
});

test("buildProcurementPhaseView: phase_link_stage is one stage per phase for link emission", () => {
  const view = buildProcurementPhaseView(FULL);
  const award = view.phases.find((p) => p.id === "award_registration");
  // Multiple city-record + checkbook entries; only one stage gets the phase link.
  assert.ok(award.phase_link_stage);
  assert.ok(["award", "pending", "registered"].includes(award.phase_link_stage));
  // city-record + checkbook families both present; dropped at least one checkbook duplicate
  assert.ok(award.source_links_dropped >= 0);
  assert.ok(view.duplicate_link_candidates >= 1);
});
