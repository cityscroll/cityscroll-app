// Pure loader for ontology/registry.v0.json — catalog only, no I/O side effects
// beyond reading the committed registry file when loadOntologyRegistry() is called.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ONTOLOGY_REGISTRY_SCHEMA = "cityscroll.ontology.registry.v0";
export const ONTOLOGY_REGISTRY_RELATIVE = "ontology/registry.v0.json";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = join(ROOT, ONTOLOGY_REGISTRY_RELATIVE);

export function loadOntologyRegistry(path = DEFAULT_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  validateRegistryShape(raw);
  return raw;
}

export function validateRegistryShape(registry) {
  if (!registry || typeof registry !== "object") {
    throw new TypeError("ontology registry must be an object");
  }
  if (registry.schema !== ONTOLOGY_REGISTRY_SCHEMA) {
    throw new TypeError(`expected schema ${ONTOLOGY_REGISTRY_SCHEMA}`);
  }
  if (!registry.version) throw new TypeError("ontology registry requires version");
  for (const key of [
    "object_types",
    "link_types",
    "event_kinds",
    "assertion_classifications",
    "assertion_facts",
    "kinetic_action_types",
    "er_type_families",
    "er_decisions",
  ]) {
    if (!(key in registry)) throw new TypeError(`ontology registry missing ${key}`);
  }
  const kinetic = registry.kinetic_action_types;
  for (const key of ["reader_actions", "action_deliveries", "product_method_log", "outcomes"]) {
    if (!Array.isArray(kinetic[key])) {
      throw new TypeError(`kinetic_action_types.${key} must be an array`);
    }
  }
  return true;
}

export function indexById(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (!entry?.id) throw new TypeError("registry entry missing id");
    if (map.has(entry.id)) throw new TypeError(`duplicate registry id: ${entry.id}`);
    map.set(entry.id, entry);
  }
  return map;
}

export function idsWithStatus(entries, status = null) {
  return (entries || [])
    .filter((entry) => !status || entry.status === status)
    .map((entry) => entry.id)
    .sort();
}

export function requireCataloged(liveIds, catalogEntries, label) {
  const catalog = indexById(catalogEntries);
  const missing = [];
  const unlistedStatus = [];
  for (const id of liveIds) {
    const entry = catalog.get(id);
    if (!entry) missing.push(id);
    else if (entry.status !== "registered" && entry.status !== "unregistered") {
      unlistedStatus.push(`${id}:${entry.status}`);
    }
  }
  return {
    label,
    live_count: liveIds.length,
    catalog_count: catalog.size,
    missing,
    invalid_status: unlistedStatus,
    ok: missing.length === 0 && unlistedStatus.length === 0,
  };
}
