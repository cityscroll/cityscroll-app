/**
 * Reviewed identity copy is the same across search, People & organizations,
 * the directory, profile headings and selected-scope labels.
 *
 * Stored agency identifiers and bookmarked scopes stay byte-compatible.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildAgencySearchDocuments } from "../site/agency_search_producer.mjs";
import { canonicalAgencyChoices } from "../site/agency_scope_links.mjs";
import { renderAgencyConstellationDocument } from "../site/agency_constellation.mjs";
import { projectInstitutionProfileNavigation } from "../site/civic_institution_profile_navigation.mjs";
import {
  projectResidentInstitutionIdentity,
  residentInstitutionSummary,
} from "../site/civic_institution_resident_identity.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";
import { peopleBrowseRows } from "../site/people_organizations_surface.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import { buildUniversalSearchResultView } from "../site/universal_search_relevance_ux.mjs";
import { agencyDirectoryModel } from "../tools/build_agency_documents.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP = JSON.parse(readFileSync(join(ROOT, "site/data/agency_constellation_lookup.json"), "utf8"));
const IDENTITY_REPORT = JSON.parse(
  readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"),
);
const CROSSWALK = JSON.parse(readFileSync(join(ROOT, "worker/src/data/agency_crosswalk.json"), "utf8"));

const BODIES = Object.freeze({
  CPC: Object.freeze({
    query: "CPC",
    id: "city-planning-commission",
    name: /City Planning Commission/,
    kind: "Commission",
    purpose: /hearings and votes/,
  }),
  NYCEDC: Object.freeze({
    query: "NYCEDC",
    id: "economic-development-corporation",
    name: /Economic Development Corporation/,
    kind: "Nonprofit organization",
    purpose: /nonprofit corporation/,
  }),
  NYCHA: Object.freeze({
    query: "NYCHA",
    id: "housing-authority",
    name: /Housing Authority/,
    kind: "Public housing authority",
    purpose: /public housing/,
  }),
  Council: Object.freeze({
    query: "Council",
    id: "city-council",
    name: /City Council/,
    kind: "Legislative body",
    purpose: /legislative body/,
  }),
});

function searchDocuments() {
  return buildAgencySearchDocuments(LOOKUP, {
    identityReport: IDENTITY_REPORT,
    publisherCrosswalk: CROSSWALK,
  }).documents;
}

function hitsFor(documents, query) {
  return searchKeywordDocuments(documents, resolveKeywordQuery(query), { limit: 20 });
}

function hitFor(documents, query, id) {
  return hitsFor(documents, query)
    .map((row) => row.document || row)
    .find((document) => document.object_ref === `agency:id:${id}` || document.canonical_href === `/agencies/${id}/`);
}

test("A1 CPC, NYCEDC, NYCHA and Council keep distinct types and the same destinations", () => {
  const documents = searchDocuments();
  const directory = agencyDirectoryModel();
  const people = buildPeopleOrganizationsReadModel({
    agencies: LOOKUP,
    publisherCrosswalk: CROSSWALK,
  });
  const seenDescriptions = new Set();

  for (const body of Object.values(BODIES)) {
    const resident = projectResidentInstitutionIdentity(body.id, {
      displayName: LOOKUP.by_id[body.id].display_name,
      publisherRow: CROSSWALK.entries[body.id],
    });
    assert.equal(resident.canonical_id, body.id);
    assert.equal(resident.href, `/agencies/${body.id}/`);
    assert.equal(resident.stored_identifier, body.id);
    assert.match(resident.canonical_name, body.name);
    assert.equal(resident.kind_label, body.kind);
    assert.match(resident.purpose, body.purpose);
    assert.match(resident.description, new RegExp(body.kind));
    assert.doesNotMatch(resident.description, /City agency organization/i);
    assert.ok(!seenDescriptions.has(resident.description), body.id);
    seenDescriptions.add(resident.description);

    const searchHit = hitFor(documents, body.query, body.id);
    assert.ok(searchHit, `search missed ${body.query}`);
    assert.equal(searchHit.canonical_href, `/agencies/${body.id}/`);
    assert.equal(searchHit.object_ref, `agency:id:${body.id}`);
    assert.match(searchHit.summary, new RegExp(body.kind));
    assert.match(searchHit.summary, body.purpose);
    assert.doesNotMatch(searchHit.summary, /Agency with public records/i);
    const view = buildUniversalSearchResultView({
      ...searchHit,
      entity_type: "agency",
      lens: "agencies",
      source_route: searchHit.canonical_href,
      match_fields: [{ field: "title", matched_term: body.query }],
    });
    assert.equal(view.entity_type_label, body.kind);
    assert.equal(view.href, `/agencies/${body.id}/`);

    const directoryRow = directory.rows.find((row) => row.canonical_id === body.id);
    assert.ok(directoryRow, body.id);
    assert.equal(directoryRow.href, `/agencies/${body.id}/`);
    assert.equal(directoryRow.kind_label, body.kind);
    assert.match(directoryRow.purpose, body.purpose);

    const peopleRow = people.rows.find((row) => row.id === `agency:id:${body.id}`);
    assert.ok(peopleRow, body.id);
    assert.equal(peopleRow.href, `/agencies/${body.id}/`);
    assert.equal(peopleRow.institution_label, body.kind);
    assert.match(peopleRow.institution_context, body.purpose);
    assert.doesNotMatch(peopleRow.institution_context, /City agency organization/);
    const browse = peopleBrowseRows({ rows: [peopleRow] })[0];
    assert.equal(browse.civic_object.kind_label, body.kind);
    assert.match(browse.label, body.name);

    const scope = canonicalAgencyChoices([LOOKUP.by_id[body.id].display_name])
      .find((choice) => choice.id === body.id);
    assert.ok(scope, body.id);
    assert.match(scope.label, body.name);
    assert.match(scope.label, new RegExp(body.kind));
  }
});

test("A2 DCP and CPC stay separate; ORE and CORE stay separate", () => {
  const documents = searchDocuments();
  const dcp = hitFor(documents, "DCP", "city-planning");
  const cpc = hitFor(documents, "CPC", "city-planning-commission");
  assert.ok(dcp && cpc);
  assert.equal(dcp.canonical_href, "/agencies/city-planning/");
  assert.equal(cpc.canonical_href, "/agencies/city-planning-commission/");
  assert.notEqual(dcp.object_ref, cpc.object_ref);
  assert.match(dcp.summary, /City department/);
  assert.match(cpc.summary, /Commission/);
  assert.notEqual(dcp.summary, cpc.summary);

  const ore = hitFor(documents, "ORE", "office-of-racial-equity");
  const core = hitFor(documents, "CORE", "commission-on-racial-equity");
  assert.ok(ore && core);
  assert.equal(ore.canonical_href, "/agencies/office-of-racial-equity/");
  assert.equal(core.canonical_href, "/agencies/commission-on-racial-equity/");
  assert.notEqual(ore.object_ref, core.object_ref);
});

test("A2 DoITT-era names stay discoverable while current display is OTI", () => {
  const otiId = "information-technology-and-telecommunications";
  const resident = projectResidentInstitutionIdentity(otiId, {
    displayName: LOOKUP.by_id[otiId].display_name,
    publisherRow: CROSSWALK.entries[otiId],
  });
  assert.equal(resident.stored_identifier, otiId);
  assert.equal(resident.href, `/agencies/${otiId}/`);
  assert.match(resident.canonical_name, /Technology and Innovation/);
  assert.ok(resident.former_names.some((name) => /Information Technology/i.test(name) || name === "DoITT"));
  assert.ok(resident.discovery_terms.some((term) => /DoITT/i.test(term)));
  assert.equal(resident.canonical_id, otiId);

  const searchHit = hitFor(searchDocuments(), "DoITT", otiId);
  assert.ok(searchHit);
  assert.equal(searchHit.title, LOOKUP.by_id[otiId].display_name);
  assert.equal(searchHit.canonical_href, `/agencies/${otiId}/`);
  assert.equal(searchHit.object_ref, `agency:id:${otiId}`);
});

test("unclassified bodies omit invented type copy", () => {
  const parks = projectResidentInstitutionIdentity("parks-and-recreation", {
    displayName: "Department of Parks and Recreation",
  });
  assert.equal(parks.classified, false);
  assert.equal(parks.kind_label, null);
  assert.equal(parks.purpose, null);
  assert.equal(parks.description, null);
  const summary = residentInstitutionSummary(parks, { matchedCategories: 2 });
  assert.match(summary, /Public records in 2 connected categories/);
  assert.doesNotMatch(summary, /Agency with public records/);
  assert.doesNotMatch(summary, /City agency organization/);
});

test("profile headings reuse the same kind and purpose", () => {
  const id = "city-planning-commission";
  const navigation = projectInstitutionProfileNavigation({
    identity: { canonical_id: id, canonical_name: "City Planning Commission" },
    view: {
      canonical_id: id,
      display_name: "City Planning Commission",
      summary: { generated_at: "2026-09-05" },
    },
  });
  assert.equal(navigation.identity.kind_label, "Commission");
  assert.match(navigation.identity.purpose, /hearings and votes/);
  assert.equal(navigation.identity.subject_ref, "agency:id:city-planning-commission");
  assert.equal(navigation.identity.route, "/agencies/city-planning-commission/");

  const html = renderAgencyConstellationDocument({
    kind: "agency-constellation",
    id,
    canonical_id: id,
    display_name: "City Planning Commission",
    path: "/agencies/city-planning-commission/",
    subject_ref: "agency:id:city-planning-commission",
    interactive_profile_href: "/agencies/city-planning-commission/",
    follow_href: "/following/?scope=agency:id:city-planning-commission",
    summary: {
      matched_categories: 2,
      generated_at: "2026-09-05",
      er_match_basis: "agency_canonical_v1",
    },
    categories: [],
    claims: [],
  });
  assert.match(html, /<p class="node-kicker civic-object-kicker">Commission<\/p>/);
  assert.match(html, /Holds public hearings and votes/);
  assert.match(html, /<h1>City Planning Commission<\/h1>/);
});
