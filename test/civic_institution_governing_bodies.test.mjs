import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadOntologyRegistry } from "../ontology/index.mjs";
import {
  CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
  CIVIC_INSTITUTION_ROLE_RELATIONS,
} from "../ontology/civic_institution.mjs";
import { renderAgencyIdentitySection } from "../site/agency_identity_evidence.mjs";
import { AGENCY_CONSTELLATION_CATEGORIES } from "../site/agency_constellation.mjs";
import {
  BERS_BOARD_ID,
  BERS_CROSSWALK_ID,
  BERS_EXECUTIVE_ID,
  BERS_ROUTE_ID,
  BERS_TARGET_MEETING_DATE,
  GOVERNING_MEETING_JOIN_METHOD,
  NYCHA_AUDIT_FINANCE_ID,
  NYCHA_AUDIT_FINANCE_REF,
  NYCHA_AUDIT_MEETING_ID,
  NYCHA_AUDIT_MEETING_REF,
  NYCHA_BOARD_ID,
  NYCHA_BOARD_MEETING_ID,
  NYCHA_BOARD_MEETING_REF,
  NYCHA_BOARD_REF,
  NYCHA_CANONICAL_ID,
  governingBodiesForInstitution,
  invertCivicInstitutionRoleEdge,
  isGenericBoardTitle,
  isOtiBucketSimilarity,
  resolveGoverningBodyRoles,
  verifyGoverningMeetingJoin,
} from "../site/civic_institution_governing_bodies.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";
import proceedings from "../site/data/governing_body_proceedings.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_governing_bodies/cases.json", import.meta.url), "utf8"),
);

function nychaSources(overrides = {}) {
  return {
    proceedings,
    publisherRow: FIXTURES.nycha_publisher,
    publisherById: {
      [NYCHA_CANONICAL_ID]: FIXTURES.nycha_publisher,
      [BERS_CROSSWALK_ID]: FIXTURES.bers_publisher,
    },
    generatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function nychaHtml() {
  const evidence = buildAgencyIdentityEvidence({
    identity: {
      canonical_id: NYCHA_CANONICAL_ID,
      canonical_name: "New York City Housing Authority",
    },
    publisherRow: FIXTURES.nycha_publisher,
    view: { path: "/agencies/housing-authority/", categories: [] },
    generatedAt: "2026-08-31T00:00:00.000Z",
    governingBodySources: nychaSources(),
  });
  return {
    evidence,
    html: renderAgencyIdentitySection({
      path: "/agencies/housing-authority/",
      display_name: "New York City Housing Authority",
      identity_evidence: evidence,
    }),
  };
}

function bersRouteHtml() {
  const evidence = buildAgencyIdentityEvidence({
    identity: {
      canonical_id: BERS_ROUTE_ID,
      canonical_name: "Employees' Retirement System",
    },
    publisherRow: null,
    view: { path: "/agencies/employees-retirement-system/", categories: [] },
    generatedAt: "2026-08-31T00:00:00.000Z",
    governingBodySources: nychaSources({ publisherRow: null }),
  });
  return {
    evidence,
    html: renderAgencyIdentitySection({
      path: "/agencies/employees-retirement-system/",
      display_name: "Employees' Retirement System",
      identity_evidence: evidence,
    }),
  };
}

test("registry registers governing-body relations with exact parent and board endpoints", () => {
  const registry = loadOntologyRegistry();
  const ids = new Map(registry.link_types.map((row) => [row.id, row]));
  assert.match(ids.get("governed_by").from, /civic-institution/);
  assert.match(ids.get("governed_by").to, /board/);
  assert.match(ids.get("has_committee").from, /board/);
  assert.match(ids.get("hosts_meeting").from, /board/);
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.governed_by.object_kind, "board");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.governed_by.inverse, "governing_body_of");
  assert.ok(CIVIC_INSTITUTION_ROLE_RELATIONS.has_committee.from_kinds.includes("board"));
  assert.ok(CIVIC_INSTITUTION_ROLE_RELATIONS.hosts_meeting.from_kinds.includes("board"));
  assert.match(CIVIC_INSTITUTION_ROLE_RELATIONS.governed_by.negative_rule, /calendar target/);
});

test("NYCHA Board, Audit and Finance Committee, and retained meetings traverse with receipts", () => {
  const resolved = resolveGoverningBodyRoles(nychaSources());
  const governed = resolved.accepted.find((edge) => edge.relation_id === "governed_by");
  const committee = resolved.accepted.find((edge) => edge.relation_id === "has_committee");
  const boardMeeting = resolved.accepted.find((edge) => edge.to === NYCHA_BOARD_MEETING_REF);
  const auditMeeting = resolved.accepted.find((edge) => edge.to === NYCHA_AUDIT_MEETING_REF);
  assert.equal(governed.status, "accepted");
  assert.equal(governed.schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(governed.from, `civic-institution:${NYCHA_CANONICAL_ID}`);
  assert.equal(governed.to, NYCHA_BOARD_REF);
  assert.equal(governed.href, "/agencies/housing-authority/#governance-nycha-board");
  assert.equal(governed.parent_institution_id, NYCHA_CANONICAL_ID);
  assert.ok(governed.provenance.source_url.includes("nycha/about/board-meetings"));
  assert.equal(committee.from, NYCHA_BOARD_REF);
  assert.equal(committee.to, NYCHA_AUDIT_FINANCE_REF);
  assert.equal(committee.href, "/agencies/housing-authority/#governance-nycha-audit-finance");
  assert.equal(boardMeeting.from, NYCHA_BOARD_REF);
  assert.equal(boardMeeting.request_id, NYCHA_BOARD_MEETING_ID);
  assert.equal(boardMeeting.join_method, GOVERNING_MEETING_JOIN_METHOD);
  assert.equal(boardMeeting.href, `/notices/${NYCHA_BOARD_MEETING_ID}`);
  assert.equal(auditMeeting.from, NYCHA_AUDIT_FINANCE_REF);
  assert.equal(auditMeeting.request_id, NYCHA_AUDIT_MEETING_ID);
  assert.equal(auditMeeting.href, `/notices/${NYCHA_AUDIT_MEETING_ID}`);
  const inverse = invertCivicInstitutionRoleEdge(governed);
  assert.equal(inverse.relation_id, "governing_body_of");
  assert.equal(inverse.from, NYCHA_BOARD_REF);
  assert.equal(inverse.to, `civic-institution:${NYCHA_CANONICAL_ID}`);
  assert.equal(resolved.accepted.some((edge) => edge.parent_institution_id === BERS_CROSSWALK_ID), false);
});

test("NYCHA Governance panel links Board, Audit and Finance Committee, and the exact notice", () => {
  const { evidence, html } = nychaHtml();
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "governed_by" && edge.to === NYCHA_BOARD_REF), true);
  assert.equal(evidence.role_edges.some((edge) => edge.to === NYCHA_AUDIT_MEETING_REF), true);
  assert.match(html, /id="agency-institution-governance"/);
  assert.match(html, /data-governance-rail="1"/);
  assert.match(html, /id="governance-nycha-board"/);
  assert.match(html, /id="governance-nycha-audit-finance"/);
  assert.match(html, /href="\/agencies\/housing-authority\/#governance-nycha-board"/);
  assert.match(html, /href="\/agencies\/housing-authority\/#governance-nycha-audit-finance"/);
  assert.match(html, /href="\/notices\/20260625034"/);
  assert.match(html, /data-role-relation="governed_by"/);
  assert.match(html, /data-role-relation="has_committee"/);
  assert.match(html, /data-role-relation="hosts_meeting"/);
  assert.doesNotMatch(html, /employees-retirement-system/);
  assert.doesNotMatch(html, /board-of-education-retirement-system/);
});

test("official BERS fixture traverses its own board and committee without using NYCHA records", () => {
  const resolved = resolveGoverningBodyRoles({
    proceedings: FIXTURES.official_bers_complete,
    publisherRow: FIXTURES.bers_publisher,
    publisherById: { [BERS_CROSSWALK_ID]: FIXTURES.bers_publisher },
  });
  const governed = resolved.accepted.find((edge) => edge.relation_id === "governed_by");
  const committee = resolved.accepted.find((edge) => edge.relation_id === "has_committee");
  const hosted = resolved.accepted.find((edge) => edge.relation_id === "hosts_meeting");
  assert.equal(governed.from, `civic-institution:${BERS_CROSSWALK_ID}`);
  assert.equal(governed.to, `board:${BERS_BOARD_ID}`);
  assert.equal(committee.from, `board:${BERS_BOARD_ID}`);
  assert.equal(committee.to, `committee:${BERS_EXECUTIVE_ID}`);
  assert.equal(hosted.request_id, FIXTURES.bers_fixture_meeting);
  assert.equal(hosted.parent_institution_id, BERS_CROSSWALK_ID);
  assert.equal(resolved.accepted.some((edge) => edge.parent_institution_id === NYCHA_CANONICAL_ID), false);
  assert.equal(resolved.accepted.some((edge) => edge.request_id === NYCHA_AUDIT_MEETING_ID), false);
});

test("BERS production state stays unresolved without a retained meeting or verified parent identity", () => {
  const { evidence, html } = bersRouteHtml();
  const scoped = governingBodiesForInstitution(BERS_ROUTE_ID, nychaSources({ publisherRow: null }));
  assert.equal(scoped.accepted.length, 0);
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "governed_by"), false);
  assert.equal(scoped.identity_states.some((row) => row.reason === "route_crosswalk_mismatch"), true);
  assert.equal(scoped.gaps.some((row) => row.target === BERS_TARGET_MEETING_DATE && row.reason === "no_retained_source_record"), true);
  assert.match(html, /data-identity-reconciliation="route_crosswalk_mismatch"/);
  assert.match(html, /data-crosswalk-key="board-of-education-retirement-system"/);
  assert.match(html, /data-governance-gap="no_retained_source_record"/);
  assert.match(html, /data-target-date="2026-07-15"/);
  assert.match(html, /data-role-relation="governed_by"/);
  assert.match(html, /data-role-status="unresolved"/);
  assert.match(html, /data-role-linking="0"/);
  assert.doesNotMatch(html, /href="\/notices\/20260625034"/);
  assert.doesNotMatch(html, /declared complete/i);
});

test("generic titles, similar committees, OTI buckets, vendor rows, and calendar targets never mint edges", () => {
  assert.equal(isGenericBoardTitle("Board Meeting"), true);
  assert.equal(isGenericBoardTitle("NYCHA Board"), false);
  assert.equal(isOtiBucketSimilarity("Pension Fund", "Pension Fund"), true);
  assert.equal(isOtiBucketSimilarity("Pension Fund", "Mayoral Agency"), false);
  const titleJoin = verifyGoverningMeetingJoin({
    title: FIXTURES.negatives.generic_board_title,
    join_method: "title_match",
    request_id: NYCHA_BOARD_MEETING_ID,
    meeting_id: NYCHA_BOARD_MEETING_REF,
  }, { body_id: NYCHA_BOARD_ID, parent_institution_id: NYCHA_CANONICAL_ID }, FIXTURES.nycha_publisher);
  assert.equal(titleJoin.accepted, false);
  const calendar = verifyGoverningMeetingJoin({
    join_method: "calendar_target",
    basis: "calendar_target",
    event_date: FIXTURES.negatives.calendar_target,
    body_id: BERS_EXECUTIVE_ID,
    parent_institution_id: BERS_CROSSWALK_ID,
  }, { body_id: BERS_EXECUTIVE_ID, parent_institution_id: BERS_CROSSWALK_ID }, FIXTURES.bers_publisher);
  assert.equal(calendar.reason, "calendar_target_not_join");
  const cross = verifyGoverningMeetingJoin({
    body_id: BERS_EXECUTIVE_ID,
    parent_institution_id: BERS_CROSSWALK_ID,
    request_id: NYCHA_AUDIT_MEETING_ID,
    meeting_id: NYCHA_AUDIT_MEETING_REF,
    agency_name: "Housing Authority",
    join_method: GOVERNING_MEETING_JOIN_METHOD,
  }, { body_id: BERS_EXECUTIVE_ID, parent_institution_id: BERS_CROSSWALK_ID }, FIXTURES.bers_publisher);
  assert.equal(cross.accepted, false);
  const probed = resolveGoverningBodyRoles({
    ...nychaSources(),
    includeNegativeProbes: true,
  });
  assert.equal(probed.unresolved.some((edge) => edge.reason === "generic_board_title" || edge.reason === "name_only_endpoint"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "similar_committee_name"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "oti_bucket_not_join"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "calendar_target_not_join"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "record_category_not_governing_edge"), true);
  assert.equal(probed.accepted.every((edge) => edge.parent_institution_id !== BERS_CROSSWALK_ID), true);
  assert.equal(probed.accepted.some((edge) => edge.from === `civic-institution:${BERS_ROUTE_ID}`), false);
});

test("NYCHA meeting claim ids, BERS vendor and staffing rows, routes, and category states stay on existing contracts", () => {
  const lookup = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
  const nycha = lookup.by_id[NYCHA_CANONICAL_ID];
  const bersRoute = lookup.by_id[BERS_ROUTE_ID];
  assert.equal(nycha.subject_ref, "agency:id:housing-authority");
  assert.equal(nycha.path, "/agencies/housing-authority/");
  assert.equal(bersRoute.subject_ref, "agency:id:employees-retirement-system");
  assert.equal(bersRoute.path, "/agencies/employees-retirement-system/");
  assert.equal(AGENCY_CONSTELLATION_CATEGORIES.length, 6);
  assert.deepEqual(AGENCY_CONSTELLATION_CATEGORIES.map((row) => row.id), [
    "contracts",
    "vendors",
    "meetings",
    "rules",
    "obligations",
    "staffing",
  ]);
  assert.equal(nycha.categories.meetings.count, 3);
  assert.equal(nycha.categories.meetings.status, "matched");
  assert.equal(bersRoute.categories.vendors.status, "matched");
  assert.equal(bersRoute.categories.staffing.status, "matched");
  assert.equal(bersRoute.categories.meetings.status, "empty");
  const nychaRel = JSON.parse(readFileSync(join(ROOT, "site/agencies/housing-authority/relationships-data.json"), "utf8"));
  const meetingItems = nychaRel.view.categories.find((row) => row.id === "meetings").items;
  assert.equal(meetingItems.some((item) => String(item.href || "").includes(NYCHA_BOARD_MEETING_ID)), true);
  assert.equal(meetingItems.some((item) => String(item.href || "").includes(NYCHA_AUDIT_MEETING_ID)), true);
  const bersRel = JSON.parse(readFileSync(join(ROOT, "site/agencies/employees-retirement-system/relationships-data.json"), "utf8"));
  const vendorItems = bersRel.view.categories.find((row) => row.id === "vendors").items;
  const staffingItems = bersRel.view.categories.find((row) => row.id === "staffing").items;
  assert.equal(vendorItems.length, 8);
  assert.equal(staffingItems.length, 6);
  const crosswalk = JSON.parse(readFileSync(join(ROOT, "worker/src/data/agency_crosswalk.json"), "utf8"));
  assert.equal(crosswalk.entries[BERS_CROSSWALK_ID].acronym, "BERS");
  assert.equal(crosswalk.entries[BERS_ROUTE_ID], undefined);
  const identityReport = JSON.parse(readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"));
  assert.ok(identityReport.aliases.some((row) => row.canonical_id === BERS_ROUTE_ID));
  const scoped = governingBodiesForInstitution("sanitation", nychaSources());
  assert.equal(scoped.accepted.length, 0);
  const nychaOnly = governingBodiesForInstitution(NYCHA_CANONICAL_ID, nychaSources());
  assert.equal(nychaOnly.accepted.every((edge) => edge.parent_institution_id === NYCHA_CANONICAL_ID), true);
});
