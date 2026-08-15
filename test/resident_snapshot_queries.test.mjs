import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  bblsForProject,
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
