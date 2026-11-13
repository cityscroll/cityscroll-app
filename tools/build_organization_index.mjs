#!/usr/bin/env node
// Builds the organization index (site/data/organization_index.json + site/data/organization_index/)
// from committed artifacts only: the engine's vendor-bearing read models, the SBS certified business
// directory and the bulk register shards (IRS EO BMF NY, NYS DOL contractor registry, SCA prequalified
// firms). No network.
//
//   node tools/build_organization_index.mjs           write
//   node tools/build_organization_index.mjs --check   rebuild in memory; fail on any byte difference or integrity problem
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEngineSources, readSbsDirectory, registerContributions } from "./lib/organization_index_sources.mjs";
import { buildIndex, checkFiles, MANIFEST_PATH, DIR, STEMS_PATH } from "./lib/organization_index_build.mjs";
import { vendorStem } from "../entity_resolution/normalizers/vendor_stem.mjs";
import { isRegisterIdShard, recordsFromRegisterShard } from "../entity_resolution/registers/shard_records.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE = join(ROOT, "site");
export const REGISTERS = Object.freeze(["irs_eo_bmf_ny", "nys_dol_contractor_registry", "nyc_sca_prequalified_firms"]);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const MAX_FILE_BYTES = 18 * 1024 * 1024;

function registerShardFile(siteDir, register, shard) {
  const path = String(shard?.path || "");
  if (path.startsWith("data/")) return join(siteDir, path);
  return join(siteDir, "data", register, path);
}

/** Every record of a bulk register from its id shards (kind "id" or "ein"; stem shards are an index). */
export function readRegisterRecords(siteDir, register) {
  const manifest = readJson(join(siteDir, "data", register, "manifest.json"));
  const records = [];
  for (const shard of (manifest.shards || []).filter(isRegisterIdShard)) {
    const decoded = recordsFromRegisterShard(readJson(registerShardFile(siteDir, register, shard)));
    if (!decoded.ok) throw new Error(`${register} ${shard.path}: ${decoded.problems.join("; ")}`);
    records.push(...decoded.records);
  }
  if (!records.length) throw new Error(`${register}: no records`);
  if (manifest.row_count != null && records.length !== manifest.row_count) {
    throw new Error(`${register}: id shards hold ${records.length} records, manifest row_count is ${manifest.row_count}`);
  }
  return { records, receipt: { path: `site/data/${register}/manifest.json`, rows: records.length, collected_at: manifest.collected_at ?? records[0].collected_at } };
}

export function buildFromRepository(root = ROOT) {
  const site = join(root, "site");
  const engine = readEngineSources(root);
  const sbs = readSbsDirectory(site);
  const contributions = [...engine.contributions, ...sbs.contributions];
  const receipts = { ...engine.receipts, sbs_certified_businesses: sbs.receipt };
  for (const reg of REGISTERS) {
    const r = readRegisterRecords(site, reg);
    for (const c of registerContributions(r.records)) contributions.push(c);
    receipts[reg] = r.receipt;
  }
  const built = buildIndex(contributions, { built_from: "committed artifacts", receipts });
  return { ...built, contributions };
}

function oversized(files) {
  const problems = [];
  for (const [p, t] of files) {
    const bytes = Buffer.byteLength(t);
    if (bytes > MAX_FILE_BYTES) problems.push(`${p} is ${bytes} bytes, above the 18 MiB headroom`);
  }
  return problems;
}

/** Every non-empty vendor stem from the inputs must be a stem in the written index. */
export function unreachableStemCount(contributions, stemSet) {
  let unreachable = 0;
  for (const contribution of contributions) {
    const stem = vendorStem(contribution.name);
    if (stem && !stemSet.has(stem)) unreachable += 1;
  }
  return unreachable;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = buildFromRepository();
  const stemSet = new Set(JSON.parse(built.files.get(STEMS_PATH)).stems.map((row) => row[0]));
  const reach = unreachableStemCount(built.contributions, stemSet);
  const sizeProblems = oversized(built.files);
  if (process.argv.includes("--check")) {
    const problems = checkFiles((p) => readFileSync(join(SITE, p), "utf8"));
    if (reach) problems.push(`${reach} stemmed names are not in the index`);
    problems.push(...sizeProblems);
    for (const [p, t] of built.files) {
      const f = join(SITE, p);
      if (!existsSync(f)) problems.push(`missing ${p}`);
      else if (readFileSync(f, "utf8") !== t) problems.push(`stale ${p}`);
    }
    const expected = new Set([...built.files.keys()].map((p) => p.slice(DIR.length + 1)));
    for (const f of existsSync(join(SITE, DIR)) ? readdirSync(join(SITE, DIR)) : []) if (!expected.has(f)) problems.push(`unexpected ${DIR}/${f}`);
    if (problems.length) { console.error(problems.slice(0, 20).join("\n")); process.exit(1); }
    console.log(`organization index current: ${built.manifest.entry_count} entries, generation ${built.manifest.generation}`);
  } else {
    if (reach || sizeProblems.length) {
      console.error([reach ? `${reach} stemmed names are not in the index` : null, ...sizeProblems].filter(Boolean).join("\n"));
      process.exit(1);
    }
    rmSync(join(SITE, DIR), { recursive: true, force: true });
    for (const [p, t] of built.files) { const f = join(SITE, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t); }
    console.log(`wrote ${built.files.size} files: ${built.manifest.entry_count} entries, generation ${built.manifest.generation} (${MANIFEST_PATH})`);
  }
}
