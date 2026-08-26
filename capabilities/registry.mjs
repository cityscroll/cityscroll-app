// Frozen build-time topology registry. Runtime adapters import their operation
// contracts and explicit providers directly; this file never resolves or invokes one.

import { NOTICE_SEARCH_CAPABILITY } from "./notice_search.mjs";
import { NOTICE_GET_CAPABILITY } from "./notice_get.mjs";
import { ENTITY_DOSSIER_CAPABILITY } from "./entity_dossier.mjs";
import { ENTITY_RELATIONSHIPS_CAPABILITY } from "./entity_relationships.mjs";
import { CITED_PASSAGES_CAPABILITY } from "./cited_passages.mjs";
import { FEDERATED_SEARCH_CAPABILITY } from "./federated_search.mjs";
import { CONTRACT_GET_CAPABILITY, CONTRACTS_BROWSE_CAPABILITY } from "./contracts.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateCapabilityRegistry(registry) {
  if (!Array.isArray(registry) || !registry.length) throw new TypeError("capability registry must not be empty");
  const ids = new Set();
  const references = new Set();
  const providers = new Set();
  const adapters = new Set();
  for (const capability of registry) {
    if (!capability?.id || ids.has(capability.id)) throw new TypeError(`duplicate or missing capability id: ${capability?.id}`);
    if (!SEMVER.test(capability.version || "")) throw new TypeError(`invalid capability version: ${capability?.version}`);
    const major = capability.version.split(".")[0];
    if (capability.reference !== `${capability.id}@${major}` || references.has(capability.reference)) {
      throw new TypeError(`invalid or duplicate capability reference: ${capability.reference}`);
    }
    if (typeof capability.owner !== "string" || !capability.owner.trim()) {
      throw new TypeError(`capability owner is required: ${capability.reference}`);
    }
    if (!capability.provider?.id || providers.has(capability.provider.id)) {
      throw new TypeError(`duplicate or missing provider: ${capability.provider?.id}`);
    }
    if (!Array.isArray(capability.adapters) || !capability.adapters.length) {
      throw new TypeError(`capability requires a real adapter: ${capability.reference}`);
    }
    let adapterRepresentations = 0;
    for (const adapter of capability.adapters) {
      if (!adapter?.id || adapters.has(adapter.id)) throw new TypeError(`duplicate or missing adapter: ${adapter?.id}`);
      const representations = Array.isArray(adapter.representations)
        ? adapter.representations.length
        : 1;
      adapterRepresentations += Math.max(1, representations);
      adapters.add(adapter.id);
    }
    if (adapterRepresentations < 2) {
      throw new TypeError(`capability requires two real adapter surfaces: ${capability.reference}`);
    }
    ids.add(capability.id);
    references.add(capability.reference);
    providers.add(capability.provider.id);
  }
  return registry;
}

export const CAPABILITY_REGISTRY = deepFreeze([
  NOTICE_SEARCH_CAPABILITY,
  NOTICE_GET_CAPABILITY,
  ENTITY_DOSSIER_CAPABILITY,
  ENTITY_RELATIONSHIPS_CAPABILITY,
  CITED_PASSAGES_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY,
  CONTRACT_GET_CAPABILITY,
  CONTRACTS_BROWSE_CAPABILITY,
]);

validateCapabilityRegistry(CAPABILITY_REGISTRY);
