import assert from "node:assert/strict";
import { test } from "node:test";
import { executeMeetingGet } from "../../capabilities/meetings.mjs";
import { workerMeetingGet, handleHearings, HEARINGS_KV_KEY } from "../src/hearings.mjs";

const meeting = {
  object_type: "meeting",
  meeting_id: "meeting:community_board:https://cb5.org/event/public-hearing-full-board-meeting-17/",
  publisher_identifier: "https://cb5.org/event/public-hearing-full-board-meeting-17/",
  source_record_id: "https://cb5.org/event/public-hearing-full-board-meeting-17/",
  source_system: "community_board",
  source_record: { source_system: "community_board", identifier: "https://cb5.org/event/public-hearing-full-board-meeting-17/" },
  source_receipt: { observed_at: "2026-01-17T21:49:15.000Z" },
  institution_refs: { board_ref: "community-board:manhattan-cb-05" },
  minutes_freshness: { status: "not_published", checked_at: "2026-09-07T13:14:16.382Z" },
  meeting_join: { status: "unknown", reason: "no_city_record_notice", join: { matched: false } },
};
function model(row) {
  return { schema: "cityscroll.shared_meeting_read_model.v1", generated_at: "2026-09-07T13:14:44.138Z", rows: [row], hearings: [row] };
}

test("source meeting, minutes, and City Record join remain independent in HTTP and capability reads", async () => {
  const snapshot = model(meeting);
  const env = { ALERT_STATE: { get: async (key) => key === HEARINGS_KV_KEY ? JSON.stringify(snapshot) : null } };
  const result = await executeMeetingGet(workerMeetingGet(env), { meetingId: meeting.meeting_id });
  const row = result.meeting;
  assert.equal(result.availability, "available");
  assert.equal(row.source_presence.status, "present");
  assert.equal(row.minutes.status, "not_published");
  assert.equal(row.source_observation.observed_on, "2026-01-17");
  assert.equal(row.city_record_join.status, "none");
  assert.equal(row.meeting_join.status, "unknown");
  assert.deepEqual(row.institution_refs, meeting.institution_refs);
  assert.equal(row.publisher_identifier, meeting.publisher_identifier);
  const response = await handleHearings(new Request(`https://api.cityscroll.org/hearings?id=${encodeURIComponent(meeting.meeting_id)}`), env);
  assert.deepEqual((await response.json()).capability.meeting, row);
});

test("absent source fields remain unknown, explicit joins remain matched, and missing meetings stay absent", async () => {
  const row = { ...meeting, source_receipt: {}, minutes_freshness: undefined, meeting_join: undefined };
  const unknown = await executeMeetingGet(workerMeetingGet({}, model(row)), { meetingId: row.meeting_id });
  assert.equal(unknown.meeting.minutes.status, "unknown");
  assert.equal(unknown.meeting.city_record_join.status, "unknown");
  assert.equal(unknown.meeting.source_observation.observed_on, null);
  const matched = await executeMeetingGet(workerMeetingGet({}, model({ ...row, meeting_join: { join: { matched: true } } })), { meetingId: row.meeting_id });
  assert.equal(matched.meeting.city_record_join.status, "matched");
  const { meetingGetFromModel } = await import("../../capabilities/meetings.mjs");
  const missing = meetingGetFromModel(model(row), { meetingId: "meeting:community_board:not-published" });
  assert.equal(missing.availability, "not_yet_public");
  assert.equal(missing.meeting, null);
});
