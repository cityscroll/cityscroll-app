// Precomputed vendor identity profiles.
//
// The daily cron folds City Record Award rows into normalized vendor stems, publishes
// versioned buckets to ALERT_STATE KV, then swaps a small manifest last. GET /vendor-profile
// reads one bucket and rejects records older than 24 hours, so the browser can paint the
// identity header quickly without ever treating stale data as current. Socrata remains the
// source of truth; a miss or refresh failure falls back to the browser's live resolver.

import { vendorStem } from "./lib/compile.mjs";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const MONEY_HONESTY_CAP = 10_000_000_000;
const PAGE_SIZE = 10_000;
const MAX_PAGES = 50;
const BUCKET_COUNT = 64;
const MANIFEST_KEY = "vp:manifest:v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECORD_TTL_SECONDS = 3 * 24 * 60 * 60;

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
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "$select": "vendor_name,agency_name,count(1) as n,sum(contract_amount) as t,min(start_date) as first,max(start_date) as last",
      "$where": `vendor_name IS NOT NULL AND type_of_notice_description='Award' AND contract_amount < ${MONEY_HONESTY_CAP}`,
      "$group": "vendor_name,agency_name",
      "$order": "vendor_name,agency_name",
      "$limit": String(PAGE_SIZE),
      "$offset": String(page * PAGE_SIZE),
    });
    const response = await fetchImpl(`${SODA}?${params}`);
    if (!response.ok) throw new Error(`vendor profile SODA ${response.status}`);
    const pageRows = await response.json();
    if (!Array.isArray(pageRows)) throw new Error("vendor profile SODA returned a non-array response");
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) return rows;
  }
  throw new Error(`vendor profile SODA exceeded ${MAX_PAGES * PAGE_SIZE} grouped rows`);
}

export async function refreshVendorProfiles(env, options = {}) {
  if (!env.ALERT_STATE) return { skipped: "no-kv-binding" };
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const generated = now.toISOString();
  const version = generated.replace(/\D/g, "").slice(0, 14);
  const profiles = buildVendorProfiles(await fetchVendorRows(fetchImpl));
  const buckets = new Map();

  for (const profile of Object.values(profiles)) {
    const bucket = vendorProfileBucket(profile.stem);
    if (!buckets.has(bucket)) buckets.set(bucket, {});
    buckets.get(bucket)[profile.stem] = profile;
  }

  for (const [bucket, records] of buckets) {
    await env.ALERT_STATE.put(
      vendorProfileBucketKey(version, bucket),
      JSON.stringify({ generated, profiles: records }),
      { expirationTtl: RECORD_TTL_SECONDS },
    );
  }

  // Publish last: readers either see the previous complete generation or this one.
  await env.ALERT_STATE.put(
    MANIFEST_KEY,
    JSON.stringify({ generated, version, profileCount: Object.keys(profiles).length }),
    { expirationTtl: RECORD_TTL_SECONDS },
  );
  return { generated, version, profiles: Object.keys(profiles).length, buckets: buckets.size };
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
  const profile = bucket?.profiles?.[stem];
  if (!profile) return json({ ok: false, reason: "not-found" }, 404, cors);

  return json(
    { ok: true, generated: manifest.generated, profile },
    200,
    { ...cors, "Cache-Control": "public, max-age=300" },
  );
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
