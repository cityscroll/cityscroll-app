import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  communityBoardLandPositionsForBoard,
  renderCommunityBoardLandPositionsSection,
  COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE,
} from "../site/community_board_land_positions.mjs";
import {
  BROWSE_INSPECTION_LEGACY_BASELINE,
  BROWSE_INSPECTION_SURFACES,
} from "../site/browse_inspection_contract.mjs";
import {
  bindCommunityBoardLandPositions,
  BOARD_LAND_POSITION_DIALOG_ID,
  BOARD_LAND_POSITION_TITLE_ID,
} from "../site/community_board_land_positions_boot.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const lookup = JSON.parse(readFileSync(new URL("../site/data/community_board_land_positions.json", import.meta.url), "utf8"));
const css = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");

// Board positions are a rotating population: boards gain and lose recorded
// recommendations every first-class refresh. Rather than pin a specific board
// and project ids (which this file used to do with brooklyn-cb-01 / 2024K0286
// / 2024K0358 / 2025K0287, all since rotated out), pick the board with the
// most currently-recorded positions, so this demonstration of "distinct
// records never collapse" keeps working as the population turns over.
function pickPrimaryBoard(source) {
  const boards = Object.values(source.boards);
  return boards.reduce((best, b) => (b.position_count > (best?.position_count ?? 0) ? b : best), null);
}
const PRIMARY_BOARD = pickPrimaryBoard(lookup);
const BOARD = PRIMARY_BOARD.body_id;
const [PRIMARY, SECONDARY] = PRIMARY_BOARD.positions;
const KENT = PRIMARY.project_id;
const MONITOR_POINT = SECONDARY?.project_id;
const EVIDENCE_PATH = new URL("../docs/evidence/board-position-primary-inspection/acceptance-manifest.json", import.meta.url);
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function view(board = BOARD, source = lookup) {
  return communityBoardLandPositionsForBoard(source, board);
}

function section(board = BOARD, source = lookup) {
  return renderCommunityBoardLandPositionsSection(view(board, source));
}

function mounted(board = BOARD, source = lookup) {
  const { doc, container } = mountDocument(section(board, source), { containerClass: "board-host" });
  const root = container.querySelector("[data-community-board-land-positions]");
  bindCommunityBoardLandPositions(root);
  return { doc, container, root };
}

test("primary inspection keeps the static fallback and explicit full-record link separate", () => {
  const html = section();
  const row = html.match(new RegExp(`<li[^>]*data-project-id="${KENT}"[\\s\\S]*?</li>`))?.[0];
  assert.ok(row, `the current primary-board fixture (${KENT}) renders a row`);

  const titleLink = row.match(/<a class="ui-constellation-link board-land-position-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  const primary = row.match(/<button class="board-land-position-inspect"[^>]*>[\s\S]*?<\/button>/)?.[0];
  const fullRecord = row.match(/<a class="ui-constellation-link board-land-position-full-record"[^>]*>[\s\S]*?<\/a>/)?.[0];
  assert.match(titleLink, new RegExp(`href="/browse/zoning/#land/${KENT}"`));
  assert.match(primary, /type="button"/);
  assert.match(primary, new RegExp(`aria-label="Inspect the position recorded on ${escapeRegex(PRIMARY.project_name)}"`));
  assert.match(primary, new RegExp(`<strong[^>]*>${escapeRegex(PRIMARY.project_name)}</strong>`));
  assert.match(fullRecord, new RegExp(`href="/browse/zoning/#land/${KENT}"`));
  assert.match(fullRecord, />Open this project<\/a>/);
  assert.equal((row.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(titleLink, /<button/);
  assert.doesNotMatch(fullRecord, /<button/);

  // Before enhancement the static title anchor is the only visible project
  // destination; after enhancement the title-sized button is primary and the
  // named full-record link stays available.
  assert.match(css, /\.board-land-position-inspect \{\s*display: none;/);
  assert.match(css, /\.board-land-position-full-record \{\s*display: none;/);
  assert.match(css, /\[data-board-land-positions-ready\] \.board-land-position-link \{\s*display: none;/);
  assert.match(css, /\[data-board-land-positions-ready\] \.board-land-position-inspect \{[\s\S]*?width: 100%/);
  assert.match(css, /\[data-board-land-positions-ready\] \.board-land-position-full-record \{[\s\S]*?display: inline-block/);
});

test("200 Kent opens its recommendation context in place and returns to the same control", () => {
  const { doc, root } = mounted();
  const button = root.querySelector(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}][data-board-land-position-id="${KENT}"]`);
  const beforeHref = root.querySelector(".board-land-position-full-record").getAttribute("href");
  button.focus();
  assert.equal(doc.activeElement, button);
  const dialog = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  dialog.showModal = undefined;
  click(button);

  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("aria-labelledby"), BOARD_LAND_POSITION_TITLE_ID);
  assert.equal(dialog.querySelector(`#${BOARD_LAND_POSITION_TITLE_ID}`).textContent, PRIMARY.project_name);
  assert.match(dialog.textContent, new RegExp(escapeRegex(PRIMARY.position)));
  assert.ok(PRIMARY.recorded_tally.recorded, "primary-board specimen must carry a recorded tally");
  assert.match(
    dialog.textContent,
    new RegExp(`${PRIMARY.recorded_tally.votes_for} in favor, ${PRIMARY.recorded_tally.votes_against} against, ${PRIMARY.recorded_tally.votes_abstain} abstaining`),
  );
  assert.match(dialog.textContent, /is advisory/);
  assert.match(dialog.textContent, /vote on the board's recommendation motion/);
  assert.equal(dialog.querySelector(".board-land-position-dialog-open").getAttribute("href"), beforeHref);

  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, button);
  assert.equal(root.querySelector(".board-land-position-full-record").getAttribute("href"), beforeHref,
    "dismissal leaves the same board-position destination available for continuation");
});

test("the primary board's records remain distinct and recommendation tallies never become approvals", () => {
  // Re-derived from the picked PRIMARY_BOARD rather than a fixed 3-record
  // fixture (board_position_count rotates with every refresh), so this keeps
  // demonstrating the same invariant — distinct records never collapse, and a
  // recorded tally never reads as a decision — however many records the
  // current primary board happens to carry.
  const expected = PRIMARY_BOARD.positions;
  assert.ok(expected.length >= 2, "primary board must carry at least two positions to prove distinctness");
  const positions = view().positions;
  assert.deepEqual(positions.map((row) => row.project_id), expected.map((row) => row.project_id));
  assert.deepEqual(positions.map((row) => row.title), expected.map((row) => row.project_name));
  assert.equal(new Set(positions.map((row) => row.href)).size, positions.length);
  assert.equal(new Set(positions.map((row) => row.source_record_id)).size, positions.length);
  assert.deepEqual(positions.map((row) => [
    row.recorded_on,
    row.recorded_tally.votes_for,
    row.recorded_tally.votes_against,
    row.recorded_tally.votes_abstain,
  ]), expected.map((row) => [
    row.recorded_on,
    row.recorded_tally.votes_for,
    row.recorded_tally.votes_against,
    row.recorded_tally.votes_abstain,
  ]));

  const html = section();
  for (const row of expected) {
    assert.match(html, new RegExp(escapeRegex(row.position)));
  }
  assert.match(html, /advisory/);
  assert.doesNotMatch(html, /final approval|approved the development|project approval/i);
});

test("missing tallies and unavailable detail stay explicit without dead primary controls", () => {
  const missingTally = {
    ...lookup,
    boards: {
      ...lookup.boards,
      [BOARD]: {
        ...lookup.boards[BOARD],
        positions: [{
          ...lookup.boards[BOARD].positions[0],
          position: "Waiver of Recommendation",
          position_class: "waiver",
          recorded_tally: { recorded: false, votes_for: null, votes_against: null, votes_abstain: null },
        }],
      },
    },
  };
  const { doc, root } = mounted(BOARD, missingTally);
  const button = root.querySelector(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}]`);
  click(button);
  assert.match(doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID).textContent, /source records no vote tally/);
  assert.doesNotMatch(doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID).textContent, /0 in favor, 0 against/);

  const unavailable = { error: "unavailable", source: lookup.source };
  const fallback = section(BOARD, unavailable);
  assert.match(fallback, /data-land-positions-state="unavailable"/);
  assert.doesNotMatch(fallback, /board-land-position-inspect/);
  assert.doesNotMatch(fallback, /board-land-position-full-record/);
  assert.match(fallback, /could not be loaded/);
});

test("keyboard and narrow-screen order keep the primary title readable", () => {
  const { doc, root } = mounted();
  const button = root.querySelector(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}][data-board-land-position-id="${KENT}"]`);
  button.focus();
  assert.equal(doc.activeElement, button);
  const dialog = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  dialog.showModal = undefined;
  click(button);
  assert.equal(doc.activeElement, dialog.querySelector("[data-board-land-position-close]"));
  keydown(dialog, "Escape");
  assert.equal(doc.activeElement, button);

  const row = section().match(new RegExp(`<li[^>]*data-project-id="${KENT}"[\\s\\S]*?</li>`))[0];
  assert.ok(row.indexOf("board-land-position-link") < row.indexOf("board-land-position-inspect"));
  assert.ok(row.indexOf("board-land-position-inspect") < row.indexOf("board-land-position-id"));
  assert.ok(row.indexOf("board-land-position-id") < row.indexOf("board-land-position-full-record"));
  assert.match(css, /\.board-land-position-inspect \{[\s\S]*?min-width: 0;/);
  assert.match(css, /\.board-land-position-inspect \{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(css, /\.board-land-position-full-record \{[\s\S]*?overflow-wrap: anywhere;/);
});

test("the board inspection surface is no longer admitted as a legacy exception", () => {
  const surface = BROWSE_INSPECTION_SURFACES.find((row) => row.surface_id === "board-land-positions");
  assert.equal(surface.classification, "conforming");
  assert.equal(surface.baseline_id, null);
  assert.equal(surface.journey_owner, "test/board_position_primary_inspection.test.mjs");
  assert.equal(BROWSE_INSPECTION_LEGACY_BASELINE.length, 0);
});

test("A4: acceptance manifest records the Brooklyn journey with revision, route, viewport, and fixture vintage", () => {
  // This evidence file is a committed browser capture, always targeting
  // brooklyn-cb-01 regardless of which board the dynamic PRIMARY_BOARD rule
  // above picks. It is captured by the "board-position-capture-fixtures" +
  // "board-position-capture" steps (tools/render_board_land_position_fixtures.mjs,
  // tools/capture_board_land_positions_evidence.py) in
  // ops/first-class-refresh/committed-read-models.json, which this refresh's
  // own run failed to complete (confirmed from the scheduled workflow's own
  // log: "board-position-capture (failed)"). Re-running those two steps
  // (needs tools/prepare_functional_site.sh's built _site first) regenerates
  // this file against brooklyn-cb-01's current position set; this test
  // compares against that board's live rows rather than a frozen id list so
  // it stays correct once that capture is rerun.
  const brooklynPositions = lookup.boards["brooklyn-cb-01"]?.positions ?? [];
  assert.equal(existsSync(EVIDENCE_PATH), true);
  const manifest = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.board_position_primary_inspection_acceptance.v1");
  assert.equal(manifest.route, "/community-boards/brooklyn-cb-01/");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.grounded_at);
  assert.ok(manifest.fixture_vintage);
  assert.deepEqual(manifest.viewports, [[1440, 900], [390, 844]]);
  assert.deepEqual(manifest.fixture.records.map((row) => row.project_id), brooklynPositions.map((row) => row.project_id));
  assert.deepEqual(manifest.journey.sequence, [
    "set_scope_or_view",
    "inspect",
    "dismiss",
    "open_full_record",
    "return_with_back",
    "continue",
  ]);
  assert.equal(manifest.captures.length, 2);
  assert.ok(manifest.captures.every((capture) => (
    capture.route === manifest.route
    && capture.revision === manifest.revision
    && capture.fixture_vintage === manifest.fixture_vintage
    && /^[0-9a-f]{64}$/.test(capture.screenshot_sha256)
  )));
  assert.deepEqual(manifest.assertions.map((row) => row.letter), ["A1", "A2", "A3", "A4"]);
  assert.ok(manifest.assertions.every((row) => row.result === "accepted" && row.artifact));
  const digest = createHash("sha256").update(JSON.stringify(manifest.assertions) + "\n").digest("hex");
  assert.equal(manifest.assertions_sha256, digest);
});
