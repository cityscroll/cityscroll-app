#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScorecard, renderScorecardPage } from "../site/community-board-scorecard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const SOURCE_INVENTORY = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const OUTCOME_LOOKUP = join(ROOT, "site/data/non_council_outcome_lookup.json");
const DETECTOR = join(ROOT, "site/data/community_board_minutes_gap.json");
const JSON_OUT = join(ROOT, "site/data/community_board_minutes_scorecard.json");
const HTML_OUT = join(ROOT, "site/community-boards/index.html");
const check = process.argv.includes("--check");
const detector = existsSync(DETECTOR) ? JSON.parse(readFileSync(DETECTOR, "utf8")) : null;
const scorecard = buildScorecard({
  registry: JSON.parse(readFileSync(REGISTRY, "utf8")),
  detector,
  sourceInventory: JSON.parse(readFileSync(SOURCE_INVENTORY, "utf8")),
  joinedLookup: JSON.parse(readFileSync(OUTCOME_LOOKUP, "utf8")),
});
const json = `${JSON.stringify(scorecard, null, 2)}\n`;
const html = `${renderScorecardPage(scorecard)}\n`;

mkdirSync(dirname(JSON_OUT), { recursive: true });
mkdirSync(dirname(HTML_OUT), { recursive: true });
if (check) {
  const currentJson = readFileSync(JSON_OUT, "utf8");
  const currentHtml = readFileSync(HTML_OUT, "utf8");
  if (currentJson !== json || currentHtml !== html) throw new Error("community board scorecard artifacts are stale");
  console.log(`checked ${scorecard.rows.length} boards (${scorecard.coverage.measured} measured)`);
} else {
  writeFileSync(JSON_OUT, json);
  writeFileSync(HTML_OUT, html);
  console.log(`wrote ${JSON_OUT} and ${HTML_OUT} (${scorecard.rows.length} boards, ${scorecard.coverage.measured} measured)`);
}
