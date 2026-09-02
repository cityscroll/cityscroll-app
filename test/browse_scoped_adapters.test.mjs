import assert from "node:assert/strict";
import test from "node:test";

import {
  FEDERATED_SEARCH_LENS_IDS,
  FEDERATED_SEARCH_PRESENTATION_SCOPES,
} from "../capabilities/federated_search.mjs";
import { federateUniversalSearch } from "../site/universal_search_federator.mjs";
import {
  BROWSE_SCOPED_ADAPTERS,
  BROWSE_SCOPED_IDLE,
  browseScopedOutcome,
  browseScopedRequest,
  fetchBrowseScoped,
  projectBrowseScopedRows,
} from "../site/browse_scoped_adapters.mjs";

const SOURCE_IDS = ["people", "property", "land", "rules", "meetings", "exams"];

function documentFor(source, index = 1) {
  const shapes = {
    people: ["person:123", "person", "people", "/officials/123/", "person"],
    property: ["bbl:1000000001", "parcel", "property", "/parcels/1000000001/", "parcel"],
    land: ["land_use_project:2024Q0001", "land_use_project", "zoning", "/browse/zoning/#land/2024Q0001", "land"],
    rules: ["rulemaking:notice:202600001", "rulemaking", "rules", "/browse/rules/?q=202600001", "rulemaking"],
    meetings: ["meeting:2026-001", "meeting", "meetings", "/meetings/2026-001/", "meeting"],
    exams: ["exam:7016", "civil_service_exam", "staffing", "/exams/7016/", "exam"],
  };
  const [objectRef, objectType, domain, canonicalHref, refPrefix] = shapes[source];
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: index === 1 ? objectRef : `${objectRef}-${index}`,
    object_type: objectType,
    domain,
    canonical_href: canonicalHref,
    title: `${source} fixture ${index}`,
    summary: `A representative ${source} fixture.`,
    search_text: `${source} fixture parks ${index}`,
    source_family: `${source}_fixture`,
    source_observation_refs: [`${refPrefix}:fixture-${index}`],
    classification: { method: "fixture", basis: "registered source adapter fixture" },
    provenance: { producer: `${source}_fixture_producer`, lifecycle: { state: "current" } },
  };
}

async function envelopeFor(source, documents, state = "matched") {
  const scope = FEDERATED_SEARCH_PRESENTATION_SCOPES[source];
  const providers = Object.fromEntries(scope.lenses.map((lens) => [lens, {
    search: async () => ({
      candidates: state === "empty" ? [] : documents.map((document, index) => ({
        document,
        local_score: index + 1,
        match_fields: [{
          field: "title",
          matched_term: "parks",
          source_observation_ref: document.source_observation_refs[0],
        }],
      })),
      coverage: {
        state,
        indexed_count: 1,
        as_of: "2026-09-02",
        source: `${source} fixture source`,
        method: "fixture substring index",
      },
    }),
  }]));
  return federateUniversalSearch({
    query: "parks",
    limit: 40,
    lenses: providers,
    scope: { lenses: scope.lenses },
  });
}

test("every US-20 source has one registered allowlisted scope and bounded request", () => {
  for (const source of SOURCE_IDS) {
    const scope = BROWSE_SCOPED_ADAPTERS[source];
    assert.deepEqual(
      Object.fromEntries(Object.entries(scope).filter(([key]) => key !== "filter_contract")),
      FEDERATED_SEARCH_PRESENTATION_SCOPES[source],
    );
    const request = browseScopedRequest(source, "  parks   ");
    assert.equal(request.capability_reference, "search.federated@1");
    assert.deepEqual([...request.lenses], [...scope.lenses]);
    const orderedLenses = FEDERATED_SEARCH_LENS_IDS.filter((lens) => request.lenses.includes(lens));
    assert.equal(request.path, `/search?q=parks${orderedLenses.map((lens) => `&scope=${lens}`).join("")}`);
    assert.ok(request.result_bound <= 100);
    assert.deepEqual(request.filter_contract.keyword, "federated");
  }
  assert.deepEqual(FEDERATED_SEARCH_LENS_IDS, [
    "notices", "people", "agencies", "vendors", "committees", "community_boards",
    "exams", "parcels", "land", "meetings",
  ]);
});

test("source-specific outcomes retain canonical references, evidence, provenance, freshness, rank, bounds, and coverage", async () => {
  for (const source of SOURCE_IDS) {
    const document = documentFor(source);
    const envelope = await envelopeFor(source, [document]);
    const outcome = browseScopedOutcome(source, envelope, browseScopedRequest(source, "parks"));
    assert.equal(outcome.outcome, "matched", source);
    assert.equal(outcome.documents[0].object_ref, document.object_ref);
    assert.equal(outcome.documents[0].canonical_href, document.canonical_href);
    assert.deepEqual(outcome.documents[0].source_observation_refs, document.source_observation_refs);
    assert.equal(outcome.documents[0].provenance.producer, document.provenance.producer);
    assert.equal(outcome.documents[0].rank, 1);
    assert.equal(outcome.as_of, "2026-09-02");
    assert.equal(outcome.bounds.returned, 1);
    assert.equal(outcome.lens_coverage.length, FEDERATED_SEARCH_PRESENTATION_SCOPES[source].lenses.length);
    assert.ok(outcome.lens_coverage.every((row) => row.state === "matched"));
  }
});

test("empty and provider failure remain different from one another", async () => {
  const emptyEnvelope = await envelopeFor("land", [], "empty");
  const empty = browseScopedOutcome("land", emptyEnvelope, browseScopedRequest("land", "nothing")).outcome;
  assert.equal(empty, "empty");

  const unavailable = await fetchBrowseScoped("land", "nothing", {
    fetcher: async () => { throw new Error("HTTP 503"); },
  });
  assert.equal(unavailable.outcome, "unavailable");
  assert.equal(unavailable.coverage_state, "provider_unavailable");
  assert.equal(unavailable.documents.length, 0);
  assert.notEqual(unavailable.outcome, empty);
});

test("stale and partial coverage remain visible while candidates retain their bound", async () => {
  const staleEnvelope = await envelopeFor("rules", [documentFor("rules")], "stale");
  const outcome = browseScopedOutcome("rules", staleEnvelope, browseScopedRequest("rules", "parks"));
  assert.equal(outcome.outcome, "partial");
  assert.equal(outcome.coverage_state, "stale");
  assert.equal(outcome.as_of_by_lens.notices, "2026-09-02");
  assert.equal(outcome.bounds.maximum, 100);
  const projected = projectBrowseScopedRows(outcome, [{ request_id: "202600001" }], (row) => `rulemaking:notice:${row.request_id}`);
  assert.equal(projected.rows[0]._scoped_search.object_ref, "rulemaking:notice:202600001");
});

test("typed filters and local analytical joins stay in the projection layer", async () => {
  const document = documentFor("meetings");
  const envelope = await envelopeFor("meetings", [document]);
  const outcome = browseScopedOutcome("meetings", envelope, browseScopedRequest("meetings", "parks"));
  const local = [{ meeting_id: "meeting:2026-001", title: "Local meeting", affected_area: { scope: "Brooklyn" } }];
  const projected = projectBrowseScopedRows(outcome, local, (row) => row.meeting_id);
  assert.equal(projected.rows.length, 1);
  assert.equal(projected.rows[0]._scoped_search.object_ref, document.object_ref);
  assert.ok(["meetings", "committees"].includes(projected.rows[0]._scoped_search.evidence.matches[0].lens));
  assert.equal(projected.rows[0].affected_area.scope, "Brooklyn");
  assert.ok(BROWSE_SCOPED_ADAPTERS.meetings.filter_contract.local.includes("analytical_join"));
  assert.ok(BROWSE_SCOPED_ADAPTERS.meetings.filter_contract.unsupported.includes("affected_area_semantics"));
});

test("queryless Browse has an explicit idle outcome and makes no capability request", async () => {
  const idle = await fetchBrowseScoped("exams", "   ", {
    fetcher: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(idle, BROWSE_SCOPED_IDLE);
  assert.equal(idle.outcome, "idle");
});

test("projection preserves official handoffs and multi-parcel local rows", async () => {
  const [personEnvelope, propertyEnvelope] = await Promise.all([
    envelopeFor("people", [documentFor("people")]),
    envelopeFor("property", [documentFor("property")]),
  ]);
  const personOutcome = browseScopedOutcome("people", personEnvelope, browseScopedRequest("people", "parks"));
  const propertyOutcome = browseScopedOutcome("property", propertyEnvelope, browseScopedRequest("property", "parks"));
  const person = projectBrowseScopedRows(
    personOutcome,
    [{ id: "official:123", kind: "official", title: "Official fixture" }],
    (row) => `person:${String(row.id).split(":")[1]}`,
  );
  const property = projectBrowseScopedRows(
    propertyOutcome,
    [{ id: "sale-1", property_location: { bbls: ["1000000001", "1000000002"] }, analytical_join: { district: "01" } }],
    (row) => row.property_location.bbls.map((bbl) => `bbl:${bbl}`),
  );
  assert.equal(person.rows[0].id, "official:123");
  assert.equal(person.rows[0]._scoped_search.object_ref, "person:123");
  assert.equal(property.rows[0].id, "sale-1");
  assert.deepEqual(property.rows[0].analytical_join, { district: "01" });
});
