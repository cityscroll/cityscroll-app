import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_COUNTS,
  FORBIDDEN_PUBLIC_NYC_FIELDS,
  NAICS_CATALOG_SCHEMA,
  NYC_COMMODITY_STATUS_SCHEMA,
  RETAINED_SOURCE_DIGESTS,
  assertPublicNycPayload,
  lookupNyc,
  publicProjection,
  validateCatalogActivation,
} from "../site/procurement_code_catalog.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const NAICS_PATH = join(ROOT, "site/data/procurement_codes/naics-2022.json");
const NYC_PATH = join(ROOT, "site/data/procurement_codes/nyc-commodity-status.json");
const MANIFEST_PATH = join(ROOT, "site/data/procurement_code_catalog_manifest.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("retained complete sources yield expected NAICS and NYC public counts", () => {
  const naics = readJson(NAICS_PATH);
  const nyc = readJson(NYC_PATH);
  assert.equal(naics.schema, NAICS_CATALOG_SCHEMA);
  assert.equal(nyc.schema, NYC_COMMODITY_STATUS_SCHEMA);
  assert.equal(naics.records.length, EXPECTED_COUNTS.naicsNodes);
  assert.equal(naics.records.filter((row) => row.level === 6).length, EXPECTED_COUNTS.naicsIndustries);
  assert.equal(nyc.records.length, EXPECTED_COUNTS.nycNumericRows);
  assert.equal(nyc.records.filter((row) => row.status === "listed").length, EXPECTED_COUNTS.nycListed);
  assert.equal(nyc.records.filter((row) => row.status === "inactive").length, EXPECTED_COUNTS.nycInactive);
  assert.equal(nyc.records.length + nyc.omitted_internal_rows, nyc.source_rows);
  assert.equal(nyc.source_rows, EXPECTED_COUNTS.nycSourceRows);
  assert.equal(naics.source_sha256, RETAINED_SOURCE_DIGESTS["procurement-codes-naics-2022"]);
  assert.equal(
    nyc.source_sha256,
    RETAINED_SOURCE_DIGESTS["procurement-codes-nyc-commodity-directory"],
  );
});

test("public NAICS keeps labels and hierarchy; public NYC is code/status only", () => {
  const naics = readJson(NAICS_PATH);
  const nycText = readFileSync(NYC_PATH, "utf8");
  const nyc = JSON.parse(nycText);
  assert.ok(naics.records.every((row) => typeof row.label === "string" && row.label.length > 0));
  assert.ok(naics.records.some((row) => Array.isArray(row.parents) && row.parents.length > 0));
  assert.ok(nyc.records.every((row) => Object.keys(row).sort().join(",") === "code,status"));
  assertPublicNycPayload(nycText);
  for (const field of FORBIDDEN_PUBLIC_NYC_FIELDS) {
    assert.equal(nycText.includes(`"${field}":`), false, `leaked ${field}`);
  }
  assert.ok(Buffer.byteLength(nycText) < 512 * 1024);
});

test("exact NYC lookup rejects prefix, non-numeric, unknown, inactive, and edition mismatch", () => {
  const nyc = readJson(NYC_PATH);
  assert.equal(lookupNyc(nyc, "02081").status, "listed");
  assert.equal(lookupNyc(nyc, "020").status, "invalid_code");
  assert.equal(lookupNyc(nyc, "GENEN").status, "invalid_code");
  assert.equal(lookupNyc(nyc, "99999").status, "unknown");
  assert.equal(lookupNyc(nyc, "02081", "wrong").status, "unknown_version");
  const inactive = nyc.records.find((row) => row.status === "inactive");
  assert.ok(inactive);
  assert.equal(lookupNyc(nyc, inactive.code).status, "inactive");
});

test("manifest activation checks schema, counts, and unique codes", () => {
  const manifest = readJson(MANIFEST_PATH);
  const naics = readJson(NAICS_PATH);
  const nyc = readJson(NYC_PATH);
  const naicsEntry = validateCatalogActivation({ manifest, artifact: naics, scheme: "NAICS" });
  const nycEntry = validateCatalogActivation({ manifest, artifact: nyc, scheme: "NYC_COMMODITY" });
  assert.equal(naicsEntry.records, EXPECTED_COUNTS.naicsNodes);
  assert.equal(nycEntry.records, EXPECTED_COUNTS.nycNumericRows);
  assert.match(naicsEntry.sha256, /^[0-9a-f]{64}$/);
  assert.match(nycEntry.sha256, /^[0-9a-f]{64}$/);
});

test("publicProjection helper mirrors committed public boundaries", () => {
  const projected = publicProjection({
    observed_at: "2026-11-11T04:00:00.000Z",
    catalogs: [
      {
        scheme: "NAICS",
        version: "2022",
        url: "https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx",
        sha256: RETAINED_SOURCE_DIGESTS["procurement-codes-naics-2022"],
      },
      {
        scheme: "NYC_COMMODITY",
        version: "snapshot-2026-11-11-6325fbf06b26",
        url: "https://www.nyc.gov/assets/mocs/downloads/PASSPort/learning-to-use-passport/NYCCommodityClassificationDirectory.xlsx",
        sha256: RETAINED_SOURCE_DIGESTS["procurement-codes-nyc-commodity-directory"],
        data_rows: 9041,
      },
    ],
    records: [
      {
        scheme: "NAICS",
        version: "2022",
        code: "11",
        label: "Agriculture",
        level: 2,
        status: "listed",
        parents: [],
      },
      {
        scheme: "NYC_COMMODITY",
        version: "snapshot-2026-11-11-6325fbf06b26",
        code: "02081",
        label: "secret label",
        level: 5,
        status: "listed",
        parents: ["02"],
        industry: "hidden",
      },
      {
        scheme: "NYC_COMMODITY",
        version: "snapshot-2026-11-11-6325fbf06b26",
        code: "GENEN",
        label: "internal",
        level: 5,
        status: "unclassified",
        parents: [],
      },
    ],
  });
  assert.equal(projected.naics.records.length, 1);
  assert.equal(projected.naics.records[0].label, "Agriculture");
  assert.deepEqual(projected.nyc.records, [{ code: "02081", status: "listed" }]);
  assert.equal(projected.nyc.omitted_internal_rows, 3);
});
