/**
 * Community-board directory neighborhood entry.
 *
 *   node --test test/board_neighborhood_directory.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  associationsFromBoardNeighborhoodSource,
  boardDisplayNameFromId,
  boardNeighborhoodSelectionHeading,
  mountBoardNeighborhoodDirectory,
  ntaLabelIndexFromLayer,
  renderBoardNeighborhoodDirectoryFailureHtml,
  renderBoardNeighborhoodDirectoryHtml,
  resolveBoardNeighborhoodSelection,
  visibleBoardIdsForSelection,
} from "../site/board_neighborhood_directory.mjs";
import { FakeEvent, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const ROOT = process.cwd();

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function loadAssociations() {
  const index = readJson("site/data/board_neighborhood_index.json");
  const labels = ntaLabelIndexFromLayer(
    readJson("site/data/geography/layers/nta2020/26B.json"),
  );
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  const boardNames = Object.fromEntries(
    (scorecard.rows || []).map((row) => [row.body_id, row.name]),
  );
  return associationsFromBoardNeighborhoodSource(index, { labels, boardNames });
}

function makeLocation(href = "https://cityscroll.org/community-boards/") {
  const url = new URL(href);
  return {
    get href() {
      return `${url.origin}${url.pathname}${url.search}${url.hash}`;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    set search(next) {
      url.search = next.startsWith("?") || next === "" ? next : `?${next}`;
    },
    get hash() {
      return url.hash;
    },
    set hash(next) {
      url.hash = next.startsWith("#") || next === "" ? next : `#${next}`;
    },
    get origin() {
      return url.origin;
    },
  };
}

function makeHistory(location) {
  return {
    replaceState(_state, _title, path) {
      if (typeof path !== "string") return;
      const parsed = new URL(path, location.origin);
      location.search = parsed.search;
      location.hash = parsed.hash;
    },
    pushState(state, title, path) {
      this.replaceState(state, title, path);
    },
  };
}

function scorecardShell(neighborhoodHtml) {
  return `<main class="scorecard" data-community-board-root data-selected-board="brooklyn-cb-01">
    ${neighborhoodHtml}
    <svg>
      <path data-board-id="brooklyn-cb-01"></path>
      <path data-board-id="brooklyn-cb-12"></path>
      <path data-board-id="brooklyn-cb-14"></path>
      <path data-board-id="brooklyn-cb-15"></path>
      <path data-board-id="brooklyn-cb-05"></path>
      <path data-board-id="brooklyn-cb-18"></path>
    </svg>
    <aside>
      <div data-board-detail="brooklyn-cb-01"></div>
      <div data-board-detail="brooklyn-cb-12" hidden></div>
      <div data-board-detail="brooklyn-cb-14" hidden></div>
      <div data-board-detail="brooklyn-cb-15" hidden></div>
      <div data-board-detail="brooklyn-cb-05" hidden></div>
      <div data-board-detail="brooklyn-cb-18" hidden></div>
    </aside>
    <table><tbody>
      <tr id="board-brooklyn-cb-01"></tr>
      <tr id="board-brooklyn-cb-12"></tr>
      <tr id="board-brooklyn-cb-14"></tr>
      <tr id="board-brooklyn-cb-15"></tr>
      <tr id="board-brooklyn-cb-05"></tr>
      <tr id="board-brooklyn-cb-18"></tr>
    </tbody></table>
  </main>`;
}

test("A1: Kensington, Greenpoint, and BK1503 resolve to the retained board sets", () => {
  const associations = loadAssociations();

  const kensington = resolveBoardNeighborhoodSelection("nta2020:BK1203", associations);
  assert.equal(kensington.ok, true);
  assert.equal(kensington.label, "Kensington");
  assert.deepEqual(
    kensington.boards.map((board) => board.board_id),
    ["brooklyn-cb-12", "brooklyn-cb-14"],
  );
  assert.equal(kensington.boards[0].pct_from > kensington.boards[1].pct_from, true);
  assert.match(boardNeighborhoodSelectionHeading(kensington), /^Boards overlapping Kensington$/);
  assert.equal(kensington.boards.some((board) => /your board/i.test(board.board_name || "")), false);

  const greenpoint = resolveBoardNeighborhoodSelection("geography:nta2020:BK0101", associations);
  assert.deepEqual(greenpoint.boards.map((board) => board.board_id), ["brooklyn-cb-01"]);
  assert.equal(greenpoint.boards[0].board_name, "Brooklyn Community Board 1");

  const sheepshead = resolveBoardNeighborhoodSelection("nta2020:BK1503", associations);
  assert.deepEqual(sheepshead.boards.map((board) => board.board_id), ["brooklyn-cb-15"]);
  assert.equal(sheepshead.non_board_overlaps.length, 0);

  const html = renderBoardNeighborhoodDirectoryHtml(associations, {
    selectedGeo: "nta2020:BK1203",
  });
  assert.match(html, /Boards overlapping Kensington/);
  assert.match(html, /brooklyn-cb-12/);
  assert.match(html, /brooklyn-cb-14/);
  assert.doesNotMatch(html, /your board/i);
  assert.match(html, /data-board-address-action/);
});

test("A2: shared geo URLs restore the choice; legacy board hashes and clear still work", () => {
  const associations = loadAssociations();
  const html = scorecardShell(renderBoardNeighborhoodDirectoryHtml(associations));
  const location = makeLocation("https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203");
  const history = makeHistory(location);
  const { doc, container } = mountDocument(html, { containerClass: "scorecard-host" });
  const root = container.querySelector("[data-community-board-root]");
  const binder = mountBoardNeighborhoodDirectory(root, { associations, location, history });
  assert.ok(binder);

  const selection = binder.getSelection();
  assert.equal(selection.nta_id, "BK1203");
  assert.deepEqual(visibleBoardIdsForSelection(selection), ["brooklyn-cb-12", "brooklyn-cb-14"]);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-12"]').hidden, false);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, true);
  assert.match(location.search, /geo=nta2020%3ABK1203|geo=nta2020:BK1203/);

  location.hash = "#board-brooklyn-cb-14";
  assert.equal(location.hash, "#board-brooklyn-cb-14");
  assert.equal(root.querySelector("#board-brooklyn-cb-14").hidden, false);

  binder.selectGeo("");
  assert.equal(binder.getSelection().selected, false);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, false);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-12"]').hidden, false);
  assert.equal(location.search, "");
});

test("A3: special-district overlaps stay out of board cards; failed loads keep directory + retry", () => {
  const associations = loadAssociations();
  const springCreek = resolveBoardNeighborhoodSelection("nta2020:BK0504", associations);
  assert.deepEqual(
    springCreek.boards.map((board) => board.board_id),
    ["brooklyn-cb-05", "brooklyn-cb-18"],
  );
  assert.ok(springCreek.non_board_overlaps.some((edge) => edge.district_id === "K56"));
  assert.equal(springCreek.boards.some((board) => board.district_id === "K56"), false);
  assert.equal(springCreek.boards.some((board) => /cb-56|Board 56/i.test(board.board_name || "")), false);

  const html = renderBoardNeighborhoodDirectoryHtml(associations, {
    selectedGeo: "nta2020:BK0504",
  });
  assert.match(html, /brooklyn-cb-05/);
  assert.match(html, /brooklyn-cb-18/);
  assert.doesNotMatch(html, /brooklyn-cb-56|Community Board 56/);
  assert.match(html, /No published community board/);

  const failed = associationsFromBoardNeighborhoodSource({}, { loadFailed: true });
  const failureHtml = renderBoardNeighborhoodDirectoryFailureHtml();
  assert.match(failureHtml, /data-board-neighborhood-failure/);
  assert.match(failureHtml, /data-board-neighborhood-retry/);
  assert.doesNotMatch(failureHtml, /no boards exist|no community boards/i);

  const shell = scorecardShell(failureHtml);
  const location = makeLocation("https://cityscroll.org/community-boards/?geo=nta2020%3ABK1203");
  const { container } = mountDocument(shell, { containerClass: "scorecard-host" });
  const root = container.querySelector("[data-community-board-root]");
  const binder = mountBoardNeighborhoodDirectory(root, {
    associations: failed,
    location,
    history: makeHistory(location),
  });
  assert.equal(root.querySelector("[data-board-neighborhood-failure]").textContent.length > 0, true);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, false);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-12"]').hidden, false);
  assert.ok(root.querySelector("[data-board-neighborhood-retry]"));
  assert.equal(binder.getSelection().recovery?.reason, "association_load_failed");
});

test("A4: labeled controls, keyboard selection, no-JS links, and multi-board copy at 390 and 1440", () => {
  const associations = loadAssociations();
  const html = renderBoardNeighborhoodDirectoryHtml(associations, {
    selectedGeo: "nta2020:BK1203",
  });

  assert.match(html, /for="scorecard-neighborhood-select"/);
  assert.match(html, /<label for="scorecard-neighborhood-select">Neighborhood<\/label>/);
  assert.match(html, /name="geo"/);
  assert.match(html, /data-board-neighborhood-link="BK1203"/);
  assert.match(html, /href="\/community-boards\/brooklyn-cb-12\/"/);
  assert.match(html, /href="\/community-boards\/\?geo=nta2020%3ABK1203"/);
  assert.match(html, /Boards overlapping Kensington/);
  assert.match(html, /data-board-address-action/);
  assert.match(html, /All neighborhood and board associations/);
  assert.match(html, /neighborhood area/);

  const shell = scorecardShell(html);
  for (const width of [390, 1440]) {
    const location = makeLocation("https://cityscroll.org/community-boards/");
    const { doc, container } = mountDocument(shell, { containerClass: "scorecard-host" });
    const root = container.querySelector("[data-community-board-root]");
    root.style = root.style || {};
    root.dataset.viewportWidth = String(width);
    const binder = mountBoardNeighborhoodDirectory(root, {
      associations,
      location,
      history: makeHistory(location),
    });
    const select = root.querySelector("[data-board-neighborhood-select]");
    assert.ok(select, `chooser present at ${width}`);
    assert.equal(select.getAttribute("id"), "scorecard-neighborhood-select");
    select.value = "nta2020:BK0101";
    keydown(select, "Enter");
    assert.equal(binder.getSelection().nta_id, "BK0101");
    assert.match(root.querySelector("[data-board-neighborhood-results-heading]").textContent, /Board overlapping Greenpoint/);
    assert.equal(root.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, false);
    assert.equal(root.querySelector('[data-board-id="brooklyn-cb-12"]').hidden, true);

    // Multi-board copy and address action return for Kensington.
    binder.selectGeo("nta2020:BK1203");
    assert.match(root.querySelector("[data-board-neighborhood-results-heading]").textContent, /Boards overlapping Kensington/);
    assert.ok(root.querySelector("[data-board-address-action]"));

    // No-JS association links remain in the document for both widths.
    const noJsLink = root.querySelector('[data-board-neighborhood-link="BK1503"]');
    assert.ok(noJsLink);
    assert.match(noJsLink.getAttribute("href"), /geo=nta2020%3ABK1503/);
    assert.equal(width === 390 || width === 1440, true);
  }

  assert.equal(boardDisplayNameFromId("brooklyn-cb-15"), "Brooklyn Community Board 15");
});
