/**
 * Build and reassemble the sharded procurement detail artifact.
 *
 * The manifest keeps the shared read-model contract and maps each canonical
 * procurement id to one bounded shard. Rows and their source observations are
 * co-located so the Pages edge can render one document without loading the
 * whole corpus.
 */

export const SHARED_PROCUREMENT_READ_MODEL_SHARD_SCHEMA = "cityscroll.shared_procurement_read_model_shard.v1";
export const DEFAULT_PROCUREMENT_SHARD_MAX_BYTES = 18 * 1024 * 1024;

function byteLength(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function shardPayload(shardId, rows, observations) {
  return {
    schema: SHARED_PROCUREMENT_READ_MODEL_SHARD_SCHEMA,
    version: 1,
    shard_id: shardId,
    rows,
    observations,
  };
}

function pathForShard(index) {
  return `shared_procurement_read_model/shard-${String(index).padStart(3, "0")}.json`;
}

function nestedJsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")).byteLength;
}

/**
 * Return the manifest and shard payloads for a full read model.
 * The byte limit is deliberately below Cloudflare Pages' per-file limit.
 */
export function buildSharedProcurementReadModelShardArtifacts(
  model,
  { maxShardBytes = DEFAULT_PROCUREMENT_SHARD_MAX_BYTES } = {},
) {
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const observations = Array.isArray(model?.observations) ? model.observations : [];
  const observationByRef = new Map(observations
    .map((observation) => [observation?.source_observation_ref, observation])
    .filter(([ref]) => ref));
  const assignedObservationRefs = new Set();
  const chunks = [];
  const emptyShardBytes = byteLength(shardPayload("candidate", [], []));
  let current = { rows: [], observations: [], bytes: emptyShardBytes };

  const observationsForRow = (row) => (Array.isArray(row?.source_observation_refs)
    ? row.source_observation_refs : [])
    .map((ref) => {
      if (assignedObservationRefs.has(ref)) return null;
      const observation = observationByRef.get(ref);
      if (!observation) return null;
      assignedObservationRefs.add(ref);
      return observation;
    })
    .filter(Boolean);

  const flush = () => {
    if (current.rows.length || current.observations.length || !chunks.length) chunks.push(current);
    current = { rows: [], observations: [], bytes: emptyShardBytes };
  };

  for (const row of rows) {
    let newObservations = observationsForRow(row);
    const rowBytes = nestedJsonByteLength(row);
    const addedBytes = () => rowBytes
      + newObservations.reduce((sum, observation) => sum + nestedJsonByteLength(observation), 0)
      + 16;
    if (current.rows.length && current.bytes + addedBytes() > maxShardBytes) {
      // The row's observations have been tentatively assigned; put them back
      // before starting the next shard.
      for (const observation of newObservations) assignedObservationRefs.delete(observation.source_observation_ref);
      chunks.push(current);
      current = { rows: [], observations: [], bytes: emptyShardBytes };
      newObservations = observationsForRow(row);
      current.rows.push(row);
      current.observations.push(...newObservations);
      current.bytes += addedBytes();
    } else {
      current.rows.push(row);
      current.observations.push(...newObservations);
      current.bytes += addedBytes();
    }
  }
  flush();

  // Preserve observations that are not referenced by a public object in the
  // final shard so a round trip retains the complete source envelope.
  const unreferenced = observations.filter((observation) => (
    !assignedObservationRefs.has(observation?.source_observation_ref)
  ));
  if (unreferenced.length) {
    const last = chunks.at(-1);
    const addedBytes = unreferenced.reduce((sum, observation) => sum + nestedJsonByteLength(observation), 0) + 16;
    if (last.rows.length && last.bytes + addedBytes > maxShardBytes) {
      chunks.push({
        rows: [],
        observations: unreferenced,
        bytes: emptyShardBytes + addedBytes,
      });
    } else {
      last.observations.push(...unreferenced);
      last.bytes += addedBytes;
    }
  }

  const shardPayloads = chunks.map((chunk, index) => shardPayload(
    String(index).padStart(3, "0"),
    chunk.rows,
    chunk.observations,
  ));
  const descriptors = shardPayloads.map((shard, index) => ({
    path: pathForShard(index),
    bytes: byteLength(shard),
    row_count: shard.rows.length,
    observation_count: shard.observations.length,
  }));
  const procurementShardById = Object.fromEntries(shardPayloads.flatMap((shard, index) => (
    shard.rows.map((row) => [row.procurement_id, descriptors[index].path])
  )));
  const { rows: _rows, observations: _observations, ...manifestBody } = model || {};
  const manifest = {
    ...manifestBody,
    representation: "sharded",
    shard_schema: SHARED_PROCUREMENT_READ_MODEL_SHARD_SCHEMA,
    shards: descriptors,
    procurement_shard_by_id: procurementShardById,
    observation_order: observations
      .map((observation) => observation?.source_observation_ref)
      .filter(Boolean),
  };
  return { manifest, shards: shardPayloads };
}

/** Reassemble the original shared read-model shape from a manifest and shards. */
export function combineSharedProcurementReadModel(manifest, shards = []) {
  if (Array.isArray(manifest?.rows)) return manifest;
  const payloads = Array.isArray(shards) ? shards : [];
  const rows = payloads.flatMap((shard) => Array.isArray(shard?.rows) ? shard.rows : []);
  const observationsByRef = new Map(payloads
    .flatMap((shard) => Array.isArray(shard?.observations) ? shard.observations : [])
    .map((observation) => [observation?.source_observation_ref, observation])
    .filter(([ref]) => ref));
  const observations = Array.isArray(manifest?.observation_order)
    ? manifest.observation_order.map((ref) => observationsByRef.get(ref)).filter(Boolean)
    : payloads.flatMap((shard) => Array.isArray(shard?.observations) ? shard.observations : []);
  const {
    schema,
    version,
    generated_at,
    freshness,
    sources,
    identity_gate,
    identity_edges,
    cross_source_identity_joins,
    counts,
    publication,
    coherence_receipt,
  } = manifest || {};
  // Keep the original model's observations-before-counts-before-rows key order
  // so deterministic fingerprints remain stable across the representation-only
  // shard migration.
  return {
    schema,
    version,
    generated_at,
    freshness,
    sources,
    identity_gate,
    identity_edges,
    cross_source_identity_joins,
    observations,
    counts,
    rows,
    publication,
    coherence_receipt,
  };
}

export function procurementShardPathForId(manifest, procurementId) {
  return manifest?.procurement_shard_by_id?.[procurementId] || null;
}
