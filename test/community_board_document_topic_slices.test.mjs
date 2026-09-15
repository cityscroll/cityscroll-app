import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA,
  buildCommunityBoardDocumentTopicSlice,
  buildCommunityBoardDocumentTopicSlices,
  renderCommunityBoardDocumentTopicSlice,
} from "../site/community_board_document_topic_slices.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const topic = {
  issue_id: "bus-priority",
  label: "Bus priority",
  aliases: [{ id: "bus", terms: ["bus lane", "bus priority"] }],
};
const base = {
  board_id: "manhattan-cb-03",
  meeting_date: "2026-08-12",
  retrieval_date: "2026-09-12",
  document_url: "https://www.nyc.gov/cb3/minutes/2026-08-12.pdf",
  locator: "pages 4-5",
};

test("A1: each accepted hit preserves board, document, dates, locator, source, and bounded excerpt", () => {
  const slice = buildCommunityBoardDocumentTopicSlice([{
    ...base,
    document_id: "cb3-2026-08-12-minutes",
    source_role: "minutes",
    text: `${"Background text ".repeat(50)} bus lane proposal`,
  }], topic);
  const hit = slice.hits[0];
  assert.equal(slice.schema, COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA);
  assert.equal(hit.board_id, "manhattan-cb-03");
  assert.equal(hit.document_id, "cb3-2026-08-12-minutes");
  assert.equal(hit.meeting_date, "2026-08-12");
  assert.equal(hit.document_url, base.document_url);
  assert.equal(hit.retrieval_date, "2026-09-12");
  assert.equal(hit.locator, "pages 4-5");
  assert.ok(hit.excerpt.length <= 321);
  assert.match(hit.route, /bus-priority\/board-documents/);
});

test("A2/A3: source roles preserve mention, testimony, recommendation, individual conduct, and formal action", () => {
  const roles = ["minutes", "testimony", "committee_recommendation", "chair_statement", "member_statement", "formal_vote"];
  const slice = buildCommunityBoardDocumentTopicSlice(roles.map((source_role, index) => ({
    ...base,
    document_id: `doc-${index}`,
    meeting_date: `2026-08-${String(12 + index).padStart(2, "0")}`,
    source_role,
    text: `The bus lane was discussed in ${source_role}.`,
  })), topic);
  assert.deepEqual(slice.hits.map((hit) => hit.action_type), [
    "mention", "public_testimony", "committee_recommendation", "chair_action", "member_action", "formal_board_action",
  ]);
  assert.equal(slice.hits.at(-1).action_type, "formal_board_action");
  assert.notEqual(slice.hits.find((hit) => hit.document_role === "chair_statement").action_type, "formal_board_action");
});

test("A3: formal stance is retained only with vote, resolution, recommendation, or official statement evidence", async () => {
  await withPinnedClock("2026-09-12T12:00:00Z", () => {
    const slice = buildCommunityBoardDocumentTopicSlice([
      { ...base, retrieval_date: todayISO(), document_id: "recommendation", source_role: "committee_recommendation", formal_stance: "support", text: "The bus lane was recommended." },
      { ...base, retrieval_date: todayISO(), document_id: "vote", source_role: "formal_vote", stance: "opposition", text: "The board voted against the bus lane." },
      { ...base, retrieval_date: todayISO(), document_id: "chair", source_role: "chair_statement", formal_stance: "opposition", text: "The chair opposed the bus lane." },
      { ...base, retrieval_date: todayISO(), document_id: "testimony", source_role: "testimony", stance: "support", text: "Public testimony supported the bus lane." },
      {
        ...base,
        retrieval_date: todayISO(),
        document_id: "testimony-self-certified",
        source_role: "testimony",
        stance: "support",
        formal_evidence: true,
        board_action: true,
        text: "The testimony record carries the formal evidence and board action flags for the bus lane.",
      },
    ], topic);
    const chair = slice.hits.find((hit) => hit.document_id === "chair");
    const testimony = slice.hits.find((hit) => hit.document_id === "testimony");
    const selfCertified = slice.hits.find((hit) => hit.document_id === "testimony-self-certified");
    const vote = slice.hits.find((hit) => hit.document_id === "vote");
    assert.equal(chair.stance, null);
    assert.equal(testimony.stance, null);
    assert.equal(selfCertified.stance, "support");
    assert.equal(selfCertified.stance_evidence_kind, "Official board statement");
    assert.equal(vote.stance, "opposition");
    assert.equal(vote.stance_evidence_kind, "Formal vote");
    const rendered = renderCommunityBoardDocumentTopicSlice(slice);
    assert.match(rendered, /Stance: opposition · Evidence: Formal vote/);
    assert.match(rendered, /Stance: support · Evidence: Official board statement/);
    const article = (action) => rendered.match(new RegExp(`<article data-action-type="${action}">([\\s\\S]*?)</article>`))[1];
    assert.doesNotMatch(article("chair_action"), /Stance:/);
    assert.doesNotMatch(article("public_testimony"), /Stance:/);
  });
});

test("A4: only retained official board roles enter the slice", () => {
  const slice = buildCommunityBoardDocumentTopicSlice([
    { ...base, document_id: "court", source_role: "court_record", text: "bus lane" },
    { ...base, document_id: "report", source_role: "reporting", text: "bus lane" },
    { ...base, document_id: "petition", source_role: "petitions", text: "bus lane" },
    { ...base, document_id: "unreadable", source_role: "minutes", state: "unreadable", text: "bus lane" },
  ], topic);
  assert.equal(slice.hits.length, 0);
  assert.equal(slice.coverage.documents_searched, 4);
  assert.equal(slice.coverage.official_documents_searched, 1);
  assert.deepEqual(slice.coverage.excluded_source_families, ["court_records", "reporting", "social_posts", "petitions", "unverified_external_documents"]);
});

test("A5: adding a retained document deterministically reevaluates the slice without changing aliases", () => {
  const first = [{ ...base, document_id: "unrelated", source_role: "minutes", text: "Traffic discussion" }];
  const empty = buildCommunityBoardDocumentTopicSlice(first, topic);
  const expanded = buildCommunityBoardDocumentTopicSlice([...first, { ...base, document_id: "new", source_role: "resolution", text: "The bus lane was approved by resolution." }], topic);
  assert.equal(empty.hits.length, 0);
  assert.equal(expanded.hits[0].document_id, "new");
  assert.deepEqual(empty.aliases, expanded.aliases);
  assert.deepEqual(expanded, buildCommunityBoardDocumentTopicSlice([...first, { ...base, document_id: "new", source_role: "resolution", text: "The bus lane was approved by resolution." }], topic));
});

test("A6: no-match coverage reports source roles, freshness, through-date, and searched population", () => {
  const slice = buildCommunityBoardDocumentTopicSlice([
    { ...base, document_id: "minutes", source_role: "minutes", text: "A different topic." },
    { ...base, document_id: "agenda", source_role: "agenda", text: "Another topic." },
    { ...base, document_id: "unreadable", source_role: "resolution", state: "unreadable", text: "bus lane" },
  ], topic);
  assert.equal(slice.matched, false);
  assert.equal(slice.coverage.documents_searched, 3);
  assert.equal(slice.coverage.through_date, "2026-09-12");
  assert.deepEqual(slice.coverage.source_roles.map((role) => role.role), ["agenda", "minutes", "resolution"]);
  assert.equal(slice.coverage.source_roles.find((role) => role.role === "resolution").unreadable, 1);
  assert.match(renderCommunityBoardDocumentTopicSlice(slice), /official document/);
  assert.match(renderCommunityBoardDocumentTopicSlice(slice), /2026-09-12/);
});

test("district topic entries are materialized as typed document excerpts", () => {
  const result = buildCommunityBoardDocumentTopicSlices([{ ...base, document_id: "doc", source_role: "minutes", text: "bus lane" }], [topic]);
  assert.equal(result.entries[0].source_family, "document_excerpt");
  assert.deepEqual(result.entries[0].districts, ["M03"]);
  assert.equal(result.entries[0].source_reference, "community-board-document:manhattan-cb-03:doc");
});
