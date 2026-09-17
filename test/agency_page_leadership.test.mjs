// Who leads an agency, asked on the agency page a resident actually opens.
//
// The person, role, source, observation date and confidence must match the same
// published officer statement the dossier and organization capabilities serve.
// An agency whose sources name nobody must say so on the page rather than omit
// the section.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeEntityDossier } from "../capabilities/entity_dossier.mjs";
import { executePeopleGet } from "../capabilities/people_organizations.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDeferredFragment,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { workerD1EntityDossier } from "../worker/src/entity_dossier.mjs";
import { workerPeopleOrganizations } from "../worker/src/people_organizations.mjs";
import { agencyLeadershipAnswer } from "../worker/src/lib/published_agency_entity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

const EVALUATED = readJson("test/fixtures/agency_entity_publication/evaluated_agencies.json");
const PUBLICATION = readJson("worker/src/data/agency_entity_publication.json");
const READ_MODEL = readJson("site/data/people_organizations_read_model.json");
const PEOPLE_ENV = { PEOPLE_ORGANIZATIONS_READ_MODEL: READ_MODEL };

const emptyStore = () => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
});

const dossierProvider = () => workerD1EntityDossier(emptyStore(), { publication: PUBLICATION });

const agencyRowIds = new Set(
  READ_MODEL.rows.filter((row) => row.kind === "agency").map((row) => row.id),
);

function agencyWithNoRecordedOfficer() {
  const found = Object.values(PUBLICATION.officers)
    .filter((officer) => officer.status === "not_recorded")
    .map((officer) => officer.entity_id)
    .filter((entityId) => PUBLICATION.agencies[entityId] && agencyRowIds.has(entityId))
    .map((entityId) => entityId.replace(/^agency:id:/, ""))
    .filter((agencyId) => {
      try {
        return buildAgencyConstellationView(agencyId).kind === "agency-constellation";
      } catch {
        return false;
      }
    })
    .sort()[0];
  assert.ok(found, "the publication records at least one agency page whose sources name no officer");
  return found;
}

function agencyIdFromEntity(entityId) {
  return String(entityId || "").replace(/^agency:id:/, "");
}

function renderAgencyPage(agencyId) {
  const view = buildAgencyConstellationView(agencyId);
  assert.equal(view.kind, "agency-constellation");
  const html = renderAgencyConstellationDocument(view);
  assert.deepEqual(detectNodePageCruft(html), []);
  return { view, html };
}

test("leadership is a static early section on the agency page", () => {
  const section = AGENCY_CONSTELLATION_SECTIONS.find((row) => row.id === "leadership");
  assert.ok(section, "leadership section is registered");
  assert.equal(section.static, true);
  assert.equal(section.order, 2);
});

test("an evaluated agency page names its leader with the same provenance the dossier and organization row carry", async () => {
  assert.ok(EVALUATED.agencies.length, "the evaluation runs named at least one organization");
  for (const agency of EVALUATED.agencies) {
    const agencyId = agencyIdFromEntity(agency.entity_id);
    const expected = agencyLeadershipAnswer(agency.entity_id, PUBLICATION);
    assert.equal(expected.status, "published", `${agency.name} has a published officer statement`);

    const dossier = await executeEntityDossier(dossierProvider(), { entityId: agency.entity_id });
    assert.equal(dossier.availability, "available");
    const fromDossier = dossier.dossier.leadership;
    const fromOrg = (await executePeopleGet(
      workerPeopleOrganizations(PEOPLE_ENV).get,
      { entityId: agency.entity_id },
    )).person_or_organization.leadership;

    const { html } = renderAgencyPage(agencyId);
    assert.match(html, /id="agency-leadership"/);
    assert.match(html, /data-agency-leadership="published"/);
    assert.match(html, /Who leads this agency\?/);
    assert.match(html, new RegExp(`data-leadership-person="${expected.person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(html, new RegExp(expected.person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (expected.title) {
      assert.match(html, new RegExp(expected.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(html, new RegExp(expected.source.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(`data-leadership-observed-at="${expected.observed_at}"`));
    assert.match(expected.observed_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(html, /data-leadership-confidence="strong"/);
    assert.match(html, /data-leadership-basis="publisher_record"/);
    assert.match(html, /Source and confidence/);
    // Resident page copy must not expose publisher column or system identifiers.
    assert.doesNotMatch(html, /\bhead_name\b/);
    assert.doesNotMatch(html, /\bhead_title\b/);
    assert.doesNotMatch(html, /\bnyc_open_data\b/);
    assert.match(html, /NYC Open Data/);

    assert.equal(fromDossier.person, expected.person);
    assert.equal(fromDossier.title, expected.title);
    assert.equal(fromDossier.observed_at, expected.observed_at);
    assert.equal(fromDossier.source.id, expected.source.id);
    assert.equal(fromDossier.confidence.status, expected.confidence.status);
    assert.equal(fromOrg.person, expected.person);
    assert.equal(fromOrg.observed_at, expected.observed_at);
    assert.equal(fromOrg.confidence.status, expected.confidence.status);
  }
});

test("an agency page with no published leader states the absence instead of omitting the section", async () => {
  const agencyId = agencyWithNoRecordedOfficer();
  const entityId = `agency:id:${agencyId}`;
  const expected = agencyLeadershipAnswer(entityId, PUBLICATION);
  assert.equal(expected.status, "not_recorded");

  const fromDossier = (await executeEntityDossier(dossierProvider(), { entityId })).dossier.leadership;
  const fromOrg = (await executePeopleGet(
    workerPeopleOrganizations(PEOPLE_ENV).get,
    { entityId },
  )).person_or_organization.leadership;

  const { html } = renderAgencyPage(agencyId);
  assert.match(html, /id="agency-leadership"/);
  assert.match(html, /data-agency-leadership="not_recorded"/);
  assert.match(html, /Who leads this agency\?/);
  assert.match(html, /data-leadership-absence="not_recorded"/);
  assert.match(html, />Not recorded</);
  assert.match(html, /carry no officer for this agency/i);
  assert.doesNotMatch(html, /data-leadership-person=/);
  assert.equal(fromDossier.status, "not_recorded");
  assert.equal(fromOrg.status, "not_recorded");
  assert.equal(fromDossier.person, null);
  assert.equal(fromOrg.person, null);
});

test("leadership stays in the static document and out of the deferred relationship fragment", () => {
  const agencyId = agencyIdFromEntity(EVALUATED.agencies[0].entity_id);
  const view = buildAgencyConstellationView(agencyId);
  const documentHtml = renderAgencyConstellationDocument(view);
  const deferredHtml = renderAgencyConstellationDeferredFragment(view);
  assert.match(documentHtml, /id="agency-leadership"/);
  assert.doesNotMatch(deferredHtml, /id="agency-leadership"/);
});
