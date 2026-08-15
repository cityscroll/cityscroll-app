import assert from "node:assert/strict";
import test from "node:test";

import {
  CITY_RECORD_MEETING_PREDICATE,
  eligibleCityRecordMeetings,
  isCityRecordMeeting,
} from "../site/city_record_meeting.mjs";

test("City Record meeting eligibility is an explicit dated-section predicate", () => {
  assert.deepEqual(CITY_RECORD_MEETING_PREDICATE, {
    sections: ["Public Hearings and Meetings", "Agency Rules"],
    agency_rules_type: "Public Hearings",
    requires_event_date: true,
  });
  assert.equal(isCityRecordMeeting({ section_name: "Public Hearings and Meetings", event_date: "2026-08-17" }), true);
  assert.equal(isCityRecordMeeting({ section_name: "Agency Rules", type_of_notice_description: "Public Hearings", event_date: "2026-08-19" }), true);
  assert.equal(isCityRecordMeeting({ section_name: "Agency Rules", type_of_notice_description: "Notice", event_date: "2026-08-19" }), false);
  assert.equal(isCityRecordMeeting({ section_name: "Public Hearings and Meetings" }), false);
  assert.deepEqual(eligibleCityRecordMeetings([
    { request_id: "meeting", section_name: "Public Hearings and Meetings", event_date: "2026-08-17" },
    { request_id: "rule", section_name: "Agency Rules", type_of_notice_description: "Notice", event_date: "2026-08-18" },
  ]).map((row) => row.request_id), ["meeting"]);
});
