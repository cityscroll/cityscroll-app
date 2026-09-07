#!/usr/bin/env node

/**
 * Render the board pages the served read-back needs but the site does not build
 * in English-only form: the same Community Board document in every shipping
 * language, the same document for a board this source records no position for,
 * and the same document with its recorded-position artifact deliberately
 * unreadable.
 *
 * These use the shipped renderers over the committed sources; nothing is
 * hand-written markup. Output is an ignored local directory, and the manifest
 * names each fixture, its route and the source vintage behind it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".artifacts/board-land-positions/fixtures");

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require(join(ROOT, "site/i18n.js"));
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const geography = read("site/data/community_board_geography_lookup.json");
const scorecard = read("site/data/community_board_minutes_scorecard.json");
const sourceRegistry = read("site/data/non_council_outcome_sources/source_registry.json");
const landPositions = read("site/data/community_board_land_positions.json");

/** The board whose record carries two applications on one date and one tally. */
const POSITIVE_BOARD = "manhattan-cb-04";

/** The first published board this source records no position for. */
const EMPTY_BOARD = sourceRegistry.sources
  .filter((row) => row.body_type === "community_board")
  .map((row) => row.body_id)
  .find((bodyId) => !landPositions.boards[bodyId]);

function sources(overrides = {}) {
  return {
    sourceRegistry,
    scorecard,
    geography,
    communityBoardLandPositions: landPositions,
    generated_at: scorecard.as_of,
    ...overrides,
  };
}

function render(bodyId, overrides, options) {
  const view = buildCommunityBoardConstellationView(bodyId, sources(overrides));
  if (!view) throw new Error(`no constellation view for ${bodyId}`);
  // Fixtures are served from their own directory, so page assets resolve from
  // the repository root rather than from a sibling of the fixture file.
  return renderCommunityBoardConstellationDocument(view, { assetPrefix: "/site/", ...options });
}

function main() {
  if (!EMPTY_BOARD) throw new Error("no published board without a recorded position");
  mkdirSync(OUT, { recursive: true });
  const fixtures = [];

  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const file = join(OUT, `board-language-${lang}.html`);
    writeFileSync(file, render(POSITIVE_BOARD, {}, { lang }));
    fixtures.push({
      id: `board-language-${lang}`,
      lang,
      body_id: POSITIVE_BOARD,
      route: `/community-boards/${POSITIVE_BOARD}/ (lang=${lang})`,
      file: relative(ROOT, file),
    });
  }

  const empty = join(OUT, "board-no-recorded-position.html");
  writeFileSync(empty, render(EMPTY_BOARD, {}, { lang: "en" }));
  fixtures.push({
    id: "board-no-recorded-position",
    lang: "en",
    body_id: EMPTY_BOARD,
    route: `/community-boards/${EMPTY_BOARD}/ (this source records no position)`,
    file: relative(ROOT, empty),
  });

  const failed = join(OUT, "board-positions-unavailable.html");
  writeFileSync(failed, render(POSITIVE_BOARD, {
    communityBoardLandPositions: {
      error: "community_board_land_positions unreadable",
      source: landPositions.source,
    },
  }, { lang: "en" }));
  fixtures.push({
    id: "board-positions-unavailable",
    lang: "en",
    body_id: POSITIVE_BOARD,
    route: `/community-boards/${POSITIVE_BOARD}/ (recorded positions unreadable)`,
    file: relative(ROOT, failed),
  });

  const manifest = {
    schema: "cityscroll.board_land_position_fixtures.v1",
    data_vintage: {
      community_board_land_positions: landPositions.source.observed_on,
      community_board_geography_lookup: geography.boundary_vintage,
      community_board_minutes_scorecard: scorecard.as_of,
    },
    counts: landPositions.counts,
    positive_board: POSITIVE_BOARD,
    empty_board: EMPTY_BOARD,
    fixtures,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${fixtures.length} fixture(s) to ${relative(ROOT, OUT)}`);
}

main();
