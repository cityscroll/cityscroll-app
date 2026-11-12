#!/usr/bin/env node
/**
 * Rebuild the public procurement code catalog manifest from committed artifacts.
 * Reads public outputs only; never acquires publisher bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);

import {
  CODE_CATALOG_MANIFEST_SCHEMA,
  EXPECTED_COUNTS,
  NAICS_CATALOG_SCHEMA,
  NYC_COMMODITY_CATEGORIES_SCHEMA,
  NYC_COMMODITY_STATUS_SCHEMA,
  assertPublicNycCategoriesPayload,
  assertPublicNycPayload,
  projectL3CategoryIndex,
} from "../site/procurement_code_catalog.mjs";

const ROOT = dirname(dirname(HERE));
const NAICS_PATH = join(ROOT, "site/data/procurement_codes/naics-2022.json");
const NYC_PATH = join(ROOT, "site/data/procurement_codes/nyc-commodity-status.json");
const NYC_CATEGORIES_PATH = join(ROOT, "site/data/procurement_codes/nyc-commodity-categories.json");
const MANIFEST_PATH = join(ROOT, "site/data/procurement_code_catalog_manifest.json");
// The Worker bundles only the 404 L3 rows (the whole categories artifact would sit on its
// startup graph above the per-file JSON budget); derived here so the two never drift.
const WORKER_L3_INDEX_PATH = join(ROOT, "worker/src/data/nyc_commodity_l3_categories.json");

export function buildWorkerL3Index({ nycCategoriesPath = NYC_CATEGORIES_PATH } = {}) {
  const raw = readFileSync(nycCategoriesPath);
  const index = projectL3CategoryIndex(JSON.parse(raw.toString("utf8")), createHash("sha256").update(raw).digest("hex"));
  return `${JSON.stringify(index, null, 1)}\n`;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildProcurementCodeManifest({
  naicsPath = NAICS_PATH,
  nycPath = NYC_PATH,
  nycCategoriesPath = NYC_CATEGORIES_PATH,
  manifestPath = MANIFEST_PATH,
  generatedAt = null,
} = {}) {
  const naicsText = readFileSync(naicsPath, "utf8");
  const nycText = readFileSync(nycPath, "utf8");
  const naics = JSON.parse(naicsText);
  const nyc = JSON.parse(nycText);

  if (naics.schema !== NAICS_CATALOG_SCHEMA) {
    throw new Error(`unexpected NAICS schema ${naics.schema}`);
  }
  if (nyc.schema !== NYC_COMMODITY_STATUS_SCHEMA) {
    throw new Error(`unexpected NYC schema ${nyc.schema}`);
  }
  if (!Array.isArray(naics.records) || naics.records.length !== EXPECTED_COUNTS.naicsNodes) {
    throw new Error(`NAICS record count ${naics.records?.length} != ${EXPECTED_COUNTS.naicsNodes}`);
  }
  const industries = naics.records.filter((row) => row.level === 6).length;
  if (industries !== EXPECTED_COUNTS.naicsIndustries) {
    throw new Error(`NAICS industries ${industries} != ${EXPECTED_COUNTS.naicsIndustries}`);
  }
  if (!Array.isArray(nyc.records) || nyc.records.length !== EXPECTED_COUNTS.nycNumericRows) {
    throw new Error(`NYC record count ${nyc.records?.length} != ${EXPECTED_COUNTS.nycNumericRows}`);
  }
  assertPublicNycPayload(nycText);
  const categoriesText = readFileSync(nycCategoriesPath, "utf8");
  const categories = JSON.parse(categoriesText);
  if (categories.schema !== NYC_COMMODITY_CATEGORIES_SCHEMA) {
    throw new Error(`unexpected NYC categories schema ${categories.schema}`);
  }
  assertPublicNycCategoriesPayload(categories);
  const levelCounts = [1, 2, 3].map((level) => categories.categories.filter((row) => row.level === level).length);
  const wantLevels = [EXPECTED_COUNTS.nycCategoryL1, EXPECTED_COUNTS.nycCategoryL2, EXPECTED_COUNTS.nycCategoryL3];
  if (levelCounts.join(",") !== wantLevels.join(",")) {
    throw new Error(`NYC category level counts ${levelCounts} != ${wantLevels}`);
  }
  if (categories.codes.length !== EXPECTED_COUNTS.nycNumericRows) {
    throw new Error(`NYC category code rows ${categories.codes.length} != ${EXPECTED_COUNTS.nycNumericRows}`);
  }
  if (categories.source_sha256 !== nyc.source_sha256 || categories.version !== nyc.version) {
    throw new Error("NYC categories and NYC status were built from different workbooks");
  }

  const naicsSha = sha256Text(naicsText.endsWith("\n") ? naicsText : `${naicsText}\n`);
  const nycSha = sha256Text(nycText.endsWith("\n") ? nycText : `${nycText}\n`);
  // Hash the exact on-disk bytes.
  const naicsDiskSha = createHash("sha256").update(readFileSync(naicsPath)).digest("hex");
  const nycDiskSha = createHash("sha256").update(readFileSync(nycPath)).digest("hex");
  const categoriesDiskSha = createHash("sha256").update(readFileSync(nycCategoriesPath)).digest("hex");

  const manifest = {
    schema: CODE_CATALOG_MANIFEST_SCHEMA,
    generated_at: generatedAt || naics.checked_at || nyc.checked_at || new Date().toISOString(),
    catalogs: [
      {
        scheme: "NAICS",
        version: naics.version,
        path: "/data/procurement_codes/naics-2022.json",
        sha256: naicsDiskSha,
        records: naics.records.length,
        checked_at: naics.checked_at,
        source_url: naics.source_url,
        source_sha256: naics.source_sha256,
        freshness: {
          checked_at: naics.checked_at,
          acquired_at: naics.source_receipt?.acquired_at || null,
        },
      },
      {
        scheme: "NYC_COMMODITY",
        version: nyc.version,
        path: "/data/procurement_codes/nyc-commodity-status.json",
        sha256: nycDiskSha,
        records: nyc.records.length,
        checked_at: nyc.checked_at,
        source_url: nyc.source_url,
        source_sha256: nyc.source_sha256,
        freshness: {
          checked_at: nyc.checked_at,
          acquired_at: nyc.source_receipt?.acquired_at || null,
        },
      },
      {
        scheme: "NYC_COMMODITY_CATEGORIES",
        version: categories.version,
        path: "/data/procurement_codes/nyc-commodity-categories.json",
        sha256: categoriesDiskSha,
        records: categories.categories.length,
        codes: categories.codes.length,
        counts: {
          l1: levelCounts[0],
          l2: levelCounts[1],
          l3: levelCounts[2],
          codes: categories.codes.length,
        },
        checked_at: categories.checked_at,
        source_url: categories.source_url,
        source_sha256: categories.source_sha256,
        freshness: {
          checked_at: categories.checked_at,
          acquired_at: categories.source_receipt?.acquired_at || null,
        },
      },
    ],
  };

  // Silence unused locals if text hashes were only for future checks.
  void naicsSha;
  void nycSha;

  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.tmp`;
  writeFileSync(tempPath, encoded);
  renameSync(tempPath, manifestPath);
  return manifest;
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  if (check) {
    if (readFileSync(WORKER_L3_INDEX_PATH, "utf8") !== buildWorkerL3Index()) {
      throw new Error("worker/src/data/nyc_commodity_l3_categories.json is stale; rebuild the manifest");
    }
    const current = readJson(MANIFEST_PATH);
    const rebuilt = buildProcurementCodeManifest({
      manifestPath: resolve(ROOT, ".artifacts/procurement_code_catalog_manifest.check.json"),
      generatedAt: current.generated_at,
    });
    rebuilt.generated_at = current.generated_at;
    if (JSON.stringify(rebuilt) !== JSON.stringify(current)) {
      throw new Error("procurement_code_catalog_manifest.json is stale; rebuild it");
    }
    console.log("procurement_code_catalog_manifest.json ok");
    return;
  }
  const manifest = buildProcurementCodeManifest();
  // determinism-lint: allow write explicit build mode emits the declared Worker projection
  writeFileSync(WORKER_L3_INDEX_PATH, buildWorkerL3Index());
  console.log(
    JSON.stringify({
      catalogs: manifest.catalogs.map((row) => ({
        scheme: row.scheme,
        records: row.records,
        sha256: row.sha256,
      })),
    }),
  );
}

if (process.argv[1] && HERE === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
