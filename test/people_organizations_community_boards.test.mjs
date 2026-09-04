import assert from "node:assert/strict";
import test from "node:test";

import { renderPeopleOrganizationRow } from "../site/browse_concept_view.mjs";
import { PEOPLE_ORGANIZATIONS_BROWSE_CONFIG, filterConfiguredBrowseRows } from "../site/browse_list_contract.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";

const places = {
  nodes: [
    { id: "community-board:manhattan-cb-06", type: "community-board", name: "Manhattan Community Board 6", properties: { body_id: "manhattan-cb-06", borough: "Manhattan", district: 6 } },
    { id: "community-board:brooklyn-cb-01", type: "community-board", name: "Brooklyn Community Board 1", properties: { body_id: "brooklyn-cb-01", borough: "Brooklyn", district: 1 } },
  ],
  public_edges: [],
};

const sourceDocument = {
  publisher_document_id: "cb6-roster-2026-08-25",
  document_url: "https://cbsix.org/about-us/board-members-and-staff/",
  date: "2026-08-25",
  observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
};

const boardPeople = {
  boards: {
    "manhattan-cb-06": { relationships: [{
      board_id: "manhattan-cb-06",
      publisher_person_id: "7801",
      person_name: "Ada Lovelace",
      relation: "member_of",
      role: "appointed_member",
      relation_date: "2026-08-25",
      source_document: sourceDocument,
    }] },
    "brooklyn-cb-01": { relationships: [{
      board_id: "brooklyn-cb-01",
      publisher_person_id: "7801",
      person_name: "Ada Lovelace",
      relation: "staffed_by",
      role: "district_manager",
      relation_date: "2026-08-25",
      source_document: { ...sourceDocument, publisher_document_id: "cb1-roster-2026-08-25", document_url: "https://cb1.example/staff/" },
    }] },
  },
};

const committees = { committees: [
  { board_id: "manhattan-cb-06", committee_id: "transportation", publisher_name: "Transportation Committee", source_url: "https://cbsix.org/meetings-calendar/", observed_on: "2026-08-25" },
  { board_id: "brooklyn-cb-01", committee_id: "transportation", publisher_name: "Transportation Committee", source_url: "https://cb1.example/committees/", observed_on: "2026-08-25" },
] };

test("Community Board rows lead the People + organizations model and name their institution", () => {
  const model = buildPeopleOrganizationsReadModel({ places, communityBoardPeople: boardPeople, communityBoardCommittees: committees });
  assert.deepEqual(model.rows.map((row) => row.kind), [
    "community-board", "community-board", "community-board-person", "community-board-person",
    "community-board-committee", "community-board-committee",
  ]);
  assert.ok(model.rows.slice(0, 6).every((row) => row.institution === "community-board"));
  assert.equal(model.rows.find((row) => row.kind === "community-board-person").institution_context, "Appointed local advisory body");
});

test("Community Board people and committees retain board-local identities and scoped filters", () => {
  const model = buildPeopleOrganizationsReadModel({ places, communityBoardPeople: boardPeople, communityBoardCommittees: committees });
  const people = model.rows.filter((row) => row.kind === "community-board-person");
  const boardCommittees = model.rows.filter((row) => row.kind === "community-board-committee");
  assert.notEqual(people[0].id, people[1].id);
  assert.notEqual(boardCommittees[0].id, boardCommittees[1].id);
  assert.deepEqual(
    filterConfiguredBrowseRows(model.rows, new URLSearchParams("institution=community-board&type=community-board-person"))
      .map((row) => row.id),
    people.map((row) => row.id),
  );
  assert.equal(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetValues.includes("community-board-person"), true);
  assert.equal(PEOPLE_ORGANIZATIONS_BROWSE_CONFIG.facetValues.includes("community-board-committee"), true);
});

test("People rows carry additive generic person projections and verified constellation edges", () => {
  const model = buildPeopleOrganizationsReadModel({ places, communityBoardPeople: boardPeople, communityBoardCommittees: committees });
  const people = model.rows.filter((row) => row.kind === "community-board-person");
  const manhattan = people.find((row) => row.id === "community-board-person:manhattan-cb-06:7801");
  const brooklyn = people.find((row) => row.id === "community-board-person:brooklyn-cb-01:7801");
  assert.equal(manhattan.person_ref, "person:community-board:manhattan-cb-06:7801");
  assert.equal(manhattan.person_projection.source_alias.identity, manhattan.id);
  assert.equal(manhattan.person_constellation.kind, "person-constellation");
  assert.equal(manhattan.person_constellation.local_constellation.kind, "person");
  assert.equal(manhattan.person_constellation.local_constellation.nodes.find((node) => node.edge_type === "member_of")?.href, "/community-boards/manhattan-cb-06/");
  assert.equal(brooklyn.person_ref, "person:community-board:brooklyn-cb-01:7801");
  assert.notEqual(manhattan.person_ref, brooklyn.person_ref);
});

test("Council rows retain the official route while surfacing an additive generic identity", () => {
  const model = buildPeopleOrganizationsReadModel({
    people: {
      retrieved_at: "2026-08-25T12:00:00Z",
      by_person_id: { "7801": { person_id: "7801", person_name: "Ada Lovelace", terms: [] } },
    },
  });
  const official = model.rows.find((row) => row.kind === "official");
  assert.equal(official.id, "official:7801");
  assert.equal(official.href, "/officials/7801/");
  assert.equal(official.person_ref, "person:legistar:7801");
  assert.equal(official.person_projection.source_alias.identity, "official:7801");
  assert.equal(official.person_constellation.local_constellation.nodes.find((node) => node.edge_type === "source_identity")?.href, "/officials/7801/");
});

test("Community Board cards link to the board institution without Council person UI", () => {
  const model = buildPeopleOrganizationsReadModel({ places, communityBoardPeople: boardPeople, communityBoardCommittees: committees });
  for (const row of model.rows.filter((candidate) => candidate.kind.startsWith("community-board-"))) {
    const html = renderPeopleOrganizationRow(row);
    assert.doesNotMatch(html, /href="\/officials\//);
    assert.doesNotMatch(html, /href="\/committees\//);
    if (row.kind !== "community-board-person") assert.match(html, /community-boards\//);
  }
  const staff = model.rows.find((row) => row.role_family === "staff");
  assert.equal(staff.detail, "District Manager");
  assert.doesNotMatch(renderPeopleOrganizationRow(staff), /member|votes|finance|lobbying/i);
});
