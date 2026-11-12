// Pure, synchronous, browser-safe lookup over the SBS directory artifacts. No network, no fuzzy matching,
// no merging with other sources. The caller supplies already-parsed documents and a shard reader.
//
// Result statuses (never conflated):
//   found      one or more rows
//   not_found  artifact valid, nothing matched (a real, trustworthy empty)
//   refused    artifact missing/invalid or query invalid; never an empty success
import { vendorStem } from "./vendor_stem.mjs";

export const SBS_SCHEMA = "cityscroll.sbs_certified_businesses.v1";
const SHARD_SCHEMA = "cityscroll.sbs_certified_businesses.shard.v1";
const NAMES_SCHEMA = "cityscroll.sbs_certified_businesses.names.v1";
const FACETS_SCHEMA = "cityscroll.sbs_certified_businesses.facets.v1";

const refuse = (reason, detail) => ({ status: "refused", reason, detail: String(detail ?? "") });
const num = (a) => Number(a);

/**
 * @param {{manifest:object, names:object, facets:object, readShard:(path:string)=>object|undefined}} input
 * @returns {{status:"ok", directory:object} | {status:"refused", reason:string, detail:string}}
 */
export function openSbsDirectory({ manifest, names, facets, readShard } = {}) {
  if (!manifest || typeof manifest !== "object") return refuse("manifest_missing");
  if (manifest.schema !== SBS_SCHEMA) return refuse("manifest_schema", manifest.schema);
  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) return refuse("manifest_shards");
  let total = 0; let prev = -Infinity;
  for (const s of manifest.shards) {
    if (!(s.path && Number.isInteger(s.rows) && s.rows > 0 && s.first_account && s.last_account)) return refuse("manifest_shard_entry", s?.path);
    if (num(s.first_account) > num(s.last_account) || num(s.first_account) <= prev) return refuse("manifest_shard_order", s.path);
    if (s.rows > manifest.shard_contract?.max_rows || s.bytes > manifest.shard_contract?.max_bytes) return refuse("manifest_shard_limit", s.path);
    prev = num(s.last_account); total += s.rows;
  }
  if (total !== manifest.row_count) return refuse("manifest_row_count", `${total} != ${manifest.row_count}`);
  if (!manifest.collected_at || !manifest.rows_updated_at) return refuse("manifest_freshness");
  if (!names || names.schema !== NAMES_SCHEMA || typeof names.by_name_stem !== "object" || typeof names.by_dba_stem !== "object") return refuse("names_invalid");
  if (!facets || facets.schema !== FACETS_SCHEMA || typeof facets.facets !== "object") return refuse("facets_invalid");
  if (typeof readShard !== "function") return refuse("reader_missing");
  const cache = new Map();
  const lower = {};
  for (const g of ["naics_sector", "borough"]) {
    lower[g] = new Map(Object.keys(facets.facets[g] || {}).map((k) => [k.toLowerCase(), k]));
  }
  return { status: "ok", directory: { manifest, names, facets: facets.facets, readShard, cache, lower } };
}

function shardFor(dir, account) {
  const n = num(account);
  return dir.manifest.shards.find((s) => n >= num(s.first_account) && n <= num(s.last_account)) || null;
}

function loadShard(dir, entry) {
  if (dir.cache.has(entry.path)) return dir.cache.get(entry.path);
  let doc;
  try { doc = dir.readShard(entry.path); } catch (e) { return refuse("shard_unreadable", `${entry.path}: ${e.message}`); }
  if (!doc) return refuse("shard_missing", entry.path);
  if (doc.schema !== SHARD_SCHEMA || !Array.isArray(doc.rows)) return refuse("shard_schema", entry.path);
  if (doc.rows.length !== entry.rows) return refuse("shard_row_count", `${entry.path}: ${doc.rows.length} != ${entry.rows}`);
  const first = doc.rows[0]?.account_number; const last = doc.rows.at(-1)?.account_number;
  if (first !== entry.first_account || last !== entry.last_account) return refuse("shard_range", entry.path);
  const loaded = { status: "ok", byAccount: new Map(doc.rows.map((r) => [r.account_number, r])) };
  dir.cache.set(entry.path, loaded);
  return loaded;
}

function wrap(dir, row, matchedOn) {
  const m = dir.manifest;
  return {
    account_number: row.account_number,
    matched_on: matchedOn,
    row,
    source_url: m.source.account_url_template.replace("{account_number}", row.account_number),
    dataset_url: m.source.landing_page,
    collected_at: m.collected_at,
    rows_updated_at: m.rows_updated_at,
  };
}

function population(dir) {
  const m = dir.manifest;
  return { row_count: m.row_count, rows_updated_at: m.rows_updated_at, collected_at: m.collected_at };
}

function resolve(dir, accounts, matchedOn, { limit = 100, offset = 0 } = {}) {
  const total = accounts.length;
  const page = accounts.slice(offset, offset + limit);
  const results = [];
  for (const a of page) {
    const entry = shardFor(dir, a);
    if (!entry) return refuse("index_points_outside_shards", a);
    const shard = loadShard(dir, entry);
    if (shard.status === "refused") return shard;
    const row = shard.byAccount.get(a);
    if (!row) return refuse("index_points_at_missing_row", a);
    results.push(wrap(dir, row, matchedOn));
  }
  return results.length
    ? { status: "found", total, results, population: population(dir) }
    : { status: "not_found", total: 0, results: [], population: population(dir) };
}

function guard(d) {
  return d && d.manifest && d.facets ? null : refuse("directory_not_open", "pass the directory from openSbsDirectory");
}

export function getByAccount(dir, accountNumber) {
  const g = guard(dir); if (g) return g;
  const a = String(accountNumber ?? "").trim();
  if (!/^\d+$/.test(a)) return refuse("invalid_account_number", a);
  const entry = shardFor(dir, a);
  if (!entry) return { status: "not_found", total: 0, results: [], population: population(dir) };
  const shard = loadShard(dir, entry);
  if (shard.status === "refused") return shard;
  const row = shard.byAccount.get(a);
  return row ? { status: "found", total: 1, results: [wrap(dir, row, "account_number")], population: population(dir) }
    : { status: "not_found", total: 0, results: [], population: population(dir) };
}

/** Exact match of vendorStem(name) against formal-name stems. */
export function findByName(dir, name, opts) {
  const g = guard(dir); if (g) return g;
  const stem = vendorStem(name);
  if (!stem) return refuse("empty_query", "name has no stem");
  return resolve(dir, dir.names.by_name_stem[stem] || [], "name_stem", opts);
}

/** Exact match of vendorStem(name) against DBA stems. */
export function findByDba(dir, name, opts) {
  const g = guard(dir); if (g) return g;
  const stem = vendorStem(name);
  if (!stem) return refuse("empty_query", "name has no stem");
  return resolve(dir, dir.names.by_dba_stem[stem] || [], "dba_stem", opts);
}

/** AND-combination of facets: programme, naics6, naics_sector, nigp, borough, zip. */
export function filterBusinesses(dir, criteria = {}, opts = {}) {
  const g = guard(dir); if (g) return g;
  const keys = Object.keys(criteria).filter((k) => criteria[k] !== undefined && criteria[k] !== null && criteria[k] !== "");
  const allowed = ["programme", "naics6", "naics_sector", "nigp", "borough", "zip"];
  if (!keys.length) return refuse("no_criteria", "give at least one of " + allowed.join(", "));
  const bad = keys.find((k) => !allowed.includes(k));
  if (bad) return refuse("unknown_criterion", bad);
  let acc = null;
  for (const k of keys) {
    let v = String(criteria[k]).trim();
    if (k === "programme") v = v.toUpperCase();
    if (k === "zip") { if (!/^\d{3,5}$/.test(v)) return refuse("invalid_zip", v); v = v.padStart(5, "0"); }
    if (k === "naics6" && !/^\d{6}$/.test(v)) return refuse("invalid_naics6", v);
    if (k === "nigp" && !/^\d+$/.test(v)) return refuse("invalid_nigp", v);
    if (k === "naics_sector" || k === "borough") v = dir.lower[k].get(v.toLowerCase()) ?? v;
    const list = dir.facets[k][v] || [];
    const have = new Set(list);
    acc = acc === null ? list : acc.filter((a) => have.has(a));
    if (!acc.length) break;
  }
  return resolve(dir, acc, "filter", opts);
}

/** Shard paths a caller must fetch before a sync query (browser/Worker pre-fetch helper). */
export function shardPathsForAccounts(dir, accounts) {
  return [...new Set(accounts.map((a) => shardFor(dir, a)?.path).filter(Boolean))];
}
