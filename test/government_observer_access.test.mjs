import test from "node:test";
import assert from "node:assert/strict";
import {
  MEETING_SOURCE_SYSTEMS,
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
  normalizeNycLegistarEventsMeeting,
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
import { withPinnedClock, todayISO } from "./helpers/test_clock.mjs";

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

test("A1: PDC and BSA details show purpose, evidenced venue/watch access, and official next step", async () => {
  await withPinnedClock("2026-09-15T12:00:00Z", () => {
    const day = todayISO();
    const fixtures = [
      normalizePdcCalendarMeeting({
        pdc_event_id: "pdc-1", title: "Public Design Commission review", event_date: `${day}T10:00:00`,
        source_url: source, venue: { name: "City Hall" },
        observer_access: { watch_url: "https://video.example.nyc/watch/pdc-1" },
        access_steps: [{ kind: "observer_instructions", destination: source, effort: "open_details", source_url: source }],
      }),
      normalizeBsaCalendarMeeting({
        bsa_session_id: "bsa-1", title: "Board of Standards and Appeals session", event_date: `${day}T14:00:00`,
        source_url: source, venue: { name: "Municipal Building", address: "1 Centre Street" },
        observer_access: { watch_url: "https://video.example.nyc/watch/bsa-1" },
        access_steps: [{ kind: "observer_instructions", destination: source, effort: "open_details", source_url: source }],
      }),
    ];
    for (const [html, title, venue, watch] of fixtures.map((record) => [
      renderMeetingDocument(record), record.title, record.venue.name,
      record.observer_access.watch_url,
    ])) {
      assert.match(html, new RegExp(title));
      assert.match(html, new RegExp(venue));
      assert.match(html, new RegExp(watch.replaceAll("/", "\\/")));
      assert.match(html, /How to observe/);
      assert.match(html, /observer-instructions-action/);
      assert.match(html, /https:\/\/example\.nyc\.gov\/calendar/);
    }
    const pdcHtml = renderMeetingDocument(fixtures[0]);
    assert.doesNotMatch(pdcHtml, /No exact Council hearing match/);
    assert.doesNotMatch(pdcHtml, /community-board lookup/i);
  });
});

test("A3: existing City Record, community-board, and Council families retain their source behavior", () => {
  const cityRecord = normalizeCityRecordMeeting({ request_id: "20260915001", title: "City Record hearing" });
  const board = normalizeCommunityBoardMeeting({
    source_record_id: "board-event-1", board_id: "brooklyn-cb-06", title: "Board meeting",
  });
  const council = normalizeNycLegistarEventsMeeting({ EventId: 22691, EventBodyName: "Committee on Contracts" });
  assert.equal(cityRecord.meeting_family, "descriptive_meeting_v0");
  assert.equal(cityRecord.compatibility.legacy_notice_href, "/notices/20260915001");
  assert.equal(board.meeting_family, "community_board_meeting_v0");
  assert.equal(board.institution_refs.board_ref, "community-board:brooklyn-cb-06");
  assert.equal(council.meeting_family, "descriptive_meeting_v0");
  assert.equal(council.source_keys[0].key_type, "event_id");
});

test("A4: observer details report effort and perform zero side effects", () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("observer detail must not fetch");
  };
  try {
    const html = renderMeetingDocument(normalizePdcCalendarMeeting({
      pdc_event_id: "pdc-side-effect-free", title: "Public Design Commission review", event_date: "2026-09-22",
      source_url: source, access_steps: [{ kind: "observer_instructions", destination: source, effort: "open_details", source_url: source }],
    }));
    assert.match(html, /observer-instructions-action/);
    assert.match(html, /meeting-access-effort">\(open_details\)/);
    assert.equal(fetchCalls, 0);
    assert.doesNotMatch(html, /mailto:|subscribe|reserve access|confirmation/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("A6: positive and absent access controls remain keyboard-usable and no-JavaScript safe", async () => {
  await withPinnedClock("2026-09-15T12:00:00Z", () => {
    const day = todayISO();
    const viewportContexts = [
      { name: "desktop", width: 1440 },
      { name: "narrow", width: 390 },
    ];
    const cases = [
      normalizeBsaCalendarMeeting({
        bsa_session_id: "bsa-positive", title: "BSA observed session", event_date: day,
        source_url: source, venue: { name: "Municipal Building" },
        access_steps: [{ kind: "observer_instructions", destination: source, effort: "open_details", source_url: source }],
      }),
      normalizeBsaCalendarMeeting({
        bsa_session_id: "bsa-absent", title: "BSA access not published", event_date: day, source_url: source,
      }),
    ];
    for (const viewport of viewportContexts) {
      for (const record of cases) {
        const html = renderMeetingDocument(record);
        assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/,
          `${viewport.name} render must declare a responsive viewport`);
        assert.match(html, /data-capability-reference="meeting\.get@1"/,
          `${viewport.name} render must retain the meeting capability anchor`);
        assert.match(html, /<main[^>]*tabindex="-1"/,
          `${viewport.name} render must keep the keyboard focus target`);
        assert.doesNotMatch(html, /onclick=|onkeydown=/i,
          `${viewport.name} render must not depend on inline keyboard handlers`);

        const withoutJavaScript = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
        assert.doesNotMatch(withoutJavaScript, /<script\b/i,
          `${viewport.name} no-JavaScript document must contain no executable script`);
        assert.match(withoutJavaScript, /<main[^>]*tabindex="-1"/,
          `${viewport.name} no-JavaScript document must retain the keyboard focus target`);
      }
    }
    const positiveWithoutJavaScript = renderMeetingDocument(cases[0])
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    assert.match(positiveWithoutJavaScript, /<a class="[^"]*observer-instructions-action[^"]*"[^>]*href="https:\/\/example\.nyc\.gov\/calendar"/,
      "positive no-JavaScript render must keep the observer action as a keyboard-reachable link");
    const absentWithoutJavaScript = renderMeetingDocument(cases[1])
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    assert.doesNotMatch(absentWithoutJavaScript, /data-observer-access|How to observe|observer-instructions-action|youtube\.com|watch_url|video\.example/i,
      "absent no-JavaScript render must keep observer controls and watch addresses absent");
  });
});
