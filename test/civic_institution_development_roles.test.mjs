import assert from "node:assert/strict";
import test from "node:test";

import { loadOntologyRegistry } from "../ontology/index.mjs";
import {
  CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
  CIVIC_INSTITUTION_ROLE_RELATIONS,
} from "../ontology/civic_institution.mjs";
import { renderAgencyIdentitySection } from "../site/agency_identity_evidence.mjs";
import { landRecordApplicantHTML } from "../site/land_record_links.mjs";
import { renderProcurementInstitutionRoles } from "../site/procurement_document.mjs";
import { buildProjectConnectionEvidence } from "../site/project_connections.mjs";
import {
  BOROUGH_BOARD_NOTICE_ID,
  NYCEDC_CANONICAL_ID,
  NYCEDC_ZAP_APPLICANT_SPELLING,
  SBS_CANONICAL_ID,
  SBS_MASTER_EPIN,
  SBS_MASTER_PROCUREMENT_ID,
  SBS_MASTER_SOURCE_REF,
  WILLETS_POINT_PARCEL_BBL,
  WILLETS_POINT_PROJECT_ID,
  resolveNycEdcDevelopmentRoles,
} from "../site/civic_institution_development_roles.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";

const project = Object.freeze({
  project_id: WILLETS_POINT_PROJECT_ID,
  project_name: "Willets Point Phase II Mapping Actions",
  primary_applicant: NYCEDC_ZAP_APPLICANT_SPELLING,
  current_milestone_date: "2024-06-01",
});

const procurement = Object.freeze({
  procurement_id: SBS_MASTER_PROCUREMENT_ID,
  canonical_href: `/procurements/${encodeURIComponent(SBS_MASTER_PROCUREMENT_ID)}`,
  pin: SBS_MASTER_EPIN,
  agency_name: "Small Business Services",
  vendor_name: "New York City Economic Development Corporation",
  short_title: "FY26 NYCEDC Master Contract",
  source_observation_refs: [SBS_MASTER_SOURCE_REF],
});

const passportObservation = Object.freeze({
  source_observation_ref: SBS_MASTER_SOURCE_REF,
  source_system: "passport_public_contracts",
  ingested_at: "2026-08-18T04:05:51.552Z",
  snapshot: {
    epin: SBS_MASTER_EPIN,
    agency: "DEPARTMENT OF SMALL BUSINESS SERVICES",
    vendor: "NEW YORK CITY ECONOMIC DEVELOPMENT CORPORATION",
    title: "FY26 NYCEDC Master Contract",
  },
});

const boroughBoardMeeting = Object.freeze({
  request_id: BOROUGH_BOARD_NOTICE_ID,
  short_title: "BROOKLYN BOROUGH BOARD PUBLIC HEARING AND MEETING",
  event_date: "2026-06-02T18:00:00.000",
});

const sources = Object.freeze({
  project,
  procurement,
  procurementObservations: [passportObservation],
  boroughBoardMeeting,
  projectBbls: [WILLETS_POINT_PARCEL_BBL],
});

test("registry registers NYCEDC development role relations", () => {
  const registry = loadOntologyRegistry();
  const ids = new Map(registry.link_types.map((row) => [row.id, row]));
  assert.equal(ids.get("applicant_on").to, "project");
  assert.equal(ids.get("contractor_on").to, "procurement");
  assert.equal(ids.get("contracted_by").inverse, "contracts_with");
  assert.equal(ids.get("presents_transaction_at").grounding, "gap");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.applicant_on.legacy_relation_id, "applicant_agency");
});

test("exact ZAP and SBS party evidence mints reciprocal role edges", () => {
  const resolved = resolveNycEdcDevelopmentRoles(sources);
  const applicant = resolved.accepted.find((edge) => edge.relation_id === "applicant_on");
  const contractor = resolved.accepted.find((edge) => edge.relation_id === "contractor_on");
  const contracted = resolved.accepted.find((edge) => edge.relation_id === "contracted_by");
  assert.equal(applicant.status, "accepted");
  assert.equal(applicant.schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(applicant.from, `civic-institution:${NYCEDC_CANONICAL_ID}`);
  assert.equal(applicant.to, `project:${WILLETS_POINT_PROJECT_ID}`);
  assert.equal(applicant.href, `/browse/zoning/#land/${WILLETS_POINT_PROJECT_ID}`);
  assert.equal(applicant.inverse_href, `/agencies/${NYCEDC_CANONICAL_ID}/`);
  assert.equal(applicant.provenance.source_field, "primary_applicant");
  assert.equal(applicant.provenance.source_value, NYCEDC_ZAP_APPLICANT_SPELLING);
  assert.ok(applicant.provenance.source_receipt);
  assert.equal(contractor.to, SBS_MASTER_PROCUREMENT_ID);
  assert.equal(contractor.provenance.source_value, "NEW YORK CITY ECONOMIC DEVELOPMENT CORPORATION");
  assert.equal(contracted.from, `civic-institution:${SBS_CANONICAL_ID}`);
  assert.equal(contracted.to, `civic-institution:${NYCEDC_CANONICAL_ID}`);
  assert.equal(resolved.accepted.some((edge) => edge.relation_id === "presents_transaction_at"), false);
  assert.equal(
    resolved.unresolved.some((edge) => edge.reason === "borough_board_selection_passage_missing"),
    true,
  );
});

test("mentions, publisher notices, and missing party fields never mint inferred roles", () => {
  const nearby = resolveNycEdcDevelopmentRoles({
    project: {
      project_id: "2024Q0136",
      project_name: "Willets Point mention only",
      primary_applicant: "A Nearby Developer LLC",
    },
    procurement: {
      procurement_id: "procurement:contract:OTHER",
      pin: "80125S9999999",
      agency_name: "Small Business Services",
      vendor_name: "New York City Economic Development Corporation",
      source_observation_refs: ["city_record:20260803001"],
    },
    procurementObservations: [{
      source_observation_ref: "city_record:20260803001",
      source_system: "city_record",
      ingested_at: "2026-08-03",
      snapshot: {
        agency_name: "Economic Development Corporation",
        vendor_name: "Some Other Vendor",
      },
    }],
    boroughBoardMeeting,
  });
  assert.equal(nearby.accepted.length, 0);
  assert.equal(nearby.accepted.some((edge) => edge.relation_id === "contractor_on"), false);
  assert.doesNotMatch(JSON.stringify(nearby), /selected_developer/);
});

test("NYCEDC profile exposes separate project and procurement paths with inverse links", () => {
  const identity = {
    canonical_id: NYCEDC_CANONICAL_ID,
    canonical_name: "Economic Development Corporation",
  };
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: {
      canonical_name: identity.canonical_name,
      org_type: "Public Benefit or Development Organization",
      match_method: "normalized",
      variants: ["Economic Development Corporation"],
    },
    view: { path: `/agencies/${NYCEDC_CANONICAL_ID}/`, categories: [] },
    generatedAt: "2026-08-09T00:00:00Z",
    developmentRoleSources: sources,
  });
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "applicant_on"), true);
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "contractor_on"), true);
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "contracts_with"), true);
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "presents_transaction_at"), false);
  const html = renderAgencyIdentitySection({
    path: `/agencies/${NYCEDC_CANONICAL_ID}/`,
    display_name: identity.canonical_name,
    identity_evidence: evidence,
  });
  assert.match(html, /id="agency-institution-projects"/);
  assert.match(html, /id="agency-institution-procurement"/);
  assert.match(html, /href="\/browse\/zoning\/#land\/2024Q0135"/);
  assert.match(html, /href="\/parcels\/4018200001\//);
  assert.match(html, new RegExp(`/procurements/${encodeURIComponent(SBS_MASTER_PROCUREMENT_ID)}`));
  assert.match(html, /href="\/agencies\/small-business-services\//);
  assert.match(html, /id="agency-institution-proceedings"/);
  assert.match(html, /borough_board_selection_passage_missing/);
  assert.doesNotMatch(html, /data-role-relation="selected_developer"/);
});

test("land and procurement destinations keep source spellings and visible inverse links", () => {
  const applicantHtml = landRecordApplicantHTML(NYCEDC_ZAP_APPLICANT_SPELLING);
  assert.match(applicantHtml, /href="\/agencies\/economic-development-corporation\//);
  assert.match(applicantHtml, /EDC - Economic Development Corporation for NYC/);
  const connections = buildProjectConnectionEvidence({
    projectId: WILLETS_POINT_PROJECT_ID,
    projectRows: [project],
    bblRows: [{ project_id: WILLETS_POINT_PROJECT_ID, bbls: [WILLETS_POINT_PARCEL_BBL] }],
  });
  const applicant = connections.groups.find((group) => group.id === "applicant");
  assert.equal(applicant.items[0].ref, "agency:id:edc-economic-development-corporation-for-nyc");
  assert.equal(applicant.items[0].relation, null);
  assert.equal(applicant.items[1].relation, "has_applicant");
  assert.equal(applicant.items[1].href, `/agencies/${NYCEDC_CANONICAL_ID}/`);
  const parcels = connections.groups.find((group) => group.id === "parcels");
  assert.equal(parcels.items[0].ref, `bbl:${WILLETS_POINT_PARCEL_BBL}`);
  const procurementHtml = renderProcurementInstitutionRoles(procurement, [passportObservation]);
  assert.match(procurementHtml, /id="procurement-institution-roles"/);
  assert.match(procurementHtml, /href="\/agencies\/economic-development-corporation\//);
  assert.match(procurementHtml, /href="\/agencies\/small-business-services\//);
});
