// SBS Certified Business List collector + normalizer (prototype for the engine source
// `sbs-certified-business-list`, Open Data dataset ci93-uc8s). Node built-ins only.
//
// Contract: every published field is carried; nothing is dropped, masked or invented. The only
// changes are (a) typing/normalization with the raw value kept beside it, (b) a quality_flags
// array, (c) name_stem / dba_stem from the engine's vendor_stem function.

import { createHash } from "node:crypto";
import { vendorStem } from "../../entity_resolution/normalizers/vendor_stem.mjs";

export const SBS_SOURCE_ID = "sbs-certified-business-list";
export const SBS_DATASET_ID = "ci93-uc8s";
export const SBS_RESOURCE_URL = "https://data.cityofnewyork.us/resource/ci93-uc8s.json";
export const SBS_LANDING_PAGE = "https://data.cityofnewyork.us/d/ci93-uc8s";
export const SBS_VIEWS_URL = "https://data.cityofnewyork.us/api/views/ci93-uc8s.json";
export const SBS_PUBLISHER = "NYC Department of Small Business Services (SBS)";
export const SBS_ROW_SCHEMA = "cityscroll.sbs_certified_businesses.v1";

// The 56 columns the publisher declares (api/views/ci93-uc8s.json columns[]), in publisher order.
// Socrata omits null cells from JSON rows, so a row object carries fewer keys than this list; the
// normalizer emits all 56 (null when absent). The task brief said 62; the metadata says 56.
export const SBS_FIELDS = Object.freeze([
  "account_number", "vendor_formal_name", "vendor_dba", "first_name", "last_name", "telephone",
  "business_description", "certification", "cert_renewal_date", "ethnicity", "address1", "address2",
  "city", "state", "zip", "mailingaddress1", "mailingaddress2", "mailingcity", "mailingstate",
  "mailingzip", "website", "date_of_establishment", "aggregate_bonding_limit",
  "signatory_to_union_contracts", "id6_digit_naics_code", "naics_sector", "naics_subsector",
  "naics_title", "types_of_construction_projects_performed", "nigp_codes",
  "name_of_client_job_exp_1", "largest_value_of_contract", "percent_self_performed_job_exp_1",
  "date_of_work_job_exp_1", "description_of_work_job_exp_1", "name_of_client_job_exp_2",
  "value_of_contract_job_exp_2", "percent_self_performed_job_exp_2", "date_of_work_job_exp_2",
  "description_of_work_job_exp_2", "name_of_client_job_exp_3", "value_of_contract_job_exp_3",
  "percent_self_performed_job_exp_3", "date_of_work_job_exp_3", "description_of_work_job_exp_3",
  "capacity_building_programs", "enrolled_in_passport", "borough", "latitude", "longitude",
  "community_board", "council_district", "bin", "bbl", "census_tract_2020_",
  "neighborhood_tabulation_area_nta_2020_",
]);

export const ZIP_FIELDS = Object.freeze(["zip", "mailingzip"]);
export const DATE_FIELDS = Object.freeze([
  "date_of_establishment", "date_of_work_job_exp_1", "date_of_work_job_exp_2", "date_of_work_job_exp_3",
]);
export const AMOUNT_FIELDS = Object.freeze([
  "aggregate_bonding_limit", "largest_value_of_contract", "value_of_contract_job_exp_2",
  "value_of_contract_job_exp_3",
]);
export const PERCENT_FIELDS = Object.freeze([
  "percent_self_performed_job_exp_1", "percent_self_performed_job_exp_2", "percent_self_performed_job_exp_3",
]);
// Fields whose output value is typed; each has a verbatim `<field>_raw` sibling (null when absent).
export const TYPED_FIELDS = Object.freeze([
  "certification", "cert_renewal_date", "nigp_codes", ...ZIP_FIELDS, ...DATE_FIELDS, ...AMOUNT_FIELDS,
  ...PERCENT_FIELDS,
]);
export const DERIVED_FIELDS = Object.freeze([
  ...TYPED_FIELDS.map((f) => `${f}_raw`), "name_stem", "dba_stem", "quality_flags",
]);

export const KNOWN_PROGRAMMES = Object.freeze(["EBE", "LBE", "MBE", "WBE"]);

// Closed vocabulary. A flag marks a value a consumer should not take at face value; the row is kept.
export const SBS_QUALITY_FLAGS = Object.freeze([
  "name_error_token", // vendor_formal_name is a spreadsheet error token (e.g. "ERROR: #NAME?"); name_stem is null
  "name_missing",
  "multi_valued_date", // cert_renewal_date holds several ';'-separated dates (publisher uses this for multi-programme firms)
  "renewal_dates_count_differs_from_programmes",
  "unparseable_date",
  "date_out_of_range", // a date outside 1800-2100; the parsed value is kept
  "website_is_email_address",
  "unparseable_amount",
  "negative_amount",
  "unparseable_percent",
  "percent_out_of_range",
  "zip_padded_three_digits", // a 3-digit zip left-padded with two zeros; padding cannot be confirmed
  "zip_unparseable",
  "phone_not_ten_digits",
  "phone_placeholder", // all digits identical (e.g. 5555555555)
  "unknown_certification_code",
]);

const ERROR_TOKEN = /^\s*ERROR:|#(?:NAME|REF|VALUE|N\/A|DIV\/0|NULL|NUM)[?!]?/i;

function str(raw, key) {
  const v = raw[key];
  return v === undefined || v === null ? null : String(v);
}

export function parseDate(value) {
  if (value === null || value === undefined) return { iso: null, ok: true };
  const s = String(value).trim();
  let y; let m; let d;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?)?$/.exec(s);
  if (match) [, y, m, d] = match;
  else if ((match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) [, m, d, y] = match;
  else return { iso: null, ok: false };
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) {
    return { iso: null, ok: false };
  }
  return { iso: `${y}-${m}-${d}`, ok: true };
}

export function parseNumber(value) {
  if (value === null || value === undefined) return { n: null, ok: true };
  const s = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return { n: null, ok: false };
  return { n: Number(s), ok: true };
}

export function padZip(value) {
  if (value === null || value === undefined) return { zip: null, flag: null };
  const s = String(value).trim();
  if (/^\d{5}$/.test(s)) return { zip: s, flag: null };
  if (/^\d{4}$/.test(s)) return { zip: `0${s}`, flag: null };
  if (/^\d{3}$/.test(s)) return { zip: `00${s}`, flag: "zip_padded_three_digits" };
  return { zip: s, flag: "zip_unparseable" };
}

export function splitList(value, separator) {
  if (value === null || value === undefined) return null;
  return String(value).split(separator).map((s) => s.trim()).filter((s) => s !== "");
}

function yearOutOfRange(iso) {
  const y = Number(iso.slice(0, 4));
  return y < 1800 || y > 2100;
}

/** Normalize one Socrata row object (any subset of the 56 fields) to the output row. */
export function normalizeRow(raw) {
  const flags = new Set();
  const out = {};
  const account = str(raw, "account_number");
  if (!account) throw new TypeError("row has no account_number");

  for (const field of SBS_FIELDS) out[field] = str(raw, field);

  // certification -> sorted programme codes
  out.certification_raw = str(raw, "certification");
  if (out.certification_raw !== null) {
    const codes = [...new Set(splitList(out.certification_raw, ",").map((c) => c.toUpperCase()))].sort();
    out.certification = codes;
    if (codes.some((c) => !KNOWN_PROGRAMMES.includes(c))) flags.add("unknown_certification_code");
  } else out.certification = null;

  // cert_renewal_date -> array of ISO dates in raw order
  out.cert_renewal_date_raw = str(raw, "cert_renewal_date");
  if (out.cert_renewal_date_raw !== null) {
    const parts = splitList(out.cert_renewal_date_raw, ";");
    if (parts.length > 1) flags.add("multi_valued_date");
    out.cert_renewal_date = parts.map((p) => {
      const r = parseDate(p);
      if (!r.ok) flags.add("unparseable_date");
      else if (r.iso && yearOutOfRange(r.iso)) flags.add("date_out_of_range");
      return r.iso;
    });
    if (out.certification && parts.length > 1 && parts.length !== out.certification.length) {
      flags.add("renewal_dates_count_differs_from_programmes");
    }
  } else out.cert_renewal_date = null;

  // nigp_codes -> array
  out.nigp_codes_raw = str(raw, "nigp_codes");
  out.nigp_codes = out.nigp_codes_raw === null ? null : splitList(out.nigp_codes_raw, "|");

  for (const f of ZIP_FIELDS) {
    out[`${f}_raw`] = str(raw, f);
    const { zip, flag } = padZip(out[`${f}_raw`]);
    out[f] = zip;
    if (flag) flags.add(flag);
  }

  for (const f of DATE_FIELDS) {
    out[`${f}_raw`] = str(raw, f);
    const r = parseDate(out[`${f}_raw`]);
    out[f] = r.iso;
    if (!r.ok) flags.add("unparseable_date");
    else if (r.iso && yearOutOfRange(r.iso)) flags.add("date_out_of_range");
  }
  for (const f of AMOUNT_FIELDS) {
    out[`${f}_raw`] = str(raw, f);
    const r = parseNumber(out[`${f}_raw`]);
    out[f] = r.n;
    if (!r.ok) flags.add("unparseable_amount");
    else if (r.n !== null && r.n < 0) flags.add("negative_amount");
  }
  for (const f of PERCENT_FIELDS) {
    out[`${f}_raw`] = str(raw, f);
    const r = parseNumber(out[`${f}_raw`]);
    out[f] = r.n;
    if (!r.ok) flags.add("unparseable_percent");
    else if (r.n !== null && (r.n < 0 || r.n > 100)) flags.add("percent_out_of_range");
  }

  // stems from the engine's own function; an error-token name never gets a stem
  const name = out.vendor_formal_name;
  if (name === null || name.trim() === "") flags.add("name_missing");
  if (name !== null && ERROR_TOKEN.test(name)) flags.add("name_error_token");
  out.name_stem = name !== null && !flags.has("name_error_token") && vendorStem(name) !== "" ? vendorStem(name) : null;
  out.dba_stem = out.vendor_dba !== null && vendorStem(out.vendor_dba) !== "" ? vendorStem(out.vendor_dba) : null;

  if (out.website !== null && out.website.includes("@")) flags.add("website_is_email_address");
  if (out.telephone !== null) {
    if (!/^\d{10}$/.test(out.telephone)) flags.add("phone_not_ten_digits");
    if (/^(\d)\1{9}$/.test(out.telephone)) flags.add("phone_placeholder");
  }

  out.quality_flags = [...flags].sort();
  return out;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two cheap requests: publisher rowsUpdatedAt and count(*). Lets a refresh skip the full pull when nothing moved. */
export async function readPublisherClock({ fetchImpl = fetch } = {}) {
  const meta = await (await fetchImpl(SBS_VIEWS_URL)).json();
  const count = await (await fetchImpl(`${SBS_RESOURCE_URL}?$select=${encodeURIComponent("count(*)")}`)).json();
  return {
    rowsUpdatedAt: Number.isFinite(meta?.rowsUpdatedAt) ? new Date(meta.rowsUpdatedAt * 1000).toISOString() : null,
    publisherCount: Number(count?.[0]?.count),
  };
}

/**
 * Full paginated pull with a stable $order, honouring robots.txt Crawl-delay 1 between requests.
 * `fetchImpl` and `sleep` are injectable. Returns rows exactly as published plus per-request receipts.
 */
export async function pullAll({
  fetchImpl = fetch, pageSize = 2000, delayMs = 1000, sleep = sleepMs, maxPages = 50,
} = {}) {
  const requests = [];
  const rows = [];
  async function get(url) {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`SBS pull ${res.status} for ${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    requests.push({ url, status: res.status, bytes: bytes.length, sha256: sha256Hex(bytes) });
    return JSON.parse(bytes.toString("utf8"));
  }
  const meta = await get(SBS_VIEWS_URL);
  await sleep(delayMs);
  const count = await get(`${SBS_RESOURCE_URL}?$select=${encodeURIComponent("count(*)")}`);
  const publisherCount = Number(count?.[0]?.count);
  for (let page = 0; page < maxPages; page += 1) {
    await sleep(delayMs);
    const url = `${SBS_RESOURCE_URL}?$order=account_number&$limit=${pageSize}&$offset=${page * pageSize}`;
    const batch = await get(url);
    if (!Array.isArray(batch)) throw new Error("SBS pull returned a non-array page");
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  const distinct = new Set(rows.map((r) => r.account_number)).size;
  if (!Number.isFinite(publisherCount) || rows.length !== publisherCount || distinct !== rows.length) {
    throw new Error(`SBS pull incomplete or not unique: rows=${rows.length} distinct=${distinct} publisher=${publisherCount}`);
  }
  const rowsUpdatedAt = Number.isFinite(meta?.rowsUpdatedAt) ? new Date(meta.rowsUpdatedAt * 1000).toISOString() : null;
  return { rows, requests, publisherCount, rowsUpdatedAt };
}

// Builds the public sharded artifact set from normalized rows. Pure: returns file contents.
// Layout (relative to the engine's site/ root, served under /data/):
//   data/sbs_certified_businesses.json              manifest (first-class artifact path)
//   data/sbs_certified_businesses/rows-000.json ... row shards, account_number numeric ranges
//   data/sbs_certified_businesses/names.json        name_stem / dba_stem -> account numbers
//   data/sbs_certified_businesses/facets.json       programme / naics6 / naics_sector / nigp / borough / zip -> accounts


export const MANIFEST_PATH = "data/sbs_certified_businesses.json";
export const DIR = "data/sbs_certified_businesses";
export const SHARD_SCHEMA = "cityscroll.sbs_certified_businesses.shard.v1";
export const NAMES_SCHEMA = "cityscroll.sbs_certified_businesses.names.v1";
export const FACETS_SCHEMA = "cityscroll.sbs_certified_businesses.facets.v1";
export const DEFAULT_LIMITS = Object.freeze({ max_rows: 1000, max_bytes: 6 * 1024 * 1024, max_index_bytes: 2 * 1024 * 1024 });

const byAccount = (a, b) => Number(a) - Number(b);

/** One row per line keeps biweekly git diffs at row granularity. */
function renderList(head, key, items) {
  return `{${head},"${key}":[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]}\n`;
}
function renderMap(head, key, map) {
  const keys = Object.keys(map).sort();
  return `{${head},"${key}":{\n${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(map[k])}`).join(",\n")}\n}}\n`;
}

function add(map, key, account) {
  if (key === null || key === undefined || key === "") return;
  (map[key] ||= []).push(account);
}

export function buildFacets(rows) {
  const f = { programme: {}, naics6: {}, naics_sector: {}, nigp: {}, borough: {}, zip: {} };
  for (const r of rows) {
    for (const p of r.certification || []) add(f.programme, p, r.account_number);
    add(f.naics6, r.id6_digit_naics_code, r.account_number);
    add(f.naics_sector, r.naics_sector, r.account_number);
    for (const c of new Set(r.nigp_codes || [])) add(f.nigp, c, r.account_number);
    add(f.borough, r.borough, r.account_number);
    add(f.zip, r.zip, r.account_number);
  }
  for (const group of Object.values(f)) for (const k of Object.keys(group)) group[k].sort(byAccount);
  return f;
}

export function buildNames(rows) {
  const by_name_stem = {}; const by_dba_stem = {};
  for (const r of rows) { add(by_name_stem, r.name_stem, r.account_number); add(by_dba_stem, r.dba_stem, r.account_number); }
  return { by_name_stem, by_dba_stem };
}

/**
 * @param rawRows rows as published (Socrata JSON objects)
 * @param meta { collected_at, rows_updated_at, publisher_row_count }
 */
export function buildDirectory(rawRows, meta, limits = DEFAULT_LIMITS) {
  const rows = rawRows.map(normalizeRow).sort((a, b) => byAccount(a.account_number, b.account_number));
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.account_number)) throw new Error(`duplicate account_number ${r.account_number}`);
    seen.add(r.account_number);
  }
  const files = new Map();
  const shards = [];
  let start = 0; let index = 0;
  while (start < rows.length) {
    let end = Math.min(start + limits.max_rows, rows.length);
    let text;
    for (;;) {
      const slice = rows.slice(start, end);
      text = renderList(`"schema":"${SHARD_SCHEMA}","shard":${index}`, "rows", slice);
      if (Buffer.byteLength(text) <= limits.max_bytes || slice.length === 1) break;
      end = start + Math.max(1, Math.floor(slice.length / 2));
    }
    if (Buffer.byteLength(text) > limits.max_bytes) throw new Error(`single row exceeds max_bytes at ${rows[start].account_number}`);
    const path = `${DIR}/rows-${String(index).padStart(3, "0")}.json`;
    files.set(path, text);
    shards.push({
      path, rows: end - start, bytes: Buffer.byteLength(text), sha256: sha256Hex(text),
      first_account: rows[start].account_number, last_account: rows[end - 1].account_number,
    });
    start = end; index += 1;
  }
  const names = buildNames(rows);
  const namesText = renderMap(`"schema":"${NAMES_SCHEMA}"`, "by_name_stem", names.by_name_stem)
    .replace(/\}\}\n$/, `},"by_dba_stem":{\n${Object.keys(names.by_dba_stem).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(names.by_dba_stem[k])}`).join(",\n")}\n}}\n`);
  const facets = buildFacets(rows);
  const facetsText = `{"schema":"${FACETS_SCHEMA}","facets":{\n${Object.keys(facets).map((g) => `${JSON.stringify(g)}:{\n${Object.keys(facets[g]).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(facets[g][k])}`).join(",\n")}\n}`).join(",\n")}\n}}\n`;
  for (const [t, p] of [[namesText, `${DIR}/names.json`], [facetsText, `${DIR}/facets.json`]]) {
    if (Buffer.byteLength(t) > limits.max_index_bytes) throw new Error(`${p} exceeds max_index_bytes`);
    files.set(p, t);
  }
  const flagCounts = Object.fromEntries(SBS_QUALITY_FLAGS.map((f) => [f, rows.filter((r) => r.quality_flags.includes(f)).length]));
  const manifest = {
    schema: SBS_ROW_SCHEMA,
    source: {
      id: SBS_SOURCE_ID, dataset_id: SBS_DATASET_ID, publisher: SBS_PUBLISHER, landing_page: SBS_LANDING_PAGE,
      resource_url: SBS_RESOURCE_URL, metadata_url: SBS_VIEWS_URL, licence_field: null,
      account_url_template: `${SBS_RESOURCE_URL}?account_number={account_number}`,
    },
    rows_updated_at: meta.rows_updated_at,
    collected_at: meta.collected_at,
    publisher_row_count: meta.publisher_row_count,
    row_count: rows.length,
    distinct_accounts: seen.size,
    content_sha256: sha256Hex(shards.map((s) => s.sha256).join("") + sha256Hex(namesText) + sha256Hex(facetsText)),
    fields: [...SBS_FIELDS],
    derived_fields: [...DERIVED_FIELDS],
    identity: { key: "account_number", note: "Only identifier the publisher gives; no EIN or state id is published.", stem_method: "vendor_stem_v1" },
    quality_flag_vocabulary: [...SBS_QUALITY_FLAGS],
    quality_flag_counts: flagCounts,
    shard_contract: { schema: SHARD_SCHEMA, keying: "account_number numeric ascending range", ...limits },
    shards,
    names: { path: `${DIR}/names.json`, bytes: Buffer.byteLength(namesText), sha256: sha256Hex(namesText), name_stems: Object.keys(names.by_name_stem).length, dba_stems: Object.keys(names.by_dba_stem).length },
    facets: { path: `${DIR}/facets.json`, bytes: Buffer.byteLength(facetsText), sha256: sha256Hex(facetsText), groups: Object.fromEntries(Object.entries(facets).map(([g, v]) => [g, Object.keys(v).length])) },
  };
  files.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files, rows };
}

/** Integrity of a materialized directory (bytes, sha256, ranges, limits, uniqueness, totals). Returns findings. */
export function verifyDirectoryFiles(read) {
  const findings = [];
  const manifest = JSON.parse(read(MANIFEST_PATH));
  const seen = new Set(); let total = 0;
  for (const s of manifest.shards) {
    const text = read(s.path);
    if (Buffer.byteLength(text) !== s.bytes) findings.push(`${s.path}: bytes differ`);
    if (sha256Hex(text) !== s.sha256) findings.push(`${s.path}: sha256 differs`);
    if (s.bytes > manifest.shard_contract.max_bytes) findings.push(`${s.path}: over max_bytes`);
    const doc = JSON.parse(text);
    if (doc.rows.length !== s.rows || doc.rows.length > manifest.shard_contract.max_rows) findings.push(`${s.path}: row limit/count`);
    for (const r of doc.rows) { if (seen.has(r.account_number)) findings.push(`duplicate ${r.account_number}`); seen.add(r.account_number); }
    total += doc.rows.length;
  }
  for (const k of ["names", "facets"]) {
    const text = read(manifest[k].path);
    if (sha256Hex(text) !== manifest[k].sha256 || Buffer.byteLength(text) !== manifest[k].bytes) findings.push(`${manifest[k].path}: hash/bytes`);
    if (manifest[k].bytes > manifest.shard_contract.max_index_bytes) findings.push(`${manifest[k].path}: over max_index_bytes`);
  }
  if (total !== manifest.row_count || seen.size !== manifest.distinct_accounts) findings.push("row_count/distinct_accounts differ from shards");
  return findings;
}

/** Serve gate: population properties only, no named record and no clock. */
export const SBS_MIN_ROWS = 10000;
export function serveGateFindings(manifest) {
  const f = [];
  if (!(manifest.row_count >= SBS_MIN_ROWS)) f.push(`row_count ${manifest.row_count} below floor ${SBS_MIN_ROWS}`);
  if (manifest.row_count !== manifest.publisher_row_count) f.push(`row_count ${manifest.row_count} != publisher_row_count ${manifest.publisher_row_count}`);
  if (manifest.distinct_accounts !== manifest.row_count) f.push("account_number is not unique");
  if (!(manifest.facets.groups.programme >= 2)) f.push("programme facet lost a programme");
  return f;
}

/** source_acquisition_receipt read by tools/source_health_observations.mjs warehouseReceipts(). */
export function acquisitionReceipt(manifest, requests) {
  return {
    schema: "cityscroll.source_acquisition_receipt.v1", source_contract_id: SBS_SOURCE_ID, observed_at: manifest.collected_at,
    status: "succeeded", run_id: `${SBS_SOURCE_ID}:${manifest.collected_at}`, publisher_clock_basis: "socrata_rows_updated_at",
    publisher_updated_at: manifest.rows_updated_at, acquisition: { mode: "bulk_soda", row_count: manifest.row_count, requests },
  };
}
