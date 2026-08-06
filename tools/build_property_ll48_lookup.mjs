#!/usr/bin/env node
/** Materialize the LL48 source rows that attach to the committed property BBL graph. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBbl } from "../entity_resolution/cross_domain/index.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const GRAPH = join(ROOT, "site/data/property_cross_domain_lookup.json");
const OUT = join(ROOT, "site/data/property_ll48_lookup.json");
const API = "https://data.cityofnewyork.us/resource/4e2n-s75z.json?$limit=20000";
const META = "https://data.cityofnewyork.us/api/views/4e2n-s75z";

export function buildLl48Slice(rows, eligibleBbls, observedAt) {
  const eligible = new Set([...eligibleBbls].map(normalizeBbl).filter(Boolean));
  const attached = [];
  for (const row of rows || []) {
    const bbl = normalizeBbl(row?.bbl);
    if (!bbl || !eligible.has(bbl)) continue;
    attached.push({
      bbl,
      parcel_name: row.parcel_name || null,
      address: row.address || null,
      agency: row.agency || null,
      current_uses: row.current_uses || null,
      potential_urban_ag: row.potential_urban_ag || null,
      total_area: row.total_area || null,
      land_use_category: row.land_use_category || null,
      source_url: "https://data.cityofnewyork.us/d/4e2n-s75z",
      _source_observed_at: observedAt,
      provenance: {
        source_system: "socrata:4e2n-s75z",
        source_record_id: `4e2n-s75z:bbl:${bbl}`,
        source_fields: ["bbl"],
        basis: "exact_bbl",
      },
    });
  }
  return {
    schema_version: 1,
    version: "property_ll48_lookup_v1",
    source: {
      id: "suitability-city-owned-leased-property-ll48",
      dataset_id: "4e2n-s75z",
      url: "https://data.cityofnewyork.us/d/4e2n-s75z",
      observed_at: observedAt,
      join_key: "bbl",
    },
    eligible_bbl_count: eligible.size,
    linked_bbl_count: new Set(attached.map((row) => row.bbl)).size,
    rows: attached,
  };
}

if (process.argv.includes("--check")) {
  const doc = JSON.parse(readFileSync(OUT, "utf8"));
  if (doc.version !== "property_ll48_lookup_v1" || !doc.rows?.length) throw new Error("LL48 lookup missing");
  console.log("property LL48 lookup OK", { eligible: doc.eligible_bbl_count, linked: doc.linked_bbl_count });
} else {
  const [rows, meta] = await Promise.all([
    fetch(API).then((r) => r.json()),
    fetch(META).then((r) => r.json()),
  ]);
  const graph = JSON.parse(readFileSync(GRAPH, "utf8"));
  const doc = buildLl48Slice(rows, Object.keys(graph.by_bbl || {}), new Date(Number(meta.rowsUpdatedAt) * 1000).toISOString().slice(0, 10));
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log("wrote property LL48 lookup", { source_rows: rows.length, eligible: doc.eligible_bbl_count, linked: doc.linked_bbl_count });
}
