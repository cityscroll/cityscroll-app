#!/usr/bin/env node
/**
 * Materialize property cross-domain joins (BBL → ZAP, owner → contracts, agency).
 *
 * CPU-light: reads committed property domain observations (+ optional live
 * property-locations refresh), fixture demos, and existing ZAP-BBL / OCP
 * lookups. Does NOT run warehouse bulk ingest.
 *
 *   node tools/build_property_cross_domain.mjs
 *   node tools/build_property_cross_domain.mjs --from-live   # refresh observations from API
 *   node tools/build_property_cross_domain.mjs --check
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPropertyCrossDomainDoc,
  buildParcelIntelligence,
  normalizeBbl,
  extractDispositionOwner,
} from "../entity_resolution/cross_domain/index.mjs";
import {
  loadCsvIfExists,
  loadJsonIfExists,
} from "./lib/entity_intelligence_build.mjs";
import {
  publicPayloadFindings,
  publicRecords,
} from "./lib/public_payload_integrity.mjs";
import { selectHistoricalProjectContext } from "../site/historical_project_context.mjs";
import { DCAS_VEHICLE_AUCTION_DATASET } from "../site/dcas_vehicle_auctions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_SITE = join(ROOT, "site/data/property_cross_domain_lookup.json");
const OUT_WORKER = join(ROOT, "worker/src/data/property_cross_domain_lookup.json");
const BBL_LOOKUP_PATH = existsSync(join(ROOT, "site/data/zap_bbl_warehouse_lookup.json"))
  ? join(ROOT, "site/data/zap_bbl_warehouse_lookup.json")
  : join(ROOT, "worker/src/data/zap_bbl_warehouse_lookup.json");
const HISTORICAL_CONTEXT_DIR = join(ROOT, "site/data/historical_project_context");
const LL48_PATH = join(ROOT, "site/data/property_ll48_lookup.json");
const PROPERTY_OBS_PATH = join(ROOT, "site/data/property_domain_observations.json");
// Confirmed against worker/src/property.mjs + source_contracts.json:
// property_domain_observations is built ONLY from City Record Online
// (dg92-zbpx / contract city-record, 168h). DCAS vehicle auctions
// (ynic-uz5i / contract dcas-vehicle-auction-list) are a separate sidecar
// excluded from property rows, joins, and map counts, with their own 8-day /
// 21-day freshness contract. Property-domain vintage is therefore the City
// Record rowsUpdatedAt only — never min()'d with the DCAS sidecar clock.
const CIVIC_PROPERTY_DATASET_ID = "dg92-zbpx";
const CIVIC_PROPERTY_SOURCE =
  `https://data.cityofnewyork.us/City-Government/City-Record-Online/${CIVIC_PROPERTY_DATASET_ID}`;
const CIVIC_PROPERTY_METADATA_URL =
  `https://data.cityofnewyork.us/api/views/${CIVIC_PROPERTY_DATASET_ID}.json`;
const DCAS_VEHICLE_AUCTION_METADATA_URL =
  `https://data.cityofnewyork.us/api/views/${DCAS_VEHICLE_AUCTION_DATASET}.json`;
const CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD = "rowsUpdatedAt";
const PROPERTY_DOMAIN_PROVIDER_CLOCK_KIND = "whole_dataset_provider_clock";
// Small allowance for provider/local clock skew when rejecting "future" stamps.
const CIVIC_PROPERTY_FUTURE_SKEW_MS = 15 * 60 * 1000;

export {
  CIVIC_PROPERTY_DATASET_ID,
  CIVIC_PROPERTY_SOURCE,
  CIVIC_PROPERTY_METADATA_URL,
  DCAS_VEHICLE_AUCTION_DATASET,
  DCAS_VEHICLE_AUCTION_METADATA_URL,
  CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD,
  PROPERTY_DOMAIN_PROVIDER_CLOCK_KIND,
  CIVIC_PROPERTY_FUTURE_SKEW_MS,
};

/**
 * Fields kept on committed property domain observations (CPU-light rebuild).
 * Body HTML is intentionally omitted: agency + BBL densify do not need it, and
 * notice bodies carry phones/emails that must not land in a public PR surface.
 * Labeled owner demos stay on the small fixture corpus.
 */
const PROPERTY_OBS_KEEP = [
  "request_id",
  "start_date",
  "agency_name",
  "type_of_notice_description",
  "section_name",
  "short_title",
  "event_date",
  "street_address_1",
  "property_location",
  "disposition_stage",
  "disposition_subject_ref",
  "disposition_join_keys",
];

/** Drop phones/emails from free text that may appear in titles. */
function scrubPublicText(value) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\bestimat(?:e|ed|es|ing|ion)\b/gi, "approx");
}

function slimPropertyRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = { domain: "property", source_system: "city_record" };
  for (const key of PROPERTY_OBS_KEEP) {
    if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
  }
  if (!out.section_name) out.section_name = "Property Disposition";
  if (out.short_title) out.short_title = scrubPublicText(out.short_title);
  if (out.street_address_1) out.street_address_1 = scrubPublicText(out.street_address_1);
  // Never commit notice body HTML (PII + size).
  delete out.additional_description_1;
  return out.request_id && out.agency_name ? out : null;
}

function uniqueBblsFromRows(rows) {
  const set = new Set();
  for (const row of rows || []) {
    for (const b of row?.property_location?.bbls || []) {
      const n = normalizeBbl(b);
      if (n) set.add(n);
    }
  }
  return set;
}

/**
 * Parse SODA rowsUpdatedAt with strict type + range checks.
 * Rejects boolean (Number(true)===1), objects, non-integer numbers, and
 * non-digit strings. Accepts a positive integer epoch-seconds number, or a
 * digit-only string of the same.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, epochSeconds: number } | { ok: false, reason: string }}
 */
export function parseStrictRowsUpdatedAtEpoch(raw) {
  if (raw == null || raw === "") {
    return { ok: false, reason: "missing_rowsUpdatedAt" };
  }
  // Booleans coerce via Number(true)===1 — never accept them.
  if (typeof raw === "boolean") {
    return { ok: false, reason: "invalid_rowsUpdatedAt" };
  }
  let epochSeconds = null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      return { ok: false, reason: "invalid_rowsUpdatedAt" };
    }
    epochSeconds = raw;
  } else if (typeof raw === "string") {
    if (!/^[1-9]\d*$/.test(raw)) {
      return { ok: false, reason: "invalid_rowsUpdatedAt" };
    }
    epochSeconds = Number(raw);
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) {
      return { ok: false, reason: "invalid_rowsUpdatedAt" };
    }
  } else {
    return { ok: false, reason: "invalid_rowsUpdatedAt" };
  }
  // Epoch-seconds floor: reject sub-second ms stamps mistaken for seconds and
  // pre-Unix-civic noise. 946684800 = 2000-01-01T00:00:00Z.
  if (epochSeconds < 946684800) {
    return { ok: false, reason: "invalid_rowsUpdatedAt" };
  }
  return { ok: true, epochSeconds };
}

/**
 * Resolve one SODA whole-dataset provider clock from /api/views/<id>.json.
 *
 * Uses ONLY metadata.rowsUpdatedAt (dataUpdatedAt is null on both Property view
 * datasets today). This is a provider-wide SODA view clock — not per-record
 * publication time and not proof a bounded query is complete. Fail-closed:
 * metadata id mismatch, missing, invalid, or future clocks return ok:false
 * with vintage null.
 *
 * @param {object|null} metadata — SODA /api/views/<id>.json body
 * @param {object} opts
 * @param {string} opts.dataset_id — expected dataset id (must equal metadata.id)
 * @param {string|Date} [opts.now] — evaluation instant (acquisition time)
 * @param {string|null} [opts.previous_vintage] — prior component vintage; a
 *   backwards move is drifting and fails closed when supplied
 */
export function resolveSodaRowsUpdatedAtClock(metadata, opts = {}) {
  const datasetId = opts.dataset_id || CIVIC_PROPERTY_DATASET_ID;
  const nowMs = Date.parse(opts.now || new Date().toISOString());
  const base = {
    dataset_id: datasetId,
    clock_field: CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD,
    clock_kind: "whole_dataset_provider_clock",
    vintage: null,
    ok: false,
  };
  if (!Number.isFinite(nowMs)) {
    return { ...base, reason: "invalid_evaluation_time" };
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ...base, reason: "missing_metadata" };
  }
  // Returned view id must match the dataset we requested — never accept a
  // swapped or proxied catalog body as this dataset's clock.
  if (metadata.id == null || metadata.id === "") {
    return { ...base, reason: "missing_metadata_id" };
  }
  if (String(metadata.id) !== String(datasetId)) {
    return {
      ...base,
      reason: "metadata_id_mismatch",
      observed_metadata_id: String(metadata.id),
    };
  }
  // dataUpdatedAt / publicationDate are intentionally ignored: a fresh sibling
  // field must never vouch for rowsUpdatedAt, and publicationDate on these
  // catalogs is a multi-year-old creation stamp.
  if (!Object.prototype.hasOwnProperty.call(metadata, CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD)
    || metadata[CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD] == null
    || metadata[CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD] === "") {
    return { ...base, reason: "missing_rowsUpdatedAt" };
  }
  const parsed = parseStrictRowsUpdatedAtEpoch(metadata[CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD]);
  if (!parsed.ok) {
    return { ...base, reason: parsed.reason };
  }
  const clockMs = parsed.epochSeconds * 1000;
  if (clockMs > nowMs + CIVIC_PROPERTY_FUTURE_SKEW_MS) {
    return { ...base, reason: "future_rowsUpdatedAt" };
  }
  const vintage = new Date(clockMs).toISOString();
  const previous = opts.previous_vintage == null ? null : String(opts.previous_vintage);
  if (previous) {
    const previousMs = Date.parse(previous);
    if (Number.isFinite(previousMs) && clockMs < previousMs) {
      return { ...base, reason: "drifting_rowsUpdatedAt_moved_backwards" };
    }
  }
  return {
    ...base,
    ok: true,
    reason: null,
    vintage,
  };
}

/**
 * PROPERTY_LOCATIONS_URL points at the Worker property-locations mirror.
 * That mirror can freeze while SODA catalogs keep moving; stamping mirror rows
 * with today's unrelated rowsUpdatedAt would relabel old content as fresh.
 * Live --from-live refresh therefore rejects the override outright. Offline /
 * fixture work uses PROPERTY_LOCATIONS_PATH and must not invent a freshness
 * vintage from live SODA metadata.
 *
 * @param {NodeJS.ProcessEnv|object} [env]
 * @returns {{ ok: true, mode: string } | { ok: false, reason: string, note: string }}
 */
export function evaluatePropertyLocationsUrlForLiveRefresh(env = process.env) {
  const url = env?.PROPERTY_LOCATIONS_URL;
  if (url == null || url === "") {
    return { ok: true, mode: "soda_direct" };
  }
  return {
    ok: false,
    reason: "property_locations_url_mirror_forbidden_for_live_refresh",
    note:
      "PROPERTY_LOCATIONS_URL selects the Worker property-locations mirror, which "
      + "can serve frozen rows. Live refresh must acquire City Record Property "
      + "Disposition rows via buildPropertyView and stamp property-domain vintage "
      + "from dg92-zbpx rowsUpdatedAt only. For offline/fixture work set "
      + "PROPERTY_LOCATIONS_PATH to a local JSON file and supply "
      + "source_generated_at / provider_clock on that file; never stamp mirror "
      + "bytes with unrelated live SODA rowsUpdatedAt.",
  };
}

/**
 * Resolve the City Record Online (dg92-zbpx) provider clock used for
 * property_domain_observations source_generated_at.
 */
export function resolveCivicPropertyProviderClock(metadata, opts = {}) {
  return resolveSodaRowsUpdatedAtClock(metadata, {
    ...opts,
    dataset_id: CIVIC_PROPERTY_DATASET_ID,
  });
}

/**
 * Resolve the DCAS vehicle-auction (ynic-uz5i) provider clock.
 * Used only to validate that dataset's own metadata id/clock; it must NEVER
 * become property-domain source_generated_at (separate dcas-vehicle-auction-list
 * contract owns that sidecar's freshness).
 */
export function resolveDcasVehicleAuctionProviderClock(metadata, opts = {}) {
  return resolveSodaRowsUpdatedAtClock(metadata, {
    ...opts,
    dataset_id: DCAS_VEHICLE_AUCTION_DATASET,
  });
}

export function civicPropertyDatasetVintageFromMetadata(metadata, opts = {}) {
  const resolved = resolveCivicPropertyProviderClock(metadata, opts);
  return resolved.ok ? resolved.vintage : null;
}

/**
 * Newest publisher start_date among acquired property rows — content evidence,
 * not the freshness vintage consumed by the first-class gate.
 */
export function maxPropertyRowStartDate(properties = []) {
  let newest = null;
  for (const row of Array.isArray(properties) ? properties : []) {
    const raw = row?.start_date;
    if (!raw) continue;
    const iso = new Date(raw).toISOString();
    if (!Number.isFinite(Date.parse(iso))) continue;
    if (newest == null || iso > newest) newest = iso;
  }
  return newest;
}

/**
 * Build a committed property domain observation snapshot from a live (or local) feed.
 * @param {object} feed — /property-locations JSON or City Record Property view
 * @param {object} opts
 * @param {string|null} [opts.source_generated_at] — City Record (dg92-zbpx) rowsUpdatedAt.
 *   Never substitute fetch/build time or the DCAS sidecar clock. Null means UNKNOWN.
 * @param {string|null} [opts.acquired_at] — when this run acquired the feed (not vintage)
 * @param {object|null} [opts.provider_clock] — resolveCivicPropertyProviderClock result
 */
export function propertyDomainObservationsFromFeed(feed, opts = {}) {
  const properties = Array.isArray(feed?.properties) ? feed.properties : [];
  const rows = [];
  for (const row of properties) {
    const slim = slimPropertyRow(row);
    if (!slim) continue;
    // Prefer BBL-bearing disposition rows for densify; keep a few unlocated
    // only when explicitly requested (default: BBL rows only + any with join keys).
    const bbls = slim.property_location?.bbls || [];
    if (!opts.includeUnlocated && !bbls.length) continue;
    rows.push(slim);
  }
  const bblSet = uniqueBblsFromRows(rows);
  const acquiredAt = opts.acquired_at || null;
  // Prefer an explicit upstream vintage. Do not fall back to feed.generated_at:
  // the Worker Property view stamps that as local build time.
  const sourceGeneratedAt = Object.prototype.hasOwnProperty.call(opts, "source_generated_at")
    ? (opts.source_generated_at || null)
    : (feed?.source_generated_at || null);
  const providerClock = opts.provider_clock && typeof opts.provider_clock === "object"
    ? opts.provider_clock
    : null;
  return {
    schema_version: 1,
    version: "property_domain_observations_v1",
    source: opts.source || feed?.source?.url || "property-locations",
    source_generated_at: sourceGeneratedAt,
    content_evidence_newest_start_date: maxPropertyRowStartDate(properties),
    acquired_at: acquiredAt,
    // Keep generated_at identical to source_generated_at so the first-class
    // vintage_fields fallback cannot treat acquisition/build time as current
    // evidence. Acquisition time lives only on acquired_at.
    generated_at: sourceGeneratedAt,
    provider_clock: {
      dataset_id: providerClock?.dataset_id || CIVIC_PROPERTY_DATASET_ID,
      field: providerClock?.clock_field || CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD,
      kind: providerClock?.clock_kind || PROPERTY_DOMAIN_PROVIDER_CLOCK_KIND,
      ok: providerClock ? Boolean(providerClock.ok) : sourceGeneratedAt != null,
      reason: providerClock?.reason || null,
      note:
        `SODA /api/views/${CIVIC_PROPERTY_DATASET_ID}.json rowsUpdatedAt for City Record Online. `
        + "Whole-dataset provider clock for the city-record contract that owns "
        + "property_domain_observations. Not per-record publication time and not proof "
        + "the bounded section_name='Property Disposition' query is complete. "
        + `DCAS vehicle auctions (${DCAS_VEHICLE_AUCTION_DATASET}) are a separate sidecar `
        + "under dcas-vehicle-auction-list and do not set this vintage.",
    },
    property_count: rows.length,
    bbl_count: bblSet.size,
    property_rows: rows,
    note:
      "CPU-light snapshot of Property Disposition rows that expose BBLs. Agency + parcel edges densify from these; ZAP edges need exact zap-bbl overlap. source_generated_at is dg92-zbpx rowsUpdatedAt (City Record whole-dataset provider clock), never local build time and never the DCAS sidecar clock.",
  };
}

async function fetchSodaViewMetadata(url, label, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "cityscroll-property-cross-domain/1.0" },
  });
  if (!res.ok) {
    throw new Error(`${label} dataset metadata fetch failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch SODA view metadata for City Record Online (dg92-zbpx). Authorized
 * --from-live acquisition path only.
 */
export async function fetchCivicPropertyDatasetMetadata(fetchImpl = fetch) {
  return fetchSodaViewMetadata(CIVIC_PROPERTY_METADATA_URL, "City Record", fetchImpl);
}

/**
 * Fetch SODA view metadata for DCAS vehicle auctions (ynic-uz5i). Authorized
 * --from-live acquisition path only.
 */
export async function fetchDcasVehicleAuctionDatasetMetadata(fetchImpl = fetch) {
  return fetchSodaViewMetadata(
    DCAS_VEHICLE_AUCTION_METADATA_URL,
    "DCAS vehicle auction",
    fetchImpl,
  );
}

/**
 * Acquire City Record Property Disposition rows (via buildPropertyView) and
 * stamp property-domain vintage from dg92-zbpx rowsUpdatedAt only. Only invoked
 * from the authorized --from-live refresh path. The Worker KV mirror can freeze
 * while civic rows continue to move; first-class refresh must not inherit that
 * mirror's build-time generated_at as source vintage. DCAS vehicle-auction rows
 * may appear on the feed as a sidecar but never set property-domain vintage.
 *
 * Returns { feed, provider_clock, source_generated_at, acquired_at }.
 * source_generated_at is null when the City Record provider clock fails closed.
 */
export async function fetchCivicPropertyFeed(fetchImpl = fetch, now = new Date(), opts = {}) {
  const acquiredAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const { buildPropertyView } = await import("../worker/src/property.mjs");
  const [feed, metadata] = await Promise.all([
    buildPropertyView(fetchImpl, now instanceof Date ? now : new Date(now)),
    fetchCivicPropertyDatasetMetadata(fetchImpl).catch((error) => {
      console.error("City Record dataset metadata unavailable:", String(error?.message || error));
      return null;
    }),
  ]);
  const providerClock = resolveCivicPropertyProviderClock(metadata, {
    now: acquiredAt,
    previous_vintage: opts.previous_vintage || null,
  });
  if (!providerClock.ok) {
    console.warn(
      "property provider clock fail-closed:",
      providerClock.reason,
      "(source_generated_at stays UNKNOWN; freshness will not invent build time)",
    );
  } else {
    console.log(
      "property provider clock:",
      `dataset=${providerClock.dataset_id}`,
      `rowsUpdatedAt=${providerClock.vintage}`,
      "(DCAS sidecar excluded from property-domain vintage)",
    );
  }
  return {
    feed,
    provider_clock: providerClock,
    source_generated_at: providerClock.ok ? providerClock.vintage : null,
    acquired_at: acquiredAt,
  };
}

function flattenZapBblLookup(lookup) {
  const rows = [];
  if (!lookup || !Array.isArray(lookup.rows)) return rows;
  for (const entry of lookup.rows) {
    const projectId = entry?.project_id;
    if (!projectId) continue;
    if (Array.isArray(entry.bbls)) {
      for (const bbl of entry.bbls) {
        const n = normalizeBbl(bbl);
        if (n) rows.push({ project_id: projectId, bbl: n, source_system: "zap-bbl" });
      }
    } else if (entry.bbl) {
      const n = normalizeBbl(entry.bbl);
      if (n) rows.push({ project_id: projectId, bbl: n, source_system: "zap-bbl" });
    }
  }
  return rows;
}

function mergePropertyLocation(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const bbls = new Set();
  for (const src of [left, right]) {
    for (const raw of src.bbls || []) {
      const n = normalizeBbl(raw);
      if (n) bbls.add(n);
    }
  }
  // Prefer the location that already carries BBLs / geometry; union BBL lists.
  const base =
    (right.bbls || []).length >= (left.bbls || []).length ? { ...left, ...right } : { ...right, ...left };
  if (bbls.size) base.bbls = [...bbls].sort();
  return base;
}

function dedupePropertyRows(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = String(row?.request_id || "").trim();
    if (!id) continue;
    // Prefer richer rows when merging fixture + live:
    // union BBLs, keep labeled-owner body language, prefer non-empty stage.
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, row);
      continue;
    }
    const prevOwner = extractDispositionOwner(prev);
    const nextOwner = extractDispositionOwner(row);
    const preferNextBody = Boolean(nextOwner) && !prevOwner;
    const preferPrevBody = Boolean(prevOwner) && !nextOwner;
    const merged = {
      ...prev,
      ...row,
      // Keep the description that yields a labeled owner when only one does.
      additional_description_1: preferNextBody
        ? row.additional_description_1
        : preferPrevBody
          ? prev.additional_description_1
          : row.additional_description_1 || prev.additional_description_1,
      short_title: preferPrevBody
        ? prev.short_title || row.short_title
        : row.short_title || prev.short_title,
      agency_name: row.agency_name || prev.agency_name,
      disposition_stage: row.disposition_stage || prev.disposition_stage,
      property_location: mergePropertyLocation(prev.property_location, row.property_location),
    };
    byId.set(id, merged);
  }
  return [...byId.values()];
}

function collectCorpus(root, propertyObsDoc) {
  const propertyRows = [];
  const zapBblRows = [];
  const zapProjects = [];
  const moneyRows = [];
  const ll48Rows = [];

  // Live / committed property materialization (main densify source)
  if (propertyObsDoc?.property_rows?.length) {
    for (const row of propertyObsDoc.property_rows) {
      propertyRows.push({
        ...row,
        section_name: row.section_name || "Property Disposition",
        domain: "property",
        source_system: row.source_system || "city_record",
      });
    }
  }

  for (const p of [join(root, "warehouse/fixtures/zap-bbl/product_seed.csv")]) {
    for (const row of loadCsvIfExists(p)) {
      if (row.project_id && row.bbl) zapBblRows.push({ ...row, source_system: "zap-bbl" });
    }
  }

  // Committed WH-06 lookup (fixture-scale until Mini bulk) — exact BBL only
  const bblLookup = loadJsonIfExists(BBL_LOOKUP_PATH);
  for (const row of flattenZapBblLookup(bblLookup)) zapBblRows.push(row);

  for (const p of [join(root, "warehouse/fixtures/ocp-recent-contract-awards/product_seed.csv")]) {
    for (const row of loadCsvIfExists(p)) moneyRows.push(row);
  }
  const ocpLookup = loadJsonIfExists(join(root, "site/data/ocp_awards_warehouse_lookup.json"));
  if (ocpLookup?.rows) {
    for (const row of ocpLookup.rows.slice(0, 200)) moneyRows.push(row);
  }

  const ll48Lookup = loadJsonIfExists(LL48_PATH);
  if (Array.isArray(ll48Lookup?.rows)) ll48Rows.push(...ll48Lookup.rows);

  for (const p of [join(root, "warehouse/fixtures/zap-projects/product_seed.csv")]) {
    for (const row of loadCsvIfExists(p)) zapProjects.push(row);
  }
  const zapLookup = loadJsonIfExists(join(root, "site/data/zap_projects_warehouse_lookup.json"));
  if (zapLookup?.rows) {
    const mihLookup = loadJsonIfExists(join(root, "site/data/mih_project_lookup.json"));
    const historicalRows = existsSync(HISTORICAL_CONTEXT_DIR)
      ? readdirSync(HISTORICAL_CONTEXT_DIR).filter((name) => /^\d{4}\.json$/.test(name))
        .sort().flatMap((name) => loadJsonIfExists(join(HISTORICAL_CONTEXT_DIR, name))?.rows || [])
      : [];
    const selected = selectHistoricalProjectContext({
      currentRows: zapLookup.rows,
      zapBblRows,
      mihRows: mihLookup?.rows || [],
      publisherRows: [...zapLookup.rows, ...historicalRows],
    });
    for (const row of selected.retained_rows) zapProjects.push(row);
  }

  return {
    propertyRows: dedupePropertyRows(
      publicRecords(propertyRows, "property cross-domain property rows"),
    ),
    zapBblRows: publicRecords(zapBblRows, "property cross-domain ZAP BBL rows"),
    zapProjects: publicRecords(zapProjects, "property cross-domain ZAP projects"),
    moneyRows: publicRecords(moneyRows, "property cross-domain money rows"),
    ll48Rows: publicRecords(ll48Rows, "property cross-domain LL48 rows"),
    property_source: propertyObsDoc
      ? {
          path: "site/data/property_domain_observations.json",
          bbl_count: propertyObsDoc.bbl_count,
          property_count: propertyObsDoc.property_count,
          source_generated_at: propertyObsDoc.source_generated_at,
        }
      : null,
  };
}

/** Pick demo BBLs: known field cases when present + live lots beyond the hand-picked pair. */
function pickDemoBbls(corpus, byBbl) {
  const preferred = ["1006440001", "3025180036", "3044440001", "5006840261"];
  const demos = [];
  for (const bbl of preferred) {
    if (byBbl?.[bbl]?.property_notices?.length) demos.push(bbl);
  }
  for (const bbl of Object.keys(byBbl || {}).sort()) {
    if (demos.includes(bbl)) continue;
    const bucket = byBbl[bbl];
    if (!bucket?.property_notices?.length) continue;
    demos.push(bbl);
    if (demos.length >= 7) break;
  }
  return demos;
}

async function main() {
  const check = process.argv.includes("--check");
  const fromLive = process.argv.includes("--from-live");
  const localFeed = process.env.PROPERTY_LOCATIONS_PATH || null;

  let propertyObsDoc = loadJsonIfExists(PROPERTY_OBS_PATH);

  // Refresh the committed property domain snapshot only on explicit --from-live.
  // PROPERTY_LOCATIONS_PATH (optional) points at a local feed JSON for offline/fixture
  // work and must carry its own source_generated_at / provider_clock — never invent
  // vintage from live SODA while reading local bytes.
  // PROPERTY_LOCATIONS_URL (Worker mirror) is rejected for live refresh: mirror rows
  // can freeze while SODA clocks keep moving, which would relabel old content as fresh.
  // Default --from-live acquires rows via buildPropertyView + both metadata endpoints.
  // --check never rewrites inputs — it rebuilds from the committed snapshot only.
  // Resident / production / required-CI paths call this without --from-live and
  // stay materialization-only against the committed snapshot.
  if (fromLive && !check) {
    const mirrorOverride = evaluatePropertyLocationsUrlForLiveRefresh(process.env);
    if (!mirrorOverride.ok) {
      console.error(
        "refusing PROPERTY_LOCATIONS_URL for live refresh:",
        mirrorOverride.reason,
        mirrorOverride.note,
      );
      process.exit(1);
    }
    const acquiredAt = new Date().toISOString();
    // Only compare drift against a prior City Record stamp. A leftover
    // combined-min stamp (mistakenly including the DCAS sidecar) must not
    // block restamping with the city-record contract clock.
    const previousKind = propertyObsDoc?.provider_clock?.kind || null;
    const previousDataset = propertyObsDoc?.provider_clock?.dataset_id || null;
    const previousVintage =
      previousDataset === CIVIC_PROPERTY_DATASET_ID
      || previousKind === PROPERTY_DOMAIN_PROVIDER_CLOCK_KIND
        ? (propertyObsDoc?.source_generated_at || null)
        : null;
    let feed;
    let sourceLabel;
    let sourceGeneratedAt = null;
    let providerClock = null;
    if (localFeed) {
      if (!existsSync(localFeed)) {
        console.error("PROPERTY_LOCATIONS_PATH missing:", localFeed);
        process.exit(1);
      }
      feed = JSON.parse(readFileSync(localFeed, "utf8"));
      sourceLabel = localFeed;
      // Offline/fixture path: only the file's own source-bound vintage fields count.
      // Never fetch live SODA metadata to stamp local/mirror bytes.
      sourceGeneratedAt = feed?.source_generated_at || null;
      providerClock = feed?.provider_clock || {
        dataset_id: CIVIC_PROPERTY_DATASET_ID,
        clock_field: CIVIC_PROPERTY_PROVIDER_CLOCK_FIELD,
        clock_kind: PROPERTY_DOMAIN_PROVIDER_CLOCK_KIND,
        ok: false,
        reason: sourceGeneratedAt
          ? "offline_feed_missing_provider_clock"
          : "offline_feed_missing_source_generated_at",
      };
      if (!sourceGeneratedAt) {
        console.warn(
          "offline PROPERTY_LOCATIONS_PATH feed has no source_generated_at; "
          + "vintage stays UNKNOWN (will not stamp with live SODA clocks).",
        );
      }
    } else {
      console.log(
        "acquiring Property Disposition from City Record",
        CIVIC_PROPERTY_DATASET_ID,
        "(DCAS sidecar excluded from property-domain vintage)",
      );
      const acquired = await fetchCivicPropertyFeed(fetch, new Date(acquiredAt), {
        previous_vintage: previousVintage,
      });
      feed = acquired.feed;
      sourceLabel = feed?.source?.url || CIVIC_PROPERTY_SOURCE;
      sourceGeneratedAt = acquired.source_generated_at;
      providerClock = acquired.provider_clock;
    }
    propertyObsDoc = propertyDomainObservationsFromFeed(feed, {
      source: sourceLabel,
      source_generated_at: sourceGeneratedAt,
      acquired_at: acquiredAt,
      provider_clock: providerClock,
    });
    if (!propertyObsDoc.source_generated_at) {
      console.warn(
        "warning: property source_generated_at is UNKNOWN "
        + `(provider clock reason=${providerClock?.reason || "unknown"}). `
        + "Freshness will fail closed rather than inventing build time as vintage.",
      );
    }
    mkdirSync(dirname(PROPERTY_OBS_PATH), { recursive: true });
    writeFileSync(PROPERTY_OBS_PATH, `${JSON.stringify(propertyObsDoc, null, 2)}\n`);
    console.log(
      "wrote property domain observations",
      PROPERTY_OBS_PATH,
      "rows",
      propertyObsDoc.property_count,
      "bbls",
      propertyObsDoc.bbl_count,
      "source_generated_at",
      propertyObsDoc.source_generated_at,
      "acquired_at",
      propertyObsDoc.acquired_at,
      "provider_clock_dataset",
      propertyObsDoc.provider_clock?.dataset_id,
      "provider_clock_field",
      propertyObsDoc.provider_clock?.field,
      "content_evidence_newest_start_date",
      propertyObsDoc.content_evidence_newest_start_date,
    );
  }

  if (!propertyObsDoc?.property_rows?.length) {
    console.warn(
      "warning: no site/data/property_domain_observations.json — property joins remain empty. Re-run with --from-live.",
    );
  }

  const corpus = collectCorpus(ROOT, propertyObsDoc);
  const doc = buildPropertyCrossDomainDoc(corpus);

  // Provenance: stamp property source + honest ZAP sparsity note
  if (corpus.property_source) {
    doc.provenance = {
      ...doc.provenance,
      property_feed: corpus.property_source,
    };
  }

  const demoBbls = pickDemoBbls(corpus, doc.by_bbl);
  const demos = {};
  for (const bbl of demoBbls) {
    demos[bbl] = buildParcelIntelligence(bbl, corpus);
  }
  const out = {
    ...doc,
    demos,
    demo_bbls: demoBbls,
  };
  const integrityFindings = publicPayloadFindings(out, {
    source: "site/data/property_cross_domain_lookup.json",
  });
  if (integrityFindings.length) {
    console.error("property cross-domain output contains test-only records", integrityFindings);
    process.exit(1);
  }

  if (check) {
    if (!existsSync(OUT_SITE)) {
      console.error("missing", OUT_SITE);
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(OUT_SITE, "utf8"));
    const pick = (d) => ({
      version: d.version,
      metrics: d.metrics,
      coverage: d.coverage,
      demo_bbls: d.demo_bbls,
      by_bbl_count: Object.keys(d.by_bbl || {}).length,
    });
    const a = JSON.stringify(pick(existing));
    const b = JSON.stringify(pick(out));
    if (a !== b) {
      console.error("property_cross_domain_lookup.json drift — re-run without --check");
      process.exit(1);
    }
    console.log("property cross-domain lookup OK", {
      by_bbl: Object.keys(out.by_bbl || {}).length,
      metrics: out.metrics,
      coverage: out.coverage,
    });
    return;
  }

  mkdirSync(dirname(OUT_SITE), { recursive: true });
  mkdirSync(dirname(OUT_WORKER), { recursive: true });
  const text = `${JSON.stringify(out, null, 2)}\n`;
  writeFileSync(OUT_SITE, text);
  writeFileSync(OUT_WORKER, text);
  console.log(
    "wrote property cross-domain lookup",
    OUT_SITE,
    "bbls",
    Object.keys(out.by_bbl || {}).length,
    "coverage",
    out.coverage,
  );
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
