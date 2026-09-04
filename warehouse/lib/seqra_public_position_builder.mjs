/**
 * SEQRA-07: build `organization` and `public_position` entities that
 * conform to the SEQRA-02 ontology spec (warehouse/lib/seqra_ontology_spec.mjs)
 * from a resolved actor (warehouse/lib/seqra_actor_resolution.mjs) plus one
 * source record.
 *
 * This module enforces the card's two hard boundaries at construction time,
 * not as an afterthought:
 *
 *   - A4 / negative rule: a position with no `availableToPublicAt`, or one
 *     whose declared availability is earlier than its own `observedAt`
 *     (an impossible cutoff), is refused rather than silently accepted as
 *     cutoff-valid. There is no "undated" public_position this module will
 *     construct.
 *   - A3 / negative rule: `suppressionRule` and `rivalExplanation` are
 *     required, non-optional constructor inputs, not properties a caller can
 *     leave null. A position built from a lobbying or labor-organization
 *     actor without an explicit suppression rule is a programming error
 *     here, not a silent gap the schema happens to allow (the ontology spec
 *     itself only requires the field be present and typed string-or-null;
 *     this module additionally refuses null for exactly those actor types).
 */

import {
  SEQRA_ONTOLOGY_ENTITY_SPECS,
  validateSeqraEntity,
} from "./seqra_ontology_spec.mjs";
import { buildPublicPositionKey } from "./seqra_stable_keys.mjs";

export const SEQRA_PUBLIC_POSITION_BUILDER_SCHEMA = "cityscroll.seqra_public_position_builder.v1";

// Actor types whose participation the commission's negative rule names
// explicitly: recording their activity as evidence must never omit the
// suppression rule that keeps it from being read as a misconduct signal.
export const SUPPRESSION_REQUIRED_ORGANIZATION_TYPES = Object.freeze([
  "labor_organization",
  "developer",
  "advocacy_group",
  "community_board",
]);

export const DEFAULT_SUPPRESSION_RULE =
  "Participation is recorded as dated process evidence only. Lobbying, labor-organization, " +
  "developer, or community participation captured here must never be read, displayed, or " +
  "modeled as a misconduct or motive signal about the participating organization.";

class SeqraPublicPositionBuilderError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraPublicPositionBuilderError";
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraPublicPositionBuilderError(`${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireIsoDateTime(value, fieldName) {
  const s = requireNonEmptyString(value, fieldName);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new SeqraPublicPositionBuilderError(`${fieldName} must be a parseable ISO date-time, got ${JSON.stringify(value)}`);
  }
  return s;
}

function throwIfInvalid(entityType, obj) {
  const findings = validateSeqraEntity(entityType, obj);
  if (findings.length) {
    throw new SeqraPublicPositionBuilderError(`built ${entityType} failed ontology validation: ${findings.join("; ")}`);
  }
  return obj;
}

/** Build one `organization` entity from a resolveOrganization(...) result. */
export function buildOrganization({
  resolvedActor,
  sourceId,
  sourceRecordId,
  observedAt,
} = {}) {
  if (!resolvedActor || typeof resolvedActor !== "object") {
    throw new SeqraPublicPositionBuilderError("resolvedActor is required (see seqra_actor_resolution.mjs#resolveOrganization)");
  }
  const entity = {
    organization_key: requireNonEmptyString(resolvedActor.organization_key, "resolvedActor.organization_key"),
    name: requireNonEmptyString(resolvedActor.name, "resolvedActor.name"),
    organization_type: requireNonEmptyString(resolvedActor.organization_type, "resolvedActor.organization_type"),
    observed_at: requireIsoDateTime(observedAt, "observedAt"),
    source_id: requireNonEmptyString(sourceId, "sourceId"),
    source_record_id: requireNonEmptyString(sourceRecordId, "sourceRecordId"),
  };
  return throwIfInvalid("organization", entity);
}

/**
 * Build one `public_position` entity.
 *
 * `position` must be one of the ontology's enum values. `namedIssue` is
 * `null` for generic/undifferentiated opposition (or support) and a
 * normalized issue string when the source ties the position to a specific,
 * named technical or procedural concern (A2) -- callers should route through
 * warehouse/lib/seqra_issue_preservation.mjs#normalizeNamedIssue rather than
 * passing raw free text, so the same issue phrased two ways still preserves
 * as one issue.
 */
export function buildPublicPosition({
  organizationKey,
  reviewKey,
  position,
  namedIssue = null,
  observedAt,
  availableToPublicAt,
  sourceId,
  sourceRecordId,
  sourceVintage = null,
  evidence = null,
  confidence,
  rivalExplanation,
  suppressionRule,
  organizationType = null,
} = {}) {
  const observed = requireIsoDateTime(observedAt, "observedAt");
  const availableToPublic = requireIsoDateTime(availableToPublicAt, "availableToPublicAt");

  // A4 / negative rule: a position cannot be public before it was observed,
  // and there is no such thing as an "undated" position this module accepts
  // -- both dates are mandatory constructor inputs, enforced above.
  if (new Date(availableToPublic).getTime() < new Date(observed).getTime()) {
    throw new SeqraPublicPositionBuilderError(
      `availableToPublicAt (${availableToPublic}) precedes observedAt (${observed}); a position cannot ` +
      "be publicly available before it was itself observed/taken",
    );
  }

  requireNonEmptyString(rivalExplanation, "rivalExplanation");
  requireNonEmptyString(suppressionRule, "suppressionRule");
  if (organizationType && SUPPRESSION_REQUIRED_ORGANIZATION_TYPES.includes(organizationType)
    && suppressionRule.trim() === "") {
    throw new SeqraPublicPositionBuilderError(
      `organization_type ${JSON.stringify(organizationType)} requires a non-empty suppressionRule`,
    );
  }

  const org = requireNonEmptyString(organizationKey, "organizationKey");
  const review = requireNonEmptyString(reviewKey, "reviewKey");
  const record = requireNonEmptyString(sourceRecordId, "sourceRecordId");

  const positionKey = buildPublicPositionKey({
    reviewKey: review,
    organizationKey: org,
    observedAt: observed,
    sourceRecordId: record,
  });

  const entity = {
    position_key: positionKey,
    organization_key: org,
    review_key: review,
    position: requireNonEmptyString(position, "position"),
    named_issue: namedIssue == null ? null : requireNonEmptyString(namedIssue, "namedIssue"),
    observed_at: observed,
    available_to_public_at: availableToPublic,
    source_id: requireNonEmptyString(sourceId, "sourceId"),
    source_record_id: record,
    source_vintage: sourceVintage,
    evidence,
    confidence: typeof confidence === "number" ? confidence : 0,
    rival_explanation: rivalExplanation,
    suppression_rule: suppressionRule,
  };
  return throwIfInvalid("public_position", entity);
}

export function organizationEntitySpec() {
  return SEQRA_ONTOLOGY_ENTITY_SPECS.organization;
}
export function publicPositionEntitySpec() {
  return SEQRA_ONTOLOGY_ENTITY_SPECS.public_position;
}

export { SeqraPublicPositionBuilderError };
