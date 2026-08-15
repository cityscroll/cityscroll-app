import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT,
  COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT,
  COMMUNITY_BOARD_RELATION_PROMOTION_METHOD,
  promoteCommunityBoardMemberEdge,
  promoteCommunityBoardRecommendationEdge,
} from "../site/community_board_relations.mjs";
import { buildCommunityBoardConstellationView, renderCommunityBoardConstellationDocument } from "../site/community_board_constellation.mjs";

const document = {
  publisher_document_id: "bronx-cb-01-minutes-2026-08-12",
  document_url: "https://board.example/minutes/2026-08-12.pdf",
  date: "2026-08-12",
  observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
};

test("member and recommendation contracts are distinct and carry different semantics", () => {
  assert.notEqual(COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT.schema, COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT.schema);
  assert.notEqual(COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT.edge_schema, COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT.edge_schema);
  assert.equal(COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT.relation, "has_member");
  assert.equal(COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT.relation, "issues_recommendation");
  assert.match(COMMUNITY_BOARD_MEMBER_SOURCE_CONTRACT.semantics, /descriptive temporal service/);
  assert.match(COMMUNITY_BOARD_RECOMMENDATION_SOURCE_CONTRACT.semantics, /issued by the board/);
});

test("only exact publisher identities, dates, and retained documents promote", () => {
  const member = promoteCommunityBoardMemberEdge({
    board_id: "bronx-cb-01",
    member_id: "7801",
    member_name: "Published Member",
    membership_date: "2026-08-12",
    source_document: document,
  });
  assert.equal(member.status, "promoted");
  assert.equal(member.promoted, true);
  assert.equal(member.edge_type, "has_member");
  assert.equal(member.to, "official:7801");
  assert.equal(member.provenance.join_method, COMMUNITY_BOARD_RELATION_PROMOTION_METHOD);
  assert.equal(member.source_document.id, document.publisher_document_id);
  assert.equal(member.source_document.date, document.date);
  assert.equal(member.source_document.observed_receipt.status, "ok");

  const recommendation = promoteCommunityBoardRecommendationEdge({
    board_id: "bronx-cb-01",
    recommendation_id: "REC-2026-08-12-01",
    recommendation_title: "Support the neighborhood plan",
    recommendation_date: "2026-08-12",
    source_document: document,
  });
  assert.equal(recommendation.status, "promoted");
  assert.equal(recommendation.edge_type, "issues_recommendation");
  assert.equal(recommendation.to, "recommendation:REC-2026-08-12-01");
  assert.equal(recommendation.source_document.url, document.document_url);
});

test("name-only, title-only, venue-only, inferred, and incomplete document candidates stay unknown", () => {
  const candidates = [
    { board_id: "bronx-cb-01", member_name: "A Name", membership_date: "2026-08-12", source_document: document },
    { board_id: "bronx-cb-01", recommendation_title: "A Title", recommendation_date: "2026-08-12", source_document: document },
    { board_id: "bronx-cb-01", venue: "Board hall", membership_date: "2026-08-12", source_document: document },
    { board_id: "bronx-cb-01", person_id: "A Name", person_name: "A Name", membership_date: "2026-08-12", source_document: document },
    { board_id: "bronx-cb-01", member_id: "7801", inferred: true, membership_date: "2026-08-12", source_document: document },
    { board_name: "Bronx Community Board 1", member_name: "Inferred", membership_date: "2026-08-12", source_document: document },
    { board_id: "bronx-cb-01", member_id: "7801", membership_date: "2026-08-13", source_document: document },
    { board_id: "bronx-cb-01", member_id: "7801", membership_date: "2026-08-12", source_document: { ...document, observed_receipt: null } },
  ];
  for (const observation of candidates) {
    const result = promoteCommunityBoardMemberEdge(observation);
    assert.equal(result.status, "unknown", JSON.stringify(observation));
    assert.equal(result.promoted, false);
  }
});

test("board profile renders promoted relation records with provenance behind an affordance", () => {
  const sourceRegistry = { sources: [{ body_id: "bronx-cb-01", body_type: "community_board", name: "Bronx Community Board 1", borough: "Bronx", district: 1, directory_url: "https://board.example/boards" }] };
  const view = buildCommunityBoardConstellationView("bronx-cb-01", {
    sourceRegistry,
    sourceInventory: { boards: [] },
    scorecard: { rows: [] },
    geography: { nodes: [], public_edges: [] },
    boardRelations: {
      "bronx-cb-01": {
        members: [{ board_id: "bronx-cb-01", member_id: "7801", member_name: "Published Member", membership_date: "2026-08-12", source_document: document }],
        recommendations: [{ board_id: "bronx-cb-01", recommendation_id: "REC-1", recommendation_title: "Support the neighborhood plan", recommendation_date: "2026-08-12", source_document: document }],
      },
    },
  });
  assert.equal(view.categories.find((category) => category.id === "members").status, "matched");
  assert.equal(view.categories.find((category) => category.id === "recommendations").status, "matched");
  const html = renderCommunityBoardConstellationDocument(view);
  const readerHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  assert.match(readerHtml, /Published Member/);
  assert.match(readerHtml, /href="\/officials\/7801\/"/);
  assert.match(readerHtml, /data-pivot-schema="cityscroll\.edge_summary\.v1"/);
  assert.match(readerHtml, /data-pivot-target-kind="official"/);
  assert.match(readerHtml, /Support the neighborhood plan/);
  assert.match(readerHtml, /data-pivot-status="held"/);
  assert.doesNotMatch(readerHtml, /href="[^"]*REC-1/);
  assert.match(readerHtml, /How confirmed/);
  assert.match(readerHtml, /Open the source document/);
  assert.doesNotMatch(readerHtml, /source_document_id|publisher_document_id|join_method|Source: Unavailable|Join method: Unavailable/);
});
