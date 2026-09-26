/**
 * Community-board directory neighborhood entry.
 *
 *   node --test test/board_neighborhood_directory.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

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
import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";
import { keydown, mountDocument } from "./helpers/preview_dom.mjs";

const ROOT = process.cwd();
const WIDTHS_PROBE = join("test", "functional", "board_neighborhood_directory_widths.py");

function pythonPlaywrightChromiumAvailable() {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      "from playwright.sync_api import sync_playwright\n"
      + "with sync_playwright() as p:\n"
      + "    browser = p.chromium.launch(headless=True)\n"
      + "    browser.close()\n",
    ],
    { encoding: "utf8", timeout: 60_000, env: process.env },
  );
  return probe.status === 0;
}

function directoryWidthsDocumentHtml() {
  const associations = loadAssociations();
  const neighborhoodHtml = renderBoardNeighborhoodDirectoryHtml(associations, {
    selectedGeo: "nta2020:BK1203",
  });
  const brandHref = pathToFileURL(join(ROOT, "site", "brand.css")).href;
  const scorecardHref = pathToFileURL(join(ROOT, "site", "community-board-scorecard.css")).href;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${brandHref}">
<link rel="stylesheet" href="${scorecardHref}">
</head>
<body>
<main class="scorecard" data-community-board-root>
${neighborhoodHtml}
</main>
</body>
</html>`;
}

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

test("A4: labeled controls, keyboard selection, no-JS links, and multi-board copy stay in markup", () => {
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
  assert.match(html, /Neighborhood board associations/);
  assert.match(html, /neighborhood area/);

  const shell = scorecardShell(html);
  const location = makeLocation("https://cityscroll.org/community-boards/");
  const { container } = mountDocument(shell, { containerClass: "scorecard-host" });
  const root = container.querySelector("[data-community-board-root]");
  const binder = mountBoardNeighborhoodDirectory(root, {
    associations,
    location,
    history: makeHistory(location),
  });
  const select = root.querySelector("[data-board-neighborhood-select]");
  assert.ok(select);
  assert.equal(select.getAttribute("id"), "scorecard-neighborhood-select");
  select.value = "nta2020:BK0101";
  keydown(select, "Enter");
  assert.equal(binder.getSelection().nta_id, "BK0101");
  assert.match(root.querySelector("[data-board-neighborhood-results-heading]").textContent, /Board overlapping Greenpoint/);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-01"]').hidden, false);
  assert.equal(root.querySelector('[data-board-id="brooklyn-cb-12"]').hidden, true);

  binder.selectGeo("nta2020:BK1203");
  assert.match(root.querySelector("[data-board-neighborhood-results-heading]").textContent, /Boards overlapping Kensington/);
  assert.ok(root.querySelector("[data-board-address-action]"));

  const noJsLink = root.querySelector('[data-board-neighborhood-link="BK1503"]');
  assert.ok(noJsLink);
  assert.match(noJsLink.getAttribute("href"), /geo=nta2020%3ABK1503/);

  assert.equal(boardDisplayNameFromId("brooklyn-cb-15"), "Brooklyn Community Board 15");
});

test("A4: browser measures neighborhood chooser and cards at 390 and 1440", async (t) => {
  assert.equal(existsSync(join(ROOT, WIDTHS_PROBE)), true);
  if (!pythonPlaywrightChromiumAvailable()) {
    t.skip("Python playwright Chromium is not launchable in this lane");
    return;
  }

  withTempDirSync("board-neighborhood-directory-widths", (dir) => {
    const documentPath = join(dir, "index.html");
    writeFileSync(documentPath, directoryWidthsDocumentHtml());
    const result = spawnSync("python3", [join(ROOT, WIDTHS_PROBE), documentPath], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, "cityscroll.board_neighborhood_directory_widths.v1");
    assert.equal(payload.capture_mode, "headless-playwright-fixture-document");
    assert.deepEqual(payload.viewports, [[390, 844], [1440, 900]]);
    assert.equal(payload.observations.length, 2);

    const byId = Object.fromEntries(payload.observations.map((row) => [row.id, row]));
    const narrow = byId.narrow_touch;
    const desktop = byId.desktop;
    assert.ok(narrow && desktop);

    for (const row of [narrow, desktop]) {
      const seen = row.observed;
      assert.equal(seen.inner_width, row.viewport.width, `${row.id} window width must match viewport`);
      assert.ok(seen.entry?.width > 0, `${row.id} entry width`);
      assert.ok(seen.chooser?.width > 0, `${row.id} chooser width`);
      assert.equal(seen.chooser_id, "scorecard-neighborhood-select");
      assert.equal(seen.label_text, "Neighborhood");
      assert.match(seen.heading_text || "", /Boards overlapping Kensington/);
      assert.equal(seen.choice_count, 2, `${row.id} Kensington board cards`);
      assert.equal(seen.choice_widths.length, 2);
      assert.ok(seen.choice_widths.every((width) => width > 0), `${row.id} card widths`);
      assert.equal(seen.address_action_present, true);
      assert.match(seen.nojs_link_href || "", /geo=nta2020%3ABK1503/);
      assert.equal(seen.focused_neighborhood_select, true);
      assert.ok(Number(seen.keyboard_traversal_steps) >= 1, `${row.id} Tab traversal`);
      assert.equal(seen.focused_id, "scorecard-neighborhood-select");
    }

    // Positive controls: the two named widths must produce distinct measured layout.
    assert.notEqual(
      narrow.observed.entry.width,
      desktop.observed.entry.width,
      "entry width must differ between 390 and 1440",
    );
    assert.ok(
      desktop.observed.entry.width > narrow.observed.entry.width,
      "desktop entry width must exceed narrow entry width",
    );
    assert.ok(
      Math.max(...desktop.observed.choice_widths) > Math.max(...narrow.observed.choice_widths),
      "desktop board-card width must exceed narrow board-card width",
    );
  });
});
