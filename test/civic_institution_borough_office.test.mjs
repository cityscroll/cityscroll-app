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
import {
  BROOKLYN_CB15_BODY_ID,
  BROOKLYN_CB15_HOMEPAGE_URL,
  BROOKLYN_CB15_MINUTES_URL,
  BROOKLYN_OFFICE_AGENCY_REF,
  BROOKLYN_OFFICE_CANONICAL_ID,
  BROOKLYN_OFFICEHOLDER_ID,
  BROOKLYN_OFFICEHOLDER_NAME,
  OFFICE_PROCEEDING_JOIN_METHOD,
  SPECIMEN_BOROUGH_BOARD_NOTICE_ID,
  SPECIMEN_OFFICE_NOTICE_IDS,
  boroughOfficeRolesForBoard,
  boroughOfficeRolesForInstitution,
  invertCivicInstitutionRoleEdge,
  isGenericAppointedLabel,
  personLeaderKey,
  resolveBoroughOfficeRoles,
  verifyAppointmentAuthority,
  verifyOfficeMeetingJoin,
} from "../site/civic_institution_borough_office.mjs";
import { buildCommunityBoardConstellationView, renderCommunityBoardConstellationDocument } from "../site/community_board_constellation.mjs";
import { AGENCY_CONSTELLATION_CATEGORIES } from "../site/agency_constellation.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";
import { PERSON_LEADER_PRIMARY_KEY_PATTERN } from "../entity_resolution/leaders/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_borough_office/cases.json", import.meta.url), "utf8"),
);

function sources(overrides = {}) {
  return {
    publisherRow: FIXTURES.publisher,
    meetings: FIXTURES.meetings,
    appointmentRecords: [],
    generatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function profileHtml(officeSources) {
  const evidence = buildAgencyIdentityEvidence({
    identity: {
      canonical_id: BROOKLYN_OFFICE_CANONICAL_ID,
      canonical_name: FIXTURES.publisher.canonical_name,
    },
    publisherRow: FIXTURES.publisher,
    view: { path: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`, categories: [] },
    generatedAt: "2026-06-02T00:00:00.000Z",
    boroughOfficeSources: officeSources,
  });
  return {
    evidence,
    html: renderAgencyIdentitySection({
      path: `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
      display_name: FIXTURES.publisher.canonical_name,
      identity_evidence: evidence,
    }),
  };
}

test("registry registers officeholder and board-level appointment relations", () => {
  const registry = loadOntologyRegistry();
  const ids = new Map(registry.link_types.map((row) => [row.id, row]));
  assert.equal(ids.get("holds_office").from, "civic-institution");
  assert.equal(ids.get("holds_office").to, "person-leader");
  assert.equal(ids.get("holds_office").inverse, "officeholder_of");
  assert.equal(ids.get("appoints_members_of").to, "community-board");
  assert.equal(ids.get("appoints_members_of").inverse, "members_appointed_by");
  assert.match(ids.get("hosts_meeting").from, /civic-institution/);
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.holds_office.object_kind, "person-leader");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.appoints_members_of.object_kind, "community-board");
  assert.match(CIVIC_INSTITUTION_ROLE_RELATIONS.holds_office.negative_rule, /roster/);
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.hosts_meeting.from_kind, "committee");
  assert.ok(CIVIC_INSTITUTION_ROLE_RELATIONS.hosts_meeting.from_kinds.includes("civic-institution"));
});

test("exact Brooklyn office, Antonio Reynoso, and Borough Board notice traverse with receipts", () => {
  const resolved = resolveBoroughOfficeRoles(sources());
  const officeholder = resolved.accepted.find((edge) => edge.relation_id === "holds_office");
  const hosted = resolved.accepted.filter((edge) => edge.relation_id === "hosts_meeting");
  const boroughBoard = hosted.find((edge) => edge.request_id === SPECIMEN_BOROUGH_BOARD_NOTICE_ID);
  assert.equal(officeholder.status, "accepted");
  assert.equal(officeholder.schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(officeholder.from, `civic-institution:${BROOKLYN_OFFICE_CANONICAL_ID}`);
  assert.equal(officeholder.to, BROOKLYN_OFFICEHOLDER_ID);
  assert.equal(officeholder.to, FIXTURES.person_leader_id);
  assert.equal(officeholder.object_display_name, BROOKLYN_OFFICEHOLDER_NAME);
  assert.equal(officeholder.provenance.source_field, "head_name");
  assert.equal(officeholder.provenance.source_value, BROOKLYN_OFFICEHOLDER_NAME);
  assert.equal(officeholder.valid_from, null);
  assert.equal(officeholder.jurisdiction, "Brooklyn");
  assert.ok(officeholder.source_receipt || officeholder.provenance.source_receipt);
  assert.equal(hosted.length, 3);
  assert.deepEqual(hosted.map((edge) => edge.request_id).sort(), [...SPECIMEN_OFFICE_NOTICE_IDS].sort());
  assert.equal(boroughBoard.to, `meeting:city_record:${SPECIMEN_BOROUGH_BOARD_NOTICE_ID}`);
  assert.equal(boroughBoard.join_method, OFFICE_PROCEEDING_JOIN_METHOD);
  assert.match(boroughBoard.href, /meeting%3Acity_record%3A20260518003/);
  assert.equal(resolved.accepted.some((edge) => edge.relation_id === "appoints_members_of"), false);
  assert.equal(
    resolved.unresolved.some((edge) => edge.relation_id === "appoints_members_of" && edge.reason === "appointment_source_missing"),
    true,
  );
});

test("Brooklyn office Office roles rail links officeholder and Borough Board proceeding", () => {
  const { evidence, html } = profileHtml(sources());
  assert.equal(evidence.role_edges.some((edge) => edge.relation_id === "holds_office" && edge.to === BROOKLYN_OFFICEHOLDER_ID), true);
  assert.equal(evidence.role_edges.some((edge) => edge.request_id === SPECIMEN_BOROUGH_BOARD_NOTICE_ID), true);
  assert.match(html, /id="agency-institution-office-roles"/);
  assert.match(html, /data-office-rail="1"/);
  assert.match(html, /Antonio Reynoso/);
  assert.match(html, /data-role-relation="holds_office"/);
  assert.match(html, /data-role-relation="hosts_meeting"/);
  assert.match(html, /20260518003/);
  assert.match(html, /data-join-method="appointment_source_missing"/);
  assert.match(html, /No official appointment source names this board and scope yet/);
  assert.doesNotMatch(html, /parent-child/);
});

test("official appointment fixture mints board-level authority with reciprocal navigation", () => {
  const resolved = resolveBoroughOfficeRoles(sources({
    appointmentRecords: [FIXTURES.official_appointment],
  }));
  const authority = resolved.accepted.find((edge) => edge.relation_id === "appoints_members_of");
  assert.equal(authority.status, "accepted");
  assert.equal(authority.to, `community-board:${BROOKLYN_CB15_BODY_ID}`);
  assert.equal(authority.body_id, BROOKLYN_CB15_BODY_ID);
  assert.equal(authority.valid_from, "2024-04-01");
  assert.equal(authority.jurisdiction, "Brooklyn");
  assert.equal(authority.href, FIXTURES.board_path);
  const inverse = invertCivicInstitutionRoleEdge(authority);
  assert.equal(inverse.relation_id, "members_appointed_by");
  assert.equal(inverse.from, `community-board:${BROOKLYN_CB15_BODY_ID}`);
  assert.equal(inverse.to, `civic-institution:${BROOKLYN_OFFICE_CANONICAL_ID}`);
  const board = boroughOfficeRolesForBoard(BROOKLYN_CB15_BODY_ID, sources({
    appointmentRecords: [FIXTURES.official_appointment],
  }));
  assert.equal(board.accepted.some((edge) => edge.relation_id === "members_appointed_by"), true);
});

test("roster, geography, title, generic appointed wording, and wrong board never mint appointment", () => {
  assert.equal(isGenericAppointedLabel("appointed member"), true);
  assert.equal(isGenericAppointedLabel(FIXTURES.official_appointment.appointment_wording), false);
  assert.equal(verifyAppointmentAuthority(FIXTURES.negatives.roster_member).accepted, false);
  assert.equal(verifyAppointmentAuthority(FIXTURES.negatives.roster_member).reason, "roster_not_board_authority");
  assert.equal(verifyAppointmentAuthority(FIXTURES.negatives.geography_only).reason, "geography_not_appointment");
  assert.equal(verifyAppointmentAuthority(FIXTURES.negatives.title_only).reason, "title_only_not_appointment");
  assert.equal(verifyAppointmentAuthority(FIXTURES.negatives.generic_appointed).reason, "generic_appointed_label");
  assert.equal(verifyAppointmentAuthority(FIXTURES.negatives.wrong_board).reason, "wrong_board");
  const titleJoin = verifyOfficeMeetingJoin(FIXTURES.negatives.title_only_meeting, FIXTURES.publisher);
  assert.equal(titleJoin.accepted, false);
  assert.equal(titleJoin.reason, "title_only_not_join");
  const probed = resolveBoroughOfficeRoles({
    ...sources(),
    appointmentRecords: [
      FIXTURES.negatives.roster_member,
      FIXTURES.negatives.geography_only,
      FIXTURES.negatives.title_only,
      FIXTURES.negatives.generic_appointed,
      FIXTURES.negatives.wrong_board,
    ],
    includeNegativeProbes: true,
  });
  assert.equal(probed.accepted.some((edge) => edge.relation_id === "appoints_members_of"), false);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "roster_not_board_authority"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "geography_not_appointment"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "title_only_not_appointment"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "generic_appointed_label"), true);
  assert.equal(probed.unresolved.some((edge) => edge.reason === "wrong_board"), true);
  assert.equal(probed.accepted.every((edge) => edge.object_kind !== "community-board-person"), true);
});

test("CB-15 page shows appointment gap and source registry URLs without re-keying the board", () => {
  const view = buildCommunityBoardConstellationView(BROOKLYN_CB15_BODY_ID, {
    sourceRegistry: {
      sources: [{
        body_id: BROOKLYN_CB15_BODY_ID,
        body_type: "community_board",
        name: "Brooklyn Community Board 15",
        borough: "Brooklyn",
        district: 15,
        homepage_url: BROOKLYN_CB15_HOMEPAGE_URL,
        directory_url: "https://www.nyc.gov/site/communityboards/about/brooklyn-boards.page",
      }],
    },
    generated_at: "2026-08-13",
  });
  const html = renderCommunityBoardConstellationDocument(view);
  assert.equal(view.body_id, BROOKLYN_CB15_BODY_ID);
  assert.equal(view.path, FIXTURES.board_path);
  assert.equal(view.subject_ref, `community-board:${BROOKLYN_CB15_BODY_ID}`);
  assert.match(html, /id="community-board-appointment-authority"/);
  assert.match(html, /data-join-method="appointment_source_missing"/);
  assert.match(html, /No official appointment source names this board and scope yet/);
  assert.match(html, /\/agencies\/borough-president-brooklyn\//);
  assert.doesNotMatch(html, /agency:id:brooklyn-cb-15/);
  assert.doesNotMatch(html, /civic-institution:brooklyn-cb-15/);
  const registry = JSON.parse(readFileSync(join(ROOT, "site/data/non_council_outcome_sources/source_registry.json"), "utf8"));
  const board = registry.sources.find((row) => row.body_id === BROOKLYN_CB15_BODY_ID);
  assert.equal(board.homepage_url, BROOKLYN_CB15_HOMEPAGE_URL);
  assert.equal(board.source_roles.minutes.url, BROOKLYN_CB15_MINUTES_URL);
});

test("office routes, person-leader key, meeting notices, and board body_id stay on existing contracts", () => {
  const lookup = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
  const office = lookup.by_id[BROOKLYN_OFFICE_CANONICAL_ID];
  assert.equal(office.subject_ref, BROOKLYN_OFFICE_AGENCY_REF);
  assert.equal(office.path, `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`);
  assert.equal(office.categories.meetings.count, 3);
  assert.equal(AGENCY_CONSTELLATION_CATEGORIES.find((row) => row.id === "meetings").relation, "hosts_meeting");
  assert.equal(PERSON_LEADER_PRIMARY_KEY_PATTERN, "person-leader:{agency_id}:{person_id|name}");
  assert.equal(personLeaderKey(BROOKLYN_OFFICE_CANONICAL_ID, BROOKLYN_OFFICEHOLDER_NAME), FIXTURES.person_leader_id);
  const meetings = JSON.parse(readFileSync(join(ROOT, "site/data/meetings_domain_observations.json"), "utf8"));
  const list = Array.isArray(meetings.rows) ? meetings.rows : [];
  for (const id of SPECIMEN_OFFICE_NOTICE_IDS) {
    const row = list.find((item) => item.request_id === id);
    assert.ok(row, id);
    assert.equal(row.meeting_id, `meeting:city_record:${id}`);
    assert.equal(row.agency_name, "Borough President - Brooklyn");
  }
  const boards = JSON.parse(readFileSync(join(ROOT, "site/data/community_board_constellation_lookup.json"), "utf8"));
  assert.equal(boards.by_id[BROOKLYN_CB15_BODY_ID].body_id, BROOKLYN_CB15_BODY_ID);
  assert.equal(boards.by_id[BROOKLYN_CB15_BODY_ID].path, FIXTURES.board_path);
  const scoped = boroughOfficeRolesForInstitution("sanitation", sources());
  assert.equal(scoped.accepted.length, 0);
  const otherBoard = boroughOfficeRolesForBoard("brooklyn-cb-01", sources({
    appointmentRecords: [FIXTURES.official_appointment],
  }));
  assert.equal(otherBoard.accepted.length, 0);
});
