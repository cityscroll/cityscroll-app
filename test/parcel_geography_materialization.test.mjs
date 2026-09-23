import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseAddressQuery,
  resolveAddressFromShard,
  addressShardKey,
} from "../site/precomputed_address_geocoder.mjs";
import { resolveCivicGeographies } from "../site/civic_geography.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_PATH,
  PARCEL_GEOGRAPHY_MIN_PARCELS,
  PARCEL_MEMBERSHIP_LAYERS,
  lookupParcelMemberships,
  normalizeParcelMembership,
  parcelShardMembershipFindings,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import { runBuild as runPointsBuild } from "../tools/build_citywide_parcel_points.mjs";
import { runMembershipBuild } from "../tools/build_parcel_memberships.mjs";
import {
  SimplifiedGeometryRefusalError,
  buildLayerResolver,
  fullScanLayerMatches,
  loadMembershipLayer,
} from "../tools/lib/parcel_membership_materialization.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_REGISTRY = path.join(ROOT, "site", "data", "geography", "layer_registry.json");

/**
 * Retained official positive rows: the NYC DCP MapPLUTO FeatureServer
 * attributes for the four named Brooklyn parcels, exactly as published for
 * BBL IN (3066990010,3076200025,3050700035,3088150590). The values are the
 * official Latitude/Longitude fields — never a derived or verdict value.
 * Every membership assertion below traces to these rows and to the committed
 * full-fidelity registered polygons, never to a recomputed or invented place.
 */
const OFFICIAL_NAMED_ROWS = [
  { bbl: "3066990010", lat: 40.6297346, lon: -73.9615272 },
  { bbl: "3076200025", lat: 40.6223241, lon: -73.9553717 },
  { bbl: "3050700035", lat: 40.6466644, lon: -73.970721 },
  { bbl: "3088150590", lat: 40.5839077, lon: -73.9323778 },
];

/** The resident-journey addresses that name these parcels, each resolved by
 * the committed PAD snapshot (source rows in site/data/address-index). */
const NAMED_ADDRESSES = [
  { query: "810 East 16th Street Brooklyn NY 11230", bbl: "3066990010" },
  { query: "1625 Ocean Avenue Brooklyn NY 11230", bbl: "3076200025" },
  { query: "461 Coney Island Avenue Brooklyn NY 11218", bbl: "3050700035" },
  { query: "3218 Emmons Avenue Brooklyn NY 11235", bbl: "3088150590" },
];

/** Grounded expectations from the pinned registered polygons (26B NTA /
 * 2026-05-26 districts): typed memberships of each official parcel point. */
const EXPECTED_MEMBERSHIPS = {
  3066990010: { borough: "3", community_district: "K14", council_district: "45", nta2020: "BK1403", police_precinct: "70" },
  3076200025: { borough: "3", community_district: "K14", council_district: "45", nta2020: "BK1403", police_precinct: "70" },
  3050700035: { borough: "3", community_district: "K14", council_district: "40", nta2020: "BK1402", police_precinct: "70" },
  3088150590: { borough: "3", community_district: "K15", council_district: "48", nta2020: "BK1503", police_precinct: "61" },
};

const readJson = async (relativePath) => JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));

let registryCache = null;
async function realRegistry() {
  registryCache ||= await readJson("site/data/geography/layer_registry.json");
  return registryCache;
}

const layerDocCache = new Map();
async function realLayerDoc(type) {
  if (!layerDocCache.has(type)) {
    const registry = await realRegistry();
    const row = registry.layers.find((layer) => layer.type === type);
    layerDocCache.set(type, await readJson(row.artifacts.full.path));
  }
  return layerDocCache.get(type);
}

/**
 * The midpoint of a real full-polygon ring edge where the registered polygons
 * report more than one containing feature (a genuine shared boundary). The
 * coordinates are derived from the committed layer geometry, not invented.
 */
async function realBoundaryMidpoint() {
  const nta = await realLayerDoc("nta2020");
  const feature = nta.features.find((candidate) => candidate.id === "BK1403");
  assert.ok(feature, "BK1403 must exist in the committed full NTA layer");
  const ring = feature.geometry.coordinates[0][0];
  for (let i = 1; i < Math.min(ring.length, 60); i += 1) {
    const lon = (ring[i - 1][0] + ring[i][0]) / 2;
    const lat = (ring[i - 1][1] + ring[i][1]) / 2;
    const matches = fullScanLayerMatches(nta, lon, lat);
    if (matches.length > 1 && matches.every((match) => match.boundary)) {
      return { lat, lon, matches };
    }
  }
  throw new Error("no multi-match boundary edge midpoint found on BK1403");
}

async function makePadIndexFixture(dir, bblByHouse) {
  await mkdir(dir, { recursive: true });
  const shardCount = 64;
  const shards = {};
  for (let index = 0; index < shardCount; index += 1) {
    const key = index.toString(16).padStart(2, "0");
    shards[key] = { schema: "cityscroll.address-index-shard.v1", key, streets: {} };
  }
  shards["3a"].streets["E 16 ST"] = [[810000, 810000, 2, bblByHouse["810"], "11230"]];
  shards["3a"].streets["OCEAN AV"] = [[1625000, 1625000, 2, bblByHouse["1625"], "11230"]];
  shards["3a"].streets["CONY ISLAND AV"] = [[461000, 461000, 2, bblByHouse["461"], "11218"]];
  shards["3a"].streets["EMMONS AV"] = [[3218000, 3218000, 2, bblByHouse["3218"], "11235"]];
  const manifestShards = {};
  for (const [key, doc] of Object.entries(shards)) {
    manifestShards[key] = { file: `./${key}.json`, records: 1, streets: 1 };
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify(doc));
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    schema: "cityscroll.address-index-manifest.v1",
    generated_at: "2026-09-23T00:00:00.000Z",
    shard_count: shardCount,
    coverage: { materialized_ranges: 1, normalized_streets: 1 },
    shards: manifestShards,
  }));
  return dir;
}

/** Scratch dirs retained across tests (shared anchor fixture); removed in after(). */
const retainedTempDirs = new Set();

function trackTempDir(dir) {
  retainedTempDirs.add(dir);
  return dir;
}

after(() => {
  for (const dir of retainedTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  retainedTempDirs.clear();
});

async function allocateReplayBase() {
  // Retained scratch cleaned in after(): cityscroll-prefixed so a leak is attributable.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const base = await mkdtemp(path.join(tmpdir(), "cityscroll-parcel-membership-"));
  return trackTempDir(base);
}

/**
 * Replay the official rows through the production point builder. Extra rows
 * (e.g. a real boundary-edge midpoint) ride along with the same accounting.
 * The base directory is retained until after() so shared fixtures can reuse it.
 */
async function replayPointsGeneration(extraRows = []) {
  const base = await allocateReplayBase();
  const padIndex = await makePadIndexFixture(path.join(base, "pad-index"), {
    810: "3066990010",
    1625: "3076200025",
    461: "3050700035",
    3218: "3088150590",
  });
  const csvPath = path.join(base, "official.csv");
  await writeFile(csvPath, [
    "borough,BBL,latitude,longitude,version",
    ...OFFICIAL_NAMED_ROWS.map((row) => `BK,${row.bbl},${row.lat},${row.lon},25v4`),
    ...extraRows.map((row) => `BK,${row.bbl},${row.lat},${row.lon},25v4`),
  ].join("\n") + "\n");
  const outDir = path.join(base, "points");
  await runPointsBuild({ fromPlutoCsv: csvPath, padIndexDir: padIndex, outDir, minParcels: 0 });
  return { base, pointsDir: outDir };
}

/** One cached replay of the four official anchors with the real registry. */
let anchorsBuildPromise = null;
function replayAnchorsBuild() {
  anchorsBuildPromise ||= (async () => {
    const { base, pointsDir } = await replayPointsGeneration();
    const outDir = path.join(base, "memberships");
    const result = await runMembershipBuild({
      parcelDir: pointsDir,
      outDir,
      minParcels: 0,
      timing: {
        generatedAt: "2026-09-23T00:00:00.000Z",
        startedAt: "2026-09-23T00:00:00.000Z",
        completedAt: "2026-09-23T00:00:01.000Z",
        durationMs: 1000,
        indexMs: 100,
        resolveMs: 900,
      },
    });
    return { base, pointsDir, outDir, result };
  })();
  return anchorsBuildPromise;
}

async function readShard(dir, bbl) {
  const key = parcelShardKey(bbl);
  return { key, shard: JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8")) };
}

function membershipSummary(shard, bbl) {
  const bundle = lookupParcelMemberships(shard, bbl);
  assert.ok(bundle, `${bbl} must carry a materialized membership bundle`);
  const summary = {};
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    summary[type] = { ids: bundle.memberships[type].ids, status: bundle.memberships[type].status };
  }
  return { bundle, summary };
}

test("A1: official anchor points materialize their named typed memberships through the production builders", async () => {
  const { outDir, result } = await replayAnchorsBuild();

  // The named resident addresses resolve to exactly these parcels through the
  // committed PAD snapshot, so the acceptance's address names and the
  // asserted parcels are the same real records.
  const indexManifest = await readJson("site/data/address-index/manifest.json");
  for (const named of NAMED_ADDRESSES) {
    const query = parseAddressQuery(named.query);
    const key = addressShardKey(query.street, indexManifest.shard_count);
    const shard = await readJson(`site/data/address-index/${key}.json`);
    const resolution = resolveAddressFromShard(query, shard, indexManifest);
    assert.equal(resolution.status, "matched", `${named.query} must resolve in the committed PAD snapshot`);
    assert.equal(resolution.bbl, named.bbl);
  }

  for (const row of OFFICIAL_NAMED_ROWS) {
    const { shard } = await readShard(outDir, row.bbl);
    const { bundle, summary } = membershipSummary(shard, row.bbl);
    assert.deepEqual(summary, {
      borough: { ids: [EXPECTED_MEMBERSHIPS[row.bbl].borough], status: "matched" },
      community_district: { ids: [EXPECTED_MEMBERSHIPS[row.bbl].community_district], status: "matched" },
      council_district: { ids: [EXPECTED_MEMBERSHIPS[row.bbl].council_district], status: "matched" },
      nta2020: { ids: [EXPECTED_MEMBERSHIPS[row.bbl].nta2020], status: "matched" },
      police_precinct: { ids: [EXPECTED_MEMBERSHIPS[row.bbl].police_precinct], status: "matched" },
    });
    // The parcel point is the official publisher value, untouched.
    assert.equal(bundle.lat, row.lat);
    assert.equal(bundle.lon, row.lon);
    // Independent vintages: NTA/precinct answer from 26B, districts from
    // 2026-05-26, each provenance carrying its own digest.
    assert.equal(bundle.memberships.nta2020.vintage, "26B");
    assert.equal(bundle.memberships.police_precinct.vintage, "26B");
    assert.equal(bundle.memberships.community_district.vintage, "2026-05-26");
    assert.equal(bundle.memberships.council_district.vintage, "2026-05-26");
    assert.equal(bundle.memberships.borough.vintage, "2026-05-26");
    for (const type of PARCEL_MEMBERSHIP_LAYERS) {
      assert.match(bundle.memberships[type].sha256, /^[0-9a-f]{64}$/);
      assert.equal(bundle.memberships[type].geometry_fidelity, "full");
    }
  }

  // The anchor identities named in the packet are the committed polygons'
  // own labels — grounded from the layer documents, not from this build.
  const nta = await realLayerDoc("nta2020");
  const borough = await realLayerDoc("borough");
  assert.equal(nta.features.find((f) => f.id === "BK1403").label, "Midwood");
  assert.equal(nta.features.find((f) => f.id === "BK1402").label, "Flatbush (West)-Ditmas Park-Parkville");
  assert.equal(nta.features.find((f) => f.id === "BK1503").label, "Sheepshead Bay-Manhattan Beach-Gerritsen Beach");
  assert.equal(nta.features.find((f) => f.id === "BK1203").label, "Kensington");
  assert.equal(borough.features.find((f) => f.id === "3").label, "Brooklyn");

  // The pinned timing receipt survives into the manifest verbatim.
  assert.equal(result.manifest.membership.build.duration_ms, 1000);
  assert.equal(result.manifest.membership.build.index_ms, 100);
  assert.equal(result.manifest.membership.build.resolve_ms, 900);
  assert.equal(result.manifest.membership.resolved_parcels, OFFICIAL_NAMED_ROWS.length);
});

test("A1: the committed citywide generation carries the same memberships and passes both generation gates", async () => {
  const committed = await readJson(PARCEL_GEOGRAPHY_MANIFEST_PATH);
  const dir = path.join(ROOT, path.dirname(PARCEL_GEOGRAPHY_MANIFEST_PATH));

  // Both committed gates pass at production floors.
  const { manifest: verifiedPoints } = await runPointsBuild({ check: true, outDir: dir });
  assert.equal(verifiedPoints.coverage.retained_parcels, committed.coverage.retained_parcels);
  const { manifest: verifiedMemberships } = await runMembershipBuild({ check: true, parcelDir: dir });
  assert.equal(verifiedMemberships.membership.resolved_parcels, committed.coverage.retained_parcels);

  assert.ok(committed.coverage.retained_parcels >= PARCEL_GEOGRAPHY_MIN_PARCELS);
  const block = committed.membership;
  assert.equal(block.schema, "cityscroll.parcel-membership-manifest.v1");
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const layer = block.layers[type];
    assert.equal(layer.status, "resolved", `${type} must be resolved in the committed generation`);
    assert.equal(layer.geometry_fidelity, "full");
    const registry = await realRegistry();
    const row = registry.layers.find((candidate) => candidate.type === type);
    assert.equal(layer.artifact_path, row.artifacts.full.path);
    const bytes = await readFile(path.join(ROOT, layer.artifact_path));
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), layer.sha256);
    const counts = layer.counts;
    assert.equal(counts.parcels, committed.coverage.retained_parcels);
    assert.equal(counts.matched + counts.not_covered + counts.ambiguous_boundary, counts.parcels);
  }
  // Independent vintages recorded per layer.
  assert.deepEqual(
    PARCEL_MEMBERSHIP_LAYERS.map((type) => block.layers[type].vintage),
    ["2026-05-26", "2026-05-26", "2026-05-26", "26B", "26B"],
  );

  // The four named parcels read back from the committed shards with the
  // exact replay memberships, including the independently resolved borough.
  for (const row of OFFICIAL_NAMED_ROWS) {
    const { shard } = await readShard(dir, row.bbl);
    const { summary } = membershipSummary(shard, row.bbl);
    for (const type of PARCEL_MEMBERSHIP_LAYERS) {
      assert.deepEqual(summary[type].ids, [EXPECTED_MEMBERSHIPS[row.bbl][type]]);
      assert.equal(summary[type].status, "matched");
    }
  }

  // Measured build count/time retained: population-scale positive receipts.
  const build = block.build;
  assert.ok(Number.isFinite(build.duration_ms) && build.duration_ms > 0);
  assert.ok(Number.isFinite(build.index_ms) && build.index_ms >= 0);
  assert.ok(Number.isFinite(build.resolve_ms) && build.resolve_ms > 0);
  assert.ok(block.layers.nta2020.counts.matched > 800_000);
});

test("A3: a real BK1403 boundary-edge midpoint retains every boundary match as a stored ambiguous membership", async () => {
  const midpoint = await realBoundaryMidpoint();
  assert.ok(midpoint.matches.length >= 2, "the boundary case must be a genuine multi-match edge");

  // Replay a parcel whose point is that real midpoint, through the same
  // production builders, and require every boundary match to survive.
  const { pointsDir } = await replayPointsGeneration([
    { bbl: "3000000099", lat: midpoint.lat, lon: midpoint.lon },
  ]);
  const outDir = path.join(path.dirname(pointsDir), "memberships-boundary");
  await runMembershipBuild({ parcelDir: pointsDir, outDir, minParcels: 0 });
  const { shard } = await readShard(outDir, "3000000099");
  const { summary } = membershipSummary(shard, "3000000099");
  assert.equal(summary.nta2020.status, "ambiguous_boundary");
  assert.deepEqual(summary.nta2020.ids, midpoint.matches.map((match) => match.id).sort());
  // Boundary method retained: the stored value records the boundary ids.
  const stored = shard.parcels["3000000099"].memberships.nta2020;
  assert.deepEqual(stored.boundary_ids, midpoint.matches.map((match) => match.id).sort());
  // Other layers still answer independently at the same point.
  assert.equal(summary.community_district.status, "matched");
  assert.equal(summary.police_precinct.status, "matched");
});

test("A3: a missing Council layer preserves healthy NTA and community results without guessing any council membership", async () => {
  const registry = await realRegistry();
  await withTempDir("missing-council", async (base) => {
    const fixtureRegistryPath = path.join(base, "layer_registry.json");
    const fixture = JSON.parse(JSON.stringify(registry));
    const councilRow = fixture.layers.find((layer) => layer.type === "council_district");
    councilRow.artifacts.full.path = "data/geography/layers/council_district/2099-01-01.full.json";
    await writeFile(fixtureRegistryPath, JSON.stringify(fixture));

    const anchors = await replayAnchorsBuild();
    const outDir = path.join(base, "memberships");
    const result = await runMembershipBuild({
      parcelDir: anchors.pointsDir,
      outDir,
      registryPath: fixtureRegistryPath,
      minParcels: 0,
      allowUnavailableLayers: true,
    });
    const block = result.manifest.membership;
    assert.equal(block.layers.council_district.status, "source_unavailable");
    assert.equal(block.layers.nta2020.status, "resolved");
    assert.equal(block.layers.community_district.status, "resolved");

    for (const row of OFFICIAL_NAMED_ROWS) {
      const { shard } = await readShard(outDir, row.bbl);
      const { summary } = membershipSummary(shard, row.bbl);
      // Healthy layers keep their exact memberships.
      assert.deepEqual(summary.nta2020.ids, [EXPECTED_MEMBERSHIPS[row.bbl].nta2020]);
      assert.deepEqual(summary.community_district.ids, [EXPECTED_MEMBERSHIPS[row.bbl].community_district]);
      assert.deepEqual(summary.police_precinct.ids, [EXPECTED_MEMBERSHIPS[row.bbl].police_precinct]);
      // The missing layer states its own status; no council id is invented or
      // guessed from the community district, borough, or NTA result.
      assert.deepEqual(summary.council_district.ids, []);
      assert.equal(summary.council_district.status, "source_unavailable");
      const stored = shard.parcels[row.bbl].memberships.council_district;
      assert.ok(!("boundary_ids" in stored));
    }
  });
});

test("A3/E16: none of the three CB14 parcels is assigned to Kensington BK1203", async () => {
  const { outDir } = await replayAnchorsBuild();
  const kensingtonBundle = lookupParcelMemberships(
    JSON.parse(JSON.stringify((await readShard(outDir, "3066990010")).shard)),
    "3066990010",
  );
  assert.ok(kensingtonBundle);
  const cb14Bbls = ["3066990010", "3076200025", "3050700035"];
  for (const bbl of cb14Bbls) {
    const { shard } = await readShard(outDir, bbl);
    const raw = shard.parcels[bbl].memberships;
    for (const type of PARCEL_MEMBERSHIP_LAYERS) {
      const normalized = normalizeParcelMembership(type, raw[type]);
      assert.ok(normalized, `${bbl} ${type} must normalize`);
      assert.ok(
        !normalized.ids.includes("BK1203"),
        `${bbl} must never carry Kensington as a ${type} membership`,
      );
    }
  }
});

test("A2: a changed Council-layer digest recomputes only Council and leaves points and other payloads untouched", async () => {
  const anchors = await replayAnchorsBuild();
  const registry = await realRegistry();

  // A genuinely changed council layer generation: district 45 removed and the
  // layer's own population statement updated (a redistricting, not a tamper).
  const council = await realLayerDoc("council_district");
  const changed = JSON.parse(JSON.stringify(council));
  changed.features = changed.features.filter((feature) => feature.id !== "45");
  changed.coverage.actual_feature_count = changed.features.length;

  await withTempDir("changed-council", async (base) => {
    const changedPath = path.join(base, "council-changed.full.json");
    await writeFile(changedPath, JSON.stringify(changed));
    const fixtureRegistryPath = path.join(base, "layer_registry.json");
    const fixture = JSON.parse(JSON.stringify(registry));
    const councilRow = fixture.layers.find((layer) => layer.type === "council_district");
    councilRow.artifacts.full.path = path.relative(ROOT, changedPath);
    await writeFile(fixtureRegistryPath, JSON.stringify(fixture));

    const outDir = path.join(base, "memberships-gen2");
    const gen2 = await runMembershipBuild({
      parcelDir: anchors.outDir,
      outDir,
      registryPath: fixtureRegistryPath,
      minParcels: 0,
    });
    const gen1Manifest = anchors.result.manifest;
    const gen2Manifest = gen2.manifest;

    // Point-side fields are untouched: same source, same coverage, same point
    // build receipt — membership work never re-geocodes or moves a point.
    assert.deepEqual(gen2Manifest.coverage, gen1Manifest.coverage);
    assert.deepEqual(gen2Manifest.source, gen1Manifest.source);
    assert.deepEqual(gen2Manifest.build, gen1Manifest.build);
    assert.equal(gen2Manifest.coordinate_vintage, gen1Manifest.coordinate_vintage);
    assert.equal(gen2Manifest.membership.inputs.points_sha256, gen1Manifest.membership.inputs.points_sha256);

    // Council recomputed against the changed digest; every other layer reused.
    assert.equal(gen2Manifest.membership.layers.council_district.computation, "computed");
    assert.notEqual(
      gen2Manifest.membership.layers.council_district.sha256,
      gen1Manifest.membership.layers.council_district.sha256,
    );
    for (const type of ["borough", "community_district", "nta2020", "police_precinct"]) {
      assert.equal(gen2Manifest.membership.layers[type].computation, "reused");
      assert.equal(
        gen2Manifest.membership.layers[type].sha256,
        gen1Manifest.membership.layers[type].sha256,
      );
    }

    for (const row of OFFICIAL_NAMED_ROWS) {
      const before = (await readShard(anchors.outDir, row.bbl)).shard.parcels[row.bbl];
      const afterShard = (await readShard(outDir, row.bbl)).shard.parcels[row.bbl];
      assert.equal(afterShard.lat, before.lat);
      assert.equal(afterShard.lon, before.lon);
      // Unchanged membership payloads are carried over byte-identically.
      for (const type of ["borough", "community_district", "nta2020", "police_precinct"]) {
        assert.deepEqual(afterShard.memberships[type], before.memberships[type]);
      }
      // The Council result itself reflects the changed polygons: the parcels in
      // removed district 45 become not covered, others keep their own result.
      if (row.bbl === "3066990010" || row.bbl === "3076200025") {
        assert.deepEqual(afterShard.memberships.council_district, { ids: [], status: "not_covered" });
      } else {
        assert.equal(afterShard.memberships.council_district, EXPECTED_MEMBERSHIPS[row.bbl].council_district);
      }
    }
  });
});

test("A4: the indexed resolver equals the full-scan production resolver on anchors, boundary cases, and committed parcels", async () => {
  const layers = new Map();
  const resolvers = new Map();
  for (const type of PARCEL_MEMBERSHIP_LAYERS) {
    const doc = await realLayerDoc(type);
    layers.set(type, doc);
    resolvers.set(type, buildLayerResolver(doc));
  }
  const compare = (type, lat, lon) => {
    const indexed = resolvers.get(type).resolvePoint(lon, lat);
    const scan = fullScanLayerMatches(layers.get(type), lon, lat);
    const key = (list) => JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.boundary === b.boundary ? 0 : a.boundary ? 1 : -1)));
    assert.deepEqual(key(indexed), key(scan), `${type} at (${lat},${lon}) must match the full scan`);
    // And the production multi-layer resolver agrees on ids and statuses.
    const production = resolveCivicGeographies(lat, lon, {
      layerData: PARCEL_MEMBERSHIP_LAYERS.map((t) => layers.get(t)),
      types: [type],
    });
    const productionIds = production.matches.map((match) => ({ id: match.id, boundary: match.method === "point_on_polygon_boundary" }));
    assert.deepEqual(key(productionIds), key(scan));
    assert.equal(production.layers[0].match_count, scan.length);
  };

  for (const row of OFFICIAL_NAMED_ROWS) {
    for (const type of PARCEL_MEMBERSHIP_LAYERS) compare(type, row.lat, row.lon);
  }
  const midpoint = await realBoundaryMidpoint();
  for (const type of PARCEL_MEMBERSHIP_LAYERS) compare(type, midpoint.lat, midpoint.lon);
  const productionBoundary = resolveCivicGeographies(midpoint.lat, midpoint.lon, {
    layerData: PARCEL_MEMBERSHIP_LAYERS.map((t) => layers.get(t)),
    types: ["nta2020"],
  });
  assert.equal(productionBoundary.layers[0].status, "ambiguous_boundary");

  // Population-sample equivalence across committed shards: the indexed
  // resolver returns exactly the full-scan answer for real parcel points.
  const manifest = await readJson(PARCEL_GEOGRAPHY_MANIFEST_PATH);
  const sampled = Object.keys(manifest.shards).slice(0, 3);
  let compared = 0;
  for (const key of sampled) {
    const shard = await readJson(`site/data/parcel-geography/${key}.json`);
    for (const [bbl, entry] of Object.entries(shard.parcels)) {
      for (const type of PARCEL_MEMBERSHIP_LAYERS) {
        const indexed = resolvers.get(type).resolvePoint(entry.lon, entry.lat);
        const scan = fullScanLayerMatches(layers.get(type), entry.lon, entry.lat);
        assert.equal(indexed.length, scan.length, `${bbl} ${type}`);
        for (let i = 0; i < scan.length; i += 1) {
          assert.equal(indexed[i].id, scan[i].id);
          assert.equal(indexed[i].boundary, scan[i].boundary);
        }
        compared += 1;
      }
    }
  }
  assert.ok(compared > 10_000, `sampled a real population slice (compared ${compared} resolutions)`);
});

test("A4: simplified display geometry is refused and never replaces the full polygons", async () => {
  const registry = await realRegistry();
  const ntaRow = registry.layers.find((layer) => layer.type === "nta2020");

  // Direct refusal: the registered simplified site artifact is not a full
  // layer, whatever path it is fetched through.
  await assert.rejects(
    () => loadMembershipLayer({ ...ntaRow, artifacts: { ...ntaRow.artifacts, full: { ...ntaRow.artifacts.full, path: ntaRow.artifacts.simplified.site_path } } }, ROOT, readFile),
    (error) => error instanceof SimplifiedGeometryRefusalError,
  );

  // Through the builder: a registry whose full artifact points at the
  // simplified file refuses activation and leaves the previous generation in
  // place with no staging left behind.
  const anchors = await replayAnchorsBuild();
  await withTempDir("substituted", async (base) => {
    const fixtureRegistryPath = path.join(base, "layer_registry.json");
    const fixture = JSON.parse(JSON.stringify(registry));
    const row = fixture.layers.find((layer) => layer.type === "nta2020");
    row.artifacts.full.path = row.artifacts.simplified.site_path;
    await writeFile(fixtureRegistryPath, JSON.stringify(fixture));
    const outDir = path.join(base, "memberships");
    await assert.rejects(
      () => runMembershipBuild({ parcelDir: anchors.pointsDir, outDir, registryPath: fixtureRegistryPath, minParcels: 0 }),
      (error) => error instanceof SimplifiedGeometryRefusalError,
    );
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(path.join(outDir, "manifest.json")), false);
    assert.equal(existsSync(path.join(outDir, ".staging")), false);
    // The input generation is untouched by the refusal.
    const before = await readFile(path.join(anchors.outDir, "manifest.json"));
    assert.ok(before.byteLength > 0);
  });
});

test("A4/D4: identical inputs rebuild byte-identical shards; the reader normalizes every stored shape", async () => {
  const anchors = await replayAnchorsBuild();
  const outDir2 = path.join(anchors.base, "memberships-determinism");
  await runMembershipBuild({ parcelDir: anchors.pointsDir, outDir: outDir2, minParcels: 0 });
  for (const row of OFFICIAL_NAMED_ROWS) {
    const key = parcelShardKey(row.bbl);
    const first = await readFile(path.join(anchors.outDir, `${key}.json`));
    const second = await readFile(path.join(outDir2, `${key}.json`));
    assert.deepEqual(first, second);
  }

  // Reader normalization: single-id shorthand, explicit object, boundary
  // object, and refusals of invented or cross-layer-guessed values.
  assert.deepEqual(normalizeParcelMembership("nta2020", "BK1403"), { ids: ["BK1403"], status: "matched", boundaryIds: [] });
  assert.deepEqual(normalizeParcelMembership("council_district", { ids: [], status: "not_covered" }), { ids: [], status: "not_covered", boundaryIds: [] });
  assert.deepEqual(
    normalizeParcelMembership("nta2020", { ids: ["BK1403", "BK1401"], boundary_ids: ["BK1401", "BK1403"], status: "ambiguous_boundary" }),
    { ids: ["BK1401", "BK1403"], status: "ambiguous_boundary", boundaryIds: ["BK1401", "BK1403"] },
  );
  assert.equal(normalizeParcelMembership("nta2020", "BK99"), null);
  assert.equal(normalizeParcelMembership("nta2020", "K14"), null);
  assert.equal(normalizeParcelMembership("council_district", { ids: ["45"], status: "not_covered" }), null);
  assert.equal(normalizeParcelMembership("council_district", { ids: ["45"], status: "source_unavailable" }), null);
  assert.equal(normalizeParcelMembership("council_district", { ids: ["45"], boundary_ids: ["40"] }), null);

  // The shard gate flags tampered membership values instead of serving them:
  // a community-district id pasted into the NTA field (a cross-layer guess)
  // and a non-canonical id are both structurally untruthful.
  const { shard } = await readShard(anchors.outDir, "3066990010");
  const tampered = JSON.parse(JSON.stringify(shard));
  tampered.parcels["3066990010"].memberships.nta2020 = "K14";
  assert.ok(parcelShardMembershipFindings(tampered).some((finding) => finding.includes("untruthful")));
  const tamperedPattern = JSON.parse(JSON.stringify(shard));
  tamperedPattern.parcels["3066990010"].memberships.police_precinct = "precinct 70";
  assert.ok(parcelShardMembershipFindings(tamperedPattern).length > 0);
  assert.deepEqual(parcelShardMembershipFindings(shard), []);
  assert.equal(lookupParcelMemberships(tampered, "3066990010"), null);
});
