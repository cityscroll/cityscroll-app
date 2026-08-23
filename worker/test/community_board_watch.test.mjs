import test from "node:test";
import assert from "node:assert/strict";
import districtActivity from "../../site/data/district_activity.json" with { type: "json" };
import sharedMeetings from "../../site/data/shared_meeting_read_model.json" with { type: "json" };
import { communityBoardIdFromSelection, communityBoardLabel } from "../../site/community_board_watch.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { describeFilter } from "../src/lib/confirm_email.mjs";

test("Manhattan Community Board 7 compiles through its covering Community District", () => {
  const board = communityBoardIdFromSelection("Manhattan", "7");
  assert.equal(board, "community-board:manhattan-cb-07");
  assert.equal(communityBoardLabel(board), "Manhattan Community Board 7");

  const filter = sanitize("meetings", { communityBoard: board });
  assert.equal(filter.communityBoard, board);
  const query = compileSub({ lens: "meetings", filter }, "2026-08-23");
  assert.equal(query.kind, "meetings");
  assert.equal(query.communityBoard, board);
  assert.equal(query.coveringCommunityDistrict, "M07");
  assert.equal(query.url, "https://cityscroll.org/data/district_activity.json");

  const rows = query.transformRows(districtActivity);
  const expectedBoardMeetingIds = new Set(sharedMeetings.rows
    .filter((row) => row.board_id === "manhattan-cb-07")
    .map((row) => row.meeting_id));
  assert.ok(expectedBoardMeetingIds.size > 0);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => expectedBoardMeetingIds.has(row.id)));
  assert.match(describeFilter("meetings", filter), /Manhattan Community Board 7/);
  assert.doesNotMatch(describeFilter("meetings", filter), /City Council District/);
});

test("Community Board watches require a borough-qualified identity and never use district lens", () => {
  assert.equal(communityBoardIdFromSelection("", "7"), null);
  assert.equal(communityBoardIdFromSelection(null, "7"), null);
  assert.equal(sanitize("meetings", { communityBoard: "7" }).communityBoard, null);
  assert.equal(compileSub({ lens: "meetings", filter: { communityBoard: "7" } }, "2026-08-23"), null);
  assert.equal(compileSub({
    lens: "district",
    filter: { communityBoard: "community-board:manhattan-cb-07" },
  }, "2026-08-23"), null);
});
