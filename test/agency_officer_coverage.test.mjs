// Who leads a city agency, asked of the organizations that live evaluation runs
// of the deployed research service actually named.
//
// A reader asking who runs an agency wants a person. The organizations in this
// test are read from a fixture derived from those runs rather than retyped
// here, so a change to the evaluation set moves the test with it. The agency
// with no published officer is likewise read out of the publication rather than
// named here, because which agencies its sources leave unrecorded is a fact
// about the record and not a choice this test gets to make.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeEntityDossier } from "../capabilities/entity_dossier.mjs";
import { executePeopleGet } from "../capabilities/people_organizations.mjs";
import { workerD1EntityDossier } from "../worker/src/entity_dossier.mjs";
import { workerPeopleOrganizations } from "../worker/src/people_organizations.mjs";
import {
  agencyLeadershipAnswer,
  readPublishedAgencyOfficer,
} from "../worker/src/lib/published_agency_entity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

const EVALUATED = readJson("test/fixtures/agency_entity_publication/evaluated_agencies.json");
const PUBLICATION = readJson("worker/src/data/agency_entity_publication.json");
const CROSSWALK = readJson("worker/src/data/agency_crosswalk.json");
const READ_MODEL = readJson("site/data/people_organizations_read_model.json");
const PEOPLE_ENV = { PEOPLE_ORGANIZATIONS_READ_MODEL: READ_MODEL };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const emptyStore = () => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
});

const dossierProvider = (publication = PUBLICATION) =>
  workerD1EntityDossier(emptyStore(), { publication });

const agencyRowIds = new Set(
  READ_MODEL.rows.filter((row) => row.kind === "agency").map((row) => row.id),
);

/** An agency the publication records no officer for, on both read surfaces. */
function agencyWithNoRecordedOfficer() {
  const found = Object.values(PUBLICATION.officers)
    .filter((officer) => officer.status === "not_recorded")
    .map((officer) => officer.entity_id)
    .filter((entityId) => PUBLICATION.agencies[entityId] && agencyRowIds.has(entityId))
    .sort()[0];
  assert.ok(found, "the publication records at least one agency whose sources name no officer");
  return found;
}

async function leadershipFromDossier(entityId, publication = PUBLICATION) {
  const result = await executeEntityDossier(dossierProvider(publication), { entityId });
  assert.equal(result.availability, "available", `${entityId} has a published dossier`);
  return result.dossier.leadership;
}

async function leadershipFromOrganizationRow(entityId) {
  const result = await executePeopleGet(
    workerPeopleOrganizations(PEOPLE_ENV).get,
    { entityId },
  );
  assert.equal(result.availability, "available", `${entityId} has a published organization row`);
  return result.person_or_organization.leadership;
}

test("each evaluated agency answers the leadership question with a person and a title", async () => {
  assert.ok(EVALUATED.agencies.length, "the evaluation runs named at least one organization");
  for (const agency of EVALUATED.agencies) {
    for (const leadership of [
      await leadershipFromDossier(agency.entity_id),
      await leadershipFromOrganizationRow(agency.entity_id),
    ]) {
      assert.ok(leadership, `${agency.name} answers the leadership question`);
      assert.equal(leadership.status, "published");
      assert.match(leadership.question, /leads this agency/i);
      assert.ok(leadership.person.trim().length, `${agency.name} names its officer`);
      assert.ok(leadership.title.trim().length, `${agency.name} names the officer's title`);
      assert.ok(leadership.source.system.trim().length);
      assert.ok(leadership.source.id.trim().length);
      assert.match(leadership.observed_at, ISO_DAY);
    }
  }
});

test("every published officer names its dataset and that dataset's own last-updated date", () => {
  const registered = new Map(PUBLICATION.sources.map((source) => [`${source.system}:${source.id}`, source]));
  for (const officer of Object.values(PUBLICATION.officers)) {
    if (officer.status !== "published") continue;
    const key = `${officer.provenance.source.system}:${officer.provenance.source.id}`;
    const source = registered.get(key);
    assert.ok(source, `${officer.entity_id} cites a dataset this publication registers`);
    assert.equal(
      officer.provenance.observed_at,
      source.observed_on,
      `${officer.entity_id} carries the date ${key} reports its rows were last updated`,
    );
    assert.ok(officer.provenance.source_fields.length, `${officer.entity_id} names the publisher fields`);
  }
});

test("an officer is published only where that agency's own source row names one", () => {
  for (const officer of Object.values(PUBLICATION.officers)) {
    const entry = CROSSWALK.entries[officer.agency_id] || null;
    const publishedName = String(entry?.head_name ?? "").trim();
    if (officer.status === "published") {
      // Read straight off the agency's own row, never off a similar name or a
      // neighbouring agency's record.
      assert.equal(officer.person, publishedName, `${officer.entity_id} names the officer its own source row does`);
      assert.equal(officer.title, String(entry?.head_title ?? "").trim() || null);
    } else {
      assert.equal(publishedName, "", `${officer.entity_id} is only unrecorded when no source row names an officer`);
      assert.equal(officer.person, null);
      assert.equal(officer.title, null);
    }
  }
});

test("an agency whose sources publish no officer says so rather than showing an empty leader", async () => {
  const entityId = agencyWithNoRecordedOfficer();
  for (const leadership of [
    await leadershipFromDossier(entityId),
    await leadershipFromOrganizationRow(entityId),
  ]) {
    assert.ok(leadership, `${entityId} still answers the leadership question`);
    assert.equal(leadership.status, "not_recorded");
    assert.equal(leadership.person, null);
    assert.equal(leadership.title, null);
    assert.ok(leadership.note.trim().length, "the answer says what not recorded means");
    assert.ok(leadership.consulted_sources.length, "the answer names the datasets that were read");
    for (const source of leadership.consulted_sources) {
      assert.ok(source.system.trim().length);
      assert.ok(source.id.trim().length);
      assert.match(source.observed_at, ISO_DAY);
    }
  }
});

test("an officer record that cannot be read is distinguishable from one nobody publishes", async () => {
  const recorded = EVALUATED.agencies[0].entity_id;
  const unrecorded = agencyWithNoRecordedOfficer();
  const damaged = {
    ...PUBLICATION,
    officers: {
      ...PUBLICATION.officers,
      [recorded]: { ...PUBLICATION.officers[recorded], provenance: { source: {}, source_fields: [] } },
    },
  };

  const unreadable = agencyLeadershipAnswer(recorded, damaged);
  assert.equal(unreadable.status, "unreadable");
  assert.equal(unreadable.person, null);
  assert.ok(unreadable.reason.trim().length, "the read failure names itself");
  assert.notEqual(unreadable.status, agencyLeadershipAnswer(unrecorded, damaged).status);

  const served = await leadershipFromDossier(recorded, damaged);
  assert.equal(served.status, "unreadable");
  assert.match(served.note, /could not be read/i);
  assert.doesNotMatch(served.note, /not recorded/i);
});

test("an id outside the published set gets no leadership answer at all", () => {
  assert.equal(readPublishedAgencyOfficer(PUBLICATION, EVALUATED.uncovered_entity_id), null);
  assert.equal(agencyLeadershipAnswer(EVALUATED.uncovered_entity_id, PUBLICATION), null);
});

test("every agency with a published record also carries a leadership answer", () => {
  for (const entityId of Object.keys(PUBLICATION.agencies)) {
    const read = readPublishedAgencyOfficer(PUBLICATION, entityId);
    assert.ok(read, `${entityId} has an officer statement`);
    assert.ok(["published", "not_recorded"].includes(read.status), `${entityId} answers readably`);
  }
  assert.equal(
    PUBLICATION.coverage.officers_published_count + PUBLICATION.coverage.officers_not_recorded_count,
    PUBLICATION.coverage.officer_statement_count,
  );
});
