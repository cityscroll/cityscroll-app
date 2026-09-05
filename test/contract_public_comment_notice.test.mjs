// PHC-08 — a proposed-contract-award notice qualifies as a written public-comment window
// only from explicit evidence in the notice itself, never from its legacy "Contract Award
// Hearings" section label or its posting date alone, and never when the notice also
// publishes a genuinely separate live event. See site/action_registry.js's kindFor /
// contractPublicCommentEvidence / contractCommentHandoff / compileActionRail.

import test from "node:test";
import assert from "node:assert/strict";
import {
  compileActionRail,
  contractPublicCommentEvidence,
  contractCommentHandoff,
} from "../worker/src/lib/action_registry.mjs";
import { projectNoticeObjectTarget } from "../site/notice_object_links.mjs";
import { materializeCityRecordSearchDocument } from "../site/city_record_search_producers.mjs";

const REQUEST_ID = "20260710020";
const COMMENT_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/SYN-CONTRACT-0001";

function qualifyingNotice(overrides = {}) {
  return {
    request_id: REQUEST_ID,
    agency_name: "Health and Mental Hygiene",
    section_name: "Contract Award Hearings",
    type_of_notice_description: "Notice",
    notice_text: "This is a notice seeking comments about the proposed contract below. "
      + "Comments must be submitted before November 1, 2026.",
    comment_url: COMMENT_URL,
    ...overrides,
  };
}

test("A1: a Contract Award Hearings notice with explicit comment evidence classifies as contract_comment, not hearing", () => {
  const evidence = contractPublicCommentEvidence(qualifyingNotice());
  assert.ok(evidence, "expected the notice to qualify on its own published evidence");
  assert.equal(evidence.comment_url, COMMENT_URL);
  assert.equal(evidence.comment_deadline, "2026-11-01");

  const actions = compileActionRail(qualifyingNotice(), {today: "2026-08-01"});
  assert.deepEqual(actions.map((action) => action.type), ["comment", "watch"]);
});

test("A2: a qualifying notice never renders attend, conferencing, remote-join, or calendar controls", () => {
  const actions = compileActionRail(qualifyingNotice(), {today: "2026-08-01"});
  for (const action of actions) {
    assert.notEqual(action.type, "attend");
    assert.notEqual(action.type, "calendar");
  }
});

test("A3: submit action requires both a verified channel and an open deadline; otherwise the fallback is the official instructions", () => {
  const submit = compileActionRail(qualifyingNotice(), {today: "2026-08-01"});
  assert.equal(submit[0].type, "comment");
  assert.equal(submit[0].destination, COMMENT_URL);
  assert.equal(submit[0].deadline, "2026-11-01");

  // Comment language and a deadline, but no channel URL/email — read the instructions.
  const noChannel = compileActionRail(qualifyingNotice({comment_url: undefined}), {today: "2026-08-01"});
  assert.equal(noChannel[0].type, "document");
  assert.equal(noChannel[0].label_key, "read_official_notice");
  assert.notEqual(noChannel[0].destination, COMMENT_URL);

  // A channel with no deadline in the notice at all — still read the instructions, never
  // invented submit-by-date control.
  const noDeadline = compileActionRail(qualifyingNotice({
    notice_text: "This is a notice seeking comments about the proposed contract below.",
  }), {today: "2026-08-01"});
  assert.equal(noDeadline[0].type, "document");
});

test("A4: the consider-before-award consequence appears in the guide only on the qualifying path", () => {
  const actions = compileActionRail(qualifyingNotice(), {today: "2026-08-01"});
  const withGuide = actions.find((action) => action.guide);
  assert.ok(withGuide, "expected a guide on the qualifying comment action");
  const steps = withGuide.guide.render_steps(withGuide.guide.actions, {t: (key) => key, escape: (v) => v});
  assert.ok(
    steps.some((step) => step.includes("contract_comment_guide_consequence_step_html")),
    "expected the consequence step to render",
  );

  // A genuine hearing (join evidence present) never gets this guide/consequence at all —
  // it takes the ordinary hearing rail instead.
  const hearing = compileActionRail({
    request_id: REQUEST_ID,
    section_name: "Contract Award Hearings",
    notice_text: "Join the hearing at https://us02web.zoom.us/j/123456789",
  }, {today: "2026-08-01"});
  assert.notEqual(hearing[0]?.type, "comment");
});

test("A5: a record predating the process change (no comment evidence, a real venue) keeps its real hearing logistics", () => {
  const preTransition = {
    request_id: REQUEST_ID,
    section_name: "Contract Award Hearings",
    type_of_notice_description: "Public Hearing",
    street_address_1: "250 Broadway",
    city: "New York",
    state: "NY",
    notice_text: "A public hearing on this proposed contract award will be held at 250 Broadway.",
  };
  assert.equal(contractPublicCommentEvidence(preTransition), null);
  const actions = compileActionRail(preTransition, {today: "2026-08-01"});
  // A venue-only hearing with no join link is guide-first (bid_checklist), the same
  // convention already used elsewhere for venue-only hearings — never routed to the
  // comment-window rail (type "comment"/"document").
  assert.equal(actions[0].type, "bid_checklist");
  assert.equal(actions[0].guide?.system, "hearing_extracted");
});

test("A6: other genuine hearing families (Public Hearings and Meetings) are not reclassified", () => {
  const genuineHearing = {
    request_id: REQUEST_ID,
    section_name: "Public Hearings and Meetings",
    type_of_notice_description: "Public Hearing",
    notice_text: "A public hearing will be held on this application.",
    participation_url: "https://us02web.zoom.us/j/123456789",
    deadline: "2026-08-10T14:30:00.000",
  };
  assert.equal(contractPublicCommentEvidence(genuineHearing), null);
  const actions = compileActionRail(genuineHearing, {today: "2026-08-01"});
  assert.deepEqual(actions.map((action) => action.type), ["attend", "calendar", "watch"]);
});

test("A7: the original section and type stay visible in the evidence/handoff provenance", () => {
  const evidence = contractPublicCommentEvidence(qualifyingNotice());
  assert.equal(evidence.original_section, "Contract Award Hearings");
  assert.equal(evidence.original_type, "Notice");
  const handoff = contractCommentHandoff(qualifyingNotice(), {today: "2026-08-01"});
  assert.equal(handoff.original_section, "Contract Award Hearings");
  assert.equal(handoff.original_type, "Notice");
});

test("negative rule: a stale (closed) comment window is stated honestly, never offered as a live submission", () => {
  const actions = compileActionRail(qualifyingNotice(), {today: "2026-12-01"});
  assert.equal(actions[0].delivery, "unavailable");
  assert.equal(actions[0].label_key, "next_action_comment_closed");
  assert.notEqual(actions[0].type, "attend");
  assert.equal(actions.some((action) => action.type === "calendar"), false);
});

test("empty case: the bare legacy label alone, with no comment evidence and no live-event evidence, is never classified", () => {
  const bareLabel = {
    request_id: REQUEST_ID,
    section_name: "Contract Award Hearings",
    type_of_notice_description: "Notice",
  };
  assert.equal(contractPublicCommentEvidence(bareLabel), null);
});

test("negative rule: a posting/transition date alone (no comment channel, no comment language) never drives classification", () => {
  const dateOnly = {
    request_id: REQUEST_ID,
    section_name: "Contract Award Hearings",
    type_of_notice_description: "Notice",
    start_date: "2025-05-21",
    deadline: "2026-09-01",
    notice_text: "Proposed contract award for custodial services.",
  };
  assert.equal(contractPublicCommentEvidence(dateOnly), null);
});

test("adversarial near-match: comment evidence alongside a genuinely published live event is never reclassified (venue)", () => {
  const hybrid = qualifyingNotice({
    street_address_1: "22 Reade Street",
    city: "New York",
    state: "NY",
    notice_text: "A public hearing on this proposed contract award will be held at 22 Reade Street. "
      + "Written comments are also invited and must be submitted before November 1, 2026.",
  });
  assert.equal(contractPublicCommentEvidence(hybrid), null);
});

test("adversarial near-match: comment evidence alongside a recognized join platform is never reclassified", () => {
  const hybrid = qualifyingNotice({
    notice_text: "Join the hearing on this proposed contract award at https://us02web.zoom.us/j/123456789. "
      + "Written comments are also invited and must be submitted before November 1, 2026.",
  });
  assert.equal(contractPublicCommentEvidence(hybrid), null);
});

test("adversarial near-match: an unrelated section merely mentioning 'award' and 'comment' is not swept into this family", () => {
  const unrelated = {
    request_id: REQUEST_ID,
    section_name: "Public Hearings and Meetings",
    type_of_notice_description: "Public Hearing",
    notice_text: "Public comment is welcome at this hearing on a proposed zoning award of a special permit.",
  };
  assert.equal(contractPublicCommentEvidence(unrelated), null);
});

test("all compiled contract_comment rails stay at three actions or fewer", () => {
  for (const matter of [
    qualifyingNotice(),
    qualifyingNotice({comment_url: undefined}),
    {...qualifyingNotice(), deadline: undefined, comment_by_date: "2026-06-01"},
  ]) {
    const actions = compileActionRail(matter, {today: "2026-12-01"});
    assert.ok(actions.length <= 3, `expected at most 3 actions, got ${actions.length}`);
  }
});

// A8/A9 — raw City Record row shape (additional_description_1, no pre-joined notice_text),
// the shape notice_object_links.mjs and city_record_search_producers.mjs actually see.
function qualifyingRawRow(overrides = {}) {
  return {
    request_id: "20260710099",
    section_name: "Contract Award Hearings",
    type_of_notice_description: "Notice",
    short_title: "Custodial Services Contract",
    additional_description_1: "<p>This is a notice seeking comments about the proposed contract below.</p>"
      + "<p><strong>E-PIN:&nbsp;</strong>81626S0021099</p>"
      + "<p>Comments must be submitted before July 27, 2026.</p>",
    ...overrides,
  };
}

test("A8: a qualifying notice projects to its stable procurement object (appears in procurement/search)", () => {
  const projection = projectNoticeObjectTarget(qualifyingRawRow());
  assert.equal(projection.state, "matched");
  assert.equal(projection.target.kind, "procurement");
  assert.equal(projection.target.id, "81626S0021099");

  const doc = materializeCityRecordSearchDocument(qualifyingRawRow());
  assert.equal(doc.object_type, "procurement");
  assert.equal(doc.domain, "contracts");
});

test("A8/A5/A6: a genuine hearing under the same legacy label stays notice-only, never a procurement match from this path", () => {
  const genuineHearing = qualifyingRawRow({
    additional_description_1: "<p>A hearing on this proposed contract award will be held at 250 Broadway, "
      + "New York, NY.</p><p><strong>E-PIN:&nbsp;</strong>81626S0021100</p>",
  });
  const projection = projectNoticeObjectTarget(genuineHearing);
  assert.equal(projection.state, "notice_only");
});

test("A9: a qualifying notice's search title leads with the normalised label ahead of its own legacy title", () => {
  const doc = materializeCityRecordSearchDocument(qualifyingRawRow());
  assert.match(doc.title, /^Contract public comment: /);
  assert.match(doc.title, /Custodial Services Contract$/);
});

test("A9 negative: a non-qualifying Contract Award Hearings notice keeps its own title, unlabelled", () => {
  const bareLabel = qualifyingRawRow({
    additional_description_1: "<p>Proposed contract award. E-PIN: 81626S0021101</p>",
  });
  const doc = materializeCityRecordSearchDocument(bareLabel);
  assert.equal(doc.title, "Custodial Services Contract");
});
