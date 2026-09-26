#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  associationsFromBoardNeighborhoodSource,
  buildScorecard,
  ntaLabelIndexFromLayer,
  renderScorecardPage,
} from "../site/community-board-scorecard.mjs";
import {
  BOARD_NEIGHBORHOOD_PUBLIC_DIR,
  loadActiveBoardNeighborhoodGeneration,
} from "../site/board_neighborhood_refresh.mjs";
import { readCommunityBoardMeetingIndex } from "./lib/community_board_meeting_index_io.mjs";
import { buildMinutesGapDetector } from "./board_scorecard_observation_closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const SOURCE_INVENTORY = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const OUTCOME_LOOKUP = join(ROOT, "site/data/non_council_outcome_lookup.json");
const DETECTOR = join(ROOT, "site/data/community_board_minutes_gap.json");
const PROBES = join(ROOT, "site/data/non_council_outcome_sources/verification_receipts/cb_minutes_publication_probes.json");
const MEETING_INDEX = join(ROOT, "site/data/community_board_meeting_index.json");
const BOUNDARIES = join(ROOT, "site/data/district_boundaries.json");
const MONEY_COMPARISON = join(ROOT, "site/data/community_board_money_comparison.json");
const BOARD_NEIGHBORHOOD_INDEX = join(ROOT, "site/data/board_neighborhood_index.json");
const NTA_LAYER = join(ROOT, "site/data/geography/layers/nta2020/26B.json");
const JSON_OUT = join(ROOT, "site/data/community_board_minutes_scorecard.json");
const HTML_OUT = join(ROOT, "site/community-boards/index.html");
const check = process.argv.includes("--check");
const rebuildJson = process.argv.includes("--rebuild-json");

function buildScorecardFromSources() {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const detector = existsSync(DETECTOR)
    ? JSON.parse(readFileSync(DETECTOR, "utf8"))
    : existsSync(PROBES)
      ? buildMinutesGapDetector({ registry, probes: JSON.parse(readFileSync(PROBES, "utf8")) })
      : null;
  const meetingIndex = existsSync(MEETING_INDEX) ? readCommunityBoardMeetingIndex(MEETING_INDEX) : null;
  return buildScorecard({
    registry,
    detector,
    sourceInventory: JSON.parse(readFileSync(SOURCE_INVENTORY, "utf8")),
    meetingIndex,
    joinedLookup: JSON.parse(readFileSync(OUTCOME_LOOKUP, "utf8")),
    moneyComparison: JSON.parse(readFileSync(MONEY_COMPARISON, "utf8")),
  });
}

const scorecard = rebuildJson || !existsSync(JSON_OUT)
  ? buildScorecardFromSources()
  : JSON.parse(readFileSync(JSON_OUT, "utf8"));

function loadBoardNeighborhoodAssociations(boardRows) {
  const labels = existsSync(NTA_LAYER)
    ? ntaLabelIndexFromLayer(JSON.parse(readFileSync(NTA_LAYER, "utf8")))
    : {};
  const boardNames = Object.fromEntries(
    (boardRows || []).map((row) => [row.body_id, row.name]),
  );
  const active = loadActiveBoardNeighborhoodGeneration(join(ROOT, BOARD_NEIGHBORHOOD_PUBLIC_DIR));
  const source = active?.directory || (existsSync(BOARD_NEIGHBORHOOD_INDEX)
    ? JSON.parse(readFileSync(BOARD_NEIGHBORHOOD_INDEX, "utf8"))
    : null);
  if (!source) {
    return associationsFromBoardNeighborhoodSource({}, { labels, boardNames, loadFailed: true });
  }
  return associationsFromBoardNeighborhoodSource(source, { labels, boardNames });
}

const boardNeighborhoodAssociations = loadBoardNeighborhoodAssociations(scorecard.rows);
const json = `${JSON.stringify(scorecard, null, 2)}\n`;
const html = `${renderScorecardPage(scorecard, {
  boundaries: JSON.parse(readFileSync(BOUNDARIES, "utf8")),
  boardNeighborhoodAssociations,
})}\n`;

mkdirSync(dirname(JSON_OUT), { recursive: true });
mkdirSync(dirname(HTML_OUT), { recursive: true });
if (check) {
  const currentHtml = readFileSync(HTML_OUT, "utf8");
  if (currentHtml !== html) throw new Error("community board scorecard HTML artifact is stale");
  if (rebuildJson || !existsSync(JSON_OUT)) {
    const currentJson = readFileSync(JSON_OUT, "utf8");
    if (currentJson !== json) throw new Error("community board scorecard JSON artifact is stale");
  }
  console.log(`checked ${scorecard.rows.length} boards (${scorecard.coverage.measured} measured)`);
} else {
  if (rebuildJson || !existsSync(JSON_OUT)) writeFileSync(JSON_OUT, json);
  writeFileSync(HTML_OUT, html);
  console.log(
    rebuildJson || !existsSync(JSON_OUT)
      ? `wrote ${JSON_OUT} and ${HTML_OUT} (${scorecard.rows.length} boards, ${scorecard.coverage.measured} measured)`
      : `wrote ${HTML_OUT} from committed scorecard JSON (${scorecard.rows.length} boards, ${scorecard.coverage.measured} measured)`,
  );
}
