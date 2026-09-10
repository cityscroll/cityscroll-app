import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MEETING_OBJECT_SCHEMA,
  meetingCanonicalHref,
  meetingIdForSource,
  meetingRouteLinks,
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
  normalizeNycLegistarEventsMeeting,
  resolveMeetingRoute,
} from "../site/meeting_object_contract.mjs";

const upcomingFixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url), "utf8"),
);
const peerIdentityFixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/peer_meeting_identity.json", import.meta.url), "utf8"),
);
import {
  auditMeetingSourceCompleteness,
  MEETING_SOURCE_COMPLETENESS,
} from "../site/meeting_source_completeness.mjs";
import { CITY_RECORD_MEETING_SOURCE_FIELDS } from "../worker/src/hearings.mjs";

test("meeting source completeness inventory covers every producer and surface disposition", () => {
  assert.deepEqual(Object.keys(MEETING_SOURCE_COMPLETENESS.producers).sort(), [
    "city_record",
    "community_board",
    "legistar",
  ]);
  const audit = auditMeetingSourceCompleteness();
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.ok, true);
  for (const [producer, entry] of Object.entries(MEETING_SOURCE_COMPLETENESS.producers)) {
    assert.ok(entry.fields.length > 0, producer);
    for (const field of entry.fields) {
      assert.ok(field.source_field, `${producer}: source field`);
      assert.ok(field.source_seam, `${producer}.${field.source_field}: source seam`);
      assert.ok(field.materialized_as, `${producer}.${field.source_field}: read model`);
      assert.ok(field.document_use, `${producer}.${field.source_field}: document`);
      assert.ok(field.search_use, `${producer}.${field.source_field}: search`);
      assert.ok(field.alert_use, `${producer}.${field.source_field}: alert`);
      assert.ok(field.disposition, `${producer}.${field.source_field}: disposition`);
    }
  }
  const cityFields = new Set(MEETING_SOURCE_COMPLETENESS.producers.city_record.fields
    .map((field) => field.source_field));
  assert.deepEqual(CITY_RECORD_MEETING_SOURCE_FIELDS.filter((field) => !cityFields.has(field)), []);
});

test("meeting is a registered source-qualified semantic object", () => {
  const registry = JSON.parse(readFileSync(new URL("../ontology/registry.v0.json", import.meta.url), "utf8"));
  const meeting = registry.object_types.find((entry) => entry.id === "meeting");
  assert.equal(meeting?.status, "registered");
  assert.equal(meeting?.identity_contract?.schema, MEETING_OBJECT_SCHEMA);
  assert.equal(meeting?.identity_contract?.source_qualified, true);
  assert.equal(meeting?.identity_contract?.title_date_identity_forbidden, true);
  assert.deepEqual(meeting?.identity_contract?.source_keys, [
    "city_record:request_id",
    "community_board:publisher_event_id",
    "nyc_legistar_events:event_id",
  ]);
});

test("Events feed EventId is the Legistar publisher key and InSite calendar id is a cross-reference", () => {
  const eventId = String(upcomingFixture.event.EventId);
  const record = normalizeNycLegistarEventsMeeting({
    ...upcomingFixture.event,
    insite_calendar: upcomingFixture.insite_calendar,
    description: upcomingFixture.event_items[0].EventItemTitle,
  });
  assert.equal(eventId, peerIdentityFixture.publisher_identity.event_id);
  assert.equal(record.meeting_id, `meeting:nyc_legistar_events:${eventId}`);
  assert.equal(record.meeting_id, peerIdentityFixture.publisher_identity.meeting_id);
  assert.equal(record.source_system, "nyc_legistar_events");
  assert.equal(record.source_keys[0].key_type, "event_id");
  assert.equal(record.source_keys[0].value, eventId);
  assert.equal(record.event_id, eventId);
  assert.equal(record.meeting_origin, "nyc_legistar_events_observed");
  assert.equal(record.join_status, "unknown");
  assert.notEqual(record.meeting_id, "meeting:nyc_legistar_events:1439673");
  assert.equal(String(upcomingFixture.insite_calendar.meeting_id), "1439673");
  assert.equal(record.publisher_cross_references[0].kind, "insite_calendar");
  assert.equal(record.publisher_cross_references[0].meeting_id, "1439673");
  assert.equal(
    record.publisher_cross_references[0].meeting_guid,
    upcomingFixture.insite_calendar.meeting_guid,
  );
  assert.equal(meetingCanonicalHref(record), "/meetings/meeting%3Anyc_legistar_events%3A22691");
  assert.equal(resolveMeetingRoute(record.source_url, [record]).meeting_id, record.meeting_id);
});

test("both producers preserve their exact source key in one shared object shape", () => {
  const cityRecord = normalizeCityRecordMeeting({
    request_id: "20260814001",
    short_title: "Public hearing on a local matter",
    event_date: "2026-08-20T10:00:00.000",
    venue: { mode: "in-person", address: "22 Reade Street" },
    participation: { links: [], emails: [], phones: [] },
    meeting_origin: "city_record_notice",
  });
  const board = normalizeCommunityBoardMeeting({
    board_id: "brooklyn-cb-06",
    source_record_id: "event-abc-123",
    title: "Brooklyn Community Board 6 meeting",
    event_date: "2026-08-20",
    source_url: "https://example.test/meetings/event-abc-123",
    source_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
    meeting_origin: "community_board_source_observed",
  });

  for (const record of [cityRecord, board]) {
    assert.equal(record.object_type, "meeting");
    assert.equal(record.schema, MEETING_OBJECT_SCHEMA);
    assert.ok(record.meeting_id.startsWith("meeting:"));
    assert.ok(record.source_keys.length === 1);
    assert.ok(record.publisher_identifier);
    assert.ok("title" in record && "event_date" in record);
    assert.ok("venue" in record && "participation" in record);
    assert.ok("source_url" in record && "source_system" in record);
    assert.ok("meeting_origin" in record && "source_receipt" in record);
    assert.ok("join_status" in record && "institution_refs" in record);
    assert.ok("meeting_family" in record);
  }

  assert.equal(cityRecord.meeting_id, meetingIdForSource("city_record", "20260814001"));
  assert.equal(cityRecord.source_keys[0].value, "20260814001");
  assert.equal(board.meeting_id, meetingIdForSource("community_board", "event-abc-123"));
  assert.equal(board.source_keys[0].value, "event-abc-123");
  assert.equal(board.institution_refs.agency_ref, null);
  assert.equal(board.institution_refs.board_ref, "community-board:brooklyn-cb-06");
  assert.equal(board.join_status, "unknown");
  const legistar = normalizeNycLegistarEventsMeeting({
    EventId: 22691,
    EventBodyName: "Committee on Contracts",
    EventDate: "2026-09-23T00:00:00",
    EventTime: "10:00 AM",
    EventLocation: "250 Broadway - 8th Floor - Hearing Room 2",
  });
  for (const record of [cityRecord, board, legistar]) {
    assert.equal(record.object_type, "meeting");
    assert.equal(record.schema, MEETING_OBJECT_SCHEMA);
    assert.ok(record.meeting_id.startsWith("meeting:"));
    assert.ok(record.source_keys.length === 1);
    assert.ok(record.publisher_identifier);
  }
  assert.equal(legistar.meeting_id, meetingIdForSource("nyc_legistar_events", "22691"));
  assert.equal(legistar.source_keys[0].key_type, "event_id");
  assert.equal(legistar.event_date, "2026-09-23T10:00:00");
  assert.equal(legistar.committee.name, "Committee on Contracts");
  assert.equal(cityRecord.meeting_family, "descriptive_meeting_v0");
  assert.equal(board.meeting_family, "community_board_meeting_v0");
  assert.equal(legistar.meeting_family, "descriptive_meeting_v0");
});

test("explicit rulemaking family survives canonical meeting normalization", () => {
  const record = normalizeCityRecordMeeting({
    request_id: "20260814003",
    meeting_family: "agency_rulemaking_hearing",
    event_date: "2026-08-20",
  });
  assert.equal(record.meeting_family, "agency_rulemaking_hearing");
});

test("City Record notice fields stay on the normalized materialized meeting", () => {
  const record = normalizeCityRecordMeeting({
    request_id: "20260814002",
    type_of_notice_description: "Public Hearings",
    section_name: "Public Hearings and Meetings",
    additional_description_1: "A published notice body.",
    street_address_1: "250 Broadway",
    contact_name: "Public Hearings Unit",
    email: "hearings@example.gov",
  });
  assert.equal(record.type_of_notice_description, "Public Hearings");
  assert.equal(record.additional_description_1, "A published notice body.");
  assert.equal(record.street_address_1, "250 Broadway");
  assert.equal(record.contact_name, "Public Hearings Unit");
  assert.equal(record.email, "hearings@example.gov");
});

test("identity never falls back to title/date and missing institutions stay honest", () => {
  assert.throws(() => meetingIdForSource("community_board", ""), /publisher_event_id is required/);
  assert.throws(() => meetingIdForSource("nyc_legistar_events", ""), /event_id is required/);
  const missingKey = normalizeCommunityBoardMeeting({ title: "Same title", event_date: "2026-08-20" });
  assert.equal(missingKey.meeting_id, null);
  assert.deepEqual(missingKey.source_keys, []);
  const first = normalizeCommunityBoardMeeting({ source_record_id: "event-1", title: "Same title", event_date: "2026-08-20" });
  const second = normalizeCommunityBoardMeeting({ source_record_id: "event-2", title: "Same title", event_date: "2026-08-20" });
  assert.notEqual(first.meeting_id, second.meeting_id);
  assert.deepEqual(first.institution_refs, { agency_ref: null, board_ref: null });
  const left = normalizeNycLegistarEventsMeeting({
    EventId: 22691,
    EventBodyName: "Committee on Contracts",
    EventDate: "2026-09-23T00:00:00",
  });
  const right = normalizeNycLegistarEventsMeeting({
    EventId: 22692,
    EventBodyName: "Committee on Contracts",
    EventDate: "2026-09-23T00:00:00",
  });
  assert.notEqual(left.meeting_id, right.meeting_id);
});

test("canonical route retains notice aliases and publisher provenance", () => {
  const cityRecord = normalizeCityRecordMeeting({ request_id: "20260814001", title: "Public hearing" });
  const board = normalizeCommunityBoardMeeting({
    source_record_id: "event-abc-123",
    title: "Board meeting",
    source_url: "https://example.test/meetings/event-abc-123",
  });
  assert.equal(meetingCanonicalHref(cityRecord), "/meetings/meeting%3Acity_record%3A20260814001");
  assert.deepEqual(meetingRouteLinks(cityRecord), {
    canonical_href: "/meetings/meeting%3Acity_record%3A20260814001",
    legacy_notice_href: "/notices/20260814001",
    legacy_fragment_href: "#notice/20260814001",
    publisher_href: "https://a856-cityrecord.nyc.gov/RequestDetail/20260814001",
  });
  assert.equal(resolveMeetingRoute("/notices/20260814001", [cityRecord]).meeting_id, cityRecord.meeting_id);
  assert.equal(resolveMeetingRoute("/#notice/20260814001", [cityRecord]).canonical_href, meetingCanonicalHref(cityRecord));
  assert.equal(resolveMeetingRoute(board.source_url, [board]).meeting_id, board.meeting_id);
  assert.equal(resolveMeetingRoute("/notices/20260814001", [board]), null);
});
