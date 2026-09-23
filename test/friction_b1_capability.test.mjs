/**
 * Stable board-decision destinations across admitted candidates.
 *
 * A shared decision link must keep its meaning when the collection is
 * reordered or another decision is inserted. These tests exercise the general
 * encoding and frozen-alias contract across every currently admitted decision,
 * including the Saturday sanitation opt-in admitted through the reviewed-data
 * path, rather than hard-coding a single fixture case.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMUNITY_BOARD_FROZEN_POSITIONAL_DECISION_ALIASES,
  buildCommunityBoardResolutionPilot,
  communityBoardDecisionAnchorId,
  communityBoardDecisionCandidateIdFromAnchor,
  communityBoardDecisionCopyTarget,
  communityBoardDecisionFrozenAliasIds,
  communityBoardDecisionHref,
  communityBoardResolutionViewForBoard,
  publicCommunityBoardResolutionPilot,
  renderCommunityBoardDecisionsSection,
} from "../site/community_board_resolution_pilot.mjs";
import { testClockISOString } from "./helpers/test_clock.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const REVIEW = read("site/data/community_board_resolution_sources/board_resolution_pilot_review.v1.json");
const PUBLIC = read("site/data/community_board_resolution_pilot.json");

const D1 = "brooklyn-cb-15:2026-06-30:bsa-154-90-bzii";
const D2 = "manhattan-cb-03:2026-05-26:transportation-2";
const D3 = "brooklyn-cb-15:2026-05-26:candidate-01";

const HELD_CONFLICTING_ADDRESS = "manhattan-cb-03:2026-05-26:sla-2";
const HELD_AMENDMENT_ORDER = REVIEW.candidates.find((row) => row.held_reason === "passage_predates_recorded_amendment")?.candidate_id;
const HELD_UNDATED = REVIEW.candidates.find((row) => row.held_reason === "document_states_no_meeting_date")?.candidate_id;

const pilot = buildCommunityBoardResolutionPilot(REVIEW);
const publicPilot = publicCommunityBoardResolutionPilot(pilot);
const decisionOf = (id) => publicPilot.by_board
  && Object.values(publicPilot.by_board).flat().find((row) => row.candidate_id === id);

function renderBoard(boardId, decisions = publicPilot.by_board[boardId]) {
  return renderCommunityBoardDecisionsSection({
    schema: "cityscroll.community_board_resolution_pilot_view.v1",
    board_id: boardId,
    reviewed_on: publicPilot.reviewed_on,
    decisions,
    documents_read: (publicPilot.documents || []).filter((row) => row.board_id === boardId).length,
  }, { lang: "en" });
}

function destinationMap(html) {
  const map = new Map();
  for (const match of html.matchAll(/id="(board-decision-[A-Za-z0-9_-]+)"[^>]*data-board-decision="([^"]+)"/g)) {
    map.set(match[2], match[1]);
  }
  return map;
}

test("A1 every admitted decision has an injective stable destination with source and vote attribution", () => {
  const clock = testClockISOString();
  assert.match(clock, /^\d{4}-\d{2}-\d{2}T/);

  const published = Object.values(publicPilot.by_board).flat();
  assert.ok(published.length >= 3, "the capability covers multiple real decisions");
  assert.ok(decisionOf(D1), "D1 is admitted");
  assert.ok(decisionOf(D2), "D2 is admitted");
  assert.ok(decisionOf(D3), "D3 is admitted through reviewed data");

  const seenAnchors = new Set();
  for (const decision of published) {
    const anchor = communityBoardDecisionAnchorId(decision.candidate_id);
    const href = communityBoardDecisionHref(decision.board_id, decision.candidate_id);
    const copy = communityBoardDecisionCopyTarget(decision.board_id, decision.candidate_id);
    assert.ok(anchor, `${decision.candidate_id} encodes`);
    assert.equal(communityBoardDecisionCandidateIdFromAnchor(anchor), decision.candidate_id);
    assert.equal(href, `/community-boards/${decision.board_id}/#${anchor}`);
    assert.equal(copy, `https://cityscroll.org${href}`);
    assert.equal(seenAnchors.has(anchor), false, `${anchor} is unique`);
    seenAnchors.add(anchor);

    const html = renderBoard(decision.board_id);
    assert.match(html, new RegExp(`id="${anchor}"`));
    assert.match(html, new RegExp(`data-board-decision="${decision.candidate_id}"`));
    assert.ok(html.includes(decision.document.document_url), `${decision.candidate_id} keeps its source`);
    assert.ok(html.includes('data-object-card-copy="https://cityscroll.org'), `${decision.candidate_id} exposes a copy target`);
    for (const vote of decision.votes) {
      assert.match(html, new RegExp(`data-vote-stage="${vote.stage}"`));
      assert.ok(html.includes(String(vote.yes)), `${decision.candidate_id} shows yes=${vote.yes}`);
      assert.ok(html.includes(String(vote.no)), `${decision.candidate_id} shows no=${vote.no}`);
      assert.ok(html.includes(String(vote.abstain)), `${decision.candidate_id} shows abstain=${vote.abstain}`);
    }
  }

  // Distinct candidate ids must never collide under the encoding.
  assert.notEqual(communityBoardDecisionAnchorId(D1), communityBoardDecisionAnchorId(D2));
  assert.notEqual(communityBoardDecisionAnchorId(D1), communityBoardDecisionAnchorId(D3));
  assert.notEqual(communityBoardDecisionAnchorId(D2), communityBoardDecisionAnchorId(D3));
});

test("A2 inserting and reversing the collection leaves all three canonical links unchanged", () => {
  const before = {
    [D1]: communityBoardDecisionHref("brooklyn-cb-15", D1),
    [D2]: communityBoardDecisionHref("manhattan-cb-03", D2),
    [D3]: communityBoardDecisionHref("brooklyn-cb-15", D3),
  };
  assert.equal(decisionOf(D3).votes[0].yes, 39);
  assert.equal(decisionOf(D3).votes[0].no, 1);
  assert.equal(decisionOf(D3).votes[0].abstain, 1);

  const brooklyn = [...publicPilot.by_board["brooklyn-cb-15"]];
  assert.equal(brooklyn.length, 2);
  const reversed = [...brooklyn].reverse();
  const inserted = [
    {
      ...brooklyn[0],
      candidate_id: "brooklyn-cb-15:synthetic-insert:probe",
      title: "Synthetic insert used only to prove link stability",
      votes: brooklyn[0].votes,
      passages: brooklyn[0].passages,
      excluded_votes: [],
      non_adopted_notes: [],
      // labeled synthetic mutation
      synthetic_mutation: true,
    },
    ...reversed,
  ];

  const beforeHtml = renderBoard("brooklyn-cb-15", brooklyn);
  const afterHtml = renderBoard("brooklyn-cb-15", inserted);
  const beforeMap = destinationMap(beforeHtml);
  const afterMap = destinationMap(afterHtml);

  for (const id of [D1, D3]) {
    assert.equal(beforeMap.get(id), communityBoardDecisionAnchorId(id));
    assert.equal(afterMap.get(id), beforeMap.get(id), `${id} keeps its anchor after insert+reverse`);
    assert.equal(communityBoardDecisionHref("brooklyn-cb-15", id), before[id]);
  }
  assert.equal(before[D2], communityBoardDecisionHref("manhattan-cb-03", D2));
  assert.match(afterHtml, /id="board-decisions-1"/);
  // The frozen alias stays nested under D1 even when D1 is no longer first.
  assert.match(
    afterHtml,
    new RegExp(`data-board-decision="${D1}"[\\s\\S]{0,200}id="board-decisions-1"`),
  );
});

test("A3 vote attribution stays decision-owned across committee and neighboring tallies", () => {
  const d1 = decisionOf(D1);
  const d2 = decisionOf(D2);
  assert.deepEqual(
    d1.votes.map((vote) => ({ stage: vote.stage, yes: vote.yes, no: vote.no, abstain: vote.abstain })),
    [
      { stage: "committee", yes: 10, no: 0, abstain: 0 },
      { stage: "full_board", yes: 29, no: 0, abstain: 0 },
    ],
  );
  assert.deepEqual(
    d2.votes.map((vote) => ({ stage: vote.stage, yes: vote.yes, no: vote.no, abstain: vote.abstain })),
    [{ stage: "full_board", yes: 34, no: 1, abstain: 0 }],
  );

  const manhattanHtml = renderBoard("manhattan-cb-03");
  assert.ok(manhattanHtml.includes("34"));
  assert.ok(manhattanHtml.includes("1"));
  // Neighboring / omnibus tallies remain labeled as not this decision.
  assert.ok(d2.excluded_votes.some((vote) => vote.exclusion_reason === "omnibus_that_excludes_this_item"));
  assert.ok(d2.excluded_votes.some((vote) => vote.exclusion_reason === "another_item"));
  for (const excluded of d2.excluded_votes) {
    assert.ok(manhattanHtml.includes(`${excluded.yes}-${excluded.no}-${excluded.abstain}`));
  }

  const brooklynHtml = renderBoard("brooklyn-cb-15");
  assert.match(brooklynHtml, /data-vote-stage="committee"/);
  assert.match(brooklynHtml, /data-vote-stage="full_board"/);
  assert.ok(brooklynHtml.includes("10"));
  assert.ok(brooklynHtml.includes("29"));
  assert.ok(brooklynHtml.includes("39"));
});

test("A4 held conflicting-address, amendment-order, and undated candidates stay unpublished", () => {
  assert.ok(HELD_CONFLICTING_ADDRESS);
  assert.ok(HELD_AMENDMENT_ORDER);
  assert.ok(HELD_UNDATED);

  const heldIds = new Set(pilot.held_candidates.map((row) => row.candidate_id));
  assert.ok(heldIds.has(HELD_CONFLICTING_ADDRESS));
  assert.ok(heldIds.has(HELD_AMENDMENT_ORDER));
  assert.ok(heldIds.has(HELD_UNDATED));

  const serialized = JSON.stringify(publicPilot);
  for (const id of [HELD_CONFLICTING_ADDRESS, HELD_AMENDMENT_ORDER, HELD_UNDATED]) {
    assert.equal(serialized.includes(id), false, `${id} stays out of the resident artifact`);
  }

  for (const decision of Object.values(publicPilot.by_board).flat()) {
    assert.notEqual(decision.authority?.relation, "final_agency_approval");
    const html = renderBoard(decision.board_id);
    assert.doesNotMatch(html, /final agency approval/i);
    assert.ok(html.includes("says nothing about what the city did afterwards")
      || html.includes("not everything the board has decided"));
  }
});

test("A5 real HTTP routes serve encoded identities, frozen aliases, and no-JS destinations", async () => {
  const pages = new Map();
  for (const boardId of Object.keys(publicPilot.by_board)) {
    const html = `<!doctype html><html><body>${renderBoard(boardId)}</body></html>`;
    pages.set(`/community-boards/${boardId}/`, html);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = pages.get(url.pathname);
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const decision of Object.values(publicPilot.by_board).flat()) {
      const href = communityBoardDecisionHref(decision.board_id, decision.candidate_id);
      const response = await fetch(`${base}${href.split("#")[0]}`);
      assert.equal(response.status, 200, `${href} is served`);
      const html = await response.text();
      const anchor = communityBoardDecisionAnchorId(decision.candidate_id);
      assert.ok(html.includes(`id="${anchor}"`), `${decision.candidate_id} is present without JavaScript`);
      assert.ok(html.includes(`data-object-card-copy="${communityBoardDecisionCopyTarget(decision.board_id, decision.candidate_id)}"`));
      assert.ok(html.includes(`href="${href}"`), "the copyable destination link is in the markup");
    }

    for (const [boardId, aliases] of Object.entries(COMMUNITY_BOARD_FROZEN_POSITIONAL_DECISION_ALIASES)) {
      for (const [position, candidateId] of Object.entries(aliases)) {
        const response = await fetch(`${base}/community-boards/${boardId}/`);
        const html = await response.text();
        assert.ok(html.includes(`id="board-decisions-${position}"`));
        assert.deepEqual(communityBoardDecisionFrozenAliasIds(boardId, candidateId), [`board-decisions-${position}`]);
        assert.ok(html.includes(`data-board-decision="${candidateId}"`));
      }
    }

    // Narrow-screen keyboard copy journey: the copy control carries the absolute
    // destination and remains focusable markup without requiring script to exist.
    const d1Href = communityBoardDecisionHref("brooklyn-cb-15", D1);
    const d1Copy = communityBoardDecisionCopyTarget("brooklyn-cb-15", D1);
    const brooklyn = await (await fetch(`${base}/community-boards/brooklyn-cb-15/`)).text();
    assert.match(brooklyn, new RegExp(`data-object-card-copy="${d1Copy.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"`));
    assert.match(brooklyn, /class="ui-object-card-copy board-decision-copy"/);
    assert.ok(brooklyn.includes(`href="${d1Href}"`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("withdrawn destinations stay put with a source explanation (synthetic mutation)", () => {
  const original = decisionOf(D2);
  const withdrawn = {
    ...original,
    withdrawn: true,
    admission: "withdrawn",
    withdrawal_explanation: "Synthetic withdrawal used only to prove destination retention.",
    synthetic_mutation: true,
  };
  const html = renderBoard("manhattan-cb-03", [withdrawn]);
  const anchor = communityBoardDecisionAnchorId(D2);
  assert.match(html, new RegExp(`id="${anchor}"`));
  assert.match(html, /data-decision-withdrawn="1"/);
  assert.ok(html.includes("Synthetic withdrawal used only to prove destination retention."));
  assert.ok(html.includes(original.document.document_url));
  assert.match(html, /id="board-decisions-1"/);
  assert.doesNotMatch(html, new RegExp(`data-board-decision="${D1}"`));
});

test("committed public artifact matches the rebuilt reviewed-data projection", () => {
  assert.deepEqual(PUBLIC, JSON.parse(JSON.stringify(publicPilot)));
  assert.equal(communityBoardResolutionViewForBoard(PUBLIC, "brooklyn-cb-15").decisions.length, 2);
  assert.equal(communityBoardResolutionViewForBoard(PUBLIC, "manhattan-cb-03").decisions.length, 1);
  assert.equal(REVIEW.extraction.optical_character_recognition_used, false);
  assert.equal(REVIEW.documents.find((row) => row.document_id === "brooklyn-cb-15:2026-05-26:general-board-minutes").extracted_text_sha256,
    "3c83736ad7353fc0f4fa845bff007cf271fca7daae366afa38cdd42c37432c65");
});
