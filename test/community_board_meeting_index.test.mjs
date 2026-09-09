import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { readCommunityBoardMeetingIndex } from "../tools/lib/community_board_meeting_index_io.mjs";
import { buildCommunityBoardMeetingIndex, rematerializeCommunityBoardMeetingIndex } from "../tools/build_community_board_meeting_index.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import edgeWorker, { isMeetingDocumentHtml } from "../site/pages_edge.mjs";

const index = readCommunityBoardMeetingIndex(new URL("../site/data/community_board_meeting_index.json", import.meta.url));
const recovery = JSON.parse(readFileSync(new URL("./fixtures/community_board_meeting_recovery.json", import.meta.url)));
const recoveryOptions = {
  inventory: { boards: [recovery.board] },
  registry: { sources: [] },
  committeeRegistry: {},
  retainedSnapshots: new Map(),
};
const previousIndex = {
  generated_at: recovery.source_record.observed_receipt.observed_at,
  source_records_by_board: { [recovery.board.id]: [recovery.source_record] },
};

test("publisher 403 and timeout preserve the published meeting, original evidence and working route", async () => {
  for (const fetchImpl of [
    async () => new Response("Forbidden", { status: 403 }),
    async () => { throw new DOMException("Publisher timed out", "TimeoutError"); },
  ]) {
    const failed = await buildCommunityBoardMeetingIndex({
      ...recoveryOptions, previousIndex, fetchImpl, observedAt: recovery.provenance.failed_read_at,
    });
    assert.equal(failed.rows.length, 1, "an unreadable source cannot erase its published meeting");
    const row = failed.rows[0];
    assert.equal(row.meeting_id, `meeting:community_board:${recovery.source_record.record_id}`);
    assert.deepEqual(row.source_receipt, recovery.source_record.observed_receipt);
    assert.equal(row.start_date, recovery.source_record.observed_receipt.observed_at);
    assert.equal(row.source_refresh.status, "unavailable");
    assert.equal(row.source_refresh.receipt.status, "unknown", "the failed receipt retains its own schema semantics");
    assert.equal(row.source_refresh.observed_at, recovery.provenance.failed_read_at);
    assert.equal(failed.board_coverage[0].meetings.state, "unreadable");
    assert.equal(failed.board_coverage[0].meetings.record_count, 1);
    assert.equal(failed.receipts[0].state, "unavailable");
    assert.equal(failed.receipts[0].retained_previous_records, 1);

    // The second outage and offline rebuild must not re-date or discard evidence.
    const again = await buildCommunityBoardMeetingIndex({
      ...recoveryOptions, previousIndex: failed, fetchImpl, observedAt: "2026-09-09T16:51:00.000Z",
    });
    const rebuilt = rematerializeCommunityBoardMeetingIndex({ ...recoveryOptions, committed: again });
    assert.deepEqual(rebuilt.receipts, again.receipts);
    assert.deepEqual(rebuilt.rows[0].source_receipt, row.source_receipt);
    assert.equal(rebuilt.rows[0].start_date, row.start_date);
    const model = buildSharedMeetingReadModel({ communityBoardIndex: rebuilt, now: rebuilt.generated_at });
    const env = { ASSETS: { fetch: async () => new Response(JSON.stringify(model)) } };
    const path = `https://cityscroll.org/meetings/${encodeURIComponent(row.meeting_id)}/`;
    const response = await edgeWorker.fetch(new Request(path), env);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(isMeetingDocumentHtml(html, row.meeting_id), true);
    assert.match(html, /Transportation &amp; Health Committees/);
    assert.match(html, /The board’s website could not be checked/);
    assert.match(html, /Showing the last published meeting details/);
    const missing = await edgeWorker.fetch(new Request(path), {
      ASSETS: { fetch: async () => new Response(JSON.stringify({ ...model, rows: [] })) },
    });
    assert.equal(missing.status, 404, "removing only the row reproduces the original route failure");
  }
});

test("a successful publisher recovery replaces retained records and clears the failure notice", async () => {
  const failed = await buildCommunityBoardMeetingIndex({
    ...recoveryOptions, previousIndex, observedAt: recovery.provenance.failed_read_at,
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
  });
  const recovered = await buildCommunityBoardMeetingIndex({
    ...recoveryOptions, previousIndex: failed, observedAt: "2026-09-09T17:00:00.000Z",
    fetchImpl: async () => new Response(`<script type="application/ld+json">${JSON.stringify({
      "@type": "Event", name: "Updated meeting", url: recovery.source_record.record_url,
      startDate: "2026-10-16T18:30:00-04:00",
    })}</script>`),
  });
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.rows[0].title, "Updated meeting");
  assert.equal(recovered.rows[0].event_date, "2026-10-16T18:30:00-04:00");
  assert.equal(recovered.rows[0].source_refresh, undefined);
  assert.equal(recovered.receipts[0].state, "indexed");
  assert.equal(recovered.receipts[0].retained_previous_records, undefined);
});

test("successful empty reads replace prior records; failed reads never borrow another source or role", async () => {
  const empty = await buildCommunityBoardMeetingIndex({
    ...recoveryOptions, previousIndex, observedAt: recovery.provenance.failed_read_at,
    fetchImpl: async () => new Response("<html><body>No published events</body></html>"),
  });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.receipts[0].state, "checked-empty");
  assert.equal(empty.receipts[0].retained_previous_records || 0, 0);
  for (const change of [ { source_url: "https://example.gov/other-calendar" }, { source_role: "minutes" }, { board_id: "bronx-cb-07" } ]) {
    const result = await buildCommunityBoardMeetingIndex({
      ...recoveryOptions, observedAt: recovery.provenance.failed_read_at,
      previousIndex: { ...previousIndex, source_records_by_board: { [recovery.board.id]: [{ ...recovery.source_record, ...change }] } },
      fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    });
    assert.equal(result.rows.length, 0);
  }
});

test("community board meeting index reports receipt-backed coverage for every board role", () => {
  assert.equal(index.schema, "cityscroll.community_board_meeting_index.v1");
  assert.equal(index.coverage.boards_in_inventory, 59);
  assert.equal(index.coverage.source_roles_total, 118);
  assert.equal(index.receipts.length, 118);
  assert.equal(new Set(index.receipts.map((row) => row.board_id)).size, 59);
  assert.ok(index.coverage.boards_indexed >= 1);
  assert.equal(index.coverage.records_indexed, index.rows.length);
  assert.ok(index.rows.length >= 1);
  assert.equal(index.policy.no_title_or_date_inference, true);
  assert.equal(index.policy.unjoined_records_are_not_official, true);
  assert.deepEqual(index.policy.source_role_states, [
    "indexed", "checked-empty", "unsupported-format", "unavailable", "stale", "not-yet-checked",
  ]);
});

test("every indexed event carries source provenance and remains unjoined", () => {
  for (const row of index.rows) {
    assert.equal(row.source_system, "community_board", row.request_id);
    assert.ok(row.source_record_id, row.request_id);
    assert.ok(/^https:\/\//.test(row.source_url), row.request_id);
    assert.ok(row.source_provenance?.source_url, row.request_id);
    assert.equal(row.source_provenance?.observed_receipt?.status, "ok", row.request_id);
    assert.equal(row.meeting_join?.official, false, row.request_id);
    assert.equal(row.meeting_join?.join?.matched, false, row.request_id);
    assert.equal(row.meeting_join?.join?.method, "exact_board_date_publisher_identifier", row.request_id);
  }
});

test("Browse renders an indexed board event as a source-linked meeting record", () => {
  const row = index.rows[0];
  const view = buildBrowseView("meetings", { retrieved_at: index.generated_at, rows: [row] });
  const html = renderBrowseView(view);
  assert.match(html, new RegExp(row.source_url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Community board source observed/);
  assert.match(html, /data-meeting-origin="community_board_source_observed"/);
});
