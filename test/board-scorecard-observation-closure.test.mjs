/**
 * Board scorecard observation closure: 59-board dispositions, empty detector
 * honesty, and a newly collected dated observation advancing the numerator.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT } from "../tools/data_source_graph.mjs";
import {
  BOARD_DISPOSITIONS,
  buildMinutesGapDetector,
  classifyBoardDispositions,
  detectorRowFromProbe,
  scorecardRankings,
} from "../tools/board_scorecard_observation_closure.mjs";
import { buildScorecard, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("empty detector input is measurement unavailable and suppresses leaders and laggards", () => {
  const registry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const detector = buildMinutesGapDetector({ registry, probes: null });
  assert.equal(detector.measurement_available, false);
  assert.equal(detector.missing_input, true);
  assert.deepEqual(detector.rows, []);
  const scorecard = buildScorecard({ registry, detector });
  assert.equal(scorecard.coverage.boards, 59);
  assert.equal(scorecard.coverage.measurement_available, false);
  assert.equal(scorecard.rankings.leaders, null);
  assert.equal(scorecard.rankings.laggards, null);
  assert.equal(scorecard.rankings.suppressed, true);
  const html = renderScorecardPage(scorecard);
  assert.match(html, /Minutes measurement is unavailable/);
  assert.doesNotMatch(html, /0 leaders/i);
  assert.doesNotMatch(html, /0 laggards/i);
  assert.match(html, /does not mean boards published no minutes/);
  const suppressed = scorecardRankings(scorecard.rankings, { measurementAvailable: false });
  assert.equal(suppressed.leaders, null);
  assert.equal(suppressed.laggards, null);
});

test("all 59 boards receive a disposition tied to actual detector scope", () => {
  const registry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const probes = readJson("site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json");
  const detector = buildMinutesGapDetector({ registry, probes });
  const closure = classifyBoardDispositions({ registry, detector, probes });
  assert.equal(closure.boards, 59);
  assert.equal(closure.rows.length, 59);
  assert.equal(closure.measurement_available, true);
  for (const id of BOARD_DISPOSITIONS) assert.ok(id in closure.counts);
  assert.equal(Object.values(closure.counts).reduce((sum, value) => sum + value, 0), 59);
  assert.ok(closure.counts.measured >= 1);
  assert.ok(closure.rows.every((row) => BOARD_DISPOSITIONS.includes(row.disposition)));
  const scorecard = buildScorecard({ registry, detector });
  assert.equal(scorecard.rows.length, 59);
  assert.ok(scorecard.coverage.measured >= 1);
  assert.equal(scorecard.coverage.measurement_available, true);
  assert.ok(Array.isArray(scorecard.rankings.leaders));
  assert.ok(Array.isArray(scorecard.rankings.laggards));
  assert.ok(scorecard.rows.every((row) => BOARD_DISPOSITIONS.includes(row.observation_disposition)));
});

test("a newly collected dated observation advances the measured numerator and evidence revision", () => {
  const registry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const probes = readJson("site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json");
  const before = buildMinutesGapDetector({ registry, probes });
  const beforeClosure = classifyBoardDispositions({ registry, detector: before, probes });
  const target = registry.sources.find((row) => row.body_type === "community_board" && row.body_id === "bronx-cb-01");
  const nextProbes = {
    ...probes,
    generated_at: "2026-09-06T15:00:00.000Z",
    as_of: "2026-09-06",
    probes: probes.probes.map((probe) => {
      if (probe.body_id !== target.body_id) return probe;
      return {
        ...probe,
        fetched_at: "2026-09-06T15:00:00.000Z",
        observations: [
          { meeting_date: "2026-09-05", document_url: "https://www.nyc.gov/site/bronxcb1/minutes/2026-09-05.pdf", title: "September 5, 2026 Minutes" },
          ...probe.observations,
        ],
      };
    }),
  };
  const after = buildMinutesGapDetector({ registry, probes: nextProbes });
  const afterClosure = classifyBoardDispositions({ registry, detector: after, probes: nextProbes });
  assert.notEqual(after.evidence_revision, before.evidence_revision);
  assert.ok(afterClosure.counts.measured >= beforeClosure.counts.measured);
  const row = after.rows.find((item) => item.body_id === "bronx-cb-01");
  assert.equal(row.last_minutes_date, "2026-09-05");
  const scorecard = buildScorecard({ registry, detector: after });
  assert.equal(scorecard.coverage.measured, afterClosure.counts.measured);
  assert.equal(scorecard.evidence_revision, after.evidence_revision);
});

test("failed collection and checked-no-dated-observation stay distinct from unmeasured", () => {
  const failed = detectorRowFromProbe({
    body_id: "fixture-cb-fail",
    status: "http_error",
    observations: [],
  }, { body_id: "fixture-cb-fail" });
  assert.equal(failed.last_minutes_date, null);
  const registry = {
    sources: [
      { body_id: "fixture-cb-fail", body_type: "community_board", name: "Fail", borough: "Bronx", district: 1 },
      { body_id: "fixture-cb-empty", body_type: "community_board", name: "Empty", borough: "Bronx", district: 2 },
      { body_id: "fixture-cb-skip", body_type: "community_board", name: "Skip", borough: "Bronx", district: 3 },
    ],
  };
  const detector = {
    schema: "cityscroll.community_board_minutes_gap_detector.v1",
    missing_input: false,
    rows: [
      { body_id: "fixture-cb-fail", last_minutes_date: null },
      { body_id: "fixture-cb-empty", last_minutes_date: null },
    ],
  };
  const probes = {
    probes: [
      { body_id: "fixture-cb-fail", status: "http_error", observations: [] },
      { body_id: "fixture-cb-empty", status: "ok", observations: [] },
    ],
  };
  const closure = classifyBoardDispositions({ registry, detector, probes });
  assert.equal(closure.rows.find((row) => row.body_id === "fixture-cb-fail").disposition, "failed-collection");
  assert.equal(closure.rows.find((row) => row.body_id === "fixture-cb-empty").disposition, "checked-no-dated-observation");
  assert.equal(closure.rows.find((row) => row.body_id === "fixture-cb-skip").disposition, "unmeasured");
});
