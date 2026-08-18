import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  bblsForProject,
  contractIdentityFromFacetValues,
  filterLandSnapshot,
  filterMoneySnapshot,
  moneyMethodFacet,
  projectIdsForBlock,
  staffingPeopleFromAppointments,
  staffingRolesFromExamples,
} from "../site/resident_snapshot_queries.mjs";
import { buildPropertyResidentSnapshot } from "../tools/build_property_resident_snapshot.mjs";

test("Money snapshot filtering composes mode, facet, keyword, and sort", () => {
  const rows = [
    { request_id: "1", type_of_notice_description: "Solicitation", due_date: "2026-08-20", agency_name: "A", short_title: "Park repair", selection_method_description: "Bid" },
    { request_id: "2", type_of_notice_description: "Solicitation", due_date: "2026-08-18", agency_name: "A", short_title: "Roof repair", selection_method_description: "RFP" },
    { request_id: "3", type_of_notice_description: "Award", start_date: "2026-08-10", agency_name: "A", contract_amount: "200" },
  ];
  assert.deepEqual(filterMoneySnapshot(rows, { mode: "open", agency: "A", keyword: "repair", today: "2026-08-15" }).map((row) => row.request_id), ["2", "1"]);
  assert.deepEqual(filterMoneySnapshot(rows, { mode: "award", minAmount: 100, today: "2026-08-15" }).map((row) => row.request_id), ["3"]);
  assert.deepEqual(moneyMethodFacet(rows), [
    { selection_method_description: "Bid", n: 1 },
    { selection_method_description: "RFP", n: 1 },
  ]);
});

test("Money snapshot filtering matches a once-encoded vendor stem exactly", () => {
  const rows = [
    { request_id: "1", type_of_notice_description: "Award", start_date: "2026-08-10", vendor_name: "P&T II Contracting Corp" },
    { request_id: "2", type_of_notice_description: "Award", start_date: "2026-08-09", vendor_name: "P & T II Contracting Corporation" },
    { request_id: "3", type_of_notice_description: "Award", start_date: "2026-08-08", vendor_name: "P and T II Contracting Corp" },
    { request_id: "4", type_of_notice_description: "Award", start_date: "2026-08-07", vendor_name: "Yonkers Contracting Company" },
  ];
  assert.deepEqual(filterMoneySnapshot(rows, {
    mode: "award",
    entityRefs: ["vendor:stem:P T II CONTRACTING"],
  }).map((row) => row.request_id), ["1", "2"]);
});

test("Money snapshot filtering treats a contract handoff as exact identity, not a keyword", () => {
  const identity = contractIdentityFromFacetValues({
    contract_identity: {
      object_ref: "procurement:05626S0013001",
      source_observation_ref: "notice:20260730029",
    },
  });
  const rows = [
    { request_id: "target", pin: "05626S0013001", type_of_notice_description: "Award", short_title: "PhotoManager maintenance" },
    { request_id: "other", pin: "05626P0001", type_of_notice_description: "Solicitation", short_title: "Software platform" },
  ];
  assert.deepEqual(filterMoneySnapshot(rows, {
    mode: "archive",
    keyword: "software",
    contractObjectRef: identity.object_ref,
  }).map((row) => row.request_id), ["target"]);
});

test("Land snapshot resolves blocks and exact project BBLs without source egress", () => {
  const bblRows = [
    { project_id: "P1", bbls: ["1001230001"] },
    { project_id: "P2", bbls: ["2004560002"] },
  ];
  assert.deepEqual(projectIdsForBlock(bblRows, "100123"), ["P1"]);
  assert.deepEqual(bblsForProject(bblRows, "P2"), ["2004560002"]);
  const projects = [
    { project_id: "P1", project_status: "Active", ulurp_non: "ULURP", borough: "Manhattan", project_name: "Library" },
    { project_id: "P2", project_status: "On-Hold", ulurp_non: "ULURP", borough: "Bronx", project_name: "Garage" },
  ];
  assert.deepEqual(filterLandSnapshot(projects, { status: "active", borough: "Manhattan" }).map((row) => row.project_id), ["P1"]);
  assert.deepEqual(filterLandSnapshot(projects, { status: "project:On-Hold" }).map((row) => row.project_id), ["P2"]);
  const mixed = [
    ...projects,
    { project_id: "P3", project_status: "Active", ulurp_non: "ELURP", borough: "Bronx", project_name: "Powers" },
    { project_id: "P4", project_status: "Active", ulurp_non: "Non-ULURP", borough: "Queens", project_name: "Authorization" },
  ];
  assert.deepEqual(filterLandSnapshot(mixed, { status: "active" }).map((row) => row.project_id).sort(), ["P1", "P3"]);
  assert.deepEqual(filterLandSnapshot(mixed, { status: "active", procedure: "ulurp" }).map((row) => row.project_id), ["P1"]);
});

test("Land stage and future-action facets combine and sort by the nearest action", () => {
  const projects = [
    { project_id: "PRE", project_status: "Active", public_status: "Filed", current_milestone: "Project Readiness", current_milestone_date: "2026-08-16" },
    { project_id: "CB", project_status: "Active", public_status: "In Public Review", current_milestone: "EAS - Community Board Referral", current_milestone_date: "2026-08-10" },
    { project_id: "CPC", project_status: "Active", public_status: "In Public Review", current_milestone: "CPC Public Hearing", current_milestone_date: "2026-08-15" },
    { project_id: "PAST", project_status: "Active", public_status: "In Public Review", current_milestone: "Community Board Review", current_milestone_date: "2026-08-14" },
    { project_id: "DONE", project_status: "Complete", public_status: "Completed", current_milestone: "Project Completed", current_milestone_date: "2026-08-17" },
  ];
  const actionRows = [
    { project_id: "PRE", event_class: "cpc_public_hearing", hearing_date: "2026-08-19" },
    { project_id: "CB", event_class: "cpc_public_hearing", hearing_date: "2026-08-22" },
    { project_id: "CPC", event_class: "cpc_public_hearing", hearing_date: "2026-08-20" },
    { project_id: "PAST", event_class: "cpc_public_hearing", hearing_date: "2026-08-16" },
    { project_id: "DONE", event_class: "cpc_public_hearing", hearing_date: "2026-08-21" },
  ];
  assert.deepEqual(filterLandSnapshot(projects, {
    status: "all", stage: "public_review", futureAction: "hearing", actionRows, today: "2026-08-17",
  }).map((row) => row.project_id), ["CPC", "CB"]);
  const matchingAction = filterLandSnapshot(projects, {
    status: "all", stage: "public_review", futureAction: "hearing", actionRows: [
      { project_id: "CPC", event_class: "cpc_session", event_date: "2026-08-18" },
      ...actionRows,
    ], today: "2026-08-17",
  })[0];
  assert.equal(matchingAction._next_action.action_kind, "hearing");
  assert.deepEqual(filterLandSnapshot(projects, {
    status: "all", stage: "community_board", futureAction: "hearing", actionRows, today: "2026-08-17",
  }).map((row) => row.project_id), ["CB"]);
  assert.deepEqual(filterLandSnapshot(projects, {
    status: "all", stage: "public_review", futureAction: "hearing", actionRows, today: "2026-08-23",
  }), []);
});

test("Staffing snapshot supports role and named-person lookup", () => {
  const roles = staffingRolesFromExamples([{ official_title: "CITY PLANNER", competitive: true, headcount: 5, base_min: 10, base_max: 20, base_median: 15, ladder: [] }], "planner");
  assert.equal(roles[0].competitive, true);
  const people = staffingPeopleFromAppointments([{ agency_name: "Planning", additional_description_1: "Reason For Change: APPOINTED; Employee Name: DOE,JANE A." }], "Jane");
  assert.equal(people[0].name, "DOE,JANE A");
});

test("Property snapshot retains multi-notice disposition spines", () => {
  const observations = JSON.parse(readFileSync(new URL("../site/data/property_domain_observations.json", import.meta.url)));
  const committed = JSON.parse(readFileSync(new URL("../site/data/property_resident_snapshot.json", import.meta.url)));
  const built = buildPropertyResidentSnapshot(observations);
  assert.deepEqual(committed, built);
  assert.equal(committed.properties.length, observations.property_rows.length);
  assert.ok(committed.disposition_spines.length > 0);
});
