// The four read surfaces a reader uses to ask what the public record holds
// about a city organization, asked about the organizations that live evaluation
// runs of the deployed research service actually named.
//
// The organizations are read from a fixture derived from those runs rather than
// retyped here, so a change to the evaluation set moves this test with it
// instead of quietly leaving it behind.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeEntityDossier } from "../capabilities/entity_dossier.mjs";
import { executeEntityRelationships } from "../capabilities/entity_relationships.mjs";
import {
  executeOrganizationsBrowse,
  executePeopleGet,
} from "../capabilities/people_organizations.mjs";
import { workerD1EntityDossier } from "../worker/src/entity_dossier.mjs";
import { workerPeopleOrganizations } from "../worker/src/people_organizations.mjs";
import { workerD1EntityRelationships } from "../worker/src/public_relationship_graph.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));

const EVALUATED = readJson("test/fixtures/agency_entity_publication/evaluated_agencies.json");
const PUBLICATION = readJson("worker/src/data/agency_entity_publication.json");
const READ_MODEL = readJson("site/data/people_organizations_read_model.json");
const PEOPLE_ENV = { PEOPLE_ORGANIZATIONS_READ_MODEL: READ_MODEL };

// A store that holds no matching entity: the deployed shape for an id the
// entity-resolution read model has never published.
const emptyStore = () => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
});

const dossierProvider = (publication = PUBLICATION) =>
  workerD1EntityDossier(emptyStore(), { publication });
const graphProvider = (publication = PUBLICATION) =>
  workerD1EntityRelationships(emptyStore(), { publication });

function assertNamedAgencies() {
  assert.ok(EVALUATED.agencies.length > 0, "the evaluation runs named at least one organization");
}

test("the evaluated organizations have a published entity dossier", async () => {
  assertNamedAgencies();
  for (const agency of EVALUATED.agencies) {
    const result = await executeEntityDossier(dossierProvider(), { entityId: agency.entity_id });
    assert.equal(result.availability, "available", `${agency.name} dossier availability`);
    assert.equal(result.dossier.entity.id, agency.entity_id);
    assert.equal(result.dossier.entity.name, agency.name);
    // A published answer, not an empty record dressed as one.
    assert.ok(result.dossier.linked_records.length > 0, `${agency.name} has linked source records`);
    const observed = result.dossier.assertions.filter((group) => group.status !== "not_observed");
    assert.ok(observed.length > 0, `${agency.name} publishes at least one observed fact`);
  }
});

test("every published dossier field carries its source and observation date", async () => {
  assertNamedAgencies();
  for (const agency of EVALUATED.agencies) {
    const result = await executeEntityDossier(dossierProvider(), { entityId: agency.entity_id });
    const groups = result.dossier.assertions.filter((group) => group.status !== "not_observed");
    for (const group of groups) {
      assert.ok(group.assertions.length > 0, `${group.fact} has at least one assertion`);
      for (const assertion of group.assertions) {
        assert.equal(assertion.classification, "source_assertion");
        assert.ok(assertion.provenance.source.system, `${group.fact} names a source system`);
        assert.ok(assertion.provenance.source.id, `${group.fact} names a source record`);
        assert.ok(assertion.provenance.source_field, `${group.fact} names the publisher field`);
        assert.match(
          assertion.provenance.observed_at,
          /^\d{4}-\d{2}-\d{2}/,
          `${group.fact} carries the date its source was observed`,
        );
      }
    }
    for (const record of result.dossier.linked_records) {
      assert.ok(record.source.system && record.source.id);
      assert.match(record.observed_at, /^\d{4}-\d{2}-\d{2}/);
    }
    // A fact the sources do not carry stays absent rather than being filled in.
    for (const group of result.dossier.assertions.filter((entry) => entry.status === "not_observed")) {
      assert.deepEqual(group.assertions, []);
      assert.ok(group.missingness);
    }
  }
});

test("the evaluated organizations have a published relationship graph", async () => {
  assertNamedAgencies();
  for (const agency of EVALUATED.agencies) {
    const result = await executeEntityRelationships(graphProvider(), { entityId: agency.entity_id });
    assert.equal(result.availability, "available", `${agency.name} relationship availability`);
    assert.equal(result.graph.root.id, agency.entity_id);
    assert.ok(result.graph.edges.length > 0, `${agency.name} publishes at least one relationship`);
    for (const edge of result.graph.edges) {
      assert.ok(edge.provenance.source.system && edge.provenance.source.id);
      assert.match(edge.provenance.observed_at, /^\d{4}-\d{2}-\d{2}/);
    }
  }
});

test("the evaluated organizations answer the organizations browse and the exact get", async () => {
  assertNamedAgencies();
  const provider = workerPeopleOrganizations(PEOPLE_ENV);
  for (const agency of EVALUATED.agencies) {
    const browse = await executeOrganizationsBrowse(provider.browse, {
      query: agency.name,
      kind: "agency",
    });
    assert.equal(browse.availability, "complete", `${agency.name} browse availability`);
    assert.ok(
      browse.results.some((row) => row.id === agency.entity_id),
      `${agency.name} appears in its own browse results`,
    );

    const got = await executePeopleGet(provider.get, { entityId: agency.entity_id });
    assert.equal(got.availability, "available", `${agency.name} exact get availability`);
    assert.equal(got.person_or_organization.id, agency.entity_id);
    assert.equal(got.person_or_organization.label, agency.name);
  }
});

test("an organization outside the published set answers with its own honest absence", async () => {
  const uncovered = EVALUATED.uncovered_entity_id;

  const dossier = await executeEntityDossier(dossierProvider(), { entityId: uncovered });
  assert.equal(dossier.availability, "not_yet_public");
  assert.equal(dossier.error, "not-found");
  assert.equal(dossier.dossier, null, "absence is not rendered as an empty dossier");

  const graph = await executeEntityRelationships(graphProvider(), { entityId: uncovered });
  assert.equal(graph.availability, "not_yet_public");
  assert.equal(graph.graph, null, "absence is not rendered as an empty graph");

  const provider = workerPeopleOrganizations(PEOPLE_ENV);
  const got = await executePeopleGet(provider.get, { entityId: uncovered });
  assert.equal(got.availability, "not_yet_public");
  assert.equal(got.person_or_organization, null);

  const browse = await executeOrganizationsBrowse(provider.browse, { query: uncovered, kind: "agency" });
  assert.equal(browse.availability, "empty");
  // The empty page reports the coverage it read, rather than standing as a bare zero.
  assert.match(browse.coverage.absence, /reports that model's coverage/);
  assert.equal(browse.coverage.state, "published");
});

test("an organization whose published record cannot be read says so, distinguishably", async () => {
  const [agency] = EVALUATED.agencies;
  const damaged = {
    ...PUBLICATION,
    agencies: {
      ...PUBLICATION.agencies,
      [agency.entity_id]: { ...PUBLICATION.agencies[agency.entity_id], dossier_rows: [] },
    },
  };

  const dossier = await executeEntityDossier(
    dossierProvider(damaged),
    { entityId: agency.entity_id },
  );
  assert.equal(dossier.availability, "unavailable");
  assert.equal(dossier.error, "record-unreadable");
  assert.equal(dossier.dossier, null, "an unreadable record is not an empty dossier");

  const graph = await executeEntityRelationships(
    graphProvider(damaged),
    { entityId: agency.entity_id },
  );
  assert.equal(graph.availability, "unavailable");
  assert.equal(graph.error, "record-unreadable");
  assert.equal(graph.graph, null);

  // The unreadable answer and the outside-the-set answer are different answers.
  const absent = await executeEntityDossier(dossierProvider(), {
    entityId: EVALUATED.uncovered_entity_id,
  });
  assert.notEqual(dossier.availability, absent.availability);
  assert.notEqual(dossier.error, absent.error);

  const unreadableModel = workerPeopleOrganizations({
    PEOPLE_ORGANIZATIONS_READ_MODEL: { schema: "cityscroll.people_organizations_read_model.unknown", rows: [] },
  });
  const got = await executePeopleGet(unreadableModel.get, { entityId: agency.entity_id });
  assert.equal(got.availability, "unavailable");
  const browse = await executeOrganizationsBrowse(unreadableModel.browse, { kind: "agency" });
  assert.equal(browse.availability, "unavailable");
  assert.equal(browse.total_matches, null, "an unreadable browse is not a zero");
});

test("the published entity records are a retained materialization with sourced coverage", () => {
  assert.equal(PUBLICATION.schema, "cityscroll.agency_entity_publication.v1");
  assert.ok(PUBLICATION.coverage.published_agency_count > 0);
  assert.ok(PUBLICATION.coverage.absence_note);
  for (const source of PUBLICATION.sources) {
    assert.ok(source.system && source.id, "each source names itself");
    assert.match(source.observed_on, /^\d{4}-\d{2}-\d{2}$/, `${source.id} carries an observation date`);
  }
  for (const agency of EVALUATED.agencies) {
    assert.ok(PUBLICATION.agencies[agency.entity_id], `${agency.name} is in the published set`);
  }
});
