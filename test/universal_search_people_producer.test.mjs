import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeopleSearchDocuments,
  materializePeopleSearchDocument,
  peopleSearchMatchFields,
  projectPeopleSearchObject,
  rankPeopleSearchDocuments,
} from "../site/people_search_producer.mjs";
import { SEARCH_DOCUMENT_SCHEMA } from "../site/search_document_contract.mjs";

const AS_OF = "2026-08-11T19:21:19.284Z";

function person(overrides = {}) {
  return {
    person_id: "7801",
    official_id: "official:7801",
    person_name: "Christopher Marte",
    names: ["Christopher Marte"],
    name_keys: ["CHRISTOPHER MARTE", "CHRIS MARTE"],
    district: "1",
    terms: [{
      term_start: "2026-01-01",
      term_end: "2029-12-31",
      office_id: "5827",
      district: "1",
      name: "Christopher Marte",
    }],
    current_term: {
      term_start: "2026-01-01",
      term_end: "2029-12-31",
      office_id: "5827",
      district: "1",
      name: "Christopher Marte",
    },
    ...overrides,
  };
}

function lookup(rows = [person()], overrides = {}) {
  return {
    schema_version: 1,
    source_contract: "uvw5-9znb",
    retrieved_at: AS_OF,
    gate: { promoted: true },
    provenance: {
      method: "exact_council_member_id_person_hub_v1",
      weak_joins_rendered: false,
      source_null_policy: "preserve_null",
    },
    by_person_id: Object.fromEntries(rows.map((row, index) => [row.person_id || `bad-${index}`, row])),
    ...overrides,
  };
}

test("a canonical person becomes an admitted SearchDocument with route and provenance", () => {
  const document = materializePeopleSearchDocument(person(), {
    sourceContract: "uvw5-9znb",
    retrievedAt: AS_OF,
    sourceProvenance: lookup().provenance,
    sourcePromoted: true,
  });

  assert.equal(document.schema, SEARCH_DOCUMENT_SCHEMA);
  assert.equal(document.outcome, "indexed");
  assert.equal(document.object_ref, "person:7801");
  assert.equal(document.object_type, "person");
  assert.equal(document.domain, "people");
  assert.equal(document.canonical_href, "/officials/7801/");
  assert.deepEqual(document.source_observation_refs, [
    "nyc_council_members:council-member:7801:2026-01-01",
  ]);
  assert.equal(document.classification.method, "exact_person_hub_projection");
  assert.match(document.classification.basis, /council_member_id=Legistar PersonId/);
  assert.equal(document.provenance.producer, "people_search_document.v1");
  assert.equal(document.provenance.source_contract, "uvw5-9znb");
  assert.equal(document.provenance.lifecycle.state, "active");
  assert.deepEqual(document.provenance.search_text_fields, [
    "display_name",
    "aliases",
    "role_labels",
    "agency_labels",
    "district_labels",
  ]);
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.classification));
});

test("only declared people fields enter search text", () => {
  const row = person({
    role_labels: ["Council member"],
    agency_labels: ["New York City Council"],
    opaque_payload: { secret_rank_hint: "should-not-be-indexed" },
  });
  const fields = peopleSearchMatchFields(row);
  const document = materializePeopleSearchDocument(row, {
    sourceContract: "uvw5-9znb",
    retrievedAt: AS_OF,
    sourcePromoted: true,
  });

  assert.deepEqual(fields, {
    display_name: "Christopher Marte",
    aliases: ["CHRIS MARTE"],
    role_labels: ["Council member"],
    agency_labels: ["New York City Council"],
    district_labels: ["Council District 1"],
  });
  assert.match(document.search_text, /Christopher Marte Chris Marte Council member/i);
  assert.doesNotMatch(document.search_text, /secret_rank_hint|should-not-be-indexed/);
  assert.doesNotMatch(document.search_text, /5827/);
});

test("unknown or unresolved person rows fail closed", () => {
  const cases = [
    person({ person_id: "unknown", official_id: "official:unknown" }),
    person({ official_id: "official:9999" }),
    person({ terms: [], current_term: null }),
  ];

  for (const row of cases) {
    const projection = projectPeopleSearchObject(row, {
      sourceContract: "uvw5-9znb",
      sourcePromoted: true,
    });
    assert.ok(["unclassified", "not_indexed"].includes(projection.outcome));
    assert.equal(projection.object, null);
    assert.equal(materializePeopleSearchDocument(row, {
      sourceContract: "uvw5-9znb",
      retrievedAt: AS_OF,
      sourcePromoted: true,
    }), null);
  }
});

test("producer coverage distinguishes matched, empty, partial, and not_indexed", () => {
  const matched = buildPeopleSearchDocuments(lookup());
  assert.equal(matched.coverage.state, "matched");
  assert.equal(matched.coverage.indexed_count, 1);
  assert.equal(matched.documents.length, 1);

  const empty = buildPeopleSearchDocuments(lookup([]));
  assert.equal(empty.coverage.state, "empty");
  assert.equal(empty.coverage.reason, "available_person_hub_has_no_people");

  const partial = buildPeopleSearchDocuments(lookup([
    person(),
    person({ person_id: "bad", official_id: "official:bad" }),
  ]));
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.coverage.indexed_count, 1);
  assert.equal(partial.coverage.rejected_count, 1);

  const held = buildPeopleSearchDocuments(lookup([person()], { gate: { promoted: false } }));
  assert.equal(held.coverage.state, "not_indexed");
  assert.equal(held.coverage.reason, "person_hub_publication_gate_not_promoted");
  assert.deepEqual(held.documents, []);
  assert.notEqual(held.coverage.reason, "No matches");
});

test("exact name and alias queries rank only admitted immutable documents", () => {
  const farah = person({
    person_id: "7785",
    official_id: "official:7785",
    person_name: "Farah N. Louis",
    names: ["Farah N. Louis"],
    name_keys: ["FARAH N LOUIS", "FARAH LOUIS"],
    district: "45",
    terms: [{
      term_start: "2026-01-01",
      term_end: "2029-12-31",
      office_id: "5825",
      district: "45",
      name: "Farah N. Louis",
    }],
  });
  const corpus = buildPeopleSearchDocuments(lookup([person(), farah])).documents;

  assert.deepEqual(
    rankPeopleSearchDocuments(corpus, "Christopher Marte").map((row) => row.object_ref),
    ["person:7801"],
  );
  assert.deepEqual(
    rankPeopleSearchDocuments(corpus, "Chris Marte").map((row) => row.object_ref),
    ["person:7801"],
  );
  const ranked = rankPeopleSearchDocuments(corpus, "Council District");
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((row) => Object.isFrozen(row.classification)));
  assert.ok(ranked.every((row) => row.object_type === "person"));
});

test("rebuilding the people corpus is deterministic and does not mutate the read model", () => {
  const source = lookup([person(), person({
    person_id: "7785",
    official_id: "official:7785",
    person_name: "Farah N. Louis",
    names: ["Farah N. Louis"],
  })]);
  const before = structuredClone(source);
  const first = buildPeopleSearchDocuments(source);
  const second = buildPeopleSearchDocuments(source);

  assert.deepEqual(first, second);
  assert.deepEqual(source, before);
  assert.deepEqual(first.documents.map((row) => row.object_ref), ["person:7785", "person:7801"]);
});
