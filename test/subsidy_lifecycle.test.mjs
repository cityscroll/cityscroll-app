// SUB-001 NYCIDA/Build NYC subsidy lifecycle prototype.
//
// Exercises five sourced cases and verifies the join can reconcile money, place, company,
// stage, official action, and outcome while keeping missing docs/amounts as explicit
// unknown values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSubsidyLifecycle, STAGES, parseNYCIDAProjects } from "../worker/src/lib/subsidy_lifecycle.mjs";

const notices = [
  {
    request_id: "20260010001",
    short_title: "East River Redevelopment Subsidy Application",
    vendor_name: "Apex Urban Builders LLC",
    type_of_notice_description: "Award",
    start_date: "2025-01-12",
  },
  {
    request_id: "20260010002",
    short_title: "Harbor District Tax-Abated Site Request",
    vendor_name: "Bayline Developments",
    type_of_notice_description: "Solicitation",
    start_date: "2025-02-08",
  },
  {
    request_id: "20260010003",
    short_title: "Queens Housing Tax-Relief Program",
    vendor_name: "Northside Housing Group",
    type_of_notice_description: "Award",
    start_date: "2025-03-05",
  },
  {
    request_id: "20260010004",
    short_title: "Ridgeway Industrial Assistance Proposal",
    vendor_name: "Civic Makers Fund",
    type_of_notice_description: "Application",
    start_date: "2025-04-11",
  },
  {
    request_id: "20260010005",
    short_title: "Broadway Market Property Support",
    vendor_name: "Riverview Capital",
    type_of_notice_description: "Award",
    start_date: "2025-05-01",
  },
];

const projectRows = [
  {
    request_id: "20260010001",
    project_id: "BND-1001",
    project_name: "East River Redevelopment Subsidy",
    company_name: "Apex Urban Builders LLC",
    project_address: "230 E 20th St, Manhattan, NY",
    requested_benefit_amount: "15000000",
    estimated_public_cost: "32000000",
    application_date: "2025-01-12",
    application_status: "application accepted",
    application_url: "https://edc.nyc/records/10001/application.pdf",
    hearing_date: "2025-02-03",
    hearing_outcome: "held",
    hearing_notice_url: "https://edc.nyc/records/10001/hearing.pdf",
    board_decision_date: "2025-03-14",
    board_decision_outcome: "approved",
    board_body: "NYC Industrial Development Agency",
    board_decision_url: "https://edc.nyc/records/10001/board.html",
    closing_date: "2025-06-04",
    closing_status: "award package approved",
    closing_amount: "15000000",
    closing_notice_url: "https://edc.nyc/records/10001/closing.pdf",
    compliance_date: "2026-06-30",
    compliance_status: "annual report submitted",
    compliance_report_url: "https://edc.nyc/records/10001/compliance.pdf",
    bbl: "3050012345",
  },
  {
    request_id: "20260010002",
    project_id: "BND-1002",
    project_name: "Harbor District Tax-Abated Site",
    company_name: "Bayline Developments",
    project_address: "50 Water Street, Brooklyn, NY",
    requested_benefit_amount: "10000000",
    estimated_public_cost: "45000000",
    application_date: "2025-02-08",
    application_status: "filed",
    application_url: "https://edc.nyc/records/10002/application.pdf",
    hearing_date: "2025-03-10",
    hearing_outcome: "held",
    hearing_notice_url: "https://edc.nyc/records/10002/hearing.pdf",
    board_decision_outcome: "",
  },
  {
    request_id: "20260010003",
    project_id: "BND-1003",
    project_name: "Queens Housing Tax Relief Project",
    company_name: "Northside Housing Group",
    project_address: "120 Queens Blvd, Queens, NY",
    requested_benefit_amount: "8400000",
    estimated_public_cost: "",
    application_date: "2025-03-06",
    application_status: "under review",
    application_url: "https://edc.nyc/records/10003/application.pdf",
    board_decision_date: "2025-03-26",
    board_decision_outcome: "approved with revised terms",
    board_body: "NYC Council",
    board_decision_url: "https://edc.nyc/records/10003/board.html",
  },
  {
    project_id: "BND-1004",
    project_name: "Ridgeway Industrial Assistance Proposal",
    company_name: "Civic Makers Fund",
    project_address: "2 Broadway, Manhattan, NY",
    requested_benefit_amount: "3500000",
    estimated_public_cost: "9800000",
    application_date: "2025-04-11",
    application_status: "filed",
    application_url: "https://edc.nyc/records/10004/application.pdf",
    hearing_date: "2025-05-02",
    hearing_status: "scheduled",
    hearing_venue: "NYCEDC Conference Room",
    // missing both hearing and board evidence documents intentionally
  },
  {
    request_id: "20260010005",
    project_id: "BND-1005",
    project_name: "Broadway Market Property Support",
    company_name: "Riverview Capital",
    project_address: "1000 Broadway, Manhattan, NY",
    requested_benefit_amount: "",
    estimated_public_cost: "",
    application_date: "2025-05-01",
    application_status: "filed",
    application_url: "",
  },
];

const lifecycleRows = assembleSubsidyLifecycle(notices, parseNYCIDAProjects(projectRows));

const byId = new Map(lifecycleRows.map((row) => [row.request_id, row]));

test("SUB-001 has five sourced cases reconciling money/place/company/stage/action/outcome", () => {
  const caseOne = byId.get("20260010001");
  assert.equal(caseOne.company.status, "matched");
  assert.equal(caseOne.company.value, "Apex Urban Builders LLC");
  assert.ok(caseOne.place.boroughs.includes("Manhattan"));
  assert.equal(caseOne.place.status, "matched");
  assert.equal(caseOne.money.requested_benefit.status, "matched");
  assert.equal(caseOne.money.requested_benefit.value, 15000000);
  assert.equal(caseOne.stage, "compliance");
  const finalAction = caseOne.timeline.find((entry) => entry.stage === "compliance");
  assert.equal(finalAction.official_action, "annual_compliance");
  assert.equal(finalAction.outcome, "annual report submitted");

  const caseTwo = byId.get("20260010002");
  assert.equal(caseTwo.stage, "hearing");
  assert.equal(caseTwo.timeline.find((entry) => entry.stage === "hearing").official_action, "public_hearing");
  assert.equal(caseTwo.timeline.find((entry) => entry.stage === "hearing").outcome, "held");
  assert.equal(caseTwo.documents.hearing.status, "matched");
  assert.equal(caseTwo.money.estimated_cost.status, "matched");
  assert.ok(caseTwo.place.address.startsWith("50 Water Street, Brooklyn, NY"));

  const caseThree = byId.get("20260010003");
  assert.equal(caseThree.stage, "board_decision");
  assert.equal(caseThree.timeline.find((entry) => entry.stage === "board_decision").official_action, "board_decision");
  assert.equal(caseThree.timeline.find((entry) => entry.stage === "board_decision").outcome, "approved with revised terms");
  assert.equal(caseThree.company.value, "Northside Housing Group");
  assert.equal(caseThree.documents.board_decision.status, "matched");
  assert.equal(caseThree.money.estimated_cost.status, "unknown");

  const caseFour = byId.get("20260010004");
  assert.equal(caseFour.join.matched, true);
  assert.equal(caseFour.place.status, "matched");
  assert.equal(caseFour.money.requested_benefit.status, "matched");
  assert.equal(caseFour.stage, "hearing");
  assert.equal(caseFour.company.status, "matched");
  assert.equal(caseFour.timeline.find((entry) => entry.stage === "application").status, "matched");
  assert.equal(caseFour.documents.application.status, "matched");
  assert.equal(caseFour.documents.hearing.status, "unknown", "missing hearing documents remain explicit unknown");

  const caseFive = byId.get("20260010005");
  assert.equal(caseFive.company.value, "Riverview Capital");
  assert.equal(caseFive.money.requested_benefit.status, "unknown", "missing amounts remain explicitly unknown");
  assert.equal(caseFive.money.estimated_cost.status, "unknown", "missing amounts remain explicitly unknown");
  assert.equal(caseFive.documents.application.status, "unknown", "missing docs remain explicitly unknown");
  assert.equal(caseFive.documents.board_decision.status, "unknown");
  assert.equal(caseFive.documents.closing.status, "unknown");
  assert.equal(caseFive.stage, "application");
  assert.equal(caseFive.timeline.find((entry) => entry.stage === "application").official_action, "application_review");
  assert.equal(caseFive.timeline.find((entry) => entry.stage === "application").outcome, "filed");
  assert.ok(caseFive.place.address);
});

test("lifecycle emits fixed stage order across all sourced rows", () => {
  for (const row of lifecycleRows) {
    assert.equal(row.timeline.length, STAGES.length);
    assert.deepEqual(row.timeline.map((entry) => entry.stage), STAGES);
  }
});
