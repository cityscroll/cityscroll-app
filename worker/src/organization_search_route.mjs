// GET /organization-search and the organization record mode of GET /vendor-profile?ref=org:...
//
// Snapshot-only (architecture/resident-read-policy.json): every read is a CityScroll materialization
// published under https://cityscroll.org/data/ (organization index, certified-business directory,
// register shards, and the committed New York State vendor lookup) or the vendor-profile KV.
// No publisher is called here. The live New York State answer is GET /org-register/dos, which the
// reader calls on an explicit request and merges with withLiveStateRegister (site/organization_record.mjs).

import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { openOrganizationIndex, searchOrganizations, searchByFacets, entriesFor, ordinalForStem, parseEntityRef, LIMITS } from "../../site/organization_search.mjs";
import { assembleOrganizationRecord } from "../../site/organization_record.mjs";
import { MANIFEST_PATH } from "../../site/organization_index_contract.mjs";
import { openSbsDirectory, getByAccount, shardPathsForAccounts } from "../../site/sbs_certified_business_lookup.mjs";
import { isRegisterIdShard, recordsFromRegisterShard, registerIdBucket, registerShardPath } from "../../entity_resolution/registers/shard_records.mjs";
import { lookupDoingBusinessFromWarehouse } from "./lib/doing_business_warehouse_lookup.mjs";

export const DOS_LOOKUP_SCHEMA = "cityscroll.dos_entities_vendor_lookup.v1";

/** { byId, byStem } from the committed New York State vendor lookup (matches[].records). */
export function indexDosVendorLookup(doc) {
  if (!doc || doc.schema !== DOS_LOOKUP_SCHEMA || !Array.isArray(doc.matches)) return null;
  const byId = new Map();
  const byStem = new Map();
  for (const match of doc.matches) {
    const records = Array.isArray(match.records) ? match.records : [];
    const stem = match.stem ? String(match.stem) : "";
    if (stem) byStem.set(stem, [...(byStem.get(stem) || []), ...records]);
    for (const rec of records) {
      const id = rec?.register_record_id == null ? "" : String(rec.register_record_id);
      if (!id) continue;
      byId.set(id, [...(byId.get(id) || []), rec]);
    }
  }
  return { byId, byStem, collected_at: doc.collected_at ?? null };
}

export const DATA_ORIGIN = "https://cityscroll.org/";
export const INDEX_RECHECK_MS = 300_000;
const CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const FACET_KEYS = Object.freeze(["programme", "naics6", "naics_sector", "nigp", "borough", "zip"]);

/** Published-file reader: Pages fetch with edge cache. Throws on any non-200 so callers report not_indexed. */
export function pagesReader(fetchImpl = fetch) {
  return async (path) => {
    const res = await fetchImpl(`${DATA_ORIGIN}${path}`, { headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  };
}

let isolate = null; // { opened, checkedAt, generation }

/** Open the index once per isolate; re-read the manifest every INDEX_RECHECK_MS and reopen on a new generation. */
export async function organizationIndex(readFile, nowMs = Date.now()) {
  if (isolate && nowMs - isolate.checkedAt < INDEX_RECHECK_MS) return isolate.opened;
  if (isolate) {
    try {
      const m = await readFile(MANIFEST_PATH);
      if (m?.generation === isolate.generation) { isolate.checkedAt = nowMs; return isolate.opened; }
    } catch { /* reopen below reports not_indexed if the manifest is gone */ }
  }
  const opened = await openOrganizationIndex(readFile);
  isolate = opened.status === "ok" ? { opened, checkedAt: nowMs, generation: opened.index.manifest.generation } : null;
  return opened;
}
export function resetOrganizationIndexForTests() { isolate = null; }

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
}
const STATUS_HTTP = { matched: 200, no_match: 200, found: 200, query_refused: 400, not_indexed: 503 };

async function committedStateLookup(readFile) {
  try {
    return indexDosVendorLookup(await readFile("data/dos_entities_vendor_lookup.json"));
  } catch { return null; }
}

/** GET /organization-search?q=...&limit=  or  ?programme=&naics6=&naics_sector=&nigp=&borough=&zip= */
export async function handleOrganizationSearch(request, env = {}, { readFile = env.ORGANIZATION_INDEX_READER || pagesReader(), nowMs } = {}) {
  const origin = request.headers.get("Origin") || "";
  const cors = corsHeaders(origin, env, { methods: "GET, OPTIONS" });
  if (!isAllowedRequestOrigin(origin, env)) return json({ ok: false, reason: "origin" }, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam === null ? undefined : Number(limitParam);
  const opened = await organizationIndex(readFile, nowMs);
  const facets = Object.fromEntries(FACET_KEYS.filter((k) => url.searchParams.has(k)).map((k) => [k, url.searchParams.get(k)]));
  let body;
  if (Object.keys(facets).length && !url.searchParams.has("q")) {
    let facetsDoc = null;
    try { facetsDoc = await readFile("data/sbs_certified_businesses/facets.json"); } catch { facetsDoc = null; }
    body = await searchByFacets(opened, facetsDoc, facets, { limit });
  } else {
    const dosCommitted = /^\s*dos\s*:/i.test(url.searchParams.get("q") || "") ? await committedStateLookup(readFile) : null;
    body = await searchOrganizations(opened, url.searchParams.get("q") ?? "", { limit, dosCommitted });
  }
  const status = STATUS_HTTP[body.status] ?? 500;
  return json(body, status, { ...cors, "Cache-Control": status === 200 ? CACHE_CONTROL : "no-store" });
}

/** One id's records from a committed register's id or EIN shard. Stem shards are a name index, not records. */
async function registerRecords(readFile, register, id) {
  try {
    const manifest = await readFile(`data/${register}/manifest.json`);
    const bucketCount = Number(manifest?.bucket_count) || 64;
    const bucket = registerIdBucket(id, bucketCount);
    const shard = (manifest.shards || []).find((s) => isRegisterIdShard(s) && s.bucket === bucket);
    if (!shard) return { status: "not_available" };
    const decoded = recordsFromRegisterShard(await readFile(registerShardPath(register, shard)));
    if (!decoded.ok) return { status: "not_available" };
    const want = String(id);
    return { status: "ok", records: decoded.records.filter((rec) => String(rec.register_record_id) === want) };
  } catch { return { status: "not_available" }; }
}

/** Entry for a ref's stem (or null), so the handler pre-reads only the shards that entry needs. */
async function entryForRef(opened, ref) {
  if (opened?.status !== "ok") return null;
  const p = parseEntityRef(ref);
  if (!p.ok) return null;
  const o = ordinalForStem(opened.index, p.stem);
  if (o < 0) return null;
  const r = await entriesFor(opened.index, [o]);
  return r.entries ? r.entries.get(o) : null;
}

/** Certified-business lookup with the shards for these accounts pre-read. */
async function sbsFor(readFile, accounts) {
  try {
    const manifest = await readFile("data/sbs_certified_businesses.json");
    const names = await readFile("data/sbs_certified_businesses/names.json");
    const facets = await readFile("data/sbs_certified_businesses/facets.json");
    const shards = new Map();
    const o = openSbsDirectory({ manifest, names, facets, readShard: (p) => shards.get(p) });
    if (o.status !== "ok") return null;
    for (const p of shardPathsForAccounts(o.directory, accounts)) shards.set(p, await readFile(p));
    return { directory: o.directory, getByAccount };
  } catch { return null; }
}

/** {register -> {byId}} for this entry's ids; a register whose shard cannot be read is left out (block says not_available). */
async function registersFor(readFile, entry) {
  const out = {};
  for (const [register, kind] of [["irs_eo_bmf_ny", "ein"], ["nys_dol_contractor_registry", "dol"], ["nyc_sca_prequalified_firms", "sca"]]) {
    const ids = entry?.ids?.[kind] || [];
    if (!ids.length) continue;
    const byId = new Map();
    let ok = true;
    for (const id of ids) {
      const r = await registerRecords(readFile, register, id);
      if (r.status !== "ok") { ok = false; break; }
      byId.set(String(id), r.records);
    }
    if (ok) out[register] = { byId };
  }
  return out;
}

/**
 * GET /vendor-profile?ref=org:{stem}[#{kind}:{id}] -> cityscroll.organization_record.v1.
 * storedVendorProfile(stem) is the existing KV read of worker/src/vendor_profile.mjs.
 */
export async function handleOrganizationRecord(request, env = {}, { readFile = env.ORGANIZATION_INDEX_READER || pagesReader(), nowMs, cors = {}, storedVendorProfile } = {}) {
  const ref = new URL(request.url).searchParams.get("ref") || "";
  const opened = await organizationIndex(readFile, nowMs);
  const entry = await entryForRef(opened, ref);
  const body = await assembleOrganizationRecord(opened, ref, {
    sbs: entry?.ids?.sbs?.length ? await sbsFor(readFile, entry.ids.sbs) : null,
    dosCommitted: await committedStateLookup(readFile),
    vendorProfile: storedVendorProfile,
    doingBusiness: (stem) => { const r = lookupDoingBusinessFromWarehouse(stem); return r.hit ? [r.payload] : []; },
    registers: await registersFor(readFile, entry),
  });
  const status = STATUS_HTTP[body.status] ?? 500;
  return json(body, status, { ...cors, "Cache-Control": status === 200 ? "public, max-age=300" : "no-store" });
}

export { LIMITS as ORGANIZATION_SEARCH_LIMITS };
