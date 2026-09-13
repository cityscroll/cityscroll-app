#!/usr/bin/env node
/** Build the exact-reference historical ZAP context population. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHistoricalProjectContextManifest,
  referencedProjectIds,
  selectHistoricalProjectContext,
  shardHistoricalProjectContext,
} from "../site/historical_project_context.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BBL = [
  join(ROOT, "site/data/zap_bbl_warehouse_lookup.json"),
  join(ROOT, "worker/src/data/zap_bbl_warehouse_lookup.json"),
].find(existsSync);
const MIH = join(ROOT, "site/data/mih_project_lookup.json");
const OUT = join(ROOT, "site/data/historical_project_context");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/historical_project_context_population.json");
const URL = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";
const BATCH_SIZE = 50;

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (id) => `'${String(id).replaceAll("'", "''")}'`;

export async function fetchProjectRowsByIds(ids, fetchImpl = fetch, batchSize = BATCH_SIZE) {
  const rows = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const params = new URLSearchParams({
      $select: "project_id,project_name,public_status,project_status,approval_date,completed_date,ulurp_numbers,ceqr_number,primary_applicant,app_filed_date,noticed_date",
      $where: `project_id in(${batch.map(quote).join(",")})`,
      $limit: String(batch.length),
    });
    const response = await fetchImpl(`${URL}?${params}`);
    if (!response.ok) throw new Error(`ZAP historical context fetch failed: HTTP ${response.status}`);
    const body = await response.json();
    rows.push(...(Array.isArray(body) ? body : []));
  }
  return rows;
}

export function writeHistoricalProjectContext(selection, opts = {}) {
  const shards = shardHistoricalProjectContext(selection.retained_rows, opts.shardSize);
  mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < shards.length; i += 1) {
    writeFileSync(join(OUT, `${String(i).padStart(4, "0")}.json`), `${JSON.stringify(shards[i], null, 2)}\n`);
  }
  const manifest = buildHistoricalProjectContextManifest(selection, shards, {
    shardSize: opts.shardSize,
    source: { dataset_id: "hgx4-8ukb", url: URL, source_hash: opts.sourceHash || null },
  });
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const bbl = read(BBL);
  const mih = read(MIH);
  const current = read(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"));
  const ids = referencedProjectIds({ currentRows: current.rows, zapBblRows: bbl.rows, mihRows: mih.rows });
  const publisher = await fetchProjectRowsByIds(ids);
  const selection = selectHistoricalProjectContext({
    currentRows: current.rows,
    zapBblRows: bbl.rows,
    mihRows: mih.rows,
    publisherRows: publisher,
  });
  const sourceHash = hash({ dataset_id: "hgx4-8ukb", selected_ids: ids, rows: publisher });
  const manifest = writeHistoricalProjectContext(selection, { sourceHash });
  mkdirSync(dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, `${JSON.stringify({
    schema_version: "cityscroll.historical_project_context.receipt.v1",
    generated_at: new Date().toISOString(),
    source: { dataset_id: "hgx4-8ukb", url: URL, source_hash: sourceHash },
    reference_sources: {
      zap_bbl: { path: BBL?.replace(`${ROOT}/`, "") || null, source_hash: hash(bbl) },
      mih: { path: "site/data/mih_project_lookup.json", source_hash: hash(mih) },
    },
    counts: selection.counts,
    missing_ids: selection.missing_ids,
    excluded_ids: selection.excluded_ids,
    shards: manifest.shards,
  }, null, 2)}\n`);
  console.log(JSON.stringify(selection.counts));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exitCode = 1; });
