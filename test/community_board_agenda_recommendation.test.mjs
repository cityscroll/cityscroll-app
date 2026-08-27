import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import registry from "../ontology/registry.v0.json" with { type: "json" };
import {
  COMMUNITY_BOARD_AGENDA_RECOMMENDATION_CONTRACT,
  buildCommunityBoardAgendaRecommendationGraph,
  projectCommunityBoardAgendaItem,
  projectCommunityBoardRecommendation,
} from "../site/community_board_agenda_recommendation.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/community_board_agenda_recommendation/cb6-2007-117-07-bz.json", import.meta.url), "utf8"));

test("registry declares source-qualified agenda and recommendation objects without materializing them", () => {
  const objects = new Map(registry.object_types.map((entry) => [entry.id, entry]));
  for (const id of ["agenda_item", "recommendation"]) {
    assert.equal(objects.get(id)?.status, "unregistered");
    assert.equal(objects.get(id)?.identity_contract?.source_qualified, true);
    assert.equal(objects.get(id)?.identity_contract?.similar_text_never_identity, true);
  }
  assert.equal(objects.get("agenda_item")?.identity_contract?.raw_text_preserved_when_matter_unknown, true);
  assert.equal(objects.get("recommendation")?.identity_contract?.explicit_statement_required, true);
  assert.equal(objects.get("recommendation")?.identity_contract?.discussion_is_not_recommendation, true);
  assert.equal(COMMUNITY_BOARD_AGENDA_RECOMMENDATION_CONTRACT.materialization, "declaration_only");
});

test("registry declares the agenda, matter, committee, recommendation, board-action, and destination edges", () => {
  const links = new Map(registry.link_types.map((entry) => [entry.id, entry]));
  const expected = {
    has_agenda_item: ["meeting", "agenda_item"],
    concerns: ["agenda_item|recommendation", "matter|project|application|place"],
    considers: ["community-board-committee", "matter"],
    issues_recommendation: ["community-board", "recommendation"],
    recommends: ["community-board-committee", "recommendation"],
    adopts: ["community-board", "recommendation"],
    rejects: ["community-board", "recommendation"],
    modifies: ["community-board", "recommendation"],
    addressed_to: ["recommendation", "agency|cpc|sla|council"],
    next_procedural_body: ["recommendation", "agency|cpc|sla|council"],
  };
  for (const [id, [from, to]] of Object.entries(expected)) {
    assert.equal(links.has(id), true, id);
    assert.equal(links.get(id).from, from, id);
    assert.equal(links.get(id).to, to, id);
    assert.equal(links.get(id).status, "unregistered", id);
  }
  assert.equal(links.get("adopts").scope, "full_board");
  assert.equal(links.get("item_on_agenda").replaced_by, "has_agenda_item");
  assert.doesNotMatch(links.get("item_on_agenda").reason, /Meeting objects unregistered/);
});

test("a real CB6 source document demonstrates the declared matter workflow end to end", () => {
  const graph = buildCommunityBoardAgendaRecommendationGraph(fixture);
  assert.equal(graph.status, "demonstrated");
  assert.equal(graph.materialized, false);
  assert.equal(graph.nodes.some((node) => node.id === "agenda_item:community_board:mancb6-minutes-2007-06-p10-a"), true);
  assert.equal(graph.nodes.some((node) => node.id === "matter:117-07-BZ"), true);

  const relations = graph.edges.map((edge) => `${edge.from} ${edge.relation} ${edge.to}`);
  assert.ok(relations.includes("meeting:community_board:mancb6-minutes-2007-06-13 has_agenda_item agenda_item:community_board:mancb6-minutes-2007-06-p10-a"));
  assert.ok(relations.includes("agenda_item:community_board:mancb6-minutes-2007-06-p10-a concerns matter:117-07-BZ"));
  assert.ok(relations.includes("community-board-committee:manhattan-cb-06:land-use considers matter:117-07-BZ"));
  assert.ok(relations.includes("community-board:manhattan-cb-06 issues_recommendation recommendation:community_board:mancb6-minutes-2007-06-p10-a-resolution"));
  assert.ok(relations.includes("recommendation:community_board:mancb6-minutes-2007-06-p10-a-resolution concerns matter:117-07-BZ"));
  for (const edge of graph.edges) {
    assert.equal(edge.status, "promoted");
    assert.equal(edge.provenance.source_document_id, fixture.source.document_id);
    assert.equal(edge.provenance.source_url, fixture.source.url);
    assert.equal(edge.provenance.observed_at, fixture.source.observed_receipt.observed_at);
  }
});

test("unknown matter preserves agenda text and never mints a matter from similar wording", () => {
  const base = fixture.agenda_item;
  const unknown = projectCommunityBoardAgendaItem({
    ...base,
    matter_join: undefined,
    raw_text: "A similar application near 222 East 34th Street",
  });
  assert.equal(unknown.item.status, "promoted");
  assert.equal(unknown.item.raw_text, "A similar application near 222 East 34th Street");
  assert.equal(unknown.item.matter_ref, null);
  assert.equal(unknown.item.matter_join_status, "unknown");
  assert.deepEqual(unknown.edges.map((edge) => edge.relation), ["has_agenda_item"]);

  const similar = projectCommunityBoardAgendaItem({
    ...base,
    matter_join: {
      method: "title_similarity",
      target_kind: "matter",
      publisher_identifier: "117-07-BZ",
      target_ref: "matter:117-07-BZ",
      similar_text: true,
    },
  });
  assert.equal(similar.item.matter_ref, null);
  assert.equal(similar.item.matter_join_status, "unknown");
  assert.deepEqual(similar.edges.map((edge) => edge.relation), ["has_agenda_item"]);
});

test("committee discussion alone cannot infer a recommendation", () => {
  const result = projectCommunityBoardRecommendation({
    ...fixture.recommendation,
    discussion_only: true,
    explicit_recommendation: false,
    recommendation_text: null,
  });
  assert.equal(result.item.status, "unknown");
  assert.equal(result.item.reason, "discussion_does_not_infer_recommendation");
  assert.equal(result.item.recommendation_text, null);
  assert.deepEqual(result.edges, []);
});
