/**
 * The pre-shaped read model behind the public Contracts browse capability.
 *
 * The shared procurement read model is the authority for procurement objects,
 * but it is shaped for one object at a time: the manifest maps a canonical id
 * to the bounded shard that carries the object and its source observations, and
 * a reader that wants one contract reads one shard. A browse is the opposite
 * shape. It has to know how many objects match before it can answer, and the
 * only way to learn that from the detail family is to read every shard and
 * materialize every object — work that grows with the population on every
 * single call.
 *
 * This module publishes the shape a browse actually needs, in two tiers:
 *
 *   filter tier  one compact entry per contract, carrying exactly the values
 *                the browse filters read plus the pre-lowercased text the
 *                keyword filter matches against. Every call reads the whole
 *                filter tier, so it is deliberately kept to the values the
 *                filters use and nothing else.
 *   detail tier  the per-contract material a result row needs that cannot be
 *                derived from the index envelope. Entries are written in
 *                canonical id order, which is the order a browse returns, so
 *                one page of results is a contiguous run and reads at most
 *                PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_READ_BOUND shards.
 *
 * Everything a result row carries that is a property of the population rather
 * than of one contract — source envelopes, publication policy, freshness — is
 * stored once in the index envelope and composed back onto the page at read
 * time by composeProcurementBrowseCapabilityContract. The same composition
 * produces the single-object result, so the browse row and the object row are
 * the same projection by construction rather than by agreement.
 *
 * Shards follow the conventions site/procurement_read_model_shards.mjs and
 * site/analytical_projection_shards.mjs already use: an index that names its
 * shards, a byte ceiling below Cloudflare Pages' per-file guard, and a load
 * that reports the population unavailable rather than answering from a
 * truncated one.
 */

import { materializeProcurementSearchDocument } from "./procurement_search_producer.mjs";
import { contractSearchDocumentToMoneyRow } from "./contract_search_bridge.mjs";
import { publicProcurementAmount } from "./checkbook_passport_corroboration.mjs";

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

/** Bytes one entry costs inside a shard's `entries` array, separator included. */
function nestedEntryBytes(entry) {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
}

export function procurementBrowseCapabilityFilterShardPath(index) {
  return `${PROCUREMENT_BROWSE_CAPABILITY_SHARD_DIRECTORY}/filter-${String(index).padStart(3, "0")}.json`;
}

export function procurementBrowseCapabilityDetailShardPath(index) {
  return `${PROCUREMENT_BROWSE_CAPABILITY_SHARD_DIRECTORY}/detail-${String(index).padStart(3, "0")}.json`;
}

function shardPayload(schema, shardId, entries) {
  return { schema, version: 1, shard_id: shardId, entries };
}

/**
 * Pack entries into shards no larger than the ceiling, preserving order. A
 * shard that still exceeds the ceiling holds a single entry larger than a whole
 * shard, which no split can fix, so the build stops with the offending path.
 */
function packShards(entries, { schema, maxShardBytes, pathFor, label }) {
  const emptyBytes = serializedBytes(shardPayload(schema, "candidate", []));
  const chunks = [];
  let current = { entries: [], bytes: emptyBytes };
  for (const entry of entries) {
    const entryBytes = nestedEntryBytes(entry);
    if (current.entries.length && current.bytes + entryBytes > maxShardBytes) {
      chunks.push(current);
      current = { entries: [], bytes: emptyBytes };
    }
    current.entries.push(entry);
    current.bytes += entryBytes;
  }
  chunks.push(current);

  const shards = chunks.map((chunk, index) => shardPayload(schema, String(index).padStart(3, "0"), chunk.entries));
  const descriptors = shards.map((shard, index) => ({
    path: pathFor(index),
    bytes: serializedBytes(shard),
    entry_count: shard.entries.length,
  }));
  for (const descriptor of descriptors) {
    if (descriptor.bytes > maxShardBytes) {
      throw new Error(`${label} shard ${descriptor.path} is ${descriptor.bytes} bytes, above the `
        + `${maxShardBytes}-byte ceiling. A single entry exceeds one shard: reduce the entry, not the ceiling.`);
    }
  }
  return { shards, descriptors };
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

function sourceObservationView(observation) {
  return {
    source_observation_ref: observation?.source_observation_ref || null,
    source_system: observation?.source_system || null,
    source_id: observation?.source_system_id || null,
    ingested_at: observation?.ingested_at || null,
  };
}

/**
 * The per-contract material a browse row needs and the envelope cannot supply.
 * Derived from the shared read model, so the read model stays the authority for
 * identity, browse fields, source evidence and amount.
 */
export function procurementBrowseCapabilityDetail(model, object, observationIndex = null) {
  const refs = Array.isArray(object?.source_observation_refs) ? object.source_observation_refs : [];
  const observations = observationIndex
    ? refs.map((ref) => observationIndex.get(ref)).filter(Boolean)
    : (Array.isArray(model?.observations) ? model.observations : [])
      .filter((entry) => refs.includes(entry.source_observation_ref));
  const document = materializeProcurementSearchDocument(object, model, observationIndex);
  const browseRow = document ? contractSearchDocumentToMoneyRow(document) : null;
  const amountValue = publicProcurementAmount(object, observations);
  return {
    object_type: object.object_type,
    schema: object.schema,
    procurement_id: object.procurement_id,
    canonical_id: object.canonical_id,
    source_observation_refs: object.source_observation_refs,
    stages: object.stages,
    identity_keys: object.identity_keys,
    identity_edges: object.identity_edges,
    lifecycle: object.lifecycle || null,
    ...(Array.isArray(object.lifecycles) ? { lifecycles: object.lifecycles } : {}),
    compatibility: object.compatibility,
    ...(browseRow
      ? { fields: (() => { const { search_document: _searchDocument, ...fields } = browseRow; return fields; })() }
      : {}),
    source_observations: observations.map(sourceObservationView),
    not_yet_joined: Array.isArray(object.coverage?.not_yet_joined) ? object.coverage.not_yet_joined : [],
    amount_value: amountValue == null ? null : amountValue,
  };
}

/** The compact entry every browse filter reads, and nothing else. */
export function procurementBrowseCapabilityFilterEntry(detail) {
  const fields = detail.fields || {};
  const value = detail.amount_value;
  return {
    procurement_id: detail.procurement_id,
    agency: normalizedText(fields.agency_name),
    vendor: normalizedText(fields.vendor_name),
    stages: Array.isArray(fields.procurement_stages) ? fields.procurement_stages : [],
    source_systems: Array.isArray(fields.source_systems) ? fields.source_systems : [],
    amount_value: value == null ? null : value,
    amount_valid: typeof value === "number" && Number.isFinite(value)
      && value > 0 && value < PUBLIC_AMOUNT_MAX_EXCLUSIVE,
    // The keyword filter has always matched the serialized browse fields. The
    // text is normalized and lowercased here, once at build time, so a call
    // never re-serializes a row to answer a query.
    search_text: normalizedText(JSON.stringify(fields)),
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

/**
 * Build the whole index in memory, without sharding. This is the shape an
 * offline fixture or a test that already holds a read model uses, and it is the
 * shape the sharded artifacts reassemble to.
 */
export function buildProcurementBrowseCapabilityIndex(model) {
  if (model?.schema !== PROCUREMENT_BROWSE_CAPABILITY_SOURCE_MODEL_SCHEMA || !Array.isArray(model?.rows)) {
    throw new Error("shared procurement read model is unavailable");
  }
  if (model.identity_gate?.ok === false) throw new Error("shared procurement identity gate failed");
  const observationIndex = new Map((Array.isArray(model.observations) ? model.observations : [])
    .map((observation) => [observation?.source_observation_ref, observation])
    .filter(([ref]) => ref));
  const ids = new Set();
  const contractIds = new Map();
  const details = [];
  for (const object of model.rows) {
    if (!object?.procurement_id || ids.has(object.procurement_id)) {
      throw new Error("shared procurement identity is not unique");
    }
    ids.add(object.procurement_id);
    for (const contractId of object.identity_keys?.contract_ids || []) {
      const prior = contractIds.get(contractId);
      if (prior && prior !== object.procurement_id) throw new Error("prime contract identity was collapsed");
      contractIds.set(contractId, object.procurement_id);
    }
    details.push(procurementBrowseCapabilityDetail(model, object, observationIndex));
  }
  // Canonical id ascending is the order the browse capability declares, so the
  // published order is already the answer order and a page is a contiguous run.
  details.sort((left, right) => left.procurement_id.localeCompare(right.procurement_id));
  return {
    schema: PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA,
    version: 1,
    generated_at: model.generated_at || null,
    source_model_schema: model.schema,
    entry_count: details.length,
    ...procurementBrowseCapabilityEnvelope(model),
    entries: details.map(procurementBrowseCapabilityFilterEntry),
    details,
  };
}

/** Split a built index into the published manifest and its bounded shards. */
export function buildProcurementBrowseCapabilityIndexArtifacts(model, {
  filterShardMaxBytes = DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_MAX_BYTES,
  detailShardMaxBytes = DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_MAX_BYTES,
} = {}) {
  const { entries, details, ...envelope } = buildProcurementBrowseCapabilityIndex(model);
  const detail = packShards(details, {
    schema: PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_SCHEMA,
    maxShardBytes: detailShardMaxBytes,
    pathFor: procurementBrowseCapabilityDetailShardPath,
    label: "Contracts browse detail",
  });
  // Each filter entry names the shard that carries its detail, so a page reads
  // exactly the shards it needs without the reader having to reproduce the
  // build's sort to locate them.
  const shardByProcurementId = new Map();
  detail.shards.forEach((shard, index) => {
    for (const row of shard.entries) shardByProcurementId.set(row.procurement_id, index);
  });
  const filter = packShards(
    entries.map((entry) => ({ ...entry, detail_shard: shardByProcurementId.get(entry.procurement_id) ?? null })),
    {
      schema: PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_SCHEMA,
      maxShardBytes: filterShardMaxBytes,
      pathFor: procurementBrowseCapabilityFilterShardPath,
      label: "Contracts browse filter",
    },
  );
  return {
    manifest: {
      ...envelope,
      representation: "sharded",
      filter_shard_schema: PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_SCHEMA,
      detail_shard_schema: PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_SCHEMA,
      filter_shards: filter.descriptors,
      detail_shards: detail.descriptors,
    },
    filterShards: filter.shards,
    detailShards: detail.shards,
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
