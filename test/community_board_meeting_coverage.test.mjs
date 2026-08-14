import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCommunityBoardMeetingIndex,
  classifyCommunityBoardSourceRole,
  COMMUNITY_BOARD_SOURCE_STATES,
} from "../tools/build_community_board_meeting_index.mjs";

function responseFor(url, { duplicate = false } = {}) {
  const id = duplicate ? "same-publisher-id" : `${url}#publisher-event`;
  const duplicateDocuments = duplicate
    ? `<a data-record-id="${id}" data-date="2026-09-11" href="${url}#minutes-1.pdf">Minutes one</a><a data-record-id="${id}" data-date="2026-09-12" href="${url}#minutes-2.pdf">Minutes two</a>`
    : `<a data-record-id="${duplicate ? id : `${url}#document`}" data-date="2026-09-11" href="${url}#minutes.pdf">Minutes</a>`;
  const html = `<script type="application/ld+json">${JSON.stringify([{
    "@type": "Event",
    identifier: id,
    name: "Board meeting",
    url: `${url}#event`,
    startDate: "2026-09-10T18:00:00-04:00",
  }])}</script>${duplicateDocuments}`;
  const bytes = new TextEncoder().encode(html);
  return { ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => bytes.buffer };
}

test("the coverage builder accounts for both roles across all 59 boards", async () => {
  const index = await buildCommunityBoardMeetingIndex({
    observedAt: "2026-08-14T12:00:00Z",
    fetchImpl: async (url) => responseFor(url),
  });

  assert.equal(index.coverage.boards_in_inventory, 59);
  assert.equal(index.coverage.source_roles_total, 118);
  assert.equal(index.receipts.length, 118);
  assert.equal(new Set(index.receipts.map((row) => row.board_id)).size, 59);
  assert.deepEqual(
    index.receipts.reduce((counts, row) => {
      counts[row.state] = (counts[row.state] || 0) + 1;
      return counts;
    }, {}),
    { indexed: 61, "checked-empty": 32, unavailable: 5, "not-yet-checked": 20 },
  );
  assert.equal(index.coverage.records_indexed, index.rows.length);
  assert.ok(index.rows.every((row) => row.source_role === "upcoming_meetings"));
  assert.ok(Object.values(index.source_records_by_board).flat().some((row) => row.source_role === "minutes"));
  assert.ok(Object.values(index.source_records_by_board).flat().every((row) => (
    row.board_id && row.body_id && row.source_record_id && row.date
      && row.source_url?.startsWith("https://")
      && row.observed_receipt?.status === "ok"
  )));
});

test("source states remain explicit for unsupported, stale, and absent roles", () => {
  assert.deepEqual(COMMUNITY_BOARD_SOURCE_STATES, [
    "indexed", "checked-empty", "unsupported-format", "unavailable", "stale", "not-yet-checked",
  ]);
  assert.equal(classifyCommunityBoardSourceRole({ url: "https://example.test/source", format: "spreadsheet" }, { receipt: { status: "ok" } }, [], "2026-08-14T00:00:00Z"), "unsupported-format");
  assert.equal(classifyCommunityBoardSourceRole({ url: "https://example.test/source", format: "html", verification: { status: "stale" } }, { receipt: { status: "ok" } }, [], "2026-08-14T00:00:00Z"), "stale");
  assert.equal(classifyCommunityBoardSourceRole({ url: null, format: null }, { receipt: { status: "unknown" } }, [], "2026-08-14T00:00:00Z"), "not-yet-checked");
});

test("duplicate publisher identifiers within a board fail the build", async () => {
  await assert.rejects(
    buildCommunityBoardMeetingIndex({
      observedAt: "2026-08-14T12:00:00Z",
      fetchImpl: async (url) => responseFor(url, { duplicate: true }),
    }),
    /duplicate publisher identifier within board/,
  );
});
