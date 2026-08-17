const MANIFEST_SCHEMA = "cityscroll.address-index-manifest.v1";
const SHARD_SCHEMA = "cityscroll.address-index-shard.v1";
const DEFAULT_MANIFEST_URL = "/data/address-index/manifest.json";

const BOROUGH_NAMES = Object.freeze({
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island",
});

const STREET_WORDS = Object.freeze({
  STREET: "ST",
  STR: "ST",
  AVENUE: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  ROAD: "RD",
  PLACE: "PL",
  DRIVE: "DR",
  LANE: "LN",
  COURT: "CT",
  TERRACE: "TER",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  EXPRESSWAY: "EXPY",
  TURNPIKE: "TPKE",
  CIRCLE: "CIR",
  SQUARE: "SQ",
  TRAIL: "TRL",
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
});

const BOROUGH_PATTERNS = Object.freeze([
  ["5", /\bSTATEN\s+ISLAND\b/],
  ["2", /\b(?:THE\s+)?BRONX\b/],
  ["3", /\bBROOKLYN\b/],
  ["4", /\bQUEENS\b/],
  ["1", /\bMANHATTAN\b|\bNEW\s+YORK(?:\s+CITY)?\b/],
]);

function asciiUpper(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toUpperCase();
}

export function normalizeStreetName(value) {
  const tokens = asciiUpper(value)
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^(\d+)(?:ST|ND|RD|TH)$/, "$1"))
    .map((token) => STREET_WORDS[token] || token);
  return tokens.join(" ");
}

function normalizeHouseDisplay(value) {
  return asciiUpper(value).replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").trim();
}

export function houseSortKey(value) {
  const house = normalizeHouseDisplay(value);
  let match = house.match(/^(\d{1,6})$/);
  if (match) return Number(match[1]) * 1000;
  match = house.match(/^(\d{1,5})-(\d{1,3})$/);
  if (match) return Number(`1${match[1].padStart(5, "0")}${match[2].padStart(3, "0")}`);
  return null;
}

function stripLocality(value) {
  let out = value
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/\b(?:APT|APARTMENT|UNIT|SUITE|STE|FLOOR|FL)\b.*$/g, " ")
    .replace(/\s+#\s*[A-Z0-9-]+.*$/g, " ")
    .replace(/\bNY\b\s*$/g, " ")
    .trim();
  out = out.replace(/\b(?:STATEN\s+ISLAND|THE\s+BRONX|BRONX|BROOKLYN|QUEENS|MANHATTAN|NEW\s+YORK(?:\s+CITY)?)\s*$/, " ").trim();
  return out;
}

export function parseAddressQuery(value) {
  const raw = asciiUpper(value).replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  const match = raw.match(/^(\d{1,6}(?:-\d{1,3})?(?:\s+1\/2|[A-Z])?)\s+(.+)$/);
  if (!match) return { status: "not_full_address" };
  const house = normalizeHouseDisplay(match[1]);
  const zip = raw.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null;
  const boroughCode = BOROUGH_PATTERNS.find(([, pattern]) => pattern.test(raw))?.[0] || null;
  const street = normalizeStreetName(stripLocality(match[2]));
  if (!street || street.length < 2) return { status: "not_full_address" };
  return {
    house,
    house_sort: houseSortKey(house),
    street,
    borough_code: boroughCode,
    zip,
  };
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function addressShardKey(street, shardCount = 64) {
  const normalized = normalizeStreetName(street);
  const count = Number.isInteger(shardCount) && shardCount > 0 ? shardCount : 64;
  return (fnv1a(normalized) % count).toString(16).padStart(2, "0");
}

function recordMatchesHouse(record, query) {
  const [low, high, parity] = record;
  if (record.length >= 7) {
    return query.house === normalizeHouseDisplay(record[5])
      || query.house === normalizeHouseDisplay(record[6]);
  }
  if (query.house_sort != null) {
    if (query.house_sort < low || query.house_sort > high) return false;
    const parityNumber = query.house_sort >= 100_000_000
      ? query.house_sort % 1000
      : Math.floor(query.house_sort / 1000);
    if (parity === 1 && parityNumber % 2 !== 1) return false;
    if (parity === 2 && parityNumber % 2 !== 0) return false;
    return true;
  }
  return false;
}

function titleCaseStreet(street) {
  return String(street || "").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function resolveAddressFromShard(query, shard, manifest = null) {
  if (!query || query.status === "not_full_address") return { status: "unknown", reason: "not_full_address" };
  if (!shard || shard.schema !== SHARD_SCHEMA) return { status: "unknown", reason: "snapshot_unavailable" };
  const rows = shard.streets?.[query.street] || [];
  const candidates = new Map();
  for (const record of rows) {
    const bbl = String(record?.[3] || "");
    const zip = String(record?.[4] || "");
    if (!/^\d{10}$/.test(bbl) || !recordMatchesHouse(record, query)) continue;
    if (query.borough_code && bbl[0] !== query.borough_code) continue;
    if (query.zip && zip !== query.zip) continue;
    candidates.set(bbl, { bbl, zip });
  }
  if (candidates.size === 0) return { status: "unknown", reason: "not_covered" };
  if (candidates.size > 1) {
    return { status: "unknown", reason: "ambiguous", candidate_count: candidates.size };
  }
  const [{ bbl, zip }] = candidates.values();
  const borough = BOROUGH_NAMES[bbl[0]] || null;
  return {
    status: "matched",
    bbl,
    borough,
    zip: zip || null,
    label: `${query.house} ${titleCaseStreet(query.street)}, ${borough}${zip ? ` ${zip}` : ""}`,
    method: "nyc_dcp_pad_snapshot",
    source_version: manifest?.source?.version || null,
    data_as_of: manifest?.generated_at || null,
  };
}

function validManifest(value) {
  return value?.schema === MANIFEST_SCHEMA
    && Number.isInteger(value?.shard_count)
    && value.shard_count > 0
    && value.shards && typeof value.shards === "object";
}

export function createPrecomputedAddressGeocoder({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  manifestUrl = DEFAULT_MANIFEST_URL,
} = {}) {
  let manifestPromise = null;
  const shardPromises = new Map();
  async function manifest() {
    manifestPromise ||= fetchImpl(manifestUrl, { cache: "force-cache", credentials: "omit" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("address-index-unavailable")))
      .then((value) => validManifest(value) ? value : Promise.reject(new Error("address-index-invalid")));
    return manifestPromise;
  }
  return async function geocodeAddress(value) {
    const query = parseAddressQuery(value);
    if (query.status === "not_full_address") return { status: "unknown", reason: "not_full_address" };
    try {
      const indexManifest = await manifest();
      const key = addressShardKey(query.street, indexManifest.shard_count);
      const descriptor = indexManifest.shards[key];
      if (!descriptor?.file) return { status: "unknown", reason: "not_covered" };
      if (!shardPromises.has(key)) {
        const url = new URL(descriptor.file, new URL(manifestUrl, "https://cityscroll.invalid")).pathname;
        shardPromises.set(key, fetchImpl(url, { cache: "force-cache", credentials: "omit" })
          .then((response) => response.ok ? response.json() : Promise.reject(new Error("address-shard-unavailable"))));
      }
      return resolveAddressFromShard(query, await shardPromises.get(key), indexManifest);
    } catch (_error) {
      return { status: "unknown", reason: "snapshot_unavailable" };
    }
  };
}

export const ADDRESS_INDEX_MANIFEST_SCHEMA = MANIFEST_SCHEMA;
export const ADDRESS_INDEX_SHARD_SCHEMA = SHARD_SCHEMA;
