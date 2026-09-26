/**
 * Publish-time shared meeting slim must retain subject-property assertions
 * (and the compact agenda_subject_places projection) for meetings that carry
 * them upstream. Dropping every location_assertion made the Pages-served
 * catalog lose the Subject property section the meeting-detail renderer reads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  agendaSubjectPlacesFromAssertions,
  slimSharedMeetingReadModel,
  slimSharedMeetingRow,
  SUBJECT_PROPERTY_ROLE,
} from "../tools/lib/shared_meeting_publish_slim.mjs";

const SEPT14_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
const SUBJECT_ADDRESS = "461 Coney Island Avenue";
const VENUE_ADDRESS = "1625 Ocean Avenue, Brooklyn, New York, 11230";

function subjectAssertion(overrides = {}) {
  return {
    schema: "cityscroll.meeting_location_assertion.v1",
    assertion_id:
      "location_assertion:meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/::subject_property::description::2",
    meeting_id: SEPT14_ID,
    role: SUBJECT_PROPERTY_ROLE,
    validity: "admitted_subject_property",
    original_address: SUBJECT_ADDRESS,
    source_field: "description",
    source_passage: "application for OC Dispensary at 461 Coney Island Avenue",
    passage_locator: "description:application_at:461-coney-island-ave@50",
    source_receipt: {
      schema: "cityscroll.community_board_source_receipt.v1",
      source_url: "https://cb14brooklyn.com/meeting/september-2026-board-meeting/",
      status: "ok",
      content_sha256: "0fcab5cd4a67004d7e76513a1ac321efc9bae6f7fe6f1e6ace3928529cd7fff5",
    },
    ...overrides,
  };
}

function venueAssertion() {
  return {
    schema: "cityscroll.meeting_location_assertion.v1",
    assertion_id:
      "location_assertion:meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/::venue::venue.address::1",
    meeting_id: SEPT14_ID,
    role: "venue",
    validity: "admitted_physical_venue",
    original_address: VENUE_ADDRESS,
    venue_name: "East Midwood Jewish Center",
    source_field: "venue.address",
    source_receipt: {
      schema: "cityscroll.community_board_source_receipt.v1",
      source_url: "https://cb14brooklyn.com/meeting/september-2026-board-meeting/",
      status: "ok",
      content_sha256: "0fcab5cd4a67004d7e76513a1ac321efc9bae6f7fe6f1e6ace3928529cd7fff5",
    },
  };
}

function upstreamRow() {
  return {
    meeting_id: SEPT14_ID,
    title: "September 2026 Board Meeting and Public Hearings on Cannabis Application and NYC Budget FY 2028",
    venue: { name: "East Midwood Jewish Center", address: VENUE_ADDRESS, mode: "in-person" },
    location_assertions: [venueAssertion(), subjectAssertion()],
    location_memberships: [
      {
        record_id: SEPT14_ID,
        role: SUBJECT_PROPERTY_ROLE,
        provenance: { source_path: { original_address: SUBJECT_ADDRESS } },
      },
    ],
  };
}

test("agendaSubjectPlacesFromAssertions keeps only subject_property addresses", () => {
  const places = agendaSubjectPlacesFromAssertions([venueAssertion(), subjectAssertion()]);
  assert.deepEqual(places, [
    {
      original_address: SUBJECT_ADDRESS,
      source_passage: "application for OC Dispensary at 461 Coney Island Avenue",
      passage_locator: "description:application_at:461-coney-island-ave@50",
      assertion_id:
        "location_assertion:meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/::subject_property::description::2",
    },
  ]);
});

test("slimSharedMeetingRow drops venue assertions and retains subject assertions plus agenda_subject_places", () => {
  const published = slimSharedMeetingRow(upstreamRow());
  assert.ok(published.location_assertions);
  assert.equal(published.location_assertions.length, 1);
  assert.equal(published.location_assertions[0].role, SUBJECT_PROPERTY_ROLE);
  assert.equal(published.location_assertions[0].original_address, SUBJECT_ADDRESS);
  assert.equal(published.agenda_subject_places?.length, 1);
  assert.equal(published.agenda_subject_places[0].original_address, SUBJECT_ADDRESS);
  assert.match(published.agenda_subject_places[0].source_passage || "", /461 Coney Island Avenue/);
  assert.equal(published.venue?.address, VENUE_ADDRESS);
});

test("regression: published model keeps subject places when upstream row has subject assertions", () => {
  const upstream = {
    schema: "cityscroll.shared_meeting_read_model.v1",
    rows: [
      upstreamRow(),
      {
        meeting_id: "meeting:community_board:https://example.test/venue-only/",
        title: "Venue only",
        location_assertions: [venueAssertion()],
      },
    ],
  };
  const published = slimSharedMeetingReadModel(upstream);
  const subjectRow = published.rows.find((row) => row.meeting_id === SEPT14_ID);
  const venueOnly = published.rows.find((row) => row.meeting_id.includes("venue-only"));

  assert.ok(subjectRow, "subject meeting must remain in published rows");
  assert.equal(
    (subjectRow.location_assertions || []).some((row) => (
      row.role === SUBJECT_PROPERTY_ROLE && row.original_address === SUBJECT_ADDRESS
    )),
    true,
    "published model must carry the upstream subject_property assertion",
  );
  assert.equal(
    (subjectRow.agenda_subject_places || []).some((place) => place.original_address === SUBJECT_ADDRESS),
    true,
    "published model must project agenda_subject_places for the subject",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(venueOnly, "location_assertions"),
    false,
    "venue-only rows must drop bulky location_assertions",
  );
  assert.equal(venueOnly.agenda_subject_places, undefined);
});

test("regression: producer must not emit a subject meeting without subject places when upstream had them", () => {
  const published = slimSharedMeetingReadModel({
    schema: "cityscroll.shared_meeting_read_model.v1",
    rows: [upstreamRow()],
  });
  const row = published.rows[0];
  const hasAssertion = (row.location_assertions || []).some((item) => (
    item.role === SUBJECT_PROPERTY_ROLE && item.original_address === SUBJECT_ADDRESS
  ));
  const hasPlace = (row.agenda_subject_places || []).some((item) => (
    item.original_address === SUBJECT_ADDRESS
  ));
  assert.equal(
    hasAssertion || hasPlace,
    true,
    "served/published catalog must retain subject assertions or agenda_subject_places when upstream admitted them",
  );
});
