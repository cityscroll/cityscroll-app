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

// Sub-borough place names that imply a borough and a bounded ZIP set. A
// published ZIP outside the allowlist is a typed locality conflict — dropping
// the place name to force a PAD hit is refused.
const CONSTRAINED_LOCALITY_ZIPS = Object.freeze({
  FLUSHING: Object.freeze(["11354", "11355", "11356", "11357", "11358", "11367"]),
  JAMAICA: Object.freeze(["11432", "11433", "11434", "11435", "11436"]),
  ASTORIA: Object.freeze(["11102", "11103", "11105", "11106"]),
  "LONG ISLAND CITY": Object.freeze(["11101", "11109"]),
});

const CONSTRAINED_LOCALITY_BOROUGH = Object.freeze({
  FLUSHING: "4",
  JAMAICA: "4",
  ASTORIA: "4",
  "LONG ISLAND CITY": "4",
});

const HOUSE_PREFIX_RE = /^(\d{1,6}(?:-\d{1,3})?(?:\s+1\/2|[A-Z])?)\s+(.+)$/;
const UNIT_SEGMENT_RE = /^(?:(?:APT|APARTMENT|UNIT|SUITE|STE|ROOM|RM|FL|FLOOR|LOBBY|BLDG|BUILDING)\b|#)|(?:\d{1,2}(?:ST|ND|RD|TH)\s+(?:FLOOR|FL)\b)/i;
const INLINE_UNIT_RE = /(?:\s+(?:APT|APARTMENT|UNIT|SUITE|STE|ROOM|RM|FL|FLOOR|LOBBY|BLDG|BUILDING)\b|\s+#)\s*[A-Z0-9-]+.*$/i;
const COUNTRY_SEGMENT_RE = /^(?:USA|U\s*S\s*A|U\.S\.A\.?|UNITED STATES(?: OF AMERICA)?)$/i;
const STATE_SEGMENT_RE = /^(?:NY|NEW YORK)$/i;
const ZIP_SEGMENT_RE = /^(\d{5})(?:-\d{4})?$/;
const STATE_ZIP_SEGMENT_RE = /^(?:NY|NEW YORK)\s+(\d{5})(?:-\d{4})?$/i;
const NYC_ZIP_RE = /^(?:10[0-9]{3}|11[0-6][0-9]{2})$/;

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

function boroughCodeFromText(value) {
  return BOROUGH_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0] || null;
}

function isUnitSegment(segment) {
  return UNIT_SEGMENT_RE.test(segment);
}

function isCountrySegment(segment) {
  return COUNTRY_SEGMENT_RE.test(segment);
}

function isStateSegment(segment) {
  return STATE_SEGMENT_RE.test(segment);
}

/**
 * True when a constrained locality's published ZIP falls outside its allowlist.
 * Unlisted neighborhood names (e.g. Forest Hills) are decorative context kept
 * off the street key; they do not invent a conflict on their own.
 */
export function localityConflictsWithZip(locality, zip) {
  const key = asciiUpper(locality || "").replace(/\s+/g, " ").trim();
  if (!key || !zip) return false;
  const allowed = CONSTRAINED_LOCALITY_ZIPS[key];
  if (!allowed) return false;
  return !allowed.includes(String(zip));
}

export function isSupportedNycZip(zip) {
  if (!zip) return true;
  return NYC_ZIP_RE.test(String(zip));
}

/**
 * Separate house/street from room, locality, borough, state, ZIP, and country
 * before street normalization. Comma boundaries are preserved so trailing
 * "Forest Hills, NY 11375, USA" and "2nd Floor Auditorium" leave a usable
 * street key while borough/ZIP constraints stay attached.
 */
export function parseAddressQuery(value) {
  const original = String(value || "").trim();
  if (!original) return { status: "not_full_address" };

  const hasComma = original.includes(",");
  let house = null;
  let streetSource = null;
  let zip = null;
  let boroughCode = null;
  let locality = null;
  let unsupportedZip = false;

  if (hasComma) {
    const segments = original
      .split(",")
      .map((part) => asciiUpper(part).replace(/\./g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    // Leading house number only. Building-name prefixes stay on the venue-span
    // extraction path; this parser does not scan later segments for a house.
    const streetMatch = segments[0]?.match(HOUSE_PREFIX_RE);
    if (!streetMatch) return { status: "not_full_address" };

    house = normalizeHouseDisplay(streetMatch[1]);
    // Drop trailing room/unit markers that share the street segment
    // ("3 Washington Square Village #1A") before street normalization.
    streetSource = streetMatch[2].replace(INLINE_UNIT_RE, " ").trim();

    const localityParts = [];
    for (let index = 1; index < segments.length; index += 1) {
      const segment = segments[index];
      if (isCountrySegment(segment) || isUnitSegment(segment)) continue;

      const stateZip = segment.match(STATE_ZIP_SEGMENT_RE);
      if (stateZip) {
        zip = stateZip[1];
        continue;
      }
      const zipOnly = segment.match(ZIP_SEGMENT_RE);
      if (zipOnly) {
        zip = zipOnly[1];
        continue;
      }
      if (isStateSegment(segment)) continue;

      if (/^(?:STATEN\s+ISLAND|THE\s+BRONX|BRONX|BROOKLYN|QUEENS|MANHATTAN|NEW\s+YORK(?:\s+CITY)?)$/.test(segment)) {
        boroughCode = boroughCode || boroughCodeFromText(segment);
        continue;
      }

      const constrainedBorough = CONSTRAINED_LOCALITY_BOROUGH[segment];
      if (constrainedBorough) {
        boroughCode = boroughCode || constrainedBorough;
        localityParts.push(segment);
        continue;
      }

      localityParts.push(segment);
    }

    locality = localityParts.length ? localityParts.join(", ") : null;
  } else {
    const raw = asciiUpper(original).replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
    const match = raw.match(HOUSE_PREFIX_RE);
    if (!match) return { status: "not_full_address" };
    house = normalizeHouseDisplay(match[1]);
    streetSource = stripLocality(match[2]);
    zip = raw.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null;
    boroughCode = boroughCodeFromText(raw);
  }

  if (zip && !isSupportedNycZip(zip)) {
    unsupportedZip = true;
  }

  boroughCode = boroughCode || boroughCodeFromText(asciiUpper(original));
  if (!boroughCode && locality) {
    boroughCode = CONSTRAINED_LOCALITY_BOROUGH[asciiUpper(locality).replace(/\s+/g, " ").trim()] || null;
  }

  const street = normalizeStreetName(streetSource);
  if (!street || street.length < 2) return { status: "not_full_address" };

  const query = {
    house,
    house_sort: houseSortKey(house),
    street,
    borough_code: boroughCode,
    zip: unsupportedZip ? null : zip,
    locality,
  };
  if (unsupportedZip) {
    query.unsupported_zip = zip;
    query.status = "unsupported_zip";
  }
  if (localityConflictsWithZip(locality, zip)) {
    query.locality_conflict = true;
  }
  return query;
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
  if (query.status === "unsupported_zip" || query.unsupported_zip) {
    return { status: "unknown", reason: "unsupported_zip" };
  }
  if (query.locality_conflict) {
    return { status: "unknown", reason: "contradictory_locality", candidate_count: 0 };
  }
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
