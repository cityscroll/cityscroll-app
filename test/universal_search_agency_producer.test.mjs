import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildAgencySearchDocuments,
  projectAgencySearchDocument,
} from "../site/agency_search_producer.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  admitSearchDocument,
} from "../site/search_document_contract.mjs";

const PARKS = Object.freeze({
  subject_ref: "agency:id:parks-and-recreation",
  display_name: "Department of Parks and Recreation",
  path: "/agencies/parks-and-recreation/",
  matched_categories: 2,
  categories: {
    contracts: { status: "matched", count: 2, method: "agency_browse_snapshot_v1" },
    meetings: { status: "empty", count: 0, method: "agency_browse_snapshot_v1" },
    rules: { status: "matched", count: 4, method: "agency_canonical_v1" },
  },
  edge_summary: [
    { state: "matched", label: "Contracts: published by this agency", relation_label: "published by this agency" },
    { state: "unknown", label: "Meetings: coverage unavailable", relation_label: "related meetings" },
  ],
});

const LOOKUP = Object.freeze({
  schema: "cityscroll.agency_constellation.v1",
  method: "agency_constellation_v1",
  er_match_basis: "agency_canonical_v1+publisher_certification_record_v1",
  generated_at: "2026-08-15T12:00:00Z",
  aliases: { "department-of-parks-and-recreation": "parks-and-recreation" },
  by_id: { "parks-and-recreation": PARKS },
  provenance: {
    intelligence_generated_at: "2026-08-15T10:00:00Z",
    certification_generated_at: "2026-08-14T10:00:00Z",
  },
});

test("agency read-model rows produce admitted canonical SearchDocuments", () => {
  const result = projectAgencySearchDocument("parks-and-recreation", PARKS, { lookup: LOOKUP });

  assert.equal(result.outcome, "indexed");
  assert.equal(result.reason, "canonical_agency_identity");
  assert.equal(result.document.schema, SEARCH_DOCUMENT_SCHEMA);
  assert.equal(result.document.object_ref, "agency:id:parks-and-recreation");
  assert.equal(result.document.object_type, "agency");
  assert.equal(result.document.domain, "people");
  assert.equal(result.document.canonical_href, "/agencies/parks-and-recreation/");
  assert.equal(result.document.title, "Department of Parks and Recreation");
  assert.deepEqual(result.document.source_observation_refs, [
    "agency_constellation:parks-and-recreation",
  ]);
  assert.equal(result.document.classification.method, "canonical_agency_read_model");
  assert.match(result.document.classification.basis, /agency_canonical_v1/);
  assert.equal(result.document.provenance.producer, "agency_search_document.v1");
  assert.equal(result.document.provenance.read_model_generated_at, LOOKUP.generated_at);
  assert.deepEqual(result.document.provenance.source_freshness, LOOKUP.provenance);
  assert.ok(Object.isFrozen(result.document.classification));
  assert.ok(Object.isFrozen(result.document.provenance));
});

test("agency aliases, identifiers, and matched constellation labels are searchable", () => {
  const { document } = projectAgencySearchDocument("parks-and-recreation", PARKS, { lookup: LOOKUP });

  assert.match(document.search_text, /Parks and Recreation/);
  assert.match(document.search_text, /DEPT OF PARKS & RECREATION/);
  assert.match(document.search_text, /department-of-parks-and-recreation/);
  assert.match(document.search_text, /agency:id:parks-and-recreation/);
  assert.match(document.search_text, /Contracts: published by this agency/);
  assert.doesNotMatch(document.search_text, /Meetings: coverage unavailable/);
  assert.deepEqual(document.provenance.constellation_relations, [
    { state: "matched", label: "Contracts: published by this agency" },
    { state: "unknown", label: "Meetings: coverage unavailable" },
  ]);
});

test("unresolved and malformed agency entries fail closed", () => {
  const unresolved = projectAgencySearchDocument("board-meetings", {
    ...PARKS,
    subject_ref: "agency:id:board-meetings",
    display_name: "Board Meetings",
    path: "/agencies/board-meetings/",
  }, {
    lookup: LOOKUP,
    identity: { classification: "unresolved", basis: "generic label" },
  });
  assert.equal(unresolved.outcome, "unclassified");
  assert.equal(unresolved.document, null);
  assert.equal(unresolved.reason, "unresolved_agency_identity");

  const malformed = projectAgencySearchDocument("parks-and-recreation", {
    ...PARKS,
    subject_ref: "agency:id:another-agency",
  }, { lookup: LOOKUP });
  assert.equal(malformed.outcome, "not_indexed");
  assert.equal(malformed.document, null);
  assert.equal(malformed.reason, "inconsistent_agency_identity");
});

test("only the registered agency object type is admitted for agency results", () => {
  const { document } = projectAgencySearchDocument("parks-and-recreation", PARKS, { lookup: LOOKUP });
  assert.equal(admitSearchDocument(document, { outcome: "indexed" }).outcome, "indexed");
  assert.equal(admitSearchDocument({ ...document, object_type: "city_agency" }, {
    outcome: "indexed",
  }).outcome, "unclassified");
});

test("producer coverage distinguishes matched, partial, empty, and not_indexed", () => {
  const matched = buildAgencySearchDocuments(LOOKUP);
  assert.equal(matched.coverage.state, "matched");
  assert.equal(matched.coverage.indexed_count, 1);
  assert.equal(matched.documents.length, 1);

  const partial = buildAgencySearchDocuments({
    ...LOOKUP,
    by_id: {
      ...LOOKUP.by_id,
      "board-meetings": {
        ...PARKS,
        subject_ref: "agency:id:board-meetings",
        display_name: "Board Meetings",
        path: "/agencies/board-meetings/",
      },
    },
  }, {
    identityReport: {
      cases: [{
        source_id: "board-meetings",
        canonical_id: "board-meetings",
        classification: "unresolved",
        basis: "generic publisher label",
      }],
    },
  });
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.coverage.indexed_count, 1);
  assert.equal(partial.coverage.not_indexed_count, 1);
  assert.notEqual(partial.coverage.reason, "No matches");

  const empty = buildAgencySearchDocuments({ ...LOOKUP, by_id: {} });
  assert.equal(empty.coverage.state, "empty");
  assert.equal(empty.coverage.reason, "agency_read_model_has_no_entries");

  const unavailable = buildAgencySearchDocuments({ ...LOOKUP, schema: "unknown" });
  assert.equal(unavailable.coverage.state, "not_indexed");
  assert.equal(unavailable.coverage.reason, "unsupported_agency_read_model");
});

test("the committed read model indexes canonical agencies and excludes reviewed unresolved labels", () => {
  const lookup = JSON.parse(readFileSync(
    new URL("../site/data/agency_constellation_lookup.json", import.meta.url),
    "utf8",
  ));
  const identityReport = JSON.parse(readFileSync(
    new URL("../site/data/agency_route_identity_report.json", import.meta.url),
    "utf8",
  ));
  const result = buildAgencySearchDocuments(lookup, { identityReport });

  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.total_count, lookup.agency_count);
  assert.equal(result.coverage.indexed_count, lookup.agency_count - 1);
  assert.ok(result.documents.some((document) => (
    document.object_ref === "agency:id:parks-and-recreation"
  )));
  assert.ok(!result.documents.some((document) => (
    document.object_ref === "agency:id:board-meetings"
  )));
  assert.deepEqual(
    result.outcomes.find((outcome) => outcome.agency_id === "board-meetings"),
    {
      agency_id: "board-meetings",
      outcome: "unclassified",
      document: null,
      reason: "unresolved_agency_identity",
      errors: ["identity"],
    },
  );
});
