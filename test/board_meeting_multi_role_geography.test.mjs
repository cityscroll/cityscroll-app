/**
 * Dual board-jurisdiction + venue placement for community board meetings.
 * Acceptance for alias c12b60479973d: keep the board district without discarding
 * the meeting venue through meetingPlacementsFromRow and the activity index.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildDistrictActivity,
  meetingPlacementsFromRow,
} from "../tools/lib/district_activity.mjs";

const boundaries = JSON.parse(
  readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"),
);
const communityBoardGeography = JSON.parse(
  readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url), "utf8"),
);
const geographyLayers = [
  JSON.parse(readFileSync(new URL("../site/data/geography/layers/nta2020/26B.json", import.meta.url), "utf8")),
];

const CB14_SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";
const CB14_SEPT23_URL =
  "https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";

/** Official parcel 3066990010 (810 East 16th) — E3 memberships. */
const VENUE_PARCEL = Object.freeze({
  bbl: "3066990010",
  point: { lat: 40.6297346, lon: -73.9615272 },
  memberships: {
    borough: "3",
    community_district: "K14",
    council_district: "45",
    nta2020: "BK1403",
    police_precinct: "70",
  },
});

function cb14September23Row(overrides = {}) {
  return {
    meeting_id: CB14_SEPT23_ID,
    request_id: CB14_SEPT23_ID,
    source_system: "community_board",
    board_id: "brooklyn-cb-14",
    institution_refs: { board_ref: "community-board:brooklyn-cb-14" },
    title: "Housing and Land Use Committee Meeting",
    short_title: "Housing and Land Use Committee Meeting",
    event_date: "2026-09-23T18:30:00-04:00",
    source_url: CB14_SEPT23_URL,
    venue: {
      name: "Brooklyn CB14 District Office",
      address: "810 East 16th Street, Brooklyn, NY 11230",
      mode: "in-person",
    },
    location_assertions: [{
      schema: "cityscroll.meeting_location_assertion.v1",
      role: "venue",
      validity: "admitted_physical_venue",
      attendance_meaning: "in_person",
      original_address: "810 East 16th Street, Brooklyn, NY 11230",
      components: {
        street_address: "810 East 16th Street",
        address_locality: "Brooklyn",
        address_region: "NY",
        postal_code: "11230",
      },
      source_field: "location.address",
    }],
    affected_area: {
      scope: "local",
      boroughs: ["Brooklyn"],
      community_boards: ["brooklyn-cb-14"],
      community_districts: ["K14"],
      neighborhoods: [],
      addresses: [],
    },
    ...overrides,
  };
}

function venueMembership(recordId = CB14_SEPT23_ID) {
  return {
    record_id: recordId,
    assertion_id: `${recordId}#venue`,
    role: "venue",
    bbl: VENUE_PARCEL.bbl,
    point: { ...VENUE_PARCEL.point },
    memberships: { ...VENUE_PARCEL.memberships },
    provenance: {
      source_method: "admitted_venue_membership",
      parcel_bbl: VENUE_PARCEL.bbl,
    },
  };
}

/** Old exclusive board shortcut — must fail the dual-placement assertions. */
function legacyBoardOnlyPlacements(row, communityBoardGeographyDoc) {
  const boardId = row?.board_id || null;
  const boardDistrict = boardId === "brooklyn-cb-14" ? "K14" : null;
  if (!boardDistrict || !communityBoardGeographyDoc) return [];
  return [{
    borough: "Brooklyn",
    community: boardDistrict,
    council: null,
    method: "community_board_ontology",
    source_method: "board_covers_district",
    confidence: 1,
    confidence_tier: "strong",
  }];
}

test("A4 early-return regression: legacy board shortcut cannot satisfy dual placement", () => {
  const row = cb14September23Row();
  const legacy = legacyBoardOnlyPlacements(row, communityBoardGeography);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].source_method, "board_covers_district");
  assert.equal(
    legacy.some((slot) => slot.location_role === "venue" || slot.source_method === "admitted_venue_membership"),
    false,
    "legacy early-return must omit venue role evidence",
  );
});

test("A1 Sept 23 under Midwood via venue and K14 via venue + board, one row each", () => {
  const row = cb14September23Row();
  const memberships = [venueMembership()];
  const slots = meetingPlacementsFromRow(row, boundaries, {
    communityBoardGeography,
    recordLocationMemberships: memberships,
  });

  const boardSlots = slots.filter((slot) => slot.source_method === "board_covers_district");
  const venueSlots = slots.filter((slot) => slot.location_role === "venue");
  assert.equal(boardSlots.length, 1);
  assert.equal(boardSlots[0].community, "K14");
  assert.ok(venueSlots.length >= 1);
  assert.ok(venueSlots.some((slot) => slot.community === "K14" && slot.council === "45"));
  assert.ok(venueSlots.some((slot) => slot.nta2020 === "BK1403" || slot.point));

  const activity = buildDistrictActivity({
    boundaries,
    communityBoardGeography,
    geographyLayers,
    meetingsRows: [row],
    recordLocationMemberships: memberships,
    builtAt: "2026-09-24T12:00:00.000Z",
  });

  const k14Meetings = activity.district_items.by_level.community_district.K14.meetings;
  assert.deepEqual(k14Meetings, [CB14_SEPT23_ID]);

  const midwood = activity.geography_items.by_key["geography:nta2020:BK1403"];
  assert.ok(midwood, "Midwood NTA must index the meeting");
  assert.deepEqual(midwood.meetings, [CB14_SEPT23_ID]);

  const k14Edges = activity.geography_subjects.public_edges.filter((edge) =>
    edge.from.includes("housing-and-land-use-committee-meeting-september-2026")
      && edge.to === "community-district:K14");
  const roles = new Set(k14Edges.map((edge) => edge.location_role || edge.evidence?.location_role));
  assert.ok(roles.has("venue"), `K14 edges need venue role, got ${[...roles]}`);
  assert.ok(
    roles.has("subject_affected_area") || roles.has("host_jurisdiction") || roles.has("affected_area"),
    `K14 edges need board-jurisdiction role, got ${[...roles]}`,
  );
  assert.ok(
    k14Edges.some((edge) => edge.evidence?.source_method === "board_covers_district"),
    "board_covers_district evidence must remain on the K14 jurisdiction edge",
  );
});

test("A2 board route survives venue failure; NTA loses only unsupported venue membership", () => {
  const row = cb14September23Row();
  // Controlled case: board known, venue membership absent / unresolved.
  const slots = meetingPlacementsFromRow(row, boundaries, {
    communityBoardGeography,
    recordLocationMemberships: [],
  });
  assert.ok(slots.some((slot) => slot.community === "K14" && slot.source_method === "board_covers_district"));
  assert.equal(slots.some((slot) => slot.location_role === "venue"), false);

  const activity = buildDistrictActivity({
    boundaries,
    communityBoardGeography,
    geographyLayers,
    meetingsRows: [row],
    recordLocationMemberships: [],
    builtAt: "2026-09-24T12:00:00.000Z",
  });
  assert.ok(activity.district_items.by_level.community_district.K14.meetings.includes(CB14_SEPT23_ID));
  assert.equal(
    activity.geography_items.by_key["geography:nta2020:BK1403"]?.meetings?.includes(CB14_SEPT23_ID) || false,
    false,
    "unsupported venue must not invent Midwood membership",
  );
});

test("A3 virtual board meeting stays district-relevant without office-as-venue; council intersects stay non-venue", () => {
  const row = cb14September23Row({
    venue: {
      name: null,
      address: null,
      mode: "remote",
    },
    location_assertions: [{
      schema: "cityscroll.meeting_location_assertion.v1",
      role: "venue",
      validity: "unlocated",
      attendance_meaning: "remote",
      original_address: null,
      components: null,
      source_field: "location",
    }],
    description: "This meeting will be held via Zoom only.",
  });

  const slots = meetingPlacementsFromRow(row, boundaries, {
    communityBoardGeography,
    // Even if a stale office membership were offered, virtual attendance must not
    // promote the board office into a physical venue placement.
    recordLocationMemberships: [],
  });
  assert.ok(slots.some((slot) => slot.community === "K14" && slot.source_method === "board_covers_district"));
  assert.equal(slots.some((slot) => slot.location_role === "venue"), false);

  const activity = buildDistrictActivity({
    boundaries,
    communityBoardGeography,
    geographyLayers,
    meetingsRows: [row],
    recordLocationMemberships: [venueMembership()], // must not attach as venue when row is remote-only
    builtAt: "2026-09-24T12:00:00.000Z",
  });
  assert.ok(activity.district_items.by_level.community_district.K14.meetings.includes(CB14_SEPT23_ID));

  const councilEdges = activity.geography_subjects.public_edges.filter((edge) =>
    edge.from.includes("housing-and-land-use-committee-meeting-september-2026")
      && String(edge.to || "").startsWith("council-district:"));
  assert.ok(councilEdges.length >= 1, "legacy CD∩council compatibility remains");
  assert.ok(
    councilEdges.every((edge) => edge.location_role !== "venue"),
    "K14 council intersections must not claim the meeting venue is physically in every council district",
  );
  assert.ok(
    councilEdges.every((edge) => edge.evidence?.placement_method === "cd_intersects_council"
      || edge.evidence?.source_method === "board_covers_district"),
  );
});

test("record-location projection edges collapse into venue memberships for placement", () => {
  const row = cb14September23Row();
  const projection = {
    schema: "cityscroll.record_location_membership_projection.v1",
    edges: [
      {
        record_id: CB14_SEPT23_ID,
        assertion_id: `${CB14_SEPT23_ID}#venue`,
        role: "venue",
        bbl: VENUE_PARCEL.bbl,
        geography_key: "geography:nta2020:BK1403",
        geography_type: "nta2020",
        geography_id: "BK1403",
        point: { ...VENUE_PARCEL.point },
        provenance: { method: "accepted_exact_parcel_membership" },
        source_path: { source_field: "location.address" },
      },
      {
        record_id: CB14_SEPT23_ID,
        assertion_id: `${CB14_SEPT23_ID}#venue`,
        role: "venue",
        bbl: VENUE_PARCEL.bbl,
        geography_key: "geography:community_district:K14",
        geography_type: "community_district",
        geography_id: "K14",
        provenance: { method: "accepted_exact_parcel_membership" },
      },
      {
        record_id: CB14_SEPT23_ID,
        assertion_id: `${CB14_SEPT23_ID}#venue`,
        role: "venue",
        bbl: VENUE_PARCEL.bbl,
        geography_key: "geography:council_district:45",
        geography_type: "council_district",
        geography_id: "45",
        provenance: { method: "accepted_exact_parcel_membership" },
      },
    ],
  };
  const slots = meetingPlacementsFromRow(row, boundaries, {
    communityBoardGeography,
    recordLocationProjection: projection,
  });
  assert.ok(slots.some((slot) => slot.source_method === "board_covers_district" && slot.community === "K14"));
  assert.ok(slots.some((slot) =>
    slot.location_role === "venue"
      && slot.community === "K14"
      && slot.council === "45"
      && slot.nta2020 === "BK1403"));
});

test("A4 replay: exact place keys and separate role evidence through placements + activity index", () => {
  const row = cb14September23Row();
  const memberships = [venueMembership()];
  const slots = meetingPlacementsFromRow(row, boundaries, {
    communityBoardGeography,
    recordLocationMemberships: memberships,
  });
  assert.ok(slots.some((s) => s.source_method === "board_covers_district" && s.community === "K14"));
  assert.ok(slots.some((s) => s.location_role === "venue" && s.community === "K14" && s.council === "45"));

  const activity = buildDistrictActivity({
    boundaries,
    communityBoardGeography,
    geographyLayers,
    meetingsRows: [row],
    recordLocationMemberships: memberships,
    builtAt: "2026-09-24T12:00:00.000Z",
  });
  const placeKeys = new Set(
    (activity.records.meetings[CB14_SEPT23_ID]?.place?.geographies || []).map((g) => g.key),
  );
  assert.ok(placeKeys.has("geography:community_district:K14"));
  assert.ok(placeKeys.has("geography:nta2020:BK1403"));
  assert.ok(placeKeys.has("geography:council_district:45"));

  // Existing board-ontology smoke: Manhattan CB10 still places its district.
  const m10 = {
    meeting_id: "meeting:community_board:https://cbmanhattan.cityofnewyork.us/cb10/event/full-board/2026-09-02/",
    source_system: "community_board",
    board_id: "manhattan-cb-10",
    institution_refs: { board_ref: "community-board:manhattan-cb-10" },
    title: "Manhattan Community Board 10 full-board meeting",
    affected_area: {
      scope: "local",
      boroughs: [],
      community_districts: [],
      community_boards: [],
      addresses: [{ label: "209 Joralemon Street" }],
    },
  };
  const m10Slots = meetingPlacementsFromRow(m10, boundaries, { communityBoardGeography });
  assert.ok(m10Slots.some((s) => s.community === "M10" && s.source_method === "board_covers_district"));
  // Board office / unrelated address must not become a venue without admitted membership.
  assert.equal(m10Slots.some((s) => s.location_role === "venue"), false);
});
