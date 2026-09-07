#!/usr/bin/env node

/**
 * Render the pages the served read-back needs but the site does not build in
 * English-only form: the same Community Board document in every shipping
 * language, and the same document with the retained hearing reading
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
const OUT = join(ROOT, ".artifacts/hearing-preparation/fixtures");

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require(join(ROOT, "site/i18n.js"));
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const geography = read("site/data/community_board_geography_lookup.json");
const scorecard = read("site/data/community_board_minutes_scorecard.json");
const sourceRegistry = read("site/data/non_council_outcome_sources/source_registry.json");
const register = read("site/data/community_board_budget_register.json");
const hearingContext = read("site/data/community_board_hearing_context.json");
const documents = Object.fromEntries(register.boards.map((entry) => [
  entry.board_id,
  read(`site/data/community_board_budget_register/${entry.board_id}.json`),
]));

/** The board this reading covers: it publishes an agenda with times. */
const POSITIVE_BOARD = hearingContext.boards[0].board_id;

function sources(overrides = {}) {
  return {
    sourceRegistry,
    scorecard,
    geography,
    communityBoardBudgetRegister: register,
    communityBoardBudgetRequests: documents,
    communityBoardHearingContext: hearingContext,
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
    const file = join(OUT, `hearing-context-language-${lang}.html`);
    writeFileSync(file, render(POSITIVE_BOARD, {}, { lang }));
    fixtures.push({
      id: `hearing-context-language-${lang}`,
      lang,
      body_id: POSITIVE_BOARD,
      route: `/community-boards/${POSITIVE_BOARD}/ (lang=${lang})`,
      file: relative(ROOT, file),
    });
  }

  const failed = join(OUT, "hearing-context-failed-load.html");
  writeFileSync(failed, render(POSITIVE_BOARD, {
    communityBoardHearingContext: { error: "community_board_hearing_context unreadable" },
  }, { lang: "en" }));
  fixtures.push({
    id: "hearing-context-failed-load",
    lang: "en",
    body_id: POSITIVE_BOARD,
    route: `/community-boards/${POSITIVE_BOARD}/ (the retained hearing reading could not be read)`,
    file: relative(ROOT, failed),
  });

  const entry = hearingContext.boards[0];
  const budgetSegment = entry.hearing.segments.find((segment) => (
    segment.kind === "public_hearing" && Number.isInteger(segment.fiscal_year)
  ));
  const manifest = {
    schema: "cityscroll.hearing_context_fixtures.v1",
    data_vintage: {
      community_board_hearing_context: hearingContext.observed_at,
      community_board_budget_register: register.acquired_at,
      community_board_budget_register_as_of: register.publication_selection.as_of,
      community_board_minutes_scorecard: scorecard.as_of,
    },
    counts: {
      agenda_segments: entry.hearing.segments.length,
      previous_cycle_documents: entry.previous_cycle.documents.length,
      previous_cycle_requests: entry.previous_cycle.register_request_count,
      statement_passages: entry.previous_cycle.statement_passages.length,
      responses_compared: entry.previous_cycle.responses_compared,
      response_source_disagreements: entry.previous_cycle.response_source_disagreements.length,
    },
    positive_board: POSITIVE_BOARD,
    hearing_date: entry.hearing.meeting_date,
    hearing_fiscal_year: budgetSegment ? budgetSegment.fiscal_year : null,
    previous_fiscal_year: entry.previous_cycle.fiscal_year,
    worked_example: entry.previous_cycle.worked_example_tracking_code,
    fixtures,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${fixtures.length} fixture(s) to ${relative(ROOT, OUT)}`);
}

main();
