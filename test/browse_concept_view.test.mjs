import assert from "node:assert/strict";
import test from "node:test";

import { buildBrowseConceptLanding, renderBrowseConceptLanding } from "../site/browse_concept_view.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";

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
  assert.match(html, /Covers Bronx Community District X01\./);
  assert.match(html, /Board identity · Published/);
  assert.match(html, /District coverage · Published/);
  assert.match(html, /Members · Unknown/);
  assert.match(html, /Hosted meetings · Unknown/);
  assert.match(html, /Recommendations · Unknown/);
  assert.match(html, /id="people-organizations-list"/);
  assert.match(html, /id="officials"/);
  assert.match(html, /id="vendors"/);
  assert.match(html, /id="committees"/);
  assert.match(html, /id="community-boards"/);
  assert.match(html, /Published official profiles\./);
  assert.match(html, /Vendor profiles from award records\./);
  assert.match(html, /Published committee records\./);
  assert.match(html, /Public bodies serving New York City districts\./);
  assert.doesNotMatch(html, /matter_title_place|venue_line|boro_cd|Source: Unavailable|Join method: Unavailable/);
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
});

test("People + organizations gives every row a unique typed h3 heading", () => {
  const html = renderBrowseConceptLanding(buildBrowseConceptLanding("people", {
    people: { by_person_id: { "7801": { person_id: "7801", person_name: "Christopher Marte", terms: [{ office_id: "office-1", term_start: "2024-01-01" }] } } },
    hires: { notices: [{ request_id: "984089", agency_name: "Parks", additional_description_1: "Employee Name: MARTE, CHRISTOPHER" }] },
  }));
  const headings = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));
  assert.equal(new Set(headings).size, headings.length);
  assert.ok(headings.some((heading) => heading.includes("Official · official:7801")));
  assert.ok(headings.some((heading) => heading.includes("Exact-person appointment · appointment:7801:office-1:2024-01-01")));
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
