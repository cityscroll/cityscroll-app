// Pure matter PIN phase spine: phase-group, aggregate, dedupe, current/next.
//
//   node --test test/matter_phase_spine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATTER_PROCUREMENT_PHASES,
  mapStageToPhase,
  mapNoticeTypeToStage,
  aggregatePhaseMilestones,
  countDuplicateSourceLinks,
  buildMatterPhaseView,
  noticeToMilestone,
} from "../site/matter_phase_spine.mjs";

const ROWS = [
  {
    request_id: "20250110001",
    type_of_notice_description: "Solicitation",
    short_title: "Prevention services",
    start_date: "2025-01-10",
    pin: "06820P8165KXLR002",
    agency_name: "ACS",
    vendor_name: null,
    contract_amount: null,
    due_date: "2025-02-15",
  },
  {
    request_id: "20250201001",
    type_of_notice_description: "Intent to Award",
    short_title: "Prevention services",
    start_date: "2025-02-01",
    pin: "06820P8165KXLR002",
    agency_name: "ACS",
    vendor_name: "ACME CORP",
    contract_amount: 5000000,
    due_date: null,
  },
  {
    request_id: "20250215001",
    type_of_notice_description: "Award",
    short_title: "Prevention services",
    start_date: "2025-02-15",
    pin: "06820P8165KXLR002",
    agency_name: "ACS",
    vendor_name: "ACME CORP",
    contract_amount: 5000000,
    due_date: null,
  },
  // Second award same title (aggregate candidate)
  {
    request_id: "20250301001",
    type_of_notice_description: "Award",
    short_title: "Prevention services",
    start_date: "2025-03-01",
    pin: "06820P8165KXLR002R001",
    agency_name: "ACS",
    vendor_name: "ACME CORP",
    contract_amount: 5100000,
    due_date: null,
  },
];

const REG = {
  contract_id: "CT106820278800037",
  registration_date: "2025-04-01",
  current_amount: 10840000,
  spent_to_date: 2500000,
  start_date: "2025-04-01",
  end_date: "2028-03-31",
  agid: "12345",
  document_code: "CT1",
};

test("mapNoticeTypeToStage covers City Record procurement types", () => {
  assert.equal(mapNoticeTypeToStage("Solicitation"), "solicitation");
  assert.equal(mapNoticeTypeToStage("Intent to Negotiate"), "intent_to_negotiate");
  assert.equal(mapNoticeTypeToStage("Vendor List"), "vendor_list");
  assert.equal(mapNoticeTypeToStage("Intent to Award"), "intent_to_award");
  assert.equal(mapNoticeTypeToStage("Award"), "award");
  assert.equal(mapStageToPhase("intent_to_award"), "selection");
  assert.equal(mapStageToPhase("registered"), "award_registration");
  assert.equal(mapStageToPhase("payment"), "payments");
});

test("buildMatterPhaseView groups under four procurement phases", () => {
  const view = buildMatterPhaseView(ROWS, { pin: "06820P8165KXLR002", regDetail: REG });
  assert.equal(view.schema_version, 1);
  assert.deepEqual(
    view.phases.map((p) => p.id),
    [...MATTER_PROCUREMENT_PHASES],
  );
  const byId = Object.fromEntries(view.phases.map((p) => [p.id, p]));
  assert.equal(byId.solicitation.event_count, 1);
  assert.equal(byId.selection.event_count, 1);
  assert.ok(byId.award_registration.event_count >= 3); // 2 awards + registered
  assert.equal(byId.payments.event_count, 1);
});

test("buildMatterPhaseView: current is payments when registration spend is present", () => {
  const view = buildMatterPhaseView(ROWS, { pin: "06820P8165KXLR002", regDetail: REG });
  assert.equal(view.current.phase_id, "payments");
  assert.equal(view.current.action_key, "matter_phase_action_follow_money");
  assert.equal(view.next, null);
  const states = Object.fromEntries(view.phases.map((p) => [p.id, p.state]));
  assert.equal(states.solicitation, "passed");
  assert.equal(states.selection, "passed");
  assert.equal(states.award_registration, "passed");
  assert.equal(states.payments, "current");
});

test("buildMatterPhaseView: solicitation-only matter stays in solicitation", () => {
  const onlySol = ROWS.filter((r) => r.type_of_notice_description === "Solicitation");
  const view = buildMatterPhaseView(onlySol, { pin: "06820P8165KXLR002" });
  assert.equal(view.current.phase_id, "solicitation");
  assert.equal(view.current.action_key, "matter_phase_action_respond");
  assert.equal(view.next?.phase_id, "selection");
  assert.equal(view.has_registration, false);
  assert.equal(view.checkbook?.pin, "06820P8165KXLR002");
});

test("aggregatePhaseMilestones collapses identical award titles", () => {
  const ms = ROWS.filter((r) => r.type_of_notice_description === "Award").map((r) =>
    noticeToMilestone(r, "06820P8165KXLR002"),
  );
  const aggs = aggregatePhaseMilestones(ms);
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0].count, 2);
  assert.equal(aggs[0].first, "2025-02-15");
  assert.equal(aggs[0].last, "2025-03-01");
});

test("countDuplicateSourceLinks: N City Record rows → N-1 duplicate candidates", () => {
  const ms = ROWS.map((r) => noticeToMilestone(r, "06820P8165KXLR002"));
  assert.equal(countDuplicateSourceLinks(ms), 3); // 4 city-record → 3 extras
});

test("buildMatterPhaseView: one Checkbook target and action notice id", () => {
  const view = buildMatterPhaseView(ROWS, { pin: "06820P8165KXLR002", regDetail: REG });
  assert.equal(view.checkbook.contractId, "CT106820278800037");
  assert.ok(view.action_notice_id);
  assert.equal(view.latest_notice_id, "20250301001");
  assert.ok(view.duplicate_link_candidates >= 3);
  // Future phases have zero display events (substance behind current/history only)
  const future = view.phases.filter((p) => p.state === "future");
  assert.ok(future.every((p) => p.event_count === 0));
});

test("buildMatterPhaseView: unmatched registration still surfaces award phase", () => {
  const lifecycle = {
    timeline: [{ stage: "registered", status: "unmatched", source: "checkbook-contracts" }],
  };
  const awards = ROWS.filter((r) => r.type_of_notice_description === "Award");
  const view = buildMatterPhaseView(awards, {
    pin: "06820P8165KXLR002",
    lifecycle,
  });
  assert.equal(view.current.phase_id, "award_registration");
  assert.equal(view.registration_unmatched, true);
  assert.equal(view.has_registration, false);
});

test("renewal-linked flag when row PIN differs from matter PIN", () => {
  const m = noticeToMilestone(ROWS[3], "06820P8165KXLR002");
  assert.equal(m.renewal_linked, true);
  assert.equal(m.pin, "06820P8165KXLR002R001");
});
