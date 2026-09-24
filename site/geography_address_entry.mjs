/**
 * Geography-specific address entry adapter.
 *
 * Joins the exact local PAD result (via geocodeAddressText's existing BBL
 * contract) to ONE cached parcel-geography shard and converts the stored
 * membership bundle into the shared resident entry result. Display-polygon
 * point-in-polygon is never re-run on this path.
 *
 * Cold-cache reads fetch the PAD manifest/street shard and the one parcel
 * shard for the matched BBL — never the citywide corpus. Entered addresses and
 * optional position coordinates stay off URL, history, and analytics.
 */

import { geocodeAddressText } from "./address_geocoder.mjs";
import {
  normalizeStreetName,
  parseAddressQuery,
} from "./precomputed_address_geocoder.mjs";
import {
  lookupParcelMemberships,
  PARCEL_GEOGRAPHY_MANIFEST_SCHEMA,
  PARCEL_GEOGRAPHY_POINT_METHOD,
  PARCEL_GEOGRAPHY_SHARD_COUNT,
  PARCEL_GEOGRAPHY_SHARD_SCHEMA,
  parcelShardKey,
} from "./parcel_geography.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_SOURCES,
  geographyEntryRecoveryResult,
  resolveGeographyEntryFromParcelMemberships,
} from "./geography_navigation_entry.mjs";

export const PARCEL_GEOGRAPHY_BROWSER_MANIFEST_URL = "/data/parcel-geography/manifest.json";

/** Common NYC street-type completions when a resident omits "Avenue"/"Street". */
export const STREET_TYPE_SUFFIXES = Object.freeze([
  "ST",
  "AVE",
  "RD",
  "BLVD",
  "PL",
  "DR",
  "LN",
  "CT",
  "TER",
  "PKWY",
  "HWY",
  "EXPY",
  "CIR",
  "SQ",
  "TRL",
]);

const BOROUGH_NAMES = Object.freeze({
  1: "Manhattan",
  2: "Bronx",
  3: "Brooklyn",
  4: "Queens",
  5: "Staten Island",
});

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) freezeDeep(entry);
  return Object.freeze(value);
}

function streetAlreadyTyped(street) {
  const tokens = String(street || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return STREET_TYPE_SUFFIXES.includes(tokens[tokens.length - 1]);
}

function ephemeralPointFrom(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return Object.freeze({ lat, lon });
}

function addressEntryResult(entry, point = null) {
  return freezeDeep({
    entry,
    ephemeralPoint: ephemeralPointFrom(point),
  });
}

function validParcelManifest(value) {
  return value?.schema === PARCEL_GEOGRAPHY_MANIFEST_SCHEMA
    && Number.isInteger(value?.shard_count)
    && value.shard_count > 0
    && value.shards
    && typeof value.shards === "object";
}

/**
 * Browser/cold-cache loader for one parcel-geography shard by BBL.
 * Fetches the manifest once, then only the shard that contains the BBL.
 */
export function createParcelGeographyShardLoader({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  manifestUrl = PARCEL_GEOGRAPHY_BROWSER_MANIFEST_URL,
} = {}) {
  let manifestPromise = null;
  const shardPromises = new Map();
  const fetchFn = typeof fetchImpl === "function" ? fetchImpl : null;

  async function manifest() {
    if (!fetchFn) throw new Error("parcel-geography-fetch-unavailable");
    manifestPromise ||= fetchFn(manifestUrl, { cache: "force-cache", credentials: "omit" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("parcel-geography-unavailable"))))
      .then((value) => (validParcelManifest(value) ? value : Promise.reject(new Error("parcel-geography-invalid"))));
    return manifestPromise;
  }

  return async function loadShardForBbl(bbl) {
    const id = String(bbl || "").trim();
    if (!/^\d{10}$/.test(id)) return null;
    try {
      const indexManifest = await manifest();
      const shardCount = Number.isInteger(indexManifest.shard_count) && indexManifest.shard_count > 0
        ? indexManifest.shard_count
        : PARCEL_GEOGRAPHY_SHARD_COUNT;
      const key = parcelShardKey(id, shardCount);
      const descriptor = indexManifest.shards[key];
      if (!descriptor?.file) return null;
      if (!shardPromises.has(key)) {
        const url = new URL(descriptor.file, new URL(manifestUrl, "https://cityscroll.invalid")).pathname;
        shardPromises.set(
          key,
          fetchFn(url, { cache: "force-cache", credentials: "omit" })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error("parcel-shard-unavailable"))))
            .then((doc) => (doc?.schema === PARCEL_GEOGRAPHY_SHARD_SCHEMA ? doc : Promise.reject(new Error("parcel-shard-invalid")))),
        );
      }
      return await shardPromises.get(key);
    } catch {
      return null;
    }
  };
}

/**
 * When a resident omits a street type ("3218 Emmons"), try appending common
 * NYC suffixes and accept only a unique BBL across successful PAD matches.
 * Does not invent a match from multiple candidates.
 */
async function geocodeWithStreetTypeCompletion(geocode, query) {
  const primary = await geocode(query);
  if (primary?.status === "matched") return primary;
  if (primary?.status === "unknown" && primary.reason === "ambiguous") return primary;

  const parsed = parseAddressQuery(query);
  if (!parsed || parsed.status === "not_full_address") return primary;
  if (streetAlreadyTyped(parsed.street)) return primary;

  const matches = new Map();
  for (const suffix of STREET_TYPE_SUFFIXES) {
    const completedStreet = normalizeStreetName(`${parsed.street} ${suffix}`);
    if (!completedStreet || completedStreet === parsed.street) continue;
    const borough = parsed.borough_code ? BOROUGH_NAMES[parsed.borough_code] : null;
    const parts = [parsed.house, completedStreet];
    if (borough) parts.push(borough);
    if (parsed.zip) parts.push(parsed.zip);
    const attempt = await geocode(parts.join(" "));
    if (attempt?.status !== "matched" || !attempt.bbl) continue;
    matches.set(String(attempt.bbl), attempt);
  }
  if (matches.size === 1) return [...matches.values()][0];
  if (matches.size > 1) {
    return { status: "unknown", reason: "ambiguous", candidate_count: matches.size };
  }
  return primary;
}

/**
 * Build the geography address entry resolver used by the Near You map island.
 *
 * @param {object} [options]
 * @param {(query: string) => Promise<object>|object} [options.geocode]
 *   Defaults to geocodeAddressText; must preserve the PAD BBL contract.
 * @param {(bbl: string) => Promise<object|null>|object|null} [options.loadParcelShard]
 * @param {string|null} [options.pointMethod]
 */
export function createGeographyAddressEntryResolver({
  geocode = geocodeAddressText,
  loadParcelShard = null,
  pointMethod = PARCEL_GEOGRAPHY_POINT_METHOD,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  parcelManifestUrl = PARCEL_GEOGRAPHY_BROWSER_MANIFEST_URL,
} = {}) {
  if (typeof geocode !== "function") {
    throw new TypeError("createGeographyAddressEntryResolver requires geocode");
  }
  const shardLoader = typeof loadParcelShard === "function"
    ? loadParcelShard
    : createParcelGeographyShardLoader({ fetchImpl, manifestUrl: parcelManifestUrl });

  return async function resolveGeographyAddressEntry(query, {
    layerData = [],
    source = GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
  } = {}) {
    const text = String(query ?? "").trim();
    if (!text) {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.EMPTY_QUERY, { source }),
      );
    }

    let pad = null;
    try {
      pad = await geocodeWithStreetTypeCompletion(geocode, text);
    } catch {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source }),
      );
    }

    if (!pad || typeof pad !== "object") {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT, { source }),
      );
    }
    if (pad.status === "unknown" && pad.reason === "ambiguous") {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_ADDRESS, { source }),
      );
    }
    if (pad.status !== "matched" || !/^\d{10}$/.test(String(pad.bbl || ""))) {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT, { source }),
      );
    }

    const bbl = String(pad.bbl);
    let shard = null;
    try {
      shard = await shardLoader(bbl);
    } catch {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE, { source }),
      );
    }
    if (!shard) {
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE, { source }),
      );
    }

    const membershipBundle = lookupParcelMemberships(shard, bbl);
    if (!membershipBundle) {
      // Successful PAD match with no stored memberships must not invent a place.
      return addressEntryResult(
        geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE, { source }),
      );
    }

    const entry = resolveGeographyEntryFromParcelMemberships(membershipBundle, {
      layerData,
      source,
      pointMethod: pointMethod || PARCEL_GEOGRAPHY_POINT_METHOD,
    });
    return addressEntryResult(entry, {
      lat: membershipBundle.lat,
      lon: membershipBundle.lon,
    });
  };
}

let productionResolver = null;

/**
 * Resolve one free-text address into the shared geography entry result using
 * the production PAD helper plus one parcel-geography shard.
 */
export function resolveGeographyAddressEntry(query, options = {}) {
  productionResolver ||= createGeographyAddressEntryResolver();
  return productionResolver(query, options);
}
