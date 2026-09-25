/**
 * Address-geography refresh acceptance (alias c7159575e9184).
 *
 * A1 venue correction propagates through memberships + reverse index in one
 * scheduled path. A2 unchanged run reuses hashes; boundary-only skips PAD
 * geocoding and recomputes only the affected membership layer. A3 failures
 * retain the last activated generation. A4 runs the actual refresh command
 * against retained old/new publisher fixtures.
 */

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeAddressGeographyFingerprints,
  createAddressGeographyRefresh,
  loadAddressGeographyRefreshReceipt,
  planAddressGeographyRefresh,
  writeAddressGeographyRefreshReceipt,
} from "../site/address_geography_refresh.mjs";
import {
  activateMeetingGeographyBackfill,
  createMeetingGeographyBackfill,
  loadActiveMeetingGeographyBackfill,
  stampMeetingRowsWithGeography,
} from "../site/meeting_geography_backfill.mjs";
import { LOCATION_ROLES } from "../site/meeting_location_assertions.mjs";
import { civicGeographyKey } from "../site/civic_geography_registry.mjs";
import {
  createRecordAddressResolutionCache,
  padContentIdentity,
} from "../site/record_address_resolution_cache.mjs";
import {
  createRecordLocationMembershipProjection,
} from "../site/record_location_memberships.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import {
  runAddressGeographyRefresh,
} from "../tools/address_geography_refresh.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(ROOT, "test/fixtures/address_geography_refresh");
const PAD_MANIFEST = path.join(FIXTURE_ROOT, "pad-manifest.json");
const PAD_SHARD = path.join(FIXTURE_ROOT, "pad-street-subsets.json");

const SEPT23_ID =
  "meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/";

const BBL_810 = "3066990010";
const BBL_EMMONS = "3088150590";

const MEMBERSHIPS_BY_BBL = {
  [BBL_810]: {
    borough: "3",
    community_district: "K14",
    council_district: "45",
    nta2020: "BK1403",
    police_precinct: "70",
    lat: 40.6297346,
    lon: -73.9615272,
  },
  [BBL_EMMONS]: {
    borough: "3",
    community_district: "K15",
    council_district: "48",
    nta2020: "BK1503",
    police_precinct: "61",
    lat: 40.5839077,
    lon: -73.9323778,
  },
  "3076200025": {
    borough: "3",
    community_district: "K14",
    council_district: "45",
    nta2020: "BK1403",
    police_precinct: "70",
    lat: 40.6223241,
    lon: -73.9553717,
  },
};

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sept23Row({ address = "810 East 16th Street, Brooklyn, NY 11230", street = "810 East 16th Street", postal = "11230" } = {}) {
  return {
    meeting_id: SEPT23_ID,
    source_system: "community_board",
    meeting_origin: "community_board_source_observed",
    board_id: "brooklyn-cb-14",
    title: "Housing and Land Use Committee Meeting",
    event_date: "2026-09-23T18:30:00-04:00",
    venue: {
      name: "Brooklyn CB14 District Office",
      address,
      mode: "in-person",
      components: {
        street_address: street,
        address_locality: "Brooklyn",
        address_region: "NY",
        postal_code: postal,
      },
    },
  };
}

function layerSha(seed) {
  // Provenance digests are 64 lowercase hex chars.
  const hex = Buffer.from(String(seed)).toString("hex").padEnd(64, "0").slice(0, 64);
  return hex;
}

function writeParcelFixture(dir, {
  membershipOverride = null,
  coordinateVintage = "fixture-coords-v1",
  layerDigest = "nta-digest-v1",
} = {}) {
  mkdirSync(dir, { recursive: true });
  const parcels = {};
  for (const [bbl, info] of Object.entries(MEMBERSHIPS_BY_BBL)) {
    const memberships = membershipOverride?.[bbl] || {
      borough: info.borough,
      community_district: info.community_district,
      council_district: info.council_district,
      nta2020: info.nta2020,
      police_precinct: info.police_precinct,
    };
    parcels[bbl] = {
      lat: info.lat,
      lon: info.lon,
      memberships,
    };
  }
  const ntaSha = layerSha(layerDigest);
  const shard = {
    schema: "cityscroll.parcel-geography-shard.v1",
    key: "00",
    memberships: {
      schema: "cityscroll.parcel-memberships.v1",
      layers: {
        borough: {
          status: "resolved",
          vintage: "fixture",
          geometry_fidelity: "full",
          sha256: layerSha("borough"),
        },
        community_district: {
          status: "resolved",
          vintage: "fixture",
          geometry_fidelity: "full",
          sha256: layerSha("community_district"),
        },
        council_district: {
          status: "resolved",
          vintage: "fixture",
          geometry_fidelity: "full",
          sha256: layerSha("council_district"),
        },
        nta2020: {
          status: "resolved",
          vintage: "fixture",
          geometry_fidelity: "full",
          sha256: ntaSha,
        },
        police_precinct: {
          status: "resolved",
          vintage: "fixture",
          geometry_fidelity: "full",
          sha256: layerSha("police_precinct"),
        },
      },
    },
    parcels,
  };
  writeFileSync(path.join(dir, "00.json"), `${JSON.stringify(shard)}\n`);
  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({
    schema: "cityscroll.parcel-geography-manifest.v1",
    coordinate_vintage: coordinateVintage,
    generated_at: "2026-09-24T12:00:00.000Z",
    source: { sha256: layerSha(`coord-${coordinateVintage}`) },
    coverage: { retained_parcels: Object.keys(parcels).length },
    shards: { "00": { file: "00.json" } },
    membership: {
      schema: "cityscroll.parcel-membership-manifest.v1",
      generated_at: "2026-09-24T12:00:00.000Z",
      layers: {
        nta2020: { content_sha256: ntaSha },
      },
    },
  }, null, 2)}\n`);
}

function writeAddressFixture(dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(PAD_MANIFEST, path.join(dir, "manifest.json"));
  cpSync(PAD_SHARD, path.join(dir, "00.json"));
  // Also keep the descriptive fixture name some loaders look for.
  cpSync(PAD_SHARD, path.join(dir, "pad-street-subsets.json"));
}

function writeLayerRegistry(dir, { ntaDigest = "nta-digest-v1" } = {}) {
  const layersDir = path.join(dir, "layers");
  mkdirSync(layersDir, { recursive: true });
  const ntaPath = path.join(layersDir, "nta2020.json");
  writeFileSync(ntaPath, `${JSON.stringify({
    type: "nta2020",
    geometry_fidelity: "full",
    vintage: { id: "fixture" },
    coverage: { actual_feature_count: 0 },
    features: [],
  })}\n`);
  writeFileSync(path.join(dir, "layer_registry.json"), `${JSON.stringify({
    schema: "cityscroll.civic_geography_layer_registry.v1",
    layers: [
      {
        type: "nta2020",
        artifacts: {
          full: { path: path.relative(dir, ntaPath), sha256: ntaDigest },
        },
      },
    ],
  }, null, 2)}\n`);
}

function seedFixtureTree(root, {
  venue = null,
  ntaDigest = "nta-digest-v1",
  coordinateVintage = "fixture-coords-v1",
  padMetadataKey = "pad-meta-v1",
  mapplutoMetadataKey = "map-meta-v1",
} = {}) {
  const addressDir = path.join(root, "address-index");
  const parcelDir = path.join(root, "parcel-geography");
  const publicDir = path.join(root, "meeting-geography-backfill");
  const geoDir = path.join(root, "geography");
  writeAddressFixture(addressDir);
  writeParcelFixture(parcelDir, { coordinateVintage, layerDigest: ntaDigest });
  writeLayerRegistry(geoDir, { ntaDigest });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(path.join(root, "publisher"), { recursive: true });
  writeFileSync(path.join(root, "publisher", "pad-metadata.json"), `${JSON.stringify({
    version: "26b",
    updatedAt: "2026-09-01T00:00:00.000Z",
    equalityKey: padMetadataKey,
  }, null, 2)}\n`);
  writeFileSync(path.join(root, "publisher", "mappluto-metadata.json"), `${JSON.stringify({
    name: "MAPPLUTO",
    lastEditDate: 1_700_000_000_000,
    equalityKey: mapplutoMetadataKey,
  }, null, 2)}\n`);

  const row = venue || sept23Row();
  const shared = {
    schema: "cityscroll.shared_meeting_read_model.v1",
    rows: [row],
  };
  writeFileSync(
    path.join(root, "shared_meeting_read_model.json"),
    `${JSON.stringify(shared, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "community_board_geography_lookup.json"),
    `${JSON.stringify({ nodes: [] }, null, 2)}\n`,
  );

  return {
    addressDir,
    parcelDir,
    publicDir,
    sharedMeetingPath: path.join(root, "shared_meeting_read_model.json"),
    layerRegistry: path.join(geoDir, "layer_registry.json"),
    communityBoardGeographyPath: path.join(root, "community_board_geography_lookup.json"),
    fixtureDir: root,
  };
}

function createInstrumentedAdapters(paths, {
  state,
} = {}) {
  const counters = state || {
    address_resolutions: 0,
    polygon_computations: 0,
    layers_recomputed: [],
  };

  const loadPad = () => loadJson(path.join(paths.addressDir, "manifest.json"));
  const loadParcel = () => loadJson(path.join(paths.parcelDir, "manifest.json"));
  const loadShared = () => loadJson(paths.sharedMeetingPath);
  const loadBoundaries = () => {
    const registry = loadJson(paths.layerRegistry);
    const digests = {};
    for (const layer of registry.layers || []) {
      digests[layer.type] = layer.artifacts.full.sha256;
    }
    return digests;
  };
  const loadPublisher = () => ({
    pad: loadJson(path.join(paths.fixtureDir, "publisher/pad-metadata.json")),
    coordinates: loadJson(path.join(paths.fixtureDir, "publisher/mappluto-metadata.json")),
  });

  async function materializeJoins({ padChanged, membershipsChanged, changedMeetingIds }) {
    const addressManifest = loadPad();
    const shard = loadJson(path.join(paths.addressDir, "00.json"));
    const addressCache = createRecordAddressResolutionCache({
      manifest: addressManifest,
      loadShard: () => shard,
    });
    const parcelManifest = loadParcel();
    const loadParcelShard = () => loadJson(path.join(paths.parcelDir, "00.json"));
    const membershipProjection = createRecordLocationMembershipProjection({
      loadParcelShard,
      parcelMembershipGeneration: parcelManifest.membership?.generated_at
        || parcelManifest.coordinate_vintage
        || null,
    });
    const runner = createMeetingGeographyBackfill({
      addressCache,
      membershipProjection,
      communityBoardGeography: { nodes: [] },
      lookupParcelPoint: (bbl) => {
        const info = MEMBERSHIPS_BY_BBL[bbl];
        return info ? { lat: info.lat, lon: info.lon } : null;
      },
    });

    const shared = loadShared();
    const generation = [
      "test-gen",
      padChanged ? "pad" : "stable",
      membershipsChanged ? "memberships" : "joins",
      (changedMeetingIds || []).length ? `changed-${(changedMeetingIds || []).length}` : "none",
    ].join("-");
    const priorCheckpointPath = path.join(paths.publicDir, "checkpoint.json");
    const priorCheckpoint = (!padChanged && existsSync(priorCheckpointPath))
      ? loadJson(priorCheckpointPath)
      : null;

    let result;
    if (membershipsChanged && !padChanged && !(changedMeetingIds || []).length && priorCheckpoint?.processed) {
      // Boundary-only path: reuse retained assertions/BBLs; no PAD resolve.
      const observedAt = "2026-09-24T15:00:00.000Z";
      const outcomes = [];
      for (const row of shared.rows) {
        const prior = priorCheckpoint.processed[row.meeting_id];
        const projectionInputs = (prior.assertions || []).map((assertion) => {
          if (assertion?.role === LOCATION_ROLES.HOST_JURISDICTION) return { assertion };
          const membership = (prior.memberships || []).find((entry) => (
            entry.assertion_id === assertion.assertion_id
          ));
          return {
            assertion,
            resolution: membership?.bbl
              ? {
                assertion_id: assertion.assertion_id,
                meeting_id: row.meeting_id,
                bbl: membership.bbl,
                status: "matched",
              }
              : null,
          };
        });
        membershipProjection.replaceRecordAssertions(row.meeting_id, projectionInputs, { observedAt });
        const snapshot = membershipProjection.snapshot();
        const edges = snapshot.edges.filter((edge) => edge.record_id === row.meeting_id);
        const memberships = [];
        for (const edge of edges) {
          let rowMembership = memberships.find((entry) => entry.assertion_id === edge.assertion_id);
          if (!rowMembership) {
            rowMembership = {
              record_id: row.meeting_id,
              assertion_id: edge.assertion_id,
              role: edge.role,
              bbl: edge.bbl || null,
              memberships: {},
              point: null,
              confidence: 1,
              confidence_tier: "strong",
              provenance: { source_method: "accepted_exact_parcel_membership" },
            };
            memberships.push(rowMembership);
          }
          if (edge.geography_type && edge.geography_id != null) {
            rowMembership.memberships[edge.geography_type] = String(edge.geography_id);
          }
        }
        outcomes.push({ ...prior, memberships, edge_count: edges.length, processed_at: observedAt });
      }
      result = {
        generation,
        checkpoint: {
          ...priorCheckpoint,
          generation,
          processed: Object.fromEntries(outcomes.map((outcome) => [outcome.meeting_id, outcome])),
          completed: true,
        },
        outcomes,
        counts: { input_rows: outcomes.length, processed_rows: outcomes.length, newly_processed: 0 },
        projection: membershipProjection.snapshot(),
      };
    } else {
      result = runner.run({
        rows: shared.rows,
        generation,
        sourceGenerationHash: generation,
        checkpoint: priorCheckpoint,
        observedAt: "2026-09-24T15:00:00.000Z",
      });
    }

    counters.address_resolutions += addressCache.resolveCallCount();
    writeFileSync(priorCheckpointPath, `${JSON.stringify(result.checkpoint, null, 2)}\n`);

    const stamped = stampMeetingRowsWithGeography(shared.rows, result.outcomes);
    const outcomesDocument = {
      schema: "cityscroll.meeting_geography_backfill_outcomes.v1",
      generation,
      built_at: "2026-09-24T15:00:00.000Z",
      outcomes: result.outcomes,
    };
    const activation = activateMeetingGeographyBackfill({
      publicDir: paths.publicDir,
      generation,
      manifest: {
        schema: "cityscroll.meeting_geography_backfill_manifest.v1",
        generation,
        built_at: outcomesDocument.built_at,
        counts: result.counts,
      },
      outcomesDocument,
      projectionDocument: result.projection,
      stampedSharedMeetingModel: { ...shared, rows: stamped },
      sharedMeetingReadModelPath: paths.sharedMeetingPath,
    });

    return {
      address_resolutions: addressCache.resolveCallCount(),
      records_reprojected: shared.rows.length,
      reverse_index_updated: true,
      active_generation: activation.generation,
      projection: result.projection,
      outcomes: result.outcomes,
    };
  }

  return createAddressGeographyRefresh({
    loadFingerprints: async () => {
      const publisher = loadPublisher();
      return {
        fingerprints: computeAddressGeographyFingerprints({
          padManifest: loadPad(),
          padMetadataEqualityKey: publisher.pad.equalityKey,
          coordinateManifest: loadParcel(),
          coordinateMetadataEqualityKey: publisher.coordinates.equalityKey,
          boundaryDigests: loadBoundaries(),
          meetingRows: loadShared().rows,
        }),
      };
    },
    loadPreviousReceipt: () => loadAddressGeographyRefreshReceipt(paths.publicDir),
    saveReceipt: (receipt) => writeAddressGeographyRefreshReceipt(paths.publicDir, receipt),
    loadActiveGeneration: () => loadActiveMeetingGeographyBackfill(paths.publicDir)?.pointer?.active_generation || null,
    acquirePad: async () => {
      counters.pad_acquired = true;
      return { acquired: true };
    },
    acquireCoordinates: async () => {
      counters.coordinates_acquired = true;
      return { acquired: true };
    },
    rebuildMemberships: async ({ changedLayers }) => {
      const layers = changedLayers?.length ? changedLayers : ["nta2020"];
      counters.polygon_computations += layers.length;
      counters.layers_recomputed = layers.slice().sort();
      return {
        polygon_computations: layers.length,
        layers_recomputed: layers,
      };
    },
    reprojectRecordJoins: async (opts) => materializeJoins(opts),
    rebuildResidentOutputs: async ({ joinResult }) => ({
      active_generation: joinResult?.active_generation || null,
      outputs: { shared_meeting_read_model: paths.sharedMeetingPath },
    }),
  });
}

test("plan: pad/coordinate/boundary/venue invalidation and weekly force when metadata absent", () => {
  const base = computeAddressGeographyFingerprints({
    padManifest: loadJson(PAD_MANIFEST),
    padMetadataEqualityKey: "pad-1",
    coordinateManifest: {
      coordinate_vintage: "c1",
      source: { sha256: "s1" },
      coverage: { retained_parcels: 3 },
    },
    coordinateMetadataEqualityKey: "map-1",
    boundaryDigests: { nta2020: "nta-1" },
    meetingRows: [sept23Row()],
  });

  const unchanged = planAddressGeographyRefresh({
    previousFingerprints: base,
    currentFingerprints: base,
    previousReceipt: { activated_at: "2026-09-24T00:00:00.000Z" },
    now: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(unchanged.work_required, false);

  const venueChanged = computeAddressGeographyFingerprints({
    padManifest: loadJson(PAD_MANIFEST),
    padMetadataEqualityKey: "pad-1",
    coordinateManifest: {
      coordinate_vintage: "c1",
      source: { sha256: "s1" },
      coverage: { retained_parcels: 3 },
    },
    coordinateMetadataEqualityKey: "map-1",
    boundaryDigests: { nta2020: "nta-1" },
    meetingRows: [sept23Row({
      address: "3218 Emmons Avenue, Brooklyn, NY 11235",
      street: "3218 Emmons Avenue",
      postal: "11235",
    })],
  });
  const venuePlan = planAddressGeographyRefresh({
    previousFingerprints: base,
    currentFingerprints: venueChanged,
    previousReceipt: { activated_at: "2026-09-24T00:00:00.000Z" },
    now: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(venuePlan.stages.pad, "skip");
  assert.equal(venuePlan.stages.record_joins, "run");
  assert.ok(venuePlan.changed_meeting_ids.includes(SEPT23_ID));

  const boundaryChanged = {
    ...base,
    boundary_digests: { nta2020: "nta-2" },
    aggregate_hash: "x",
  };
  const boundaryPlan = planAddressGeographyRefresh({
    previousFingerprints: base,
    currentFingerprints: boundaryChanged,
    previousReceipt: { activated_at: "2026-09-24T00:00:00.000Z" },
    now: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(boundaryPlan.stages.pad, "skip");
  assert.equal(boundaryPlan.stages.memberships, "run");
  assert.deepEqual(boundaryPlan.changed_layers, ["nta2020"]);

  const noMeta = {
    ...base,
    pad_metadata_equality_key: null,
    coordinate_metadata_equality_key: null,
  };
  const weekly = planAddressGeographyRefresh({
    previousFingerprints: noMeta,
    currentFingerprints: noMeta,
    previousReceipt: { activated_at: "2026-09-01T00:00:00.000Z" },
    now: "2026-09-10T00:00:00.000Z",
  });
  assert.equal(weekly.stages.pad, "force_verify");
  assert.equal(weekly.stages.coordinates, "force_verify");
});

test("A1 [outcome] corrected September 23 venue propagates memberships and reverse index in one refresh", async () => {
  await withTempDir("address-geography-refresh-a1-", async (dir) => {
    const paths = seedFixtureTree(dir);
    const refresh = createInstrumentedAdapters(paths);

    const first = await refresh.run({ now: "2026-09-24T12:00:00.000Z", force: true });
    assert.equal(first.ok, true);
    assert.equal(first.status, "activated");
    const firstOutcome = first.joinResult.outcomes.find((row) => row.meeting_id === SEPT23_ID);
    assert.equal(firstOutcome.memberships.find((m) => m.role === LOCATION_ROLES.VENUE)?.bbl, BBL_810);
    const midwoodKey = civicGeographyKey("nta2020", "BK1403");
    assert.ok(first.joinResult.projection.reverse[midwoodKey]?.record_ids.includes(SEPT23_ID));

    // Introduce the corrected venue (Emmons / BK1503).
    writeFileSync(paths.sharedMeetingPath, `${JSON.stringify({
      schema: "cityscroll.shared_meeting_read_model.v1",
      rows: [sept23Row({
        address: "3218 Emmons Avenue, Brooklyn, NY 11235",
        street: "3218 Emmons Avenue",
        postal: "11235",
      })],
    }, null, 2)}\n`);

    const second = await refresh.run({ now: "2026-09-24T13:00:00.000Z" });
    assert.equal(second.ok, true);
    assert.equal(second.status, "activated");
    const corrected = second.joinResult.outcomes.find((row) => row.meeting_id === SEPT23_ID);
    const venue = corrected.memberships.find((m) => m.role === LOCATION_ROLES.VENUE);
    assert.equal(venue.bbl, BBL_EMMONS);
    assert.equal(venue.memberships.nta2020, "BK1503");
    const sheepshead = civicGeographyKey("nta2020", "BK1503");
    assert.ok(second.joinResult.projection.reverse[sheepshead]?.record_ids.includes(SEPT23_ID));
    assert.equal(
      second.joinResult.projection.reverse[midwoodKey]?.record_ids?.includes(SEPT23_ID) || false,
      false,
    );
    const active = loadActiveMeetingGeographyBackfill(paths.publicDir);
    assert.equal(active.pointer.active_generation, second.active_generation);
  });
});

test("A2 [outcome] unchanged run reuses hashes; boundary-only skips PAD and updates one membership layer", async () => {
  await withTempDir("address-geography-refresh-a2-", async (dir) => {
    const paths = seedFixtureTree(dir);
    const state = {
      address_resolutions: 0,
      polygon_computations: 0,
      layers_recomputed: [],
    };
    const refresh = createInstrumentedAdapters(paths, { state });

    const first = await refresh.run({ now: "2026-09-24T12:00:00.000Z", force: true });
    assert.equal(first.ok, true);
    const resolutionsAfterFirst = state.address_resolutions;
    const polygonsAfterFirst = state.polygon_computations;
    assert.ok(resolutionsAfterFirst >= 1);

    const second = await refresh.run({ now: "2026-09-24T12:05:00.000Z" });
    assert.equal(second.status, "unchanged");
    assert.equal(state.address_resolutions, resolutionsAfterFirst);
    assert.equal(state.polygon_computations, polygonsAfterFirst);
    assert.equal(second.counters.address_resolutions, 0);
    assert.equal(second.counters.polygon_computations, 0);

    // Boundary-only change: new NTA digest, same PAD + meetings.
    writeLayerRegistry(path.join(paths.fixtureDir, "geography"), { ntaDigest: "nta-digest-v2" });
    // Simulate membership values flipping for the named parcel under the new layer.
    writeParcelFixture(paths.parcelDir, {
      coordinateVintage: "fixture-coords-v1",
      layerDigest: "nta-digest-v2",
      membershipOverride: {
        [BBL_810]: {
          borough: { ids: ["3"], status: "matched" },
          community_district: { ids: ["K14"], status: "matched" },
          council_district: { ids: ["45"], status: "matched" },
          nta2020: { ids: ["BK1403"], status: "matched" },
          police_precinct: { ids: ["70"], status: "matched" },
        },
      },
    });

    const third = await refresh.run({ now: "2026-09-24T12:10:00.000Z" });
    assert.equal(third.ok, true);
    assert.equal(third.status, "activated");
    assert.equal(third.plan.stages.pad, "skip");
    assert.equal(third.counters.address_resolutions, 0);
    assert.deepEqual(third.counters.membership_layers_recomputed, ["nta2020"]);
    assert.equal(third.counters.polygon_computations, 1);
    assert.equal(state.address_resolutions, resolutionsAfterFirst, "no additional PAD geocoding");
  });
});

test("A3 [boundary] timeout / partial coordinates / incomplete boundaries retain last activated generation", async () => {
  await withTempDir("address-geography-refresh-a3-", async (dir) => {
    const paths = seedFixtureTree(dir);
    const refresh = createInstrumentedAdapters(paths);
    const first = await refresh.run({ now: "2026-09-24T12:00:00.000Z", force: true });
    assert.equal(first.ok, true);
    const kept = first.active_generation;
    assert.ok(kept);

    for (const kind of ["timeout", "partial_coordinates", "incomplete_boundaries"]) {
      const failed = await refresh.run({
        now: "2026-09-24T13:00:00.000Z",
        force: true,
        injectFailure: kind,
      });
      assert.equal(failed.ok, false);
      assert.equal(failed.status, "failed");
      assert.equal(failed.active_generation, kept);
      const active = loadActiveMeetingGeographyBackfill(paths.publicDir);
      assert.equal(active.pointer.active_generation, kept);
      const receipt = loadAddressGeographyRefreshReceipt(paths.publicDir);
      assert.equal(receipt.status, "failed");
      assert.ok(receipt.failure?.kind);
      assert.equal(receipt.active_generation, kept);
      // Never publish an empty neighborhood as success.
      assert.notEqual(receipt.status, "activated");
      assert.ok((active.outcomes?.outcomes || []).length > 0);
    }
  });
});

test("A4 [verification] actual refresh command covers unchanged, venue, PAD, boundary, and failure fixtures", async () => {
  await withTempDir("address-geography-refresh-a4-", async (dir) => {
    const base = seedFixtureTree(dir);

    // Seed via the real command once.
    const seeded = await runAddressGeographyRefresh({
      fixtureDir: base.fixtureDir,
      publicDir: base.publicDir,
      sharedMeetingPath: base.sharedMeetingPath,
      addressDir: base.addressDir,
      parcelDir: base.parcelDir,
      layerRegistry: base.layerRegistry,
      communityBoardGeographyPath: base.communityBoardGeographyPath,
      skipLiveMetadata: true,
      force: true,
      now: "2026-09-24T12:00:00.000Z",
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded.receipt?.failure || seeded));
    const kept = seeded.active_generation;

    const unchanged = await runAddressGeographyRefresh({
      fixtureDir: base.fixtureDir,
      publicDir: base.publicDir,
      sharedMeetingPath: base.sharedMeetingPath,
      addressDir: base.addressDir,
      parcelDir: base.parcelDir,
      layerRegistry: base.layerRegistry,
      communityBoardGeographyPath: base.communityBoardGeographyPath,
      skipLiveMetadata: true,
      now: "2026-09-24T12:05:00.000Z",
    });
    assert.equal(unchanged.status, "unchanged");
    assert.equal(unchanged.counters.address_resolutions, 0);

    // Venue-change fixture.
    writeFileSync(base.sharedMeetingPath, `${JSON.stringify({
      schema: "cityscroll.shared_meeting_read_model.v1",
      rows: [sept23Row({
        address: "3218 Emmons Avenue, Brooklyn, NY 11235",
        street: "3218 Emmons Avenue",
        postal: "11235",
      })],
    }, null, 2)}\n`);
    const venue = await runAddressGeographyRefresh({
      fixtureDir: base.fixtureDir,
      publicDir: base.publicDir,
      sharedMeetingPath: base.sharedMeetingPath,
      addressDir: base.addressDir,
      parcelDir: base.parcelDir,
      layerRegistry: base.layerRegistry,
      communityBoardGeographyPath: base.communityBoardGeographyPath,
      skipLiveMetadata: true,
      now: "2026-09-24T12:10:00.000Z",
    });
    assert.equal(venue.ok, true);
    assert.equal(venue.status, "activated");

    // PAD-change fixture: alter PAD content identity.
    const padManifest = loadJson(path.join(base.addressDir, "manifest.json"));
    padManifest.source = {
      ...padManifest.source,
      sha256: "pad-changed-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      version: "26b-corrected",
    };
    writeFileSync(
      path.join(base.addressDir, "manifest.json"),
      `${JSON.stringify(padManifest, null, 2)}\n`,
    );
    writeFileSync(
      path.join(base.fixtureDir, "publisher/pad-metadata.json"),
      `${JSON.stringify({
        version: "26b-corrected",
        updatedAt: "2026-09-20T00:00:00.000Z",
        equalityKey: "pad-meta-v2",
      }, null, 2)}\n`,
    );
    const pad = await runAddressGeographyRefresh({
      fixtureDir: base.fixtureDir,
      publicDir: base.publicDir,
      sharedMeetingPath: base.sharedMeetingPath,
      addressDir: base.addressDir,
      parcelDir: base.parcelDir,
      layerRegistry: base.layerRegistry,
      communityBoardGeographyPath: base.communityBoardGeographyPath,
      skipLiveMetadata: true,
      now: "2026-09-24T12:15:00.000Z",
    });
    assert.equal(pad.ok, true);
    assert.equal(pad.plan.stages.pad, "run");

    // Boundary-change fixture.
    writeLayerRegistry(path.join(base.fixtureDir, "geography"), { ntaDigest: "nta-digest-v3" });
    const boundary = await runAddressGeographyRefresh({
      fixtureDir: base.fixtureDir,
      publicDir: base.publicDir,
      sharedMeetingPath: base.sharedMeetingPath,
      addressDir: base.addressDir,
      parcelDir: base.parcelDir,
      layerRegistry: base.layerRegistry,
      communityBoardGeographyPath: base.communityBoardGeographyPath,
      skipLiveMetadata: true,
      now: "2026-09-24T12:20:00.000Z",
    });
    assert.equal(boundary.ok, true);
    assert.equal(boundary.plan.stages.pad, "skip");
    assert.equal(boundary.plan.stages.memberships, "run");
    assert.equal(boundary.counters.address_resolutions, 0);

    // Failure fixture via CLI process.
    const failure = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "tools/address_geography_refresh.mjs"),
        "--fixture-dir", base.fixtureDir,
        "--public-dir", base.publicDir,
        "--shared-meeting", base.sharedMeetingPath,
        "--address-dir", base.addressDir,
        "--parcel-dir", base.parcelDir,
        "--layer-registry", base.layerRegistry,
        "--skip-live-metadata",
        "--force",
        "--inject-failure", "timeout",
      ],
      { encoding: "utf8", cwd: ROOT },
    );
    assert.notEqual(failure.status, 0);
    const active = loadActiveMeetingGeographyBackfill(base.publicDir);
    assert.ok(active?.pointer?.active_generation);
    assert.notEqual(active.pointer.active_generation, null);
    // The forced failure must not clear the previously activated generation.
    assert.ok(active.pointer.active_generation === boundary.active_generation
      || active.pointer.active_generation === pad.active_generation
      || active.pointer.active_generation === venue.active_generation
      || active.pointer.active_generation === kept);
    const receipt = loadAddressGeographyRefreshReceipt(base.publicDir);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.failure?.kind || "", /timeout|refresh_failed|source_timeout/);
  });
});
