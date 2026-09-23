/**
 * Citywide parcel-point generation: ingest, accounting, sharding, verification.
 *
 * Build-time lib behind tools/build_citywide_parcel_points.mjs and its replay
 * tests. It consumes publisher rows from the shared official MapPLUTO
 * acquisition (tools/lib/mappluto_acquisition.mjs) — one retained PLUTO CSV, or
 * exact object-ID batches — and materializes a committed citywide generation
 * under site/data/parcel-geography as deterministic 256-way BBL shards plus a
 * manifest with content digests.
 *
 * Rules this lib enforces:
 *  - Every enumerated publisher row / object ID lands in exactly one accounting
 *    bucket; the buckets sum back to the denominator.
 *  - Missing, null, nonfinite, or out-of-NYC coordinates are classified and
 *    dropped — never coerced to zero or a borough center.
 *  - A duplicate BBL with a conflicting point refuses the generation.
 *  - PAD parcel references without usable coordinates are reported separately
 *    (pad-only unmatched) and stay missing.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { normalizeBbl } from "../../site/bbl_mappluto_centroids.mjs";
import {
  PARCEL_GEOGRAPHY_MANIFEST_SCHEMA,
  PARCEL_GEOGRAPHY_POINT_METHOD,
  PARCEL_GEOGRAPHY_SHARD_COUNT,
  PARCEL_GEOGRAPHY_SHARD_SCHEMA,
  PARCEL_POINT_NYC_BOUNDS,
  assertParcelGeographyServeGate,
  parcelPointEntry,
  parcelShardKey,
} from "../../site/parcel_geography.mjs";
import { enumerateArcgisObjectIds, fetchArcgisObjectBatch, parseCsvLine } from "./mappluto_acquisition.mjs";

export const PARCEL_GEOGRAPHY_MAX_SHARD_BYTES = 20 * 1024 * 1024;
export const PAD_ONLY_UNMATCHED_FILE = "pad-only-unmatched.json";
const MANIFEST_FILE = "manifest.json";

export class ParcelPointConflictError extends Error {
  constructor(bbl, existing, incoming) {
    super(
      `Conflicting MapPLUTO points for BBL ${bbl}: retained (${existing.lon},${existing.lat}) vs new (${incoming.lon},${incoming.lat}) — refusing to activate an ambiguous generation`,
    );
    this.name = "ParcelPointConflictError";
    this.bbl = bbl;
  }
}

function emptyAccounting() {
  return {
    publisher_rows: 0,
    distinct_publisher_bbls: 0,
    retained_parcels: 0,
    retained_rows: 0,
    excluded_rows: {
      missing_coordinates: 0,
      nonfinite_coordinates: 0,
      out_of_nyc_coordinates: 0,
      invalid_bbl: 0,
      publisher_absent: 0,
    },
    duplicate_rows: 0,
  };
}

/**
 * Classify one raw publisher row. Raw values stay strings/null exactly as the
 * publisher emitted them; classification never rewrites a bad value into a
 * plausible one.
 * @param {string} rawBbl
 * @param {string|number|null} rawLat
 * @param {string|number|null} rawLon
 */
export function classifyPublisherRow(rawBbl, rawLat, rawLon) {
  const bbl = normalizeBbl(rawBbl);
  if (!bbl || !/^[1-5]\d{9}$/.test(bbl)) {
    return { status: "invalid_bbl", bbl: null, point: null };
  }
  const latText = rawLat === null || rawLat === undefined ? "" : String(rawLat).trim();
  const lonText = rawLon === null || rawLon === undefined ? "" : String(rawLon).trim();
  if (latText === "" || lonText === "") {
    return { status: "missing_coordinates", bbl, point: null };
  }
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { status: "nonfinite_coordinates", bbl, point: null };
  }
  if (
    lat < PARCEL_POINT_NYC_BOUNDS.min_lat
    || lat > PARCEL_POINT_NYC_BOUNDS.max_lat
    || lon < PARCEL_POINT_NYC_BOUNDS.min_lon
    || lon > PARCEL_POINT_NYC_BOUNDS.max_lon
  ) {
    return { status: "out_of_nyc_coordinates", bbl, point: null };
  }
  return { status: "retained", bbl, point: { lat, lon } };
}

/**
 * Ingest an in-memory batch of publisher rows into the accumulating generation
 * state. Throws ParcelPointConflictError on a duplicate BBL with conflicting
 * coordinates.
 * @param {object} state {{ byBbl, accounting, seenBbls }} mutated in place
 * @param {Array<{bbl:string, lat:(string|number|null), lon:(string|number|null)}>} rows
 */
export function ingestPublisherRows(state, rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    state.accounting.publisher_rows += 1;
    const shaped = classifyPublisherRow(row?.bbl, row?.lat, row?.lon);
    if (shaped.status === "invalid_bbl") {
      state.accounting.excluded_rows.invalid_bbl += 1;
      continue;
    }
    if (!state.seenBbls.has(shaped.bbl)) {
      state.seenBbls.add(shaped.bbl);
      state.accounting.distinct_publisher_bbls += 1;
    }
    if (shaped.status !== "retained") {
      state.accounting.excluded_rows[shaped.status] += 1;
      continue;
    }
    const existing = state.byBbl[shaped.bbl];
    if (existing) {
      if (existing.lat === shaped.point.lat && existing.lon === shaped.point.lon) {
        state.accounting.duplicate_rows += 1;
      } else {
        throw new ParcelPointConflictError(shaped.bbl, existing, shaped.point);
      }
      continue;
    }
    state.byBbl[shaped.bbl] = shaped.point;
    state.accounting.retained_rows += 1;
  }
}

export function newIngestState() {
  return {
    byBbl: Object.create(null),
    seenBbls: new Set(),
    accounting: emptyAccounting(),
    versions: new Set(),
    contentHash: createHash("sha256"),
  };
}

function finishAccounting(state) {
  const accounting = state.accounting;
  accounting.retained_parcels = Object.keys(state.byBbl).length;
  const sum = accounting.retained_rows
    + accounting.duplicate_rows
    + Object.values(accounting.excluded_rows).reduce((total, value) => total + value, 0);
  assert.equal(
    sum,
    accounting.publisher_rows,
    "parcel-point accounting broken: every publisher row must land in exactly one bucket",
  );
  return accounting;
}

/**
 * Stream a retained PLUTO CSV, ingesting every data row and hashing the source
 * bytes. Only rows with usable official coordinates are retained; every row is
 * accounted.
 * @param {string} csvPath
 * @param {object} state from newIngestState()
 */
export async function ingestPlutoCsv(csvPath, state) {
  const sourceHash = createHash("sha256");
  let hashError = null;
  const sourceStream = createReadStream(csvPath);
  sourceStream.on("error", (error) => { hashError = error; });
  sourceStream.on("data", (chunk) => sourceHash.update(chunk));
  const sourceStreamClosed = new Promise((resolve) => sourceStream.on("close", resolve));
  const rl = createInterface({ input: createReadStream(csvPath, { encoding: "utf8" }), crlfDelay: Infinity });
  let headers = null;
  let bblIdx = -1;
  let latIdx = -1;
  let lonIdx = -1;
  let versionIdx = -1;
  const batch = [];
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map((h) => String(h || "").trim());
      bblIdx = headers.findIndex((h) => /^bbl$/i.test(h));
      latIdx = headers.findIndex((h) => /^latitude$/i.test(h));
      lonIdx = headers.findIndex((h) => /^longitude$/i.test(h));
      versionIdx = headers.findIndex((h) => /^version$/i.test(h));
      if (bblIdx < 0 || latIdx < 0 || lonIdx < 0) {
        throw new Error(`PLUTO CSV missing BBL/latitude/longitude columns in ${csvPath}`);
      }
      continue;
    }
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (versionIdx >= 0) {
      const version = String(cols[versionIdx] ?? "").trim();
      if (version) state.versions.add(version);
    }
    batch.push({ bbl: cols[bblIdx], lat: cols[latIdx], lon: cols[lonIdx] });
    if (batch.length >= 20_000) {
      ingestPublisherRows(state, batch);
      batch.length = 0;
    }
  }
  ingestPublisherRows(state, batch);
  await sourceStreamClosed;
  if (hashError) throw hashError;
  return { sha256: sourceHash.digest("hex") };
}

/**
 * Acquire the official citywide population through exact object-ID batches.
 * Every enumerated id is returned-with-a-row or accounted absent.
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.endpoint]
 * @param {number} [opts.batchSize] at most 1000
 * @param {(awaited: number, total: number) => void} [opts.onProgress]
 */
export async function ingestArcgisObjectBatches(state, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const endpoint = opts.endpoint;
  const batchSize = Math.min(
    Number.isInteger(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 1000,
    1000,
  );
  const ids = await enumerateArcgisObjectIds({ fetchImpl, endpoint });
  const objectAccounting = {
    object_ids_enumerated: ids.length,
    object_ids_returned: 0,
    object_ids_absent: 0,
  };
  const rowsAcquired = createHash("sha256");
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const { rows, returned } = await fetchArcgisObjectBatch(batch, { fetchImpl, endpoint });
    objectAccounting.object_ids_returned += returned;
    for (const row of rows) {
      rowsAcquired.update(`${row.objectid},${row.bbl},${row.lat},${row.lon}\n`);
    }
    ingestPublisherRows(state, rows.map((row) => ({ bbl: row.bbl, lat: row.lat, lon: row.lon })));
    // Requested ids with no returned feature are accounted absent — the
    // publisher's population statement, not a truncation.
    const returnedInBatch = new Set(rows.map((row) => row.objectid));
    const absent = batch.filter((id) => !returnedInBatch.has(id));
    state.accounting.publisher_rows += absent.length;
    state.accounting.excluded_rows.publisher_absent += absent.length;
    opts.onProgress?.(Math.min(offset + batchSize, ids.length), ids.length);
  }
  objectAccounting.object_ids_absent = objectAccounting.object_ids_enumerated - objectAccounting.object_ids_returned;
  return {
    objectAccounting,
    sha256: rowsAcquired.digest("hex"),
    endpoint: endpoint,
  };
}

/**
 * Collect the distinct PAD-referenced BBLs from a committed address index.
 * @param {string} addressIndexDir directory holding manifest.json + shards
 * @returns {Promise<Set<string>>}
 */
export async function collectPadReferencedBbls(addressIndexDir) {
  const manifest = JSON.parse(await readFile(path.join(addressIndexDir, "manifest.json"), "utf8"));
  assert.ok(manifest?.shards && typeof manifest.shards === "object", "address-index manifest has no shards");
  const bbls = new Set();
  for (const descriptor of Object.values(manifest.shards)) {
    const shard = JSON.parse(await readFile(path.join(addressIndexDir, path.basename(descriptor.file)), "utf8"));
    for (const records of Object.values(shard.streets || {})) {
      for (const record of records) {
        const bbl = record?.[3];
        if (typeof bbl === "string" && /^[1-5]\d{9}$/.test(bbl)) bbls.add(bbl);
      }
    }
  }
  return bbls;
}

/**
 * Assemble the generation: manifest + 256 shard documents.
 * @param {object} opts
 * @param {object} opts.state ingest state (byBbl / accounting)
 * @param {Set<string>} opts.padBbls PAD-referenced BBLs
 * @param {object} opts.source retained source receipt (kind, publisher, sha256, ...)
 * @param {string} opts.mode mappluto_pluto_csv | mappluto_arcgis_batch
 * @param {object} [opts.objectAccounting] ArcGIS id accounting when mode is arcgis
 * @param {string} opts.generatedAt
 * @param {{ started_at: string, completed_at: string, duration_ms: number }} opts.build timing receipt
 */
export function buildParcelGeographyGeneration(opts) {
  const { state, padBbls, source, mode, generatedAt, build } = opts;
  const accounting = finishAccounting(state);
  const retainedBbls = Object.keys(state.byBbl).sort();
  const padOnlyUnmatched = [...padBbls].filter((bbl) => !state.byBbl[bbl]).sort();
  const versions = [...state.versions].sort();
  const coordinateVintage = versions.length === 1
    ? (source.kind === "pluto_csv" ? `pluto_${versions[0]}` : `mappluto_${versions[0]}`)
    : (versions.length ? `mixed:${versions.join("+")}` : `${mode}`);

  const shards = new Map();
  for (let index = 0; index < PARCEL_GEOGRAPHY_SHARD_COUNT; index += 1) {
    const key = index.toString(16).padStart(2, "0");
    shards.set(key, { schema: PARCEL_GEOGRAPHY_SHARD_SCHEMA, key, parcels: {} });
  }
  for (const bbl of retainedBbls) {
    const key = parcelShardKey(bbl);
    shards.get(key).parcels[bbl] = state.byBbl[bbl];
  }

  const manifest = {
    schema: PARCEL_GEOGRAPHY_MANIFEST_SCHEMA,
    generated_at: generatedAt,
    delivery_tier: "committed-citywide-parcel-point-snapshot",
    mode: String(mode || ""),
    point_method: PARCEL_GEOGRAPHY_POINT_METHOD,
    coordinate_vintage: coordinateVintage,
    max_age_days: 120,
    source,
    shard_count: PARCEL_GEOGRAPHY_SHARD_COUNT,
    coverage: {
      ...accounting,
      arcgis: opts.objectAccounting || null,
      pad_referenced_bbls: padBbls.size,
      pad_only_unmatched: padOnlyUnmatched.length,
      pad_only_unmatched_file: `./${PAD_ONLY_UNMATCHED_FILE}`,
      statement:
        "Covers the official MapPLUTO tax-lot population with published parcel points. PAD parcel references without usable coordinates are reported as pad-only unmatched and remain missing; they never receive fabricated points.",
    },
    build,
    shards: {},
  };
  return { manifest, shards, padOnlyUnmatched };
}

export function renderParcelShard(shard) {
  return `${JSON.stringify(shard)}\n`;
}

/**
 * Verify a generation directory end to end: manifest serve gate, every shard
 * digest/bytes/count, deterministic placement, coordinate sanity, pad-only
 * separation, and accounting identities. Used on staging before activation and
 * on the committed tree for --check.
 * @param {string} dir
 * @param {{ minParcels?: number }} [opts] replay/rehearsal floor override
 */
export async function verifyParcelGeographyGeneration(dir, opts = {}) {
  const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
  assertParcelGeographyServeGate(manifest, { minParcels: opts.minParcels });
  const shardKeys = Object.keys(manifest.shards || {});
  assert.equal(shardKeys.length, PARCEL_GEOGRAPHY_SHARD_COUNT, "manifest must describe exactly 256 shards");
  let totalParcels = 0;
  const seenPadOnly = new Set();
  const coverage = manifest.coverage || {};
  const padOnlyCount = Number(coverage.pad_only_unmatched || 0);
  if (padOnlyCount > 0) {
    const padOnly = JSON.parse(await readFile(path.join(dir, PAD_ONLY_UNMATCHED_FILE), "utf8"));
    assert.ok(Array.isArray(padOnly), "pad-only unmatched file must be a JSON array");
    assert.equal(padOnly.length, padOnlyCount, "pad-only unmatched file length must match the manifest count");
    assert.deepEqual([...padOnly].sort(), padOnly, "pad-only unmatched file must be sorted and deduplicated");
    for (const bbl of padOnly) seenPadOnly.add(bbl);
  }
  for (const key of shardKeys) {
    assert.match(key, /^[0-9a-f]{2}$/, `shard key ${key} must be two hex digits`);
    const descriptor = manifest.shards[key] || {};
    const shardPath = path.join(dir, path.basename(descriptor.file || `${key}.json`));
    const content = await readFile(shardPath);
    assert.ok(content.byteLength <= PARCEL_GEOGRAPHY_MAX_SHARD_BYTES, `${key} exceeds the static-host shard limit`);
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      descriptor.sha256,
      `${key} shard digest drifted`,
    );
    assert.equal(content.byteLength, descriptor.bytes, `${key} shard byte count drifted`);
    const shard = JSON.parse(content);
    assert.equal(shard.schema, PARCEL_GEOGRAPHY_SHARD_SCHEMA, `${key} shard schema drifted`);
    assert.equal(shard.key, key, `${key} shard key mismatch`);
    const bbls = Object.keys(shard.parcels || {});
    assert.equal(bbls.length, descriptor.parcels, `${key} parcel count drifted`);
    for (const bbl of bbls) {
      assert.equal(parcelShardKey(bbl), key, `BBL ${bbl} is not in its deterministic shard`);
      const entry = parcelPointEntry(bbl, shard.parcels[bbl]);
      assert.ok(entry, `BBL ${bbl} carries a non-usable point in ${key}`);
      const stored = shard.parcels[bbl];
      assert.deepEqual(entry, { lat: stored.lat, lon: stored.lon }, `BBL ${bbl} point drifted in ${key}`);
      for (const field of Object.keys(stored)) {
        // The membership build stage attaches typed memberships additively;
        // no other field may ride along on a parcel entry.
        assert.ok(
          field === "lat" || field === "lon" || field === "memberships",
          `BBL ${bbl} carries unexpected parcel field ${field} in ${key}`,
        );
      }
      assert.ok(!seenPadOnly.has(bbl), `BBL ${bbl} is both retained and pad-only unmatched`);
    }
    totalParcels += bbls.length;
  }
  assert.equal(totalParcels, Number(coverage.retained_parcels), "retained parcel total drifted");
  const excludedSum = Object.values(coverage.excluded_rows || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  assert.equal(
    Number(coverage.retained_rows) + Number(coverage.duplicate_rows) + excludedSum,
    Number(coverage.publisher_rows),
    "generation accounting broken: rows must sum back to the publisher denominator",
  );
  const padReferenced = Number(coverage.pad_referenced_bbls);
  assert.ok(
    !(Number.isFinite(padReferenced) && padOnlyCount > padReferenced),
    "pad-only unmatched cannot exceed the PAD-referenced population",
  );
  const manifestStat = await stat(path.join(dir, MANIFEST_FILE));
  assert.ok(manifestStat.isFile(), "manifest must be a regular file");
  return manifest;
}
