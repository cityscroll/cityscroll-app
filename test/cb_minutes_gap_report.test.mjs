import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import { buildScorecard, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const receipt = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json", import.meta.url)));
const report = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/cb_minutes_gap_report.json", import.meta.url)));
const inventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const meetingIndex = JSON.parse(readFileSync(new URL("../site/data/community_board_meeting_index.json", import.meta.url)));

test("CB minutes report is a complete deterministic expected-set projection", () => {
  assert.equal(registry.sources.filter((row) => row.body_type === "community_board").length, 59);
  assert.equal(receipt.schema, "cityscroll.cb_minutes_publication_probe_receipt.v1");
  assert.equal(receipt.probes.length, 59);
  assert.equal(report.schema, "cityscroll.cb_minutes_gap_report.v1");
  assert.equal(report.rows.length, 59);
  assert.equal(report.expected_set.trailing_months, 12);
  assert.match(report.expected_set.mandate_source, /^https:\/\/comptroller\.nyc\.gov\//);
  assert.ok(report.rows.every((row) => row.body_id && ["a", "b"].includes(row.gap_class)));
});

test("missing registry URLs remain honest class-b empty probes", () => {
  const byId = new Map(receipt.probes.map((probe) => [probe.body_id, probe]));
  const rows = registry.sources.filter((row) => row.body_type === "community_board" && !row.source_url);
  assert.ok(rows.length > 0);
  for (const source of rows) {
    const probe = byId.get(source.body_id);
    assert.deepEqual(probe.observations, []);
    assert.equal(probe.url, null);
    assert.equal(report.rows.find((row) => row.body_id === source.body_id).gap_class, "b");
  }
});

test("collect rows have receipt-backed URL evidence", () => {
  const byId = new Map(receipt.probes.map((probe) => [probe.body_id, probe]));
  for (const source of registry.sources.filter((row) => row.body_type === "community_board" && row.status === "collect")) {
    const probe = byId.get(source.body_id);
    assert.equal(probe.url, source.source_url);
    assert.match(probe.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(probe.content_sha256, /^[a-f0-9]{64}$/);
  }
});

test("Manhattan CB3 official-calendar observations enter Meetings with visible coverage receipts", () => {
  const rows = meetingIndex.rows.filter((row) => row.board_id === "manhattan-cb-03"
    && ["2026-09-21", "2026-09-29"].includes(String(row.event_date).slice(0, 10)));
  assert.deepEqual(rows.map((row) => String(row.event_date).slice(0, 10)), ["2026-09-21", "2026-09-29"]);
  assert.ok(rows.every((row) => row.meeting_origin === "official_community_board_calendar"));
  assert.ok(rows.every((row) => row.source_url === "https://www.nyc.gov/site/manhattancb3/calendar/calendar.page"));
  assert.ok(rows.every((row) => row.observed_receipt?.status === "ok"));
  assert.ok(rows.every((row) => row.observed_receipt?.parser === "nyc_official_calendar_v1"));
  assert.ok(rows.every((row) => row.publisher_identifier === null));
  assert.ok(rows.every((row) => !Object.hasOwn(row, "vote") && !Object.hasOwn(row, "outcome")));

  const html = renderBrowseView(buildBrowseView("meetings", { generated_at: meetingIndex.generated_at, rows }));
  assert.match(html, /Official community board calendar/);
  assert.match(html, /Calendar observed/);
  assert.match(html, /Parser OK/);
  assert.match(html, /https:\/\/www\.nyc\.gov\/site\/manhattancb3\/calendar\/calendar\.page/);
});

test("boards without ingested calendar rows are labeled not ingested", () => {
  const scorecard = buildScorecard({ registry, sourceInventory: inventory, meetingIndex });
  const html = renderScorecardPage(scorecard);
  assert.ok(meetingIndex.receipts.some((row) => row.role === "upcoming_meetings" && row.state === "not-yet-checked"));
  assert.match(html, /Not ingested/);
});
