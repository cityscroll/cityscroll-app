/**
 * Meeting-geography backfill acceptance (alias c7e099b2d5a3b).
 *
 * A1 process every pinned canonical id once and reconcile address-candidate
 * counts before validation. A2 Midwood September 23 venue membership +
 * idempotent replay. A3 date-shaped / remote-office / OATH exclusions and
 * atomic activation on failure. A4 retained-corpus replay with interrupt/
 * resume and an exact per-id outcome file.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";
import {
  BACKFILL_OUTCOME,
  activateMeetingGeographyBackfill,
  assertionsForGeographyRow,
  collectAddressCandidates,
  createMeetingGeographyBackfill,
  loadActiveMeetingGeographyBackfill,
  meetingGeographyInputHash,
  rowWithComposedVenue,
  stampMeetingRowsWithGeography,
} from "../site/meeting_geography_backfill.mjs";
import {
  LOCATION_ROLES,
  LOCATION_VALIDITY,
  buildMeetingLocationAssertions,
  isDateShapedVenueText,
} from "../site/meeting_location_assertions.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_PATH,
  lookupParcelMemberships,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import {
  createRecordAddressResolutionCache,
} from "../site/record_address_resolution_cache.mjs";
import {
  createRecordLocationMembershipProjection,
} from "../site/record_location_memberships.mjs";
import {
  buildLocalGeographyPublication,
  buildMeetings,
  residentialPlacesFromNtaLayer,
} from "../tools/build_worker_route_read_models.mjs";
import {
  summarizeCandidates,
} from "../tools/build_meeting_geography_backfill.mjs";
import {
  assertFrozenNeighborhoodBaseline,
  buildNeighborhoodPublicationReceipt,
  classifyAddressCandidateClass,
  FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE,
  NEIGHBORHOOD_PUBLICATION_ANCHORS,
  resolveNeighborhoodPublicationAnchorId,
} from "../tools/lib/neighborhood_publication_receipt.mjs";
import {
  buildDistrictActivity,
} from "../tools/lib/district_activity.mjs";
import { handleNearYou } from "../worker/src/near_you.mjs";
import { NEAR_YOU_MANIFEST_KEY } from "../worker/src/lib/route_read_model_kv.mjs";
import { readSharedMeetingReadModelDocument } from "../tools/lib/shared_meeting_read_model_io.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_MEETING_PATH = path.join(ROOT, "site/data/shared_meeting_read_model.json");
const COMMUNITY_BOARD_GEOGRAPHY_PATH = path.join(ROOT, "site/data/community_board_geography_lookup.json");
const ADDRESS_FIXTURE_DIR = path.join(ROOT, "test/fixtures/record_address_resolution_cache");
const PARCEL_DIR = path.join(ROOT, "site/data/parcel-geography");
const ADDRESS_DIR = path.join(ROOT, "site/data/address-index");

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadPadFixture() {
  const manifest = loadJson(path.join(ADDRESS_FIXTURE_DIR, "pad-manifest.json"));
  const shard = loadJson(path.join(ADDRESS_FIXTURE_DIR, "pad-street-subsets.json"));
  return {
    manifest,
    loadShard: () => shard,
  };
}

function loadRealParcelShard(shardKey) {
  return loadJson(path.join(PARCEL_DIR, `${shardKey}.json`));
}

function createFixtureRunner({ communityBoardGeography = null } = {}) {
  const { manifest, loadShard } = loadPadFixture();
  const parcelManifest = loadJson(path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH));
  const addressCache = createRecordAddressResolutionCache({ manifest, loadShard });
  const membershipProjection = createRecordLocationMembershipProjection({
    loadParcelShard: loadRealParcelShard,
    parcelMembershipGeneration: parcelManifest.membership?.generated_at
      || parcelManifest.coordinate_vintage
      || null,
  });
  return createMeetingGeographyBackfill({
    addressCache,
    membershipProjection,
    communityBoardGeography: communityBoardGeography
      || loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH),
    lookupParcelPoint: (bbl) => {
      const bundle = lookupParcelMemberships(loadRealParcelShard(parcelShardKey(bbl)), bbl);
      return bundle ? { lat: bundle.lat, lon: bundle.lon } : null;
    },
    now: () => "2026-09-24T12:00:00.000Z",
  });
}

function createProductionRunner() {
  const addressManifest = loadJson(path.join(ADDRESS_DIR, "manifest.json"));
  const parcelManifest = loadJson(path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH));
  const shardCache = new Map();
  const loadAddressShard = (key) => {
    if (shardCache.has(`a:${key}`)) return shardCache.get(`a:${key}`);
    const filePath = path.join(ADDRESS_DIR, `${key}.json`);
    const doc = existsSync(filePath) ? loadJson(filePath) : null;
    shardCache.set(`a:${key}`, doc);
    return doc;
  };
  const loadParcelShard = (key) => {
    if (shardCache.has(`p:${key}`)) return shardCache.get(`p:${key}`);
    const filePath = path.join(PARCEL_DIR, `${key}.json`);
    const doc = existsSync(filePath) ? loadJson(filePath) : null;
    shardCache.set(`p:${key}`, doc);
    return doc;
  };
  const addressCache = createRecordAddressResolutionCache({
    manifest: addressManifest,
    loadShard: loadAddressShard,
  });
  const membershipProjection = createRecordLocationMembershipProjection({
    loadParcelShard,
    parcelMembershipGeneration: parcelManifest.membership?.generated_at
      || parcelManifest.coordinate_vintage
      || null,
  });
  return createMeetingGeographyBackfill({
    addressCache,
    membershipProjection,
    communityBoardGeography: loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH),
    lookupParcelPoint: (bbl) => {
      const bundle = lookupParcelMemberships(loadParcelShard(parcelShardKey(bbl)), bbl);
      return bundle ? { lat: bundle.lat, lon: bundle.lon } : null;
    },
    now: () => "2026-09-24T12:00:00.000Z",
  });
}

function sept23Row() {
  return {
    meeting_id: SEPT23_ID,
    source_system: "community_board",
    meeting_origin: "community_board_source_observed",
    board_id: "brooklyn-cb-14",
    title: "Housing and Land Use Committee Meeting",
    event_date: "2026-09-23T18:30:00-04:00",
    venue: {
      name: "Brooklyn CB14 District Office",
      address: "810 East 16th Street, Brooklyn, NY 11230",
      mode: "in-person",
      components: {
        street_address: "810 East 16th Street",
        address_locality: "Brooklyn",
        address_region: "NY",
        postal_code: "11230",
      },
    },
  };
}

function dateShapedRow() {
  return {
    meeting_id: "meeting:community_board:example:october-20-date-shaped",
    source_system: "community_board",
    board_id: "queens-cb-01",
    title: "Full Board Public Hearing Meetings",
    event_date: "2026-10-20T18:30:00-04:00",
    venue: {
      name: null,
      address: "October 20",
      mode: "not-stated",
    },
  };
}

function remoteOfficeConflictRow() {
  return {
    meeting_id: "meeting:community_board:example:remote-office-conflict",
    source_system: "community_board",
    board_id: "brooklyn-cb-14",
    title: "Virtual committee with office line",
    event_date: "2026-09-30T18:30:00-04:00",
    venue: {
      name: "Brooklyn CB14 District Office",
      address: "810 East 16th Street, Brooklyn, NY 11230",
      mode: "virtual",
    },
    description: "Meeting via video conference",
  };
}

function oathRow(index = 1) {
  return {
    meeting_id: `meeting:oath_trial_calendar:example-${index}`,
    source_system: "oath_trial_calendar",
    meeting_origin: "official_oath_trial_calendar",
    title: `OATH Trial ${index}`,
    event_date: "2026-09-24T09:00:00-04:00",
    venue: null,
  };
}

test("A1 [G1] pinned corpus processes once; address candidates reconcile before validation", () => {
  const shared = readSharedMeetingReadModelDocument(SHARED_MEETING_PATH);
  const rows = shared.rows || [];
  // Regression caught: backfill population does not fall below retained floor.
  assert.ok(rows.length >= 780, `expected at least 780 rows, got ${rows.length}`);

  const candidateSummary = summarizeCandidates(rows);
  assert.equal(candidateSummary.canonical_meeting_count, rows.length);
  assert.ok(candidateSummary.address_bearing_rows >= 250, "address-bearing floor");
  assert.ok(candidateSummary.distinct_address_strings >= 60, "distinct address floor");
  // The card's 312/84 figures describe raw candidate input before validation —
  // recompute from the pinned corpus rather than inventing addresses.
  assert.equal(
    candidateSummary.address_bearing_rows,
    rows.filter((row) => collectAddressCandidates(row).length > 0).length,
  );
  const distinct = new Set();
  for (const row of rows) {
    for (const candidate of collectAddressCandidates(row)) distinct.add(candidate.value);
  }
  assert.equal(candidateSummary.distinct_address_strings, distinct.size);

  const runner = createProductionRunner();
  const first = runner.run({
    rows,
    generation: "test-a1-full",
    sourceGenerationHash: "test-a1",
    observedAt: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(first.counts.processed_rows, rows.length);
  assert.equal(first.counts.input_rows, rows.length);
  assert.equal(first.counts.newly_processed, rows.length);
  assert.equal(first.counts.address_bearing_rows, candidateSummary.address_bearing_rows);
  assert.equal(first.counts.distinct_address_strings, candidateSummary.distinct_address_strings);

  const ids = first.outcomes.map((outcome) => outcome.meeting_id);
  assert.equal(new Set(ids).size, ids.length, "each canonical id processed once");
  for (const outcome of first.outcomes) {
    assert.ok(Object.values(BACKFILL_OUTCOME).includes(outcome.outcome));
  }
});

test("A2 [G1] September 23 lands in BK1403 venue membership; replay is idempotent", () => {
  withTempDirSync("meeting-geography-backfill-a2-", (dir) => {
    const runner = createFixtureRunner();
    const rows = [
      sept23Row(),
      dateShapedRow(),
      oathRow(1),
    ];
    const generation = "test-a2-midwood";
    const first = runner.run({
      rows,
      generation,
      sourceGenerationHash: "a2",
      observedAt: "2026-09-24T12:00:00.000Z",
    });

    const sept23 = first.outcomes.find((outcome) => outcome.meeting_id === SEPT23_ID);
    assert.ok(sept23);
    assert.equal(sept23.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
    const venue = sept23.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
    assert.ok(venue, "expected venue membership");
    assert.equal(venue.memberships.nta2020, "BK1403");
    assert.equal(venue.memberships.community_district, "K14");
    assert.equal(venue.memberships.council_district, "45");
    assert.equal(venue.bbl, "3066990010");

    const stamped = stampMeetingRowsWithGeography(rows, first.outcomes);
    const outcomesDocument = {
      schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
      generation,
      outcomes: first.outcomes,
      positive_record: { meeting_id: SEPT23_ID, expected_nta2020: "BK1403" },
    };
    const activation = activateMeetingGeographyBackfill({
      publicDir: dir,
      generation,
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation,
        built_at: "2026-09-24T12:00:00.000Z",
        counts: first.counts,
      },
      outcomesDocument,
      projectionDocument: first.projection,
      stampedSharedMeetingModel: {
        schema: "cityscroll.shared_meeting_read_model.v1",
        rows: stamped,
      },
      sharedMeetingReadModelPath: path.join(dir, "shared_meeting_read_model.json"),
    });
    assert.equal(activation.activated, true);

    // Replay with the same input hashes must not duplicate identities or memberships.
    const secondRunner = createFixtureRunner();
    const second = secondRunner.run({
      rows: stamped,
      generation,
      sourceGenerationHash: "a2",
      checkpoint: first.checkpoint,
      observedAt: "2026-09-24T13:00:00.000Z",
    });
    assert.equal(second.counts.newly_processed, 0);
    assert.equal(second.counts.processed_rows, first.counts.processed_rows);

    const replaySept23 = second.outcomes.find((outcome) => outcome.meeting_id === SEPT23_ID);
    assert.deepEqual(
      (replaySept23.memberships || []).map((membership) => ({
        role: membership.role,
        bbl: membership.bbl,
        memberships: membership.memberships,
      })),
      (sept23.memberships || []).map((membership) => ({
        role: membership.role,
        bbl: membership.bbl,
        memberships: membership.memberships,
      })),
    );

    const active = loadActiveMeetingGeographyBackfill(dir);
    assert.equal(active.pointer.active_generation, generation);
    const published = buildMeetings({
      schema: "cityscroll.shared_meeting_read_model.v1",
      rows: stamped,
    }, "test-slice");
    const sliceEntry = published.entries.find((entry) => entry.key.includes("2026-09"));
    assert.ok(sliceEntry);
    const slice = JSON.parse(sliceEntry.value);
    const sliceRow = slice.rows.find((row) => row.meeting_id === SEPT23_ID);
    assert.ok(sliceRow?.location_memberships?.some((membership) => (
      membership.role === "venue" && membership.memberships?.nta2020 === "BK1403"
    )), "published meeting slice retains Midwood venue membership");
  });
});

test("A3 [boundary] date-shaped and remote-office stay non-physical; OATH unlocated; failure keeps old generation", () => {
  assert.equal(isDateShapedVenueText("October 20"), true);

  const runner = createFixtureRunner();
  const oathRows = Array.from({ length: 5 }, (_, index) => oathRow(index + 1));
  const rows = [dateShapedRow(), remoteOfficeConflictRow(), ...oathRows, sept23Row()];
  const result = runner.run({
    rows,
    generation: "test-a3-boundary",
    sourceGenerationHash: "a3",
  });

  const dateShaped = result.outcomes.find((outcome) => outcome.meeting_id === dateShapedRow().meeting_id);
  assert.equal(dateShaped.outcome, BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE);
  assert.equal(
    (dateShaped.memberships || []).some((membership) => membership.role === "venue" && membership.bbl),
    false,
  );

  const remote = result.outcomes.find((outcome) => outcome.meeting_id === remoteOfficeConflictRow().meeting_id);
  assert.ok([BACKFILL_OUTCOME.VIRTUAL, BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE].includes(remote.outcome));
  assert.equal(
    (remote.memberships || []).some((membership) => membership.role === "venue" && membership.bbl),
    false,
  );

  for (const oath of oathRows) {
    const outcome = result.outcomes.find((row) => row.meeting_id === oath.meeting_id);
    assert.equal(outcome.outcome, BACKFILL_OUTCOME.NO_SOURCE_ADDRESS);
    assert.equal((outcome.memberships || []).filter((membership) => membership.bbl).length, 0);
  }

  withTempDirSync("meeting-geography-backfill-a3-", (dir) => {
    const generationOld = "gen-old-active";
    activateMeetingGeographyBackfill({
      publicDir: dir,
      generation: generationOld,
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation: generationOld,
        built_at: "2026-09-24T11:00:00.000Z",
      },
      outcomesDocument: {
        schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
        generation: generationOld,
        built_at: "2026-09-24T11:00:00.000Z",
        outcomes: [],
      },
    });
    const before = loadActiveMeetingGeographyBackfill(dir);
    assert.equal(before.pointer.active_generation, generationOld);

    assert.throws(() => activateMeetingGeographyBackfill({
      publicDir: dir,
      generation: "gen-new-failed",
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation: "gen-new-failed",
        built_at: "2026-09-24T12:00:00.000Z",
      },
      outcomesDocument: {
        schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
        generation: "gen-new-failed",
        built_at: "2026-09-24T12:00:00.000Z",
        outcomes: result.outcomes,
      },
      failBeforeActivate: true,
    }), /forced failure before activation/);

    const after = loadActiveMeetingGeographyBackfill(dir);
    assert.equal(after.pointer.active_generation, generationOld);
    assert.equal(existsSync(path.join(dir, ".staging")), false);
    assert.equal(existsSync(path.join(dir, "gen-new-failed")), false);
  });
});

test("A4 [verification] retained-corpus interrupt/resume and exact per-id outcome file", () => {
  withTempDirSync("meeting-geography-backfill-a4-", (dir) => {
    const shared = readSharedMeetingReadModelDocument(SHARED_MEETING_PATH);
    const sharedCopyPath = path.join(dir, "shared_meeting_read_model.json");
    writeFileSync(sharedCopyPath, JSON.stringify(shared));
    const publicDir = path.join(dir, "meeting-geography-backfill");
    mkdirSync(publicDir, { recursive: true });

    const runner = createProductionRunner();
    const generation = "test-a4-retained";
    let checkpoint = null;
    try {
      runner.run({
        rows: shared.rows,
        generation,
        sourceGenerationHash: "a4",
        interruptAfter: 25,
        onCheckpoint: (state) => {
          checkpoint = state;
          writeFileSync(path.join(publicDir, "checkpoint.json"), JSON.stringify(state));
        },
      });
      assert.fail("expected interrupt");
    } catch (error) {
      assert.equal(error.code, "MEETING_GEOGRAPHY_BACKFILL_INTERRUPTED");
      checkpoint = error.checkpoint;
    }
    assert.ok(checkpoint);
    assert.equal(checkpoint.completed, false);
    assert.ok(Object.keys(checkpoint.processed).length >= 25);

    // Resume completes the corpus without redoing unchanged hashes.
    const resumedRunner = createProductionRunner();
    const completed = resumedRunner.run({
      rows: shared.rows,
      generation,
      sourceGenerationHash: "a4",
      checkpoint,
      observedAt: "2026-09-24T12:30:00.000Z",
    });
    assert.equal(completed.checkpoint.completed, true);
    assert.equal(completed.counts.processed_rows, shared.rows.length);
    assert.ok(completed.counts.newly_processed < shared.rows.length);
    assert.ok(completed.counts.resumed_unchanged >= 25);

    const stamped = stampMeetingRowsWithGeography(shared.rows, completed.outcomes);
    const outcomesDocument = {
      schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
      generation,
      built_at: "2026-09-24T12:30:00.000Z",
      candidate_input: summarizeCandidates(shared.rows),
      counts: completed.counts,
      positive_record: {
        meeting_id: SEPT23_ID,
        expected_nta2020: "BK1403",
        expected_role: "venue",
      },
      outcomes: completed.outcomes,
    };
    activateMeetingGeographyBackfill({
      publicDir,
      generation,
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation,
        built_at: "2026-09-24T12:30:00.000Z",
        counts: completed.counts,
        candidate_input: outcomesDocument.candidate_input,
        positive_record: outcomesDocument.positive_record,
      },
      outcomesDocument,
      projectionDocument: completed.projection,
      stampedSharedMeetingModel: { ...shared, rows: stamped },
      sharedMeetingReadModelPath: sharedCopyPath,
    });

    const active = loadActiveMeetingGeographyBackfill(publicDir);
    assert.ok(active.outcomes);
    assert.equal(active.outcomes.outcomes.length, shared.rows.length);
    assert.equal(existsSync(path.join(publicDir, "per-id-outcomes.json")), true);

    const sept23 = active.outcomes.outcomes.find((outcome) => outcome.meeting_id === SEPT23_ID);
    assert.ok(sept23, "named positive record retained");
    const venue = (sept23.memberships || []).find((membership) => membership.role === "venue");
    assert.equal(venue?.memberships?.nta2020, "BK1403");

    const stampedShared = readSharedMeetingReadModelDocument(sharedCopyPath);
    const stampedRow = stampedShared.rows.find((row) => row.meeting_id === SEPT23_ID);
    assert.ok(stampedRow.location_memberships.some((membership) => (
      membership.role === "venue" && membership.memberships?.nta2020 === "BK1403"
    )));

    // OATH location-free population is not guessed onto the map.
    const oathOutcomes = completed.outcomes.filter((outcome) => {
      const row = shared.rows.find((candidate) => candidate.meeting_id === outcome.meeting_id);
      return row?.source_system === "oath_trial_calendar";
    });
    assert.ok(oathOutcomes.length >= 140);
    assert.equal(
      oathOutcomes.filter((outcome) => outcome.outcome === BACKFILL_OUTCOME.PHYSICAL_VENUE).length,
      0,
    );
    assert.ok(oathOutcomes.every((outcome) => outcome.outcome === BACKFILL_OUTCOME.NO_SOURCE_ADDRESS));
  });
});

test("A5 [G1/G2] named-building venues resolve to exact venue membership through the real PAD and parcel shards", () => {
  const KINGSBOROUGH =
    "Kingsborough Community College, 2001 Oriental Boulevard, Room U112 Faculty Dining Room, Brooklyn, NY 11235";
  const SEPT29_ID =
    "meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person";
  const JUNE30_ID =
    "meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-06-30:general-board-meeting-in-person";
  const LEGISTAR_ID = "meeting:nyc_legistar_events:22627";

  const cb15Row = (meetingId, address = KINGSBOROUGH, mode = "in-person") => ({
    meeting_id: meetingId,
    source_system: "community_board",
    meeting_origin: "community_board_source_observed",
    board_id: "brooklyn-cb-15",
    title: "General Board Meeting (In Person)",
    event_date: "2026-09-29T19:00:00-04:00",
    venue: { name: "Kingsborough Community College", address, mode },
  });

  const rows = [
    cb15Row(SEPT29_ID),
    cb15Row(JUNE30_ID),
    {
      meeting_id: LEGISTAR_ID,
      source_system: "nyc_legistar_events",
      title: "Committee on Public Safety",
      event_date: "2026-09-28T10:00:00-04:00",
      venue: {
        name: "The New York Public Library",
        address: "The New York Public Library at 515 Malcolm X Boulevard, New York, NY 10037 (135th Street and Malcolm X Boulevard)",
        mode: "in-person",
      },
    },
    cb15Row("meeting:community_board:example:cb15-intersection-only",
      "135th Street and Malcolm X Boulevard"),
    cb15Row("meeting:community_board:example:cb15-dropdown-placeholder",
      "Kingsborough Community College, Address Not Listed In The Dropdown, Brooklyn, NY 11235"),
    cb15Row("meeting:community_board:example:cb15-competing-spans",
      "VFW Hall, 461 and 463 Coney Island Avenue, Brooklyn, NY 11218"),
    cb15Row("meeting:community_board:example:cb15-virtual-only", KINGSBOROUGH, "virtual"),
  ];

  const runner = createProductionRunner();
  const result = runner.run({
    rows,
    generation: "test-a5-venue-span",
    sourceGenerationHash: "a5",
    observedAt: "2026-09-24T12:00:00.000Z",
  });

  // A1: the frozen CB15 September 29 wording yields an exact parcel-backed
  // venue edge; original wording and host district remain distinct.
  const sept29 = result.outcomes.find((outcome) => outcome.meeting_id === SEPT29_ID);
  assert.equal(sept29.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const venue = sept29.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.ok(venue, "expected venue membership");
  assert.equal(venue.bbl, "3087600060");
  assert.equal(venue.memberships.nta2020, "BK1503");
  assert.equal(venue.memberships.community_district, "K15");
  const host = sept29.memberships.find((membership) => membership.role === LOCATION_ROLES.HOST_JURISDICTION);
  assert.ok(host, "host district activity remains");
  assert.equal(host.memberships.community_district, "K15");
  assert.equal(host.bbl, null);
  const venueAssertion = sept29.assertions.find((assertion) => assertion.role === LOCATION_ROLES.VENUE);
  assert.equal(venueAssertion.original_address, KINGSBOROUGH);
  assert.equal(venueAssertion.source_field, "venue.address");

  // A2: June 30 replay shares the one normalized cache entry (one resolver
  // call for both) while keeping separate assertion provenance.
  const june30 = result.outcomes.find((outcome) => outcome.meeting_id === JUNE30_ID);
  assert.equal(june30.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const juneVenue = june30.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.equal(juneVenue.bbl, "3087600060");
  assert.equal(juneVenue.memberships.nta2020, "BK1503");
  const venueLinks = runner.addressCache.assertionLinks()
    .filter((link) => link.bbl === "3087600060" && link.role === LOCATION_ROLES.VENUE);
  // Regression caught: both meetings share one normalized cache entry.
  assert.ok(venueLinks.length >= 2, "June 30 and Sept 29 both keep venue assertion links");
  assert.deepEqual(
    venueLinks.map((link) => link.meeting_id).sort(),
    [JUNE30_ID, SEPT29_ID].sort(),
  );
  assert.ok(
    venueLinks.every((link) => link.cache_key === venueLinks[0].cache_key),
    "shared Kingsborough venue reuses one cache key",
  );
  // One resolver call for the shared Kingsborough key, one for the distinct
  // Malcolm X Boulevard key; every boundary row failed before resolution.
  assert.equal(runner.addressCache.resolveCallCount(), 2);

  // A2: the non-board named-building source gives a typed unresolved result
  // (PAD has no MALCOLM X BLVD street record) — never a fuzzy alias, and no
  // NTA inferred from the institution name.
  const legistar = result.outcomes.find((outcome) => outcome.meeting_id === LEGISTAR_ID);
  assert.equal(legistar.outcome, BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE);
  assert.equal(
    legistar.memberships.some((membership) => membership.bbl
      || Object.keys(membership.memberships || {}).length > 0),
    false,
  );

  // A3: intersection-only, dropdown placeholder, competing spans, and
  // virtual-only rows create no new venue NTA.
  for (const id of [
    "meeting:community_board:example:cb15-intersection-only",
    "meeting:community_board:example:cb15-dropdown-placeholder",
    "meeting:community_board:example:cb15-competing-spans",
    "meeting:community_board:example:cb15-virtual-only",
  ]) {
    const outcome = result.outcomes.find((candidate) => candidate.meeting_id === id);
    assert.ok(outcome, `expected outcome for ${id}`);
    assert.notEqual(outcome.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE, id);
    assert.equal(
      outcome.memberships.some((membership) => membership.role === LOCATION_ROLES.VENUE
        && (membership.bbl || Object.keys(membership.memberships || {}).length > 0)),
      false,
      `${id} must not create a venue NTA`,
    );
  }

  // A4: a changed source address cannot retain the old NTA — the input-hash
  // checkpoint reprocesses the row and the projection drops the prior edge.
  const changed = runner.run({
    rows: [cb15Row(SEPT29_ID, "Kingsborough Community College, Address Not Listed In The Dropdown, Brooklyn, NY 11235")],
    generation: "test-a5-venue-span",
    sourceGenerationHash: "a5",
    checkpoint: result.checkpoint,
    observedAt: "2026-09-24T12:30:00.000Z",
  });
  assert.equal(changed.counts.newly_processed, 1);
  const relocated = changed.outcomes.find((outcome) => outcome.meeting_id === SEPT29_ID);
  assert.notEqual(relocated.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  assert.equal(
    relocated.memberships.some((membership) => membership.role === LOCATION_ROLES.VENUE
      && (membership.bbl || Object.keys(membership.memberships || {}).length > 0)),
    false,
  );
  const projectionEdges = changed.projection.edges || [];
  assert.equal(
    projectionEdges.some((edge) => edge.record_id === SEPT29_ID
      && edge.role === LOCATION_ROLES.VENUE && edge.bbl),
    false,
    "failed re-resolution removes the prior venue edge",
  );
});

test("input hash reuse skips unchanged meetings across resume", () => {
  const runner = createFixtureRunner();
  const row = sept23Row();
  const hash = meetingGeographyInputHash(row);
  const first = runner.processMeetingRow(row);
  assert.equal(first.input_hash, hash);
  assert.equal(first.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);

  const assertions = buildMeetingLocationAssertions(dateShapedRow());
  assert.equal(assertions[0].validity, LOCATION_VALIDITY.REJECTED_DATE_SHAPED);
});

test("publish-slim subject-only assertions still recover venue membership from venue.address", () => {
  const SEPT14_ID =
    "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
  const row = {
    meeting_id: SEPT14_ID,
    source_system: "community_board",
    meeting_origin: "community_board_source_observed",
    board_id: "brooklyn-cb-14",
    title: "September 2026 Board Meeting",
    event_date: "2026-09-14T19:00:00-04:00",
    venue: {
      name: "East Midwood Jewish Center",
      address: "1625 Ocean Avenue, Brooklyn, NY 11230",
      mode: "in-person",
      components: {
        street_address: "1625 Ocean Avenue",
        address_locality: "Brooklyn",
        address_region: "New York",
        postal_code: "11230",
      },
    },
    // Publish slim retains subject_property and drops venue assertions.
    location_assertions: [{
      schema: "cityscroll.meeting_location_assertion.v1",
      assertion_id: `${SEPT14_ID}::subject_property::description::2`,
      meeting_id: SEPT14_ID,
      role: LOCATION_ROLES.SUBJECT_PROPERTY,
      validity: LOCATION_VALIDITY.ADMITTED_SUBJECT_PROPERTY,
      original_address: "461 Coney Island Avenue",
      source_field: "description",
    }],
  };

  const merged = assertionsForGeographyRow(row);
  assert.equal(merged.some((assertion) => assertion.role === LOCATION_ROLES.VENUE), true);
  assert.equal(merged.some((assertion) => assertion.role === LOCATION_ROLES.SUBJECT_PROPERTY), true);

  const runner = createProductionRunner();
  const result = runner.run({
    rows: [row],
    generation: "test-slim-venue-merge",
    sourceGenerationHash: "slim-venue-merge",
    observedAt: "2026-10-05T20:00:00.000Z",
  });
  const outcome = result.outcomes.find((entry) => entry.meeting_id === SEPT14_ID);
  assert.equal(outcome.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const venue = outcome.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.ok(venue);
  assert.equal(venue.memberships.nta2020, "BK1403");
  assert.equal(venue.bbl, "3076200025");
});

test("subject assertion with inherited venue ZIP still resolves when PAD zip differs", () => {
  const SEPT14_ID =
    "meeting:community_board:https://cb14brooklyn.com/meeting/september-2026-board-meeting/";
  const row = {
    meeting_id: SEPT14_ID,
    source_system: "community_board",
    meeting_origin: "community_board_source_observed",
    board_id: "brooklyn-cb-14",
    title: "September 2026 Board Meeting",
    event_date: "2026-09-14T19:00:00-04:00",
    venue: {
      name: "East Midwood Jewish Center",
      address: "1625 Ocean Avenue, Brooklyn, NY 11230",
      mode: "in-person",
    },
    location_assertions: [{
      schema: "cityscroll.meeting_location_assertion.v1",
      assertion_id: `${SEPT14_ID}::subject_property::description::2`,
      meeting_id: SEPT14_ID,
      role: LOCATION_ROLES.SUBJECT_PROPERTY,
      validity: LOCATION_VALIDITY.ADMITTED_SUBJECT_PROPERTY,
      original_address: "461 Coney Island Avenue",
      // Venue Midwood ZIP incorrectly stamped onto the subject assertion.
      components: {
        street_address: "461 Coney Island Avenue",
        address_locality: "Brooklyn",
        address_region: "New York",
        postal_code: "11230",
        address_borough: "Brooklyn",
      },
      source_field: "description",
    }],
  };

  const runner = createProductionRunner();
  const result = runner.run({
    rows: [row],
    generation: "test-subject-zip-retry",
    sourceGenerationHash: "subject-zip-retry",
    observedAt: "2026-10-05T20:00:00.000Z",
  });
  const outcome = result.outcomes.find((entry) => entry.meeting_id === SEPT14_ID);
  assert.equal(outcome.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const subject = outcome.memberships.find(
    (membership) => membership.role === LOCATION_ROLES.SUBJECT_PROPERTY,
  );
  assert.ok(subject, "subject membership must survive inherited venue ZIP");
  assert.equal(subject.bbl, "3050700035");
  assert.equal(subject.memberships.nta2020, "BK1402");
  const venue = outcome.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.equal(venue.memberships.nta2020, "BK1403");
});

test("City Record notice street fields recover venue when residual rows omit venue", () => {
  const WORTH_ID = "meeting:city_record:20260106034";
  const row = {
    meeting_id: WORTH_ID,
    source_system: "city_record",
    title: "Board of Correction Public Meeting",
    event_date: "2026-09-09T13:00:00.000",
    venue: null,
    street_address_1: "125 Worth Street",
    street_address_2: "2nd Floor Auditorium",
    city: "New York",
    state: "NY",
    zip_code: "10013",
  };
  const composed = rowWithComposedVenue(row);
  assert.match(composed.venue.address, /125 Worth Street/);
  assert.equal(
    collectAddressCandidates(row).some((candidate) => /125 Worth Street/.test(candidate.value)),
    true,
  );

  const runner = createProductionRunner();
  const result = runner.run({
    rows: [row],
    generation: "test-notice-street-venue",
    sourceGenerationHash: "notice-street-venue",
    observedAt: "2026-10-05T20:00:00.000Z",
  });
  const outcome = result.outcomes.find((entry) => entry.meeting_id === WORTH_ID);
  assert.equal(outcome.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const venue = outcome.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.equal(venue.bbl, "1001680032");
  assert.equal(venue.memberships.nta2020, "MN0102");

  const stamped = stampMeetingRowsWithGeography([row], result.outcomes)[0];
  assert.match(stamped.venue?.address || "", /125 Worth Street/);
});

test("locality and unit suffixes resolve through production PAD and parcel shards", () => {
  const FOREST_HILLS_ID =
    "meeting:community_board:0pue8uab456hejvloi8sikfpke@google.com::2026-09-08";
  const WORTH_ID = "meeting:city_record:20260106034";
  const FOREST_HILLS_ADDRESS =
    "104-01 Metropolitan Ave, Forest Hills, NY 11375, USA";
  const WORTH_ADDRESS =
    "125 Worth Street, 2nd Floor Auditorium, New York, NY, 10013";

  const rows = [
    {
      meeting_id: FOREST_HILLS_ID,
      source_system: "community_board",
      meeting_origin: "community_board_source_observed",
      board_id: "queens-cb-06",
      title: "Community Board 6 Public Meeting",
      event_date: "2026-09-08T19:00:00-04:00",
      venue: {
        name: null,
        address: FOREST_HILLS_ADDRESS,
        mode: "in-person",
      },
    },
    {
      meeting_id: WORTH_ID,
      source_system: "city_record",
      title: "Board of Health",
      event_date: "2026-01-06T10:00:00-05:00",
      venue: {
        name: null,
        address: WORTH_ADDRESS,
        mode: "in-person",
      },
    },
    {
      meeting_id: "meeting:example:flushing-conflict",
      source_system: "community_board",
      board_id: "queens-cb-06",
      title: "Contradictory locality control",
      event_date: "2026-09-08T19:00:00-04:00",
      venue: {
        name: null,
        address: "104-01 Metropolitan Ave, Flushing, NY 11375, USA",
        mode: "in-person",
      },
    },
  ];

  const runner = createProductionRunner();
  const result = runner.run({
    rows,
    generation: "test-locality-unit",
    sourceGenerationHash: "locality-unit",
    observedAt: "2026-09-29T12:00:00.000Z",
  });

  const forest = result.outcomes.find((outcome) => outcome.meeting_id === FOREST_HILLS_ID);
  assert.equal(forest.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const forestVenue = forest.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.ok(forestVenue);
  assert.equal(forestVenue.bbl, "4032400041");
  assert.equal(forestVenue.memberships.nta2020, "QN0602");
  assert.equal(forestVenue.memberships.community_district, "Q06");
  assert.equal(
    forest.assertions.find((assertion) => assertion.role === LOCATION_ROLES.VENUE).original_address,
    FOREST_HILLS_ADDRESS,
  );

  const worth = result.outcomes.find((outcome) => outcome.meeting_id === WORTH_ID);
  assert.equal(worth.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const worthVenue = worth.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.ok(worthVenue);
  assert.equal(worthVenue.bbl, "1001680032");
  assert.equal(worthVenue.memberships.nta2020, "MN0102");
  assert.equal(worthVenue.memberships.community_district, "M01");

  const flushing = result.outcomes.find(
    (outcome) => outcome.meeting_id === "meeting:example:flushing-conflict",
  );
  assert.notEqual(flushing.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  assert.equal(
    flushing.memberships.some((membership) => membership.role === LOCATION_ROLES.VENUE
      && (membership.bbl || Object.keys(membership.memberships || {}).length > 0)),
    false,
  );

  // A4: frozen physical-venue and virtual role/ID sets from the pre-recovery
  // baseline stay unchanged under the locality/unit parse. Live corpus counts
  // may grow after neighborhood publication; the frozen ID lists are the control
  // (same isolation intent as the locality-unit retained fixture on main).
  const frozenIds = loadJson(
    path.join(ROOT, "site/data/meeting-geography-backfill/frozen-baseline-ids.json"),
  );
  assert.equal(
    frozenIds.physical_venue_meeting_ids.length,
    FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.by_outcome.physical_venue,
  );
  assert.equal(
    frozenIds.virtual_meeting_ids.length,
    FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.by_outcome.virtual,
  );

  const shared = readSharedMeetingReadModelDocument(SHARED_MEETING_PATH);
  const retainedIds = new Set([
    ...frozenIds.physical_venue_meeting_ids,
    ...frozenIds.virtual_meeting_ids,
  ]);
  const replayRows = shared.rows.filter((row) => retainedIds.has(row.meeting_id));
  assert.equal(
    replayRows.length,
    FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.by_outcome.physical_venue
      + FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.by_outcome.virtual,
  );

  const replay = createProductionRunner().run({
    rows: replayRows,
    generation: "test-locality-unit-parity",
    sourceGenerationHash: "locality-unit-parity",
    observedAt: "2026-09-29T12:30:00.000Z",
  });
  const byId = new Map(replay.outcomes.map((row) => [row.meeting_id, row]));
  for (const meetingId of frozenIds.physical_venue_meeting_ids) {
    const next = byId.get(meetingId);
    assert.ok(next, meetingId);
    assert.equal(next.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE, meetingId);
  }
  for (const meetingId of frozenIds.virtual_meeting_ids) {
    const next = byId.get(meetingId);
    assert.ok(next, meetingId);
    assert.equal(next.outcome, BACKFILL_OUTCOME.VIRTUAL, meetingId);
  }
});

const BOUNDARIES = loadJson(path.join(ROOT, "site/data/district_boundaries.json"));
const GEOGRAPHY_LAYERS = [
  loadJson(path.join(ROOT, "site/data/geography/layers/nta2020/26B.json")),
];
const RESIDENTIAL_PLACES = residentialPlacesFromNtaLayer(GEOGRAPHY_LAYERS[0]);

function sharedRow(meetingId) {
  const shared = readSharedMeetingReadModelDocument(SHARED_MEETING_PATH);
  const row = shared.rows.find((candidate) => candidate.meeting_id === meetingId);
  assert.ok(row, `missing shared row ${meetingId}`);
  return structuredClone(row);
}

function publicationKv(publication) {
  const values = new Map();
  for (const entry of publication.nearYou.entries) values.set(entry.key, entry.value);
  for (const entry of publication.meetings.entries) values.set(entry.key, entry.value);
  values.set(NEAR_YOU_MANIFEST_KEY, JSON.stringify(publication.nearYou.manifest));
  return {
    async get(key) {
      return values.get(key) || null;
    },
  };
}

test("neighborhood publication A1/A2 [outcome] recovered venues publish into exact NTA lists and keep host districts", async () => {
  const anchors = NEIGHBORHOOD_PUBLICATION_ANCHORS;
  const sharedCorpus = readSharedMeetingReadModelDocument(SHARED_MEETING_PATH);
  const forestHillsId = resolveNeighborhoodPublicationAnchorId(
    anchors.forest_hills,
    sharedCorpus.rows,
  );
  assert.ok(forestHillsId, "Forest Hills anchor must resolve from shared corpus");
  const rows = [
    sharedRow(anchors.cb15_sept29.meeting_id),
    sharedRow(forestHillsId),
    sharedRow(anchors.worth_street.meeting_id),
  ];
  // Drop any previously stamped memberships so publication depends on this run.
  for (const row of rows) {
    delete row.location_memberships;
    delete row.geography_backfill;
  }

  const runner = createProductionRunner();
  const result = runner.run({
    rows,
    generation: "test-mn03-publication",
    sourceGenerationHash: "mn03-publication",
    observedAt: "2026-09-30T18:00:00.000Z",
  });

  const sept29 = result.outcomes.find((row) => row.meeting_id === anchors.cb15_sept29.meeting_id);
  assert.equal(sept29.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  const septVenue = sept29.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE);
  assert.equal(septVenue.bbl, anchors.cb15_sept29.expected_bbl);
  assert.equal(septVenue.memberships.nta2020, anchors.cb15_sept29.expected_nta2020);
  assert.equal(
    sept29.memberships.find((membership) => membership.role === LOCATION_ROLES.HOST_JURISDICTION)
      ?.memberships?.community_district,
    anchors.cb15_sept29.expected_community_district,
  );
  assert.equal(
    sept29.assertions.find((assertion) => assertion.role === LOCATION_ROLES.VENUE)?.original_address,
    rows[0].venue.address,
  );

  const forest = result.outcomes.find((row) => row.meeting_id === forestHillsId);
  assert.equal(forest.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  assert.equal(
    forest.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE)?.memberships?.nta2020,
    anchors.forest_hills.expected_nta2020,
  );

  const worth = result.outcomes.find((row) => row.meeting_id === anchors.worth_street.meeting_id);
  assert.equal(worth.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  assert.equal(
    worth.memberships.find((membership) => membership.role === LOCATION_ROLES.VENUE)?.memberships?.nta2020,
    anchors.worth_street.expected_nta2020,
  );

  const stamped = stampMeetingRowsWithGeography(rows, result.outcomes);
  const activity = buildDistrictActivity({
    boundaries: BOUNDARIES,
    communityBoardGeography: loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH),
    geographyLayers: GEOGRAPHY_LAYERS,
    meetingsRows: stamped,
    builtAt: "2026-09-30T18:00:00.000Z",
  });

  assert.ok(
    activity.geography_items.by_key["geography:nta2020:BK1503"]?.meetings
      ?.includes(anchors.cb15_sept29.meeting_id),
    "BK1503 exact Meetings must include CB15 September 29",
  );
  assert.ok(
    activity.district_items.by_level.community_district.K15.meetings
      .includes(anchors.cb15_sept29.meeting_id),
    "K15 broader district activity must retain CB15 September 29",
  );
  assert.ok(
    activity.geography_items.by_key["geography:nta2020:QN0602"]?.meetings
      ?.includes(forestHillsId),
  );
  // City Record list cards key on request_id while the canonical meeting_id
  // remains on the shared row and meeting-detail route.
  const worthListId = rows[2].request_id || anchors.worth_street.meeting_id;
  assert.ok(
    activity.geography_items.by_key["geography:nta2020:MN0102"]?.meetings
      ?.includes(worthListId),
    `MN0102 must include City Record list id ${worthListId}`,
  );

  const listRecord = activity.records.meetings[anchors.cb15_sept29.meeting_id];
  assert.equal(listRecord.id, anchors.cb15_sept29.meeting_id);
  assert.equal(listRecord.venue_address, rows[0].venue.address);
  assert.match(String(listRecord.basis || ""), /Venue/i);
  const worthRecord = activity.records.meetings[worthListId];
  assert.ok(worthRecord, "City Record list record must be present");
  assert.equal(worthRecord.id, worthListId);
  assert.match(String(worthRecord.route || ""), /20260106034/);
  assert.equal(
    stamped.find((row) => row.meeting_id === anchors.worth_street.meeting_id)?.meeting_id,
    anchors.worth_street.meeting_id,
    "canonical City Record meeting_id remains on the stamped shared row",
  );

  const publication = buildLocalGeographyPublication({
    activity,
    geography: {},
    meetings: { schema: "cityscroll.shared_meeting_read_model.v1", rows: stamped },
    version: "mn03-publication",
    residentialPlaces: RESIDENTIAL_PLACES,
    dependencies: {
      parcel_membership_generation: "parcel-test",
      parcel_coordinate_vintage: "pluto-test",
      assertion_generation: "assertion-test",
      source_generation: "2026-09-30T18:00:00.000Z",
    },
  });
  assert.equal(publication.activation.activate, true, publication.activation.reason);

  const env = { ALERT_STATE: publicationKv(publication) };
  async function deferredIds(geo) {
    const response = await handleNearYou(new Request(
      `https://cityscroll.org/near-you/deferred.json?geo=${encodeURIComponent(geo)}&lens=meetings&surface=records`,
    ), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    return body.results_html || "";
  }

  const bk1503Html = await deferredIds("nta2020:BK1503");
  assert.match(bk1503Html, new RegExp(anchors.cb15_sept29.meeting_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(bk1503Html, /data-place-role="venue"|Meeting venue|Venue \/ logistics/i);

  const qn0602Html = await deferredIds("nta2020:QN0602");
  assert.match(qn0602Html, new RegExp(forestHillsId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const mn0102Html = await deferredIds("nta2020:MN0102");
  assert.match(mn0102Html, new RegExp(String(worthListId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(mn0102Html, /meeting%3Acity_record%3A20260106034|20260106034/);
});

test("neighborhood publication A3/A4 [boundary] host-only and missing-parcel rows create no exact NTA; failure keeps prior generation", () => {
  const anchors = NEIGHBORHOOD_PUBLICATION_ANCHORS;
  const hostOnly = sharedRow(anchors.cb15_sept29.meeting_id);
  hostOnly.venue = { name: null, address: null, mode: "in-person" };
  delete hostOnly.location_assertions;
  delete hostOnly.location_memberships;

  const bronx = sharedRow(anchors.bronx_missing_parcel.meeting_id);
  delete bronx.location_memberships;
  delete bronx.geography_backfill;

  const oath = oathRow(99);
  const virtual = {
    meeting_id: "meeting:example:virtual-only-control",
    source_system: "community_board",
    board_id: "brooklyn-cb-15",
    title: "Virtual-only control",
    event_date: "2026-09-30T19:00:00-04:00",
    venue: { name: null, address: null, mode: "virtual" },
    description: "This meeting will be held via Zoom only.",
  };

  const runner = createProductionRunner();
  const result = runner.run({
    rows: [hostOnly, bronx, oath, virtual],
    generation: "test-mn03-boundary",
    sourceGenerationHash: "mn03-boundary",
    observedAt: "2026-09-30T18:05:00.000Z",
  });

  const hostOutcome = result.outcomes.find((row) => row.meeting_id === hostOnly.meeting_id);
  assert.equal(hostOutcome.outcome, BACKFILL_OUTCOME.BROAD_JURISDICTION);
  assert.equal(
    hostOutcome.memberships.some((membership) => membership.role === LOCATION_ROLES.VENUE
      && membership.memberships?.nta2020),
    false,
  );

  const bronxOutcome = result.outcomes.find((row) => row.meeting_id === bronx.meeting_id);
  assert.notEqual(bronxOutcome.outcome, BACKFILL_OUTCOME.PHYSICAL_VENUE);
  assert.equal(
    bronxOutcome.memberships.some((membership) => membership.memberships?.nta2020),
    false,
    "matched BBL without parcel bundle must not invent an exact NTA",
  );
  // Resolution matched the BBL; parcel projection produced no NTA edge.
  const bronxResolution = runner.addressCache.resolveAddress(bronx.venue.address, {
    assertion: {
      role: LOCATION_ROLES.VENUE,
      validity: LOCATION_VALIDITY.ADMITTED_PHYSICAL_VENUE,
      original_address: bronx.venue.address,
      assertion_id: "bronx-control",
      meeting_id: bronx.meeting_id,
      record_id: bronx.meeting_id,
    },
  });
  assert.equal(bronxResolution.status, "matched");
  assert.equal(bronxResolution.bbl, anchors.bronx_missing_parcel.matched_bbl);
  assert.equal(
    classifyAddressCandidateClass({
      addressCandidateCount: 1,
      resolution: bronxResolution,
      parcelBundle: null,
    }),
    "matched_bbl_missing_parcel",
  );

  assert.equal(
    result.outcomes.find((row) => row.meeting_id === oath.meeting_id).outcome,
    BACKFILL_OUTCOME.NO_SOURCE_ADDRESS,
  );
  assert.ok([BACKFILL_OUTCOME.VIRTUAL, BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE].includes(
    result.outcomes.find((row) => row.meeting_id === virtual.meeting_id).outcome,
  ));

  const stamped = stampMeetingRowsWithGeography([hostOnly, bronx, oath, virtual], result.outcomes);
  const activity = buildDistrictActivity({
    boundaries: BOUNDARIES,
    communityBoardGeography: loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH),
    geographyLayers: GEOGRAPHY_LAYERS,
    meetingsRows: stamped,
    builtAt: "2026-09-30T18:05:00.000Z",
  });
  assert.equal(
    activity.geography_items.by_key["geography:nta2020:BK1503"]?.meetings
      ?.includes(hostOnly.meeting_id) || false,
    false,
    "host district alone must not create BK1503 membership",
  );
  assert.ok(
    activity.district_items.by_level.community_district.K15.meetings.includes(hostOnly.meeting_id),
  );

  withTempDirSync("meeting-geography-backfill-mn03-", (dir) => {
    const generationOld = "gen-mn03-old";
    activateMeetingGeographyBackfill({
      publicDir: dir,
      generation: generationOld,
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation: generationOld,
        built_at: "2026-09-30T17:00:00.000Z",
      },
      outcomesDocument: {
        schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
        generation: generationOld,
        built_at: "2026-09-30T17:00:00.000Z",
        outcomes: [],
      },
    });
    assert.equal(loadActiveMeetingGeographyBackfill(dir).pointer.active_generation, generationOld);
    assert.throws(() => activateMeetingGeographyBackfill({
      publicDir: dir,
      generation: "gen-mn03-failed",
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation: "gen-mn03-failed",
        built_at: "2026-09-30T18:05:00.000Z",
      },
      outcomesDocument: {
        schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
        generation: "gen-mn03-failed",
        built_at: "2026-09-30T18:05:00.000Z",
        outcomes: result.outcomes,
      },
      failBeforeActivate: true,
    }), /forced failure before activation/);
    assert.equal(loadActiveMeetingGeographyBackfill(dir).pointer.active_generation, generationOld);
    assert.equal(existsSync(path.join(dir, "gen-mn03-failed")), false);
  });
});

test("neighborhood publication A5 [verification] ID/role parity receipt and venue-edge mutation control", async () => {
  const retained = loadJson(path.join(ROOT, "site/data/meeting-geography-backfill/per-id-outcomes.json"));
  if (retained.outcomes.length === FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.canonical_meeting_count
    && retained.outcomes.filter((row) => row.outcome === BACKFILL_OUTCOME.BROAD_JURISDICTION).length
      === FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.broad_jurisdiction) {
    const frozen = assertFrozenNeighborhoodBaseline(retained.outcomes);
    assert.equal(
      frozen.address_candidate_classes.observed_no_candidate_among_broad,
      FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE.address_candidate_classes.no_candidate,
    );
  }

  const anchors = NEIGHBORHOOD_PUBLICATION_ANCHORS;
  const row = sharedRow(anchors.cb15_sept29.meeting_id);
  delete row.location_memberships;
  delete row.geography_backfill;
  const runner = createProductionRunner();
  const result = runner.run({
    rows: [row],
    generation: "test-mn03-parity",
    sourceGenerationHash: "mn03-parity",
    observedAt: "2026-09-30T18:10:00.000Z",
  });
  const stamped = stampMeetingRowsWithGeography([row], result.outcomes);
  const activity = buildDistrictActivity({
    boundaries: BOUNDARIES,
    communityBoardGeography: loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH),
    geographyLayers: GEOGRAPHY_LAYERS,
    meetingsRows: stamped,
    builtAt: "2026-09-30T18:10:00.000Z",
  });
  assert.ok(activity.geography_items.by_key["geography:nta2020:BK1503"]?.meetings
    ?.includes(anchors.cb15_sept29.meeting_id));
  assert.ok(activity.district_items.by_level.community_district.K15.meetings
    .includes(anchors.cb15_sept29.meeting_id));

  const meetings = buildMeetings({
    schema: "cityscroll.shared_meeting_read_model.v1",
    rows: stamped,
  }, "mn03-parity");
  const detailEntry = meetings.entries.find((entry) => entry.value.includes(anchors.cb15_sept29.meeting_id));
  assert.ok(detailEntry);
  const detailSlice = JSON.parse(detailEntry.value);
  const detail = detailSlice.rows.find((candidate) => candidate.meeting_id === anchors.cb15_sept29.meeting_id);
  assert.ok(detail.location_memberships.some((membership) => (
    membership.role === "venue" && membership.memberships?.nta2020 === "BK1503"
  )));

  // Mutation control: removing the venue edge drops exact local membership and
  // leaves broader district activity.
  const withoutVenue = stamped.map((candidate) => ({
    ...candidate,
    location_memberships: (candidate.location_memberships || [])
      .filter((membership) => membership.role !== LOCATION_ROLES.VENUE),
    geography_backfill: {
      outcome: BACKFILL_OUTCOME.BROAD_JURISDICTION,
      input_hash: candidate.geography_backfill?.input_hash || null,
      processed_at: "2026-09-30T18:10:00.000Z",
    },
  }));
  const mutatedActivity = buildDistrictActivity({
    boundaries: BOUNDARIES,
    communityBoardGeography: loadJson(COMMUNITY_BOARD_GEOGRAPHY_PATH),
    geographyLayers: GEOGRAPHY_LAYERS,
    meetingsRows: withoutVenue,
    builtAt: "2026-09-30T18:11:00.000Z",
  });
  assert.equal(
    mutatedActivity.geography_items.by_key["geography:nta2020:BK1503"]?.meetings
      ?.includes(anchors.cb15_sept29.meeting_id) || false,
    false,
  );
  assert.ok(
    mutatedActivity.district_items.by_level.community_district.K15.meetings
      .includes(anchors.cb15_sept29.meeting_id),
  );

  const receipt = buildNeighborhoodPublicationReceipt({
    beforeOutcomes: [{
      meeting_id: anchors.cb15_sept29.meeting_id,
      outcome: BACKFILL_OUTCOME.BROAD_JURISDICTION,
      memberships: [{
        role: LOCATION_ROLES.HOST_JURISDICTION,
        memberships: { community_district: "K15" },
      }],
    }],
    afterOutcomes: result.outcomes,
    beforeGeneration: "before-fixture",
    afterGeneration: "test-mn03-parity",
    builtAt: "2026-09-30T18:10:00.000Z",
  });
  assert.equal(receipt.schema, "cityscroll.neighborhood_publication_receipt.v1");
  assert.equal(receipt.frozen_baseline.canonical_meeting_count, 792);
  assert.equal(receipt.frozen_baseline.broad_jurisdiction, 281);
  assert.equal(receipt.frozen_baseline.address_candidate_classes.not_full_address, 54);
  assert.equal(receipt.frozen_baseline.address_candidate_classes.not_covered, 25);
  assert.equal(receipt.frozen_baseline.address_candidate_classes.no_candidate, 201);
  assert.equal(receipt.frozen_baseline.address_candidate_classes.matched_bbl_missing_parcel, 1);
  assert.equal(receipt.after.anchors.cb15_sept29.venue_nta2020, "BK1503");
  assert.equal(receipt.before.anchors.cb15_sept29.venue_nta2020, null);

  // Positive control: a receipt built without the recovered venue must not
  // claim the BK1503 anchor.
  const negativeReceipt = buildNeighborhoodPublicationReceipt({
    beforeOutcomes: [],
    afterOutcomes: [{
      meeting_id: anchors.cb15_sept29.meeting_id,
      outcome: BACKFILL_OUTCOME.BROAD_JURISDICTION,
      memberships: [{
        role: LOCATION_ROLES.HOST_JURISDICTION,
        memberships: { community_district: "K15" },
      }],
    }],
  });
  assert.equal(negativeReceipt.after.anchors.cb15_sept29.venue_nta2020, null);
  assert.notEqual(negativeReceipt.after.anchors.cb15_sept29.venue_nta2020, "BK1503");
});
