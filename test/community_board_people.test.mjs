import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMUNITY_BOARD_PERSON_ROLES,
  buildCommunityBoardPersonEdges,
  communityBoardPersonId,
  promoteCommunityBoardPersonRoleEdge,
} from "../site/community_board_people.mjs";

const sourceDocument = {
  publisher_document_id: "cb6-roster-2026-08-25",
  document_url: "https://cbsix.org/about-us/board-members-and-staff/",
  date: "2026-08-25",
  observed_receipt: { status: "ok", observed_at: "2026-08-25T12:00:00Z" },
};

const row = (extra = {}) => ({
  board_id: "manhattan-cb-06",
  publisher_person_id: "jason-froimowitz",
  person_name: "Jason Froimowitz",
  relation_date: "2026-08-25",
  source_document: sourceDocument,
  ...extra,
});

test("Community Board person identity is board-local and future-generic-person ready", () => {
  assert.equal(communityBoardPersonId("manhattan-cb-06", "jason-froimowitz"), "community-board-person:manhattan-cb-06:jason-froimowitz");
  assert.notEqual(communityBoardPersonId("manhattan-cb-06", "jason-froimowitz"), communityBoardPersonId("brooklyn-cb-01", "jason-froimowitz"));
  assert.equal(communityBoardPersonId("manhattan-cb-06", "Jason Froimowitz"), null);
});

test("membership, chairship, committee membership, and employment remain typed temporal edges", () => {
  const edges = buildCommunityBoardPersonEdges({
    relationships: [
      row({ relation: "member_of", role: "appointed_member", valid_from: "2025-01-01", valid_to: "2025-12-31" }),
      row({ relation: "chairs", role: "committee_chair", committee_ref: "community-board-committee:manhattan-cb-06:transportation" }),
      row({ relation: "member_of", role: "public_committee_member", committee_ref: "community-board-committee:manhattan-cb-06:transportation" }),
      row({ publisher_person_id: "jesus-perez", person_name: "Jesús Pérez", relation: "staffed_by", role: "district_manager" }),
    ],
  });
  assert.deepEqual(edges.map((edge) => [edge.relation, edge.role, edge.target_kind]), [
    ["member_of", "appointed_member", "community-board"],
    ["chairs", "committee_chair", "community-board-committee"],
    ["member_of", "public_committee_member", "community-board-committee"],
    ["staffed_by", "district_manager", "community-board-person"],
  ]);
  assert.equal(edges[0].valid_from, "2025-01-01");
  assert.equal(edges[0].valid_to, "2025-12-31");
  assert.equal(edges[3].role_semantics.includes("membership"), true);
  assert.equal(edges[3].from, "community-board:manhattan-cb-06");
  assert.equal(edges[3].to, "community-board-person:manhattan-cb-06:jesus-perez");
  assert.equal(edges[3].inverse_relation, "works_for");
  assert.ok(edges.every((edge) => edge.provenance?.source_url && edge.provenance?.observed_at));
  assert.ok(edges.every((edge) => !edge.to.startsWith("official:")));
  assert.ok(COMMUNITY_BOARD_PERSON_ROLES.includes("district_manager"));
});

test("role evidence cannot turn a District Manager into a board member", () => {
  const edge = promoteCommunityBoardPersonRoleEdge(row({ relation: "member_of", role: "district_manager" }));
  assert.equal(edge.status, "unknown");
  assert.equal(edge.reason, "role_target_mismatch");
  const employment = promoteCommunityBoardPersonRoleEdge(row({ relation: "staffed_by", role: "district_manager" }));
  assert.equal(employment.status, "promoted");
  assert.equal(employment.role, "district_manager");
  assert.equal(employment.role_semantics.includes("does not establish board membership"), true);
});

test("same display name does not create an identity or Council route", () => {
  const edge = promoteCommunityBoardPersonRoleEdge(row({ publisher_person_id: "Jason Froimowitz", person_name: "Jason Froimowitz" }));
  assert.equal(edge.status, "unknown");
  assert.equal(edge.promoted, false);
  const numeric = promoteCommunityBoardPersonRoleEdge(row({ publisher_person_id: "7801", person_name: "Published Member" }));
  assert.equal(numeric.to, "community-board:manhattan-cb-06");
  assert.equal(numeric.from, "community-board-person:manhattan-cb-06:7801");
  assert.doesNotMatch(numeric.from, /^official:/);
});
