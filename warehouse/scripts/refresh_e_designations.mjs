#!/usr/bin/env node
/** Refresh the retained E-Designations source slice used by the deterministic LDP-15 builder. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET_ID = "hxm3-23vy";
const SOURCE_PATH = "warehouse/fixtures/e-designations/source.v1.json";
const RECEIPT_PATH = "warehouse/receipts/proof/e_designation_source_latest.json";
const read = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
const stable = (value) => `${JSON.stringify(value, null, 2)}\n`;

const projects = read("site/data/zap_projects_warehouse_lookup.json").rows;
const projectIds = new Set(projects.map((row) => row.project_id));
const lots = read("site/data/zap_bbl_warehouse_lookup.json").rows;
const eligibleLots = new Set(lots.filter((row) => projectIds.has(row.project_id)).flatMap((row) => row.bbls || []));

const sourceResponse = await fetch(`https://data.cityofnewyork.us/resource/${DATASET_ID}.json?$select=*,%20:id&$order=:id&$limit=50000`);
if (!sourceResponse.ok) throw new Error(`E-Designations fetch failed: ${sourceResponse.status}`);
const allRows = await sourceResponse.json();
const metadataResponse = await fetch(`https://data.cityofnewyork.us/api/views/${DATASET_ID}`);
if (!metadataResponse.ok) throw new Error(`E-Designations metadata fetch failed: ${metadataResponse.status}`);
const metadata = await metadataResponse.json();
const sourceVintage = new Date(Number(metadata.rowsUpdatedAt) * 1000).toISOString().slice(0, 10);
const retainedRows = allRows.filter((row) => eligibleLots.has(String(row.bbl || "").padStart(10, "0")));
const source = { dataset_id: DATASET_ID, source_vintage: sourceVintage, rows: retainedRows };
const receipt = {
  schema: "cityscroll.e_designation_source_receipt.v1",
  dataset_id: DATASET_ID,
  source_vintage: sourceVintage,
  source_url: `https://data.cityofnewyork.us/resource/${DATASET_ID}.json`,
  source_row_count: allRows.length,
  eligible_project_count: projects.length,
  eligible_lot_count: eligibleLots.size,
  retained_row_count: retainedRows.length,
  retention_basis: "exact BBL membership in the committed Land project universe",
};
writeFileSync(path.join(ROOT, SOURCE_PATH), stable(source));
writeFileSync(path.join(ROOT, RECEIPT_PATH), stable(receipt));
console.log(`refreshed E-Designations source slice: ${retainedRows.length}/${allRows.length} rows at ${sourceVintage}`);
