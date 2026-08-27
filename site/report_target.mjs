/**
 * Internal context contract for reporting a CityScroll assertion.
 *
 * The target has two deliberately separate layers:
 *
 *   1. an addressable civic object, identified by an existing object id and
 *      canonical route; and
 *   2. an optional semantic claim anchor, identified by stable ids and a
 *      relation/field key rather than presentation details.
 *
 * This is a transport-neutral seam. It does not create graph nodes or edges;
 * callers pass the object and edge payloads already produced by the domain
 * read models.
 */

import { objectCardInteractionProjection } from "./affordance_grammar.mjs";

export const REPORT_TARGET_SCHEMA = "cityscroll.report_target.v1";

export const REPORT_CLAIM_TYPES = Object.freeze([
  "field",
  "relationship",
  "identity",
  "grouping",
  "lifecycle",
  "interpretation",
]);

const CLAIM_TYPE_ALIASES = Object.freeze({
  field_claim: "field",
  semantic_field: "field",
  relation: "relationship",
  group: "grouping",
  derived_interpretation: "interpretation",
});

const CLAIM_KEY_TYPES = Object.freeze({
  vendor: "field",
  identity: "identity",
  parcel: "relationship",
  "collapsed_notices": "grouping",
  lifecycle: "lifecycle",
  "regulatory-effect": "interpretation",
  regulatory_effect: "interpretation",
});

function reportTargetClean(value, max = 1_000) {
  if (value == null) return null;
  const result = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return result || null;
}

function required(value, name) {
  const result = reportTargetClean(value);
  if (!result) throw new TypeError(`${name} is required`);
  return result;
}

function addProvenanceValue(out, field, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) addProvenanceValue(out, field, item);
    return;
  }
  const cleaned = reportTargetClean(value, 2_000);
  if (cleaned) out[field].add(cleaned);
}

/**
 * Extract only explicitly labelled source values from existing source/edge
 * payloads. In particular, this never guesses a source system from an id.
 */
export function provenanceFromExisting(...payloads) {
  const out = {
    source_record_ids: new Set(),
    source_urls: new Set(),
    systems: new Set(),
  };
  const seen = new Set();

  function visit(value) {
    if (value == null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value === "string") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    for (const field of [
      "source_record_ids", "source_observation_refs", "source_record_id",
      "source_observation_ref", "source_record_identifier", "identifier",
    ]) addProvenanceValue(out, "source_record_ids", value[field]);
    for (const field of ["source_urls", "source_url", "record_url", "official_url", "url"]) {
      addProvenanceValue(out, "source_urls", value[field]);
    }
    for (const field of ["systems", "source_systems", "source_system", "system"]) {
      addProvenanceValue(out, "systems", value[field]);
    }

    // These are the existing nested shapes used by source records and graph
    // edges. Traversing them retains provenance without copying the edge into
    // the report contract or introducing another relationship model.
    for (const field of [
      "source_record", "source_records", "source", "sources", "provenance",
      "where", "how", "evidence", "observations",
    ]) {
      visit(value[field]);
    }
  }

  for (const payload of payloads) visit(payload);
  const result = {
    source_record_ids: [...out.source_record_ids].sort((left, right) => left.localeCompare(right)),
    source_urls: [...out.source_urls].sort((left, right) => left.localeCompare(right)),
    systems: [...out.systems].sort((left, right) => left.localeCompare(right)),
  };
  return result.source_record_ids.length || result.source_urls.length || result.systems.length
    ? Object.freeze(result)
    : null;
}

function claimTypeForKey(key) {
  return CLAIM_KEY_TYPES[key] || "field";
}

function canonicalClaimType(value, key) {
  const normalized = reportTargetClean(value)?.toLowerCase();
  const claimType = CLAIM_TYPE_ALIASES[normalized] || normalized || claimTypeForKey(key);
  if (!REPORT_CLAIM_TYPES.includes(claimType)) {
    throw new TypeError(`unsupported report claim type: ${claimType}`);
  }
  return claimType;
}

function parseAnchor(value) {
  const anchor = required(value, "claim anchor");
  const separator = anchor.indexOf("#");
  if (separator <= 0 || separator === anchor.length - 1 || anchor.indexOf("#", separator + 1) >= 0) {
    throw new TypeError("claim anchor must be <object-ref>#<semantic-key>");
  }
  const objectRef = anchor.slice(0, separator);
  const key = anchor.slice(separator + 1);
  return { anchor, object_ref: objectRef, key };
}

function objectRefParts(objectRef) {
  const separator = objectRef.indexOf(":");
  return separator < 1
    ? { namespace: null, value: objectRef }
    : { namespace: objectRef.slice(0, separator), value: objectRef.slice(separator + 1) };
}

/** Parse one of the stable semantic anchors registered by the workstream. */
export function parseReportClaimAnchor(value) {
  const parsed = parseAnchor(value);
  const parts = objectRefParts(parsed.object_ref);
  const parcelAnchor = parsed.key.match(/^parcel(?::(\d{10}))?$/);
  const claim_type = canonicalClaimType(null, parcelAnchor ? "parcel" : parsed.key);
  const claim = {
    anchor: parsed.anchor,
    object_ref: parsed.object_ref,
    claim_type,
    field_or_semantic_key: parcelAnchor ? "parcel" : parsed.key,
  };

  if (parts.namespace === "landuse" && parcelAnchor) {
    claim.relation_type = "sits_on_parcel";
    claim.subject_id = `project:${parts.value}`;
    claim.object_id = parcelAnchor[1] ? `bbl:${parcelAnchor[1]}` : null;
  } else if (parts.namespace === "contract") {
    claim.subject_id = `contract:${parts.value}`;
  } else if (parts.namespace === "entity") {
    claim.subject_id = parsed.object_ref;
  } else if (parts.namespace === "meeting") {
    claim.subject_id = parsed.object_ref;
  } else if (parts.namespace === "rulemaking") {
    claim.subject_id = parsed.object_ref;
  }
  return claim;
}

function normalizeClaimAnchor(value, defaults = {}) {
  if (!value) return null;
  const parsed = typeof value === "string"
    ? parseReportClaimAnchor(value)
    : (value.anchor ? parseReportClaimAnchor(value.anchor) : {});
  const key = reportTargetClean(value?.field_or_semantic_key || parsed.field_or_semantic_key);
  const claimType = canonicalClaimType(value?.claim_type || parsed.claim_type, key);
  const claim = {
    ...(parsed.anchor ? { anchor: parsed.anchor } : {}),
    ...(parsed.object_ref ? { object_ref: parsed.object_ref } : {}),
    claim_type: claimType,
  };
  for (const field of [
    "relation_type", "subject_id", "object_id", "field_or_semantic_key",
    "rendered_value", "subject_label", "object_label",
  ]) {
    const selected = value?.[field] ?? parsed[field] ?? defaults[field];
    const normalized = reportTargetClean(selected, field === "rendered_value" ? 2_000 : 500);
    if (normalized) claim[field] = normalized;
  }
  if (claimType === "relationship" && !claim.relation_type && key === "parcel") {
    claim.relation_type = "sits_on_parcel";
  }
  if (!claim.field_or_semantic_key && key) claim.field_or_semantic_key = key;
  return Object.freeze(claim);
}

function stableClaimIdentity(claim) {
  if (!claim) return null;
  return [
    claim.claim_type,
    claim.relation_type,
    claim.subject_id,
    claim.object_id,
    claim.field_or_semantic_key,
  ].map((value) => encodeURIComponent(value || "")).join(":");
}

/** Stable identity excludes display labels, rendered values, URLs, and order. */
export function reportTargetIdentity(target) {
  const objectType = required(target?.object_type, "object_type");
  const objectId = required(target?.object_id, "object_id");
  const claim = normalizeClaimAnchor(target?.claim_anchor);
  return `${REPORT_TARGET_SCHEMA}|${encodeURIComponent(objectType)}|${encodeURIComponent(objectId)}|${stableClaimIdentity(claim) || "object"}`;
}

function claimLabel(claim) {
  return claim?.field_or_semantic_key?.replaceAll("-", " ") || claim?.claim_type || "claim";
}

/** Resolve the machine target to the short text used by a future report form. */
export function describeReportTarget(target) {
  const label = reportTargetClean(target?.object_label || target?.label) || `${target?.object_type || "Civic"} ${target?.object_id || "object"}`;
  const claim = target?.claim_anchor;
  if (!claim) return label;
  const rendered = reportTargetClean(claim.rendered_value, 2_000);
  if (claim.claim_type === "relationship") {
    if (rendered) return rendered;
    const subject = reportTargetClean(claim.subject_label) || reportTargetClean(claim.subject_id) || label;
    const object = reportTargetClean(claim.object_label) || reportTargetClean(claim.object_id) || "another civic record";
    return `${subject} is connected to ${object}`;
  }
  if (claim.claim_type === "grouping") return `${label}: grouped notices`;
  if (claim.claim_type === "lifecycle") return `${label}: lifecycle`;
  if (claim.claim_type === "identity") return `${label}: identity`;
  return `${label}: ${rendered || claimLabel(claim)}`;
}

/**
 * Build a target from an already-resolved civic object and optional edge
 * payload. `canonical_url` is the same route supplied to the object-card
 * projection; it is not used to derive identity.
 */
export function buildReportTarget({
  object_type,
  object_id,
  canonical_url,
  object_label = null,
  label = null,
  claim_anchor = null,
  provenance = null,
  edge = null,
  source = null,
} = {}) {
  const target = {
    schema: REPORT_TARGET_SCHEMA,
    object_type: required(object_type, "object_type"),
    object_id: required(object_id, "object_id"),
    canonical_url: required(canonical_url, "canonical_url"),
    ...(reportTargetClean(object_label || label) ? { object_label: reportTargetClean(object_label || label) } : {}),
    provenance: provenanceFromExisting(provenance, edge, source),
  };
  const normalizedClaim = normalizeClaimAnchor(claim_anchor);
  if (normalizedClaim) target.claim_anchor = normalizedClaim;
  target.target_id = reportTargetIdentity(target);
  target.description = describeReportTarget(target);
  return Object.freeze(target);
}

/**
 * Build a report target for one accepted graph edge. Endpoint labels are
 * display context only; the target identity remains the typed endpoint ids
 * and semantic relation, so presentation order cannot change the target.
 */
export function buildRelationshipReportTarget({
  object_type,
  object_id,
  canonical_url,
  object_label = null,
  anchor,
  relation_type,
  subject_id,
  subject_label,
  related_object_id,
  related_object_label,
  field_or_semantic_key,
  provenance = null,
  edge = null,
  source = null,
} = {}) {
  const subject = required(subject_id, "relationship subject_id");
  const related = required(related_object_id, "relationship object_id");
  const relation = required(relation_type, "relationship relation_type");
  const key = required(field_or_semantic_key, "relationship semantic key");
  const stableAnchor = required(anchor, "relationship anchor");
  const subjectDisplay = reportTargetClean(subject_label) || subject;
  const relatedDisplay = reportTargetClean(related_object_label) || related;
  return buildReportTarget({
    object_type,
    object_id,
    canonical_url,
    object_label,
    claim_anchor: {
      anchor: stableAnchor,
      claim_type: "relationship",
      relation_type: relation,
      subject_id: subject,
      object_id: related,
      field_or_semantic_key: key,
      subject_label: subjectDisplay,
      object_label: relatedDisplay,
      rendered_value: `${subjectDisplay} is connected to ${relatedDisplay}`,
    },
    provenance,
    edge,
    source,
  });
}

function objectDescriptorFromContext(parsed, context) {
  const object = context.object && typeof context.object === "object" ? context.object : {};
  const parts = objectRefParts(parsed.object_ref);
  let object_type = context.object_type || object.object_type;
  let object_id = context.object_id
    || object.canonical_id
    || object.procurement_id
    || object.meeting_id
    || object.entity_ref
    || object.subject_ref;
  let canonical_url = context.canonical_url || context.canonical_href
    || object.canonical_url || object.canonical_href
    || object.compatibility?.canonical_href || object.href;
  let object_label = context.object_label || context.label || object.object_label || object.label
    || object.title || object.project_name;

  if (parts.namespace === "contract") {
    object_type ||= "procurement";
    object_id ||= `procurement:contract:${parts.value}`;
    canonical_url ||= `/procurements/${encodeURIComponent(object_id)}`;
    object_label ||= `Contract ${parts.value}`;
  } else if (parts.namespace === "landuse") {
    object_type ||= "land_use_project";
    object_id ||= `project:${parts.value}`;
    canonical_url ||= `/browse/zoning/#land/${encodeURIComponent(parts.value)}`;
    object_label ||= `Land-use project ${parts.value}`;
  } else if (parts.namespace === "meeting") {
    object_type ||= "meeting";
    object_id ||= parsed.object_ref;
    canonical_url ||= `/meetings/${encodeURIComponent(object_id)}`;
    object_label ||= `Meeting ${parts.value}`;
  } else if (parts.namespace === "rulemaking") {
    object_type ||= "rulemaking";
    object_id ||= parsed.object_ref;
    canonical_url ||= context.rule_url || context.official_url;
    object_label ||= `Rulemaking ${parts.value}`;
  } else if (parts.namespace === "entity") {
    object_type ||= "entity";
    object_id ||= parsed.object_ref;
    object_label ||= `Entity ${parts.value}`;
  }

  return { object_type, object_id, canonical_url, object_label };
}

/** Resolve a registered stable anchor against an existing object/edge payload. */
export function buildReportTargetFromAnchor(anchor, context = {}) {
  const parsed = parseReportClaimAnchor(anchor);
  const descriptor = objectDescriptorFromContext(parsed, context);
  const parcelId = reportTargetClean(context.bbl || context.parcel_id || context.edge?.to)?.replace(/^bbl:/, "") || null;
  const claimDefaults = {
    subject_id: descriptor.object_id,
    ...(parsed.field_or_semantic_key === "parcel" && parcelId ? { object_id: `bbl:${parcelId}` } : {}),
  };
  const claimInput = {
    ...parsed,
    ...context.claim_anchor,
  };
  if (!context.claim_anchor?.subject_id) claimInput.subject_id = claimDefaults.subject_id;
  if (parsed.field_or_semantic_key === "parcel" && parcelId && !context.claim_anchor?.object_id) {
    claimInput.object_id = `bbl:${parcelId}`;
  }
  const claim_anchor = normalizeClaimAnchor({
    ...claimInput,
  }, claimDefaults);
  return buildReportTarget({
    ...descriptor,
    claim_anchor,
    provenance: context.provenance,
    edge: context.edge,
    source: context.source || context.object,
  });
}

/**
 * Bridge to the existing object-card copy contract without rendering a card.
 * The returned `copy_target` is exactly what Copy link would write.
 */
export function reportTargetCardProjection(target) {
  return objectCardInteractionProjection({
    target: target ? {
      href: target.canonical_url,
      label: target.description,
    } : null,
  });
}

/** Deterministic JSON attachment for machine-delivered report context. */
export function serializeReportTarget(target) {
  const normalized = buildReportTarget(target);
  return JSON.stringify(normalized, null, 0);
}

/** Re-normalize a received target and resolve its human-readable description. */
export function resolveReportTarget(target) {
  if (!target || typeof target !== "object") return null;
  return buildReportTarget({
    object_type: target.object_type,
    object_id: target.object_id,
    canonical_url: target.canonical_url,
    object_label: target.object_label,
    claim_anchor: target.claim_anchor,
    provenance: target.provenance,
  });
}
