/**
 * Contracts browse capability index — build path and presentation re-exports.
 *
 * Bounded shard loads, envelope composition and filter matching live in
 * capabilities/procurement_browse_capability_read.mjs so the Worker contracts
 * adapter can depend on them without importing presentation producers.
 */

import { materializeProcurementSearchDocument } from "./procurement_search_producer.mjs";
import { contractSearchDocumentToMoneyRow } from "./contract_search_bridge.mjs";
import { publicProcurementAmount } from "./checkbook_passport_corroboration.mjs";

export {
  PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA,
  PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_SCHEMA,
  PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_SCHEMA,
  PROCUREMENT_BROWSE_CAPABILITY_INDEX_PATH,
  PROCUREMENT_BROWSE_CAPABILITY_SHARD_DIRECTORY,
  PROCUREMENT_BROWSE_CAPABILITY_SOURCE_MODEL_SCHEMA,
  DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_MAX_BYTES,
  DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_MAX_BYTES,
  PROCUREMENT_BROWSE_CAPABILITY_MAXIMUM_PAGE,
  PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_READ_BOUND,
  procurementBrowseCapabilityReadBudgetBytes,
  serializedProcurementBrowseCapabilityShard,
  procurementBrowseCapabilityFilterShardPath,
  procurementBrowseCapabilityDetailShardPath,
  procurementBrowseCapabilityEnvelope,
  composeProcurementBrowseCapabilityContract,
  loadProcurementBrowseCapabilityFilterTier,
  loadProcurementBrowseCapabilityDetails,
  procurementBrowseCapabilityEntryMatches,
} from "../capabilities/procurement_browse_capability_read.mjs";

import {
  PROCUREMENT_BROWSE_CAPABILITY_INDEX_SCHEMA,
  PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_SCHEMA,
  PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_SCHEMA,
  PROCUREMENT_BROWSE_CAPABILITY_SOURCE_MODEL_SCHEMA,
  DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_FILTER_SHARD_MAX_BYTES,
  DEFAULT_PROCUREMENT_BROWSE_CAPABILITY_DETAIL_SHARD_MAX_BYTES,
  procurementBrowseCapabilityFilterShardPath,
  procurementBrowseCapabilityDetailShardPath,
  procurementBrowseCapabilityEnvelope,
  serializedProcurementBrowseCapabilityShard,
} from "../capabilities/procurement_browse_capability_read.mjs";

const PUBLIC_AMOUNT_MAX_EXCLUSIVE = 10_000_000_000;

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function serializedBytes(value) {
  return new TextEncoder().encode(serializedProcurementBrowseCapabilityShard(value)).byteLength;
}

function nestedEntryBytes(entry) {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
}

function shardPayload(schema, shardId, entries) {
  return { schema, version: 1, shard_id: shardId, entries };
}

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

