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
  collectAddressCandidates,
  createMeetingGeographyBackfill,
  loadActiveMeetingGeographyBackfill,
  meetingGeographyInputHash,
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
  buildMeetings,
} from "../tools/build_worker_route_read_models.mjs";
import {
  summarizeCandidates,
} from "../tools/build_meeting_geography_backfill.mjs";

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
  const shared = loadJson(SHARED_MEETING_PATH);
  const rows = shared.rows || [];
  assert.ok(rows.length >= 780 && rows.length <= 820, `expected ~790 rows, got ${rows.length}`);

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
      manifest: { schema: "cityscroll.meeting_geography_backfill_manifest.v1", generation: generationOld },
      outcomesDocument: { schema: "cityscroll.meeting_geography_backfill_outcomes.v1", generation: generationOld, outcomes: [] },
    });
    const before = loadActiveMeetingGeographyBackfill(dir);
    assert.equal(before.pointer.active_generation, generationOld);

    assert.throws(() => activateMeetingGeographyBackfill({
      publicDir: dir,
      generation: "gen-new-failed",
      manifest: { schema: "cityscroll.meeting_geography_backfill_manifest.v1", generation: "gen-new-failed" },
      outcomesDocument: { schema: "cityscroll.meeting_geography_backfill_outcomes.v1", generation: "gen-new-failed", outcomes: result.outcomes },
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
    const shared = loadJson(SHARED_MEETING_PATH);
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

    const stampedShared = loadJson(sharedCopyPath);
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
