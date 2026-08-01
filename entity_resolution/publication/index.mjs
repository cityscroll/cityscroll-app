// Allowlist serializers for public entity-resolution responses.
//
// Database rows and desk review objects must never be serialized directly. These
// helpers construct new objects from the small public contract so new internal
// columns remain private by default.

export const PUBLICATION_VERSION = "public_er_v1";
export const PUBLIC_ENTITY_FIELDS = Object.freeze(["id", "type", "name"]);
export const PUBLIC_ENTITY_LINK_FIELDS = Object.freeze(["entity_id", "source"]);

export const DESK_ONLY_ENTITY_RESOLUTION_FIELDS = Object.freeze([
  "source_record_id",
  "raw_snapshot",
  "normalized_snapshot",
  "content_hash",
  "attrs_json",
  "confidence",
  "method",
  "matcher_version",
  "evidence_json",
  "resolution_run_id",
  "review_status",
  "reviewer",
  "notes",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function publicSourceUrl(value) {
  const candidate = clean(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

/** Map a canonical_entity row to the complete public entity contract. */
export function serializePublicEntity(entity = {}) {
  if (!entity || typeof entity !== "object") return null;
  const id = clean(entity.id);
  const type = clean(entity.entity_type ?? entity.type);
  const name = clean(entity.display_name ?? entity.name);
  if (!id || !type || !name) return null;
  return { id, type, name };
}

/**
 * Map a hydrated entity_link to public provenance.
 *
 * `source_system_id` is the publisher-native public identifier. It is not the
 * internal `source_record_id`, which includes an immutable snapshot hash.
 */
export function serializePublicEntityLink(link = {}) {
  if (!link || typeof link !== "object") return null;
  const nestedSource = link.source && typeof link.source === "object" ? link.source : {};
  const entityId = clean(link.canonical_entity_id ?? link.entity_id);
  const system = clean(link.source_system ?? nestedSource.system);
  const id = clean(link.source_system_id ?? nestedSource.id);
  if (!entityId || !system || !id) return null;

  const source = { system, id };
  const url = publicSourceUrl(link.source_url ?? nestedSource.url);
  if (url) source.url = url;
  return { entity_id: entityId, source };
}

export {
  PUBLIC_DOSSIER_FACT_DEFINITIONS,
  PUBLIC_DOSSIER_VERSION,
  serializePublicEntityDossier,
} from "./dossier.mjs";

export {
  PUBLIC_GRAPH_DEFAULT_DEPTH,
  PUBLIC_GRAPH_DEFAULT_FAN_OUT,
  PUBLIC_GRAPH_EDGE_LABELS,
  PUBLIC_GRAPH_EDGE_TYPES,
  PUBLIC_GRAPH_MAX_DEPTH,
  PUBLIC_GRAPH_MAX_FAN_OUT,
  PUBLIC_GRAPH_NODE_TYPES,
  PUBLIC_RELATIONSHIP_GRAPH_VERSION,
  serializePublicRelationshipGraph,
} from "./relationship_graph.mjs";
