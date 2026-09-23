import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BBL_MAPPLUTO_CENTROIDS_ARTIFACT,
  BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE,
  assertBblMapplutoCentroidsServeGate,
} from "../site/bbl_mappluto_centroids.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_PATH,
  PARCEL_GEOGRAPHY_MIN_PARCELS,
  PARCEL_GEOGRAPHY_SHARD_COUNT,
  lookupParcelPoint,
  parcelGeographyServeGateFindings,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import { runBuild } from "../tools/build_citywide_parcel_points.mjs";
import {
  ParcelPointConflictError,
  classifyPublisherRow,
  ingestPublisherRows,
  newIngestState,
} from "../tools/lib/citywide_parcel_points.mjs";
import { ARCGIS_MAX_RETRIES } from "../tools/lib/mappluto_acquisition.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Retained official positive rows: the NYC DCP MapPLUTO FeatureServer
 * attributes for the four named Brooklyn parcels, exactly as published for
 * BBL IN (3066990010,3076200025,3050700035,3088150590). The values are the
 * official Latitude/Longitude fields — never a derived or verdict value.
 */
const OFFICIAL_NAMED_ROWS = [
  { bbl: "3066990010", lat: 40.6297346, lon: -73.9615272 },
  { bbl: "3076200025", lat: 40.6223241, lon: -73.9553717 },
  { bbl: "3050700035", lat: 40.6466644, lon: -73.970721 },
  { bbl: "3088150590", lat: 40.5839077, lon: -73.9323778 },
];

const PLUTO_CSV_HEADERS = "borough,BBL,latitude,longitude,version";
function plutoCsvRow(row) {
  return `BK,${row.bbl},${row.lat ?? ""},${row.lon ?? ""},${row.version ?? "25v4"}`;
}

async function makePadIndexFixture(dir, { e16 = "3066990010", nowhere = "1999999999" } = {}) {
  await mkdir(dir, { recursive: true });
  const shardCount = 64;
  const shards = {};
  for (let index = 0; index < shardCount; index += 1) {
    const key = index.toString(16).padStart(2, "0");
    shards[key] = { schema: "cityscroll.address-index-shard.v1", key, streets: {} };
  }
  shards["3a"].streets["E 16 ST"] = [[810000, 810000, 2, e16, "11230"]];
  shards["12"].streets["NOWHERE ST"] = [[100, 100, 1, nowhere, "10001"]];
  const manifestShards = {};
  let records = 0;
  for (const [key, doc] of Object.entries(shards)) {
    const docRecords = Object.values(doc.streets).reduce((sum, rows) => sum + rows.length, 0);
    records += docRecords;
    manifestShards[key] = { file: `./${key}.json`, records: docRecords, streets: Object.keys(doc.streets).length };
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify(doc));
  }
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    schema: "cityscroll.address-index-manifest.v1",
    generated_at: "2026-09-23T00:00:00.000Z",
    shard_count: shardCount,
    coverage: { materialized_ranges: records, normalized_streets: 2 },
    shards: manifestShards,
  }));
  return dir;
}

async function replayDir(name) {
  const base = await mkdtemp(path.join(tmpdir(), `parcel-geography-${name}-`));
  const padIndex = await makePadIndexFixture(path.join(base, "pad-index"));
  return { base, padIndex };
}

function arcgisResponse(features, extra = {}) {
  return { json: async () => ({ features, ...extra }) , ok: true };
}

/**
 * Mock fetch impersonating the official FeatureServer for object-ID
 * acquisition. Feature rows keep the publisher's exact attribute shapes.
 * A row marked returned:false is a requested object ID the response omits.
 */
function makeArcgisFetch({ rowsById, failMode = null, attempts = { count: 0 } } = {}) {
  const allIds = Object.keys(rowsById).map(Number).sort((a, b) => a - b);
  const known = new Set(allIds.filter((id) => rowsById[String(id)].returned !== false));
  const features = Object.entries(rowsById)
    .filter(([, row]) => row.returned !== false)
    .map(([objectid, row]) => ({
      attributes: {
        OBJECTID: Number(objectid),
        BBL: Number(row.bbl),
        Latitude: row.lat,
        Longitude: row.lon,
      },
    }));
  return async (url) => {
    const target = url instanceof URL ? url : new URL(url);
    attempts.count += 1;
    if (failMode === "page") throw new Error(" simulated network failure");
    if (target.searchParams.get("returnIdsOnly") === "true") {
      return arcgisResponse([], { objectIds: allIds });
    }
    if (failMode === "truncated") {
      return { ok: true, json: async () => ({ features: [], exceededTransferLimit: true }) };
    }
    const requested = String(target.searchParams.get("objectIds") || "").split(",").map(Number).filter(Boolean);
    const payloadFeatures = requested
      .filter((id) => known.has(id))
      .map((id) => features.find((feature) => feature.attributes.OBJECTID === id))
      .filter(Boolean);
    return arcgisResponse(payloadFeatures);
  };
}

test("retained official positive rows replay through the production builder into deterministic shards", async () => {
  const { base, padIndex } = await replayDir("official");
  const csvPath = path.join(base, "official.csv");
  await writeFile(csvPath, [
    PLUTO_CSV_HEADERS,
    ...OFFICIAL_NAMED_ROWS.map(plutoCsvRow),
    `BK,1999999999,,,25v4`,
  ].join("\n") + "\n");
  const outDir = path.join(base, "out");

  const { manifest, shardBytes } = await runBuild({
    fromPlutoCsv: csvPath,
    padIndexDir: padIndex,
    outDir,
    minParcels: 0,
  });

  assert.equal(manifest.mode, "mappluto_pluto_csv");
  assert.equal(manifest.point_method, "mappluto_published_latitude_longitude");
  assert.equal(manifest.coordinate_vintage, "pluto_25v4");
  assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.build.duration_ms >= 0);
  assert.ok(shardBytes.total > 0);

  // Denominator accounting: every publisher row landed in exactly one bucket.
  assert.equal(manifest.coverage.publisher_rows, 5);
  assert.equal(manifest.coverage.retained_parcels, 4);
  assert.equal(manifest.coverage.retained_rows, 4);
  assert.equal(manifest.coverage.excluded_rows.missing_coordinates, 1);
  assert.equal(manifest.coverage.distinct_publisher_bbls, 5);

  // PAD-only unmatched references are reported separately and stay missing.
  assert.equal(manifest.coverage.pad_referenced_bbls, 2);
  assert.equal(manifest.coverage.pad_only_unmatched, 1);
  const padOnly = JSON.parse(await readFile(path.join(outDir, "pad-only-unmatched.json"), "utf8"));
  assert.deepEqual(padOnly, ["1999999999"]);

  // The four official points read back by exact BBL from their deterministic
  // shards, byte-for-byte the published values.
  for (const row of OFFICIAL_NAMED_ROWS) {
    const key = parcelShardKey(row.bbl);
    assert.match(key, /^[0-9a-f]{2}$/);
    const shard = JSON.parse(await readFile(path.join(outDir, `${key}.json`), "utf8"));
    const hit = lookupParcelPoint(shard, row.bbl);
    assert.ok(hit, `${row.bbl} must be readable from shard ${key}`);
    assert.equal(hit.lat, row.lat);
    assert.equal(hit.lon, row.lon);
    assert.equal(hit.key, key);
  }
  const padOnlyShard = JSON.parse(await readFile(path.join(outDir, `${parcelShardKey("1999999999")}.json`), "utf8"));
  assert.equal(lookupParcelPoint(padOnlyShard, "1999999999"), null);

  // Determinism: the same source rebuilds the identical shard bytes.
  const outDir2 = path.join(base, "out2");
  await runBuild({ fromPlutoCsv: csvPath, padIndexDir: padIndex, outDir: outDir2, minParcels: 0 });
  const first = await readFile(path.join(outDir, `${parcelShardKey("3066990010")}.json`));
  const second = await readFile(path.join(outDir2, `${parcelShardKey("3066990010")}.json`));
  assert.deepEqual(first, second);
  await rm(base, { recursive: true, force: true });
});

test("committed citywide generation serves the four named official parcel points and passes full verification", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, PARCEL_GEOGRAPHY_MANIFEST_PATH), "utf8"));

  // Structural serve gate at production floors (population property, not a
  // named-record gate): the committed tree must clear it without overrides.
  assert.deepEqual(parcelGeographyServeGateFindings(manifest), []);
  assert.ok(manifest.coverage.retained_parcels >= PARCEL_GEOGRAPHY_MIN_PARCELS);
  assert.equal(Object.keys(manifest.shards).length, PARCEL_GEOGRAPHY_SHARD_COUNT);

  const dir = path.join(ROOT, path.dirname(PARCEL_GEOGRAPHY_MANIFEST_PATH));
  const { manifest: verified } = await runBuild({ check: true, outDir: dir });
  assert.equal(verified.coverage.publisher_rows, manifest.coverage.publisher_rows);

  for (const row of OFFICIAL_NAMED_ROWS) {
    const shard = JSON.parse(await readFile(path.join(dir, `${parcelShardKey(row.bbl)}.json`), "utf8"));
    const hit = lookupParcelPoint(shard, row.bbl);
    assert.ok(hit, `${row.bbl} must be locatable in the committed generation`);
    assert.equal(hit.lat, row.lat);
    assert.equal(hit.lon, row.lon);
  }
  // The committed build retained its actual denominator, shard sizes and timing.
  assert.ok(manifest.coverage.publisher_rows > 800_000);
  for (const descriptor of Object.values(manifest.shards)) {
    assert.ok(descriptor.bytes > 0);
    assert.match(descriptor.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(Number.isFinite(manifest.build.duration_ms) && manifest.build.duration_ms > 0);
});

test("existing Land bounded projection keeps its canaries and coverage gate; the named parcels stay citywide-only", async () => {
  const landDoc = JSON.parse(await readFile(path.join(ROOT, BBL_MAPPLUTO_CENTROIDS_ARTIFACT), "utf8"));
  assertBblMapplutoCentroidsServeGate(landDoc);
  assert.ok(landDoc.coverage.rate >= BBL_MAPPLUTO_CENTROIDS_MIN_COVERAGE);
  assert.equal(landDoc.coverage.canaries["3012660036"].status, "matched");
  assert.equal(landDoc.coverage.canaries["5017800015"].status, "matched");
  // E10 boundary: the Land lookup stays the bounded sell-facing projection and
  // still carries none of the four named parcels — their home is the citywide
  // generation, which now serves them.
  for (const row of OFFICIAL_NAMED_ROWS) {
    assert.ok(!landDoc.by_bbl[row.bbl], `Land projection must stay bounded (${row.bbl})`);
  }
});

test("every enumerated publisher object ID and distinct BBL is accounted in the ArcGIS fallback", async () => {
  const { base, padIndex } = await replayDir("arcgis");
  const outDir = path.join(base, "out");
  // Enumeration 101..104; 103 returns a null Latitude; 104 is absent from the
  // batch response (the publisher's population statement, not a truncation).
  const rowsById = {
    101: { bbl: "3066990010", lat: 40.6297346, lon: -73.9615272 },
    102: { bbl: "3076200025", lat: 40.6223241, lon: -73.9553717 },
    103: { bbl: "3050700035", lat: null, lon: -73.970721 },
    104: { bbl: "3088150590", lat: 40.5839077, lon: -73.9323778, returned: false },
  };
  const fetchImpl = makeArcgisFetch({ rowsById });
  const { manifest } = await runBuild({
    fromArcgis: true,
    fetchImpl,
    padIndexDir: padIndex,
    outDir,
    minParcels: 0,
  });
  assert.equal(manifest.mode, "mappluto_arcgis_batch");
  assert.equal(manifest.coverage.arcgis.object_ids_enumerated, 4);
  assert.equal(manifest.coverage.arcgis.object_ids_returned, 3);
  assert.equal(manifest.coverage.arcgis.object_ids_absent, 1);
  assert.equal(manifest.coverage.publisher_rows, 4);
  assert.equal(manifest.coverage.retained_parcels, 2);
  assert.equal(manifest.coverage.excluded_rows.missing_coordinates, 1);
  assert.equal(manifest.coverage.excluded_rows.publisher_absent, 1);
  assert.equal(manifest.coverage.distinct_publisher_bbls, 3);
  const shard = JSON.parse(await readFile(path.join(outDir, `${parcelShardKey("3088150590")}.json`), "utf8"));
  assert.equal(lookupParcelPoint(shard, "3088150590"), null);
  await rm(base, { recursive: true, force: true });
});

test("a truncated acquisition batch refuses activation and retains the previous generation", async () => {
  const { base, padIndex } = await replayDir("truncated");
  const csvPath = path.join(base, "official.csv");
  await writeFile(csvPath, [PLUTO_CSV_HEADERS, ...OFFICIAL_NAMED_ROWS.map(plutoCsvRow)].join("\n") + "\n");
  const outDir = path.join(base, "out");
  await runBuild({ fromPlutoCsv: csvPath, padIndexDir: padIndex, outDir, minParcels: 0 });
  const manifestBefore = await readFile(path.join(outDir, "manifest.json"));
  const shardKey = parcelShardKey("3066990010");
  const shardBefore = await readFile(path.join(outDir, `${shardKey}.json`));

  const fetchImpl = makeArcgisFetch({
    rowsById: { 1: OFFICIAL_NAMED_ROWS[0] },
    failMode: "truncated",
  });
  await assert.rejects(
    () => runBuild({ fromArcgis: true, fetchImpl, padIndexDir: padIndex, outDir, minParcels: 0 }),
    /transfer limit|truncated/i,
  );
  assert.deepEqual(await readFile(path.join(outDir, "manifest.json")), manifestBefore);
  assert.deepEqual(await readFile(path.join(outDir, `${shardKey}.json`)), shardBefore);
  assert.equal(existsSync(path.join(outDir, ".staging")), false);
  await rm(base, { recursive: true, force: true });
});

test("a duplicate conflicting BBL point refuses activation; identical duplicates dedupe", async () => {
  const fresh = newIngestState();
  ingestPublisherRows(fresh, [
    { bbl: "3066990010", lat: "40.6297346", lon: "-73.9615272" },
    { bbl: "3066990010", lat: "40.6297346", lon: "-73.9615272" },
  ]);
  assert.equal(fresh.accounting.duplicate_rows, 1);
  assert.equal(fresh.accounting.retained_rows, 1);

  const conflicting = newIngestState();
  assert.throws(
    () => ingestPublisherRows(conflicting, [
      { bbl: "3066990010", lat: "40.6297346", lon: "-73.9615272" },
      { bbl: "3066990010", lat: "40.6297349", lon: "-73.9615272" },
    ]),
    (error) => error instanceof ParcelPointConflictError,
  );

  // Through the production builder: the conflict aborts before any activation.
  const { base, padIndex } = await replayDir("conflict");
  const csvPath = path.join(base, "conflict.csv");
  await writeFile(csvPath, [
    PLUTO_CSV_HEADERS,
    ...OFFICIAL_NAMED_ROWS.map(plutoCsvRow),
    `BK,3066990010,40.6297349,-73.9615272,25v4`,
  ].join("\n") + "\n");
  const outDir = path.join(base, "out");
  await assert.rejects(
    () => runBuild({ fromPlutoCsv: csvPath, padIndexDir: padIndex, outDir, minParcels: 0 }),
    (error) => error instanceof ParcelPointConflictError,
  );
  assert.equal(existsSync(path.join(outDir, "manifest.json")), false);
  await rm(base, { recursive: true, force: true });
});

test("a failed acquisition page refuses activation after bounded retries", async () => {
  const { base, padIndex } = await replayDir("failed-page");
  const attempts = { count: 0 };
  const fetchImpl = makeArcgisFetch({ rowsById: { 1: OFFICIAL_NAMED_ROWS[0] }, failMode: "page", attempts });
  const outDir = path.join(base, "out");
  await assert.rejects(
    () => runBuild({ fromArcgis: true, fetchImpl, padIndexDir: padIndex, outDir, minParcels: 0 }),
    /id enumeration failed/,
  );
  // Enumeration retries are bounded — no unbounded page hammering.
  assert.equal(attempts.count, ARCGIS_MAX_RETRIES);
  assert.equal(existsSync(path.join(outDir, "manifest.json")), false);
  await rm(base, { recursive: true, force: true });
});

test("missing, null, nonfinite, and out-of-NYC coordinates never coerce to zero or a borough center", async () => {
  assert.deepEqual(classifyPublisherRow("3066990010", "", ""), { status: "missing_coordinates", bbl: "3066990010", point: null });
  assert.equal(classifyPublisherRow("3066990010", null, null).status, "missing_coordinates");
  assert.equal(classifyPublisherRow("3066990010", "NaN", "-73.96").status, "nonfinite_coordinates");
  assert.equal(classifyPublisherRow("3066990010", "Infinity", "-73.96").status, "nonfinite_coordinates");
  assert.equal(classifyPublisherRow("3066990010", "40.6297346", "NaN").status, "nonfinite_coordinates");
  assert.equal(classifyPublisherRow("3066990010", "0", "0").status, "out_of_nyc_coordinates");
  assert.equal(classifyPublisherRow("3066990010", "35.0", "-90.0").status, "out_of_nyc_coordinates");
  assert.equal(classifyPublisherRow("not-a-bbl", "40.63", "-73.96").status, "invalid_bbl");
  const retained = classifyPublisherRow("3066990010", "40.6297346", "-73.9615272");
  assert.deepEqual(retained.point, { lat: 40.6297346, lon: -73.9615272 });

  // Through the production builder: unusable rows stay missing — no zero,
  // borough-center, or other fabricated coordinate appears anywhere served.
  const { base, padIndex } = await replayDir("boundary");
  const csvPath = path.join(base, "boundary.csv");
  await writeFile(csvPath, [
    PLUTO_CSV_HEADERS,
    `BK,3066990010,,,25v4`,
    `BK,3076200025,NaN,-73.9553717,25v4`,
    `BK,3050700035,0,0,25v4`,
    `BK,3088150590,35.0,-90.0,25v4`,
    `BK,1017670001,40.8,-73.95,25v4`,
  ].join("\n") + "\n");
  const outDir = path.join(base, "out");
  const { manifest } = await runBuild({ fromPlutoCsv: csvPath, padIndexDir: padIndex, outDir, minParcels: 0 });
  assert.equal(manifest.coverage.retained_parcels, 1);
  assert.equal(manifest.coverage.excluded_rows.missing_coordinates, 1);
  assert.equal(manifest.coverage.excluded_rows.nonfinite_coordinates, 1);
  assert.equal(manifest.coverage.excluded_rows.out_of_nyc_coordinates, 2);
  for (const bbl of ["3066990010", "3076200025", "3050700035", "3088150590"]) {
    const shard = JSON.parse(await readFile(path.join(outDir, `${parcelShardKey(bbl)}.json`), "utf8"));
    assert.equal(lookupParcelPoint(shard, bbl), null, `${bbl} must stay missing`);
    assert.ok(!shard.parcels[bbl]);
  }
  const control = JSON.parse(await readFile(path.join(outDir, `${parcelShardKey("1017670001")}.json`), "utf8"));
  assert.deepEqual(lookupParcelPoint(control, "1017670001"), {
    bbl: "1017670001",
    lat: 40.8,
    lon: -73.95,
    key: parcelShardKey("1017670001"),
  });
  await rm(base, { recursive: true, force: true });
});
