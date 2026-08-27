import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommunityBoardCommitteeSearchDocuments,
} from "../site/board_search_producer.mjs";
import {
  buildCommunityBoardPersonSearchDocuments,
} from "../site/community_board_people_search_producer.mjs";
import { matchKeywordDocument, resolveKeywordQuery } from "../site/keyword_matcher.mjs";
import { renderUniversalSearchResultHtml } from "../site/universal_search_relevance_ux.mjs";

const boards = {
  by_id: {
    "manhattan-cb-06": { display_name: "Manhattan Community Board 6" },
    "brooklyn-cb-01": { display_name: "Brooklyn Community Board 1" },
  },
};

const registry = {
  committees: [
    {
      board_id: "manhattan-cb-06",
      committee_id: "transportation",
      publisher_name: "Transportation Committee",
      aliases: ["Transportation Committee Meeting"],
      source_url: "https://cbsix.org/meetings-calendar/",
      observed_on: "2026-08-25",
      topic_facets: ["transportation"],
    },
    {
      board_id: "brooklyn-cb-01",
      committee_id: "transportation",
      publisher_name: "Transportation Committee",
      aliases: ["Transportation Committee Meeting"],
      source_url: "https://www.nyc.gov/site/brooklyncb1/calendar/calendar.page",
      observed_on: "2026-08-25",
      topic_facets: ["transportation"],
    },
  ],
};

function sourceDocument(id) {
  return {
    publisher_document_id: id,
    document_url: `https://example.gov/${id}`,
    date: "2026-08-25",
    observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
  };
}

function person(boardId, publisherId, name) {
  return {
    publisher_person_id: publisherId,
    person_name: name,
    board_id: boardId,
    relation: "member_of",
    role: "appointed_member",
    relation_date: "2026-08-25",
    source_document: sourceDocument(`${boardId}-${publisherId}`),
  };
}

test("CB committee SearchDocuments keep same-named committees board-local", () => {
  const corpus = buildCommunityBoardCommitteeSearchDocuments(registry, { boardLookup: boards });
  assert.equal(corpus.coverage.state, "matched");
  assert.deepEqual(corpus.documents.map((document) => document.object_ref), [
    "community-board-committee:brooklyn-cb-01:transportation",
    "community-board-committee:manhattan-cb-06:transportation",
  ]);
  assert.equal(new Set(corpus.documents.map((document) => document.title)).size, 1);
  assert.match(corpus.documents[1].summary, /Manhattan Community Board 6 · Community Board committee/);
  assert.deepEqual(corpus.documents.map((document) => document.provenance.board_id), [
    "brooklyn-cb-01",
    "manhattan-cb-06",
  ]);
});

test("transportation community board 6 reaches the exact Manhattan CB6 committee", () => {
  const corpus = buildCommunityBoardCommitteeSearchDocuments(registry, { boardLookup: boards });
  const query = resolveKeywordQuery("transportation community board 6");
  const matches = corpus.documents.filter((document) => matchKeywordDocument(document, query));
  assert.deepEqual(matches.map((document) => document.object_ref), [
    "community-board-committee:manhattan-cb-06:transportation",
  ]);
});

test("CB people remain distinct from same-name Council identities and expose role plus board", () => {
  const people = {
    schema: "cityscroll.community_board_people.v1",
    observed_on: "2026-08-25",
    boards: {
      "manhattan-cb-06": { relationships: [person("manhattan-cb-06", "jane-doe", "Jane Doe")] },
      "brooklyn-cb-01": { relationships: [person("brooklyn-cb-01", "jane-doe", "Jane Doe")] },
    },
  };
  const corpus = buildCommunityBoardPersonSearchDocuments(people, { boardLookup: boards });
  assert.deepEqual(corpus.documents.map((document) => document.object_ref), [
    "community-board-person:brooklyn-cb-01:jane-doe",
    "community-board-person:manhattan-cb-06:jane-doe",
  ]);
  const result = corpus.documents.find((document) => document.object_ref.endsWith("manhattan-cb-06:jane-doe"));
  assert.match(result.summary, /Board member · Manhattan Community Board 6/);
  assert.doesNotMatch(result.canonical_href, /officials/);
  const html = renderUniversalSearchResultHtml({
    ...result,
    result_schema: "cityscroll.universal_search_result.v1",
    entity_type: result.object_type,
    lens: "people",
    match_fields: [{
      field: "title",
      matched_term: "jane doe",
      source_observation_ref: result.source_observation_refs[0],
    }],
  });
  assert.match(html, /Board member · Manhattan Community Board 6/);
  assert.doesNotMatch(html, /Official profile|\/officials\//);
});

test("Council and CB committee results have visibly different institution labels", () => {
  const cb = buildCommunityBoardCommitteeSearchDocuments(registry, { boardLookup: boards }).documents
    .find((document) => document.object_ref.includes("manhattan-cb-06"));
  const council = {
    schema: "cityscroll.search_document.v1",
    object_ref: "committee:17",
    object_type: "committee",
    domain: "meetings",
    canonical_href: "/committees/17/",
    title: "Transportation Committee",
    summary: "New York City Council · City Council committee · elected legislative body.",
    search_text: "Transportation Committee New York City Council",
    source_family: "nyc_legistar_committee_graph",
    source_observation_refs: ["nyc_legistar_office_records:17"],
    classification: { method: "test", basis: "test" },
    provenance: { producer: "committee_search_document.v1" },
    outcome: "indexed",
  };
  const cbHtml = renderUniversalSearchResultHtml({
    ...cb,
    entity_type: cb.object_type,
    lens: "people",
    match_fields: [{ field: "title", matched_term: "transportation", source_observation_ref: cb.source_observation_refs[0] }],
  });
  const councilHtml = renderUniversalSearchResultHtml({
    ...council,
    entity_type: council.object_type,
    lens: "committees",
    match_fields: [{ field: "title", matched_term: "transportation", source_observation_ref: council.source_observation_refs[0] }],
  });
  assert.match(cbHtml, /Manhattan Community Board 6 · Community Board committee/);
  assert.match(councilHtml, /New York City Council · City Council committee/);
  assert.notEqual(cb.summary, council.summary);
});
