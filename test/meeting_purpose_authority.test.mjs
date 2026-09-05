/**
 * PHC-02 — sourced purpose and plain-language body authority, projected
 * ahead of logistics on the meetings result card and the meeting detail
 * page, from PHC-00's already evidence-gated consequence projection.
 *
 *   node --test test/meeting_purpose_authority.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  BODY_ROLE_PLAIN_LABEL,
  RECORD_DESTINATION_PLAIN_LABEL,
  meetingPurposeAuthority,
} from "../site/meeting_purpose_authority.mjs";
import { BODY_ROLES, RECORD_DESTINATIONS } from "../site/consequence_projection.mjs";
import { meetingObservedState, observedMeetingStage } from "../site/meeting_process_profile.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";

const goldFixtures = JSON.parse(
  readFileSync(new URL("fixtures/consequence_projection/gold_fixtures.v0.json", import.meta.url), "utf8"),
);
const goldCase = (id) => goldFixtures.cases.find((c) => c.id === id);

const i18nSource = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
function i18nValue(key) {
  const match = i18nSource.match(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  assert.notEqual(match, null, `${key} must exist in site/i18n.js`);
  return match[1];
}

// A council hearing record, sourced with a matched Council meeting/outcome
// join — reuses consequence_projection's own gold fixture record so this
// test exercises the same already-accepted evidence rather than a bespoke one.
function fullCouncilHearingRecord(overrides = {}) {
  const record = structuredClone(goldCase("full-council-hearing-land-use-matched-join").record);
  record.agency = "City Council";
  return { ...record, ...overrides };
}

// ---- module: sourced purpose (pending question) and authority (body role, record destination, next official action) ----

test("A1/G1: a sourced council hearing carries its pending question and plain-language body role", () => {
  const purpose = meetingPurposeAuthority(fullCouncilHearingRecord());
  assert.match(purpose.pending_question, /Landmarks, Queens CD 2/);
  assert.equal(purpose.body_role, "conditional_decision_maker");
  assert.equal(purpose.body_role_label, BODY_ROLE_PLAIN_LABEL.conditional_decision_maker);
  assert.equal(purpose.record_destination, "minutes");
  assert.equal(purpose.record_destination_label, RECORD_DESTINATION_PLAIN_LABEL.minutes);
  assert.equal(purpose.next_official_action.status, "Laid Over by Subcommittee");
});

test("G1: a council hearing with no explicit hearing kind carries its pending question but no guessed body role", () => {
  const record = fullCouncilHearingRecord({ council_hearing_kind: undefined, meeting_outcome: undefined });
  const purpose = meetingPurposeAuthority(record);
  assert.ok(purpose.pending_question);
  assert.equal(purpose.body_role, null);
  assert.equal(purpose.body_role_label, null);
});

// ---- A3/G2: never paraphrase an event title into a pending question ----

test("A3: a descriptive meeting this repository could not classify omits the pending question rather than paraphrasing its title", () => {
  const unknownCase = goldCase("unknown-mixed-hearings-and-meetings-section-no-invented-copy");
  const purpose = meetingPurposeAuthority(unknownCase.record);
  assert.equal(purpose.proceeding_kind, "unknown");
  assert.equal(purpose.pending_question, null);
  assert.equal(purpose.body_role, null);
  assert.equal(purpose.record_destination, null);
  assert.equal(purpose.next_official_action, null);
});

test("A3: the same descriptive-family record still omits the pending question even when it carries a decides field", () => {
  const unknownCase = goldCase("unknown-mixed-hearings-and-meetings-section-no-invented-copy");
  const record = { ...unknownCase.record, decides: unknownCase.record.title };
  const purpose = meetingPurposeAuthority(record);
  // The family-level gate in consequence_projection.mjs's meetingConsequence()
  // drops the pending question for an unresolved family regardless of whether
  // a decides field happens to be present — proving the omission is
  // structural (the composer never reaches the field), not merely that the
  // field was absent in this particular record.
  assert.equal(purpose.pending_question, null);
});

test("a community board meeting carries no guessed body role (meetingConsequence never sets one)", () => {
  const boardCase = goldCase("partial-community-board-meeting-hybrid-venue-no-minutes-yet");
  const purpose = meetingPurposeAuthority(boardCase.record, { domain: "meeting" });
  assert.equal(purpose.proceeding_kind, "public_meeting");
  assert.equal(purpose.pending_question, null);
  assert.equal(purpose.body_role, null);
});

test("negative rule: an unresolved projection with no evidence produces no purpose or authority fields", () => {
  const purpose = meetingPurposeAuthority({});
  assert.equal(purpose.proceeding_kind, "unknown");
  assert.equal(purpose.pending_question, null);
  assert.equal(purpose.body_role, null);
  assert.equal(purpose.record_destination, null);
  assert.equal(purpose.next_official_action, null);
});

// ---- label completeness (mirrors participation_action_verbs.test.mjs's verb-completeness check) ----

test("every non-unknown body role and every record destination has a non-empty plain-language label", () => {
  for (const role of BODY_ROLES) {
    if (role === "unknown") continue;
    assert.ok(BODY_ROLE_PLAIN_LABEL[role]?.length > 0, `${role} has a label`);
  }
  for (const destination of RECORD_DESTINATIONS) {
    assert.ok(RECORD_DESTINATION_PLAIN_LABEL[destination]?.length > 0, `${destination} has a label`);
  }
});

// ---- A2: the detail page places the consequence block before the participation controls ----

test("A2: the sourced consequence block renders before the participation controls on the meeting detail page", () => {
  const html = renderMeetingDocument(fullCouncilHearingRecord({
    meeting_id: "meeting:city_record:phc02-a2",
    request_id: "phc02-a2",
    participation: { links: [{ url: "https://zoomgov.com/j/phc02a2", label: "Join online" }] },
  }));
  const consequenceIndex = html.indexOf('data-meeting-consequence="1"');
  const participationIndex = html.indexOf('meeting-participation"');
  assert.notEqual(consequenceIndex, -1, "consequence section must render");
  assert.notEqual(participationIndex, -1, "participation section must render");
  assert.ok(consequenceIndex < participationIndex, "consequence block must precede participation controls");
  assert.match(html, /Considering:/);
  assert.match(html, /Can decide, conditioned on another body/);
});

test("the nearest exact next official action is stated when the shared projection sourced one", () => {
  const html = renderMeetingDocument(fullCouncilHearingRecord({
    meeting_id: "meeting:city_record:phc02-next-1",
    request_id: "phc02-next-1",
  }));
  assert.match(html, /Next official step: Committee action: Laid Over by Subcommittee/);
  assert.match(html, /official source/);
  assert.doesNotMatch(html, /has not been published yet/);
});

test("an honest unknown replaces the next official action when none has been published, never inferred from the event having been held", () => {
  const record = fullCouncilHearingRecord({
    meeting_id: "meeting:city_record:phc02-next-2",
    request_id: "phc02-next-2",
    meeting_outcome: undefined,
    additional_description_1: "This hearing was held on the scheduled date.",
  });
  const html = renderMeetingDocument(record);
  assert.match(html, /The next official step has not been published yet\./);
  assert.doesNotMatch(html, /Next official step: Committee action/);
  assert.doesNotMatch(html, /Review outcomes/);
});

test("a record whose sourced purpose/authority is entirely empty renders no consequence section at all", () => {
  const unknownCase = goldCase("unknown-mixed-hearings-and-meetings-section-no-invented-copy");
  const html = renderMeetingDocument({
    ...unknownCase.record,
    meeting_id: "meeting:city_record:phc02-empty",
    source_system: "city_record",
  });
  assert.doesNotMatch(html, /data-meeting-consequence/);
});

// ---- A4/A5: listen-only and testimony sessions render different participation states; never invite testimony without evidence ----

test("A4/A5: a testimony session renders its testify action while a listen-only session on the same shape renders none", () => {
  const testimonyHtml = renderMeetingDocument(fullCouncilHearingRecord({
    meeting_id: "meeting:city_record:phc02-testify",
    request_id: "phc02-testify",
    additional_description_1: "Register to testify at https://testimony.example.test/phc02-signup",
  }));
  assert.match(testimonyHtml, />Register to testify<\/a>/);

  const listenOnlyHtml = renderMeetingDocument(fullCouncilHearingRecord({
    meeting_id: "meeting:city_record:phc02-listen",
    request_id: "phc02-listen",
    additional_description_1: "",
  }));
  assert.doesNotMatch(listenOnlyHtml, /Register to testify/);
  assert.doesNotMatch(listenOnlyHtml, /Submit written testimony/);
  // The new consequence block itself never mentions testimony — it states
  // purpose/authority/next-action only, never a participation invitation.
  const consequenceStart = listenOnlyHtml.indexOf('data-meeting-consequence="1"');
  if (consequenceStart !== -1) {
    const consequenceEnd = listenOnlyHtml.indexOf("</section>", consequenceStart);
    assert.doesNotMatch(listenOnlyHtml.slice(consequenceStart, consequenceEnd), /testif/i);
  }
});

// ---- A1: the result card gives purpose and role higher priority than provenance, and lower than date/status ----

test("A1: the meetings result card renders purpose/role after date-and-status and before the official-source provenance link", () => {
  const source = readFileSync(new URL("../site/app/feed-actions.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function meetingsExplorerCardHTML");
  assert.notEqual(start, -1, "meetingsExplorerCardHTML must exist");
  const end = source.indexOf("\nfunction renderHearingGroup", start);
  assert.notEqual(end, -1, "the next top-level function must exist to bound the slice");
  const body = source.slice(start, end);

  const dateStatusIndex = body.indexOf('<div class="ftype">');
  const purposeIndex = body.indexOf("meetingPurposeAuthorityCardHTML?.(record");
  const provenanceIndex = body.indexOf('class="ui-object-card-handoffs"');
  assert.notEqual(dateStatusIndex, -1);
  assert.notEqual(purposeIndex, -1);
  assert.notEqual(provenanceIndex, -1);
  assert.ok(dateStatusIndex < purposeIndex, "date/status must render before purpose/role");
  assert.ok(purposeIndex < provenanceIndex, "purpose/role must render before provenance");
});

test("A1: the meetings result card i18n copy exists for the purpose label and every body-role plain-language key", () => {
  assert.equal(i18nValue("meeting_purpose_question_label"), "Considering:");
  for (const role of ["receives_record", "advisory", "conditional_decision_maker", "decision_maker", "oversight"]) {
    assert.ok(i18nValue(`meeting_body_role_${role}`).length > 0);
  }
});

// ---- A6 [verification]: the existing stage rail requires its own evidence per stage, never inherited ----

test("A6: a meeting held with no published outcome or minutes stays at the held stage rather than escalating to outcomes", () => {
  const observed = meetingObservedState({
    event_status: "held",
    event_date: "2026-07-01",
  });
  assert.equal(observed.event_state.value, "held");
  assert.equal(observed.publications.outcome.state, "not_observed");
  assert.equal(observed.publications.minutes.state, "not_observed");
  assert.equal(observedMeetingStage(observed), "held");
});

test("A6: a held meeting with a published outcome escalates to outcomes, on its own evidence rather than the held state alone", () => {
  const observed = meetingObservedState({
    event_status: "held",
    event_date: "2026-07-01",
    minutes_freshness: { status: "published" },
  });
  assert.equal(observed.publications.minutes.state, "observed");
  assert.equal(observedMeetingStage(observed), "outcomes");
});
