// Allowlist serializers for public entity-resolution responses.
//
// Database rows and desk review objects must never be serialized directly. These
// helpers construct new objects from the small public contract so new internal
// columns remain private by default.

import { publicEntityLinkConfidence } from "./link_confidence.mjs";

export const PUBLICATION_VERSION = "public_er_v1";
export const PUBLIC_ENTITY_FIELDS = Object.freeze(["id", "type", "name"]);
export const PUBLIC_ENTITY_LINK_FIELDS = Object.freeze([
  "entity_id",
  "source",
  "link_confidence",
]);

export const DESK_ONLY_ENTITY_RESOLUTION_FIELDS = Object.freeze([
  "source_record_id",
  "raw_snapshot",
  "normalized_snapshot",
  "content_hash",
  "attrs_json",
  // Raw numeric matcher score — public surfaces use link_confidence bands only.
  "confidence",
  "method",
  "matcher_version",
  "evidence_json",
  "resolution_run_id",
  "review_status",
  "reviewer",
  "notes",
  "actor",
  "curation_receipt_id",
  "curation_verdict",
  "review_policy",
  "reversible_effect",
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
 * Map a hydrated entity_link to public provenance + banded link confidence.
 *
 * `source_system_id` is the publisher-native public identifier. It is not the
 * internal `source_record_id`, which includes an immutable snapshot hash.
 * Numeric matcher scores and method strings stay desk-only.
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
  const score = link.link_confidence_score ?? link.confidence;
  return {
    entity_id: entityId,
    source,
    link_confidence: publicEntityLinkConfidence(score),
  };
}

export {
  PUBLIC_LINK_CONFIDENCE_READER_LABELS,
  PUBLIC_LINK_CONFIDENCE_STATUSES,
  PUBLIC_LINK_CONFIDENCE_STRONG_MIN,
  PUBLIC_LINK_CONFIDENCE_VERSION,
  measurePublicEntityLinkConfidenceRate,
  publicEntityLinkConfidence,
  readerLabelForLinkConfidence,
  summarizeLinkConfidence,
} from "./link_confidence.mjs";

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
