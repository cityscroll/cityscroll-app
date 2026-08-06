#!/usr/bin/env node
/**
 * Materialize the DOB Certificate Of Occupancy graph slice.
 *
 * The source is bulk-sized, so only rows whose exact ten-digit BBL is already
 * present in the committed parcel graph are published. The raw export stays
 * upstream-side; this artifact is the bounded read model used by the parcel
 * biography.
 *
 *   node tools/build_dob_cofo_lookup.mjs --from-live
 *   node tools/build_dob_cofo_lookup.mjs --check
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = join(ROOT, "site/data/dob_cofo_lookup.json");
const OUT_WORKER = join(ROOT, "worker/src/data/dob_cofo_lookup.json");
const DATASET_ID = "bs8b-p36w";
const DOMAIN = "https://data.cityofnewyork.us";
const SOURCE_URL = `${DOMAIN}/d/${DATASET_ID}`;
const FIELDS = [
  "job_number", "job_type", "c_o_issue_date", "bin_number", "borough",
  "house_number", "street_name", "block", "lot", "postcode",
  "pr_dwelling_unit", "ex_dwelling_unit", "application_status_raw",
  "filing_status_raw", "item_number", "issue_type", "community_board",
  "council_district", "bbl", "bin", "nta",
];

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

export function normalizeBbl(value) {
  const bbl = clean(value, 40).replace(/\.0$/, "");
  return /^\d{10}$/.test(bbl) ? bbl : null;
}

function graphBbls() {
  const out = new Set();
  const zap = JSON.parse(readFileSync(join(ROOT, "site/data/zap_bbl_warehouse_lookup.json"), "utf8"));
  for (const row of zap.rows || []) for (const bbl of row.bbls || []) {
    const normalized = normalizeBbl(bbl);
    if (normalized) out.add(normalized);
  }
  const property = JSON.parse(readFileSync(join(ROOT, "site/data/property_cross_domain_lookup.json"), "utf8"));
  for (const bbl of Object.keys(property.by_bbl || {})) {
    const normalized = normalizeBbl(bbl);
    if (normalized) out.add(normalized);
  }
  return out;
}

function addressFromProperty(row) {
  const location = row?.property_location || {};
  return clean(location.address || location.label || row?.street_address_1, 240).toLowerCase();
}

function propertyAddressByBbl() {
  const out = new Map();
  const doc = JSON.parse(readFileSync(join(ROOT, "site/data/property_domain_observations.json"), "utf8"));
  for (const row of doc.property_rows || []) {
    for (const raw of row.property_location?.bbls || []) {
      const bbl = normalizeBbl(raw);
      const address = addressFromProperty(row);
      if (bbl && address && !out.has(bbl)) out.set(bbl, { value: address, source: "City Record property observations" });
    }
  }
  return out;
}

function shapeRow(row, propertyAddresses) {
  const bbl = normalizeBbl(row.bbl);
  const jobNumber = clean(row.job_number, 80);
  if (!bbl || !jobNumber) return null;
  const shaped = { bbl, job_number: jobNumber };
  // Keep the read model narrow; the full bulk export remains upstream-side.
  const readModelFields = ["job_type", "c_o_issue_date", "issue_type", "application_status_raw", "filing_status_raw"];
  for (const field of readModelFields) {
    if (row[field] !== undefined && row[field] !== null && clean(row[field]) !== "") shaped[field] = row[field];
  }
  const sourceRecordId = `${DATASET_ID}:${jobNumber}`;
  const sourceAddress = clean([row.house_number, row.street_name].filter(Boolean).join(" "), 240).toLowerCase();
  const propertyAddress = propertyAddresses.get(bbl);
  const conflicts = [];
  if (sourceAddress && propertyAddress?.value && sourceAddress !== propertyAddress.value) {
    conflicts.push({
      field: "address",
      values: [
        { value: sourceAddress, source: "DOB Certificate Of Occupancy" },
        { value: propertyAddress.value, source: propertyAddress.source },
      ],
      note: "Both source values are retained; the exact BBL join does not resolve address disagreement.",
    });
  }
  return {
    ...shaped,
    provenance: {
      source_record_id: sourceRecordId,
      observed_at: row.c_o_issue_date || null,
    },
    ...(conflicts.length ? { conflicts } : {}),
  };
}

async function fetchRows() {
  const rows = [];
  let offset = 0;
  for (;;) {
    const url = new URL(`${DOMAIN}/resource/${DATASET_ID}.json`);
    url.searchParams.set("$select", FIELDS.join(","));
    url.searchParams.set("$limit", "50000");
    url.searchParams.set("$offset", String(offset));
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "cityscroll-cofo-acquisition/1.0" } });
    if (!response.ok) throw new Error(`DOB CofO fetch failed: HTTP ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 50000) return rows;
    offset += page.length;
  }
}

export function buildDobCofoDoc(sourceRows, { sourceGeneratedAt = null } = {}) {
  const eligible = graphBbls();
  const propertyAddresses = propertyAddressByBbl();
  const byBbl = {};
  for (const row of sourceRows || []) {
    const shaped = shapeRow(row, propertyAddresses);
    if (!shaped || !eligible.has(shaped.bbl)) continue;
    (byBbl[shaped.bbl] ||= []).push(shaped);
  }
  const linked = Object.keys(byBbl).length;
  return {
    schema_version: 1,
    version: "dob_cofo_lookup_v1",
    dataset_id: DATASET_ID,
    source_url: SOURCE_URL,
    generated_at: new Date().toISOString(),
    source_generated_at: sourceGeneratedAt,
    method: "exact_bbl_v1",
    observed_only: true,
    by_bbl: byBbl,
    coverage: {
      eligible: eligible.size,
      linked,
      rate: eligible.size ? Number((linked / eligible.size).toFixed(4)) : 0,
      denominator: "distinct exact ten-digit BBLs in the committed parcel graph",
      source_rows_linked: Object.values(byBbl).reduce((count, rows) => count + rows.length, 0),
      gap: "Only exact BBLs already present in the committed graph are published; absent CofO rows are not evidence of no legal occupancy record.",
    },
    provenance: {
      source: "NYC Department of Buildings, DOB Certificate Of Occupancy",
      source_dataset: DATASET_ID,
      source_url: SOURCE_URL,
      key: "bbl",
      graph_sources: ["site/data/zap_bbl_warehouse_lookup.json", "site/data/property_cross_domain_lookup.json"],
      row_provenance: "Each published row carries source_record_id, source_fields, source_url, and observed_at.",
      conflict_policy: "Conflicting address values remain visible with both source names; no value is selected by inference.",
    },
  };
}

function checkDoc(doc) {
  if (doc?.version !== "dob_cofo_lookup_v1" || doc?.dataset_id !== DATASET_ID) throw new Error("invalid DOB CofO artifact identity");
  if (doc.method !== "exact_bbl_v1" || doc.observed_only !== true) throw new Error("DOB CofO artifact is not exact and observed-only");
  if (!doc.coverage || doc.coverage.linked !== Object.keys(doc.by_bbl || {}).length) throw new Error("DOB CofO coverage does not match by_bbl");
  for (const [bbl, rows] of Object.entries(doc.by_bbl || {})) {
    if (!/^\d{10}$/.test(bbl) || !Array.isArray(rows)) throw new Error(`invalid DOB CofO BBL bucket ${bbl}`);
    for (const row of rows) {
      if (row.bbl !== bbl || !row.provenance?.source_record_id) throw new Error(`invalid DOB CofO row for ${bbl}`);
    }
  }
}

async function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const doc = JSON.parse(readFileSync(OUT_SITE, "utf8"));
    checkDoc(doc);
    console.log(`DOB CofO lookup OK: ${doc.coverage.linked}/${doc.coverage.eligible} BBLs (${(doc.coverage.rate * 100).toFixed(1)}%)`);
    return;
  }
  const sourceRows = await fetchRows();
  const metadata = await (await fetch(`${DOMAIN}/api/views/${DATASET_ID}`)).json();
  const doc = buildDobCofoDoc(sourceRows, { sourceGeneratedAt: metadata.rowsUpdatedAt ? new Date(metadata.rowsUpdatedAt * 1000).toISOString() : null });
  doc.raw_source_rows = sourceRows.length;
  const text = `${JSON.stringify(doc)}\n`;
  mkdirSync(dirname(OUT_SITE), { recursive: true });
  mkdirSync(dirname(OUT_WORKER), { recursive: true });
  writeFileSync(OUT_SITE, text);
  writeFileSync(OUT_WORKER, text);
  console.log(`wrote DOB CofO lookup: ${doc.coverage.linked}/${doc.coverage.eligible} BBLs, ${doc.coverage.source_rows_linked} rows`);
}

main().catch((error) => { console.error(error); process.exit(1); });
