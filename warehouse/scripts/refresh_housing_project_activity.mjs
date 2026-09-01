#!/usr/bin/env node
/** Refresh the retained Housing Database project-level slice used by the deterministic LDP-17 builder. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET_ID = "br6q-ssj3";
const SOURCE_PATH = "warehouse/fixtures/housing-project-activity/source.v1.json";
const RECEIPT_PATH = "warehouse/receipts/proof/housing_project_activity_source_latest.json";
const RETAINED_FIELDS = [
  ":id", "job_number", "job_type", "job_status", "residflag", "bbl", "boro", "bin",
  "classainit", "classaprop", "classanet", "units_co", "job_desc",
  "datefiled", "datepermit", "datecomplt", "compltyear", "permityear", "ownership", "version",
];
const read = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
const stable = (value) => `${JSON.stringify(value, null, 2)}\n`;
const bbl = (value) => String(value ?? "").trim().replace(/\.0$/, "").padStart(10, "0");

const projects = read("site/data/zap_projects_warehouse_lookup.json").rows;
const projectIds = new Set(projects.map((row) => row.project_id));
const lotRows = read("site/data/zap_bbl_warehouse_lookup.json").rows;
const eligibleLots = [...new Set(lotRows.filter((row) => projectIds.has(row.project_id)).flatMap((row) => (row.bbls || []).map(bbl)))].sort();

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Housing Database request failed: ${response.status} ${url}`);
  return response.json();
}

const metadata = await getJson(`https://data.cityofnewyork.us/api/views/${DATASET_ID}`);
const sourceVintage = new Date(Number(metadata.rowsUpdatedAt) * 1000).toISOString().slice(0, 10);

// Query by exact BBL membership so acquisition stays bounded to the committed Land project universe.
const retained = new Map();
const CHUNK = 100;
for (let index = 0; index < eligibleLots.length; index += CHUNK) {
  const chunk = eligibleLots.slice(index, index + CHUNK);
  const params = new URLSearchParams({
    $select: RETAINED_FIELDS.join(","),
    $where: `bbl in(${chunk.map((lot) => `'${lot}'`).join(",")})`,
    $order: ":id",
    $limit: "5000",
  });
  for (const row of await getJson(`https://data.cityofnewyork.us/resource/${DATASET_ID}.json?${params}`)) {
    const normalized = Object.fromEntries(RETAINED_FIELDS.map((field) => [field, row[field] ?? null]));
    normalized.bbl = bbl(row.bbl);
    retained.set(String(row[":id"]), normalized);
  }
}

const rows = [...retained.values()].sort((a, b) => String(a[":id"]).localeCompare(String(b[":id"])));
const source = { dataset_id: DATASET_ID, source_vintage: sourceVintage, retained_fields: RETAINED_FIELDS, rows };
const receipt = {
  schema: "cityscroll.housing_project_activity_source_receipt.v1",
  dataset_id: DATASET_ID,
  dataset_name: "Housing Database Project Level Files",
  source_vintage: sourceVintage,
  source_url: `https://data.cityofnewyork.us/resource/${DATASET_ID}.json`,
  eligible_project_count: projects.length,
  eligible_lot_count: eligibleLots.length,
  retained_row_count: rows.length,
  retained_fields: RETAINED_FIELDS,
  retention_basis: "exact BBL membership in the committed Land project universe",
  acquisition: "scheduled_warehouse_materialization",
};
writeFileSync(path.join(ROOT, SOURCE_PATH), stable(source));
writeFileSync(path.join(ROOT, RECEIPT_PATH), stable(receipt));
console.log(`refreshed Housing Database slice: ${rows.length} rows over ${eligibleLots.length} exact lots at ${sourceVintage}`);
