import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  attendanceModeFromParticipation,
  attendanceModeForRecord,
  MEETINGS_ATTENDANCE_MODES,
} from "../site/meetings_attendance.mjs";
import { meetingConsequence, councilHearingConsequence } from "../site/consequence_projection.mjs";
import { emptyScope, routeHashFromScope, scopeFromRouteHash } from "../site/scope_v0.mjs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const i18nSource = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");

const meetingsSection = html.slice(
  html.indexOf('<section id="tab-meetings"'),
  html.indexOf("<!-- ============ ALERTS", html.indexOf('<section id="tab-meetings"')),
);

function i18nValue(key) {
  const match = i18nSource.match(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  assert.notEqual(match, null, `${key} must exist in site/i18n.js`);
  return match[1];
}

// ---- A1: lead with the hearing-vs-meeting distinction, not the data method ----

test("the meetings deck states the hearing-versus-meeting distinction, not the data method", () => {
  const deck = i18nValue("meetings_domain_deck");
  assert.match(deck, /hearing/i);
  assert.match(deck, /scheduled chance to give testimony/i);
  assert.match(deck, /meeting/i);
  assert.match(deck, /broader/i);
  assert.doesNotMatch(deck, /scheduled, agenda, held/i);
});

test("the method-arc explanation moved into the existing disclosure", () => {
  const methodDetailsStart = meetingsSection.indexOf('class="lens-method meetings-method"');
  assert.notEqual(methodDetailsStart, -1);
  const detailsEnd = meetingsSection.indexOf("</details>", methodDetailsStart);
  const details = meetingsSection.slice(methodDetailsStart, detailsEnd);
  assert.match(details, /data-i18n-html="meetings_method_arc_html"/);
  assert.match(details, /data-i18n-html="hearings_location_note_html"/);
  const arcValue = i18nValue("meetings_method_arc_html");
  assert.match(arcValue, /scheduled, agenda, held, then outcomes/);
  // The intro deck outside the disclosure must not repeat the method explanation.
  const introEnd = meetingsSection.indexOf("</details>", meetingsSection.indexOf('id="meetings-domain-intro"'));
  const intro = meetingsSection.slice(0, methodDetailsStart);
  assert.doesNotMatch(intro, /scheduled, agenda, held, then outcomes/);
});

// ---- A2/A6: attendance is its own first-level control ----

test("attendance is an independent control beside affected area, with watch-only as a first-level option", () => {
  const disclosureStart = meetingsSection.indexOf('id="meetings-more-filters"');
  const disclosureEnd = meetingsSection.indexOf("</details>", disclosureStart);
  const disclosure = meetingsSection.slice(disclosureStart, disclosureEnd);
  const boroIndex = disclosure.indexOf('id="meetingsboro"');
  const attendanceIndex = disclosure.indexOf('id="meetingsattendance"');
  assert.ok(boroIndex >= 0 && attendanceIndex >= 0);
  const attendanceFieldEnd = disclosure.indexOf("</select>", attendanceIndex);
  const attendanceField = disclosure.slice(attendanceIndex, attendanceFieldEnd);
  for (const mode of MEETINGS_ATTENDANCE_MODES) {
    assert.match(attendanceField, new RegExp(`value="${mode}"`), `missing option for ${mode}`);
  }
  // watch_only must be a plain top-level <option>, never nested inside another <details>.
  assert.doesNotMatch(disclosure.slice(attendanceIndex, attendanceFieldEnd), /<details/);
});

test("A7: existing meetings controls remain in place", () => {
  for (const id of [
    "meetingskw",
    "meetingswhen",
    "meetingsboro",
    "meetingsneighborhood",
    "meetings-agency-scope",
    "meetings-board-scope",
    "meetingsprocessrail",
  ]) {
    assert.ok(meetingsSection.includes(`id="${id}"`), `${id} must still exist`);
  }
});

// ---- A4/A5/A6: attendance bucket derivation ----

test("attendanceModeFromParticipation maps participation modes to the right bucket", () => {
  assert.equal(attendanceModeFromParticipation(["attend_in_person", "join_remote"]), "hybrid");
  assert.equal(attendanceModeFromParticipation(["join_remote"]), "remote");
  assert.equal(attendanceModeFromParticipation(["attend_in_person"]), "in_person");
  assert.equal(attendanceModeFromParticipation(["watch"]), "watch_only");
  assert.equal(attendanceModeFromParticipation(["watch", "register_to_testify"]), "watch_only");
  assert.equal(attendanceModeFromParticipation(["register_to_testify"]), "not_stated");
  assert.equal(attendanceModeFromParticipation(["submit_written"]), "not_stated");
  assert.equal(attendanceModeFromParticipation([]), "not_stated");
  assert.equal(attendanceModeFromParticipation(undefined), "not_stated");
});

test("A4: only a recognized join platform proves remote participation", () => {
  const record = {
    meeting_id: "meeting:city_record:1",
    request_id: "1",
    decides: "Zoning text amendment",
    additional_description_1: "Join the hearing via Zoom at https://zoomgov.com/j/123456",
  };
  const projection = councilHearingConsequence(record);
  assert.ok(projection.participation_modes.includes("join_remote"));
  assert.equal(attendanceModeFromParticipation(projection.participation_modes), "remote");
});

test("A6: a broadcast-only link is watch-only, and never upgraded to remote", () => {
  const record = {
    meeting_id: "meeting:city_record:2",
    request_id: "2",
    decides: "Budget hearing",
    additional_description_1: "Watch the livestream at https://www.youtube.com/watch?v=abc123",
  };
  const projection = councilHearingConsequence(record);
  assert.ok(!projection.participation_modes.includes("join_remote"));
  assert.equal(attendanceModeFromParticipation(projection.participation_modes), "watch_only");
});

test("A5: written testimony alone renders as not stated, never remote", () => {
  const record = {
    object_type: "meeting",
    schema: "cityscroll.meeting_object.v1",
    meeting_id: "meeting:community_board:1",
    source_system: "community_board",
    source_section: "Community Board Meetings",
    request_id: null,
    participation: { emails: ["testimony@example.gov"], links: [] },
  };
  const mode = attendanceModeForRecord({ ...record, agency: null });
  assert.equal(mode, "not_stated");
});

test("hybrid requires both an in-person venue and a recognized remote join", () => {
  const record = {
    meeting_id: "meeting:city_record:3",
    request_id: "3",
    decides: "Landmarks designation",
    street_address_1: "250 Broadway, New York, NY",
    additional_description_1: "In person at 250 Broadway. Join remotely via https://zoomgov.com/j/999",
  };
  const projection = councilHearingConsequence({
    ...record,
    venue: { address: record.street_address_1 },
  });
  assert.equal(attendanceModeFromParticipation(projection.participation_modes), "hybrid");
});

// ---- A2/A3: attendance and affected area serialize independently ----

test("attendance and affected-area facets serialize as independent URL params", () => {
  const scope = emptyScope("en");
  scope.facets.domains = ["meetings"];
  scope.place.boroughs = ["Manhattan"];
  scope.facets.values = { attendance: "remote" };
  const hash = routeHashFromScope(scope, { surface: "meetings" });
  assert.match(hash, /[?&]boro=Manhattan/);
  assert.match(hash, /[?&]attendance=remote/);

  const roundTripped = scopeFromRouteHash(hash);
  assert.equal(roundTripped.facets.values.attendance, "remote");
  assert.deepEqual(roundTripped.place.boroughs, ["Manhattan"]);
});

test("filtering by remote attendance never changes the affected area", () => {
  const withAttendance = emptyScope("en");
  withAttendance.facets.domains = ["meetings"];
  withAttendance.place.boroughs = ["Queens"];
  withAttendance.facets.values = { attendance: "remote" };

  const withoutAttendance = emptyScope("en");
  withoutAttendance.facets.domains = ["meetings"];
  withoutAttendance.place.boroughs = ["Queens"];

  const hashWith = routeHashFromScope(withAttendance, { surface: "meetings" });
  const hashWithout = routeHashFromScope(withoutAttendance, { surface: "meetings" });
  const boroOf = (hash) => new URLSearchParams(hash.split("?")[1] || "").get("boro");
  assert.equal(boroOf(hashWith), boroOf(hashWithout));
  assert.equal(boroOf(hashWith), "Queens");
});
