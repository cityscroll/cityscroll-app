/**
 * The bounded bridge between a registered-contract aggregate and the
 * procurement detail records an individual contract can be fetched from.
 *
 * The analytical projection identifies a registered contract by its publisher
 * registration identifier; the procurement detail read model identifies the
 * same contract by a canonical procurement id. Nothing used to connect the
 * two, so an aggregate could hand out identifiers that the detail capability
 * could not accept. This module owns that resolution, and it resolves rather
 * than guesses: an identifier is retrievable only when the detail read model
 * itself publishes a record under that contract's own exact identity.
 */

import { PROCUREMENT_DETAIL_RESOLUTIONS } from "../capabilities/contracts_analysis.mjs";
import { procurementContractIdentityKey } from "./procurement_identity_key.mjs";

export const PROCUREMENT_DETAIL_INDEX_SCHEMA = "cityscroll.procurement_detail_index.v1";

const CONTRACT_IDENTITY_PREFIX = "procurement:contract:";

function canonicalContractId(identityKey) {
  return `${CONTRACT_IDENTITY_PREFIX}${identityKey}`;
}

/**
 * Build the resolution view over a shared procurement read model, whether the
 * caller holds the whole model or only its published index. A model that
 * carries rows resolves through the identity keys those rows publish; an index
 * resolves through the canonical ids it publishes. Neither form invents an id.
 */
export function procurementDetailIndex(model) {
  if (!model || typeof model !== "object") return null;
  const generatedAt = model.generated_at || model.freshness?.generated_at || null;
  const rows = Array.isArray(model.rows) ? model.rows : null;
  if (rows?.length) {
    const byIdentityKey = new Map();
    for (const row of rows) {
      const procurementId = row?.procurement_id;
      if (typeof procurementId !== "string" || !procurementId) continue;
      for (const contractId of row?.identity_keys?.contract_ids || []) {
        const key = procurementContractIdentityKey(contractId);
        if (key && !byIdentityKey.has(key)) byIdentityKey.set(key, procurementId);
      }
    }
    return Object.freeze({
      schema: PROCUREMENT_DETAIL_INDEX_SCHEMA,
      resolution: PROCUREMENT_DETAIL_RESOLUTIONS[0],
      generated_at: generatedAt,
      procurement_id_count: byIdentityKey.size,
      procurementIdFor(primeContractId) {
        const key = procurementContractIdentityKey(primeContractId);
        return key ? byIdentityKey.get(key) || null : null;
      },
    });
  }
  const published = model.procurement_shard_by_id;
  if (!published || typeof published !== "object") return null;
  const publishedIds = new Set(Object.keys(published));
  return Object.freeze({
    schema: PROCUREMENT_DETAIL_INDEX_SCHEMA,
    resolution: PROCUREMENT_DETAIL_RESOLUTIONS[1],
    generated_at: generatedAt,
    procurement_id_count: publishedIds.size,
    procurementIdFor(primeContractId) {
      const key = procurementContractIdentityKey(primeContractId);
      if (!key) return null;
      const candidate = canonicalContractId(key);
      return publishedIds.has(candidate) ? candidate : null;
    },
  });
}

/** Resolve one bounded list of registration identifiers, in the same order. */
export function resolveProcurementDetailIds(index, primeContractIds = []) {
  if (!index || typeof index.procurementIdFor !== "function") return null;
  return primeContractIds.map((primeContractId) => index.procurementIdFor(primeContractId));
}
