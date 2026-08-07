import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildScorecard, formatLastMinutes, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url), "utf8"));

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
