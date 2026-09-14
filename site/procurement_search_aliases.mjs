/** Reviewed, editorial search aliases for already-admitted procurements. */

import registry from "./data/procurement_search_aliases.json" with { type: "json" };

export const PROCUREMENT_SEARCH_ALIAS_REGISTRY_SCHEMA = "cityscroll.procurement_search_alias_registry.v1";

export const DEFAULT_PROCUREMENT_SEARCH_ALIAS_REGISTRY = Object.freeze(registry);

function clean(value, max = 500) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeProcurementSearchAlias(value) {
  return clean(value, 240).toLocaleLowerCase("en-US");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedEntry(entry, index) {
  if (!plainObject(entry)) throw new TypeError(`procurement search alias ${index} must be an object`);
  const alias = clean(entry.alias, 240);
  const objectRef = clean(entry.canonical_object_ref, 320);
  const provenance = entry.provenance;
  if (!alias || !objectRef) throw new TypeError(`procurement search alias ${index} needs alias and canonical_object_ref`);
  if (!plainObject(provenance) || !clean(provenance.source, 240) || !clean(provenance.basis, 600)) {
    throw new TypeError(`procurement search alias ${index} needs provenance source and basis`);
  }
  const normalizedAlias = normalizeProcurementSearchAlias(alias);
  if (!normalizedAlias) throw new TypeError(`procurement search alias ${index} has no searchable text`);
  return Object.freeze({
    alias,
    normalized_alias: normalizedAlias,
    canonical_object_ref: objectRef,
    provenance: Object.freeze({
      source: clean(provenance.source, 240),
      basis: clean(provenance.basis, 600),
    }),
  });
}

/** Validate registry shape and exact anchors against the admitted read model. */
export function validateProcurementSearchAliasRegistry(registry, admittedObjectRefs) {
  if (!plainObject(registry) || registry.schema !== PROCUREMENT_SEARCH_ALIAS_REGISTRY_SCHEMA) {
    throw new TypeError("invalid procurement search alias registry schema");
  }
  if (!Array.isArray(registry.aliases)) throw new TypeError("procurement search alias registry aliases must be an array");
  const refs = admittedObjectRefs instanceof Set ? admittedObjectRefs : new Set(admittedObjectRefs || []);
  const seenAliases = new Set();
  const aliases = registry.aliases.map(normalizedEntry);
  for (const entry of aliases) {
    if (seenAliases.has(entry.normalized_alias)) throw new TypeError(`duplicate procurement search alias: ${entry.alias}`);
    seenAliases.add(entry.normalized_alias);
    if (refs.size && !refs.has(entry.canonical_object_ref)) {
      throw new TypeError(`procurement search alias target is not an admitted canonical object: ${entry.canonical_object_ref}`);
    }
  }
  return Object.freeze(aliases);
}

export function aliasesForProcurement(registry, objectRef, admittedObjectRefs) {
  return validateProcurementSearchAliasRegistry(registry, admittedObjectRefs)
    .filter((entry) => entry.canonical_object_ref === objectRef);
}
