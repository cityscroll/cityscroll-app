import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseAirtableSource,
  parseGoogleCalendarSource,
  parseHtmlPdfSource,
  parseNycOfficialCalendarSource,
} from "../site/community_board_source_adapters.mjs";
import {
  ATTENDANCE_MEANING,
  LOCATION_ROLES,
  LOCATION_VALIDITY,
  buildMeetingLocationAssertions,
  isAdmittedPhysicalVenue,
  isDateShapedVenueText,
  parseIcsLocationWrapper,
} from "../site/meeting_location_assertions.mjs";
import {
  normalizeCommunityBoardMeeting,
  normalizeOathTrialCalendarMeeting,
} from "../site/meeting_object_contract.mjs";
import { materializeCommunityBoardMeetingRow } from "../tools/build_community_board_meeting_index.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/meeting_location_assertions/${name}`, import.meta.url), "utf8");
const fixtureJson = (name) => JSON.parse(fixture(name));

const CB14_HOUSING_URL = "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const CB14_SEPT14_URL = "https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const QUEENS_CB1_URL = "https://www.nyc.gov/site/queenscb1/calendar/calendar.page";
const QUEENS_CB2_ICS_URL = "https://calendar.google.com/calendar/ical/t613gs3ukqiab5hgeibu27rfjs%40group.calendar.google.com/public/basic.ics";

test("A1 CB14 September 23 preserves structured venue, publisher URL, and in-person mode", () => {
  const records = parseHtmlPdfSource(fixture("cb14-housing-land-use-september-2026.html"), {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "brooklyn-cb-14",
    body_name: "Brooklyn Community Board 14",
    url: "https://cb14brooklyn.com/meetings/",
    format: "board-owned WordPress HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } });

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.record_url, CB14_HOUSING_URL);
  assert.equal(record.location_components?.street_address, "810 East 16th Street");
  assert.equal(record.location_components?.address_locality, "Brooklyn");
  assert.equal(record.location_components?.address_region, "NY");
  assert.equal(record.location_components?.postal_code, "11230");
  assert.equal(record.venue_name, "Brooklyn CB14 District Office");
  assert.equal(record.mode, "in-person");

  const meeting = materializeCommunityBoardMeetingRow(record, {
    id: "brooklyn-cb-14",
    name: "Brooklyn Community Board 14",
  }, "2026-09-23T05:09:59.711Z");

  assert.equal(
    meeting.meeting_id,
    `meeting:community_board:${CB14_HOUSING_URL}`,
  );
  assert.equal(meeting.source_url, CB14_HOUSING_URL);
  assert.equal(meeting.venue?.mode, "in-person");
  assert.equal(meeting.venue?.address, "810 East 16th Street, Brooklyn, NY 11230");
  assert.equal(meeting.venue?.name, "Brooklyn CB14 District Office");

  const venueAssertion = meeting.location_assertions.find((row) => row.role === LOCATION_ROLES.VENUE);
  assert.ok(venueAssertion);
  assert.equal(venueAssertion.validity, LOCATION_VALIDITY.ADMITTED_PHYSICAL);
  assert.equal(venueAssertion.attendance_meaning, ATTENDANCE_MEANING.IN_PERSON);
  assert.equal(venueAssertion.components.street_address, "810 East 16th Street");
  assert.equal(venueAssertion.components.postal_code, "11230");
  assert.equal(venueAssertion.source_field, "location.address");
  assert.ok(isAdmittedPhysicalVenue(venueAssertion));
});

test("A2 Queens CB2 LaGuardia ICS wrapper keeps street and ZIP without a board borough guess", () => {
  const parsed = parseIcsLocationWrapper(
    "Laguardia Community College E Building (31-10 Thomson Ave, Long Island City, 11101)",
  );
  assert.equal(parsed.venue_name, "Laguardia Community College E Building");
  assert.equal(parsed.components.street_address, "31-10 Thomson Avenue");
  assert.equal(parsed.components.postal_code, "11101");
  assert.equal(parsed.components.address_locality, "Long Island City");
  assert.equal(parsed.components.address_borough, null);

  const records = parseGoogleCalendarSource(fixture("queens-cb02-laguardia.ics"), {
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    board_id: "queens-cb-02",
    body_name: "Queens Community Board 2",
    url: QUEENS_CB2_ICS_URL,
    format: "google calendar ICS",
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } });

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.venue_name, "Laguardia Community College E Building");
  assert.equal(record.location_components.street_address, "31-10 Thomson Avenue");
  assert.equal(record.location_components.postal_code, "11101");
  assert.equal(record.location_components.address_borough, null);
  assert.match(record.address, /31-10 Thomson Ave/);

  const meeting = normalizeCommunityBoardMeeting({
    ...record,
    board_id: "queens-cb-02",
    publisher_identifier: record.publisher_identifier,
    source_url: QUEENS_CB2_ICS_URL,
    meeting_origin: "community_board_source_observed",
    venue: {
      name: record.venue_name,
      address: record.address,
      mode: record.mode,
      components: record.location_components,
    },
    location_components: record.location_components,
    location_wrapper: record.location_wrapper,
  });

  const venueAssertion = meeting.location_assertions.find((row) => row.role === LOCATION_ROLES.VENUE);
  assert.equal(venueAssertion.validity, LOCATION_VALIDITY.ADMITTED_PHYSICAL);
  assert.equal(venueAssertion.venue_name, "Laguardia Community College E Building");
  assert.equal(venueAssertion.components.street_address, "31-10 Thomson Avenue");
  assert.equal(venueAssertion.components.postal_code, "11101");
  assert.equal(venueAssertion.components.address_borough, null);
  assert.equal(venueAssertion.wrapper, "31-10 Thomson Ave, Long Island City, 11101");
  assert.equal(venueAssertion.source_field, "LOCATION");
  // Hosting board must not supply a missing borough.
  assert.equal(meeting.board_id || "queens-cb-02", "queens-cb-02");
  assert.equal(venueAssertion.components.address_borough, null);
});

test("A3 date-shaped, video/office conflict, footer contact, and OATH absence stay non-physical", () => {
  assert.equal(isDateShapedVenueText("October 20, 2026"), true);

  const queens = parseNycOfficialCalendarSource(fixture("queens-cb01-full-board-dates.html"), {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "queens-cb-01",
    body_name: "Queens Community Board 1",
    url: QUEENS_CB1_URL,
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } });
  assert.equal(queens.length, 1);
  assert.equal(queens[0].address, null);
  assert.equal(queens[0].record_id, "nyc-calendar:queens-cb-01:2026-09-22:full-board-public-hearing-meetings");

  const queensMeeting = materializeCommunityBoardMeetingRow(queens[0], {
    id: "queens-cb-01",
    name: "Queens Community Board 1",
  }, "2026-09-23T05:09:59.711Z");
  assert.equal(
    queensMeeting.meeting_id,
    "meeting:community_board:nyc-calendar:queens-cb-01:2026-09-22:full-board-public-hearing-meetings",
  );
  assert.equal(queensMeeting.venue, null);
  const queensVenue = queensMeeting.location_assertions.find((row) => row.role === LOCATION_ROLES.VENUE);
  assert.equal(queensVenue.validity, LOCATION_VALIDITY.UNLOCATED);
  assert.equal(isAdmittedPhysicalVenue(queensVenue), false);

  // Replay the frozen shard text through the assertion layer: date-shaped source
  // text is preserved for repair and emits no address candidate.
  const e8Assertions = buildMeetingLocationAssertions({
    meeting_id: "meeting:community_board:nyc-calendar:queens-cb-01:2026-09-22:full-board-public-hearing-meetings",
    venue: { name: null, address: "October 20, 2026", mode: "not-stated" },
  });
  assert.equal(e8Assertions[0].validity, LOCATION_VALIDITY.REJECTED_DATE_SHAPED);
  assert.equal(e8Assertions[0].original_address, "October 20, 2026");
  assert.equal(isAdmittedPhysicalVenue(e8Assertions[0]), false);

  const airtable = parseAirtableSource(fixtureJson("manhattan-cb11-economic-development-airtable.json"), {
    adapter: "airtable_v1",
    role: "upcoming_meetings",
    board_id: "manhattan-cb-11",
    airtable_share_id: "shrEZxc5vi8McZNFb",
    url: "https://www.cb11m.org/calendar/",
    format: "public Airtable shared view",
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } });
  assert.equal(airtable.length, 1);
  assert.equal(airtable[0].record_id, "recCUxAqawlygvkw5");
  assert.match(airtable[0].address, /via Video Conference/);
  assert.match(airtable[0].address, /1664 Park Avenue/);
  assert.equal(airtable[0].mode, "not-stated");

  const conflictMeeting = normalizeCommunityBoardMeeting({
    ...airtable[0],
    board_id: "manhattan-cb-11",
    source_url: "https://airtable.com/shrEZxc5vi8McZNFb/recCUxAqawlygvkw5",
    meeting_origin: "community_board_source_observed",
    venue: {
      name: airtable[0].venue_name,
      address: airtable[0].address,
      mode: airtable[0].mode,
    },
  });
  const conflict = conflictMeeting.location_assertions.find((row) => row.role === LOCATION_ROLES.VENUE);
  assert.equal(conflict.validity, LOCATION_VALIDITY.UNRESOLVED_ATTENDANCE);
  assert.equal(conflict.attendance_meaning, ATTENDANCE_MEANING.UNRESOLVED_CONFLICT);
  assert.equal(isAdmittedPhysicalVenue(conflict), false);
  assert.equal(conflictMeeting.venue?.attendance_conflict, true);

  const sept14 = parseHtmlPdfSource(fixture("cb14-september-2026-board-meeting.html"), {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "brooklyn-cb-14",
    body_name: "Brooklyn Community Board 14",
    url: "https://cb14brooklyn.com/meetings/",
    event_detail: true,
    format: "board-owned WordPress HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-09-23T05:09:59.711Z" } });
  assert.equal(sept14.length, 1);
  assert.equal(sept14[0].record_url, CB14_SEPT14_URL);
  assert.equal(sept14[0].location_components?.street_address, "1625 Ocean Avenue");
  assert.equal(sept14[0].venue_name, "East Midwood Jewish Center");
  assert.doesNotMatch(sept14[0].address || "", /810 East 16th/);

  const sept14Meeting = normalizeCommunityBoardMeeting({
    ...sept14[0],
    board_id: "brooklyn-cb-14",
    source_url: CB14_SEPT14_URL,
    meeting_origin: "community_board_source_observed",
    venue: {
      name: sept14[0].venue_name,
      address: sept14[0].address,
      mode: sept14[0].mode,
      components: sept14[0].location_components,
    },
    location_components: sept14[0].location_components,
    incidental_location_addresses: [{
      address: "810 East 16th Street, Brooklyn, NY 11230",
      source_field: "page_footer",
      passage: "Brooklyn Community Board 14 District Office, 810 East 16th Street, Brooklyn, NY 11230",
    }],
  });
  const sept14Venue = sept14Meeting.location_assertions.find((row) => row.role === LOCATION_ROLES.VENUE);
  assert.equal(sept14Venue.components.street_address, "1625 Ocean Avenue");
  assert.equal(isAdmittedPhysicalVenue(sept14Venue), true);
  const footer = sept14Meeting.location_assertions.find((row) => row.role === LOCATION_ROLES.CONTACT_FOOTER);
  assert.ok(footer);
  assert.equal(footer.validity, LOCATION_VALIDITY.REJECTED_INCIDENTAL);
  assert.match(footer.original_address, /810 East 16th Street/);
  assert.equal(isAdmittedPhysicalVenue(footer), false);

  const oath = normalizeOathTrialCalendarMeeting({
    oath_trial_session_id: "262301:2026-09-30:12:30:00:Scheduled-For-Trial",
    title: "OATH trial 262301",
    event_date: "2026-09-30T12:30:00",
    source_url: "https://a820-oathhearingrequest.nyc.gov/",
    meeting_origin: "oath_trial_calendar_observed",
  });
  assert.equal(oath.venue, null);
  assert.equal(oath.location_assertions.length, 1);
  assert.equal(oath.location_assertions[0].validity, LOCATION_VALIDITY.UNLOCATED);
  assert.equal(isAdmittedPhysicalVenue(oath.location_assertions[0]), false);
});
