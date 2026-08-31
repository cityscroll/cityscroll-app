#!/usr/bin/env node
/** Build/check the bounded LDP-13 CEQR reconciliation receipt. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEQR_MILESTONES_DATASET_ID,
  CEQR_PROJECTS_DATASET_ID,
  inspectCeqrRows,
  normalizeCeqrKey,
  reconcileCeqrProjectMilestones,
} from "../warehouse/lib/ceqr_project_milestone_reconciliation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATION = path.join(ROOT, "warehouse/fixtures/ceqr-project-milestone-reconciliation/source.v1.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json");
const ZAP = path.join(ROOT, "site/data/zap_projects_warehouse_lookup.json");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) { return `${JSON.stringify(stable(value), null, 2)}\n`; }

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "CityScroll CEQR reconciliation" } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function acquireDataset(id, fields) {
  const metadata = await fetchJson(`https://data.cityofnewyork.us/api/views/${id}`);
  const rows = await fetchJson(`https://data.cityofnewyork.us/resource/${id}.json?$select=:id,${fields.join(",")}&$limit=50000`);
  return {
    metadata: {
      dataset_id: id,
      name: metadata.name,
      source_url: `https://data.cityofnewyork.us/d/${id}`,
      rows_updated_at: Number.isFinite(Number(metadata.rowsUpdatedAt))
        ? new Date(Number(metadata.rowsUpdatedAt) * 1000).toISOString()
        : null,
      metadata_updated_at: Number.isFinite(Number(metadata.metadataUpdatedAt))
        ? new Date(Number(metadata.metadataUpdatedAt) * 1000).toISOString()
        : null,
      columns: metadata.columns.map(({ name, fieldName, dataTypeName }) => ({ name, field_name: fieldName, data_type: dataTypeName })),
    },
    rows,
  };
}

async function refreshObservation() {
  const zapDoc = JSON.parse(readFileSync(ZAP, "utf8"));
  const zapKeys = new Set(zapDoc.rows.map((row) => normalizeCeqrKey(row.ceqr_number)).filter(Boolean));
  const projects = await acquireDataset(CEQR_PROJECTS_DATASET_ID, ["ceqr", "project_name", "project_description", "borough", "lead_agency", "url"]);
  const milestones = await acquireDataset(CEQR_MILESTONES_DATASET_ID, ["ceqr", "project_name", "milestone_name", "milestone_date"]);
  const materializedAt = new Date().toISOString();
  return {
    schema: "cityscroll.ceqr_reconciliation_source_observation.v1",
    materialized_at: materializedAt,
    sources: { projects: projects.metadata, milestones: milestones.metadata, zap: {
      dataset_id: zapDoc.dataset_id,
      source_url: `https://data.cityofnewyork.us/d/${zapDoc.dataset_id}`,
      rows_updated_at: zapDoc.materialized_at,
      source_fields: ["project_id", "ceqr_number", "environmental_milestone", "environmental_milestone_date"],
    } },
    dataset_inventory: inspectCeqrRows(projects.rows, milestones.rows),
    project_rows: projects.rows.filter((row) => zapKeys.has(normalizeCeqrKey(row.ceqr))),
    milestone_rows: milestones.rows.filter((row) => zapKeys.has(normalizeCeqrKey(row.ceqr))),
  };
}

function build(observation) {
  const zapRows = JSON.parse(readFileSync(ZAP, "utf8")).rows;
  return reconcileCeqrProjectMilestones({
    zapRows,
    projectRows: observation.project_rows,
    milestoneRows: observation.milestone_rows,
    sources: observation.sources,
    datasetInventory: observation.dataset_inventory,
    materializedAt: observation.materialized_at,
  });
}

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !["--check", "--refresh"].includes(arg))) throw new Error("Usage: node tools/build_ceqr_project_milestone_reconciliation.mjs [--refresh|--check]");
if (args.has("--check") && args.has("--refresh")) throw new Error("Choose --refresh or --check");

let observation;
if (args.has("--refresh")) {
  observation = await refreshObservation();
  mkdirSync(path.dirname(OBSERVATION), { recursive: true });
  writeFileSync(OBSERVATION, stringify(observation));
} else {
  observation = JSON.parse(readFileSync(OBSERVATION, "utf8"));
}
const next = stringify(build(observation));
if (args.has("--check")) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run the builder`);
  console.log(`CEQR reconciliation receipt OK (${JSON.parse(next).gate.result})`);
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)}`);
}
