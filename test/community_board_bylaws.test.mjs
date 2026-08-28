import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  answerCommunityBoardGovernanceQuestion,
  buildCommunityBoardBylawGraph,
  COMMUNITY_BOARD_BYLAW_RULE_TOPICS,
  currentCommunityBoardBylawVersion,
  normalizeCommunityBoardBylawVersion,
  renderCommunityBoardBylawPanel,
} from "../site/community_board_bylaws.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";

const source = JSON.parse(readFileSync(new URL("../site/data/community_board_bylaws.json", import.meta.url), "utf8"));

const baseVersion = (overrides = {}) => ({
  id: "bylaw-version:bronx-cb-01:fixture",
  board_id: "bronx-cb-01",
  source_url: "https://example.test/bronx-cb-01-bylaws.pdf",
  publisher: "Bronx Community Board 1",
  publisher_document_id: "bronx-cb-01-bylaws-2026",
  publisher_document_title: "Bronx Community Board 1 bylaws",
  effective_date: null,
  adoption_date: null,
  observed_on: "2026-08-27",
  supersedes: null,
  receipt: {
    schema: "cityscroll.community_board_bylaw_receipt.v1",
    source_url: "https://example.test/bronx-cb-01-bylaws.pdf",
    observed_at: "2026-08-27T00:00:00Z",
    status: "ok",
    fetch_status: "200",
    content_type: "application/pdf",
    parser: "fixture",
  },
  rules: [],
  ...overrides,
});

test("bylaw schema generalizes across materially different board documents", () => {
  assert.equal(source.versions.length >= 3, true);
  const graph = buildCommunityBoardBylawGraph(source);
  const boards = new Set(graph.versions.map((version) => version.board_id));
  assert.ok(boards.has("manhattan-cb-06"));
  assert.ok(boards.has("queens-cb-06"));
  assert.ok(boards.has("manhattan-cb-02"));
  assert.notDeepEqual(
    graph.currentByBoard("manhattan-cb-06").rules.find((rule) => rule.topic === "public_committee_member_eligibility").value,
    graph.currentByBoard("queens-cb-06").rules.find((rule) => rule.topic === "public_committee_member_eligibility").value,
  );
  assert.equal(COMMUNITY_BOARD_BYLAW_RULE_TOPICS.includes("parliamentary_authority"), true);
});

test("every normalized material rule carries the governing version and receipt provenance", () => {
  const graph = buildCommunityBoardBylawGraph(source);
  for (const version of graph.versions) {
    assert.ok(version.source_url.startsWith("https://"));
    assert.ok(version.publisher_document_id);
    assert.ok(version.observed_on);
    assert.equal(version.receipt.source_url, version.source_url);
    assert.equal(version.provenance.publisher_document_id, version.publisher_document_id);
    for (const rule of version.rules) {
      assert.equal(rule.bylaw_version_id, version.id);
      assert.equal(rule.source.bylaw_version_id, version.id);
      assert.equal(rule.source.source_url, version.source_url);
      assert.ok(rule.source.source_locator);
      assert.equal(rule.source.receipt.status, "ok");
    }
  }
});

test("a board never inherits public-member voting from another board", () => {
  const graph = buildCommunityBoardBylawGraph({ versions: [baseVersion({
    rules: [{
      topic: "public_committee_member_voting",
      answer: "yes",
      statement: "Fixture board members may vote in their appointed committee.",
      source_locator: "fixture section 4",
    }],
  })] });
  const otherBoard = answerCommunityBoardGovernanceQuestion(graph, "queens-cb-01");
  assert.equal(otherBoard.answer, "source_does_not_establish");
  assert.equal(otherBoard.bylaw_version, null);
  assert.equal(otherBoard.provenance, null);
});

test("unknown beats inference from general voting or eligibility rules", () => {
  const graph = buildCommunityBoardBylawGraph({ versions: [baseVersion({
    rules: [
      { topic: "voting_eligibility", answer: "yes", statement: "Appointed board members may vote.", source_locator: "fixture section 2" },
      { topic: "public_committee_member_eligibility", answer: "yes", statement: "The Chair may appoint public committee members.", source_locator: "fixture section 3" },
    ],
  })] });
  const answer = answerCommunityBoardGovernanceQuestion(graph, "bronx-cb-01");
  assert.equal(answer.answer, "source_does_not_establish");
  assert.equal(answer.label, "Source does not establish");
  assert.equal(answer.rule, null);
});

test("superseded versions remain in history while the newest linked version answers", () => {
  const prior = baseVersion({
    id: "bylaw-version:bronx-cb-01:2020",
    publisher_document_id: "bronx-cb-01-bylaws-2020",
    rules: [{ topic: "public_committee_member_voting", answer: "yes", statement: "Prior rule allowed committee voting.", source_locator: "prior section 1" }],
  });
  const current = baseVersion({
    id: "bylaw-version:bronx-cb-01:2026",
    publisher_document_id: "bronx-cb-01-bylaws-2026",
    adoption_date: "2026-01-15",
    effective_date: "2026-02-01",
    supersedes: prior.id,
    rules: [{ topic: "public_committee_member_voting", answer: "no", statement: "Current rule does not grant committee voting.", source_locator: "current section 1" }],
  });
  const graph = buildCommunityBoardBylawGraph({ versions: [prior, current] });
  assert.equal(currentCommunityBoardBylawVersion(graph.versions, "bronx-cb-01").id, current.id);
  assert.equal(answerCommunityBoardGovernanceQuestion(graph, "bronx-cb-01").answer, "no");
  assert.deepEqual(graph.versions.map((version) => version.id), [prior.id, current.id]);
  assert.deepEqual(graph.edges.map((edge) => edge.to), [prior.id, current.id]);
  assert.equal(graph.edges[1].supersedes, prior.id);
});

test("governance question panel links the answer to the exact bylaw version", () => {
  const graph = buildCommunityBoardBylawGraph(source);
  const answer = answerCommunityBoardGovernanceQuestion(graph, "manhattan-cb-06");
  const html = renderCommunityBoardBylawPanel({
    question: answer,
    versions: graph.versions,
  });
  assert.match(html, /Can public committee members vote here\?/);
  assert.match(html, /data-governance-answer="yes"/);
  assert.match(html, /2023-03-13-Bylaws-March-2023-revision-FINAL-VERSION\.pdf/);
  assert.match(html, /Version history/);
  assert.match(html, /bylaw-version:manhattan-cb-06:2023-03-08/);
});

test("a current bylaw version with no material rules states that gap once", () => {
  const graph = buildCommunityBoardBylawGraph({ versions: [baseVersion()] });
  const question = answerCommunityBoardGovernanceQuestion(graph, "bronx-cb-01");
  const html = renderCommunityBoardBylawPanel({ question, versions: graph.versions });
  assert.match(html, /No material board rules are listed in this source/);
  assert.equal((html.match(/Source does not establish/g) || []).length, 1);
  assert.match(html, /data-bylaw-answer="source_does_not_establish"/);
});

test("board page renders a board-specific yes answer and no-bylaw unknown", () => {
  const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url), "utf8"));
  const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url), "utf8"));
  const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url), "utf8"));
  const common = { sourceRegistry: registry, scorecard, geography, communityBoardBylaws: source };
  const yesHtml = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("manhattan-cb-06", common));
  const unknownHtml = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("bronx-cb-02", common));
  assert.match(yesHtml, /data-governance-answer="yes"/);
  assert.match(yesHtml, /Governing bylaws/);
  assert.match(unknownHtml, /data-governance-answer="source_does_not_establish"/);
  assert.match(unknownHtml, /No board-specific bylaw version is available/);
  const governance = unknownHtml.match(/<section id="community-board-governance"[\s\S]*?<\/section>/)?.[0] || "";
  assert.equal((governance.match(/Source does not establish/g) || []).length, 1);
  assert.doesNotMatch(governance, /Source does not establish material rules/);
});
