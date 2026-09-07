import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMUNITY_BOARD_FULL_BOARD_ANSWER_STATES,
  classifyCommunityBoardConveningBody,
  communityBoardFullBoardMeetingAnswer,
  resolveCommunityBoardQuery,
} from "../site/community_board_full_board_lens.mjs";
import {
  checkRetainedCommunityBoardSnapshot,
  readRetainedCommunityBoardSnapshots,
} from "../tools/acquire_community_board_retained_snapshot.mjs";
import { buildCommunityBoardFullBoardMeetings } from "../tools/build_community_board_full_board_meetings.mjs";

const readModel = JSON.parse(readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url)));
const inventory = JSON.parse(readFileSync(
  new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url),
));
// The boards under test are the ones the live evaluation runs asked about. They
// are read from the derived fixture rather than restated here, so a change to
// the evaluation set moves this test instead of leaving it behind.
const evaluated = JSON.parse(readFileSync(new URL("./fixtures/meeting-lens/evaluation_boards.json", import.meta.url)));
const published = JSON.parse(readFileSync(new URL("../site/data/community_board_full_board_meetings.json", import.meta.url)));

const coverage = readModel.sources.community_board.board_coverage;
const AS_OF = readModel.freshness.checked_at.slice(0, 10);
const boardsInState = (state) => coverage.filter((row) => row.meetings.state === state);

test("the evaluated boards are read from the evaluation fixture, not restated", () => {
  assert.equal(evaluated.schema, "cityscroll.meeting_lens_evaluation_boards.v1");
  assert.ok(evaluated.boards.length >= 1, "the evaluation named at least one community board");
  assert.equal(evaluated.runs.length, 3);
  assert.ok(evaluated.runs.every((run) => run.task_family === "meetings"));
  const source = readFileSync(new URL("./community_board_full_board_lens.test.mjs", import.meta.url), "utf8");
  for (const board of evaluated.boards) {
    assert.ok(!source.includes(board.name), `${board.name} is read from the fixture rather than written into the test`);
  }
});

test("each evaluated board answers with its own most recent full board meeting, dated and attributed", () => {
  for (const board of evaluated.boards) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel, query: board.name, asOf: AS_OF });
    assert.equal(result.status, "full_board_meeting", `${board.name}: ${result.statement}`);
    assert.equal(result.board.name, board.name);
    assert.equal(result.board.borough, board.borough);
    assert.equal(result.meeting.board_name, board.name);
    assert.equal(result.meeting.convening_body, "full_board");
    assert.match(result.meeting.meeting_day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(result.meeting.meeting_day <= AS_OF, "the meeting reported as held is not in the future");
    assert.match(result.meeting.source.source_url, /^https:\/\//);
    assert.match(result.meeting.source.observed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(result.statement.includes(board.name));
    assert.ok(result.statement.includes(result.meeting.meeting_day));
  }
});

test("an answered meeting states whether the corpus holds its minutes", () => {
  for (const board of evaluated.boards) {
    const { meeting } = communityBoardFullBoardMeetingAnswer({ readModel, query: board.name, asOf: AS_OF });
    assert.ok(["held", "not_held"].includes(meeting.minutes.status));
    assert.ok(meeting.minutes.statement.length > 0, "minutes are stated in words, not left empty");
    if (meeting.minutes.status === "not_held") {
      assert.ok(meeting.minutes.reason, "an unheld minutes record says why it is not held");
      assert.deepEqual(meeting.minutes.documents, []);
    } else {
      assert.ok(meeting.minutes.document_count > 0);
    }
  }
});

test("a committee meeting is never returned in place of a full board one", () => {
  for (const board of evaluated.boards) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel, query: board.name, asOf: AS_OF });
    const boardRows = readModel.rows
      .filter((row) => row.source_system === "community_board" && row.board_id === result.board.id)
      .filter((row) => String(row.event_date).slice(0, 10) <= AS_OF)
      .sort((left, right) => String(right.event_date).localeCompare(String(left.event_date)));
    assert.ok(boardRows.length > 1, "the board publishes more than one kind of meeting");
    assert.notEqual(classifyCommunityBoardConveningBody(boardRows[0]), "full_board");
    assert.equal(result.meeting.meeting_id, boardRows.find(
      (row) => classifyCommunityBoardConveningBody(row) === "full_board",
    ).meeting_id);
  }
});

test("every returned full board meeting belongs to the board that was asked about", () => {
  for (const row of coverage) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel, query: row.board_id, asOf: AS_OF });
    assert.equal(result.board.id, row.board_id);
    if (result.meeting) assert.equal(result.meeting.board_id, row.board_id);
  }
});

test("a board number without a borough resolves to no board rather than a neighbour's", () => {
  for (const board of evaluated.boards) {
    const bare = communityBoardFullBoardMeetingAnswer({ readModel, query: `Community Board ${board.district}`, asOf: AS_OF });
    assert.equal(bare.status, "board_query_unresolved");
    assert.equal(bare.board, null);
    assert.equal(bare.meeting, null);
    // The same board number in another borough is a different board. Every one
    // of them must resolve to itself, which is the confusion a bare number
    // invites and the reason an unqualified number resolves to nothing.
    const sameNumber = coverage.filter((row) => row.community_district?.slice(1) === String(board.district).padStart(2, "0"));
    assert.ok(sameNumber.length > 1, "more than one borough has a board with this number");
    for (const sibling of sameNumber) {
      assert.equal(resolveCommunityBoardQuery(sibling.board_name, coverage).board_id, sibling.board_id);
    }
  }
});

test("a board outside the covered set says it is not covered", () => {
  const uncovered = boardsInState("not-registered");
  assert.ok(uncovered.length >= 1, "the corpus publishes no meeting source for at least one board");
  for (const row of uncovered) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel, query: row.board_name, asOf: AS_OF });
    assert.equal(result.status, "board_not_covered");
    assert.equal(result.meeting, null);
    assert.equal(result.board.id, row.board_id);
    assert.match(result.statement, /publishes no meeting source/);
    assert.ok(!/\b0\b/.test(result.statement), "an uncovered board is never reported as a zero");
  }
  const absent = communityBoardFullBoardMeetingAnswer({ readModel, query: "Manhattan Community Board 44", asOf: AS_OF });
  assert.equal(absent.status, "board_not_covered");
  assert.equal(absent.reason, "board_is_not_in_the_published_board_set");
  assert.equal(absent.meeting, null);
});

test("a board whose source could not be read says so, and says something different", () => {
  const unreadable = boardsInState("unreadable");
  assert.ok(unreadable.length >= 1, "at least one board publishes a source this corpus cannot read");
  const uncoveredStatus = communityBoardFullBoardMeetingAnswer({
    readModel, query: boardsInState("not-registered")[0].board_name, asOf: AS_OF,
  }).status;
  for (const row of unreadable) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel, query: row.board_name, asOf: AS_OF });
    assert.equal(result.status, "board_source_unreadable");
    assert.notEqual(result.status, uncoveredStatus);
    assert.equal(result.meeting, null);
    assert.equal(result.coverage.meetings.state, "unreadable");
    assert.match(result.statement, /could not read/);
  }
});

test("a lens that could not be read says so rather than answering emptily", () => {
  for (const broken of [
    null,
    { schema: "cityscroll.shared_meeting_read_model.v1", rows: [], sources: {} },
    { ...readModel, sources: { ...readModel.sources, community_board: { ...readModel.sources.community_board, status: "unavailable" } } },
  ]) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel: broken, query: "Manhattan Community Board 1", asOf: AS_OF });
    assert.equal(result.status, "lens_unreadable");
    assert.equal(result.meeting, null);
    assert.equal(result.board, null);
    assert.match(result.statement, /could not be read/);
  }
});

test("every answer is one of the declared states and never an empty record", () => {
  for (const row of coverage) {
    const result = communityBoardFullBoardMeetingAnswer({ readModel, query: row.board_name, asOf: AS_OF });
    assert.ok(COMMUNITY_BOARD_FULL_BOARD_ANSWER_STATES.includes(result.status));
    assert.ok(result.statement.length > 0);
    if (result.status !== "full_board_meeting") assert.equal(result.meeting, null);
  }
});

test("the meetings corpus carries one coverage row per inventoried board", () => {
  assert.equal(coverage.length, inventory.boards.length);
  assert.deepEqual(
    coverage.map((row) => row.board_id).sort(),
    inventory.boards.map((board) => board.id).sort(),
  );
  for (const row of coverage) {
    for (const role of ["meetings", "minutes"]) {
      assert.ok(["indexed", "checked-empty", "unreadable", "not-registered"].includes(row[role].state));
      if (row[role].state !== "not-registered") assert.match(row[role].source_url, /^https:\/\//);
      if (row[role].state === "indexed") assert.match(row[role].observed_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  }
});

test("retained publisher snapshots name their capture, its time and its digest", () => {
  const snapshots = [...readRetainedCommunityBoardSnapshots().values()];
  assert.ok(snapshots.length >= 1);
  for (const snapshot of snapshots) {
    assert.deepEqual(checkRetainedCommunityBoardSnapshot(snapshot), []);
    const row = coverage.find((entry) => entry.board_id === snapshot.board_id);
    const role = snapshot.source_role === "minutes" ? row.minutes : row.meetings;
    assert.equal(role.state, "indexed");
    assert.equal(role.observed_at, snapshot.retention.captured_at);
    assert.equal(role.retained_snapshot.content_sha256, snapshot.retention.content_sha256);
  }
});

test("the published answers are a materialization of the committed read model", () => {
  const rebuilt = buildCommunityBoardFullBoardMeetings(readModel);
  assert.deepEqual(published, rebuilt);
  assert.equal(published.counts.boards, coverage.length);
  assert.equal(
    published.counts.boards,
    Object.values(published.counts).reduce((total, count) => total + count, 0) - published.counts.boards,
  );
  for (const board of evaluated.boards) {
    const answer = published.boards.find((row) => row.board?.name === board.name);
    assert.equal(answer.status, "full_board_meeting");
    assert.equal(answer.meeting.convening_body, "full_board");
    assert.match(answer.meeting.source.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  }
});
