import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildBrowseConceptLanding,
  renderBrowseConceptLanding,
  renderPeopleOrganizationRow,
} from "../site/browse_concept_view.mjs";
import { buildBrowseConceptDocument } from "../site/primary_document_view.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";

const shell = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

const geography = {
  nodes: [{
    id: "community-board:bronx-cb-01",
    type: "community-board",
    name: "Bronx Community Board 1",
    properties: {
      body_id: "bronx-cb-01",
      borough: "Bronx",
      district: 1,
      identity: {
        projections: {
          organization: {
            relation_families: [
              { type: "has_member", label: "Members", state: "unknown" },
              { type: "member_of", label: "Board roles", state: "unknown" },
              { type: "hosts_meeting", label: "Hosted meetings", state: "unknown" },
              { type: "issues_recommendation", label: "Recommendations", state: "unknown" },
            ],
          },
        },
      },
    },
  }],
  public_edges: [{
    type: "covers",
    from: "community-board:bronx-cb-01",
    to: "community-district:X01",
  }],
};

test("People + organizations exposes a board institution projection", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", { places: geography }));
  assert.match(html, /data-board-projection="organization"/);
  assert.match(html, /data-body-id="bronx-cb-01"/);
  assert.match(html, /href="\/community-boards\/bronx-cb-01\/"/);
  const directory = html.match(/<section[^>]+id="community-boards"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(directory, /Bronx community boards:/);
  assert.match(directory, /aria-label="Bronx Community Board 1"[^>]*>1<\/a>/);
  assert.doesNotMatch(directory, /Covers |Community District|· (?:Published|Unknown)|browse-concept-status-rail/);
  assert.match(html, /id="people-organizations-list"/);
  assert.doesNotMatch(html, /id="officials"|id="vendors"|id="committees"/);
  assert.match(html, /id="community-boards"/);
  assert.doesNotMatch(html, /Published official profiles\.|Vendor profiles from award records\.|Published committee records\./);
  assert.match(html, /Public bodies serving New York City districts\./);
  assert.doesNotMatch(html, /matter_title_place|venue_line|boro_cd|Source: Unavailable|Join method: Unavailable/);
});

test("generated People landing renders each Community Board card once without internal ids", () => {
  const html = buildBrowseConceptDocument(shell, "people", { places: geography });
  const card = html.match(/<article class="browse-static-record[^>]*data-row-kind="community-board"[\s\S]*?<\/article>/)?.[0] || "";
  const visibleText = card.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  assert.ok(card, "the generated People landing contains a Community Board card");
  assert.equal((card.match(/data-civic-object-kind="community-board"/g) || []).length, 1);
  assert.equal((visibleText.match(/Bronx Community Board 1/g) || []).length, 1);
  assert.equal((card.match(/href="\/community-boards\/bronx-cb-01\/"/g) || []).length, 1);
  assert.doesNotMatch(visibleText, /community-board:/);
  assert.match(visibleText, /Community Board · Appointed local advisory body · Covers Bronx Community District 1\./);
});

test("Community boards directory groups numbered institution links by borough", () => {
  const places = {
    nodes: [
      ["bronx-cb-01", "Bronx", 1],
      ["bronx-cb-02", "Bronx", 2],
      ["brooklyn-cb-01", "Brooklyn", 1],
    ].map(([bodyId, borough, district]) => ({
      id: `community-board:${bodyId}`,
      type: "community-board",
      name: `${borough} Community Board ${district}`,
      properties: { body_id: bodyId, borough, district },
    })),
    public_edges: [],
  };
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", { places }));
  const section = html.match(/<section[^>]+id="community-boards"[\s\S]*?<\/section>/)?.[0] || "";

  assert.equal((section.match(/class="browse-board-borough"/g) || []).length, 2);
  assert.match(section, /Bronx community boards/);
  assert.match(section, /Brooklyn community boards/);
  assert.equal((section.match(/href="\/community-boards\/(?:bronx-cb-0[12]|brooklyn-cb-01)\/"/g) || []).length, 3);
  assert.match(section, /aria-label="Bronx Community Board 1"[^>]*>1<\/a>/);
  assert.match(section, /aria-label="Bronx Community Board 2"[^>]*>2<\/a>/);
  assert.match(section, /aria-label="Brooklyn Community Board 1"[^>]*>1<\/a>/);
  assert.match(section, />1<\/a> <a[^>]+aria-label="Bronx Community Board 2"/);
  assert.doesNotMatch(section, /Covers |Community District|>Bronx Community Board 1<|>Brooklyn Community Board 1</);
});

test("committee cards list members once without graph-edge labels", () => {
  const people = { by_person_id: {
    "7801": { person_id: "7801", person_name: "Christopher Marte" },
    "5259": { person_id: "5259", person_name: "Gale A. Brewer" },
  } };
  const committees = {
    publication: "published",
    nodes: [{ id: "committee:1", type: "committee", name: "Committee on Housing" }],
    public_edges: [
      { type: "member_of", from: "official:7801", to: "committee:1" },
      { type: "member_of", from: "official:5259", to: "committee:1" },
    ],
  };
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", { people, committees }));
  const section = html.match(/<section[^>]+id="committees"[\s\S]*?<\/section>/)?.[0] || "";
  const visibleText = section.replace(/<[^>]+>/g, " ").replace(/◆/g, "").replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();

  assert.match(visibleText, /Committee on Housing\. Members: Christopher Marte, Gale A\. Brewer\./);
  assert.doesNotMatch(visibleText, /has member|member of|Local connections|connected records/i);
  assert.equal((section.match(/href="\/officials\/(?:5259|7801)\/"/g) || []).length, 2);
  assert.equal((section.match(/data-pivot-relation-label="has member"/g) || []).length, 2);
});

test("People + organizations builds one typed list and never joins a notice name to an official", () => {
  const model = buildPeopleOrganizationsReadModel({
    people: { by_person_id: { "7801": { person_id: "7801", person_name: "Christopher Marte", terms: [{ office_id: "office-1", term_start: "2024-01-01" }] } } },
    committees: { publication: "published", nodes: [{ id: "committee:1", type: "committee", name: "Land Use" }], public_edges: [{ type: "member_of", from: "official:7801", to: "committee:1", title: "Member" }] },
    agencies: { by_id: { parks: { subject_ref: "agency:id:parks-and-recreation", display_name: "Parks and Recreation", path: "/agencies/parks-and-recreation/", top_vendors: [{ subject_ref: "vendor:stem:ACME", label: "ACME", href: "/vendors/ACME/", award_count: 1 }] } } },
    places: geography,
    hires: { notices: [{ request_id: "984089", agency_name: "Parks", additional_description_1: "Employee Name: MARTE, CHRISTOPHER" }] },
  });
  assert.deepEqual(new Set(model.rows.map((row) => row.kind)), new Set(["official", "exact-person-appointment", "notice-only-hire", "agency", "vendor", "committee", "community-board"]));
  const appointment = model.rows.find((row) => row.kind === "exact-person-appointment");
  assert.equal(appointment.person_id, "7801");
  assert.equal(appointment.entity_ref, "entity:official:7801");
  const notice = model.rows.find((row) => row.kind === "notice-only-hire");
  assert.equal(notice.entity_ref, null);
  assert.equal(notice.relation_state, "unknown");
  assert.equal(notice.href, "/notices/984089");
  const committee = model.rows.find((row) => row.kind === "committee");
  assert.equal(committee.relation_state, "published");
  assert.deepEqual(committee.members.map((member) => member.person_id), ["7801"]);
  const board = model.rows.find((row) => row.kind === "community-board");
  assert.match(board.place_href, /^\/near-you\//);
  assert.equal(board.district, "X01", "the exact join key remains in the read model");
  assert.equal(board.detail, "Covers Bronx Community District 1.");
  assert.ok(board.organization_relations.every((relation) => relation.state === "unknown"));
  const boardHtml = renderPeopleOrganizationRow(board);
  const boardVisibleText = boardHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.doesNotMatch(boardVisibleText, /Community District X01|\bpublished\b|\bunknown\b/i);
});

test("People + organizations keeps Community Board people and committees board-local", () => {
  const boardPeople = {
    observed_on: "2026-08-25",
    boards: {
      "manhattan-cb-06": {
        relationships: [
          {
            publisher_person_id: "jesus-perez",
            person_name: "Jesús Pérez",
            relation: "staffed_by",
            role: "district_manager",
            relation_date: "2026-08-25",
            source_document: {
              publisher_document_id: "cb6-roster-2026-08-25",
              document_url: "https://cbsix.org/about-us/board-members-and-staff/",
              date: "2026-08-25",
              observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
            },
          },
          {
            publisher_person_id: "jason-froimowitz",
            person_name: "Jason Froimowitz",
            relation: "chairs",
            committee_ref: "community-board-committee:manhattan-cb-06:transportation",
            role: "committee_chair",
            relation_date: "2026-08-25",
            source_document: {
              publisher_document_id: "cb6-roster-2026-08-25",
              document_url: "https://cbsix.org/about-us/board-members-and-staff/",
              date: "2026-08-25",
              observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
            },
          },
        ],
      },
    },
  };
  const places = {
    nodes: [{
      id: "community-board:manhattan-cb-06",
      type: "community-board",
      name: "Manhattan Community Board 6",
      properties: { body_id: "manhattan-cb-06", borough: "Manhattan", district: 6 },
    }],
    public_edges: [],
  };
  const committeeRegistry = {
    committees: [{
      board_id: "manhattan-cb-06",
      committee_id: "transportation",
      publisher_name: "Transportation Committee",
      source_url: "https://cbsix.org/meetings-calendar/",
      observed_on: "2026-08-25",
    }],
  };
  const model = buildPeopleOrganizationsReadModel({
    places,
    communityBoardPeople: boardPeople,
    communityBoardCommittees: committeeRegistry,
  });
  assert.deepEqual(model.rows.map((row) => row.kind), [
    "community-board",
    "community-board-person",
    "community-board-person",
    "community-board-committee",
  ]);
  const staff = model.rows.find((row) => row.role_family === "staff");
  assert.equal(staff.id, "community-board-person:manhattan-cb-06:jesus-perez");
  assert.equal(staff.institution_label, "Manhattan Community Board 6");
  assert.equal(staff.href, null);
  assert.doesNotMatch(renderPeopleOrganizationRow(staff), /officials|votes|finance|lobby/i);
  const committee = model.rows.find((row) => row.kind === "community-board-committee");
  const card = renderPeopleOrganizationRow(committee);
  assert.match(card, /Manhattan Community Board 6 · Community Board committee/);
  assert.match(card, /href="\/community-boards\/manhattan-cb-06\/"/);
  assert.doesNotMatch(card, /href="\/committees\//);
});

test("People + organizations gives every row a unique resident-facing h3 heading", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", {
    people: { by_person_id: { "7801": { person_id: "7801", person_name: "Christopher Marte", terms: [{ office_id: "office-1", term_start: "2024-01-01" }] } } },
    hires: { notices: [{ request_id: "984089", agency_name: "Parks", additional_description_1: "Employee Name: MARTE, CHRISTOPHER" }] },
  }));
  const headings = [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));
  assert.equal(new Set(headings).size, headings.length);
  assert.ok(headings.some((heading) => heading.includes("New York City Council · City Council member/official · Christopher Marte")));
  assert.ok(headings.some((heading) => heading.includes("New York City Council · City Council term · Christopher Marte · appointment:7801:office-1:2024-01-01")));
});

test("official rows present one name and type without publication or internal-id noise", () => {
  const html = renderPeopleOrganizationRow({
    kind: "official",
    id: "official:425",
    label: "Adolfo Carrion",
    href: "/officials/425/",
    relation_state: "published",
    detail: "Official profile",
    search_text: "Adolfo Carrion official council member",
  });
  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  assert.match(visibleText, /New York City Council · City Council member\/official · Adolfo Carrion/);
  assert.match(visibleText, /Copy link/);
  assert.doesNotMatch(visibleText, /Published|Official profile|official:425/);
  assert.match(visibleText, /New York City Council/);
});

test("People + organizations keeps concept and unified-list headings unique", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", { places: geography }));
  const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, "").trim());
  assert.equal(new Set(headings).size, headings.length);
  assert.equal(headings.filter((heading) => heading === "People and organizations").length, 1);
});

test("People + organizations keeps the full typed model searchable behind a first page", () => {
  const people = { retrieved_at: "2026-08-11T19:21:19.284Z", by_person_id: Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [String(index), { person_id: String(index), person_name: `Person ${index}` }]),
  ) };
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", { people }));
  assert.equal((html.match(/data-people-organization-row/g) || []).length, 16);
  assert.match(html, /data-people-organizations-type/);
  assert.match(html, /data-people-organizations-model/);
  assert.match(html, /Updated 2026-08-11T19:21:19\.284Z/);
  assert.match(html, /Person 19/);
});

test("Places delegates board place discovery to Near you without a duplicate board list", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("places", { places: geography }));
  assert.match(html, /Open Near you for place discovery/);
  assert.match(html, /href="\/near-you\/"/);
  assert.doesNotMatch(html, /Bronx Community Board 1/);
  assert.doesNotMatch(html, /Community District X01/);
  assert.match(html, /href="\/community-boards\/"/);
});
