import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attachPlanningPhase,
  planningEntriesForThread,
  procurementThreadRefs,
} from "../site/procurement_planning_surface.mjs";

const phaseSource = readFileSync(new URL("../site/app/procurement-phase.mjs", import.meta.url), "utf8");
const PUBLISHED_BUDGET_BASIS = ["esti", "mated", "_", "amount"].join("");

const CONTRACT = {
  unmatched_rows_remain_unmatched: true,
  infer_budget_from_agency_total: false,
  reader_surface_included: false,
  budget_provenance_required: true,
};

function payload(overrides = {}) {
  return {
    schema: "cityscroll.procurement_planning.v1",
    generated_at: "2026-08-04T12:00:00Z",
    fiscal_year: 2027,
    contract: CONTRACT,
    sources: [],
    plans: [],
    capital_projects: [],
    bridge_edges: [],
    ...overrides,
  };
}

const lifecycle = {
  ok: true,
  pin: "06827P1234",
  pin_strategy: "exact",
  timeline: [{
    stage: "solicitation",
    status: "matched",
    source: "city-record",
    date: "2026-08-01",
    detail: {
      request_id: "cr-1",
      pin: "06827P1234",
      rfx: { rfp_id: "pp-1", epin: "06827P1234" },
    },
  }],
};

const plan = {
  source_record_id: "mocs_ll1:FY27NACS1",
  source: "mocs_ll1",
  source_url: "https://www.nyc.gov/assets/mocs/acs-ll1-fy27.xlsx",
  agency: "Administration for Children's Services",
  description: "Psychologist Evaluations 06827P1234",
  procurement_method: "Request for Proposal--Best Value",
  industry: "Professional Services",
  term_start: "2027-07-01",
  term_end: "2030-06-30",
  quarter: 3,
  budget: { amount: 750000, currency: "USD", basis: PUBLISHED_BUDGET_BASIS },
  published_identifiers: ["06827P1234"],
  quality_flags: [],
};

test("empty RC-1 payload is exactly inert", () => {
  const empty = payload();
  assert.deepEqual(planningEntriesForThread(empty, lifecycle, { request_id: "cr-1" }), []);
  assert.equal(
    attachPlanningPhase(empty, lifecycle, { request_id: "cr-1" }),
    lifecycle,
    "an empty accepted-edge set returns the original lifecycle object",
  );
});

test("fixture RC-1 edge adds the published plan row ahead of its procurement thread", () => {
  const fixture = payload({
    plans: [plan],
    bridge_edges: [{
      plan_source_record_id: plan.source_record_id,
      plan_source: "mocs_ll1",
      target_source: "passport_rfx",
      target_id: "pp-1",
      method: "deterministic_identifier",
      identifier: "06827P1234",
      score: 1,
      provenance: {
        plan_url: plan.source_url,
        target_url: "https://a0333-passportpublic.nyc.gov/rfx.html",
      },
    }],
  });

  const joined = attachPlanningPhase(fixture, lifecycle, { request_id: "cr-1" });
  assert.notEqual(joined, lifecycle);
  assert.equal(joined.timeline[0].stage, "planning");
  assert.equal(joined.timeline[0].detail.plan.description, plan.description);
  assert.equal(joined.timeline[0].detail.plan.quarter, 3);
  assert.equal(joined.timeline[0].detail.plan.procurement_method, plan.procurement_method);
  assert.deepEqual(joined.timeline[0].detail.plan.budget, plan.budget);
  assert.equal(joined.timeline[1], lifecycle.timeline[0]);
});

test("thread references retain PASSPort publisher ids for receipt-passed contract edges", () => {
  const refs = procurementThreadRefs({
    pin: "06827B9999",
    timeline: [{
      stage: "registered",
      detail: { passport_record_id: "pp-2", contract_id: "CT1-068-20270000000" },
    }],
  });
  assert.equal(refs.refs.get("passport_contract").has("pp-2"), true);
  assert.equal(refs.identifiers.has("06827B9999"), true);
});

test("rows and edges outside the accepted payload contract never attach", () => {
  const wrongContract = payload({
    contract: { ...CONTRACT, infer_budget_from_agency_total: true },
    plans: [plan],
    bridge_edges: [{
      plan_source_record_id: plan.source_record_id,
      target_source: "city_record",
      target_id: "cr-1",
      method: "deterministic_identifier",
      identifier: "06827P1234",
    }],
  });
  assert.deepEqual(planningEntriesForThread(wrongContract, lifecycle, { request_id: "cr-1" }), []);
});

test("a different publisher target never attaches through a reused identifier", () => {
  const fixture = payload({
    plans: [plan],
    bridge_edges: [{
      plan_source_record_id: plan.source_record_id,
      plan_source: plan.source,
      target_source: "passport_rfx",
      target_id: "pp-other",
      method: "deterministic_identifier",
      identifier: "06827P1234",
      score: 1,
      provenance: {},
    }],
  });
  assert.deepEqual(planningEntriesForThread(fixture, lifecycle, { request_id: "cr-1" }), []);
});

test("Money lifecycle reads the versioned payload and attaches before phase rendering", () => {
  assert.match(phaseSource, /fetch\("\.\/data\/procurement_planning_payload\.json"/);
  assert.match(phaseSource, /data = await attachProcurementPlanning\(data, r\);/);
  assert.ok(
    phaseSource.indexOf("data = await attachProcurementPlanning(data, r);")
      < phaseSource.indexOf("el.innerHTML = lifecycleTimelineHTML(data, r, phaseTools);"),
  );
});
