#!/usr/bin/env node

/**
 * Render the pages the served read-back of the request-to-project relation
 * needs but the site does not build in English-only form: the same Community
 * Board document in every shipping language, the same document with the
 * relation's materialization absent, and the same document with the register
 * itself unreadable.
 *
 * These use the shipped renderers over the committed sources; nothing here is
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
import {
  REQUEST_PROJECT_STRINGS,
  communityBoardRequestProjectLinkIndex,
} from "../site/community_board_request_project_links.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".artifacts/board-request-project-links/fixtures");

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require(join(ROOT, "site/i18n.js"));
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const geography = read("site/data/community_board_geography_lookup.json");
const scorecard = read("site/data/community_board_minutes_scorecard.json");
const sourceRegistry = read("site/data/non_council_outcome_sources/source_registry.json");
const register = read("site/data/community_board_budget_register.json");
const projectLinks = read("site/data/community_board_request_project_links.json");
const documents = Object.fromEntries(register.boards.map((entry) => [
  entry.board_id,
  read(`site/data/community_board_budget_register/${entry.board_id}.json`),
]));

/**
 * The board this evidence is read on: its street reconstruction request carries
 * an answer that names a capital project outright, and the same page holds many
 * requests that name none, so the absence is visible beside the presence.
 */
const POSITIVE_BOARD = "bronx-cb-03";
/** The district whose answer says its own segment came out of the project. */
const SCOPE_DIFFERENCE_BOARD = "queens-cb-05";

/**
 * The boundary sentence a fixture must carry, in that fixture's own language.
 *
 * The read-back checks the sentence rather than the presence of a block, so a
 * page that rendered the relation with an untranslated or missing boundary
 * fails instead of passing on markup alone.
 */
function boundaryFor(lang) {
  return (REQUEST_PROJECT_STRINGS[lang] || REQUEST_PROJECT_STRINGS.en).crpl_boundary;
}

function sources(overrides = {}) {
  return {
    sourceRegistry,
    scorecard,
    geography,
    communityBoardBudgetRegister: register,
    communityBoardBudgetRequests: documents,
    communityBoardRequestProjectLinks: projectLinks,
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

function linkCounts() {
  const index = communityBoardRequestProjectLinkIndex(projectLinks);
  const counts = {};
  for (const relation of projectLinks.relations) {
    counts[relation.request.board_id] = (counts[relation.request.board_id] || 0) + 1;
  }
  return { by_board: counts, relations: index.relation_count, requests: index.request_count };
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const fixtures = [];

  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const file = join(OUT, `request-project-language-${lang}.html`);
    writeFileSync(file, render(POSITIVE_BOARD, {}, { lang }));
    fixtures.push({
      id: `board-request-project-language-${lang}`,
      lang,
      body_id: POSITIVE_BOARD,
      state: "present",
      boundary: boundaryFor(lang),
      route: `/community-boards/${POSITIVE_BOARD}/ (lang=${lang})`,
      file: relative(ROOT, file),
    });
  }

  const scopeDifference = join(OUT, "request-project-scope-difference.html");
  writeFileSync(scopeDifference, render(SCOPE_DIFFERENCE_BOARD, {}, { lang: "en" }));
  fixtures.push({
    id: "board-request-project-scope-difference",
    lang: "en",
    body_id: SCOPE_DIFFERENCE_BOARD,
    state: "present",
    boundary: boundaryFor("en"),
    route: `/community-boards/${SCOPE_DIFFERENCE_BOARD}/ (the answer says this district's segment came out of the project)`,
    file: relative(ROOT, scopeDifference),
  });

  // The relation is optional by construction, so its absence has to be provable
  // rather than assumed: the same board, rendered with no materialization at
  // all, must read exactly as it did before this relation existed.
  const absent = join(OUT, "request-project-materialization-absent.html");
  writeFileSync(absent, render(POSITIVE_BOARD, { communityBoardRequestProjectLinks: null }, { lang: "en" }));
  fixtures.push({
    id: "board-request-project-materialization-absent",
    lang: "en",
    body_id: POSITIVE_BOARD,
    state: "absent",
    boundary: boundaryFor("en"),
    route: `/community-boards/${POSITIVE_BOARD}/ (no relation materialization)`,
    file: relative(ROOT, absent),
  });

  // The narrow-viewport baseline for the district whose rows are already wider
  // than a phone before this relation exists. Without it, a page that scrolls
  // sideways there could be read as something this block did.
  const baseline = join(OUT, "request-project-narrow-baseline.html");
  writeFileSync(baseline, render(SCOPE_DIFFERENCE_BOARD, { communityBoardRequestProjectLinks: null }, { lang: "en" }));
  fixtures.push({
    id: "board-request-project-narrow-baseline",
    lang: "en",
    body_id: SCOPE_DIFFERENCE_BOARD,
    state: "absent",
    boundary: boundaryFor("en"),
    viewport: { width: 390, height: 844 },
    route: `/community-boards/${SCOPE_DIFFERENCE_BOARD}/ (no relation materialization, narrow touch)`,
    file: relative(ROOT, baseline),
  });

  const failed = join(OUT, "request-project-failed-load.html");
  writeFileSync(failed, render(POSITIVE_BOARD, {
    communityBoardBudgetRegister: {
      error: "community_board_budget_register unreadable",
      source: register.source,
      publication_selection: register.publication_selection,
      publications: register.publications,
    },
  }, { lang: "en" }));
  fixtures.push({
    id: "board-request-project-failed-load",
    lang: "en",
    body_id: POSITIVE_BOARD,
    state: "unavailable",
    boundary: boundaryFor("en"),
    route: `/community-boards/${POSITIVE_BOARD}/ (the register could not be read)`,
    file: relative(ROOT, failed),
  });

  const manifest = {
    schema: "cityscroll.board_request_project_fixtures.v1",
    data_vintage: {
      community_board_budget_register: register.acquired_at,
      community_board_budget_register_as_of: register.publication_selection.as_of,
      capital_projects_latest_release: projectLinks.source_scope.capital_projects.latest_retained_release,
      request_project_links_reviewed_on: projectLinks.reviewed_on,
    },
    counts: { ...projectLinks.counts, links: linkCounts() },
    positive_board: POSITIVE_BOARD,
    scope_difference_board: SCOPE_DIFFERENCE_BOARD,
    fixtures,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${fixtures.length} fixture(s) to ${relative(ROOT, OUT)}`);
}

main();
