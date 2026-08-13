import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildScorecard, formatLastMinutes, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url), "utf8"));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url), "utf8"));

test("scorecard lists every community board and never invents a minutes URL", () => {
  const scorecard = buildScorecard({ registry });
  assert.equal(scorecard.schema, "cityscroll.community_board_minutes_scorecard.v1");
  assert.equal(scorecard.rows.length, 59);
  assert.equal(scorecard.coverage.measured, 0);
  assert.ok(scorecard.rows.every((row) => row.minutes_url === null || row.minutes_url === registry.sources.find((source) => source.body_id === row.body_id).source_url));
  assert.deepEqual(scorecard.rows.map((row) => row.body_id), [...scorecard.rows].sort((a, b) => a.borough.localeCompare(b.borough) || a.district - b.district).map((row) => row.body_id));
});

test("detector dates produce deterministic age and ranking", () => {
  const scorecard = buildScorecard({
    registry,
    observedOn: "2026-08-04",
    detector: { schema: "cityscroll.community_board_minutes_gap_detector.v1", as_of: "2026-08-04", rows: [
      { body_id: "bronx-cb-01", last_minutes_date: "2026-08-01", receipts: [{ kind: "probe", path: "probe.json" }] },
      { body_id: "bronx-cb-02", last_minutes_date: "2026-07-01", receipts: [{ kind: "probe", path: "probe.json" }] },
    ] },
  });
  assert.equal(scorecard.coverage.measured, 2);
  assert.equal(scorecard.rows.find((row) => row.body_id === "bronx-cb-01").days_since_last_minutes, 3);
  assert.equal(scorecard.rows.find((row) => row.body_id === "bronx-cb-01").rank, 1);
  assert.equal(formatLastMinutes("2026-03-01", 156), "Last published minutes: March 2026 — 5 months ago");
  assert.match(renderScorecardPage(scorecard), /Machine-readable JSON/);
});

test("board source inventory keeps explicit roles and honest collection states", () => {
  assert.equal(sourceInventory.schema, "cityscroll.community_board_source_inventory.v1");
  assert.equal(sourceInventory.coverage.boards, 59);
  const scorecard = buildScorecard({ registry, sourceInventory });
  assert.equal(scorecard.rows.length, 59);
  const cb3 = scorecard.rows.find((row) => row.body_id === "manhattan-cb-03");
  assert.equal(cb3.sources.upcoming_meetings.collection_state, "observed");
  assert.equal(cb3.sources.minutes.collection_state, "not_yet_ingested");
  assert.equal(cb3.sources.minutes.source_url, "https://www.nyc.gov/site/manhattancb3/minutes/meeting-vote-records.page");
  assert.equal(cb3.sources.upcoming_meetings.source_url, "https://www.nyc.gov/site/manhattancb3/calendar/calendar.page");

  const joined = buildScorecard({
    registry,
    sourceInventory,
    joinedLookup: { notices: { n1: { body_id: "manhattan-cb-03" } } },
  }).rows.find((row) => row.body_id === "manhattan-cb-03");
  assert.equal(joined.sources.minutes.collection_state, "joined");

  const absent = scorecard.rows.find((row) => row.body_id === "bronx-cb-08");
  assert.equal(absent.sources.upcoming_meetings.collection_state, "absent_in_pass");
  assert.equal(absent.sources.minutes.collection_state, "absent_in_pass");
  const html = renderScorecardPage(scorecard);
  assert.match(html, /Official source inventory/);
  assert.match(html, /The City Comptroller <a href="https:\/\/comptroller\.nyc\.gov\/reports\/audit-report-on-the-twelve-manhattan-community-boards-compliance-with-new-york-city-charter-and-new-york-city-administrative-code-requirements-for-public-meetings-and-hearings-and-for-web\/">has recommended<\/a> that community boards post minutes from the past 12 months\./);
  assert.match(html, /Source available/);
  assert.doesNotMatch(html, /Source found; records not yet ingested/);
  assert.doesNotMatch(html, /Not verified in this pass/);
  assert.doesNotMatch(html, /Public accountability|What the public record expects|How to read these sources|dated minutes freshness receipts|No dated checks are available yet|in this pass/);
  assert.doesNotMatch(html, /no official meeting exists/i);
  assert.match(html, /Board-linked third-party storage/);
  const readerCopy = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(readerCopy, /upcoming_meetings|not_yet_ingested|absent_in_pass/);
});
