import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  normalizeOfficeRecord,
} from "../site/committee_graph.mjs";
import {
  buildCommunityBoardGeography,
} from "../site/community_board_geography.mjs";
import {
  communityBoardCommitteeId,
  matchCommunityBoardCommittee,
} from "../site/community_board_committees.mjs";
import {
  buildCommunityBoardBylawGraph,
} from "../site/community_board_bylaws.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import {
  buildCommunityBoardInstitutionEdges,
  joinCommunityBoardSourceRecord,
  promoteCommunityBoardHostsMeetingEdge,
} from "../site/community_board_institution_edges.mjs";
import {
  COMMUNITY_BOARD_PROCEEDING_FORMS,
  projectCommunityBoardProceedingHost,
} from "../site/community_board_proceeding_hosts.mjs";
import {
  communityBoardPersonId,
  promoteCommunityBoardPersonRoleEdge,
} from "../site/community_board_relations.mjs";
import { meetingIdForSource, normalizeCommunityBoardMeeting } from "../site/meeting_object_contract.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";
import { renderPeopleOrganizationRow } from "../site/browse_concept_view.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url), "utf8"));
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"));

const people = { by_person_id: {
  "7801": { person_id: "7801", person_name: "Ada Lovelace" },
} };

const committeeRegistry = {
  committees: [{
    board_id: "manhattan-cb-06",
    committee_id: "transportation",
    publisher_name: "Transportation Committee",
    source_url: "https://cbsix.org/meetings-calendar/",
    observed_on: "2026-08-25",
  }],
};

const boardMeeting = {
  source_system: "community_board",
  publisher_identifier: "cb6-transport-2026-09-02",
  source_record_id: "cb6-transport-2026-09-02",
  board_id: "manhattan-cb-06",
  event_date: "2026-09-02",
  title: "Transportation Committee Meeting",
};

const boardRecord = {
  board_id: "manhattan-cb-06",
  body_id: "manhattan-cb-06",
  source_url: "https://cbsix.org/meetings-calendar/",
  source_record_id: "cb6-transport-2026-09-02",
  record_id: "cb6-transport-2026-09-02",
  date: "2026-09-02",
  publisher_identifier: "cb6-transport-2026-09-02",
  title: "Transportation Committee Meeting",
  committee: { name: "Transportation Committee" },
  observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
};

function acceptedCityRecordMeeting(title = "Public hearing on a neighborhood matter") {
  const meeting = {
    source_system: "city_record",
    request_id: "20260814001",
    publisher_identifier: "20260814001",
    meeting_id: "meeting:city_record:20260814001",
    body_id: "bronx-cb-01",
    event_date: "2026-08-12",
    title,
  };
  const record = {
    board_id: "bronx-cb-01",
    body_id: "bronx-cb-01",
    source_url: "https://board.example/calendar",
    source_record_id: "event-2026-08-12-1",
    record_id: "event-2026-08-12-1",
    record_kind: "event",
    date: "2026-08-12",
    publisher_identifier: "20260814001",
    title,
    observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
  };
  const join = joinCommunityBoardSourceRecord(meeting, record);
  return { meeting, record, join, edge: promoteCommunityBoardHostsMeetingEdge({ meeting, source_record: record, join }) };
}

function communityBoardPlaces() {
  return {
    nodes: [{
      id: "community-board:manhattan-cb-06",
      type: "community-board",
      name: "Manhattan Community Board 6",
      properties: { body_id: "manhattan-cb-06", borough: "Manhattan", district: 6 },
    }],
    public_edges: [],
  };
}

function validPersonObservation(overrides = {}) {
  return {
    board_id: "manhattan-cb-06",
    publisher_person_id: "7801",
    person_name: "Ada Lovelace",
    relation: "member_of",
    role: "appointed_member",
    relation_date: "2026-08-25",
    source_document: {
      publisher_document_id: "cb6-roster-2026-08-25",
      document_url: "https://cbsix.org/about-us/board-members-and-staff/",
      date: "2026-08-25",
      observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
    },
    ...overrides,
  };
}

function assertInspectableProvenance(edge) {
  assert.ok(edge?.provenance && typeof edge.provenance === "object", `missing provenance: ${JSON.stringify(edge)}`);
  assert.ok(edge.provenance.source_url, `missing provenance source URL: ${JSON.stringify(edge)}`);
  assert.ok(
    edge.provenance.observed_at || edge.provenance.observed_on || edge.provenance.observed_receipt?.observed_at,
    `missing provenance observation time: ${JSON.stringify(edge)}`,
  );
}

test("gate 01: Legistar committee identities remain keyed by BodyId", () => {
  const first = normalizeOfficeRecord({
    OfficeRecordPersonId: 7801,
    OfficeRecordBodyId: 5261,
    OfficeRecordBodyName: "Committee on Housing",
  });
  const renamed = normalizeOfficeRecord({
    OfficeRecordPersonId: 7801,
    OfficeRecordBodyId: 5261,
    OfficeRecordBodyName: "Housing Committee",
  });
  assert.equal(first.committee_id, "committee:5261");
  assert.equal(renamed.committee_id, first.committee_id);
});

test("gate 02: Council official identities remain keyed by PersonId", () => {
  const first = normalizeOfficeRecord({ OfficeRecordPersonId: 7801, OfficeRecordBodyId: 5261, OfficeRecordBodyName: "Committee on Housing" });
  const renamed = normalizeOfficeRecord({ OfficeRecordPersonId: 7801, OfficeRecordBodyId: 5262, OfficeRecordBodyName: "Committee on Land Use" });
  assert.equal(first.official_id, "official:7801");
  assert.equal(renamed.official_id, first.official_id);
});

test("gate 03: Community Board meeting identities remain source-qualified", () => {
  const first = normalizeCommunityBoardMeeting({ ...boardMeeting, title: "Transportation Committee Meeting" });
  const renamed = normalizeCommunityBoardMeeting({ ...boardMeeting, title: "Transportation and Environment" });
  assert.equal(meetingIdForSource("community_board", "cb6-transport-2026-09-02"), "meeting:community_board:cb6-transport-2026-09-02");
  assert.equal(renamed.meeting_id, first.meeting_id);
  assert.notEqual(first.meeting_id, "community-board-committee:manhattan-cb-06:transportation");
});

test("gate 04: Community District and Council District membership stays many-to-many", () => {
  const geography = buildCommunityBoardGeography({ sourceRegistry, boundaries, observedAt: "2026-08-12T00:00:00.000Z" });
  const intersections = geography.public_edges.filter((edge) => edge.type === "intersects");
  const councilIdsByCommunityDistrict = new Map();
  for (const edge of intersections) {
    const list = councilIdsByCommunityDistrict.get(edge.from) || new Set();
    list.add(edge.to);
    councilIdsByCommunityDistrict.set(edge.from, list);
  }
  assert.ok(intersections.length > 59, "the overlay must retain multiple Council districts per Community District");
  assert.ok([...councilIdsByCommunityDistrict.values()].some((ids) => ids.size > 1));
  assert.ok(intersections.every((edge) => edge.from.startsWith("community-district:") && edge.to.startsWith("council-district:")));
});

test("gate 05: display-name equality never creates a cross-source person identity", () => {
  const nameOnly = promoteCommunityBoardPersonRoleEdge(validPersonObservation({ publisher_person_id: "Ada Lovelace" }));
  assert.equal(nameOnly.promoted, false);
  assert.equal(nameOnly.status, "unknown");
  assert.equal(communityBoardPersonId("manhattan-cb-06", "7801"), "community-board-person:manhattan-cb-06:7801");
  assert.notEqual(communityBoardPersonId("manhattan-cb-06", "7801"), "official:7801");
});

test("gate 06: same-named committees remain distinct across boards", () => {
  const registry = { committees: [
    { ...committeeRegistry.committees[0] },
    { ...committeeRegistry.committees[0], board_id: "brooklyn-cb-01", source_url: "https://cb1.example/committees/" },
  ] };
  const manhattan = matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", committee: { name: "Transportation Committee" } }, registry);
  const brooklyn = matchCommunityBoardCommittee({ board_id: "brooklyn-cb-01", committee: { name: "Transportation Committee" } }, registry);
  assert.equal(manhattan.id, "community-board-committee:manhattan-cb-06:transportation");
  assert.equal(brooklyn.id, "community-board-committee:brooklyn-cb-01:transportation");
  assert.notEqual(manhattan.id, brooklyn.id);
  assert.equal(communityBoardCommitteeId("manhattan-cb-06", "transportation"), manhattan.id);
});

test("gate 07: every materialized Community Board edge carries inspectable provenance", () => {
  const institutionEdges = buildCommunityBoardInstitutionEdges([{ meeting: boardMeeting, source_record: boardRecord }], { committeeRegistry });
  const personEdge = promoteCommunityBoardPersonRoleEdge(validPersonObservation());
  const bylawEdge = buildCommunityBoardBylawGraph({ versions: [{
    id: "bylaw-version:manhattan-cb-06:2026",
    board_id: "manhattan-cb-06",
    source_url: "https://cbsix.org/bylaws/2026.pdf",
    publisher: "Manhattan Community Board 6",
    publisher_document_id: "cb6-bylaws-2026",
    observed_on: "2026-08-25",
    receipt: { status: "ok", source_url: "https://cbsix.org/bylaws/2026.pdf", observed_at: "2026-08-25T12:00:00Z" },
    rules: [],
  }] }).edges[0];
  assert.equal(institutionEdges.length, 2);
  for (const edge of [...institutionEdges, personEdge, bylawEdge]) assertInspectableProvenance(edge);
});

test("gate 08: failed evidence remains unknown rather than becoming certainty", () => {
  const { meeting, record } = acceptedCityRecordMeeting();
  const missingIdentifier = { ...record, publisher_identifier: null };
  const join = joinCommunityBoardSourceRecord(meeting, missingIdentifier);
  const edge = promoteCommunityBoardHostsMeetingEdge({ meeting, source_record: missingIdentifier, join });
  const host = projectCommunityBoardProceedingHost(edge, { meeting_family: "meeting" });
  assert.equal(join.status, "unknown");
  assert.equal(edge.status, "held");
  assert.equal(edge.href, null);
  assert.equal(host.status, "unknown");
});

test("gate 09: an accepted meeting source record renders once through its semantic object", () => {
  const accepted = acceptedCityRecordMeeting("Transportation Committee Meeting");
  const view = buildCommunityBoardConstellationView("bronx-cb-01", {
    sourceRegistry: { sources: [{ body_id: "bronx-cb-01", body_type: "community_board", name: "Bronx Community Board 1", borough: "Bronx" }] },
    geography: { nodes: [], public_edges: [] },
    sourceInventory: { boards: [] },
    scorecard: { rows: [] },
    sourceRecords: [accepted.record],
    institutionEdges: { "bronx-cb-01": [accepted.edge] },
  });
  const visible = renderCommunityBoardConstellationDocument(view)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  assert.equal(view.source_records.length, 0);
  assert.equal((visible.match(/Transportation Committee Meeting/g) || []).length, 1);
});

test("gate 10: Full Board is hosted by the board, never a synthetic committee", () => {
  const accepted = acceptedCityRecordMeeting("Full Board Meeting");
  const edges = buildCommunityBoardInstitutionEdges([{ meeting: accepted.meeting, source_record: accepted.record }], { committeeRegistry: { committees: [] } });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, "community-board:bronx-cb-01");
  assert.doesNotMatch(edges[0].from, /community-board-committee:/);
});

test("gate 11: hearing form and convening body remain orthogonal", () => {
  const host = projectCommunityBoardProceedingHost({
    relation: "hosts_meeting",
    status: "promoted",
    promoted: true,
    from: "community-board-committee:manhattan-cb-06:transportation",
    to: "meeting:community_board:hearing-1",
    committee_name: "Transportation Committee",
    parent_board_ref: "community-board:manhattan-cb-06",
    provenance: { source_url: "https://cbsix.org/meetings-calendar/", observed_at: "2026-08-25T12:00:00Z" },
  }, { meeting_family: "public_hearing" });
  assert.equal(host.host_kind, "community-board-committee");
  assert.equal(host.proceeding_form, "public_hearing");
  assert.ok(!COMMUNITY_BOARD_PROCEEDING_FORMS.includes("committee_meeting"));
});

test("gate 12: Community Board people stay outside Council person routes and UI", () => {
  const model = buildPeopleOrganizationsReadModel({
    places: communityBoardPlaces(),
    people,
    communityBoardPeople: { boards: { "manhattan-cb-06": { relationships: [validPersonObservation()] } } },
  });
  const boardPerson = model.rows.find((row) => row.kind === "community-board-person");
  assert.ok(boardPerson);
  assert.equal(boardPerson.id, "community-board-person:manhattan-cb-06:7801");
  assert.equal(boardPerson.href, null);
  const html = renderPeopleOrganizationRow(boardPerson);
  assert.doesNotMatch(html, /href="\/officials\//);
  assert.doesNotMatch(html, /votes|finance|lobbying|City Council committee/i);
});
