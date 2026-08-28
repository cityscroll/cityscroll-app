import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCommunityBoardMoneyComparison,
  buildCommunityBoardMoneyComparisons,
  validateCommunityBoardMoneyComparison,
} from "../site/community_board_money_comparison.mjs";
import { buildCommunityBoardMap, buildScorecard, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const money = JSON.parse(readFileSync(new URL("../site/data/community_board_money.json", import.meta.url), "utf8"));
const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url), "utf8"));
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"));
const boards = registry.sources
  .filter((row) => row.body_type === "community_board")
  .map((row) => ({ body_id: row.body_id, name: row.name, borough: row.borough, district: row.district }));

test("comparison projects every board from the canonical read model with explicit source years", () => {
  const comparison = buildCommunityBoardMoneyComparison(money, boards);
  assert.equal(validateCommunityBoardMoneyComparison(comparison).ok, true);
  assert.equal(comparison.rows.length, 59);
  assert.deepEqual(comparison.source_years, { budget: [2027], spending: [2026] });
  assert.equal(comparison.year_alignment, "separate_source_years");
  assert.equal(comparison.ranking.scope, "each_metric_only");
  assert.equal(comparison.coverage.source_as_of_exposed, true);
  assert.ok(comparison.rows.every((row) => row.dossier_href.startsWith("/community-boards/")));
  const known = comparison.rows.find((row) => row.board_id === "bronx-cb-01");
  assert.deepEqual(known.values, { adopted_budget: 366943, posted_amount: 95914.68, payment_count: 22, payee_count: 9 });
  assert.deepEqual(known.read_model_row_keys, { budget: "bronx-cb-01:2027", spending: "bronx-cb-01:2026" });
  assert.equal(comparison.boundaries.spending.source_vintage.payment_issue_date_through, "2026-06-30");
  const unmatched = comparison.rows.find((row) => row.board_id === "bronx-cb-03");
  assert.ok(unmatched.exclusions.includes("payment_identity_unobserved"));
  assert.equal(unmatched.values.posted_amount, null);
  assert.ok(comparison.rows.every((row) => !Object.hasOwn(row.values, "per_capita")));
});

test("exact fiscal-year views keep unavailable facts explicit and preserve all boards", () => {
  const projections = buildCommunityBoardMoneyComparisons(money, boards);
  assert.deepEqual(projections.available_keys, ["latest", "fy2026", "fy2027"]);
  assert.equal(projections.comparisons.fy2026.rows.length, 59);
  assert.equal(projections.comparisons.fy2026.coverage.rows_with_budget, 0);
  assert.equal(projections.comparisons.fy2027.coverage.rows_with_payments, 0);
  assert.equal(projections.comparisons.fy2026.rows[0].budget.state, "unavailable");
  assert.equal(projections.comparisons.fy2027.rows[0].spending.state, "unavailable");
});

test("money map layer and comparison table use the same row values", () => {
  const projections = buildCommunityBoardMoneyComparisons(money, boards);
  const scorecard = buildScorecard({ registry, moneyComparison: projections });
  const map = buildCommunityBoardMap(scorecard, boundaries, { moneyComparisons: projections });
  assert.equal(map.features.length, 59);
  const mapFeature = map.features.find((feature) => feature.boardId === "bronx-cb-01");
  const tableRow = projections.comparisons.latest.rows.find((row) => row.board_id === "bronx-cb-01");
  assert.deepEqual(mapFeature.money.latest.values, tableRow.values);
  assert.equal(mapFeature.money.latest.states.spending, tableRow.states.spending);
  const html = renderScorecardPage(scorecard, { boundaries });
  assert.match(html, /59-board money comparison/);
  assert.match(html, /Adopted budget · FY2027/);
  assert.match(html, /Payments posted · FY2026/);
  assert.match(html, /Latest retained facts/);
  assert.match(html, /data-scorecard-map-layer="money"/);
  assert.equal((html.match(/data-money-row=/g) || []).length, 177);
  assert.match(html, /data-money-projection=/);
  assert.doesNotMatch(html, /per-capita|remaining budget|posted share/i);
});
