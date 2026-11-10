/**
 * Engine-owned Contracts browse index read path: envelope composition, filter
 * matching, and bounded shard loads. Index *build* helpers that depend on
 * presentation search producers remain in site/procurement_browse_capability_index.mjs.
 */

export const PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA = "cityscroll.procurement_browse_capability_index.v1";
export const PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_SCHEMA = "cityscroll.procurement_browse_capability_filter_shard.v1";
export const PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_SCHEMA = "cityscroll.procurement_browse_capability_detail_shard.v1";
export const PROCUREMENT_BROWSE_CAPABILITY_INDEX_PATH = "procurement_browse_capability.json";
export const PROCUREMENT_BROWSE_CAPABILITY_SHARD_DIRECTORY = "procurement_browse_capability";
export const PROCUREMENT_BROWSE_CAPABILITY_SOURCE_MODEL_SCHEMA = "cityscroll.shared_procurement_read_model.v1";

// The filter tier is read whole on every call, so its ceiling is chosen for the
// number of parallel reads a call makes rather than for the Pages guard.
export const DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_MAX_BYTES = 4 * 1024 * 1024;
// The detail tier is read one page at a time, and a filtered page is a sparse
// selection rather than a contiguous run: twenty-five matches for a common word
// are scattered across the whole population. So the worst case is one shard read
// per returned row, and the ceiling below — not the number of shards — is what
// makes that bounded. It is deliberately small for that reason.
export const DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_MAX_BYTES = 64 * 1024;

// One page is at most the browse capability's maximum limit of 100 rows, so a
// page never reads more than 100 detail shards. Reading more than that means the
// index is truncated or malformed, and the reader fails closed rather than
// issuing an unbounded fan-out.
export const PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE = 100;
export const PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_READ_BOUND = PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE;

/**
 * The most bytes one browse call may read: the index document, the whole filter
 * tier, and one detail shard per returned row. Every term is a property of the
 * published shape rather than of the population, which is what makes a browse
 * bounded — the filter tier grows with the population, but the work a call does
 * with it does not grow with the page.
 */
export function procurementBrowseCapabilityReadBudgetBytes(
  manifest,
  limit = PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE,
  indexBytes = 0,
) {
  const filterBytes = (manifest?.filter_shards || []).reduce((total, descriptor) => total + (descriptor.bytes || 0), 0);
  const detailCeiling = Math.max(0, ...(manifest?.detail_shards || []).map((descriptor) => descriptor.bytes || 0));
  return indexBytes + filterBytes + detailCeiling * Math.min(limit, PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE);
}

const PUBLIC_AMOUNT_MAX_EXCLUSIVE = 10_000_000_000;

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Both tiers are read by machines on a request path and never by eye, so they
// are serialized compactly. The measurement here is the file that is written.
export function serializedProcurementBrowseCapabilityShard(value) {
  return `${JSON.stringify(value)}\n`;
}

function serializedBytes(value) {
  return new TextEncoder().encode(serializedProcurementBrowseCapabilityShard(value)).byteLength;
}

export function procurementBrowseCapabilityFilterShardPath(index) {
  return `${PROCUREMENT_BROWSE_CAPABILITY_SHARD_DIRECTORY}/filter-${String(index).padStart(3, "0")}.json`;
}

export function procurementBrowseCapabilityDetailShardPath(index) {
  return `${PROCUREMENT_BROWSE_CAPABILITY_SHARD_DIRECTORY}/detail-${String(index).padStart(3, "0")}.json`;
}

/**
 * The population-level facts every result row repeats. Kept once in the index
 * so a row carries only what is true of that one contract.
 */
export function procurementBrowseCapabilityEnvelope(model) {
  const generatedAt = model?.generated_at || model?.freshness?.generated_at || null;
  return {
    sources: model?.sources || {},
    publication: model?.publication || null,
    freshness: {
      as_of: generatedAt || "unknown",
      generated_at: generatedAt,
      checked_at: model?.freshness?.checked_at || null,
      sources: model?.freshness?.sources || {},
    },
  };
}

function sourceEnvelopeStates(envelope, observations) {
  const observed = new Set(observations.map((entry) => entry.source_system).filter(Boolean));
  return Object.fromEntries(Object.entries(envelope?.sources || {}).map(([source, sourceEnvelope]) => {
    const status = sourceEnvelope?.status || "unavailable";
    const state = observed.has(source)
      ? "observed"
      : ["unavailable", "partial"].includes(status) ? "not_observed" : "not_published";
    return [source, {
      state,
      status,
      generated_at: sourceEnvelope?.generated_at || null,
      reason: sourceEnvelope?.reason || null,
      source_row_count: sourceEnvelope?.row_count ?? null,
    }];
  }));
}

/**
 * Compose one published contract from the population envelope and one detail
 * entry. Both the browse page and the single-object read go through here, so
 * the two surfaces cannot drift apart.
 */
export function composeProcurementBrowseCapabilityContract(envelope, detail) {
  const {
    fields,
    source_observations: observations,
    not_yet_joined: notYetJoined,
    amount_value: amountValue,
    ...publicObject
  } = detail;
  const sourceEnvelopes = sourceEnvelopeStates(envelope, observations || []);
  const valid = typeof amountValue === "number" && Number.isFinite(amountValue)
    && amountValue > 0 && amountValue < PUBLIC_AMOUNT_MAX_EXCLUSIVE;
  return {
    ...publicObject,
    ...(fields ? { fields } : {}),
    provenance: {
      identity: {
        exact: true,
        basis: "site/procurement_object_contract.mjs exact identity gate",
        canonical_id: detail.procurement_id,
        prime_contract_ids: detail.identity_keys?.contract_ids || [],
        epins: detail.identity_keys?.epins || [],
      },
      source_observations: observations || [],
    },
    coverage: {
      state: "observed",
      source_envelopes: sourceEnvelopes,
      not_published: Object.entries(sourceEnvelopes)
        .filter(([, entry]) => entry.state === "not_published").map(([source]) => source),
      not_observed: Object.entries(sourceEnvelopes)
        .filter(([, entry]) => entry.state === "not_observed").map(([source]) => source),
      not_yet_joined: notYetJoined || [],
      publication: envelope?.publication || null,
    },
    freshness: { ...envelope.freshness },
    amount: {
      value: amountValue == null ? null : amountValue,
      valid,
      validity_rule: "finite amount greater than 0 and less than $10,000,000,000",
    },
  };
}

function shardEntries(shard, schema) {
  return shard?.schema === schema && Array.isArray(shard?.entries) ? shard.entries : null;
}

/**
 * Read the index and its whole filter tier. A shard that cannot be read is a
 * truncated population, not a smaller one, so the load reports nothing rather
 * than letting a partial match count read as a whole one.
 */
export async function loadProcurementBrowseCapabilityFilterTier(url, fetchJson) {
  const manifest = await fetchJson(url);
  if (manifest?.schema !== PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA) return null;
  if (Array.isArray(manifest.entries)) {
    return { manifest, entries: manifest.entries, bytesRead: null };
  }
  const base = String(url).slice(0, String(url).lastIndexOf("/") + 1);
  const descriptors = Array.isArray(manifest.filter_shards) ? manifest.filter_shards : [];
  if (!descriptors.length) return null;
  const shards = await Promise.all(descriptors.map((descriptor) => fetchJson(`${base}${descriptor.path}`)));
  const entries = [];
  for (const shard of shards) {
    const shardRows = shardEntries(shard, PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_SCHEMA);
    if (!shardRows) return null;
    entries.push(...shardRows);
  }
  if (entries.length !== manifest.entry_count) return null;
  return { manifest, entries };
}

/**
 * Read only the detail shards one page needs. Returns null when the page would
 * read more shards than the declared bound, which means the index is truncated
 * or out of order rather than that the page is large.
 */
export async function loadProcurementBrowseCapabilityDetails(url, manifest, pageEntries, fetchJson) {
  const procurementIds = pageEntries.map((entry) => entry.procurement_id);
  if (Array.isArray(manifest.details)) {
    const byId = new Map(manifest.details.map((detail) => [detail.procurement_id, detail]));
    const inline = procurementIds.map((id) => byId.get(id) || null);
    return inline.some((detail) => !detail) ? null : inline;
  }
  const descriptors = Array.isArray(manifest.detail_shards) ? manifest.detail_shards : [];
  const wanted = new Set(procurementIds);
  const shardIndexes = [...new Set(pageEntries.map((entry) => entry.detail_shard))];
  if (!wanted.size) return [];
  if (shardIndexes.some((index) => !Number.isInteger(index) || !descriptors[index])) return null;
  if (shardIndexes.length > PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_READ_BOUND) return null;
  const base = String(url).slice(0, String(url).lastIndexOf("/") + 1);
  const shards = await Promise.all(shardIndexes.map((index) => fetchJson(`${base}${descriptors[index].path}`)));
  const byId = new Map();
  for (const shard of shards) {
    const shardRows = shardEntries(shard, PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_SCHEMA);
    if (!shardRows) return null;
    for (const detail of shardRows) {
      if (wanted.has(detail.procurement_id)) byId.set(detail.procurement_id, detail);
    }
  }
  const details = procurementIds.map((id) => byId.get(id) || null);
  return details.some((detail) => !detail) ? null : details;
}

/**
 * The browse filter, applied to the compact entries. This is the same predicate
 * the capability declares: a keyword term matches anywhere in the serialized
 * browse fields, agency and vendor are case-insensitive substrings, stage and
 * source system are exact, and an amount bound requires a valid public amount.
 */
export function procurementBrowseCapabilityEntryMatches(entry, input) {
  const query = normalizedText(input.query);
  if (query && !query.split(" ").filter(Boolean).every((term) => entry.search_text.includes(term))) return false;
  if (input.agency && !entry.agency.includes(normalizedText(input.agency))) return false;
  if (input.vendor && !entry.vendor.includes(normalizedText(input.vendor))) return false;
  if (input.stage && !entry.stages.includes(input.stage)) return false;
  if (input.sourceSystem && !entry.source_systems.includes(input.sourceSystem)) return false;
  if (input.minAmount !== undefined && (!entry.amount_valid || entry.amount_value < input.minAmount)) return false;
  if (input.maxAmount !== undefined && (!entry.amount_valid || entry.amount_value > input.maxAmount)) return false;
  return true;
}
