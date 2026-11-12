#!/usr/bin/env node
// Build site/data/procurement_plan_index.json: a small, deterministic index of
// the committed plan population so a consumer can answer "which agencies have
// plans, how many, in which quarters and industries, and which shard holds
// them" without downloading every shard.
//
//   node tools/build_procurement_plan_index.mjs [--check]
//
// Inputs (all committed): the planning manifest and its plans shards, the
// engine agency crosswalk (worker/src/data/agency_crosswalk.json) and the
// crosswalk resolver exactAgency() from site/procurement_evidence.mjs. No wall
// clock and no network: the same inputs give the same bytes. --check exits 1
// when the committed index differs from a rebuild.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agencyCodeFromUrl, isWorkbookListRow, PLANNING_MANIFEST_PATH, WITHHELD_WORKBOOK_LIST_ROW, NOT_PUBLISHED,
} from "../site/procurement_plan_listing.mjs";
import { exactAgency } from "../site/procurement_evidence.mjs";

export const PLAN_INDEX_SCHEMA = "cityscroll.procurement_plan_index.v1";
export const PLAN_INDEX_PATH = "site/data/procurement_plan_index.json";
export const CROSSWALK_PATH = "worker/src/data/agency_crosswalk.json";
const SHORT = { mocs_ll1: "ll1", mocs_ll63: "ll63" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortedObject = (map) => Object.fromEntries([...Object.entries(map)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Engine link for one publisher agency code: exactAgency(code) over the
 * crosswalk, else exactAgency over the Local Law 1 workbook label (LL1 labels
 * are full agency names). Ambiguous or absent stays null; never a guess.
 */
export function linkAgencyCode(code, ll1Labels, crosswalk, exactAgencyFn = exactAgency) {
  const byCode = exactAgencyFn(code, crosswalk);
  if (byCode) return { agency_id: byCode, agency_id_basis: "crosswalk_exact_code" };
  const ids = [...new Set(ll1Labels.map((label) => exactAgencyFn(label, crosswalk)).filter(Boolean))];
  if (ids.length === 1) return { agency_id: ids[0], agency_id_basis: "crosswalk_exact_ll1_label" };
  return { agency_id: null, agency_id_basis: null };
}

export function buildPlanIndex({ manifest, manifestBytes, shards, crosswalk, exactAgency: exactAgencyFn = exactAgency }) {
  const labelByUrl = new Map(manifest.sources.filter((s) => SHORT[s.source]).map((s) => [s.url, s.label ?? null]));
  const agencies = new Map();
  const totals = { rows_held: 0, rows_listable: 0, withheld: { [WITHHELD_WORKBOOK_LIST_ROW]: 0 }, by_source: {} };
  const flags = {};
  const shardDescriptors = [];
  for (const { descriptor, rows } of shards) {
    const codes = new Set();
    for (const row of rows) {
      const code = agencyCodeFromUrl(row.source_url);
      const src = SHORT[row.source];
      codes.add(code);
      const a = agencies.get(code) || {
        agency_code: code, published_names: new Set(), agency_keys: new Set(), rows_held: 0, rows_listable: 0,
        withheld: 0, by_source: {}, quarters: {}, industries: {}, amount: { published: 0, [NOT_PUBLISHED]: 0 },
        quality_flags: {}, shards: new Set(), ll1_labels: new Set(),
      };
      agencies.set(code, a);
      const bySource = a.by_source[src] || { rows_listable: 0, workbooks: new Set() };
      a.by_source[src] = bySource;
      bySource.workbooks.add(row.source_url);
      if (src === "ll1" && labelByUrl.get(row.source_url)) a.ll1_labels.add(labelByUrl.get(row.source_url));
      a.rows_held += 1;
      a.agency_keys.add(row.agency_key);
      a.shards.add(descriptor.path);
      totals.rows_held += 1;
      const ts = totals.by_source[src] || { rows_held: 0, rows_listable: 0, workbooks: new Set() };
      totals.by_source[src] = ts;
      ts.rows_held += 1;
      ts.workbooks.add(row.source_url);
      if (isWorkbookListRow(row)) {
        a.withheld += 1;
        totals.withheld[WITHHELD_WORKBOOK_LIST_ROW] += 1;
        continue;
      }
      a.rows_listable += 1;
      bySource.rows_listable += 1;
      ts.rows_listable += 1;
      totals.rows_listable += 1;
      if (row.agency) a.published_names.add(row.agency);
      const quarter = row.quarter == null ? NOT_PUBLISHED : String(row.quarter);
      a.quarters[quarter] = (a.quarters[quarter] || 0) + 1;
      const industry = row.industry == null ? NOT_PUBLISHED : row.industry;
      a.industries[industry] = (a.industries[industry] || 0) + 1;
      if (row.budget?.amount != null) a.amount.published += 1; else a.amount[NOT_PUBLISHED] += 1;
      for (const flag of row.quality_flags) {
        a.quality_flags[flag] = (a.quality_flags[flag] || 0) + 1;
        flags[flag] = (flags[flag] || 0) + 1;
      }
    }
    shardDescriptors.push({ path: descriptor.path, sha256: descriptor.sha256, rows: descriptor.rows, agency_codes: [...codes].sort() });
  }
  const agencyRows = [...agencies.values()].sort((x, y) => (x.agency_code < y.agency_code ? -1 : 1)).map((a) => {
    const link = linkAgencyCode(a.agency_code, [...a.ll1_labels].sort(), crosswalk, exactAgencyFn);
    return {
      agency_code: a.agency_code,
      agency_id: link.agency_id,
      agency_id_basis: link.agency_id_basis,
      published_names: [...a.published_names].sort(),
      agency_keys: [...a.agency_keys].sort(),
      rows_held: a.rows_held,
      rows_listable: a.rows_listable,
      withheld: { [WITHHELD_WORKBOOK_LIST_ROW]: a.withheld },
      by_source: sortedObject(Object.fromEntries(Object.entries(a.by_source).map(([k, v]) => [k, { rows_listable: v.rows_listable, workbooks: [...v.workbooks].sort() }]))),
      quarters: sortedObject(a.quarters),
      industries: sortedObject(a.industries),
      estimated_amount: a.amount,
      quality_flags: sortedObject(a.quality_flags),
      shards: [...a.shards].sort(),
    };
  });
  const linked = new Set(agencyRows.map((a) => a.agency_id).filter(Boolean));
  return {
    schema: PLAN_INDEX_SCHEMA,
    fiscal_year: manifest.fiscal_year,
    source_manifest: {
      path: PLANNING_MANIFEST_PATH,
      sha256: sha256(manifestBytes),
      generated_at: manifest.generated_at,
      plans_rows: manifest.collections.plans.rows,
    },
    rule: {
      agency_code: "publisher workbook file-name prefix, upper-cased (ACS_LL1_FY27.xlsx -> ACS)",
      withheld_workbook_list_row: "plan_id present and not matching ^FY\\d{2}[A-Z]: the drop-down list table at the foot of each Local Law 1 sheet",
      agency_id: "exactAgency() over worker/src/data/agency_crosswalk.json, by code then by Local Law 1 workbook label; ambiguous or absent stays null",
    },
    totals: {
      rows_held: totals.rows_held,
      rows_listable: totals.rows_listable,
      withheld: totals.withheld,
      by_source: sortedObject(Object.fromEntries(Object.entries(totals.by_source).map(([k, v]) => [k, { rows_held: v.rows_held, rows_listable: v.rows_listable, workbooks: v.workbooks.size }]))),
    },
    quality_flags: sortedObject(flags),
    shards: shardDescriptors,
    agencies: agencyRows,
    unlinked_agency_codes: agencyRows.filter((a) => !a.agency_id).map((a) => a.agency_code),
    known_agencies_without_rows: Object.keys(crosswalk).filter((id) => !linked.has(id)).sort(),
    crosswalk: { path: CROSSWALK_PATH },
  };
}

export function serializeIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Families to append to the capability registry in tools/build_procurement_evidence.mjs. */
export function planCapabilityFamilies(index) {
  return ["ll1", "ll63"].map((src) => ({
    id: `agency-plans-${src}`,
    source_id: src === "ll1" ? "mocs-ll1-plans" : "mocs-ll63-plans",
    agency_ids: [...new Set(index.agencies.filter((a) => a.agency_id && (a.by_source[src]?.rows_listable || 0) > 0).map((a) => a.agency_id))].sort(),
    status: "available",
    unit: "published plan row",
    version: `fy${index.fiscal_year}`,
    source_as_of: String(index.source_manifest.generated_at).slice(0, 10),
    index: "/data/procurement_plan_index.json",
  }));
}

export function buildFromRoot(root) {
  const manifestBytes = readFileSync(join(root, PLANNING_MANIFEST_PATH));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const shards = manifest.collections.plans.shards.map((descriptor) => {
    const bytes = readFileSync(join(root, descriptor.path));
    if (sha256(bytes) !== descriptor.sha256) throw new Error(`shard hash mismatch: ${descriptor.path}`);
    return { descriptor, rows: JSON.parse(bytes.toString("utf8")).rows };
  });
  const crosswalk = JSON.parse(readFileSync(join(root, CROSSWALK_PATH), "utf8")).entries;
  return buildPlanIndex({ manifest, manifestBytes, shards, crosswalk, exactAgency });
}

export async function main(argv = process.argv.slice(2)) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let out = null;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check") check = true;
    else if (argv[i] === "--root") root = resolve(argv[++i]);
    else if (argv[i] === "--out") out = resolve(argv[++i]);
    else { console.error("usage: build_procurement_plan_index.mjs [--check] [--root dir] [--out file]"); return 2; }
  }
  out ||= join(root, PLAN_INDEX_PATH);
  const body = serializeIndex(buildFromRoot(root));
  if (check) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (current !== body) { console.error(`procurement plan index drift: ${out}`); return 1; }
    return 0;
  }
  writeFileSync(out, body);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main();
}
