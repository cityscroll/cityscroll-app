/**
 * Accepted community-board decisions from a bounded four-document reading.
 *
 * Minutes are already discoverable. What was missing was the decision: the
 * board's own operative words with the one tally that belongs to them. Getting
 * that wrong is worse than not publishing it, because a nearby tally attached
 * to the wrong item reads as a civic fact.
 *
 * These tests pin the reasoning rather than a snapshot. Counts are recomputed
 * from the committed reviewed input by a second pass, so a later review that
 * legitimately reads another document reports its own figures. What is fixed is
 * the behaviour: which tally a decision may claim, which tallies it may not,
 * that a committee vote never stands in for a full-board vote, where a quoted
 * passage stops, that two source spellings of an address block a building
 * match, and that a document stating no meeting date is never given one.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  COMMUNITY_BOARD_DECISIONS_ANCHOR,
  COMMUNITY_BOARD_MOTION_OWNERSHIP,
  COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA,
  COMMUNITY_BOARD_RESOLUTION_REVIEW_QUEUE_SCHEMA,
  COMMUNITY_BOARD_RESOLUTION_REVIEW_SCHEMA,
  COMMUNITY_BOARD_RESOLUTION_VIEW_SCHEMA,
  COMMUNITY_BOARD_VOTE_STAGES,
  buildCommunityBoardResolutionPilot,
  communityBoardDecisionAddressConflict,
  communityBoardResolutionReviewQueue,
  communityBoardResolutionSearchTopics,
  communityBoardResolutionViewForBoard,
  projectCommunityBoardResolutionCandidate,
  publicCommunityBoardResolutionPilot,
  renderCommunityBoardDecisionsSection,
  selectCommunityBoardDecisionVotes,
} from "../site/community_board_resolution_pilot.mjs";
import { projectBoardSearchDocument } from "../site/board_search_producer.mjs";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../site/i18n.js");
const SHIPPING_LANGS = globalThis.window.SHIPPING_LANGS;

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const REVIEW = read("site/data/community_board_resolution_sources/board_resolution_pilot_review.v1.json");
const PUBLIC = read("site/data/community_board_resolution_pilot.json");
const QUEUE = read("worker/src/data/community_board_resolution_review_queue.json");
const BOARD_LOOKUP = read("site/data/community_board_constellation_lookup.json");

// The two reviewed decisions, addressed by their own identifiers so a failure
// names the record that moved rather than an index that shifted.
const BIKE_LANE = "manhattan-cb-03:2026-05-26:transportation-2";
const BSA_CASE = "brooklyn-cb-15:2026-06-30:bsa-154-90-bzii";
const NOODLE = "manhattan-cb-03:2026-05-26:sla-2";
const MANHATTAN = "manhattan-cb-03";
const BROOKLYN = "brooklyn-cb-15";

const pilot = buildCommunityBoardResolutionPilot(REVIEW);
const decisionOf = (id) => pilot.decisions.find((row) => row.candidate_id === id);
const heldOf = (id) => pilot.held_candidates.find((row) => row.candidate_id === id);
const reviewedCandidate = (id) => REVIEW.candidates.find((row) => row.candidate_id === id);
const textOf = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("the reviewed input describes four documents that were actually read", () => {
  assert.equal(REVIEW.schema, COMMUNITY_BOARD_RESOLUTION_REVIEW_SCHEMA);
  assert.equal(REVIEW.documents.length, 4);
  assert.equal(REVIEW.extraction.optical_character_recognition_used, false);
  const boards = new Set(REVIEW.documents.map((row) => row.board_id));
  assert.deepEqual([...boards].sort(), [BROOKLYN, MANHATTAN]);
  for (const document of REVIEW.documents) {
    assert.match(document.document_url, /^https:\/\/www\.nyc\.gov\//, `${document.document_id} names a published URL`);
    assert.match(document.extracted_text_sha256, /^[0-9a-f]{64}$/, `${document.document_id} carries a text digest`);
    assert.match(document.document_sha256, /^[0-9a-f]{64}$/, `${document.document_id} carries a document digest`);
    assert.ok(document.candidate_blocks_observed >= 1, `${document.document_id} observed at least one candidate`);
  }
  // Every candidate belongs to a document that was read, and every document's
  // observed candidate count is accounted for by retained candidates.
  const perDocument = new Map(REVIEW.documents.map((row) => [row.document_id, 0]));
  for (const candidate of REVIEW.candidates) {
    assert.ok(perDocument.has(candidate.document_id), `${candidate.candidate_id} names a read document`);
    perDocument.set(candidate.document_id, perDocument.get(candidate.document_id) + 1);
  }
  for (const document of REVIEW.documents) {
    assert.equal(perDocument.get(document.document_id), document.candidate_blocks_observed,
      `${document.document_id} retains every candidate it observed`);
  }
});

test("every candidate is retained as either a published decision or a held one", () => {
  const projected = REVIEW.candidates.map((row) => projectCommunityBoardResolutionCandidate(row, REVIEW));
  assert.equal(projected.length, REVIEW.candidates.length);
  assert.equal(pilot.decisions.length + pilot.held_candidates.length, REVIEW.candidates.length);
  assert.equal(pilot.coverage.candidate_blocks_observed, REVIEW.candidates.length);
  for (const row of pilot.held_candidates) {
    assert.ok(row.held_reason, `${row.candidate_id} states why it was held`);
  }
  // The two reviewed examples are published; nothing is published without a review.
  assert.ok(decisionOf(BIKE_LANE), "the bicycle lane decision is published");
  assert.ok(decisionOf(BSA_CASE), "the board of standards case is published");
  for (const decision of pilot.decisions) {
    assert.equal(reviewedCandidate(decision.candidate_id).admission, "published",
      `${decision.candidate_id} was published only because the review said so`);
  }
});

test("a decision carries the tally that owns its motion, and no other", () => {
  const decision = decisionOf(BIKE_LANE);
  assert.equal(decision.votes.length, 1);
  const [vote] = decision.votes;
  assert.equal(vote.stage, "full_board");
  assert.equal(vote.motion_ownership, "names_this_item");
  assert.equal(vote.subject_wording, "Transportation item 2");
  assert.deepEqual(
    { yes: vote.yes, no: vote.no, abstain: vote.abstain, present_not_voting: vote.present_not_voting },
    { yes: 34, no: 1, abstain: 0, present_not_voting: 0 },
  );
  assert.equal(vote.result, "passed");

  // The three tallies a nearest-match parser would reach for are excluded, each
  // for the reason it is not this decision.
  const excluded = new Map(decision.excluded_votes.map((row) => [row.subject_wording, row]));
  const referral = excluded.get("send Transportation item 4 to Landmarks Committee");
  assert.equal(referral.exclusion_reason, "referral_motion_on_another_item");
  assert.deepEqual([referral.yes, referral.no, referral.abstain], [3, 28, 2]);
  assert.equal(referral.result, "did_not_pass");
  const amendment = excluded.get("amending Transportation item 4");
  assert.equal(amendment.exclusion_reason, "amendment_to_another_item");
  assert.deepEqual([amendment.yes, amendment.no, amendment.abstain], [32, 2, 1]);
  const omnibus = excluded.get("excluding Transportation items 2, 3, 4");
  assert.equal(omnibus.exclusion_reason, "omnibus_that_excludes_this_item");
  assert.deepEqual([omnibus.yes, omnibus.no, omnibus.abstain], [35, 0, 0]);
  // None of the excluded tallies can be mistaken for the decision's own.
  for (const row of decision.excluded_votes) {
    assert.notEqual(row.subject_wording, vote.subject_wording);
  }
});

test("an omnibus that excepts an item can never be assigned to it", () => {
  const omnibusOwns = selectCommunityBoardDecisionVotes({
    votes: [{
      stage: "full_board", subject_wording: "excluding SLA item 3", motion_ownership: "omnibus_that_covers_this_item",
      yes: 35, no: 0, abstain: 0, result: "passed", text: "35 YES 0 NO 0 ABS", source_lines: [1, 1],
    }],
  });
  assert.equal(omnibusOwns.votes.length, 1, "an omnibus that covers the item is assignable");

  // The same tally offered without a recognised ownership claim is excluded,
  // not quietly attached.
  const unowned = selectCommunityBoardDecisionVotes({
    votes: [{
      stage: "full_board", subject_wording: "excluding Transportation items 2, 3, 4", motion_ownership: "nearest_tally",
      yes: 35, no: 0, abstain: 0, result: "passed", text: "35 YES 0 NO 0 ABS", source_lines: [1, 1],
    }],
  });
  assert.equal(unowned.votes.length, 0);
  assert.equal(unowned.excluded_votes[0].exclusion_reason, "tally_does_not_name_this_item");

  // A motion that did not pass is never a decision, whatever it claims.
  const failed = selectCommunityBoardDecisionVotes({
    votes: [{
      stage: "full_board", subject_wording: "Transportation item 2", motion_ownership: "names_this_item",
      yes: 3, no: 28, abstain: 2, result: "did_not_pass", text: "3 YES 28 NO 2 ABS", source_lines: [1, 1],
    }],
  });
  assert.equal(failed.votes.length, 0);
  assert.equal(failed.excluded_votes[0].exclusion_reason, "motion_did_not_pass");

  // A tally with no stated subject cannot own anything.
  const unnamed = selectCommunityBoardDecisionVotes({
    votes: [{
      stage: "full_board", motion_ownership: "names_this_item",
      yes: 36, no: 0, abstain: 0, result: "passed", text: "36 YES 0 NO 0 ABS", source_lines: [1, 1],
    }],
  });
  assert.equal(unnamed.votes.length, 0);
  assert.equal(unnamed.excluded_votes[0].exclusion_reason, "tally_states_no_subject");

  assert.ok(!COMMUNITY_BOARD_MOTION_OWNERSHIP.includes("nearest_tally"));
});

test("a committee vote and a full board vote stay distinct records", () => {
  const decision = decisionOf(BSA_CASE);
  assert.equal(decision.votes.length, 2);
  assert.ok(decision.has_committee_vote && decision.has_full_board_vote);
  const byStage = Object.fromEntries(decision.votes.map((row) => [row.stage, row]));
  assert.deepEqual(
    [byStage.committee.yes, byStage.committee.no, byStage.committee.abstain],
    [10, 0, 0],
  );
  assert.deepEqual(
    [byStage.full_board.yes, byStage.full_board.no, byStage.full_board.abstain],
    [29, 0, 0],
  );
  // Neither tally is derived from, folded into or averaged with the other.
  assert.notEqual(byStage.committee.yes, byStage.full_board.yes);
  assert.notDeepEqual(byStage.committee.source_lines, byStage.full_board.source_lines);
  for (const stage of COMMUNITY_BOARD_VOTE_STAGES) {
    assert.ok(byStage[stage], `the decision keeps its ${stage} record`);
  }

  const html = renderCommunityBoardDecisionsSection(
    communityBoardResolutionViewForBoard(PUBLIC, BROOKLYN),
    { lang: "en" },
  );
  assert.match(html, /data-vote-stage="committee"/);
  assert.match(html, /data-vote-stage="full_board"/);
  assert.match(textOf(html), /Committee vote: 10 in favour/);
  assert.match(textOf(html), /Full board vote: 29 in favour/);
  assert.match(textOf(html), /Neither one replaces the other/);
});

test("the board of standards case keeps its own jurisdiction and adopts no suggestion", () => {
  const decision = decisionOf(BSA_CASE);
  assert.equal(decision.authority.authority_name, "New York City Board of Standards and Appeals");
  assert.equal(decision.authority.case_number, "154-90-BZII");
  assert.equal(decision.authority.review_regime, "bsa_variance_modification");
  assert.equal(decision.authority.is_ulurp, false);

  // The impact-glass exchange is retained as discussion, and is never promoted
  // into the adopted decision.
  assert.equal(decision.non_adopted_notes.length, 1);
  const [note] = decision.non_adopted_notes;
  assert.equal(note.classification, "discussion_not_adopted_condition");
  assert.match(note.text, /impact glass/);
  for (const passage of decision.passages) {
    assert.doesNotMatch(passage.text, /impact glass/,
      "a discussion note never enters the operative passage");
  }

  const text = textOf(renderCommunityBoardDecisionsSection(
    communityBoardResolutionViewForBoard(PUBLIC, BROOKLYN),
    { lang: "en" },
  ));
  assert.match(text, /not a ULURP land use review/);
  assert.match(text, /suggestion raised in discussion is not a condition the board adopted/);
});

test("a quoted passage stops where the source's next item begins", () => {
  const decision = decisionOf(BIKE_LANE);
  const operative = decision.passages.find((row) => row.role === "operative");
  assert.match(operative.text, /^Therefore, be it resolved/);
  assert.match(operative.text, /between 2nd and 3rd Avenues\.$/);
  // The line after the passage is the next numbered agenda item. A raw split
  // keeps it; the reviewed passage does not.
  assert.equal(decision.passage_boundary.ends_before_source_line, operative.source_lines[1] + 1);
  assert.match(decision.passage_boundary.next_block_first_line, /^3\. Street Co-naming/);
  assert.doesNotMatch(operative.text, /Street Co-naming/);
  assert.ok(operative.source_lines[0] < operative.source_lines[1]);

  // The board's decision is quoted with the specifics the reader came for.
  assert.match(operative.text, /continuous 5' standard bike lane/);
  assert.match(operative.text, /elimination of a parking lane on the north side/);

  const html = renderCommunityBoardDecisionsSection(
    communityBoardResolutionViewForBoard(PUBLIC, MANHATTAN),
    { lang: "en" },
  );
  assert.ok(html.includes(operative.text.replace(/'/g, "&#39;")),
    "the section quotes the passage exactly as reviewed");
});

test("two source spellings of one address hold the candidate and block a building match", () => {
  const conflict = communityBoardDecisionAddressConflict(reviewedCandidate(NOODLE));
  assert.equal(conflict.conflicting, true);
  assert.equal(conflict.property_match_withheld, true);
  assert.deepEqual(conflict.assertions.map((row) => row.text), [
    "106 Bayard St (aka 75 Baxter St)",
    "103 Bayard St",
    "106 Bayard Street",
  ]);
  assert.deepEqual(conflict.assertions.map((row) => row.source_position), [
    "agenda_item", "resolution_recital", "resolution_operative",
  ]);

  const held = heldOf(NOODLE);
  assert.equal(held.admission, "held");
  assert.equal(held.held_reason, "conflicting_address_assertions");
  assert.equal(decisionOf(NOODLE), undefined, "a contested address never reaches the resident read model");

  // One consistent address is not a conflict, and does not hold a candidate.
  const single = communityBoardDecisionAddressConflict({
    address_assertions: [
      { source_position: "agenda_item", text: "730 Avenue S" },
      { source_position: "resolution_operative", text: "730 Avenue S" },
    ],
  });
  assert.equal(single.conflicting, false);
  assert.equal(single.property_match_withheld, false);
});

test("a document that states no meeting date is never given one", () => {
  const voteSheet = REVIEW.documents.find((row) => row.meeting_date_state === "not_stated");
  assert.ok(voteSheet, "one of the four documents states no meeting date");
  assert.equal(voteSheet.meeting_date, null);

  const fromVoteSheet = pilot.held_candidates.filter((row) => row.document_id === voteSheet.document_id);
  assert.equal(fromVoteSheet.length, voteSheet.candidate_blocks_observed);
  for (const row of fromVoteSheet) {
    assert.equal(row.admission, "held");
    assert.equal(row.held_reason, "document_states_no_meeting_date");
  }
  assert.equal(pilot.decisions.filter((row) => row.document_id === voteSheet.document_id).length, 0);

  // Even a candidate the review marked published is held when its document
  // carries no stated meeting date, so the guard does not depend on the review.
  const forced = projectCommunityBoardResolutionCandidate(
    { ...reviewedCandidate(BIKE_LANE), document_id: voteSheet.document_id },
    REVIEW,
  );
  assert.equal(forced.admission, "held");
  assert.equal(forced.held_reason, "document_states_no_meeting_date");

  // Every published decision does carry a stated meeting date.
  for (const decision of pilot.decisions) {
    assert.match(decision.document.meeting_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(decision.document.meeting_date_state, "stated_in_document");
  }
});

test("held candidates reach the authenticated queue and never the public artifact", () => {
  const publicPilot = publicCommunityBoardResolutionPilot(pilot);
  const queue = communityBoardResolutionReviewQueue(pilot);
  assert.equal(publicPilot.schema, COMMUNITY_BOARD_RESOLUTION_PILOT_SCHEMA);
  assert.equal(queue.schema, COMMUNITY_BOARD_RESOLUTION_REVIEW_QUEUE_SCHEMA);

  const serialized = JSON.stringify(publicPilot);
  assert.ok(!("held_candidates" in publicPilot));
  for (const held of pilot.held_candidates) {
    assert.ok(!serialized.includes(held.candidate_id), `${held.candidate_id} stays out of the resident artifact`);
  }
  assert.ok(!serialized.includes("103 Bayard"), "the contested address never ships to residents");
  assert.ok(JSON.stringify(queue).includes("103 Bayard"), "the contested address is retained for review");
  assert.equal(queue.held_candidates.length, pilot.held_candidates.length);

  // The committed artifacts match what the module builds from the same input.
  assert.deepEqual(PUBLIC, JSON.parse(JSON.stringify(publicPilot)));
  assert.deepEqual(QUEUE, JSON.parse(JSON.stringify(queue)));
});

test("the section renders on the resident route with source-open actions that survive Back", () => {
  const view = communityBoardResolutionViewForBoard(PUBLIC, MANHATTAN);
  assert.equal(view.schema, COMMUNITY_BOARD_RESOLUTION_VIEW_SCHEMA);
  const html = renderCommunityBoardDecisionsSection(view, { lang: "en" });
  assert.match(html, new RegExp(`id="${COMMUNITY_BOARD_DECISIONS_ANCHOR}"`));

  // Inspection is same-page and addressed by a fragment, so the browser's own
  // Back restores the expansion and the scroll offset with it.
  assert.match(html, /href="#board-decisions-1-passage"/);
  assert.match(html, /href="#board-decisions-1-other"/);
  assert.match(html, /href="#board-decisions-1"/);
  assert.doesNotMatch(html, /<details/, "the expansion lives in the URL, not in element state");
  assert.doesNotMatch(html, /target="_blank"/, "no control opens a new tab");
  assert.doesNotMatch(html, /onclick=/, "no control depends on script");
  assert.doesNotMatch(html, /<button/, "no destination is a scripted control");

  // With no stylesheet and no script, the passage and the excluded tallies are
  // both already in the document.
  const decision = decisionOf(BIKE_LANE);
  assert.ok(html.includes(decision.document.document_url), "the published document is a real destination");
  for (const excluded of decision.excluded_votes) {
    assert.ok(html.includes(`${excluded.yes}-${excluded.no}-${excluded.abstain}`),
      "every excluded tally renders without script");
  }

  // A board outside the pilot renders nothing at all rather than an empty list.
  assert.equal(communityBoardResolutionViewForBoard(PUBLIC, "queens-cb-01"), null);
  assert.equal(renderCommunityBoardDecisionsSection(null, { lang: "en" }), "");
});

test("the worked explanation states what the board decided, in its own terms", () => {
  const text = textOf(renderCommunityBoardDecisionsSection(
    communityBoardResolutionViewForBoard(PUBLIC, MANHATTAN),
    { lang: "en" },
  ));
  assert.match(text, /The board voted to support this proposal/);
  assert.match(text, /Full board vote: 34 in favour, 1 against, 0 abstaining/);
  assert.match(text, /records this tally against Transportation item 2/);
  assert.match(text, /5 other tallies\. None of them is this decision/);
  assert.match(text, /A motion to send a different item to another committee/);
  assert.match(text, /expressly excluding this one/);
  // The section states its own bound rather than implying completeness.
  assert.match(text, /not everything the board has decided/);
});

test("the section ships in every shipping language with the source text preserved", () => {
  const view = communityBoardResolutionViewForBoard(PUBLIC, BROOKLYN);
  const english = renderCommunityBoardDecisionsSection(view, { lang: "en" });
  for (const lang of ["en", ...SHIPPING_LANGS]) {
    const html = renderCommunityBoardDecisionsSection(view, { lang });
    const text = textOf(html);
    assert.ok(html, `${lang} renders the section`);
    if (lang !== "en") {
      assert.notEqual(text, textOf(english), `${lang} renders translated copy, not the English string`);
      assert.ok(html.includes(`lang="${lang}"`), `${lang} declares its language`);
      assert.ok(html.includes(`dir="${["ar", "ur"].includes(lang) ? "rtl" : "ltr"}"`), `${lang} declares its direction`);
    }
    assert.ok(!/\bcbrp_[a-z_]+\b/.test(text), `${lang} resolves every key rather than rendering it`);
    // The publisher's own words are never translated, and keep their direction.
    assert.ok(html.includes('<span lang="en" dir="ltr">New York City Board of Standards and Appeals</span>'),
      `${lang} keeps the published authority name`);
    assert.ok(html.includes('<span lang="en" dir="ltr">154-90-BZII</span>'), `${lang} keeps the published case number`);
    assert.ok(html.includes('blockquote class="board-decision-quote" lang="en" dir="ltr"'),
      `${lang} keeps the quoted passage in the language it was published in`);
    assert.ok(html.includes(view.decisions[0].document.document_url), `${lang} keeps the source reachable`);
  }
});

test("the decisions are reachable by the issue a resident would search for", () => {
  const manhattan = communityBoardResolutionSearchTopics(PUBLIC, MANHATTAN);
  assert.ok(manhattan.includes("St. Marks Place"));
  assert.ok(manhattan.includes("bicycle lane"));
  const brooklyn = communityBoardResolutionSearchTopics(PUBLIC, BROOKLYN);
  assert.ok(brooklyn.includes("730 Avenue S"));
  assert.ok(brooklyn.includes("154-90-BZII"));
  // A board outside the pilot gains no issue words at all.
  assert.deepEqual(communityBoardResolutionSearchTopics(PUBLIC, "queens-cb-01"), []);

  const document = projectBoardSearchDocument(MANHATTAN, BOARD_LOOKUP.by_id[MANHATTAN], {
    lookup: BOARD_LOOKUP,
    resolutionPilot: PUBLIC,
  });
  assert.equal(document.outcome, "indexed");
  assert.match(document.document.search_text, /St\. Marks Place/);
  assert.deepEqual([...document.document.provenance.decision_topics], manhattan);

  // Without the pilot the same board indexes with no decision words, so a
  // decision can never be implied by the producer alone.
  const bare = projectBoardSearchDocument(MANHATTAN, BOARD_LOOKUP.by_id[MANHATTAN], { lookup: BOARD_LOOKUP });
  assert.doesNotMatch(bare.document.search_text, /St\. Marks Place/);
});

test("the coverage block counts what was read, not what was hoped for", () => {
  const expectedHeld = REVIEW.candidates.filter((row) => row.admission !== "published").length
    + REVIEW.candidates.filter((row) => row.admission === "published").length
    - pilot.decisions.length;
  assert.equal(pilot.coverage.candidates_held, expectedHeld);
  assert.equal(pilot.coverage.decisions_published, pilot.decisions.length);
  assert.equal(pilot.coverage.documents, REVIEW.documents.length);
  assert.equal(pilot.coverage.boards, new Set(REVIEW.documents.map((row) => row.board_id)).size);
  const summed = Object.values(pilot.coverage.held_reasons).reduce((total, value) => total + value, 0);
  assert.equal(summed, pilot.coverage.candidates_held, "every held candidate is counted under a reason");
  assert.ok(pilot.coverage.held_reasons.conflicting_address_assertions >= 1);
  assert.ok(pilot.coverage.held_reasons.document_states_no_meeting_date >= 1);
});

test("an unreadable or unsupported input fails loudly rather than publishing nothing quietly", () => {
  assert.throws(() => buildCommunityBoardResolutionPilot({ schema: "something.else.v1" }),
    /unsupported community board resolution review input/);
  assert.throws(() => publicCommunityBoardResolutionPilot({ schema: "something.else.v1" }),
    /unsupported community board resolution pilot/);
  assert.throws(() => communityBoardResolutionReviewQueue({}),
    /unsupported community board resolution pilot/);
  // A candidate naming a document that was not read is held, not invented.
  const orphan = projectCommunityBoardResolutionCandidate(
    { ...reviewedCandidate(BIKE_LANE), document_id: "a-document-nobody-read" },
    REVIEW,
  );
  assert.equal(orphan.admission, "held");
  assert.equal(orphan.held_reason, "candidate_source_identity_incomplete");
});
