import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildCommunityBoardPeopleFromRosterCapture,
  parseCbsixRosterHtml,
  publisherPersonIdFromName,
} from "../site/community_board_people_refresh.mjs";

const fixtureHtml = `
<html><body>
  <h2>Board Officers</h2>
  <div class="col-md-4 pl-0 members_box_item">
    <div class="members_box_title lh-1_2">Sandra McKee</div>
    <div class="tags"><span>Chair</span></div>
  </div>
  <h2>Committee Chairs</h2>
  <div class="col-md-4 pl-0 members_box_item">
    <div class="members_box_title lh-1_2">Jason Froimowitz</div>
    <div class="tags"><span>Transportation</span></div>
  </div>
  <h2>Public Members</h2>
  <div class="col-md-4 pl-0 members_box_item">
    <div class="members_box_title lh-1_2">Michael Cohen</div>
    <div class="tags"><span>Transportation</span></div>
  </div>
  <h2>Board Staff</h2>
  <div class="col-md-4 pl-0 members_box_item">
    <div class="members_box_title lh-1_2">Jesús Pérez</div>
    <div class="tags"><span>District Manager</span></div>
  </div>
</body></html>
`;

test("publisher person ids are board-local opaque slugs without spaces", () => {
  assert.equal(publisherPersonIdFromName("Sandra McKee"), "sandra-mckee");
  assert.equal(publisherPersonIdFromName("Jesús Pérez"), "jesus-perez");
});

test("CB6 roster HTML parser reads sectioned member cards", () => {
  const parsed = parseCbsixRosterHtml(fixtureHtml);
  assert.equal(parsed.sections.length, 4);
  assert.equal(parsed.sections[0].title, "Board Officers");
  assert.deepEqual(parsed.sections[3].members[0], {
    name: "Jesús Pérez",
    tags: ["District Manager"],
  });
});

test("people refresh rebuilds the grounded pilot from roster evidence", () => {
  const artifact = buildCommunityBoardPeopleFromRosterCapture({
    html: fixtureHtml,
    observedAt: "2026-10-09T12:00:00.000Z",
    contentSha256: "abc",
  });
  assert.equal(artifact.observed_on, "2026-10-09");
  const rows = artifact.boards["manhattan-cb-06"].relationships;
  assert.deepEqual(rows.map((row) => [row.publisher_person_id, row.relation, row.role]), [
    ["sandra-mckee", "member_of", "board_chair"],
    ["sandra-mckee", "chairs", "board_chair"],
    ["jason-froimowitz", "chairs", "committee_chair"],
    ["michael-cohen", "member_of", "public_committee_member"],
    ["jesus-perez", "staffed_by", "district_manager"],
  ]);
  assert.ok(rows.every((row) => row.source_document.observed_receipt.status === "ok"));
});

test("people refresh refuses a roster missing required role evidence", () => {
  assert.throws(
    () => buildCommunityBoardPeopleFromRosterCapture({
      html: "<h2>Board Officers</h2>",
      observedAt: "2026-10-09T12:00:00.000Z",
    }),
    /missing required role evidence/,
  );
});

test("live CB6 roster fixture from acquisition still contains the grounded roles", () => {
  // Optional live smoke when a capture is supplied in the environment; unit
  // coverage above stays hermetic.
  const path = process.env.CITYSCROLL_CB6_ROSTER_HTML;
  if (!path) return;
  const artifact = buildCommunityBoardPeopleFromRosterCapture({
    html: readFileSync(path, "utf8"),
    observedAt: "2026-10-09T12:00:00.000Z",
  });
  assert.equal(artifact.boards["manhattan-cb-06"].relationships.length, 5);
});
