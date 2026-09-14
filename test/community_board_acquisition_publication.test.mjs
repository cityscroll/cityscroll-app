import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import {
  buildCommunityBoardMeetingIndex,
} from "../tools/build_community_board_meeting_index.mjs";

const OBSERVED_AT = "2026-09-14T12:00:00.000Z";
const BOARD_IDS = [
  "bronx-cb-01", "bronx-cb-02", "brooklyn-cb-01", "manhattan-cb-01",
  "queens-cb-01", "staten-island-cb-01", "manhattan-cb-02",
];

function inventory({ format = "ics", verification = {} } = {}) {
  return {
    boards: BOARD_IDS.map((id) => ({
      id,
      name: `${id} board`,
      borough: id.split("-")[0],
      upcoming: {
        adapter: "google_calendar_v1",
        format,
        url: `https://${id}.sources.example/calendar.ics`,
        verification,
      },
      minutes: {},
    })),
  };
}

function registry() {
  return { sources: BOARD_IDS.map((body_id) => ({ body_id, body_type: "community_board", name: body_id })) };
}

function committeeRegistry() {
  return { committees: [] };
}

function icsFor(id, { title = "Full Board Meeting", date = "2026-09-21", time = "180000" } = {}) {
  return `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:${id}-meeting\nDTSTART;TZID=America/New_York:${date.replaceAll("-", "")}T${time}\nSUMMARY:${title}\nLOCATION:${id} civic center\nEND:VEVENT\nEND:VCALENDAR`;
}

function response(body, contentType = "text/calendar", status = 200) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer,
  };
}

function fetchAll({ failing = new Set(), titles = new Map(), empty = new Set() } = {}) {
  return async (url) => {
    const id = String(url).match(/https:\/\/([^/.]+)\.sources\.example/)?.[1];
    if (failing.has(id)) return response("", "text/calendar", 503);
    if (empty.has(id)) return response("BEGIN:VCALENDAR\nEND:VCALENDAR");
    return response(icsFor(id, { title: titles.get(id) || "Full Board Meeting" }));
  };
}

function buildOptions(overrides = {}) {
  return {
    observedAt: OBSERVED_AT,
    transportOptions: { minOriginIntervalMs: 0 },
    inventory: overrides.inventory?.boards ? overrides.inventory : inventory(overrides.inventory),
    registry: registry(),
    committeeRegistry: committeeRegistry(),
    ...overrides,
  };
}

function readBack(index, now = OBSERVED_AT) {
  return buildSharedMeetingReadModel({
    communityBoardIndex: index,
    generatedAt: index.generated_at,
    now,
  });
}

test("successful publication admits all seven boards and resident read-back has the same records", async () => {
  const index = await buildCommunityBoardMeetingIndex({
    ...buildOptions(),
    fetchImpl: fetchAll(),
  });
  const model = readBack(index);
  const rows = model.rows.filter((row) => row.source_system === "community_board");

  assert.equal(index.coverage.boards_in_inventory, 7);
  assert.equal(new Set(rows.map((row) => row.board_id)).size, 7);
  assert.equal(rows.length, index.rows.length);
  assert.deepEqual(
    new Set(rows.map((row) => row.meeting_id)),
    new Set(index.rows.map((row) => row.meeting_id)),
  );
  assert.ok(rows.every((row) => row.source_url.endsWith(".sources.example/calendar.ics")));
  assert.ok(rows.every((row) => row.event_date === "2026-09-21T18:00:00-04:00"));
  assert.equal(model.sources.community_board.status, "available");
});

test("partial required-child acquisition is unavailable, not a parent-only success", async () => {
  const base = { boards: inventory().boards.slice(0, 1) };
  base.boards[0].upcoming = {
    adapter: "google_calendar_v1",
    format: "calendar HTML with required child",
    required_child: true,
    url: "https://sources.example/bronx-cb-01/calendar.html",
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("calendar.html")) {
      return response('<iframe src="https://calendar.google.com/calendar/embed?src=board%40example.test"></iframe>', "text/html");
    }
    return response("", "text/calendar", 503);
  };
  const index = await buildCommunityBoardMeetingIndex({
    ...buildOptions({ inventory: base }),
    fetchImpl,
  });
  const receipt = index.receipts.find((row) => row.board_id === "bronx-cb-01" && row.role === "upcoming_meetings");
  assert.equal(receipt.state, "unavailable");
  assert.equal(receipt.observed_receipt.acquisition.complete, false);
  assert.equal(index.rows.filter((row) => row.board_id === "bronx-cb-01").length, 0);
});

test("failed refresh retains last-good records and marks the role unavailable without duplicates", async () => {
  const first = await buildCommunityBoardMeetingIndex({
    ...buildOptions(),
    fetchImpl: fetchAll(),
  });
  const repeated = await buildCommunityBoardMeetingIndex({
    ...buildOptions(),
    previousIndex: first,
    fetchImpl: fetchAll(),
  });
  assert.equal(repeated.rows.length, 7, "identical content on refresh remains one record per admitted board");
  assert.equal(new Set(repeated.rows.map((row) => row.meeting_id)).size, repeated.rows.length);

  const second = await buildCommunityBoardMeetingIndex({
    ...buildOptions({ inventory: inventory() }),
    previousIndex: first,
    fetchImpl: fetchAll({ failing: new Set(["bronx-cb-01"]) }),
  });
  const retained = second.rows.filter((row) => row.board_id === "bronx-cb-01");
  const receipt = second.receipts.find((row) => row.board_id === "bronx-cb-01" && row.role === "upcoming_meetings");

  assert.equal(retained.length, 1);
  assert.equal(new Set(retained.map((row) => row.meeting_id)).size, retained.length);
  assert.equal(receipt.state, "unavailable");
  assert.equal(retained[0].source_refresh.status, "unavailable");
  assert.equal(retained[0].source_refresh.receipt.reason, "http_error");
});

test("stale and genuinely empty states remain distinct, and closures are not admitted as meetings", async () => {
  const staleInventory = inventory({ verification: { status: "stale" } });
  const stale = await buildCommunityBoardMeetingIndex({
    ...buildOptions({ inventory: staleInventory }),
    fetchImpl: fetchAll(),
  });
  const empty = await buildCommunityBoardMeetingIndex({
    ...buildOptions(),
    fetchImpl: fetchAll({ empty: new Set(["bronx-cb-01"]) }),
  });
  const staleReceipt = stale.receipts.find((row) => row.board_id === "bronx-cb-01" && row.role === "upcoming_meetings");
  const emptyReceipt = empty.receipts.find((row) => row.board_id === "bronx-cb-01" && row.role === "upcoming_meetings");
  const emptyModel = readBack(empty);

  assert.equal(staleReceipt.state, "stale");
  assert.equal(stale.board_coverage.find((row) => row.board_id === "bronx-cb-01").meetings.state, "unreadable");
  assert.equal(emptyReceipt.state, "checked-empty");
  assert.equal(empty.board_coverage.find((row) => row.board_id === "bronx-cb-01").meetings.state, "checked-empty");
  assert.equal(emptyModel.sources.community_board.status, "available");
  assert.equal(emptyModel.sources.community_board.board_coverage.find((row) => row.board_id === "bronx-cb-01").meetings.state, "checked-empty");

  const cancelled = await buildCommunityBoardMeetingIndex({
    ...buildOptions(),
    fetchImpl: fetchAll({ titles: new Map([["bronx-cb-01", "Board meeting cancelled"]]) }),
  });
  assert.equal(cancelled.rows.filter((row) => row.board_id === "bronx-cb-01").length, 1);
  assert.equal(cancelled.rows[0].title, "Board meeting cancelled");
  assert.deepEqual(cancelled.rows[0].participation.links, []);
});
