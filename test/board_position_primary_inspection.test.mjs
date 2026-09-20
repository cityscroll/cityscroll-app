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
const BOARD = "brooklyn-cb-01";
const KENT = "2024K0286";
const MONITOR_POINT = "2024K0358";
const QUAY_DEMAPPING = "2025K0287";
const EVIDENCE_PATH = new URL("../docs/evidence/board-position-primary-inspection/acceptance-manifest.json", import.meta.url);

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
  assert.ok(row, "the frozen 200 Kent Avenue fixture renders a row");

  const titleLink = row.match(/<a class="ui-constellation-link board-land-position-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  const primary = row.match(/<button class="board-land-position-inspect"[^>]*>[\s\S]*?<\/button>/)?.[0];
  const fullRecord = row.match(/<a class="ui-constellation-link board-land-position-full-record"[^>]*>[\s\S]*?<\/a>/)?.[0];
  assert.match(titleLink, /href="\/browse\/zoning\/#land\/2024K0286"/);
  assert.match(primary, /type="button"/);
  assert.match(primary, /aria-label="Inspect the position recorded on 200 Kent Avenue Rezoning"/);
  assert.match(primary, /<strong[^>]*>200 Kent Avenue Rezoning<\/strong>/);
  assert.match(fullRecord, /href="\/browse\/zoning\/#land\/2024K0286"/);
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
  assert.equal(dialog.querySelector(`#${BOARD_LAND_POSITION_TITLE_ID}`).textContent, "200 Kent Avenue Rezoning");
  assert.match(dialog.textContent, /Conditional Favorable/);
  assert.match(dialog.textContent, /28 in favor, 0 against, 0 abstaining/);
  assert.match(dialog.textContent, /is advisory/);
  assert.match(dialog.textContent, /vote on the board's recommendation motion/);
  assert.equal(dialog.querySelector(".board-land-position-dialog-open").getAttribute("href"), beforeHref);

  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, button);
  assert.equal(root.querySelector(".board-land-position-full-record").getAttribute("href"), beforeHref,
    "dismissal leaves the same board-position destination available for continuation");
});

test("the three Brooklyn CB1 records remain distinct and recommendation tallies never become approvals", () => {
  const positions = view().positions;
  assert.deepEqual(positions.map((row) => row.project_id), [KENT, MONITOR_POINT, QUAY_DEMAPPING]);
  assert.deepEqual(positions.map((row) => row.title), [
    "200 Kent Avenue Rezoning",
    "Monitor Point",
    "Monitor Point - 56 Quay Demapping",
  ]);
  assert.notEqual(positions[1].href, positions[2].href);
  assert.notEqual(positions[1].source_record_id, positions[2].source_record_id);
  assert.deepEqual(positions.slice(1).map((row) => [
    row.recorded_on,
    row.recorded_tally.votes_for,
    row.recorded_tally.votes_against,
    row.recorded_tally.votes_abstain,
  ]), [
    ["2026-02-10", 24, 9, 0],
    ["2026-02-10", 30, 1, 0],
  ]);

  const html = section();
  assert.match(html, /Conditional Favorable/);
  assert.match(html, /Unfavorable/);
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
  assert.equal(existsSync(EVIDENCE_PATH), true);
  const manifest = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.board_position_primary_inspection_acceptance.v1");
  assert.equal(manifest.route, "/community-boards/brooklyn-cb-01/");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.grounded_at);
  assert.ok(manifest.fixture_vintage);
  assert.deepEqual(manifest.viewports, [[1440, 900], [390, 844]]);
  assert.deepEqual(manifest.fixture.records.map((row) => row.project_id), [KENT, MONITOR_POINT, QUAY_DEMAPPING]);
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
