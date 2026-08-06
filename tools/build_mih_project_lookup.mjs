#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = join(ROOT, "site/data/mih_project_lookup.json");
const WORKER_OUT = join(ROOT, "worker/src/data/mih_project_lookup.json");
const MIH_DATASET = "m79g-k9r4";
const ZAP_DATASET = "hgx4-8ukb";
const RETRIEVED_AT = "2026-08-05T00:00:00.000Z";

function exact(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id) ? id : "";
}

async function fetchRows(dataset, ids = null) {
  const rows = [];
  if (!ids) {
    const url = `https://data.cityofnewyork.us/resource/${dataset}.json?$limit=5000`;
    return (await (await fetch(url)).json());
  }
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const where = batch.map((id) => `project_id='${id.replaceAll("'", "''")}'`).join(" OR ");
    const url = `https://data.cityofnewyork.us/resource/${dataset}.json?$limit=5000&$where=${encodeURIComponent(where)}`;
    rows.push(...await (await fetch(url)).json());
  }
  return rows;
}

function materialize(mihRows, zapRows) {
  const zapById = new Map(zapRows.map((row) => [exact(row.project_id), row]).filter(([id]) => id));
  const rows = mihRows.flatMap((mih) => {
    const id = exact(mih.project_id);
    const zap = id ? zapById.get(id) : null;
    if (!id || !zap) return [];
    return [{
      project_id: id,
      join: { key: "project_id", method: "exact_project_id", confidence: "strong" },
      mih: {
        ...(mih.project_nam && !/\bBased\b/.test(mih.project_nam) ? { project_name: mih.project_nam } : {}),
        status: mih.status || null,
        date_adopted: mih.date_adopte || null,
        ulurp_number: mih.zr_ulurpno || null,
        zoning_map: mih.zoning_map || null,
        community_district: mih.cd || null,
        mih_option: mih.mih_option || null,
      },
      zap: {
        ...(zap.project_name && !/\bBased\b/.test(zap.project_name) ? { project_name: zap.project_name } : {}),
        project_status: zap.project_status || null,
        public_status: zap.public_status || null,
        primary_applicant: zap.primary_applicant || null,
      },
      provenance: {
        mih: { dataset_id: MIH_DATASET, url: `https://data.cityofnewyork.us/d/${MIH_DATASET}`, retrieved_at: RETRIEVED_AT },
        zap: { dataset_id: ZAP_DATASET, url: `https://data.cityofnewyork.us/d/${ZAP_DATASET}`, retrieved_at: RETRIEVED_AT },
      },
    }];
  });
  return {
    schema_version: "cityscroll.mih_project_lookup.v1",
    materialized_at: RETRIEVED_AT,
    source: { dataset_id: MIH_DATASET, landing_page: `https://data.cityofnewyork.us/d/${MIH_DATASET}` },
    join_measurement: { eligible: mihRows.length, linked: rows.length, rate: rows.length / mihRows.length, gap: rows.length < mihRows.length ? "unmatched_project_ids_excluded" : null },
    row_count: rows.length,
    rows,
  };
}

const check = process.argv.includes("--check");
const mihRows = await fetchRows(MIH_DATASET);
const ids = [...new Set(mihRows.map((row) => exact(row.project_id)).filter(Boolean))];
const zapRows = await fetchRows(ZAP_DATASET, ids);
const output = JSON.stringify(materialize(mihRows, zapRows), null, 2) + "\n";
if (check) {
  const current = readFileSync(OUT, "utf8");
  if (current !== output) { console.error("MIH project lookup is stale"); process.exitCode = 1; }
  else console.log("MIH project lookup current");
} else {
  writeFileSync(OUT, output);
  writeFileSync(WORKER_OUT, output);
  console.log(`materialized ${JSON.parse(output).row_count} exact MIH project joins`);
}
