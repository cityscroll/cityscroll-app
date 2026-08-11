import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attachPlanningLookup,
  attachPlanningPhase,
  planningEntriesForThread,
  procurementThreadRefs,
} from "../site/procurement_planning_surface.mjs";
import { planningRowsForThread } from "../site/procurement_planning_gate.mjs";

const phaseSource = readFileSync(new URL("../site/app/procurement-phase.mjs", import.meta.url), "utf8");
const moneyListSource = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
const gateSource = readFileSync(new URL("../site/procurement_planning_gate.mjs", import.meta.url), "utf8");
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

test("prefix plan PIN joins a thread EPIN without requiring exact identifier equality", () => {
  const prefixPlan = {
    ...plan,
    source_record_id: "mocs_ll63:FY27RNACS8",
    source: "mocs_ll63",
    published_identifiers: ["06823P0008"],
  };
  const fixture = payload({
    plans: [prefixPlan],
    bridge_edges: [{
      plan_source_record_id: prefixPlan.source_record_id,
      plan_source: "mocs_ll63",
      target_source: "passport_contract",
      target_id: "ctr-prefix",
      method: "pin_prefix_of_epin",
      identifier: "06823P0008001",
      score: 1,
      provenance: {
        plan_url: prefixPlan.source_url,
        target_url: "https://a0333-passportpublic.nyc.gov/",
      },
    }],
  });
  const threadLifecycle = {
    ok: true,
    pin: "06823P0008",
    timeline: [{
      stage: "award",
      status: "matched",
      detail: { epin: "06823P0008001", ctr_id: "ctr-prefix" },
    }],
  };
  const joined = attachPlanningPhase(fixture, threadLifecycle, {});
  assert.notEqual(joined, threadLifecycle);
  assert.equal(joined.timeline[0].stage, "planning");
  assert.equal(joined.timeline[0].detail.bridge.method, "pin_prefix_of_epin");
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

test("edge-empty RC-1 thread lookup remains exactly inert", () => {
  const lookup = {
    schema: "cityscroll.procurement_planning.thread-lookup.v1",
    contract: CONTRACT,
    rows: [],
  };
  assert.deepEqual(planningRowsForThread(lookup, lifecycle, { request_id: "cr-1" }), []);
  assert.equal(attachPlanningLookup(lookup, lifecycle, { request_id: "cr-1" }), lifecycle);
});

test("RC-1 thread lookup attaches its receipt-passed fixture row", () => {
  const edge = {
    plan_source_record_id: plan.source_record_id,
    plan_source: plan.source,
    target_source: "passport_rfx",
    target_id: "pp-1",
    method: "deterministic_identifier",
    identifier: "06827P1234",
    score: 1,
  };
  const lookup = {
    schema: "cityscroll.procurement_planning.thread-lookup.v1",
    generated_at: "2026-08-04T16:09:54Z",
    fiscal_year: 2027,
    contract: CONTRACT,
    rows: [{ edge, plan }],
  };
  const joined = attachPlanningLookup(lookup, lifecycle, { request_id: "cr-1" });
  assert.equal(joined.timeline[0].detail.plan, plan);
  assert.equal(joined.timeline[0].detail.bridge.target_id, "pp-1");
});

test("Money lifecycle loads the full planning surface only for a matching lookup row", () => {
  assert.match(moneyListSource, /planningDetailRequested=false/);
  assert.match(moneyListSource, /event\.isTrusted/);
  assert.match(phaseSource, /planning_detail_requested === true/);
  assert.match(phaseSource, /import\("\.\.\/procurement_planning_gate\.mjs"\)/);
  assert.match(gateSource, /fetch\("\.\/data\/procurement_planning_thread_lookup\.json"/);
  assert.match(gateSource, /planningRowsForThread\(lookup, lifecycle, notice\)\.length/);
  assert.match(gateSource, /import\("\.\/procurement_planning_surface\.mjs"\)/);
  assert.match(gateSource, /tools\.attachPlanningLookup\(lookup, lifecycle, notice\)/);
  assert.ok(
    phaseSource.indexOf("gate.attachAvailablePlanning(data, r)")
      < phaseSource.indexOf("el.innerHTML = lifecycleTimelineHTML(data, r, phaseTools);"),
  );
});
