import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_FAMILY,
  meetingObservedState,
  meetingProcessProjection,
  meetingProcessProfile,
  resolveMeetingFamily,
} from "../site/meeting_process_profile.mjs";

test("past dates and participation links do not invent held or agenda observations", () => {
  const projection = meetingProcessProjection({
    event_date: "2026-07-20",
    notice_type: "Meeting",
    participation: {
      links: [{ label: "Join online", url: "https://meet.example.test/room" }],
    },
  });

  assert.equal(projection.observed.event_state.value, "scheduled");
  assert.equal(projection.observed.publications.agenda.state, "not_observed");
  assert.equal(projection.observed.publications.minutes.state, "not_observed");
  assert.equal(projection.observed.publications.outcome.state, "not_observed");
  assert.equal(projection.observed_stage, "scheduled");
});

test("structured event status and exact publications remain independent observed facts", () => {
  for (const value of ["scheduled", "cancelled", "postponed", "held"]) {
    assert.equal(
      meetingObservedState({ event_status: value }).event_state.value,
      value,
    );
  }

  const observed = meetingObservedState({
    event_status: "held",
    meeting_documents: [
      { role: "agenda", attachment_status: "attached" },
      { role: "minutes", attachment_status: "attached" },
    ],
    meeting_outcomes_matched: true,
  });
  assert.equal(observed.event_state.value, "held");
  assert.equal(observed.publications.agenda.state, "observed");
  assert.equal(observed.publications.minutes.state, "observed");
  assert.equal(observed.publications.outcome.state, "observed");
});

test("rulemaking expectations never turn a missing outcome into a compliance verdict", () => {
  const projection = meetingProcessProjection({
    meeting_family: MEETING_FAMILY.AGENCY_RULEMAKING_HEARING,
    event_date: "2026-08-20",
  });

  assert.equal(projection.meeting_family, "agency_rulemaking_hearing");
  assert.equal(projection.process_profile.version, 1);
  assert.equal(projection.process_profile.expectation_mode, "normative");
  assert.equal(projection.normative_expectations.process_kind, "rulemaking");
  assert.equal(projection.normative_expectations.process_stage, "hearing");
  assert.equal(projection.observed.publications.outcome.state, "not_observed");
  assert.equal("compliance" in projection, false);
  assert.equal("verdict" in projection, false);
  assert.equal("compliance" in projection.observed.publications.outcome, false);
});

test("community-board and unknown families resolve to descriptive fail-closed profiles", () => {
  assert.equal(
    resolveMeetingFamily({ source_system: "community_board" }),
    MEETING_FAMILY.COMMUNITY_BOARD_MEETING_V0,
  );
  const boardProfile = meetingProcessProfile({ source_system: "community_board" });
  assert.equal(boardProfile.version, 0);
  assert.equal(boardProfile.expectation_mode, "descriptive");
  assert.equal(boardProfile.normative_expectations, null);

  const unknown = meetingProcessProjection({ meeting_family: "unregistered_family" });
  assert.equal(unknown.meeting_family, MEETING_FAMILY.DESCRIPTIVE_MEETING_V0);
  assert.equal(unknown.process_profile.expectation_mode, "descriptive");
  assert.equal(unknown.normative_expectations, null);
  assert.equal(unknown.process_role, null);
});
