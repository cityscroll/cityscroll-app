import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { normalizeHearingRow, chooseHearingScope } from "../site/hearing_location.js";
import {
  buildMeetingsExplorerEntries,
  meetingEventSubjectKey,
} from "../site/meetings_explorer.mjs";
import {
  communityBoardScopeHref,
  communityBoardRows,
} from "../site/community_board_scope_links.mjs";
import { routeHashFromScope, scopeFromRouteHash } from "../site/scope_v0.mjs";

const shared = JSON.parse(fs.readFileSync(new URL(
  "../site/data/shared_meeting_read_model.json",
  import.meta.url,
), "utf8"));

function meeting(partial = {}) {
  return {
    meeting_id: "meeting:city_record:20260814001",
    source_system: "city_record",
    source_keys: [{ source_system: "city_record", key_type: "request_id", value: "20260814001" }],
    request_id: "20260814001",
    title: "Harbor access public hearing",
    decides: "Harbor access public hearing",
    event_date: "2026-08-20",
    meeting_origin: "city_record_notice",
    affected_area: { scope: "local", boroughs: ["Brooklyn"], community_boards: [] },
    ...partial,
  };
}

test("mixed Meetings entries keep source-qualified identities and exact duplicate collapse", () => {
  const city = meeting();
  const board = meeting({
    meeting_id: "meeting:community_board:https://example.test/cb14/harbor",
    source_system: "community_board",
    source_keys: [{ source_system: "community_board", key_type: "publisher_event_id", value: "https://example.test/cb14/harbor" }],
    request_id: null,
    publisher_identifier: "https://example.test/cb14/harbor",
    board_id: "brooklyn-cb-14",
    board_name: "Brooklyn Community Board 14",
    institution_refs: { agency_ref: null, board_ref: "community-board:brooklyn-cb-14" },
    entity_refs_all: ["community-board:brooklyn-cb-14", "meeting:community_board:https://example.test/cb14/harbor"],
    meeting_origin: "community_board_source_observed",
  });
  const otherBoard = { ...board,
    meeting_id: "meeting:community_board:https://example.test/cb6/harbor",
    publisher_identifier: "https://example.test/cb6/harbor",
    board_id: "brooklyn-cb-06",
    board_name: "Brooklyn Community Board 6",
    institution_refs: { agency_ref: null, board_ref: "community-board:brooklyn-cb-06" },
  };
  const entries = buildMeetingsExplorerEntries([city, board, { ...board }, otherBoard], { now: "2026-08-01" });
  assert.equal(entries.length, 3, "CR, CB14, and CB6 remain peer cards");
  assert.equal(entries.find((entry) => entry.primary.meeting_id === board.meeting_id).notice_count, 2);
  assert.notEqual(meetingEventSubjectKey(city), meetingEventSubjectKey(board));
});

test("live scope search and sort honor an exact community-board reference", () => {
  const records = [
    normalizeHearingRow({
      source_system: "community_board",
      meeting_id: "meeting:community_board:cb14-late",
      publisher_identifier: "cb14-late",
      board_id: "brooklyn-cb-14",
      board_name: "Brooklyn Community Board 14",
      short_title: "Harbor access committee",
      event_date: "2026-08-25T18:30:00-04:00",
      event_end: "2026-08-25T20:30:00-04:00",
      affected_area: { scope: "local", boroughs: ["Brooklyn"], community_boards: ["brooklyn-cb-14"] },
    }),
    normalizeHearingRow({
      source_system: "community_board",
      meeting_id: "meeting:community_board:cb06-same-day",
      publisher_identifier: "cb06-same-day",
      board_id: "brooklyn-cb-06",
      board_name: "Brooklyn Community Board 6",
      short_title: "Harbor access committee",
      event_date: "2026-08-20",
      affected_area: { scope: "local", boroughs: ["Brooklyn"], community_boards: ["brooklyn-cb-06"] },
    }),
  ];
  const result = chooseHearingScope(records, {
    when: "all",
    communityBoard: "community-board:brooklyn-cb-14",
    keyword: "Brooklyn Community Board 14",
  }, "2026-08-01", false);
  assert.deepEqual(result.rows.map((row) => row.meeting_id), ["meeting:community_board:cb14-late"]);
  assert.equal(result.rows[0].board_id, "brooklyn-cb-14");
  assert.equal(result.rows[0].event_end, "2026-08-25T20:30:00-04:00");
});

test("static Browse carries board peers, canonical links, origin, and exact board scope", () => {
  const boardRows = shared.rows.filter((row) => row.source_system === "community_board");
  const board = boardRows[0];
  const href = communityBoardScopeHref("meetings", board.board_id, "#meetings?q=committee");
  const parsed = scopeFromRouteHash(href);
  assert.deepEqual(parsed.facets.values.entity_refs_all, [`community-board:${board.board_id}`]);
  assert.ok(communityBoardRows(boardRows).length > 0);

  const view = buildBrowseView("meetings", { rows: shared.rows }, new URLSearchParams(href.split("?", 2)[1] || ""), { limit: 1000 });
  assert.equal(view.scope.mode, "applied");
  assert.ok(view.total > 0);
  assert.ok(view.rows.every((row) => row.institution_refs?.board_ref === `community-board:${board.board_id}`));
  const html = renderBrowseView(view);
  assert.match(html, /\/meetings\/meeting%3Acommunity_board%3A/);
  assert.match(html, /Community board source observed/);
  assert.match(html, /Hosted by /);
  assert.doesNotMatch(html, /href="\/community-boards\/[^" ]+"/);
});
