#!/usr/bin/env node

/**
 * Render the board pages the served read-back needs but the site does not build
 * in English-only form: the same Community Board document in every shipping
 * language, and the same document with its district-project artifact
 * deliberately unreadable.
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
const OUT = join(ROOT, ".artifacts/board-district-projects/fixtures");

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require(join(ROOT, "site/i18n.js"));
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const geography = read("site/data/community_board_geography_lookup.json");
const scorecard = read("site/data/community_board_minutes_scorecard.json");
const sourceRegistry = read("site/data/non_council_outcome_sources/source_registry.json");
const districtProjects = read("site/data/community_board_district_projects.json");

const POSITIVE_BOARD = "brooklyn-cb-01";

function sources(overrides = {}) {
  return {
    sourceRegistry,
    scorecard,
    geography,
    communityBoardDistrictProjects: districtProjects,
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

  const failed = join(OUT, "board-list-unavailable.html");
  writeFileSync(failed, render(POSITIVE_BOARD, {
    communityBoardDistrictProjects: {
      error: "community_board_district_projects unreadable",
      source: districtProjects.source,
    },
  }, { lang: "en" }));
  fixtures.push({
    id: "board-list-unavailable",
    lang: "en",
    body_id: POSITIVE_BOARD,
    route: `/community-boards/${POSITIVE_BOARD}/ (district project list unreadable)`,
    file: relative(ROOT, failed),
  });

  const manifest = {
    schema: "cityscroll.board_district_project_fixtures.v1",
    data_vintage: {
      community_board_district_projects: districtProjects.source.observed_on,
      community_board_geography_lookup: geography.boundary_vintage,
      community_board_minutes_scorecard: scorecard.as_of,
    },
    counts: districtProjects.counts,
    fixtures,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${fixtures.length} fixture(s) to ${relative(ROOT, OUT)}`);
}

main();
