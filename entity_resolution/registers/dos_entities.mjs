// NYS Department of State active entities (data.ny.gov n9v6-gdp6): on-demand query builder,
// response mapper, and lookup envelope. Pure functions; the network is injected.
//
// Query strategy (4.3M rows, no server-side stem): the user's text is reduced with the engine's
// vendorStem, split on every non-alphanumeric character into tokens, and sent as a token-prefix
// LIKE  upper(current_entity_name) like 'T1%T2%...%'  . Because only [A-Z0-9] tokens reach the
// pattern, no quote, percent or underscore from user text can ever appear in it. Candidate rows
// are then checked client-side: exact name equality, or vendorStem equality, or candidate only.

import { vendorStem } from "../normalizers/vendor_stem.mjs";
import { addressFrom, makeRecord } from "./read_contract.mjs";
import { entityClassOf } from "./entity_class.mjs";

export const DOS_REGISTER = "ny_dos_entities";
export const DOS_DATASET_ID = "n9v6-gdp6";
export const DOS_RESOURCE_URL = `https://data.ny.gov/resource/${DOS_DATASET_ID}.json`;
export const DOS_LANDING_URL = `https://data.ny.gov/d/${DOS_DATASET_ID}`;

export const DOS_FIELDS = Object.freeze([
  "dos_id", "current_entity_name", "initial_dos_filing_date", "county", "jurisdiction", "entity_type",
  "dos_process_name", "dos_process_address_1", "dos_process_address_2", "dos_process_city", "dos_process_state", "dos_process_zip",
  "chairman_name", "chairman_address_1", "chairman_address_2", "chairman_city", "chairman_state", "chairman_zip",
  "registered_agent_name", "registered_agent_address_1", "registered_agent_address_2", "registered_agent_city", "registered_agent_state", "registered_agent_zip",
  "location_name", "location_address_1", "location_address_2", "location_city", "location_state", "location_zip",
]);

export const DOS_BLOCKS = Object.freeze(["dos_process", "chairman", "registered_agent", "location"]);

export const DOS_LIMITS = Object.freeze({
  default_limit: 25,
  max_limit: 50,
  min_alnum_chars: 3,
  min_longest_token: 3,
  max_input_length: 200,
  max_tokens: 12,
  timeout_ms: 5000,
  retry_delays_ms: Object.freeze([250]),
  cache_seconds: 300,
});

/** Reasons a name is refused BEFORE any request is built. */
export const REFUSAL = Object.freeze({
  NOT_TEXT: "input_not_text",
  TOO_LONG: "input_too_long",
  TOO_SHORT: "input_too_short",
  WILDCARD_ONLY: "input_has_no_letters_or_digits",
  NO_LONG_TOKEN: "no_token_of_3_or_more_characters",
  BAD_ID: "dos_id_not_digits",
});

/** Stem with whole-word AND removed; used only to compare a typed name with a returned name. */
export function andFolded(stem) {
  return String(stem).split(" ").filter((t) => t !== "AND").join(" ");
}

export function tokenize(stem) {
  return String(stem).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Pure validation of a typed name. -> { ok:true, stem, tokens } | { ok:false, reason } */
export function prepareName(input) {
  if (typeof input !== "string") return { ok: false, reason: REFUSAL.NOT_TEXT };
  if (input.length > DOS_LIMITS.max_input_length) return { ok: false, reason: REFUSAL.TOO_LONG };
  const stem = vendorStem(input);
  const all = tokenize(stem).map((t) => t.toUpperCase());
  // "AND" is dropped from the pattern: the register writes "&" where a vendor writes "and" (and the
  // reverse); '%' between the neighbouring tokens absorbs either spelling.
  const kept = all.filter((t) => t !== "AND");
  if (all.length && !kept.length) return { ok: false, reason: REFUSAL.NO_LONG_TOKEN };
  const tokens = kept;
  const alnum = tokens.join("").length;
  if (alnum === 0) return { ok: false, reason: REFUSAL.WILDCARD_ONLY };
  if (alnum < DOS_LIMITS.min_alnum_chars) return { ok: false, reason: REFUSAL.TOO_SHORT };
  if (Math.max(...tokens.map((t) => t.length)) < DOS_LIMITS.min_longest_token) return { ok: false, reason: REFUSAL.NO_LONG_TOKEN };
  return { ok: true, stem, tokens: tokens.slice(0, DOS_LIMITS.max_tokens) };
}

/** SoQL string literal: single quotes doubled. Only used for the exact-name batch path. */
export function soqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function url(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  return `${DOS_RESOURCE_URL}?${q.toString().replace(/\+/g, "%20")}`;
}

const SELECT = DOS_FIELDS.join(",");

/**
 * Name query. One request returns up to limit+1 rows so truncation is detectable.
 * Always carries $select and $limit; never unbounded.
 */
export function buildNameQuery(input, { limit = DOS_LIMITS.default_limit } = {}) {
  const prep = prepareName(input);
  if (!prep.ok) return { ok: false, refused: true, reason: prep.reason };
  const lim = Math.min(Math.max(1, Math.floor(Number(limit) || DOS_LIMITS.default_limit)), DOS_LIMITS.max_limit);
  const pattern = `${prep.tokens.join("%")}%`;
  const params = {
    $select: SELECT,
    $where: `upper(current_entity_name) like ${soqlString(pattern)}`,
    $limit: String(lim + 1),
  };
  return { ok: true, kind: "name_token_prefix", url: url(params), params, stem: prep.stem, tokens: prep.tokens, pattern, limit: lim, fetch_limit: lim + 1 };
}

/** dos_id query: digits only, so nothing needs escaping. */
export function buildIdQuery(id) {
  const s = typeof id === "number" ? String(id) : id;
  if (typeof s !== "string" || !/^\d{1,10}$/.test(s.trim())) return { ok: false, refused: true, reason: REFUSAL.BAD_ID };
  const params = { $select: SELECT, $where: `dos_id=${soqlString(s.trim())}`, $limit: "2" };
  return { ok: true, kind: "dos_id", url: url(params), params, dos_id: s.trim(), limit: 1, fetch_limit: 2 };
}

/** Batch path (warehouse job): exact upper(name) equality for up to 10 raw names in one request. */
export function buildExactBatchQuery(names) {
  const list = [...new Set((names || []).map((n) => String(n).trim().toUpperCase()).filter((n) => n.length >= 3 && n.length <= DOS_LIMITS.max_input_length))].slice(0, 10);
  if (!list.length) return { ok: false, refused: true, reason: REFUSAL.TOO_SHORT };
  const params = {
    $select: SELECT,
    $where: `upper(current_entity_name) in (${list.map(soqlString).join(",")})`,
    $limit: "500",
  };
  return { ok: true, kind: "exact_upper_batch", url: url(params), params, names: list, limit: 500, fetch_limit: 500 };
}

function cleanStr(v) { return v == null ? "" : String(v); }

/** One published row -> contract record. Nothing is dropped; malformed rows are flagged and kept. */
export function mapDosRow(row, { queried_at, flags = [] } = {}) {
  const raw = {};
  // every key the publisher sent is kept, including any column added after 2026-11-11
  for (const [k, v] of Object.entries(row || {})) if (v != null) raw[k] = String(v);
  const blocks = {};
  for (const b of DOS_BLOCKS) {
    blocks[b] = {
      name: cleanStr(raw[`${b}_name`]).trim() || null,
      address: addressFrom({ street: raw[`${b}_address_1`], street_2: raw[`${b}_address_2`], city: raw[`${b}_city`], state: raw[`${b}_state`], zip: raw[`${b}_zip`], role: b }),
    };
  }
  const cls = entityClassOf(raw.entity_type);
  const f = [...flags];
  if (raw.entity_type && !cls.mapped) f.push("unmapped_entity_type");
  if (raw.initial_dos_filing_date && Number.isNaN(Date.parse(raw.initial_dos_filing_date))) f.push("invalid_date");
  const primary = blocks.location.address || blocks.dos_process.address || null;
  const address = primary ? { ...primary } : null;
  return makeRecord({
    register: DOS_REGISTER,
    register_record_id: raw.dos_id,
    name: raw.current_entity_name,
    entity_class: cls.entity_class,
    entity_type: raw.entity_type ?? null,
    address,
    status: "ACTIVE",
    status_basis: "dataset_scope_active_corporations",
    source_url: DOS_LANDING_URL,
    queried_at,
    flags: f,
    published: {
      jurisdiction: raw.jurisdiction ?? null,
      county: raw.county ?? null,
      initial_dos_filing_date: raw.initial_dos_filing_date ?? null,
      blocks,
    },
    raw,
  });
}

/**
 * Compare returned rows with the typed name. Never produces a single verdict for several
 * matches. match_basis per record: exact_name | stem_equal | candidate.
 */
export function classifyRows(input, rows, { queried_at, limit = DOS_LIMITS.default_limit } = {}) {
  const prep = prepareName(input);
  const stem = prep.ok ? prep.stem : vendorStem(input);
  const upperInput = String(input).trim().toUpperCase();
  const truncated = rows.length > limit;
  const used = truncated ? rows.slice(0, limit) : rows;
  const records = used.map((row) => {
    const rec = mapDosRow(row, { queried_at });
    const exact = rec.name.trim().toUpperCase() === upperInput;
    const basis = exact ? "exact_name"
      : rec.name_stem === stem ? "stem_equal"
      : (andFolded(rec.name_stem) === andFolded(stem) && andFolded(stem).length >= 3) ? "stem_equal_and_folded"
      : "candidate";
    return { ...rec, match_basis: basis };
  });
  records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : String(a.register_record_id).localeCompare(String(b.register_record_id))));
  const verified = records.filter((r) => r.match_basis !== "candidate");
  const base = { query_stem: stem, truncated, returned: used.length };
  if (!records.length) return { ...base, status: "no_match", verdict: null, records: [] };
  const others = records.filter((r) => r.match_basis === "candidate");
  const exact = records.filter((r) => r.match_basis === "exact_name");
  // One record whose whole published name equals the typed name outranks stem-equal siblings.
  if (exact.length === 1) return { ...base, status: "one_match", verdict: "single_name_match", link_policy: "candidate_only", records: exact, also_stem_equal: verified.length - 1, other_candidates: others.length };
  // Cap reached: the list is incomplete, so no count of matches and no single verdict is honest.
  if (truncated && verified.length < 2) return { ...base, status: "truncated", verdict: null, link_policy: "candidate_only", records };
  if (verified.length === 1) return { ...base, status: "one_match", verdict: "single_name_match", link_policy: "candidate_only", records: verified, other_candidates: others.length };
  if (verified.length >= 2) return { ...base, status: "several_matches", verdict: null, link_policy: "candidate_only", records };
  return { ...base, status: "candidates_only", verdict: null, link_policy: "candidate_only", records };
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/** Failure -> envelope. Mirrors worker/src/lib/upstream_failure.mjs: transient statuses and
 *  network errors are "source unavailable"; any other 4xx is our own rejected query. */
export function classifyFailure(err) {
  const us = Number(err?.upstream_status);
  const status = Number.isInteger(us) && us >= 100 && us <= 599 ? us : null; // 0/null means "no HTTP status" (timeout, network)
  const m = /SODA\s+(\d{3})/.exec(String(err?.message || ""));
  const http = status ?? (m ? Number(m[1]) : null);
  if (http != null && !TRANSIENT.has(http)) return { status: "query_rejected", http_status: http, reason: "source_rejected_query" };
  const reason = http != null ? `http_${http}` : /timed out|timeout/i.test(String(err?.message)) ? "timeout" : "network";
  return { status: "source_unavailable", http_status: http, reason };
}

/**
 * Lookup by name. `readRows(url)` returns the parsed JSON array or throws (in the engine this is
 * fetchSodaRowsWithRetry with budgetMs 5000 and one 250 ms retry). `cache` is optional
 * { get(key), put(key, value, seconds) }; only answered lookups are cached, never failures.
 */
export async function lookupDosByName(input, { readRows, cache = null, now = () => new Date(), limit = DOS_LIMITS.default_limit } = {}) {
  const q = buildNameQuery(input, { limit });
  if (!q.ok) return { status: "refused", reason: q.reason, requests: 0 };
  return run(q, input, { readRows, cache, now, limit: q.limit });
}

export async function lookupDosById(id, { readRows, cache = null, now = () => new Date() } = {}) {
  const q = buildIdQuery(id);
  if (!q.ok) return { status: "refused", reason: q.reason, requests: 0 };
  return run(q, id, { readRows, cache, now, limit: 1 });
}

async function run(q, input, { readRows, cache, now, limit }) {
  if (cache) {
    const hit = await cache.get(q.url);
    if (hit) return { ...hit, cache: "hit", requests: 0 };
  }
  let rows;
  try {
    rows = await readRows(q.url);
  } catch (err) {
    return { ...classifyFailure(err), requests: 1, request_url: q.url };
  }
  if (!Array.isArray(rows)) return { status: "source_unavailable", reason: "invalid_json_shape", http_status: null, requests: 1, request_url: q.url };
  const queried_at = now().toISOString();
  const out = q.kind === "dos_id"
    ? idEnvelope(rows, queried_at)
    : classifyRows(input, rows, { queried_at, limit });
  const full = { ...out, queried_at, request_url: q.url, requests: 1, cache: "miss" };
  if (cache) await cache.put(q.url, full, DOS_LIMITS.cache_seconds);
  return full;
}

function idEnvelope(rows, queried_at) {
  if (!rows.length) return { status: "no_match", verdict: null, records: [] };
  const rec = mapDosRow(rows[0], { queried_at });
  const flags = rows.length > 1 ? { duplicate_dos_id_rows: rows.length } : {};
  return { status: "one_match", verdict: "dos_id_match", records: [{ ...rec, match_basis: "dos_id" }], ...flags };
}
