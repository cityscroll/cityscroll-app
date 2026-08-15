import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createRequire } from "node:module";
import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import {
  examNumbersForAgency,
  filterExamsByAgencyScope,
  hireMatchesAgencyScope,
  sodaAgencyNameClause,
  staffingAgencyScopePresentation,
} from "../site/staffing_agency_scope.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const PARKS_ID = "parks-and-recreation";
const PARKS_NAME = resolveAgencyIdentity(PARKS_ID).canonical_name;
const PARKS_SOURCE = "DEPT OF PARKS & RECREATION";

test("Parks agency scope matches City Record personnel spelling, not only the canonical label", () => {
  assert.equal(hireMatchesAgencyScope(PARKS_SOURCE, PARKS_NAME), true);
  assert.equal(hireMatchesAgencyScope(PARKS_SOURCE, `agency:id:${PARKS_ID}`), false);
  assert.equal(hireMatchesAgencyScope(PARKS_SOURCE, PARKS_ID), true);
  assert.equal(hireMatchesAgencyScope("POLICE DEPARTMENT", PARKS_NAME), false);
  assert.equal(hireMatchesAgencyScope(PARKS_SOURCE, ""), true);
});

test("filterHireNotices identity matcher keeps Parks rows under a canonical agency filter", () => {
  const notices = Staffing.hireNotices([
    {
      request_id: "parks-1",
      start_date: "2026-04-24T00:00:00.000",
      agency_name: PARKS_SOURCE,
      additional_description_1:
        "Effective Date: 04/20/2026; Provisional Status: No; Title Code: 81310; Reason For Change: APPOINTED; Salary: 50000.00; Employee Name: PARKS,PERSON",
    },
    {
      request_id: "pd-1",
      start_date: "2026-04-25T00:00:00.000",
      agency_name: "POLICE DEPARTMENT",
      additional_description_1:
        "Effective Date: 04/21/2026; Provisional Status: No; Title Code: 70210; Reason For Change: APPOINTED; Salary: 60000.00; Employee Name: PD,PERSON",
    },
  ], []);
  const filtered = Staffing.filterHireNotices(notices, {
    agency: PARKS_NAME,
    agencyMatch: (agency) => hireMatchesAgencyScope(agency, PARKS_NAME),
  });
  assert.deepEqual(filtered.map((row) => row.request_id), ["parks-1"]);
  assert.ok(filtered.length < notices.length);
});

test("SODA agency clause expands Parks to the published personnel spelling", () => {
  const clause = sodaAgencyNameClause(PARKS_NAME);
  assert.match(clause, /agency_name in\(/);
  assert.match(clause, /DEPT OF PARKS & RECREATION/);
  assert.match(clause, /Parks and Recreation/);
});

test("exam certification edges filter staffing exams to Parks; unscoped exams stay out", () => {
  const certification = JSON.parse(
    readFileSync(new URL("../site/data/exam_certification_constellation.json", import.meta.url), "utf8"),
  );
  const exams = JSON.parse(
    readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url), "utf8"),
  ).exams;
  const numbers = examNumbersForAgency(certification, PARKS_ID);
  assert.ok(numbers.size > 0, "Parks has published certification edges");
  const scoped = filterExamsByAgencyScope(exams, numbers);
  assert.ok(scoped.length > 0, "at least one current staffing exam is certified to Parks");
  assert.ok(scoped.length < exams.length, "agency exam scope is a strict subset of the citywide guide");
  assert.ok(scoped.every((exam) => numbers.has(String(exam.exam_number))));

  const presentation = staffingAgencyScopePresentation(PARKS_NAME, numbers);
  assert.equal(presentation.leadWithAppointments, true);
  assert.equal(presentation.showExamGuide, true);
  assert.equal(presentation.examFilterActive, true);

  const emptyPresentation = staffingAgencyScopePresentation(PARKS_NAME, new Set());
  assert.equal(emptyPresentation.showExamGuide, false);
  assert.equal(emptyPresentation.leadWithAppointments, true);

  const unscoped = staffingAgencyScopePresentation("", null);
  assert.equal(unscoped.leadWithAppointments, false);
  assert.equal(unscoped.showExamGuide, true);
});

test("routing hydrates people agency from typed entity_refs_all facet (source contract)", () => {
  const routing = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
  assert.match(routing, /agencyFromRouteFacet\(activeRouteFacetValues\)/);
  assert.match(routing, /reloadStaffingForAgencyScope/);
  const people = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(people, /sodaAgencyNameClause/);
  assert.match(people, /filterExamsByAgencyScope/);
  assert.match(people, /hireMatchesAgencyScope/);
});
