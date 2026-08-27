import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  communityBoardCommitteeId,
  matchCommunityBoardCommittee,
  normalizeCommunityBoardCommitteeRegistry,
} from "../site/community_board_committees.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/community_board_committees.json", import.meta.url)));

test("committee identity is board-local even when publisher names and topics match", () => {
  const rows = normalizeCommunityBoardCommitteeRegistry(registry);
  assert.equal(communityBoardCommitteeId("manhattan-cb-06", "transportation"), "community-board-committee:manhattan-cb-06:transportation");
  assert.equal(communityBoardCommitteeId("brooklyn-cb-01", "transportation"), "community-board-committee:brooklyn-cb-01:transportation");
  assert.notEqual(rows[0].board_id, rows[1].board_id);
  assert.notEqual(
    matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", committee: { name: "Transportation Committee" } }, registry).id,
    matchCommunityBoardCommittee({ board_id: "brooklyn-cb-01", committee: { name: "Transportation Committee" } }, registry).id,
  );
});

test("matching uses identifier, exact publisher name, then reviewed local alias", () => {
  const local = {
    committees: [{
      board_id: "manhattan-cb-06",
      committee_id: "transportation",
      publisher_name: "Official Transportation Body",
      publisher_identifier: "publisher-transport",
      aliases: ["Transportation Committee Meeting"],
      source_url: "https://cbsix.org/meetings-calendar/",
      observed_on: "2026-08-25",
      topic_facets: ["transportation"],
    }],
  };
  assert.equal(matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", committee: { name: "Wrong label", publisher_identifier: "publisher-transport" } }, local).match_method, "exact_publisher_committee_identifier");
  assert.equal(matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", committee: { name: "Official Transportation Body" } }, local).match_method, "exact_official_publisher_name");
  assert.equal(matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", title: "Transportation Committee Meeting" }, local).match_method, "reviewed_board_local_alias");
  assert.equal(matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", title: "Transportation Committee Meeting — September" }, local).status, "unresolved");
});

test("unlisted board committee names stay unresolved", () => {
  const result = matchCommunityBoardCommittee({ board_id: "manhattan-cb-06", committee: { name: "Transport-adjacent working group" } }, registry);
  assert.equal(result.status, "unresolved");
  assert.equal(result.id, null);
});
