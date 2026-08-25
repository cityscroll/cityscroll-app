#!/usr/bin/env node
/**
 * Materialize a bounded BBL → MapPLUTO centroid lookup for Land exact pins.
 *
 * Build-time only. Resident Land reads use the committed JSON; never call
 * ArcGIS / MapPLUTO from the browser hot path.
 *
 * Usage:
 *   node tools/build_bbl_mappluto_centroids.mjs --from-pluto-csv /path/to/pluto.csv
 *   node tools/build_bbl_mappluto_centroids.mjs --from-arcgis
 *   node tools/build_bbl_mappluto_centroids.mjs --check
 *   node tools/build_bbl_mappluto_centroids.mjs --fixture
 */

import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  BBL_MAPPLUTO_CENTROID_CANARIES,
  assertBblMapplutoCentroidsServeGate,
  buildBblMapplutoCentroidsDoc,
  collectSellFacingBbls,
  normalizeBbl,
  sellFacingProjectIds,
} from "../site/bbl_mappluto_centroids.mjs";
import { publicPayloadFindings } from "./lib/public_payload_integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = path.join(ROOT, "site", "data", "bbl_mappluto_centroids_lookup.json");
const PROJECTS_LOOKUP = path.join(ROOT, "site", "data", "zap_projects_warehouse_lookup.json");
const BBL_LOOKUP = path.join(ROOT, "site", "data", "zap_bbl_warehouse_lookup.json");
const MAPPLUTO_QUERY =
  "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
const DEFAULT_PLUTO_CANDIDATES = [
  process.env.CROL_PLUTO_CSV,
  path.join(ROOT, "warehouse", "raw", "mappluto", "pluto_latest.csv"),
  path.join(os.homedir(), "dev", "nyc-neighborhood-warehouse", "raw_data", "pluto", "pluto_latest.csv"),
].filter(Boolean);

function parseArgs(argv) {
  const out = {
    check: false,
    fixture: false,
    fromArcgis: false,
    fromPlutoCsv: null,
    limit: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") out.check = true;
    else if (arg === "--fixture") out.fixture = true;
    else if (arg === "--from-arcgis") out.fromArcgis = true;
    else if (arg === "--from-pluto-csv") out.fromPlutoCsv = argv[++i];
    else if (arg === "--limit") out.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolvePlutoCsv(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`PLUTO CSV not found: ${explicit}`);
    return explicit;
  }
  for (const candidate of DEFAULT_PLUTO_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function extractCentroidsFromPlutoCsv(csvPath, wantedBbls) {
  const wanted = wantedBbls instanceof Set ? wantedBbls : new Set(wantedBbls);
  const byBbl = Object.create(null);
  const stream = createReadStream(csvPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let bblIdx = -1;
  let latIdx = -1;
  let lonIdx = -1;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map((h) => String(h || "").trim());
      bblIdx = headers.findIndex((h) => /^bbl$/i.test(h));
      latIdx = headers.findIndex((h) => /^latitude$/i.test(h));
      lonIdx = headers.findIndex((h) => /^longitude$/i.test(h));
      if (bblIdx < 0 || latIdx < 0 || lonIdx < 0) {
        throw new Error(`PLUTO CSV missing BBL/latitude/longitude columns in ${csvPath}`);
      }
      continue;
    }
    if (!line) continue;
    const cols = parseCsvLine(line);
    const bbl = normalizeBbl(cols[bblIdx]);
    if (!bbl || !wanted.has(bbl) || byBbl[bbl]) continue;
    const lat = Number(cols[latIdx]);
    const lon = Number(cols[lonIdx]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    byBbl[bbl] = { lat, lon };
    if (Object.keys(byBbl).length >= wanted.size) break;
  }
  return {
    byBbl,
    source: {
      kind: "pluto_csv",
      path: path.isAbsolute(csvPath) && csvPath.startsWith(ROOT)
        ? path.relative(ROOT, csvPath)
        : "external:pluto_latest.csv",
      publisher: "NYC Department of City Planning MapPLUTO/PLUTO",
    },
    mode: "mappluto_pluto_csv",
  };
}

async function fetchArcgisChunk(bbls) {
  const where = `BBL IN (${bbls.map((bbl) => String(Number(bbl))).join(",")})`;
  const url = new URL(MAPPLUTO_QUERY);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "BBL,Latitude,Longitude");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("resultRecordCount", String(Math.max(bbls.length, 1)));
  url.searchParams.set("f", "json");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "cityscroll-bbl-mappluto-centroids/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`MapPLUTO ArcGIS HTTP ${response.status} for ${bbls.length} BBLs`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`MapPLUTO ArcGIS error: ${JSON.stringify(payload.error)}`);
  }
  const byBbl = Object.create(null);
  for (const feature of payload?.features || []) {
    const attrs = feature?.attributes || {};
    const bbl = normalizeBbl(attrs.BBL);
    const lat = Number(attrs.Latitude);
    const lon = Number(attrs.Longitude);
    if (!bbl || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    byBbl[bbl] = { lat, lon };
  }
  return byBbl;
}

async function extractCentroidsFromArcgis(wantedBbls, { limit = null } = {}) {
  let list = [...wantedBbls];
  if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit);
  const byBbl = Object.create(null);
  const chunkSize = 80;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const part = await fetchArcgisChunk(chunk);
    Object.assign(byBbl, part);
    if (i + chunkSize < list.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return {
    byBbl,
    source: {
      kind: "arcgis_batch",
      endpoint: MAPPLUTO_QUERY,
      publisher: "NYC Department of City Planning MapPLUTO FeatureServer",
      requested: list.length,
      matched: Object.keys(byBbl).length,
    },
    mode: "mappluto_arcgis_batch",
  };
}

function fixtureExtract(wantedBbls) {
  const byBbl = Object.create(null);
  // Stable fixture points near Brooklyn/Manhattan for offline CI.
  const seed = {
    "3012660036": { lat: 40.6696224, lon: -73.9557834 },
    "1017670001": { lat: 40.7995, lon: -73.9412 },
    "1017670002": { lat: 40.7996, lon: -73.9411 },
  };
  for (const bbl of wantedBbls) {
    if (seed[bbl]) byBbl[bbl] = seed[bbl];
  }
  for (const bbl of Object.keys(BBL_MAPPLUTO_CENTROID_CANARIES)) {
    byBbl[bbl] = seed[bbl] || { lat: 40.6696224, lon: -73.9557834 };
  }
  return {
    byBbl,
    source: {
      kind: "fixture",
      publisher: "test fixture — not for production serve",
    },
    mode: "mappluto_pluto_csv",
  };
}

function writeDoc(doc) {
  mkdirSync(path.dirname(OUT_SITE), { recursive: true });
  const rendered = stableStringify(doc);
  writeFileSync(OUT_SITE, rendered);
  return { path: OUT_SITE, bytes: Buffer.byteLength(rendered) };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.fixture && (args.fromArcgis || args.fromPlutoCsv)) {
    throw new Error("Cannot combine --fixture with live/CSV extract flags");
  }
  if (args.fromArcgis && args.fromPlutoCsv) {
    throw new Error("Cannot combine --from-arcgis and --from-pluto-csv");
  }

  if (args.check && !args.fixture && !args.fromArcgis && !args.fromPlutoCsv) {
    assert.ok(existsSync(OUT_SITE), `${path.relative(ROOT, OUT_SITE)} missing`);
    const committed = readJson(OUT_SITE);
    assertBblMapplutoCentroidsServeGate(committed);
    assert.deepEqual(
      publicPayloadFindings(committed, { source: path.relative(ROOT, OUT_SITE) }),
      [],
      "BBL MapPLUTO centroids public materialization contains test-only records",
    );
    console.log(
      `ok serve-gate ${path.relative(ROOT, OUT_SITE)} ` +
        `coverage=${(committed.coverage.rate * 100).toFixed(2)}% ` +
        `bbls=${committed.bbl_count}`,
    );
    return;
  }

  assert.ok(existsSync(PROJECTS_LOOKUP), "zap_projects_warehouse_lookup.json missing");
  assert.ok(existsSync(BBL_LOOKUP), "zap_bbl_warehouse_lookup.json missing");
  const projectsDoc = readJson(PROJECTS_LOOKUP);
  const bblDoc = readJson(BBL_LOOKUP);
  const projectIds = sellFacingProjectIds(projectsDoc);
  const collected = collectSellFacingBbls(bblDoc, projectIds);
  let wanted = collected.bbls;
  // Coverage denominator excludes canary-only extras that are not in zap_bbl.
  const sellFacingUniverse = wanted.filter((bbl) => {
    if (!Object.prototype.hasOwnProperty.call(BBL_MAPPLUTO_CENTROID_CANARIES, bbl)) return true;
    return (bblDoc.rows || []).some(
      (row) => Array.isArray(row.bbls) && row.bbls.map((value) => normalizeBbl(value)).includes(bbl),
    );
  });
  // Always request canaries even when absent from WH-06.
  wanted = [...new Set([...wanted, ...Object.keys(BBL_MAPPLUTO_CENTROID_CANARIES)])].sort();
  if (Number.isFinite(args.limit) && args.limit > 0) {
    wanted = wanted.slice(0, args.limit);
    for (const bbl of Object.keys(BBL_MAPPLUTO_CENTROID_CANARIES)) {
      if (!wanted.includes(bbl)) wanted.push(bbl);
    }
  }

  let extracted;
  if (args.fixture) {
    extracted = fixtureExtract(wanted);
  } else if (args.fromArcgis) {
    extracted = await extractCentroidsFromArcgis(wanted, { limit: args.limit });
  } else {
    const csvPath = resolvePlutoCsv(args.fromPlutoCsv);
    if (!csvPath) {
      throw new Error(
        "No PLUTO CSV found. Pass --from-pluto-csv PATH, set CROL_PLUTO_CSV, or use --from-arcgis",
      );
    }
    extracted = await extractCentroidsFromPlutoCsv(csvPath, wanted);
  }

  const doc = buildBblMapplutoCentroidsDoc({
    byBbl: extracted.byBbl,
    sellFacingBbls: sellFacingUniverse,
    mode: extracted.mode,
    materializedAt: new Date().toISOString(),
    source: extracted.source,
  });

  assert.deepEqual(
    publicPayloadFindings(doc, { source: path.relative(ROOT, OUT_SITE) }),
    [],
    "BBL MapPLUTO centroids public materialization contains test-only records",
  );

  if (!args.fixture) {
    assertBblMapplutoCentroidsServeGate(doc);
  }

  if (args.check) {
    assert.ok(existsSync(OUT_SITE), `${path.relative(ROOT, OUT_SITE)} missing`);
    const committed = readJson(OUT_SITE);
    assert.equal(
      stableStringify(committed),
      stableStringify({ ...doc, materialized_at: committed.materialized_at }),
      `${path.relative(ROOT, OUT_SITE)} is stale; rebuild without --check`,
    );
    assertBblMapplutoCentroidsServeGate(committed);
    console.log(`ok byte-check ${path.relative(ROOT, OUT_SITE)}`);
    return;
  }

  const written = writeDoc(doc);
  console.log(
    `wrote ${path.relative(ROOT, written.path)} (${written.bytes} bytes) ` +
      `mode=${doc.mode} coverage=${(doc.coverage.rate * 100).toFixed(2)}% ` +
      `matched=${doc.coverage.matched}/${doc.coverage.sell_facing_bbl_count} ` +
      `canary=${doc.coverage.canaries["3012660036"]?.status}`,
  );
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
