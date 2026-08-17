import assert from "node:assert/strict";
import test from "node:test";

import {
  communityBoardIdFromEvidence,
  communityBoardPageHref,
  communityDistrictDisplayName,
} from "../site/community_board_links.mjs";

test("community-board references resolve only from explicit board evidence", () => {
  assert.equal(
    communityBoardIdFromEvidence("2022M0258_HA_MN CB11"),
    "manhattan-cb-11",
  );
  assert.equal(
    communityBoardPageHref("Community Board 11, Manhattan"),
    "/community-boards/manhattan-cb-11/",
  );
  assert.equal(
    communityBoardPageHref("CB11", { borough: "Manhattan" }),
    "/community-boards/manhattan-cb-11/",
  );
});

test("unresolved board references remain unlinked", () => {
  assert.equal(communityBoardIdFromEvidence("Conditional Favorable"), null);
  assert.equal(communityBoardPageHref("CB11"), null);
  assert.equal(communityBoardPageHref("Community Board 11", { borough: "Unknown" }), null);
});

test("community-district display names keep machine codes out of resident copy", () => {
  assert.equal(
    communityDistrictDisplayName({ borough: "Bronx", district: 1, id: "X01" }),
    "Bronx Community District 1",
  );
  assert.equal(
    communityDistrictDisplayName({ borough: "Bronx", id: "X01" }),
    "Bronx Community District 1",
  );
  assert.equal(communityDistrictDisplayName({ borough: "Bronx", id: "Q01" }), null);
});
