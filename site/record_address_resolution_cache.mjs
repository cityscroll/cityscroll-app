/**
 * Normalized observed-address resolution cache.
 *
 * Reuses one exact PAD parcel outcome per normalized address key and PAD
 * content identity. Multiple source assertions may reference the same cache
 * entry without losing their original published wording or civic roles.
 * Address aliases share BBL identity only after exact resolution — never by
 * fuzzy text similarity. Empty, malformed, and ambiguous inputs never invent
 * a BBL.
 *
 * Uses parseAddressQuery, addressShardKey, and resolveAddressFromShard from
 * the precomputed PAD index directly. Keep this module free of
 * location_extract.mjs (module-dom inline rebuild binding collisions).
 */

import {
  addressShardKey,
  parseAddressQuery,
  resolveAddressFromShard,
} from "./precomputed_address_geocoder.mjs";

export const RECORD_ADDRESS_RESOLUTION_CACHE_SCHEMA = "cityscroll.record_address_resolution_cache.v1";
export const RECORD_ADDRESS_RESOLUTION_ENTRY_SCHEMA = "cityscroll.record_address_resolution_entry.v1";
export const RECORD_ADDRESS_RESOLUTION_METHOD = "nyc_dcp_pad_snapshot";

const KEY_SEP = "\u001f";

/**
 * Stable PAD content identity for cache keys and invalidation.
 * Combines the published PAD version string with the source archive digest.
 * @param {object|null|undefined} manifest
 * @returns {string}
 */
export function padContentIdentity(manifest) {
  const version = String(manifest?.source?.version || "").trim();
  const sha256 = String(manifest?.source?.sha256 || "").trim().toLowerCase();
  if (!version && !sha256) return "";
  return `${version}|${sha256}`;
}

/**
 * Cache key: normalized house/street + explicit borough + ZIP + PAD identity.
 * Returns null when the query is not a full address (no guessed key).
 * @param {object} query - parseAddressQuery result
 * @param {string} padIdentity - padContentIdentity(manifest)
 * @returns {string|null}
 */
export function normalizedAddressCacheKey(query, padIdentity) {
  if (!query || query.status === "not_full_address") return null;
  const house = String(query.house || "").trim();
  const street = String(query.street || "").trim();
  if (!house || !street) return null;
  return [
    house,
    street,
    query.borough_code == null ? "" : String(query.borough_code),
    query.zip == null ? "" : String(query.zip),
    String(padIdentity || ""),
  ].join(KEY_SEP);
}

/**
 * Build a free-text address line from a source-qualified location assertion
 * (or plain components) without inventing a borough the publisher omitted.
 * @param {object} assertion
 * @returns {string|null}
 */
export function addressTextFromAssertion(assertion) {
  if (!assertion || typeof assertion !== "object") return null;
  const components = assertion.components || null;
  if (components?.street_address) {
    const region = components.address_region === "New York" ? "NY" : components.address_region;
    const locality = components.address_borough || components.address_locality || null;
    const cityStateZip = [
      locality,
      [region, components.postal_code].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ");
    return [components.street_address, cityStateZip].filter(Boolean).join(", ") || null;
  }
  const original = String(assertion.original_address || "").trim();
  return original || null;
}

function cleanPublishedAddress(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * Shape one retained cache entry from a PAD resolver result.
 * Never copies a MapPLUTO / parcel-source street label into the entry —
 * published wording lives on the assertion reference.
 */
function shapeEntry({
  cacheKey,
  query,
  padIdentity,
  manifest,
  result,
}) {
  const matched = result?.status === "matched";
  const candidateCount = matched
    ? 1
    : (Number.isInteger(result?.candidate_count) ? result.candidate_count : 0);
  return {
    schema: RECORD_ADDRESS_RESOLUTION_ENTRY_SCHEMA,
    cache_key: cacheKey,
    normalized: {
      house: query.house,
      street: query.street,
      borough_code: query.borough_code || null,
      zip: query.zip || null,
    },
    pad_content_identity: padIdentity,
    source_version: manifest?.source?.version || result?.source_version || null,
    status: result?.status || "unknown",
    reason: result?.reason || (matched ? null : "unknown"),
    bbl: matched ? String(result.bbl) : null,
    candidate_count: candidateCount,
    method: matched ? (result.method || RECORD_ADDRESS_RESOLUTION_METHOD) : null,
    zip: matched ? (result.zip || query.zip || null) : null,
    borough: matched ? (result.borough || null) : null,
  };
}

/**
 * Attach a source assertion to a cache entry without replacing its published
 * address with a parcel-coordinate-source label (e.g. MapPLUTO "901 CHURCH
 * AVENUE" for the corner lot that PAD resolves from "461 Coney Island Avenue").
 */
export function linkAssertionToResolution(assertion, entry, {
  parcel_source_label = null,
} = {}) {
  if (!assertion || !entry) return null;
  const published = cleanPublishedAddress(
    assertion.original_address
    || assertion.components?.street_address
    || null,
  );
  const parcelLabel = cleanPublishedAddress(parcel_source_label);
  // Exact BBL joins may observe an alternate parcel label; it is retained as
  // a separate field and never overwrites the publisher's wording.
  return {
    assertion_id: assertion.assertion_id || null,
    meeting_id: assertion.meeting_id || null,
    record_id: assertion.record_id || null,
    role: assertion.role || null,
    published_address: published,
    parcel_source_label: parcelLabel,
    published_address_preserved: Boolean(published)
      && published !== parcelLabel,
    cache_key: entry.cache_key,
    bbl: entry.bbl,
    status: entry.status,
    reason: entry.reason,
  };
}

/**
 * Create a retained normalized-address resolution cache bound to one PAD
 * manifest generation. Resolution goes through parseAddressQuery /
 * addressShardKey / resolveAddressFromShard (or an injected spy).
 *
 * @param {object} options
 * @param {object} options.manifest - address-index manifest
 * @param {(shardKey: string) => object|null|undefined} options.loadShard
 * @param {typeof resolveAddressFromShard} [options.resolveFn]
 * @returns {object} cache materializer API
 */
export function createRecordAddressResolutionCache({
  manifest,
  loadShard,
  resolveFn = resolveAddressFromShard,
} = {}) {
  if (!manifest || typeof loadShard !== "function") {
    throw new Error("record address resolution cache requires manifest and loadShard");
  }

  const entries = new Map();
  const assertionLinks = [];
  const bblIndex = new Map(); // bbl -> Set of cache keys (alias identity after exact resolution)
  let padIdentity = padContentIdentity(manifest);
  let activeManifest = manifest;
  let resolveCalls = 0;

  function ensurePadIdentity(nextManifest) {
    const nextIdentity = padContentIdentity(nextManifest);
    if (nextIdentity !== padIdentity) {
      entries.clear();
      bblIndex.clear();
      // Assertion links from a prior PAD generation stay inspectable but no
      // longer satisfy cache hits under the new identity.
      padIdentity = nextIdentity;
      activeManifest = nextManifest;
    } else {
      activeManifest = nextManifest || activeManifest;
    }
    return padIdentity;
  }

  function rememberBbl(entry) {
    if (!entry?.bbl) return;
    if (!bblIndex.has(entry.bbl)) bblIndex.set(entry.bbl, new Set());
    bblIndex.get(entry.bbl).add(entry.cache_key);
  }

  /**
   * Resolve one address text (or assertion) through the cache.
   * Cache hits under the same PAD identity do not call the resolver again.
   */
  function resolveAddress(input, {
    assertion = null,
    parcel_source_label = null,
    manifest: manifestOverride = null,
  } = {}) {
    if (manifestOverride) ensurePadIdentity(manifestOverride);

    const fromAssertion = assertion && !input ? addressTextFromAssertion(assertion) : null;
    const addressText = cleanPublishedAddress(input) || fromAssertion;
    const query = parseAddressQuery(addressText || "");
    const identity = padIdentity;
    const cacheKey = normalizedAddressCacheKey(query, identity);

    if (!cacheKey) {
      const emptyEntry = {
        schema: RECORD_ADDRESS_RESOLUTION_ENTRY_SCHEMA,
        cache_key: null,
        normalized: null,
        pad_content_identity: identity,
        source_version: activeManifest?.source?.version || null,
        status: "unknown",
        reason: query?.status === "not_full_address" ? "not_full_address" : "empty_or_malformed",
        bbl: null,
        candidate_count: 0,
        method: null,
        zip: null,
        borough: null,
      };
      if (assertion) {
        assertionLinks.push(linkAssertionToResolution(assertion, emptyEntry, { parcel_source_label }));
      }
      return emptyEntry;
    }

    if (entries.has(cacheKey)) {
      const cached = entries.get(cacheKey);
      if (assertion) {
        assertionLinks.push(linkAssertionToResolution(assertion, cached, { parcel_source_label }));
      }
      return cached;
    }

    resolveCalls += 1;
    const shardCount = Number.isInteger(activeManifest.shard_count) && activeManifest.shard_count > 0
      ? activeManifest.shard_count
      : 64;
    // Fixture manifests may collapse all streets into one synthetic shard.
    const preferredKey = addressShardKey(query.street, shardCount);
    let shard = loadShard(preferredKey);
    if (!shard || shard.schema !== "cityscroll.address-index-shard.v1") {
      shard = loadShard("00") || loadShard("pad-street-subsets") || null;
    }
    // When a fixture packs every street into one document, prefer that doc's
    // streets map regardless of the preferred shard key.
    if (shard && !shard.streets?.[query.street]) {
      const fallback = loadShard("00") || loadShard("pad-street-subsets");
      if (fallback?.streets?.[query.street]) shard = fallback;
    }

    let result = resolveFn(query, shard, activeManifest);
    // When explicit borough/ZIP filters erase every candidate that an
    // unconstrained house+street query would still see as ambiguous, keep the
    // unresolved outcome visible — do not silently collapse to a bare miss.
    if (
      result?.status === "unknown"
      && result?.reason === "not_covered"
      && (query.borough_code || query.zip)
    ) {
      const unconstrained = {
        ...query,
        borough_code: null,
        zip: null,
      };
      const open = resolveFn(unconstrained, shard, activeManifest);
      if (open?.status === "unknown" && open?.reason === "ambiguous") {
        result = {
          status: "unknown",
          reason: "contradictory_locality",
          candidate_count: open.candidate_count,
        };
      }
    }
    const entry = shapeEntry({
      cacheKey,
      query,
      padIdentity: identity,
      manifest: activeManifest,
      result,
    });
    entries.set(cacheKey, entry);
    rememberBbl(entry);
    if (assertion) {
      assertionLinks.push(linkAssertionToResolution(assertion, entry, { parcel_source_label }));
    }
    return entry;
  }

  /**
   * Materialize resolutions for a batch of source inputs. Repeated normalized
   * keys under one PAD identity share one resolution. Returns a deterministic
   * cache document (sorted keys) suitable for later persistence.
   *
   * @param {Array<object|string>} inputs
   * @param {object} [options]
   * @param {object} [options.manifest] - when PAD identity changes, the cache
   *   invalidates through this same production function before resolving.
   */
  function materialize(inputs = [], { manifest: manifestOverride = null } = {}) {
    if (manifestOverride) ensurePadIdentity(manifestOverride);
    const list = Array.isArray(inputs) ? inputs : [];
    const results = [];
    for (const item of list) {
      if (item == null) {
        results.push(resolveAddress(null));
        continue;
      }
      if (typeof item === "string") {
        results.push(resolveAddress(item));
        continue;
      }
      const assertion = item.assertion || (item.schema?.includes("meeting_location_assertion") ? item : null);
      const address = item.address
        || item.original_address
        || (assertion ? addressTextFromAssertion(assertion) : null)
        || null;
      results.push(resolveAddress(address, {
        assertion: assertion || (item.role || item.assertion_id ? item : null),
        parcel_source_label: item.parcel_source_label || null,
      }));
    }

    const sortedEntries = [...entries.values()].sort((left, right) =>
      String(left.cache_key).localeCompare(String(right.cache_key)));
    const byBbl = {};
    for (const [bbl, keys] of [...bblIndex.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      byBbl[bbl] = [...keys].sort();
    }

    return {
      schema: RECORD_ADDRESS_RESOLUTION_CACHE_SCHEMA,
      pad_content_identity: padIdentity,
      source_version: activeManifest?.source?.version || null,
      resolve_calls: resolveCalls,
      entry_count: sortedEntries.length,
      entries: sortedEntries,
      by_bbl: byBbl,
      assertion_links: assertionLinks.slice(),
      results,
    };
  }

  function snapshot() {
    return materialize([]);
  }

  return {
    resolveAddress,
    materialize,
    snapshot,
    padContentIdentity: () => padIdentity,
    resolveCallCount: () => resolveCalls,
    getEntry: (cacheKey) => entries.get(cacheKey) || null,
    entriesForBbl: (bbl) => [...(bblIndex.get(String(bbl)) || [])],
    assertionLinks: () => assertionLinks.slice(),
  };
}

/**
 * Convenience: materialize a cache from inputs and a shard loader in one call.
 * Used by verification and later ingestion stages.
 */
export function materializeRecordAddressResolutionCache({
  manifest,
  loadShard,
  inputs = [],
  resolveFn = resolveAddressFromShard,
} = {}) {
  const cache = createRecordAddressResolutionCache({ manifest, loadShard, resolveFn });
  return { cache, document: cache.materialize(inputs) };
}
