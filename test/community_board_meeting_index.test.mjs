import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";

const index = JSON.parse(readFileSync(new URL("../site/data/community_board_meeting_index.json", import.meta.url), "utf8"));

test("community board meeting index is a bounded receipt-backed slice", () => {
  assert.equal(index.schema, "cityscroll.community_board_meeting_index.v1");
  assert.equal(index.coverage.boards_in_inventory, 59);
  assert.equal(index.coverage.boards_indexed, 9);
  assert.equal(index.coverage.records_indexed, index.rows.length);
  assert.ok(index.rows.length >= 1);
  assert.equal(index.policy.no_title_or_date_inference, true);
  assert.equal(index.policy.unjoined_records_are_not_official, true);
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
