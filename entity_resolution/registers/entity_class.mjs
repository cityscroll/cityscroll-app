// entity_type -> entity_class, from the closed mapping file built over the real distinct values.
// JSON import (not node:fs) so the same module loads in Node tests and the Worker route.
import mapDoc from "./entity_type_class_map.json" with { type: "json" };

export function loadEntityClassMap(doc = mapDoc) {
  const byType = new Map();
  for (const e of doc.entries) byType.set(e.entity_type, e.entity_class);
  return { doc, byType };
}

const DEFAULT = loadEntityClassMap();

/** -> { entity_class, mapped }. Unknown or empty types are `other` with mapped:false. */
export function entityClassOf(entityType, map = DEFAULT) {
  const key = entityType == null ? "" : String(entityType).trim().toUpperCase();
  if (map.byType.has(key)) return { entity_class: map.byType.get(key), mapped: true };
  return { entity_class: "other", mapped: false };
}
