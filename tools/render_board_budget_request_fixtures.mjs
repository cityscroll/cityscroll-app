#!/usr/bin/env node

/**
 * Render the pages the served read-back needs but the site does not build in
 * English-only form: the same Community Board document in every shipping
 * language, the same document for a board the register holds no request for,
 * and the same document with the register deliberately unreadable.
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
import { communityBoardBudgetRequestsForBoard } from "../site/community_board_budget_requests.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".artifacts/board-budget-requests/fixtures");

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require(join(ROOT, "site/i18n.js"));
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const geography = read("site/data/community_board_geography_lookup.json");
const scorecard = read("site/data/community_board_minutes_scorecard.json");
const sourceRegistry = read("site/data/non_council_outcome_sources/source_registry.json");
const register = read("site/data/community_board_budget_register.json");
const documents = Object.fromEntries(register.boards.map((entry) => [
  entry.board_id,
  read(`site/data/community_board_budget_register/${entry.board_id}.json`),
]));

/**
 * The board this evidence is read on: it holds a request whose answer was
 * rewritten between the two publications, one whose publisher wrapper moved on
 * its own, and two neighbouring requests answered by two different bodies.
 */
const POSITIVE_BOARD = "brooklyn-cb-14";

function sources(overrides = {}) {
  return {
    sourceRegistry,
    scorecard,
    geography,
    communityBoardBudgetRegister: register,
    communityBoardBudgetRequests: documents,
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

function boardRequestCounts() {
  const counts = {};
  for (const [boardId, document] of Object.entries(documents)) {
    counts[boardId] = communityBoardBudgetRequestsForBoard(register, document, boardId).request_count;
  }
  return counts;
}

function agencyRequestCounts() {
  const counts = {};
  for (const document of Object.values(documents)) {
    for (const request of document.requests) {
      const servable = request.versions.filter((version) => version.servable);
      if (!servable.length) continue;
      const agency = servable[servable.length - 1].responsible_agency;
      if (agency.binding !== "bound") continue;
      counts[agency.agency_id] = (counts[agency.agency_id] || 0) + 1;
    }
  }
  return counts;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const fixtures = [];

  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const file = join(OUT, `budget-requests-language-${lang}.html`);
    writeFileSync(file, render(POSITIVE_BOARD, {}, { lang }));
    fixtures.push({
      id: `board-budget-requests-language-${lang}`,
      lang,
      body_id: POSITIVE_BOARD,
      route: `/community-boards/${POSITIVE_BOARD}/ (lang=${lang})`,
      file: relative(ROOT, file),
    });
  }

  // A board the register holds nothing for. The register currently carries a
  // request for every published board, so the absence is produced by handing
  // the renderer an empty document for this board rather than by naming a board
  // that happens to be empty today — the state has to be provable either way.
  const empty = join(OUT, "budget-requests-none-recorded.html");
  writeFileSync(empty, render(POSITIVE_BOARD, {
    communityBoardBudgetRequests: {
      ...documents,
      [POSITIVE_BOARD]: { board_id: POSITIVE_BOARD, requests: [] },
    },
  }, { lang: "en" }));
  fixtures.push({
    id: "board-budget-requests-none-recorded",
    lang: "en",
    body_id: POSITIVE_BOARD,
    route: `/community-boards/${POSITIVE_BOARD}/ (the register holds no request for this board)`,
    file: relative(ROOT, empty),
  });

  const failed = join(OUT, "budget-requests-failed-load.html");
  writeFileSync(failed, render(POSITIVE_BOARD, {
    communityBoardBudgetRegister: {
      error: "community_board_budget_register unreadable",
      source: register.source,
      publication_selection: register.publication_selection,
      publications: register.publications,
    },
  }, { lang: "en" }));
  fixtures.push({
    id: "board-budget-requests-failed-load",
    lang: "en",
    body_id: POSITIVE_BOARD,
    route: `/community-boards/${POSITIVE_BOARD}/ (the register could not be read)`,
    file: relative(ROOT, failed),
  });

  const manifest = {
    schema: "cityscroll.board_budget_request_fixtures.v1",
    data_vintage: {
      community_board_budget_register: register.acquired_at,
      community_board_budget_register_as_of: register.publication_selection.as_of,
      community_board_minutes_scorecard: scorecard.as_of,
    },
    counts: {
      ...register.counts,
      board_requests: boardRequestCounts(),
      agency_requests: agencyRequestCounts(),
    },
    positive_board: POSITIVE_BOARD,
    fixtures,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${fixtures.length} fixture(s) to ${relative(ROOT, OUT)}`);
}

main();
