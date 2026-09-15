import test from "node:test";
import assert from "node:assert/strict";
import {
  MEETING_SOURCE_SYSTEMS,
  normalizePdcCalendarMeeting,
  normalizeBsaCalendarMeeting,
  normalizeOathTrialCalendarMeeting,
} from "../site/meeting_object_contract.mjs";
import {
  MEETING_FAMILY,
  meetingProcessProjection,
} from "../site/meeting_process_profile.mjs";
import { buildConsequenceProjection } from "../site/consequence_projection.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";

const source = "https://example.nyc.gov/calendar";

test("the three observer calendars are admitted with typed native keys", () => {
  assert.deepEqual(MEETING_SOURCE_SYSTEMS.slice(-3), [
    "pdc_calendar", "bsa_calendar", "oath_trial_calendar",
  ]);
  const pdc = normalizePdcCalendarMeeting({ pdc_event_id: "2026-09-22", event_date: "2026-09-22", source_url: source });
  const bsa = normalizeBsaCalendarMeeting({ bsa_session_id: "2026-09-14", event_date: "2026-09-14", source_url: source });
  const oath = normalizeOathTrialCalendarMeeting({ oath_trial_session_id: "270419:2026-09-15:10:00", event_date: "2026-09-15T10:00", source_url: source });
  assert.equal(pdc.source_keys[0].key_type, "pdc_event_id");
  assert.equal(bsa.source_keys[0].key_type, "bsa_session_id");
  assert.equal(oath.source_keys[0].key_type, "oath_trial_session_id");
  assert.equal(pdc.activity, "observe");
  assert.equal(pdc.speaking_rights, "unknown");
});
test("observation intent stays independent from attendance and speaking rights", () => {
  const record = normalizePdcCalendarMeeting({
    pdc_event_id: "pdc-1", event_date: "2026-09-22", source_url: source,
    venue: { name: "City Hall", address: "New York, NY" },
    observer_access: { watch_url: "https://video.example.nyc/watch/1" },
    access_steps: [{ kind: "observer_instructions", destination: source, effort: "open_details", source_url: source }],
    speaking_rights: "requires_registration",
  });
  const projection = buildConsequenceProjection("meeting", record);
  assert.equal(projection.activity, "observe");
  assert.equal(projection.speaking_rights, "requires_registration");
  assert.ok(projection.participation_modes.includes("attend_in_person"));
  assert.ok(projection.participation_modes.includes("watch"));
  assert.equal(projection.access_steps[0].destination, source);
});

test("named source families expose procedure profiles while unsupported families stay unknown", () => {
  assert.equal(meetingProcessProjection({ source_system: "pdc_calendar" }).meeting_family, MEETING_FAMILY.PDC_SESSION_V1);
  assert.equal(meetingProcessProjection({ source_system: "bsa_calendar" }).meeting_family, MEETING_FAMILY.BSA_SESSION_V1);
  assert.equal(meetingProcessProjection({ source_system: "oath_trial_calendar" }).meeting_family, MEETING_FAMILY.OATH_TRIAL_SESSION_V1);
  assert.equal(meetingProcessProjection({ source_system: "unsupported_calendar", event_date: "2026-09-22" }).meeting_family, MEETING_FAMILY.DESCRIPTIVE_MEETING_V0);
});

test("item adjournment and lack of quorum do not cancel a parent session", () => {
  const bsa = meetingProcessProjection({
    source_system: "bsa_calendar", event_date: "2026-09-14",
    agenda_items: [{ case_id: "2024-58-BZ", status: "adjourned" }],
  });
  const pdc = meetingProcessProjection({
    source_system: "pdc_calendar", event_date: "2026-08-17",
    description: "No votes were taken for lack of quorum.",
  });
  assert.equal(bsa.observed.event_state.value, "scheduled");
  assert.equal(bsa.observed.phase_states[0].state, "adjourned");
  assert.equal(pdc.observed.event_state.value, "scheduled");
});

test("observer detail renders actual instruction destination without Council or board diagnostics", () => {
  const html = renderMeetingDocument(normalizePdcCalendarMeeting({
    pdc_event_id: "pdc-1", title: "Public Design Commission review", event_date: "2026-09-22",
    source_url: source, venue: { name: "City Hall" },
    access_steps: [{ kind: "observer_instructions", destination: source, effort: "open_details", source_url: source }],
  }));
  assert.match(html, /Public Design Commission meeting/);
  assert.match(html, /How to observe/);
  assert.match(html, /observer-instructions-action/);
  assert.match(html, /https:\/\/example\.nyc\.gov\/calendar/);
  assert.doesNotMatch(html, /No exact Council hearing match/);
  assert.doesNotMatch(html, /community-board lookup/i);
});
