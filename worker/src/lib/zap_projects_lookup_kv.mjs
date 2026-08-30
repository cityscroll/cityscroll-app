// Live sell-facing ZAP project lookup stored in ALERT_STATE.
// The 08:00 cron pages current SODA hgx4-8ukb sell-facing rows and writes
// land:zap-lookup:v1. GET /zap-projects-lookup and fetchOpenDataRow read that
// key; missing, empty, unparseable, or failed KV uses the committed Worker twin
// so Land never goes blank. The 10.6 MB keyword index and 40-row default ULURP
// snapshot stay committed — they are not this cache.

import { LAND_ZAP_FRESHNESS_CANARIES } from "../../../warehouse/lib/land_zap_canaries.mjs";
import { stampLandRegulatoryEffect } from "../../../site/land_regulatory_effect.mjs";
import {
  stampZapEnvironmentalProjection,
  ZAP_ENVIRONMENTAL_SOURCE_COLS,
} from "../../../warehouse/lib/zap_environmental_projection.mjs";
import zapProjectsLookupFloor from "../data/zap_projects_warehouse_lookup.json" with { type: "json" };
import { readKvValue } from "./preset_fallback_kv.mjs";

export const ZAP_PROJECTS_LOOKUP_KV_KEY = "land:zap-lookup:v1";
export const ZAP_PROJECTS_LOOKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const ZAP_PROJECTS_LOOKUP_MIN_ROWS = 100;
export const ZAP_PROJECTS_LOOKUP_SCHEMA_VERSION = 1;
export const ZAP_PROJECTS_SODA_DATASET = "hgx4-8ukb";
export const ZAP_PROJECTS_SODA =
  `https://data.cityofnewyork.us/resource/${ZAP_PROJECTS_SODA_DATASET}.json`;
export const ZAP_PROJECTS_USER_AGENT =
  "CityScroll land-zap-lookup/1.0 (+https://cityscroll.org)";

export const ZAP_SELL_FACING_STATUSES = Object.freeze([
  "In Public Review",
  "Noticed",
  "Active",
  "Filed",
]);

const ZAP_STORE_COLS = Object.freeze([
  "project_id",
  "project_name",
  "public_status",
  "project_status",
  "approval_date",
  "completed_date",
  "ulurp_numbers",
  "borough",
  "community_district",
  "cc_district",
  "actions",
  "current_milestone",
  "current_milestone_date",
  "ulurp_non",
  "primary_applicant",
  "mih_flag",
  "app_filed_date",
  "noticed_date",
  "certified_referred",
  ...ZAP_ENVIRONMENTAL_SOURCE_COLS,
]);

const ZAP_SODA_COLS = Object.freeze([...ZAP_STORE_COLS, "project_brief"]);
const DEMO_PROJECT_ID = "2022M0258";

export function committedZapProjectsLookupFloor() {
  return zapProjectsLookupFloor;
}

function cell(value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function shapeZapLookupRow(row, opts = {}) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const col of ZAP_STORE_COLS) out[col] = cell(row[col]);
  if (!out.project_id) return null;
  out.project_id = String(out.project_id).trim();
  const stamped = stampLandRegulatoryEffect({ ...row, ...out });
  out.regulatory_effect = stamped.regulatory_effect;
  out.regulatory_effect_confidence = stamped.regulatory_effect_confidence;
  out.regulatory_effect_basis = stamped.regulatory_effect_basis;
  const asOf = opts.asOf || opts.now || null;
  return stampZapEnvironmentalProjection(out, {
    asOf,
    cutoff: opts.cutoff || asOf,
    observedAt: opts.observedAt,
  });
}

export function sodaSellFacingLookupUrl({ limit = 1000, offset = 0 } = {}) {
  const list = ZAP_SELL_FACING_STATUSES
    .map((status) => `'${String(status).replace(/'/g, "''")}'`)
    .join(", ");
  const params = new URLSearchParams({
    $select: ZAP_SODA_COLS.join(","),
    $where: `public_status in(${list})`,
    $order: "current_milestone_date DESC",
    $limit: String(limit),
    $offset: String(offset),
  });
  return `${ZAP_PROJECTS_SODA}?${params}`;
}

export function zapProjectsLookupHasCanaries(doc) {
  const ids = new Set((doc?.rows || []).map((row) => String(row?.project_id || "").trim()));
  return LAND_ZAP_FRESHNESS_CANARIES.every((canary) => ids.has(canary.project_id));
}

export function zapProjectsLookupKvAcceptable(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (Number(doc.schema_version) !== ZAP_PROJECTS_LOOKUP_SCHEMA_VERSION) return false;
  if (!Array.isArray(doc.rows) || doc.rows.length < ZAP_PROJECTS_LOOKUP_MIN_ROWS) return false;
  return zapProjectsLookupHasCanaries(doc);
}

export function parseZapProjectsLookupRecord(raw) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!zapProjectsLookupKvAcceptable(parsed)) return null;
  return parsed;
}

export async function loadZapProjectsLookup(env) {
  const floor = committedZapProjectsLookupFloor();
  const kv = env?.ALERT_STATE;
  if (!kv || typeof kv.get !== "function") {
    return { source: "committed_floor", record: floor };
  }
  try {
    const parsed = parseZapProjectsLookupRecord(
      await readKvValue(kv, ZAP_PROJECTS_LOOKUP_KV_KEY),
    );
    if (parsed) return { source: "kv", record: parsed };
  } catch {
    // Failed KV reads must not blank Land warehouse hits.
  }
  return { source: "committed_floor", record: floor };
}

export function zapProjectsLookupStale(record, nowMs = Date.now()) {
  const stamped = Date.parse(record?.materialized_at);
  if (!Number.isFinite(stamped)) return true;
  return nowMs - stamped > ZAP_PROJECTS_LOOKUP_MAX_AGE_MS;
}

function mergeSeedRows(sodaRows, floorRows, opts = {}) {
  const byId = new Map();
  for (const raw of sodaRows || []) {
    const row = shapeZapLookupRow(raw, opts);
    if (row) byId.set(row.project_id, row);
  }
  const required = new Set([
    DEMO_PROJECT_ID,
    ...LAND_ZAP_FRESHNESS_CANARIES.map((canary) => canary.project_id),
  ]);
  for (const raw of floorRows || []) {
    const id = String(raw?.project_id || "").trim();
    if (!id || byId.has(id) || !required.has(id)) continue;
    const row = shapeZapLookupRow(raw, opts);
    if (row) byId.set(row.project_id, row);
  }
  return [...byId.values()].sort((left, right) =>
    String(left.project_id).localeCompare(String(right.project_id)));
}

export function buildZapProjectsLookupDoc(sodaRows, opts = {}) {
  const floor = opts.floor || committedZapProjectsLookupFloor();
  const asOf = opts.now || new Date().toISOString();
  const rows = mergeSeedRows(sodaRows, floor.rows, { asOf, cutoff: opts.cutoff || asOf });
  return {
    schema_version: ZAP_PROJECTS_LOOKUP_SCHEMA_VERSION,
    phase: "WH-05",
    source: "soda",
    dataset_id: ZAP_PROJECTS_SODA_DATASET,
    table_name: "zap_projects",
    mode: opts.mode || "soda_sell_facing",
    materialized_at: asOf,
    row_count: rows.length,
    replaces_live_fetch: {
      worker: "worker/src/zap_outcomes.mjs#fetchOpenDataRow",
      soda_dataset: ZAP_PROJECTS_SODA_DATASET,
      description:
        "ZAP Open Data project rows retained for resident Land and /zap-outcomes reads",
    },
    rows,
  };
}

async function fetchSodaJson(url, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": ZAP_PROJECTS_USER_AGENT,
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`ZAP SODA ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("ZAP SODA returned a non-array response");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchZapProjectsLookupFromSoda(fetchImpl = fetch, opts = {}) {
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 1000, 1), 5000);
  const hardCap = Math.min(Math.max(Number(opts.limit) || 5000, 1), 5000);
  const rows = [];
  let offset = 0;
  while (rows.length < hardCap) {
    const batchLimit = Math.min(pageSize, hardCap - rows.length);
    const batch = await fetchSodaJson(
      sodaSellFacingLookupUrl({ limit: batchLimit, offset }),
      fetchImpl,
    );
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < batchLimit) break;
    offset += batch.length;
  }
  return buildZapProjectsLookupDoc(rows, {
    mode: "soda_sell_facing",
    now: (opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now())).toISOString(),
    floor: opts.floor,
  });
}

export async function refreshZapProjectsLookup(env, {
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!env?.ALERT_STATE || typeof env.ALERT_STATE.put !== "function") {
    return { status: "skipped", reason: "no-kv" };
  }
  const doc = await fetchZapProjectsLookupFromSoda(fetchImpl, { now });
  if (!zapProjectsLookupKvAcceptable(doc)) {
    return {
      status: "skipped",
      reason: "unusable-payload",
      row_count: doc?.row_count ?? 0,
    };
  }
  await env.ALERT_STATE.put(ZAP_PROJECTS_LOOKUP_KV_KEY, JSON.stringify(doc));
  return {
    status: "success",
    row_count: doc.row_count,
    materialized_at: doc.materialized_at,
  };
}
