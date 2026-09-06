import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadOntologyRegistry } from "../ontology/index.mjs";
import { CIVIC_INSTITUTION_ROLE_RELATIONS } from "../ontology/civic_institution.mjs";
import { projectInstitutionClassification } from "../site/civic_institution_classification_project.mjs";
import {
  BROOKLYN_CB15_BODY_ID,
  BROOKLYN_OFFICE_CANONICAL_ID,
  BROOKLYN_OFFICEHOLDER_NAME,
} from "../site/civic_institution_borough_office.mjs";
import {
  MTA_OPERATING_BODIES,
  RELATED_PUBLIC_BODIES_NEGATIVE_RULE,
  boroughBoardCanonicalId,
  boroughBoardHref,
  boroughGeographyHref,
  projectRelatedPublicBodies,
  renderBoroughBoardDocument,
  renderRelatedPublicBodies,
  renderRelatedPublicBodiesFor,
  reviewedBoroughBoardDestinations,
} from "../site/civic_institution_related_bodies.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));

test("registry registers sourced related-body verbs without collapsing them into control", () => {
  const registry = loadOntologyRegistry();
  const ids = new Map(registry.link_types.map((row) => [row.id, row]));
  assert.equal(ids.get("staffs").inverse, "has_staffing_from");
  assert.equal(ids.get("director_chairs").from, "civic-institution");
  assert.equal(ids.get("lists_operating_body").to, "civic-institution");
  assert.equal(ids.get("chairs_body").inverse, "body_chaired_by");
  assert.match(ids.get("staffs").negative_rule, /legal form/);
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.staffs.object_kind, "civic-institution");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.lists_operating_body.inverse, "listed_as_operating_body_of");
  assert.match(RELATED_PUBLIC_BODIES_NEGATIVE_RULE, /current members/);
});

test("A1 DCP and CPC link to one another with staffing and chairing explained", () => {
  const dcp = projectRelatedPublicBodies("city-planning");
  const cpc = projectRelatedPublicBodies("city-planning-commission");
  const dcpStaffs = dcp.links.find((row) => row.relation_id === "staffs");
  const cpcStaffed = cpc.links.find((row) => row.relation_id === "has_staffing_from");
  assert.equal(dcpStaffs.href, "/agencies/city-planning-commission/");
  assert.equal(cpcStaffed.href, "/agencies/city-planning/");
  assert.match(dcpStaffs.verb, /Staffs/);
  assert.match(cpcStaffed.verb, /Staffed by/);
  assert.match(dcpStaffs.boundary, /not a general power/i);
  assert.equal(dcp.links.some((row) => row.relation_id === "director_chairs"), true);
  assert.equal(cpc.links.some((row) => row.relation_id === "chaired_by_director_of"), true);

  const dcpHtml = renderRelatedPublicBodiesFor("city-planning");
  const cpcHtml = renderRelatedPublicBodiesFor("city-planning-commission");
  assert.match(dcpHtml, /id="related-public-bodies"/);
  assert.match(dcpHtml, /href="\/agencies\/city-planning-commission\/"/);
  assert.match(cpcHtml, /href="\/agencies\/city-planning\/"/);
  assert.match(dcpHtml, /Staffs/);
  assert.doesNotMatch(dcpHtml, /controls the commission/i);
});

test("A1 MTA offers operating-body links that keep distinct identities", () => {
  const mta = projectRelatedPublicBodies("metropolitan-transportation-authority");
  const parent = projectInstitutionClassification("metropolitan-transportation-authority");
  assert.equal(mta.links.length, MTA_OPERATING_BODIES.length);
  const html = renderRelatedPublicBodiesFor("metropolitan-transportation-authority");
  for (const id of MTA_OPERATING_BODIES) {
    const row = mta.links.find((link) => link.object_id === id);
    assert.equal(row.href, `/agencies/${id}/`);
    assert.equal(row.object_kind, "operating_body");
    assert.match(row.boundary, /legal form/);
    assert.match(html, new RegExp(`href="/agencies/${id}/"`));
    const body = projectInstitutionClassification(id);
    assert.equal(body.legal_form, null, id);
    assert.notEqual(body.institution.institution_kind, parent.institution.institution_kind, id);
    const reverse = projectRelatedPublicBodies(id);
    assert.equal(reverse.links[0].href, "/agencies/metropolitan-transportation-authority/");
    assert.match(renderRelatedPublicBodiesFor(id), /href="\/agencies\/metropolitan-transportation-authority\/"/);
    assert.notEqual(LOOKUP.by_id[id].path, LOOKUP.by_id["metropolitan-transportation-authority"].path);
  }
});

test("A2 a borough-president journey distinguishes office, board, Community Board and geography", () => {
  const office = projectRelatedPublicBodies(BROOKLYN_OFFICE_CANONICAL_ID);
  const boardId = boroughBoardCanonicalId("brooklyn");
  const board = projectRelatedPublicBodies(boardId);
  const community = projectRelatedPublicBodies(BROOKLYN_CB15_BODY_ID);
  const hrefs = new Set([
    ...office.links.map((row) => row.href),
    ...board.links.map((row) => row.href),
    ...community.links.map((row) => row.href),
  ]);
  assert.equal(office.links.find((row) => row.relation_id === "chairs_body").href, boroughBoardHref("brooklyn"));
  assert.equal(office.links.find((row) => row.relation_id === "appoints_members_of").href, `/community-boards/${BROOKLYN_CB15_BODY_ID}/`);
  assert.equal(office.links.find((row) => row.relation_id === "serves_territory").href, boroughGeographyHref("brooklyn"));
  assert.equal(hrefs.has(`/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`), true);
  assert.equal(hrefs.has(boroughBoardHref("brooklyn")), true);
  assert.equal(hrefs.has(`/community-boards/${BROOKLYN_CB15_BODY_ID}/`), true);
  assert.equal(hrefs.has(boroughGeographyHref("brooklyn")), true);
  assert.equal(new Set([
    `/agencies/${BROOKLYN_OFFICE_CANONICAL_ID}/`,
    boroughBoardHref("brooklyn"),
    `/community-boards/${BROOKLYN_CB15_BODY_ID}/`,
    boroughGeographyHref("brooklyn"),
  ]).size, 4);

  const officeHtml = renderRelatedPublicBodiesFor(BROOKLYN_OFFICE_CANONICAL_ID);
  const boardHtml = renderBoroughBoardDocument("brooklyn");
  assert.match(officeHtml, /Chairs/);
  assert.match(officeHtml, /Appoints members of/);
  assert.match(boardHtml, /data-civic-object-kind="borough-board"/);
  assert.match(boardHtml, /statutory seats/);
  assert.match(community.links.find((row) => row.relation_id === "covers_district").href, /near-you/);
  assert.match(office.links.find((row) => row.relation_id === "appoints_members_of").boundary, /not a general power/);
  assert.match(office.links.find((row) => row.relation_id === "chairs_body").boundary, /not a power to direct/);
});

test("A3 statutory seats do not name current members and operating bodies keep their own form", () => {
  const boardHtml = renderBoroughBoardDocument("brooklyn");
  assert.doesNotMatch(boardHtml, new RegExp(BROOKLYN_OFFICEHOLDER_NAME));
  assert.doesNotMatch(boardHtml, /current members include/i);
  const office = projectRelatedPublicBodies(BROOKLYN_OFFICE_CANONICAL_ID);
  assert.equal(office.links.every((row) => !/control|runs the board|directs every/i.test(`${row.verb} ${row.explanation}`)), true);
  for (const id of MTA_OPERATING_BODIES) {
    const body = projectInstitutionClassification(id);
    assert.equal(body.legal_form, null, id);
    assert.equal(body.institution.legal_form, null, id);
  }
});

test("A3 a body with no sourced relationship omits the panel", () => {
  assert.equal(projectRelatedPublicBodies("sanitation"), null);
  assert.equal(renderRelatedPublicBodies(null), "");
  assert.equal(renderRelatedPublicBodiesFor("sanitation"), "");
});

test("reviewed borough boards are five navigable destinations", () => {
  const destinations = reviewedBoroughBoardDestinations();
  assert.equal(destinations.length, 5);
  assert.equal(new Set(destinations.map((row) => row.href)).size, 5);
  assert.equal(destinations.find((row) => row.borough_slug === "brooklyn").href, "/agencies/brooklyn-borough-board/");
  const html = renderBoroughBoardDocument("queens");
  assert.match(html, /Queens Borough Board/);
  assert.match(html, /href="\/near-you\/borough\/queens\/"/);
});
