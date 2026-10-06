/**
 * Publish-time shared meeting slim must retain subject-property assertions
 * (and the compact agenda_subject_places projection) for meetings that carry
 * them upstream. Dropping every location_assertion made the Pages-served
 * catalog lose the Subject property section the meeting-detail renderer reads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PAGES_FILE_HEADROOM_BYTES } from "../tools/check_pages_bundle_sizes.mjs";
import {
  agendaSubjectPlacesFromAssertions,
  PUBLIC_LOCATION_MEMBERSHIP_ROLES,
  SHARED_MEETING_PUBLISH_STRIP,
  slimGeographyBackfillReceipt,
  slimPublicLocationMembership,
  slimSharedMeetingReadModel,
  slimSharedMeetingRow,
  SUBJECT_PROPERTY_ROLE,
  VENUE_MEMBERSHIP_ROLE,
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

function hostMembership() {
  return {
    record_id: SEPT14_ID,
    role: "host_jurisdiction",
    geography_key: "geography:community_district:K14",
    provenance: { method: "community_board_ontology" },
  };
}

function venueMembership() {
  return {
    record_id: SEPT14_ID,
    role: VENUE_MEMBERSHIP_ROLE,
    geography_key: "geography:nta2020:BK1403",
    memberships: {
      nta2020: "BK1403",
      community_district: "K14",
      police_precinct: "70",
    },
    provenance: {
      source_method: "admitted_venue_membership",
      parcel_bbl: "3076200025",
      source_path: { original_address: VENUE_ADDRESS },
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
      hostMembership(),
      venueMembership(),
      {
        record_id: SEPT14_ID,
        role: SUBJECT_PROPERTY_ROLE,
        geography_key: "geography:nta2020:BK1402",
        memberships: {
          nta2020: "BK1402",
          community_district: "K14",
          police_precinct: "70",
        },
        provenance: {
          source_method: "admitted_subject_membership",
          parcel_bbl: "3050700035",
          source_path: { original_address: SUBJECT_ADDRESS },
        },
      },
    ],
    geography_backfill: {
      outcome: "subject",
      generation: "test-generation",
      input_hash: "deadbeef".repeat(8),
      processed_at: "2026-10-05T20:21:40.442Z",
    },
  };
}

/** Build a pretty-printed catalog larger than the Pages refresh headroom mark. */
function fatCatalogOverHeadroom() {
  const pad = "x".repeat(2400);
  const rows = [];
  const model = {
    schema: "cityscroll.shared_meeting_read_model.v1",
    generated_at: "2026-09-30T12:00:00.000Z",
    rows,
  };
  let pretty = `${JSON.stringify(model, null, 2)}\n`;
  let i = 0;
  while (pretty.length <= PAGES_FILE_HEADROOM_BYTES) {
    rows.push({
      meeting_id: `meeting:community_board:https://example.test/fat-${i}/`,
      title: `Fat geography stamp ${i} ${pad}`,
      venue: { name: `Venue ${i}`, address: `${i} Example Street, Brooklyn, NY 11230`, mode: "in-person" },
      location_assertions: [
        {
          ...venueAssertion(),
          assertion_id: `location_assertion:fat-${i}::venue`,
          meeting_id: `meeting:community_board:https://example.test/fat-${i}/`,
          original_address: `${i} Example Street, Brooklyn, NY 11230 ${pad}`,
          source_passage: pad,
        },
        {
          ...subjectAssertion(),
          assertion_id: `location_assertion:fat-${i}::subject_property`,
          meeting_id: `meeting:community_board:https://example.test/fat-${i}/`,
          original_address: `${1000 + i} Subject Avenue`,
        },
      ],
      location_memberships: [
        {
          record_id: `meeting:community_board:https://example.test/fat-${i}/`,
          role: "host_jurisdiction",
          geography_key: "geography:community_district:K14",
          provenance: { method: "community_board_ontology", note: pad },
        },
        {
          record_id: `meeting:community_board:https://example.test/fat-${i}/`,
          role: VENUE_MEMBERSHIP_ROLE,
          geography_key: "geography:nta2020:BK1403",
        },
      ],
    });
    pretty = `${JSON.stringify(model, null, 2)}\n`;
    i += 1;
    if (i > 20000) throw new Error("fat catalog builder failed to exceed headroom");
  }
  return model;
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

test("SHARED_MEETING_PUBLISH_STRIP lists exactly what is removed and why it is not displayed", () => {
  assert.deepEqual(
    SHARED_MEETING_PUBLISH_STRIP.map((entry) => entry.field).sort(),
    [
      "geography_backfill.input_hash",
      "location_assertions",
      "location_memberships",
      "location_memberships.provenance.source_path",
      "location_memberships.record_id",
    ],
  );
  for (const entry of SHARED_MEETING_PUBLISH_STRIP) {
    assert.equal(typeof entry.remove_when, "string");
    assert.ok(entry.remove_when.length > 0, `${entry.field} must name the remove predicate`);
    assert.equal(typeof entry.why_not_displayed, "string");
    assert.ok(
      entry.why_not_displayed.length > 20,
      `${entry.field} must explain why the resident UI does not read the stripped value`,
    );
  }
  assert.deepEqual([...PUBLIC_LOCATION_MEMBERSHIP_ROLES].sort(), [
    SUBJECT_PROPERTY_ROLE,
    VENUE_MEMBERSHIP_ROLE,
  ]);
});

test("slimPublicLocationMembership drops record_id and source_path; keeps placement + police_precinct", () => {
  const slim = slimPublicLocationMembership(venueMembership());
  assert.equal(Object.prototype.hasOwnProperty.call(slim, "record_id"), false);
  assert.equal(slim.role, VENUE_MEMBERSHIP_ROLE);
  assert.equal(slim.geography_key, "geography:nta2020:BK1403");
  assert.equal(slim.memberships?.police_precinct, "70");
  assert.equal(slim.provenance?.source_method, "admitted_venue_membership");
  assert.equal(slim.provenance?.parcel_bbl, "3076200025");
  assert.equal(Object.prototype.hasOwnProperty.call(slim.provenance || {}, "source_path"), false);
});

test("slimGeographyBackfillReceipt keeps outcome + processed_at only", () => {
  const slim = slimGeographyBackfillReceipt({
    outcome: "physical_venue",
    processed_at: "2026-10-05T20:21:40.442Z",
    generation: "gen-test",
    input_hash: "abc123",
  });
  assert.deepEqual(slim, {
    outcome: "physical_venue",
    processed_at: "2026-10-05T20:21:40.442Z",
  });
});

test("slimSharedMeetingRow drops venue assertions and host memberships; retains user-visible fields", () => {
  const published = slimSharedMeetingRow(upstreamRow());
  assert.ok(published.location_assertions);
  assert.equal(published.location_assertions.length, 1);
  assert.equal(published.location_assertions[0].role, SUBJECT_PROPERTY_ROLE);
  assert.equal(published.location_assertions[0].original_address, SUBJECT_ADDRESS);
  assert.equal(published.agenda_subject_places?.length, 1);
  assert.equal(published.agenda_subject_places[0].original_address, SUBJECT_ADDRESS);
  assert.match(published.agenda_subject_places[0].source_passage || "", /461 Coney Island Avenue/);
  assert.equal(published.venue?.address, VENUE_ADDRESS);
  assert.equal(published.venue?.name, "East Midwood Jewish Center");
  assert.equal(published.title?.includes("September 2026"), true);
  assert.equal(published.geography_backfill?.outcome, "subject");
  assert.equal(published.geography_backfill?.processed_at, "2026-10-05T20:21:40.442Z");
  assert.equal(
    Object.prototype.hasOwnProperty.call(published.geography_backfill || {}, "input_hash"),
    false,
    "catalog geography_backfill must drop input_hash",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(published.geography_backfill || {}, "generation"),
    false,
    "catalog geography_backfill must drop generation",
  );
  assert.equal(
    (published.location_memberships || []).some((row) => row.role === "host_jurisdiction"),
    false,
    "host_jurisdiction memberships must be stripped from the published catalog",
  );
  assert.equal(
    (published.location_memberships || []).some((row) => row.role === VENUE_MEMBERSHIP_ROLE),
    true,
    "venue memberships remain for Near You exact placement",
  );
  assert.equal(
    (published.location_memberships || []).some((row) => row.role === SUBJECT_PROPERTY_ROLE),
    true,
    "subject_property memberships remain for About placement",
  );
  assert.equal(
    (published.location_assertions || []).some((row) => row.role === "venue"),
    false,
    "venue assertions must be stripped (redundant with venue text)",
  );
  for (const membership of published.location_memberships || []) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(membership, "record_id"),
      false,
      "published memberships must drop redundant record_id",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(membership.provenance || {}, "source_path"),
      false,
      "published memberships must drop provenance.source_path",
    );
    assert.equal(
      membership.memberships?.police_precinct,
      "70",
      "police_precinct stays on retained venue/subject memberships",
    );
  }
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

test("producer slim of an over-headroom catalog stays under the Pages refresh headroom budget", () => {
  const fat = fatCatalogOverHeadroom();
  const fatPretty = `${JSON.stringify(fat, null, 2)}\n`;
  assert.ok(
    fatPretty.length > PAGES_FILE_HEADROOM_BYTES,
    `fat fixture must exceed headroom (${fatPretty.length} > ${PAGES_FILE_HEADROOM_BYTES})`,
  );
  const published = slimSharedMeetingReadModel(fat);
  const publishedPretty = `${JSON.stringify(published, null, 2)}\n`;
  assert.ok(
    publishedPretty.length <= PAGES_FILE_HEADROOM_BYTES,
    `published shared_meeting must stay under ${PAGES_FILE_HEADROOM_BYTES} bytes after producer slim; got ${publishedPretty.length}`,
  );
  assert.equal(published.rows.length, fat.rows.length);
  for (const row of published.rows) {
    assert.equal(
      (row.location_assertions || []).every((item) => item.role === SUBJECT_PROPERTY_ROLE),
      true,
    );
    assert.equal(
      (row.location_memberships || []).every((item) => (
        PUBLIC_LOCATION_MEMBERSHIP_ROLES.includes(item.role)
      )),
      true,
    );
    assert.ok(row.venue?.address, "venue text remains user-visible");
    assert.ok(
      (row.location_assertions || []).length >= 1 || (row.agenda_subject_places || []).length >= 1,
      "subject places remain user-visible",
    );
  }
});

test("geography backfill producer wires publish slim before activating shared_meeting", async () => {
  const source = await import("node:fs").then((fs) => (
    fs.readFileSync(new URL("../tools/build_meeting_geography_backfill.mjs", import.meta.url), "utf8")
  ));
  assert.match(source, /slimSharedMeetingReadModel/);
  assert.match(
    source,
    /const stampedShared = slimSharedMeetingReadModel\(/,
    "producer must slim the stamped shared catalog before activation",
  );
});
