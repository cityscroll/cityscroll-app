import test from "node:test";
import assert from "node:assert/strict";
import { compileSub } from "../worker/src/lib/compile.mjs";
import {
  COMMUNITY_BOARD_WATCH_STATUS,
  evaluateMeetingTextQueryWatch,
} from "../worker/src/lib/watch_text_query_meetings.mjs";

const TODAY = "2026-09-01";
const BOARD = "community-board:brooklyn-cb-15";
const term = (value) => ({ kind: "term", value });
const expression = { version: 1, all: [[term("shelter")]] };
const snapshotRows = [
  { meeting_id: "meeting:cb15", board_id: "brooklyn-cb-15", event_date: "2026-09-29", title: "Shelter discussion", description: "Public shelter agenda" },
  { meeting_id: "meeting:cb14", board_id: "brooklyn-cb-14", event_date: "2026-09-29", title: "Shelter discussion" },
  { meeting_id: "meeting:borough", event_date: "2026-09-29", title: "Shelter discussion", description: "Borough-wide body" },
  { meeting_id: "meeting:cb15-other", board_id: "brooklyn-cb-15", event_date: "2026-09-30", title: "Transportation", description: "No matching subject" },
];

function kvFor(rows, failure = null) {
  return {
    async get(key) {
      if (failure) throw failure;
      if (key === "route-read-model:meetings:manifest:v1") {
        return JSON.stringify({ schema_version: 1, kind: "meetings", version: "snapshot-1", slices: { "2026-09": "meetings-2026-09" } });
      }
      if (key === "meetings-2026-09") return JSON.stringify({ rows });
      return null;
    },
  };
}

function sub(filter = {}) {
  return { lens: "meetings", filter: { communityBoard: BOARD, ...filter } };
}

test("A1-A3: exact board edge and text predicate produce identical preview and delivery IDs", async () => {
  const watch = sub({ text_query: expression });
  const compiled = compileSub(watch, TODAY);
  assert.equal(compiled.routeReadModel.kind, "meetings");
  assert.equal(compiled.routeReadModel.communityBoard, BOARD);
  const previewEvaluation = await evaluateMeetingTextQueryWatch({
    sub: watch,
    todayISO: TODAY,
    sourceRows: snapshotRows,
  });
  const preview = previewEvaluation.rows;
  const deliveryEvaluation = await evaluateMeetingTextQueryWatch({
    sub: watch,
    todayISO: TODAY,
    env: { ALERT_STATE: kvFor(snapshotRows) },
  });
  const delivery = deliveryEvaluation.rows;
  assert.deepEqual(preview.map((row) => row.meeting_id), ["meeting:cb15"]);
  assert.deepEqual(delivery.map((row) => row.meeting_id), preview.map((row) => row.meeting_id));
});

test("A4: unknown identity, unavailable materialization, and failed loading remain distinct", async () => {
  const unknown = await evaluateMeetingTextQueryWatch({
    sub: { lens: "meetings", filter: { communityBoard: "community-board:brooklyn-cb-99", text_query: expression } },
    todayISO: TODAY,
  });
  const unavailable = await evaluateMeetingTextQueryWatch({ sub: sub({ text_query: expression }), todayISO: TODAY, env: { ALERT_STATE: { async get() { return null; } } } });
  const failed = await evaluateMeetingTextQueryWatch({ sub: sub({ text_query: expression }), todayISO: TODAY, env: { ALERT_STATE: kvFor([], new Error("read failed")) } });
  assert.equal(unknown.reason, COMMUNITY_BOARD_WATCH_STATUS.unknownBoard);
  assert.equal(unavailable.reason, COMMUNITY_BOARD_WATCH_STATUS.unavailable);
  assert.equal(failed.reason, COMMUNITY_BOARD_WATCH_STATUS.failed);
  assert.notEqual(unknown.status, "complete");
  assert.notEqual(unavailable.status, "complete");
  assert.notEqual(failed.status, "complete");
});
