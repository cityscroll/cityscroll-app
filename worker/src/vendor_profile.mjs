// Precomputed vendor profiles.
//
// The daily cron folds City Record Award rows into normalized vendor stems, publishes
// versioned buckets to ALERT_STATE KV, then swaps a small manifest last. Each record is a
// read model for the whole profile: identity totals, agency rollup, 15 recent notices,
// Doing Business Search entity enrichment when the stem joins, and any Checkbook
// renewal-estimate payload already present in KV. GET /vendor-profile reads one bucket and
// rejects records older than 24 hours. Socrata remains the source of truth; a miss or refresh
// failure falls back to the browser's live resolver.

import { vendorStem } from "./lib/compile.mjs";
import {
  DOING_BUSINESS_SODA,
  buildDoingBusinessIndex,
  doingBusinessProfilePayload,
  joinVendorToDoingBusiness,
} from "./lib/doing_business_join.mjs";
import { attachDoingBusinessFromWarehouse } from "./lib/doing_business_warehouse_lookup.mjs";
import { precomputedVendorFootprint } from "./entity_intelligence.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const MONEY_HONESTY_CAP = 10_000_000_000;
const PAGE_SIZE = 10_000;
const MAX_PAGES = 50;
const BUCKET_COUNT = 64;
const MANIFEST_KEY = "vp:manifest:v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECORD_TTL_SECONDS = 28 * 60 * 60;
const RECENT_NOTICE_LIMIT = 15;
const FORECAST_PREFIXES = ["fc:"];
const CACHE_SCHEMA = "source-contract-v2";
const DOING_BUSINESS_PAGE = 5_000;

function cacheKeyFor(req) {
  const url = new URL(req.url);
  url.searchParams.set("_cache_schema", CACHE_SCHEMA);
  return new Request(url, req);
}

function withoutDisabledPlanRows(profile) {
  return {
    ...profile,
    forecasts: Array.isArray(profile?.forecasts)
      ? profile.forecasts.filter((forecast) => forecast?.source === "checkbook")
      : [],
  };
}

export function vendorProfileBucket(stem) {
  let hash = 2166136261;
  for (let i = 0; i < stem.length; i++) {
    hash ^= stem.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % BUCKET_COUNT).toString(16).padStart(2, "0");
}

export function vendorProfileBucketKey(version, bucket) {
  return `vp:v1:${version}:${bucket}`;
}

function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

export function buildVendorProfiles(rows) {
  const stems = new Map();

  for (const row of rows || []) {
    const name = String(row?.vendor_name || "").trim();
    const stem = vendorStem(name);
    if (!name || stem.length < 3) continue;

    let profile = stems.get(stem);
    if (!profile) {
      profile = {
        stem,
        variants: new Map(),
        agencies: new Map(),
        awardCount: 0,
        total: 0,
        first: null,
        last: null,
      };
      stems.set(stem, profile);
    }

    const n = Number(row.n) || 0;
    const total = Number(row.t) || 0;
    const variant = profile.variants.get(name) || {
      name, n: 0, total: 0, first: null, last: null,
    };
    variant.n += n;
    variant.total += total;
    variant.first = minDate(variant.first, row.first);
    variant.last = maxDate(variant.last, row.last);
    profile.variants.set(name, variant);

    const agencyName = String(row.agency_name || "").trim();
    if (agencyName) {
      const agency = profile.agencies.get(agencyName) || { name: agencyName, n: 0, total: 0 };
      agency.n += n;
      agency.total += total;
      profile.agencies.set(agencyName, agency);
    }

    profile.awardCount += n;
    profile.total += total;
    profile.first = minDate(profile.first, row.first);
    profile.last = maxDate(profile.last, row.last);
  }

  const output = {};
  for (const [stem, profile] of stems) {
    const variants = [...profile.variants.values()].sort(
      (a, b) => b.n - a.n || b.total - a.total || a.name.localeCompare(b.name),
    );
    output[stem] = {
      stem,
      display: variants[0]?.name || stem,
      variants,
      awardCount: profile.awardCount,
      total: profile.total,
      first: profile.first,
      last: profile.last,
      topAgencies: [...profile.agencies.values()]
        .sort((a, b) => b.total - a.total || b.n - a.n || a.name.localeCompare(b.name))
        .slice(0, 10),
    };
  }
  return output;
}

async function fetchVendorRows(fetchImpl) {
  const rows = [];
  let requests = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "$select": "vendor_name,agency_name,count(1) as n,sum(contract_amount) as t,min(start_date) as first,max(start_date) as last",
      "$where": `vendor_name IS NOT NULL AND type_of_notice_description='Award' AND contract_amount < ${MONEY_HONESTY_CAP}`,
      "$group": "vendor_name,agency_name",
      "$order": "vendor_name,agency_name",
      "$limit": String(PAGE_SIZE),
      "$offset": String(page * PAGE_SIZE),
    });
    requests++;
    const response = await fetchImpl(`${SODA}?${params}`);
    if (!response.ok) throw new Error(`vendor profile SODA ${response.status}`);
    const pageRows = await response.json();
    if (!Array.isArray(pageRows)) throw new Error("vendor profile SODA returned a non-array response");
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) return { rows, requests };
  }
  throw new Error(`vendor profile SODA exceeded ${MAX_PAGES * PAGE_SIZE} grouped rows`);
}

function recentNotice(row) {
  return {
    request_id: row.request_id || null,
    start_date: row.start_date || null,
    agency_name: row.agency_name || null,
    type_of_notice_description: row.type_of_notice_description || null,
    short_title: row.short_title || null,
    contract_amount: row.contract_amount ?? null,
  };
}

async function attachRecentNotices(profiles, fetchImpl) {
  let requests = 0;
  let rowsScanned = 0;
  let rowsStored = 0;
  for (const profile of Object.values(profiles)) profile.recentNotices = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "$select": "request_id,start_date,agency_name,type_of_notice_description,short_title,contract_amount,vendor_name",
      "$where": "vendor_name IS NOT NULL",
      "$order": "start_date DESC,request_id",
      "$limit": String(PAGE_SIZE),
      "$offset": String(page * PAGE_SIZE),
    });
    requests++;
    const response = await fetchImpl(`${SODA}?${params}`);
    if (!response.ok) throw new Error(`vendor profile recent-notices SODA ${response.status}`);
    const pageRows = await response.json();
    if (!Array.isArray(pageRows)) {
      throw new Error("vendor profile recent-notices SODA returned a non-array response");
    }
    rowsScanned += pageRows.length;
    for (const row of pageRows) {
      const profile = profiles[vendorStem(row?.vendor_name || "")];
      if (!profile || profile.recentNotices.length >= RECENT_NOTICE_LIMIT) continue;
      profile.recentNotices.push(recentNotice(row));
      rowsStored++;
    }
    if (pageRows.length < PAGE_SIZE) return { requests, rowsScanned, rowsStored };
  }
  throw new Error(`vendor profile recent-notices SODA exceeded ${MAX_PAGES * PAGE_SIZE} rows`);
}

async function listKeys(kv, prefix) {
  if (typeof kv?.list !== "function") return { keys: [], requests: 0 };
  const keys = [];
  let cursor;
  let requests = 0;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    requests++;
    keys.push(...(page?.keys || []).map((key) => key.name));
    cursor = page?.list_complete === false ? page.cursor : null;
  } while (cursor);
  return { keys, requests };
}

async function attachForecasts(profiles, kv) {
  for (const profile of Object.values(profiles)) profile.forecasts = [];
  let listRequests = 0;
  let readRequests = 0;
  let recordsStored = 0;

  for (const prefix of FORECAST_PREFIXES) {
    const listed = await listKeys(kv, prefix);
    listRequests += listed.requests;
    for (const key of listed.keys) {
      const stem = key.slice(prefix.length);
      const profile = profiles[stem];
      if (!profile || !stem || stem.includes(":")) continue;
      const raw = await kv.get(key);
      readRequests++;
      if (!raw) continue;
      let forecasts;
      try {
        forecasts = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(forecasts)) continue;
      profile.forecasts.push(...forecasts);
      recordsStored += forecasts.length;
    }
  }

  for (const profile of Object.values(profiles)) {
    profile.forecasts.sort((a, b) => {
      const dateA = a.expiration_date || a.release_quarter || "";
      const dateB = b.expiration_date || b.release_quarter || "";
      return dateA.localeCompare(dateB);
    });
  }
  return { listRequests, readRequests, recordsStored };
}

/**
 * Fetch Doing Business Search Entities and attach a strict stem join to each profile.
 * WH-05: warehouse materialization first (no network). Live multi-page SODA when:
 *   - materialization is empty/missing, or
 *   - materialization is a partial/fixture snapshot and some profiles are still unmatched
 *     (full bulk pack skips SODA entirely).
 * Failure is non-fatal: profiles keep doingBusiness=null so the cron still publishes.
 */
async function attachDoingBusiness(profiles, fetchImpl) {
  const profileList = Object.values(profiles || {});
  // Warehouse materialization path — instant stem index, zero SODA catalog pages when complete.
  const fromWh = attachDoingBusinessFromWarehouse(profiles);
  const allMatched =
    fromWh.used &&
    profileList.length > 0 &&
    profileList.every((p) => p.doingBusiness);
  // ~11k entities on Open Data; ≥5k rows ⇒ treat as full-catalog materialization.
  const fullCatalog = fromWh.used && fromWh.rows >= 5000;
  if (fromWh.used && (fullCatalog || allMatched)) {
    return {
      requests: 0,
      rows: fromWh.rows,
      matched: fromWh.matched,
      indexSize: fromWh.indexSize,
      lookup_path: "warehouse",
    };
  }

  // Live SODA for empty materialization, or to fill gaps left by a partial snapshot.
  // Preserve any warehouse hits already attached above.
  if (!fromWh.used) {
    for (const profile of profileList) profile.doingBusiness = null;
  }
  const rows = [];
  let requests = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "$limit": String(DOING_BUSINESS_PAGE),
      "$offset": String(page * DOING_BUSINESS_PAGE),
      "$order": "organization_name",
    });
    requests++;
    const response = await fetchImpl(`${DOING_BUSINESS_SODA}?${params}`);
    if (!response.ok) throw new Error(`doing business SODA ${response.status}`);
    const pageRows = await response.json();
    if (!Array.isArray(pageRows)) {
      throw new Error("doing business SODA returned a non-array response");
    }
    rows.push(...pageRows);
    if (pageRows.length < DOING_BUSINESS_PAGE) break;
  }

  const index = buildDoingBusinessIndex(rows);
  let matched = fromWh.used ? fromWh.matched : 0;
  for (const profile of profileList) {
    if (profile.doingBusiness) continue; // keep warehouse hit
    const hit = joinVendorToDoingBusiness(profile.display || profile.stem, index)
      || joinVendorToDoingBusiness(profile.stem, index);
    if (!hit) continue;
    // Prefer a name-variant match when one of the published City Record names stems equal.
    let best = hit;
    for (const variant of profile.variants || []) {
      const vHit = joinVendorToDoingBusiness(variant.name, index);
      if (vHit) {
        best = vHit;
        break;
      }
    }
    profile.doingBusiness = doingBusinessProfilePayload(best);
    matched++;
  }
  return {
    requests,
    rows: fromWh.used ? Math.max(fromWh.rows, rows.length) : rows.length,
    matched,
    indexSize: fromWh.used ? Math.max(fromWh.indexSize, index.size) : index.size,
    lookup_path: fromWh.used ? "warehouse+soda" : "soda",
  };
}

function withoutTail(profile) {
  const { recentNotices, forecasts, ...identity } = profile;
  return identity;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export async function refreshVendorProfiles(env, options = {}) {
  if (!env.ALERT_STATE) return { skipped: "no-kv-binding" };
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const generated = now.toISOString();
  const version = generated.replace(/\D/g, "").slice(0, 14);
  const aggregate = await fetchVendorRows(fetchImpl);
  const profiles = buildVendorProfiles(aggregate.rows);
  const recent = await attachRecentNotices(profiles, fetchImpl);
  const forecast = await attachForecasts(profiles, env.ALERT_STATE);

  let doingBusiness = { requests: 0, rows: 0, matched: 0, indexSize: 0 };
  try {
    doingBusiness = await attachDoingBusiness(profiles, fetchImpl);
  } catch (err) {
    // Non-fatal: still publish award/forecast profiles without Doing Business enrichment.
    console.error(
      "doing business attach failed (vendor profiles continue):",
      String(err?.message || err),
    );
    for (const profile of Object.values(profiles)) profile.doingBusiness = null;
  }

  const buckets = new Map();

  for (const profile of Object.values(profiles)) {
    profile.footprint = precomputedVendorFootprint(profile.stem, profile.display);
    const bucket = vendorProfileBucket(profile.stem);
    if (!buckets.has(bucket)) buckets.set(bucket, {});
    buckets.get(bucket)[profile.stem] = profile;
  }

  let beforeBytes = 0;
  let afterBytes = 0;
  for (const [bucket, records] of buckets) {
    const baseline = {};
    for (const [stem, profile] of Object.entries(records)) baseline[stem] = withoutTail(profile);
    beforeBytes += byteLength(JSON.stringify({ generated, profiles: baseline }));
    const value = JSON.stringify({ generated, profiles: records });
    afterBytes += byteLength(value);
    await env.ALERT_STATE.put(
      vendorProfileBucketKey(version, bucket),
      value,
      { expirationTtl: RECORD_TTL_SECONDS },
    );
  }

  // Publish last: readers either see the previous complete generation or this one.
  await env.ALERT_STATE.put(
    MANIFEST_KEY,
    JSON.stringify({
      generated,
      version,
      schema: 3,
      profileCount: Object.keys(profiles).length,
    }),
    { expirationTtl: RECORD_TTL_SECONDS },
  );
  return {
    generated,
    version,
    profiles: Object.keys(profiles).length,
    buckets: buckets.size,
    cronCost: {
      socrataRequestsBefore: aggregate.requests,
      socrataRequestsAfter: aggregate.requests + recent.requests + doingBusiness.requests,
      recentRowsScanned: recent.rowsScanned,
      forecastKvListRequests: forecast.listRequests,
      forecastKvReadRequests: forecast.readRequests,
      doingBusinessRequests: doingBusiness.requests,
    },
    storage: {
      bucketCount: buckets.size,
      averageBytesBefore: buckets.size ? Math.round(beforeBytes / buckets.size) : 0,
      averageBytesAfter: buckets.size ? Math.round(afterBytes / buckets.size) : 0,
      totalBytesBefore: beforeBytes,
      totalBytesAfter: afterBytes,
    },
    included: {
      recentNotices: recent.rowsStored,
      forecasts: forecast.recordsStored,
      doingBusiness: doingBusiness.matched,
      vendorFootprints: Object.values(profiles).filter((profile) => profile.footprint).length,
      mentions: false,
    },
  };
}

export async function handleVendorProfile(req, env, options = {}) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);
  if (!env.ALERT_STATE) return json({ ok: false, reason: "not-configured" }, 503, cors);

  const name = new URL(req.url).searchParams.get("name") || "";
  const stem = vendorStem(name);
  if (stem.length < 3) return json({ ok: false, reason: "invalid-name" }, 400, cors);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = cacheKeyFor(req);
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  let manifest;
  try {
    manifest = JSON.parse(await env.ALERT_STATE.get(MANIFEST_KEY) || "null");
  } catch {
    return json({ ok: false, reason: "missing-index" }, 404, cors);
  }
  if (!manifest?.generated || !manifest?.version) {
    return json({ ok: false, reason: "missing-index" }, 404, cors);
  }

  const nowMs = options.nowMs ?? Date.now();
  const ageMs = nowMs - Date.parse(manifest.generated);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_AGE_MS) {
    return json({ ok: false, reason: "stale-index" }, 503, cors);
  }

  let bucket;
  try {
    bucket = JSON.parse(
      await env.ALERT_STATE.get(
        vendorProfileBucketKey(manifest.version, vendorProfileBucket(stem)),
      ) || "null",
    );
  } catch {
    return json({ ok: false, reason: "missing-index" }, 404, cors);
  }
  const storedProfile = bucket?.profiles?.[stem];
  if (!storedProfile) return json({ ok: false, reason: "not-found" }, 404, cors);
  const profile = withoutDisabledPlanRows(storedProfile);

  const cacheSeconds = Math.max(
    0,
    Math.min(300, Math.floor((MAX_AGE_MS - ageMs) / 1000)),
  );
  const res = json(
    { ok: true, generated: manifest.generated, profile },
    200,
    { ...cors, "Cache-Control": `public, max-age=${cacheSeconds}` },
  );
  if (cache && cacheSeconds > 0) {
    const put = cache.put(cacheKey, res.clone());
    if (options?.waitUntil) options.waitUntil(put); else await put.catch(() => {});
  }
  return res;
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
