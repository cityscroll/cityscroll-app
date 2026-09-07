/**
 * The positions a Community Board has recorded on land use projects.
 *
 * The relationship these tests cover already existed in the retained land
 * records, published project-first. What was missing was the board-first read
 * of it, so a resident standing on their own board could see what the board has
 * actually said about the applications in front of it and then open one.
 *
 * Population figures are never written down here. Every count is recomputed
 * from the committed retained inputs by a second, deliberately independent
 * pass, so a later source refresh that legitimately moves the numbers reports
 * its own figures instead of failing against a stale fixture. What is pinned is
 * the reasoning and the named records:
 *
 *   - the exact reverse association, keyed only on the canonical board identity
 *     the retained record already carries
 *   - two applications reviewed on one date with one identical tally stay two
 *     applications and are never counted as two meetings
 *   - a waiver stays a waiver, with its absent tally intact
 *   - a body that submitted a position with no recorded vote date keeps that
 *     absence rather than borrowing the board's date
 *   - a recorded tally is described as the vote on the recommendation motion
 *     and never as support for the development
 *   - three separate states: recorded positions, a source-qualified absence,
 *     and a list that could not be read
 *   - two affordances with two meanings: a real anchor to the project route
 *     that needs no scripting, and a native button that inspects in place, with
 *     focus, Tab containment, Escape and focus return
 *
 *   node --test test/community_board_land_positions.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  boardIdOfRecommendation,
  buildCommunityBoardLandPositions,
  positionClass,
  COMMUNITY_BOARD_LAND_POSITIONS_SCHEMA,
} from "../warehouse/lib/community_board_land_positions.mjs";
import {
  communityBoardLandPositionPayload,
  communityBoardLandPositionsForBoard,
  renderCommunityBoardLandPositionsSection,
  COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR,
  COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE,
  COMMUNITY_BOARD_LAND_POSITIONS_OVERFLOW_ANCHOR,
  COMMUNITY_BOARD_LAND_POSITION_STATES,
  COMMUNITY_BOARD_LAND_POSITION_STRINGS,
  COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT,
} from "../site/community_board_land_positions.mjs";
import {
  bindCommunityBoardLandPositions,
  parseBoardLandPosition,
  BOARD_LAND_POSITION_DIALOG_ID,
  BOARD_LAND_POSITION_READY_ATTRIBUTE,
  BOARD_LAND_POSITION_TITLE_ID,
} from "../site/community_board_land_positions_boot.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { click, keydown, mountDocument } from "./helpers/preview_dom.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const AUTHORITY = read("site/data/land_authority_summary.json");
const LAND_PROJECTS = read("site/data/land_default_ulurp.json");
const LOOKUP = read("site/data/community_board_land_positions.json");
const REGISTRY = read("site/data/non_council_outcome_sources/source_registry.json");
const SCORECARD = read("site/data/community_board_minutes_scorecard.json");
const GEOGRAPHY = read("site/data/community_board_geography_lookup.json");
const CSS = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");

// The named source-backed cases, addressed by the publisher's own identifiers,
// so a failure says which record moved rather than which number did.
const MANHATTAN_CB4 = "manhattan-cb-04";
// Two separate applications this board recorded on one date with one identical
// tally. They must never merge and must never be read as two meetings.
const DEWITT_ELEVENTH = "2024M0244";
const DEWITT_54TH = "2023M0213";
const BROOKLYN_CB1 = "brooklyn-cb-01";
const MONITOR_POINT = "2024K0358";
const MONITOR_POINT_DEMAPPING = "2025K0287";
const STATEN_ISLAND_CB1 = "staten-island-cb-01";
const WAIVER_PROJECT = "2026R0127";

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const textOf = (html) => html
  .replace(/<[^>]*>/g, " ")
  .replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match])
  .replace(/\s+/g, " ")
  .trim();

/**
 * The recorded board positions, recomputed without the module under test:
 * walk the retained recommendations, keep only the ones representing a
 * Community Board that carry a canonical board reference, a submitted status
 * and a vote date, and index them by that reference.
 */
function independentIndex() {
  const byBoard = new Map();
  for (const [projectId, summary] of Object.entries(AUTHORITY.summaries || {})) {
    for (const row of summary?.observed?.recommendations || []) {
      if (row.representing !== "Community Board") continue;
      if (row.status !== "Submitted") continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.vote_date || ""))) continue;
      const ref = String(row.body_ref || "");
      if (!ref.startsWith("community-board:")) continue;
      const boardId = ref.slice("community-board:".length);
      if (!byBoard.has(boardId)) byBoard.set(boardId, []);
      byBoard.get(boardId).push({
        project_id: projectId,
        position: row.value,
        recorded_on: row.vote_date,
        votes: [row.votes_for, row.votes_against, row.votes_abstain],
        source_record_id: row.source_id,
      });
    }
  }
  return byBoard;
}

function viewFor(bodyId, lookup = LOOKUP) {
  return communityBoardLandPositionsForBoard(lookup, bodyId);
}

function sectionFor(bodyId, options = {}, lookup = LOOKUP) {
  return renderCommunityBoardLandPositionsSection(viewFor(bodyId, lookup), options);
}

function positionOf(bodyId, projectId) {
  const view = viewFor(bodyId);
  const found = view.positions.find((row) => row.project_id === projectId);
  assert.ok(found, `${bodyId} records no position on ${projectId}`);
  return found;
}

function documentSources(overrides = {}) {
  return {
    sourceRegistry: REGISTRY,
    scorecard: SCORECARD,
    geography: GEOGRAPHY,
    communityBoardLandPositions: LOOKUP,
    generated_at: SCORECARD.as_of,
    ...overrides,
  };
}

/* ---------- the reverse association ---------- */

test("the index reproduces the retained recommendations board for board", () => {
  const expected = independentIndex();
  const boards = Object.keys(LOOKUP.boards);
  assert.equal(LOOKUP.schema, COMMUNITY_BOARD_LAND_POSITIONS_SCHEMA);
  assert.deepEqual(boards.slice().sort(), [...expected.keys()].sort());

  let rows = 0;
  for (const [boardId, want] of expected) {
    const got = LOOKUP.boards[boardId];
    rows += want.length;
    assert.equal(got.position_count, want.length, boardId);
    assert.deepEqual(
      got.positions.map((row) => row.project_id).sort(),
      want.map((row) => row.project_id).sort(),
      boardId,
    );
    for (const row of got.positions) {
      const source = want.find((candidate) => candidate.project_id === row.project_id);
      assert.equal(row.position, source.position);
      assert.equal(row.recorded_on, source.recorded_on);
      assert.equal(row.source_record_id, source.source_record_id);
      assert.deepEqual(
        [row.recorded_tally.votes_for, row.recorded_tally.votes_against, row.recorded_tally.votes_abstain],
        source.votes,
      );
    }
  }

  assert.equal(LOOKUP.counts.board_positions, rows);
  assert.equal(LOOKUP.counts.boards_with_positions, boards.length);
  assert.equal(
    LOOKUP.counts.projects_with_board_positions,
    new Set([...expected.values()].flat().map((row) => row.project_id)).size,
  );
  assert.equal(LOOKUP.counts.retained_projects, Object.keys(AUTHORITY.summaries).length);
});

test("the index is a rebuild of the committed retained inputs, not a stored guess", () => {
  const rebuilt = buildCommunityBoardLandPositions({
    authority: AUTHORITY,
    projects: LAND_PROJECTS,
    generatedAt: AUTHORITY.generated_at,
  });
  assert.deepEqual(rebuilt, LOOKUP);
});

test("only the canonical board identity on the record decides the association", () => {
  assert.equal(boardIdOfRecommendation({ body_ref: "community-board:queens-cb-10" }), "queens-cb-10");
  // A borough president, an unresolved recommendation and a reference this
  // repository does not publish all resolve to no board at all.
  assert.equal(boardIdOfRecommendation({ body_ref: "borough-president:brooklyn" }), null);
  assert.equal(boardIdOfRecommendation({ body_ref: null, representing: "Community Board" }), null);
  assert.equal(boardIdOfRecommendation({ body_ref: "community-board:brooklyn-1" }), null);

  const built = buildCommunityBoardLandPositions({
    authority: {
      generated_at: "2026-09-06T00:00:00.000Z",
      summaries: {
        "2026K0001": {
          observed: {
            recommendations: [
              // Represents a board, but names no canonical board: counted, never
              // guessed at from the borough or the project identifier.
              {
                representing: "Community Board",
                body_ref: null,
                value: "Favorable",
                status: "Submitted",
                vote_date: "2026-04-01",
                source_id: "unresolved-1",
              },
            ],
          },
        },
      },
    },
    projects: LAND_PROJECTS,
  });
  assert.deepEqual(built.boards, {});
  assert.equal(built.counts.unresolved_board_recommendations, 1);
  assert.equal(built.counts.board_positions, 0);
});

test("an unsubmitted or undated recommendation is counted, never rendered as a position", () => {
  const built = buildCommunityBoardLandPositions({
    authority: {
      generated_at: "2026-09-06T00:00:00.000Z",
      summaries: {
        "2026K0002": {
          observed: {
            recommendations: [
              {
                representing: "Community Board",
                body_ref: "community-board:brooklyn-cb-01",
                value: "Favorable",
                status: "Draft",
                vote_date: "2026-04-01",
                source_id: "draft-1",
              },
              {
                representing: "Community Board",
                body_ref: "community-board:brooklyn-cb-01",
                value: "Favorable",
                status: "Submitted",
                vote_date: null,
                source_id: "undated-1",
              },
            ],
          },
        },
      },
    },
    projects: LAND_PROJECTS,
  });
  assert.deepEqual(built.boards, {});
  assert.equal(built.counts.unsubmitted_board_recommendations, 1);
  assert.equal(built.counts.undated_board_recommendations, 1);
  assert.equal(built.counts.board_recommendations, 2);
});

/* ---------- the named records ---------- */

test("Manhattan CB4 exposes both Dewitt Clinton applications with their recorded tally", () => {
  const view = viewFor(MANHATTAN_CB4);
  assert.equal(view.state, COMMUNITY_BOARD_LAND_POSITION_STATES.AVAILABLE);

  const eleventh = positionOf(MANHATTAN_CB4, DEWITT_ELEVENTH);
  assert.equal(eleventh.position, "Conditional Unfavorable");
  assert.equal(eleventh.recorded_on, "2026-02-04");
  assert.deepEqual(
    [eleventh.recorded_tally.votes_for, eleventh.recorded_tally.votes_against, eleventh.recorded_tally.votes_abstain],
    [33, 1, 1],
  );

  const html = sectionFor(MANHATTAN_CB4);
  const text = textOf(html);
  assert.match(text, /Conditional Unfavorable/);
  assert.match(text, /February 4, 2026/);
  assert.match(text, /33 in favor, 1 against, 1 abstaining/);
});

test("Brooklyn CB1 exposes Monitor Point and the demapping as separate applications", () => {
  const monitor = positionOf(BROOKLYN_CB1, MONITOR_POINT);
  assert.equal(monitor.position, "Conditional Favorable");
  assert.equal(monitor.recorded_on, "2026-02-10");
  assert.deepEqual(
    [monitor.recorded_tally.votes_for, monitor.recorded_tally.votes_against, monitor.recorded_tally.votes_abstain],
    [24, 9, 0],
  );

  const demapping = positionOf(BROOKLYN_CB1, MONITOR_POINT_DEMAPPING);
  assert.equal(demapping.position, "Unfavorable");
  assert.equal(demapping.recorded_on, "2026-02-10");
  assert.deepEqual(
    [demapping.recorded_tally.votes_for, demapping.recorded_tally.votes_against, demapping.recorded_tally.votes_abstain],
    [30, 1, 0],
  );

  // Same date, same board, two applications, two destinations.
  assert.notEqual(monitor.href, demapping.href);
  assert.notEqual(monitor.source_record_id, demapping.source_record_id);
});

/* ---------- the boundaries ---------- */

test("two applications recorded on one date with one tally stay two applications", () => {
  const view = viewFor(MANHATTAN_CB4);
  const eleventh = positionOf(MANHATTAN_CB4, DEWITT_ELEVENTH);
  const fiftyFourth = positionOf(MANHATTAN_CB4, DEWITT_54TH);

  // Identical on every attribute a careless join would key on.
  assert.equal(eleventh.recorded_on, fiftyFourth.recorded_on);
  assert.deepEqual(eleventh.recorded_tally, fiftyFourth.recorded_tally);
  assert.equal(eleventh.position, fiftyFourth.position);
  // And still two rows, two projects, two source records, two destinations.
  assert.equal(view.position_count, 2);
  assert.equal(view.project_count, 2);
  assert.notEqual(eleventh.project_id, fiftyFourth.project_id);
  assert.notEqual(eleventh.source_record_id, fiftyFourth.source_record_id);
  assert.notEqual(eleventh.href, fiftyFourth.href);
  // One date carries both, and the artifact publishes that as a date count so
  // no surface can turn it into a meeting count.
  assert.equal(view.recorded_date_count, 1);
  assert.equal(LOOKUP.boards[MANHATTAN_CB4].recorded_date_count, 1);
});

test("nothing in the projection or the section counts meetings", () => {
  // No count, key or row in the artifact is a meeting, and the only place the
  // word appears at all is the rule that denies the reading.
  const withoutRule = { ...LOOKUP, negative_rule: "" };
  assert.equal(JSON.stringify(withoutRule).includes("meeting"), false);
  assert.equal(Object.keys(LOOKUP.counts).some((key) => key.includes("meeting")), false);
  const html = sectionFor(MANHATTAN_CB4);
  // The one place the word may appear is the sentence that denies the reading.
  const text = textOf(html);
  assert.match(text, /Each row is one position on one application\./);
  assert.match(text, /keep separate rows, separate source records and separate project pages/);
  assert.match(text, /this list counts positions/);
  // The section never describes a date, a row or a tally as a meeting.
  assert.doesNotMatch(text, /meeting/i);
});

test("a recorded tally is described as the vote on the recommendation motion", () => {
  const text = textOf(sectionFor(MANHATTAN_CB4));
  assert.match(text, /vote on the board's recommendation motion/);
  assert.match(text, /not a count of members for or against the development/);
  // No surface ever calls the tally support for the project.
  assert.doesNotMatch(text, /votes? (?:for|in favor of) the development/i);
  assert.doesNotMatch(text, /supported the (?:project|development)/i);
});

test("the Staten Island waiver stays a waiver with its absent tally intact", () => {
  const waiver = positionOf(STATEN_ISLAND_CB1, WAIVER_PROJECT);
  assert.equal(waiver.position, "Waiver of Recommendation");
  assert.equal(waiver.position_class, "waiver");
  assert.equal(waiver.recorded_tally.recorded, false);
  assert.deepEqual(
    [waiver.recorded_tally.votes_for, waiver.recorded_tally.votes_against, waiver.recorded_tally.votes_abstain],
    [null, null, null],
  );

  const text = textOf(sectionFor(STATEN_ISLAND_CB1));
  assert.match(text, /Waiver of Recommendation/);
  assert.match(text, /The source records no vote tally for this position\./);
  assert.match(text, /It is not support and it is not opposition\./);
  // A null tally is never rendered as a unanimous or a zero vote.
  assert.doesNotMatch(text, /0 in favor, 0 against, 0 abstaining/);
});

test("a Borough President position with no recorded vote date keeps that absence", () => {
  for (const [board, project] of [[MANHATTAN_CB4, DEWITT_ELEVENTH], [MANHATTAN_CB4, DEWITT_54TH]]) {
    const position = positionOf(board, project);
    const bp = position.other_positions.find((row) => row.representing === "Borough President");
    assert.ok(bp, `${project} carries no Borough President position`);
    assert.equal(bp.position, "Conditional Favorable");
    // The board voted on 2026-02-04; the Borough President's record carries no
    // date at all and must not borrow one.
    assert.equal(bp.recorded_on, null);
    assert.notEqual(position.recorded_on, null);
  }

  const t = (key) => COMMUNITY_BOARD_LAND_POSITION_STRINGS.en[key];
  const payload = communityBoardLandPositionPayload(
    positionOf(MANHATTAN_CB4, DEWITT_ELEVENTH),
    (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? ""),
    "en",
  );
  const bpRow = payload.others.find((row) => row.term === "Borough President");
  assert.equal(bpRow.note, "The source records no vote date for this position.");
});

test("the reviewed position vocabulary classifies without rewriting the label", () => {
  assert.equal(positionClass("Waiver of Recommendation"), "waiver");
  assert.equal(positionClass("Conditional Unfavorable"), "conditional_unfavorable");
  // A label this repository has not reviewed keeps its own text and is not
  // forced into a familiar bucket.
  assert.equal(positionClass("Approved With Modifications"), "unreviewed");
  for (const board of Object.values(LOOKUP.boards)) {
    for (const row of board.positions) {
      assert.equal(typeof row.position, "string");
      assert.ok(row.position.length > 0);
    }
  }
});

/* ---------- the three states ---------- */

test("a board this source records no position for says so about the source", () => {
  const boardIds = REGISTRY.sources
    .filter((row) => row.body_type === "community_board")
    .map((row) => row.body_id);
  const withoutPositions = boardIds.filter((id) => !LOOKUP.boards[id]);
  assert.ok(withoutPositions.length > 0, "expected at least one board with no recorded position");

  const view = viewFor(withoutPositions[0]);
  assert.equal(view.state, COMMUNITY_BOARD_LAND_POSITION_STATES.NONE_RECORDED);
  assert.equal(view.position_count, 0);
  assert.equal(view.retained_project_count, LOOKUP.counts.retained_projects);

  const text = textOf(renderCommunityBoardLandPositionsSection(view));
  assert.match(text, /This source records no position submitted by this board/);
  assert.match(text, /That is what the source holds/);
  assert.match(text, /not a record that this board has never voted on an application/);
  // The absence is qualified by the population it was measured over.
  assert.match(text, new RegExp(`${LOOKUP.counts.retained_projects} land use projects this site retains`));
  assert.match(text, /NYC Department of City Planning, Zoning Application Portal/);
});

test("a list that could not be read is a stated failure, not an absence", () => {
  const failed = { error: "community_board_land_positions unreadable", source: LOOKUP.source };
  const view = viewFor(MANHATTAN_CB4, failed);
  assert.equal(view.state, COMMUNITY_BOARD_LAND_POSITION_STATES.UNAVAILABLE);
  const text = textOf(renderCommunityBoardLandPositionsSection(view));
  assert.match(text, /could not be loaded/);
  assert.match(text, /That is a failure to read them, not a board with no recorded positions/);
  assert.match(text, /Reload this page to try again/);
  // The published source stays reachable through the failure.
  assert.match(renderCommunityBoardLandPositionsSection(view), /href="https:\/\/data\.cityofnewyork\.us\/d\//);
  // And the failure never borrows the source-qualified absence sentence.
  assert.doesNotMatch(text, /This source records no position submitted by this board/);
});

/* ---------- teaching copy ---------- */

test("the section teaches what an advisory recommendation is and what it decides", () => {
  const text = textOf(sectionFor(BROOKLYN_CB1));
  assert.match(text, /is advisory/);
  assert.match(text, /holds a public hearing and votes on a recommendation/);
  assert.match(text, /City Planning Commission/);
  assert.match(text, /City Council/);
  assert.match(text, /are the bodies that decide/);
});

test("the lede states the population the positions were read from", () => {
  const view = viewFor(BROOKLYN_CB1);
  const text = textOf(sectionFor(BROOKLYN_CB1));
  assert.match(text, new RegExp(`hold ${view.position_count} dated positions this board submitted`));
  assert.match(text, new RegExp(`on ${view.project_count} land use projects`));
});

/* ---------- navigation into the existing project experience ---------- */

test("every project destination is an ordinary anchor to the canonical route", () => {
  for (const boardId of Object.keys(LOOKUP.boards)) {
    const view = viewFor(boardId);
    for (const row of view.positions) {
      assert.equal(row.href, `/browse/zoning/#land/${row.project_id}`);
    }
    const html = renderCommunityBoardLandPositionsSection(view);
    const links = [...html.matchAll(/<a class="[^"]*board-land-position-link"([^>]*)>/g)].map((m) => m[1]);
    assert.equal(links.length, view.visible_count);
    for (const attrs of links) {
      assert.match(attrs, /href="\/browse\/zoning\/#land\/[A-Za-z0-9_-]+"/);
      // No new tab, no scripted click, no interception.
      assert.doesNotMatch(attrs, /target=/);
      assert.doesNotMatch(attrs, /\son[a-z]+=/);
    }
  }
});

test("inspection is a native button beside the anchor, never inside it", () => {
  const html = sectionFor(MANHATTAN_CB4);
  const buttons = [...html.matchAll(/<button class="board-land-position-inspect"([^>]*)>/g)];
  assert.equal(buttons.length, 2);
  for (const [, attrs] of buttons) {
    assert.match(attrs, /type="button"/);
    assert.match(attrs, /aria-label="Inspect the position recorded on /);
    assert.doesNotMatch(attrs, /href=/);
  }
  // The button is a sibling of the anchor: no anchor in this section wraps one.
  assert.doesNotMatch(html, /<a [^>]*board-land-position-link[^>]*>[^<]*<button/);
});

test("the overflow disclosure lives in the URL so Back returns the list as it was", () => {
  const crowded = Object.entries(LOOKUP.boards)
    .find(([, board]) => board.position_count > COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT);
  if (!crowded) {
    // No board currently exceeds the visible bound; the rule is proven over a
    // synthetic lookup rather than skipped.
    const board = LOOKUP.boards[BROOKLYN_CB1];
    const stretched = {
      ...LOOKUP,
      boards: {
        ...LOOKUP.boards,
        [BROOKLYN_CB1]: {
          ...board,
          positions: Array.from({ length: COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT + 2 }, (_, index) => ({
            ...board.positions[index % board.positions.length],
            project_id: `2026K${String(index).padStart(4, "0")}`,
            source_record_id: `synthetic-${index}`,
          })),
        },
      },
    };
    const view = viewFor(BROOKLYN_CB1, stretched);
    assert.equal(view.visible_count, COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT);
    assert.equal(view.overflow_count, 2);
    const html = renderCommunityBoardLandPositionsSection(view);
    assert.match(html, new RegExp(`id="${COMMUNITY_BOARD_LAND_POSITIONS_OVERFLOW_ANCHOR}"`));
    assert.match(html, new RegExp(`href="#${COMMUNITY_BOARD_LAND_POSITIONS_OVERFLOW_ANCHOR}"`));
    assert.match(html, new RegExp(`href="#${COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR}"`));
    // A native <details> would not survive Back; nothing here uses one.
    assert.doesNotMatch(html, /<details/);
    return;
  }
  const view = viewFor(crowded[0]);
  assert.equal(view.visible_count, COMMUNITY_BOARD_LAND_POSITION_VISIBLE_LIMIT);
  assert.ok(view.overflow_count > 0);
});

test("the document stylesheet is what collapses the overflow and hides the button", () => {
  assert.match(CSS, /\.board-land-positions-overflow > \.board-land-positions-overflow-list,/);
  assert.match(CSS, /\.board-land-positions-overflow:target > \.board-land-positions-overflow-list \{/);
  assert.match(CSS, /\.board-land-position-inspect \{\s*display: none;/);
  assert.match(CSS, /\[data-board-land-positions-ready\] \.board-land-position-inspect \{/);
});

/* ---------- inspecting in place ---------- */

function mountedSection(bodyId = MANHATTAN_CB4) {
  const { doc, container } = mountDocument(sectionFor(bodyId), { containerClass: "board-host" });
  const section = container.querySelector("[data-community-board-land-positions]");
  const controller = bindCommunityBoardLandPositions(section);
  return { doc, section, controller };
}

test("the payload parses only its own current shape", () => {
  const payload = JSON.parse(
    sectionFor(MANHATTAN_CB4).match(/data-board-land-position="([^"]*)"/)[1]
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
  );
  assert.equal(parseBoardLandPosition(JSON.stringify(payload)).id, DEWITT_54TH);
  assert.equal(parseBoardLandPosition(JSON.stringify({ ...payload, v: 99 })), null);
  assert.equal(parseBoardLandPosition("not json"), null);
  assert.equal(parseBoardLandPosition(""), null);
});

test("binding reveals the inspect control and only then", () => {
  const { doc, container } = mountDocument(sectionFor(MANHATTAN_CB4), { containerClass: "board-host" });
  const section = container.querySelector("[data-community-board-land-positions]");
  assert.equal(section.hasAttribute(BOARD_LAND_POSITION_READY_ATTRIBUTE), false);
  assert.equal(doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID), null);
  bindCommunityBoardLandPositions(section);
  assert.equal(section.hasAttribute(BOARD_LAND_POSITION_READY_ATTRIBUTE), true);
  assert.ok(doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID));
});

test("binding one section twice installs nothing twice", () => {
  const { section } = mountedSection();
  assert.equal(section.listenerCount("click"), 1);
  assert.equal(bindCommunityBoardLandPositions(section), null);
  assert.equal(section.listenerCount("click"), 1);
});

test("activating the control opens the record, and dismissing returns focus", () => {
  const { doc, section } = mountedSection();
  const button = section.querySelector(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}]`);
  click(button);

  const dialog = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("aria-labelledby"), BOARD_LAND_POSITION_TITLE_ID);
  assert.equal(dialog.querySelector(`#${BOARD_LAND_POSITION_TITLE_ID}`).textContent,
    "Dewitt Clinton Park North (629 West 54th Street)");

  const facts = dialog.querySelector(".board-land-position-dialog-facts").textContent;
  assert.match(facts, /Conditional Unfavorable/);
  assert.match(facts, /February 4, 2026/);
  assert.match(facts, /33 in favor, 1 against, 1 abstaining/);
  // The other body's position, with its absent date stated rather than filled.
  const others = dialog.querySelector(".board-land-position-dialog-others").textContent;
  assert.match(others, /Borough President/);
  assert.match(others, /The source records no vote date for this position\./);
  // The teaching copy travels with the record.
  assert.match(dialog.textContent, /is advisory/);
  assert.match(dialog.textContent, /vote on the board's recommendation motion/);

  // Focus lands inside on the dismiss control.
  assert.equal(doc.activeElement, dialog.querySelector("[data-board-land-position-close]"));

  // Opening navigates nothing: the destination is still one explicit choice.
  const open = dialog.querySelector(".board-land-position-dialog-open");
  assert.equal(open.getAttribute("href"), `/browse/zoning/#land/${DEWITT_54TH}`);
  assert.equal(open.hasAttribute("target"), false);

  click(dialog.querySelector("[data-board-land-position-close]"));
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, button);
});

test("Escape dismisses the record on the non-modal fallback path", () => {
  const { doc, section } = mountedSection();
  const dialog = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  // A browser without showModal gets the same dismissal contract.
  dialog.showModal = undefined;
  const button = section.querySelector(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}]`);
  click(button);
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  keydown(dialog, "Escape");
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, button);
});

test("Tab stays inside the record on the non-modal fallback path", () => {
  const { doc, section } = mountedSection();
  const dialog = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  dialog.showModal = undefined;
  click(section.querySelector(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}]`));
  const focusable = dialog.querySelectorAll("a[href], button:not([disabled])");
  assert.ok(focusable.length >= 2);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  last.focus();
  keydown(dialog, "Tab");
  assert.equal(doc.activeElement, first);

  first.focus();
  keydown(dialog, "Tab", { shiftKey: true });
  assert.equal(doc.activeElement, last);
});

test("inspecting a second record replaces the first rather than stacking", () => {
  const { doc, section } = mountedSection();
  const buttons = section.querySelectorAll(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}]`);
  click(buttons[0]);
  click(buttons[1]);
  const dialogs = doc.querySelectorAll(`#${BOARD_LAND_POSITION_DIALOG_ID}`);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].querySelector(`#${BOARD_LAND_POSITION_TITLE_ID}`).textContent,
    "Dewitt Clinton Park North (801 Eleventh Avenue)");
  assert.equal(dialogs[0].querySelectorAll(`#${BOARD_LAND_POSITION_TITLE_ID}`).length, 1);
});

test("the waiver record carries its own meaning into the inspected view", () => {
  const { doc, section } = mountedSection(STATEN_ISLAND_CB1);
  const button = section.querySelectorAll(`[${COMMUNITY_BOARD_LAND_POSITIONS_ATTRIBUTE}]`)
    .find((node) => node.getAttribute("data-board-land-position-id") === WAIVER_PROJECT);
  click(button);
  const dialog = doc.getElementById(BOARD_LAND_POSITION_DIALOG_ID);
  assert.match(dialog.textContent, /Waiver of Recommendation/);
  assert.match(dialog.textContent, /It is not support and it is not opposition\./);
  assert.match(dialog.textContent, /The source records no vote tally for this position\./);
});

/* ---------- the whole board document ---------- */

test("the board document carries the section and everything it already had", () => {
  const view = buildCommunityBoardConstellationView(MANHATTAN_CB4, documentSources());
  const html = renderCommunityBoardConstellationDocument(view);
  assert.match(html, new RegExp(`id="${COMMUNITY_BOARD_LAND_POSITIONS_ANCHOR}"`));
  assert.match(html, /community_board_land_positions_boot\.mjs/);
  // The board's own proceedings, committees and people are untouched.
  assert.match(html, /data-civic-object-kind="community-board-constellation"/);
  assert.match(html, /Back to community board sources/);
  assert.equal(view.land_positions.body_id, MANHATTAN_CB4);
});

test("a board document reads the same with no scripting at all", () => {
  const html = sectionFor(MANHATTAN_CB4);
  // Every fact the inspect control would show is already written into the row.
  const text = textOf(html);
  assert.match(text, /Position recorded: Conditional Unfavorable/);
  assert.match(text, /Voted February 4, 2026/);
  assert.match(text, /Recorded tally on the recommendation: 33 in favor, 1 against, 1 abstaining/);
  // Nothing on the page depends on an inline handler.
  assert.doesNotMatch(html, /\son(?:click|keydown|load)=/);
});

/* ---------- translation ---------- */

test("the section ships in every shipping language with the source text preserved", () => {
  const keys = Object.keys(COMMUNITY_BOARD_LAND_POSITION_STRINGS.en);
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const bag = COMMUNITY_BOARD_LAND_POSITION_STRINGS[lang];
    assert.ok(bag, `no strings for ${lang}`);
    assert.deepEqual(Object.keys(bag).sort(), keys.slice().sort(), lang);

    const html = sectionFor(MANHATTAN_CB4, { lang });
    const text = textOf(html);
    // Published values keep their own language and direction.
    assert.match(text, /Dewitt Clinton Park North \(801 Eleventh Avenue\)/, lang);
    assert.match(text, /Conditional Unfavorable/, lang);
    assert.match(html, /lang="en" dir="ltr"/, lang);
    // No unresolved translation key ever reaches the page.
    assert.doesNotMatch(text, /cblp_/, lang);
    if (lang !== "en") {
      assert.match(html, new RegExp(`lang="${lang}"`), lang);
      assert.match(html, new RegExp(`dir="${["ar", "ur"].includes(lang) ? "rtl" : "ltr"}"`), lang);
    }
  }
});

test("the translated absence and failure states keep their own meaning", () => {
  const boardIds = REGISTRY.sources
    .filter((row) => row.body_type === "community_board")
    .map((row) => row.body_id);
  const empty = boardIds.find((id) => !LOOKUP.boards[id]);
  const failed = { error: "unreadable", source: LOOKUP.source };
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const emptyHtml = renderCommunityBoardLandPositionsSection(viewFor(empty, LOOKUP), { lang });
    const failedHtml = renderCommunityBoardLandPositionsSection(viewFor(MANHATTAN_CB4, failed), { lang });
    assert.match(emptyHtml, /data-land-positions-state="none_recorded"/, lang);
    assert.match(failedHtml, /data-land-positions-state="unavailable"/, lang);
    // The two states never render the same sentence in any language.
    assert.notEqual(textOf(emptyHtml), textOf(failedHtml), lang);
    assert.doesNotMatch(textOf(emptyHtml), /cblp_/, lang);
    assert.doesNotMatch(textOf(failedHtml), /cblp_/, lang);
  }
});

/* ---------- provenance ---------- */

test("the artifact records its own source, vintage and boundary", () => {
  assert.equal(LOOKUP.source.dataset_id, LAND_PROJECTS.source.dataset);
  assert.equal(LOOKUP.source.source_url, `https://data.cityofnewyork.us/d/${LAND_PROJECTS.source.dataset}`);
  assert.equal(LOOKUP.source.observed_on, AUTHORITY.generated_at);
  assert.equal(LOOKUP.generated_at, AUTHORITY.generated_at);
  // The clock is the retained input's own vintage, never a build-time reading:
  // rebuilding without touching the inputs reproduces the artifact byte for
  // byte, which a wall clock could not do.
  assert.deepEqual(
    buildCommunityBoardLandPositions({
      authority: AUTHORITY,
      projects: LAND_PROJECTS,
      generatedAt: AUTHORITY.generated_at,
    }).generated_at,
    LOOKUP.generated_at,
  );
  assert.match(LOOKUP.negative_rule, /never a decision on the project/);
  assert.match(LOOKUP.negative_rule, /never a count of meetings/);
  assert.match(LOOKUP.negative_rule, /rather than a count of support for the development/);
});

test("the rendered section names the publisher and the date it was observed", () => {
  const html = sectionFor(BROOKLYN_CB1);
  assert.match(textOf(html), /Source: NYC Department of City Planning, Zoning Application Portal ?\. Observed /);
  assert.match(html, /href="https:\/\/data\.cityofnewyork\.us\/d\/hgx4-8ukb"/);
});

/* ---------- the committed capture evidence ---------- */

const CAPTURE = read("docs/evidence/board-land-positions/manifest.json");

test("the capture manifest is the proof, and no image binary is committed", () => {
  assert.equal(CAPTURE.schema, "cityscroll.board_land_position_capture.v1");
  assert.match(CAPTURE.revision, /^[0-9a-f]{40}$/);
  assert.equal(CAPTURE.data_vintage.community_board_land_positions, LOOKUP.source.observed_on);
  assert.deepEqual(CAPTURE.counts, LOOKUP.counts);
  assert.ok(CAPTURE.captures.length >= 20);
  for (const capture of CAPTURE.captures) {
    assert.match(capture.route, /^\/community-boards\//);
    assert.ok(capture.viewport.width > 0 && capture.viewport.height > 0, capture.case);
    assert.equal(capture.revision, CAPTURE.revision, capture.case);
    assert.deepEqual(capture.data_vintage, CAPTURE.data_vintage, capture.case);
    assert.ok(capture.assertion.length > 40, capture.case);
    assert.match(capture.render_sha256, /^[0-9a-f]{64}$/, capture.case);
    if (capture.screenshot) {
      assert.match(capture.screenshot_sha256, /^[0-9a-f]{64}$/, capture.case);
      // The rendered image stays local: the receipt carries its digest, and the
      // path it names is under an ignored working directory, never the tree.
      assert.match(capture.screenshot, /^\.artifacts\//, capture.case);
      assert.doesNotMatch(capture.screenshot, /^docs\//, capture.case);
    }
  }
  assert.equal(CAPTURE.axe_all_pass, true);

  // The committed evidence directory holds the receipt and nothing else, so no
  // image binary can reach the repository through it.
  const files = readdirSync(new URL("../docs/evidence/board-land-positions/", import.meta.url));
  assert.deepEqual(files.sort(), ["manifest.json"]);
});

test("the capture manifest covers both viewports, both fallbacks and every language", () => {
  const cases = new Set(CAPTURE.captures.map((capture) => capture.case));
  for (const lang of ["en", ...SHIPPING_LANGS]) assert.ok(cases.has(`board-language-${lang}`), lang);
  assert.ok(cases.has("board-no-recorded-position"));
  assert.ok(cases.has("board-positions-unavailable"));
  assert.ok(cases.has("board-position-keyboard"));
  assert.ok(cases.has("board-position-inspect-journey"));

  const widths = new Set(CAPTURE.captures
    .filter((capture) => capture.case.startsWith("board-land-positions-shared-date")
      && capture.javascript === "enabled")
    .map((capture) => capture.viewport.width));
  assert.deepEqual([...widths].sort((a, b) => a - b), [390, 1440]);
});

test("the captured pages prove the two applications stayed two, in both viewports", () => {
  const shared = CAPTURE.captures.filter((capture) => capture.case.startsWith("board-land-positions-shared-date"));
  assert.ok(shared.length >= 3);
  for (const capture of shared) {
    const observed = capture.observed;
    assert.equal(observed.section_present, true, capture.case);
    assert.equal(observed.rendered_rows, 2, capture.case);
    assert.equal(observed.distinct_project_hrefs, 2, capture.case);
    // One recorded date carrying two rows: the pages never turn it into two.
    assert.deepEqual(observed.distinct_recorded_dates, ["2026-02-04"], capture.case);
    assert.equal(observed.recorded_date_count_attribute, "1", capture.case);
    assert.equal(observed.position_count_attribute, "2", capture.case);
    assert.equal(observed.no_horizontal_overflow, true, capture.case);
  }
});

test("the captured pages prove the no-scripting fallback and the native affordances", () => {
  const withoutScript = CAPTURE.captures.filter((capture) => capture.javascript === "disabled");
  assert.ok(withoutScript.length >= 2);
  for (const capture of withoutScript) {
    assert.equal(capture.observed.section_present, true, capture.case);
    assert.ok(capture.observed.rendered_rows > 0, capture.case);
    // The inspect control is in the markup but never offered without the
    // behaviour behind it; the project links work regardless.
    assert.equal(capture.observed.ready_for_inspection, false, capture.case);
    assert.equal(capture.observed.inspect_controls.visible, 0, capture.case);
    assert.equal(capture.observed.links.native, true, capture.case);
    assert.equal(capture.observed.links.new_tab, 0, capture.case);
    assert.equal(capture.observed.links.scripted, 0, capture.case);
  }

  for (const capture of CAPTURE.captures.filter((c) => c.observed?.inspect_controls && c.javascript === "enabled")) {
    const controls = capture.observed.inspect_controls;
    assert.equal(controls.native, true, capture.case);
    assert.equal(controls.labelled, true, capture.case);
    assert.equal(controls.nested_in_link, 0, capture.case);
    assert.equal(controls.visible, controls.count, capture.case);
    assert.equal(capture.observed.links.reachable, capture.observed.links.visible, capture.case);
    assert.ok(capture.observed.smallest_target_px >= 24, `${capture.case}: ${capture.observed.smallest_target_px}`);
  }
});

test("the captured journey preserves scope, scroll and the list through inspect and Back", () => {
  const journeys = CAPTURE.captures.filter((capture) => capture.case === "board-position-inspect-journey");
  assert.equal(journeys.length, 2);
  for (const { observed, viewport } of journeys) {
    const at = `${viewport.width}x${viewport.height}`;
    assert.equal(observed.dialog_open, true, at);
    assert.equal(observed.dialog_labelled_by, "board-land-position-inspect-title", at);
    assert.equal(observed.focus_inside_dialog, true, at);
    // Inspecting changes nothing about where the reader is.
    assert.equal(observed.url_unchanged_by_inspection, true, at);
    assert.equal(observed.scroll_preserved_through_inspection, true, at);
    // The teaching copy and the other body's undated position travel with it.
    assert.equal(observed.dialog_states_advisory, true, at);
    assert.equal(observed.dialog_states_tally_meaning, true, at);
    assert.equal(observed.dialog_states_other_body, true, at);
    assert.equal(observed.dialog_states_missing_vote_date, true, at);
    // Escape dismisses and focus comes back to the control it opened from.
    assert.equal(observed.dialog_closed_by_escape, true, at);
    assert.equal(observed.focus_returned_to_control, true, at);
    // The full record is a real destination, and Back returns the board intact.
    assert.equal(observed.dialog_open_href, `/browse/zoning/#land/${DEWITT_ELEVENTH}`, at);
    assert.equal(observed.left_for_path, "/browse/zoning/", at);
    assert.equal(observed.left_for_hash, `land/${DEWITT_ELEVENTH}`, at);
    assert.equal(observed.returned_path, `/community-boards/${MANHATTAN_CB4}/`, at);
    assert.equal(observed.scroll_restored, true, at);
    assert.equal(observed.list_undisturbed, true, at);
    assert.equal(observed.calendar_undisturbed, true, at);
    assert.equal(observed.ready_on_return, true, at);
  }
});

test("the captured keyboard pass drives the whole affordance without a pointer", () => {
  const keyboard = CAPTURE.captures.find((capture) => capture.case === "board-position-keyboard");
  assert.ok(keyboard);
  assert.deepEqual(keyboard.observed, {
    control_focusable: true,
    opened_by_enter: true,
    focus_on_dismiss_control: true,
    tab_stays_inside: true,
    closed_by_escape: true,
    focus_returned: true,
  });
});

test("the captured language pages resolve every label and preserve the source text", () => {
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const capture = CAPTURE.captures.find((row) => row.case === `board-language-${lang}`);
    assert.ok(capture, lang);
    assert.equal(capture.observed.section_present, true, lang);
    assert.equal(capture.observed.unresolved_key_rendered, false, lang);
    assert.equal(capture.observed.no_horizontal_overflow, true, lang);
    assert.equal(capture.observed.published_title_preserved, true, lang);
    assert.equal(capture.observed.published_position_preserved, true, lang);
    if (lang !== "en") {
      assert.equal(capture.observed.language, lang, lang);
      assert.equal(capture.observed.direction, ["ar", "ur"].includes(lang) ? "rtl" : "ltr", lang);
    }
  }
});

test("the captured absence and failure pages stay two different answers", () => {
  const absent = CAPTURE.captures.find((capture) => capture.case === "board-no-recorded-position");
  const failed = CAPTURE.captures.find((capture) => capture.case === "board-positions-unavailable");
  assert.equal(absent.observed.state, "none_recorded");
  assert.equal(absent.observed.project_links, 0);
  assert.equal(absent.observed.retained_project_count, String(LOOKUP.counts.retained_projects));
  assert.equal(failed.observed.state, "unavailable");
  assert.equal(failed.observed.project_links, 0);
  // The published source stays reachable through the failure.
  assert.equal(failed.observed.source_link, 1);
  assert.notEqual(absent.render_sha256, failed.render_sha256);
});
