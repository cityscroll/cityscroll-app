import assert from "node:assert/strict";
import { test } from "node:test";

import {
  communityBoardDisambiguation,
  communityBoardInstitutionHref,
  parseCommunityBoardQuery,
  rowMatchesCommunityBoardQuery,
} from "../site/community_board_search.mjs";

test("bare community-board number stays ambiguous across boroughs", () => {
  const query = parseCommunityBoardQuery("community board 3");
  assert.deepEqual(query, {
    number: 3,
    borough: null,
    ambiguous: true,
    query: "community board 3",
  });
  assert.equal(communityBoardDisambiguation(query).length, 5);
  assert.equal(communityBoardInstitutionHref("bronx-cb-03"), "/browse/people/?board=bronx-cb-03#community-boards");
});

test("CB3 shorthand keeps the same borough-aware disambiguation", () => {
  assert.deepEqual(parseCommunityBoardQuery("CB3"), {
    number: 3,
    borough: null,
    ambiguous: true,
    query: "CB3",
  });
  assert.equal(parseCommunityBoardQuery("Manhattan CB3")?.borough, "Manhattan");
});

test("borough-qualified community-board search matches the exact board", () => {
  const row = { affected_area: { community_boards: ["Community Board 3, Bronx"] } };
  assert.equal(rowMatchesCommunityBoardQuery(row, parseCommunityBoardQuery("Bronx community board 3")), true);
  assert.equal(rowMatchesCommunityBoardQuery(row, parseCommunityBoardQuery("Brooklyn community board 3")), false);
  assert.equal(rowMatchesCommunityBoardQuery(row, parseCommunityBoardQuery("community board 3")), true);
});
