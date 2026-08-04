#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNeighborhood } from "../site/neighborhood_search.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_ID = "9nt8-h7nd";
const SOURCE_URL = `https://data.cityofnewyork.us/resource/${DATASET_ID}.json`;
const META_URL = `https://data.cityofnewyork.us/api/views/${DATASET_ID}`;
const OUT = resolve(ROOT, "site/data/neighborhood_gazetteer.json");
const RECEIPT = resolve(ROOT, "site/data/neighborhood_gazetteer_receipt.json");

// Aliases are deliberately small and reviewable. Targets are official NTA names
// after directional parts (East/West) are combined by canonicalName().
export const CURATED_ALIASES = Object.freeze({
  "Bedford-Stuyvesant": ["Bed-Stuy", "Bed Stuy", "Bedford Stuyvesant"],
  "SoHo-Little Italy-Hudson Square": ["SoHo", "Soho", "South of Houston"],
  "St. George-New Brighton": ["Saint George", "St George", "New Brighton"],
  "Washington Heights": ["Washington Heights South", "Washington Heights North"],
  "Chelsea-Hudson Yards": ["Chelsea", "Hudson Yards"],
  "Midtown South-Flatiron-Union Square": ["Flatiron", "Union Square"],
  "Park Slope": ["Park Slope-Gowanus"],
  "East Harlem": ["El Barrio", "Spanish Harlem"],
  "Hell's Kitchen": ["Clinton", "Hells Kitchen"],
  "Coney Island-Sea Gate": ["Coney Island"],
  "East Flatbush-Erasmus": ["East Flatbush"],
  "Downtown Brooklyn-DUMBO-Boerum Hill": ["Downtown Brooklyn", "DUMBO"],
  "Carroll Gardens-Cobble Hill-Gowanus-Red Hook": ["Red Hook"],
  "Long Island City-Hunters Point": ["Long Island City"],
  "Flushing-Willets Point": ["Flushing"],
  "Far Rockaway-Bayswater": ["Far Rockaway"],
  "Fresh Meadows-Utopia": ["Fresh Meadows"],
  "Financial District-Battery Park City": ["Financial District"],
  "Mott Haven-Port Morris": ["Mott Haven"],
  "Fordham Heights": ["Fordham"],
  "Riverdale-Spuyten Duyvil": ["Riverdale"],
  "Pelham Bay-Country Club-City Island": ["Pelham Bay"],
  "Tompkinsville-Stapleton-Clifton-Fox Hills": ["Stapleton"],
  "Tottenville-Charleston": ["Tottenville"],
  "Great Kills-Eltingville": ["Great Kills"],
  "Upper East Side-Carnegie Hill": ["Upper East Side"],
});

// Search-promise fixture: popular residential NTA names plus common public names.
// Kept in the artifact so the promise-parity detector tests exactly what ships.
export const COMMON_NEIGHBORHOODS = Object.freeze([
  "Canarsie", "Bedford-Stuyvesant", "Bed-Stuy", "Williamsburg", "Greenpoint",
  "Bushwick", "Crown Heights", "Park Slope", "Bay Ridge", "Sunset Park",
  "Flatbush", "East Flatbush", "Brownsville", "Bensonhurst", "Coney Island",
  "Brooklyn Heights", "Downtown Brooklyn", "DUMBO", "Prospect Heights", "Red Hook",
  "Astoria", "Long Island City", "Jackson Heights", "Flushing", "Jamaica",
  "Forest Hills", "Sunnyside", "Woodside", "Elmhurst", "Ridgewood",
  "Bayside", "Far Rockaway", "South Ozone Park", "Fresh Meadows", "Queens Village",
  "Harlem", "East Harlem", "Washington Heights", "Inwood", "Upper East Side",
  "Upper West Side", "Chelsea", "SoHo", "Lower East Side", "Financial District",
  "Mott Haven", "Fordham", "Riverdale", "Pelham Bay", "Bedford Park",
  "St. George", "New Brighton", "Stapleton", "Tottenville", "Great Kills",
]);

const CD_PREFIX = Object.freeze({ BK: "K", BX: "X", MN: "M", QN: "Q", SI: "R" });

function canonicalName(name) {
  return String(name || "").replace(/\s+\((?:North|South|East|West|Central)\)$/i, "").trim();
}

function productCd(cdta) {
  const match = String(cdta || "").match(/^(BK|BX|MN|QN|SI)(\d{2})$/);
  return match ? `${CD_PREFIX[match[1]]}${match[2]}` : null;
}

export function buildGazetteer(rows, sourceUpdatedAt = null) {
  const residential = rows.filter((row) => String(row.ntatype) === "0");
  const grouped = new Map();
  for (const row of residential) {
    const name = canonicalName(row.ntaname);
    if (!name) continue;
    if (!grouped.has(name)) grouped.set(name, {
      name,
      borough: row.boroname,
      community_districts: [],
      nta_codes: [],
      official_names: [],
      aliases: [],
    });
    const entry = grouped.get(name);
    const cd = productCd(row.cdta2020);
    if (cd) entry.community_districts.push(cd);
    if (row.nta2020) entry.nta_codes.push(row.nta2020);
    if (row.ntaname && row.ntaname !== name) entry.official_names.push(row.ntaname);
  }
  const neighborhoods = [...grouped.values()].map((entry) => ({
    ...entry,
    community_districts: [...new Set(entry.community_districts)].sort(),
    nta_codes: [...new Set(entry.nta_codes)].sort(),
    official_names: [...new Set(entry.official_names)].sort(),
    aliases: [...new Set([...(CURATED_ALIASES[entry.name] || []), ...entry.official_names])].sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const document = {
    schema: "cityscroll.neighborhood_gazetteer.v1",
    source: {
      agency: "NYC Department of City Planning",
      dataset_id: DATASET_ID,
      dataset_name: "2020 Neighborhood Tabulation Areas (NTAs)",
      url: `https://data.cityofnewyork.us/d/${DATASET_ID}`,
      updated_at: sourceUpdatedAt,
    },
    source_row_count: rows.length,
    residential_nta_count: residential.length,
    neighborhood_count: neighborhoods.length,
    common_neighborhoods: COMMON_NEIGHBORHOODS,
    neighborhoods,
  };
  const missing = COMMON_NEIGHBORHOODS.filter((name) => !resolveNeighborhood(name, document));
  if (missing.length) throw new Error(`common neighborhood fixture does not resolve: ${missing.join(", ")}`);
  return document;
}

async function sourceRows() {
  const fields = "boroname,nta2020,ntaname,ntaabbrev,cdta2020,cdtaname,ntatype";
  const url = `${SOURCE_URL}?%24select=${encodeURIComponent(fields)}&%24limit=500`;
  const [rowsResponse, metaResponse] = await Promise.all([fetch(url), fetch(META_URL)]);
  if (!rowsResponse.ok) throw new Error(`NTA rows HTTP ${rowsResponse.status}`);
  if (!metaResponse.ok) throw new Error(`NTA metadata HTTP ${metaResponse.status}`);
  const rows = await rowsResponse.json();
  const meta = await metaResponse.json();
  return {
    rows,
    updatedAt: meta.rowsUpdatedAt ? new Date(Number(meta.rowsUpdatedAt) * 1000).toISOString() : null,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  const { rows, updatedAt } = await sourceRows();
  const document = buildGazetteer(rows, updatedAt);
  const body = stableJson(document);
  const receipt = {
    schema: "cityscroll.neighborhood_gazetteer_receipt.v1",
    dataset_id: DATASET_ID,
    source_url: `https://data.cityofnewyork.us/d/${DATASET_ID}`,
    source_updated_at: updatedAt,
    source_row_count: document.source_row_count,
    residential_nta_count: document.residential_nta_count,
    neighborhood_count: document.neighborhood_count,
    curated_alias_count: Object.values(CURATED_ALIASES).reduce((sum, aliases) => sum + aliases.length, 0),
    promise_fixture_count: document.common_neighborhoods.length,
    artifact_sha256: createHash("sha256").update(body).digest("hex"),
  };
  if (check) {
    const [current, currentReceipt] = await Promise.all([readFile(OUT, "utf8"), readFile(RECEIPT, "utf8")]);
    if (current !== body || currentReceipt !== stableJson(receipt)) {
      throw new Error("neighborhood gazetteer is stale; run node tools/build_neighborhood_gazetteer.mjs");
    }
    console.log(`neighborhood gazetteer current: ${document.neighborhood_count} names`);
    return;
  }
  await mkdir(dirname(OUT), { recursive: true });
  await Promise.all([writeFile(OUT, body), writeFile(RECEIPT, stableJson(receipt))]);
  console.log(`wrote ${document.neighborhood_count} neighborhood names from ${rows.length} NTA rows`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
