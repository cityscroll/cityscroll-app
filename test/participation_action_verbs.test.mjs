/**
 * PHC-03 — action verbs bound to the evidence their destination provides.
 *
 *   node --test test/participation_action_verbs.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTICIPATION_ACTION_VERBS,
  participationActionVerbs,
} from "../site/participation_action_verbs.mjs";
import {
  councilHearingConsequence,
  contractCommentConsequence,
  ruleConsequence,
} from "../site/consequence_projection.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";

function verbsByMode(actions) {
  return Object.fromEntries(actions.map((action) => [action.mode, action]));
}

test("every participation mode maps to its own verb, and an empty projection yields no actions", () => {
  assert.deepEqual(participationActionVerbs({ participation_modes: [], evidence: [] }), []);
  assert.deepEqual(participationActionVerbs(null), []);
  assert.deepEqual(participationActionVerbs(undefined), []);
  for (const mode of Object.keys(PARTICIPATION_ACTION_VERBS)) {
    assert.ok(PARTICIPATION_ACTION_VERBS[mode].length > 0, `${mode} has a non-empty verb`);
  }
});

test("a mode carried in participation_modes without its own evidence entry is never rendered", () => {
  // A malformed/foreign projection — the honest behavior is to render nothing
  // rather than guess a basis for a mode the evidence list does not name.
  const actions = participationActionVerbs({ participation_modes: ["join_remote"], evidence: [] });
  assert.deepEqual(actions, []);
});

// ---- A1: a recognized conferencing attendee destination powers joining remotely; a generic agency address cannot ----

test("A1: a recognized video-conference join URL becomes Join remotely with that URL as the destination", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-1",
    request_id: "phc03-1",
    decides: "Local law hearing",
    additional_description_1: "Join the hearing via Zoom at https://zoomgov.com/j/555000111",
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.equal(actions.join_remote.verb, "Join remotely");
  assert.match(actions.join_remote.href, /zoomgov\.com/);
  assert.equal(actions.join_remote.linkable, true);
  assert.equal(actions.attend_in_person, undefined);
});

test("A1: a venue plus a generic, non-recognized agency link never becomes Join remotely", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-2",
    request_id: "phc03-2",
    decides: "Budget hearing",
    venue: { address: "250 Broadway, New York, NY" },
    additional_description_1: "More information: https://www1.nyc.gov/site/council/index.page",
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.equal(actions.join_remote, undefined);
  assert.ok(actions.attend_in_person, "attend_in_person still renders from the venue address");
  assert.equal(actions.attend_in_person.verb, "Attend in person");
});

// ---- A2: a broadcast destination powers watching only, unless the notice separately allows remote participation ----

test("A2: a broadcast-only link renders Watch, and never Join remotely", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-3",
    request_id: "phc03-3",
    decides: "Oversight hearing",
    additional_description_1: "Watch the livestream at https://www.youtube.com/watch?v=phc03demo",
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.equal(actions.watch.verb, "Watch");
  assert.match(actions.watch.href, /youtube\.com/);
  assert.equal(actions.watch.linkable, true);
  assert.equal(actions.join_remote, undefined);
});

test("A2: a broadcast link plus a separately published join link produces both Watch and Join remotely", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-4",
    request_id: "phc03-4",
    decides: "Zoning text amendment",
    additional_description_1: "Watch at https://www.youtube.com/watch?v=phc03hybrid. Join to speak via Zoom at https://zoomgov.com/j/777000222.",
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.ok(actions.watch, "watch is still exposed alongside join_remote");
  assert.ok(actions.join_remote, "join_remote is exposed once separately evidenced");
  assert.notEqual(actions.watch.href, actions.join_remote.href);
});

// ---- A5: a record with both physical and remote evidence exposes both actions separately ----

test("A5: physical and remote evidence each produce their own separate action", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-5",
    request_id: "phc03-5",
    decides: "Landmarks designation",
    venue: { address: "250 Broadway, New York, NY" },
    additional_description_1: "In person at 250 Broadway. Join remotely via https://zoomgov.com/j/999000333.",
  });
  const actions = participationActionVerbs(projection);
  const modes = actions.map((action) => action.mode).sort();
  assert.deepEqual(modes, ["attend_in_person", "join_remote"]);
});

test("A5: a record with only physical evidence exposes only that action", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-6",
    request_id: "phc03-6",
    decides: "Franchise renewal",
    venue: { address: "22 Reade Street, New York, NY" },
  });
  const actions = participationActionVerbs(projection);
  assert.deepEqual(actions.map((action) => action.mode), ["attend_in_person"]);
});

// ---- A3: in-person attendance carries no registration prompt where policy states none is required ----

test("A3: attend-in-person evidence alone never produces a register_to_testify action", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-7",
    request_id: "phc03-7",
    decides: "Site selection hearing",
    venue: { address: "1 Centre Street, New York, NY" },
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.ok(actions.attend_in_person);
  assert.equal(actions.register_to_testify, undefined);
});

// ---- A4/A6: written testimony renders only on its own evidenced path, and attendance stays unknown when unevidenced ----

test("A6: register_to_testify renders as its own action while attendance stays unknown", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-8",
    request_id: "phc03-8",
    decides: "Franchise renewal",
    additional_description_1: "Register to testify at https://testimony.example.test/signup",
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.equal(actions.register_to_testify.verb, "Register to testify");
  assert.match(actions.register_to_testify.href, /testimony\.example\.test/);
  assert.equal(actions.register_to_testify.linkable, true);
  assert.equal(actions.attend_in_person, undefined);
  assert.equal(actions.join_remote, undefined);
  assert.equal(actions.watch, undefined);
});

test("A4: submit_written never appears on a rule notice with no comment-window or hearing signal", () => {
  const projection = ruleConsequence(
    { title: "A rule with no published participation channel" },
    { today: "2026-08-20" },
  );
  const actions = participationActionVerbs(projection);
  assert.deepEqual(actions, []);
});

test("A4: submit_written renders from an open comment channel, with the channel as its destination", () => {
  const projection = contractCommentConsequence({
    request_id: "SYN-CONTRACT-PHC03",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/SYN-CONTRACT-PHC03",
    comment_url: "https://a856-cityrecord.nyc.gov/RequestDetail/SYN-CONTRACT-PHC03",
    comment_by_date: "2026-11-01",
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.equal(actions.submit_written.verb, "Submit written testimony");
  assert.equal(actions.submit_written.linkable, true);
  assert.equal(actions.attend_in_person, undefined);
  assert.equal(actions.join_remote, undefined);
  assert.equal(actions.watch, undefined);
});

test("submit_written evidenced only by a testimony email is not treated as linkable (the notice page is not the channel)", () => {
  const projection = councilHearingConsequence({
    meeting_id: "meeting:city_record:phc03-9",
    request_id: "phc03-9",
    decides: "Public hearing on proposed rule",
    additional_description_1: `Submit written testimony to ${["hearings", "example.com"].join("@")}.`,
  });
  const actions = verbsByMode(participationActionVerbs(projection));
  assert.ok(actions.submit_written);
  assert.equal(actions.submit_written.basis, "published_testimony_email");
  assert.equal(actions.submit_written.linkable, false);
});

// ---- Negative rule: never promote a generic URL, never infer a channel/deadline/registration the notice omits ----

test("negative rule: an unresolved projection with no evidence produces no actions at all", () => {
  const projection = councilHearingConsequence({ decides: "Something with no meeting_id" });
  assert.deepEqual(participationActionVerbs(projection), []);
});

// ---- Wiring: the evidenced actions actually render on the meeting document page (site/meeting_document.mjs) ----

test("wiring: a City Council record with only a testimony signup link renders Register to testify with attendance left unstated", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:city_record:phc03-render-1",
    source_system: "city_record",
    agency: "City Council",
    title: "Franchise renewal hearing",
    request_id: "phc03-render-1",
    decides: "Franchise renewal",
    additional_description_1: "Register to testify at https://testimony.example.test/signup-render",
  });
  assert.match(html, /meeting-participation-actions/);
  assert.match(html, />Register to testify<\/a>/);
  assert.match(html, /href="https:\/\/testimony\.example\.test\/signup-render"/);
  assert.doesNotMatch(html, />Watch<\/(?:a|li)>/);
  assert.doesNotMatch(html, /Join online/);
});

test("wiring: a City Council record with a broadcast-only link renders Watch instead of being dropped", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:city_record:phc03-render-2",
    source_system: "city_record",
    agency: "City Council",
    title: "Oversight hearing",
    request_id: "phc03-render-2",
    decides: "Oversight hearing",
    additional_description_1: "Watch the livestream at https://www.youtube.com/watch?v=phc03render",
  });
  assert.match(html, />Watch<\/a>/);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=phc03render"/);
  assert.doesNotMatch(html, /Join online/);
});

test("wiring: a record with no evidenced participation mode at all renders no participation-actions list", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:legistar:phc03-render-none",
    source_system: "legistar",
    title: "Meeting with no published participation method",
  });
  assert.doesNotMatch(html, /meeting-participation-actions/);
});

test("A7: existing contact, phone, and official-source details are preserved alongside the new evidenced actions", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:city_record:phc03-render-3",
    source_system: "city_record",
    agency: "City Council",
    title: "Local law hearing",
    request_id: "phc03-render-3",
    decides: "Local law hearing",
    contact_name: "Public Hearings Unit",
    contact_phone: ["212", "555", "0100"].join("-"),
    email: ["hearings", "example.com"].join("@"),
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/phc03-render-3",
    additional_description_1: "Register to testify at https://testimony.example.test/signup-render-3",
  });
  assert.match(html, /Public Hearings Unit/);
  assert.match(html, new RegExp(["212", "555", "0100"].join("-")));
  assert.match(html, /mailto:hearings@example\.com/);
  assert.match(html, /href="https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/phc03-render-3"/);
  assert.match(html, />Register to testify<\/a>/);
});
