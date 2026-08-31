import {
  CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
  buildCivicInstitutionIdentity,
  buildEntityLink,
  resolveCivicInstitutionRoleEdges,
  sourceIdentityEvidence,
  sourceRecordObservation,
} from "../../ontology/civic_institution.mjs";
import { developmentRolesForInstitution } from "../../site/civic_institution_development_roles.mjs";
import { accountabilityRolesForInstitution } from "../../site/civic_institution_accountability.mjs";
import { councilCommitteeRolesForInstitution } from "../../site/civic_institution_council_committees.mjs";
import { boroughOfficeRolesForInstitution } from "../../site/civic_institution_borough_office.mjs";
import { governingBodiesForInstitution } from "../../site/civic_institution_governing_bodies.mjs";

export const AGENCY_IDENTITY_EVIDENCE_SCHEMA = "cityscroll.civic_institution_identity_evidence.v1";
export const AGENCY_IDENTITY_EVIDENCE_METHOD = "source_preserving_agency_identity_v1";

const clean = (value, max = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function observedAt(value, fallback = "2026-08-09") {
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?/);
  return match?.[0] || fallback;
}

function sourceFieldFor(item) {
  return item?.provenance?.source_fields?.find((field) => /agency|publisher/i.test(field))
    || item?.provenance?.source_fields?.[0]
    || "agency_name";
}

function itemObservation(item, identity, generatedAt) {
  const provenance = item?.provenance || {};
  const sourceRecordId = clean(provenance.source_record_id || item.source_record_id, 320);
  const sourceValue = clean(provenance.input_value, 1_000);
  if (!sourceRecordId || !sourceValue) return null;
  const rawSourceSystem = provenance.source_system || item.source || "source";
  const sourceSystem = typeof rawSourceSystem === "string"
    ? clean(rawSourceSystem, 120).replace(/[\s/:]+/g, "_") || "source"
    : "source";
  const observation = sourceRecordObservation({
    sourceSystem,
    sourceRecordId,
    sourceField: sourceFieldFor(item),
    sourceValue,
    sourceUrl: item.href || null,
    sourceDataset: sourceSystem,
    observedAt: observedAt(provenance.observed_at || generatedAt),
  });
  const link = buildEntityLink({
    sourceObservation: observation,
    institution: identity,
    method: "exact_normalized_publisher_value",
    confidence: item.confidence === "strong" ? "strong" : "unknown",
  });
  if (!link) return null;
  return {
    ...sourceIdentityEvidence(link),
    record_href: item.href || null,
    record_label: item.label || item.id || sourceRecordId,
    source_resolution_method: item.method || null,
  };
}

/**
 * Materialize the additive identity disclosure from retained source rows and
 * already-built record provenance. It performs no request-time acquisition.
 */
function mergeRoleBags(left, right) {
  const seen = new Set((left.accepted || []).map((edge) => edge.id));
  const accepted = [...(left.accepted || [])];
  for (const edge of right.accepted || []) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    accepted.push(edge);
  }
  return {
    accepted,
    held: [...(left.held || []), ...(right.held || [])],
    unknown: [...(left.unknown || []), ...(right.unknown || [])],
    unresolved: [...(left.unresolved || []), ...(right.unresolved || [])],
  };
}

export function buildAgencyIdentityEvidence({
  identity,
  publisherRow = null,
  view,
  generatedAt = null,
  roleCandidates = [],
  developmentRoleSources = null,
  accountabilitySources = null,
  committeeRoleSources = null,
  boroughOfficeSources = null,
  governingBodySources = null,
} = {}) {
  if (!identity?.canonical_id) return null;
  // A routed profile is not itself a source identity. Route-only and
  // unresolved bodies remain unknown until a retained publisher crosswalk
  // row supplies the exact source join.
  const hasPublisherIdentity = publisherRow && typeof publisherRow === "object" && !Array.isArray(publisherRow);
  const institution = buildCivicInstitutionIdentity({
    canonicalId: identity.canonical_id,
    canonicalName: identity.canonical_name,
  });
  const observations = [];
  const seen = new Set();
  const add = (observation) => {
    if (!observation) return;
    const key = [observation.source_system, observation.source_record_id, observation.source_field, observation.source_value].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    observations.push(observation);
  };

  if (hasPublisherIdentity) {
    // The OTI row is the retained source row for the enduring publisher identity.
    const rowObservation = sourceRecordObservation({
      sourceSystem: "oti",
      sourceRecordId: identity.canonical_id,
      sourceField: "canonical_name",
      sourceValue: publisherRow.canonical_name || identity.canonical_name,
      sourceUrl: "https://data.cityofnewyork.us/d/t3jq-9nkf",
      sourceDataset: "t3jq-9nkf",
      observedAt: observedAt(generatedAt),
    });
    const rowLink = buildEntityLink({
      sourceObservation: rowObservation,
      institution,
      method: "exact_source_identifier",
      confidence: "strong",
    });
    if (rowLink) {
      add({
        ...sourceIdentityEvidence(rowLink),
        record_href: rowObservation.source_url,
        record_label: "OTI agency record",
        oti_org_type: clean(publisherRow.org_type, 160) || null,
        source_resolution_method: clean(publisherRow.match_method, 160) || "exact source row",
      });
      for (const variant of publisherRow.variants || []) {
        const variantObservation = sourceRecordObservation({
          sourceSystem: "oti",
          sourceRecordId: identity.canonical_id,
          sourceField: "variants",
          sourceValue: variant,
          sourceUrl: "https://data.cityofnewyork.us/d/t3jq-9nkf",
          sourceDataset: "t3jq-9nkf",
          observedAt: observedAt(generatedAt),
        });
        const variantLink = buildEntityLink({
          sourceObservation: variantObservation,
          institution,
          method: "exact_normalized_publisher_value",
          confidence: "strong",
        });
        if (variantLink) {
          add({
            ...sourceIdentityEvidence(variantLink),
            record_label: "Retained publisher spelling",
            oti_org_type: null,
            source_resolution_method: clean(publisherRow.match_method, 160) || "exact publisher value",
          });
        }
      }
    }
    for (const category of view?.categories || []) {
      for (const item of category.items || []) add(itemObservation(item, institution, generatedAt));
    }
  }

  let roleEdges = resolveCivicInstitutionRoleEdges(roleCandidates);
  if (developmentRoleSources && identity.canonical_id) {
    roleEdges = mergeRoleBags(
      roleEdges,
      developmentRolesForInstitution(identity.canonical_id, developmentRoleSources),
    );
  }
  if (accountabilitySources && identity.canonical_id) {
    roleEdges = mergeRoleBags(
      roleEdges,
      accountabilityRolesForInstitution(identity.canonical_id, accountabilitySources),
    );
  }
  if (committeeRoleSources && identity.canonical_id) {
    roleEdges = mergeRoleBags(
      roleEdges,
      councilCommitteeRolesForInstitution(identity.canonical_id, committeeRoleSources),
    );
  }
  if (boroughOfficeSources && identity.canonical_id) {
    roleEdges = mergeRoleBags(
      roleEdges,
      boroughOfficeRolesForInstitution(identity.canonical_id, boroughOfficeSources),
    );
  }
  let governanceGaps = [];
  let identityReconciliations = [];
  if (governingBodySources && identity.canonical_id) {
    const governance = governingBodiesForInstitution(identity.canonical_id, governingBodySources);
    roleEdges = mergeRoleBags(roleEdges, governance);
    governanceGaps = governance.gaps || [];
    identityReconciliations = governance.identity_states || [];
  }
  return {
    schema: AGENCY_IDENTITY_EVIDENCE_SCHEMA,
    method: AGENCY_IDENTITY_EVIDENCE_METHOD,
    status: observations.length ? "matched" : "unknown",
    institution: {
      ...institution,
      href: view?.path || `/agencies/${identity.canonical_id}/`,
    },
    observations,
    role_edge_schema: CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
    role_edges: roleEdges.accepted,
    role_edge_held: roleEdges.held,
    role_edge_unknown: roleEdges.unknown,
    role_edge_unresolved: roleEdges.unresolved,
    governance_gaps: governanceGaps,
    identity_reconciliations: identityReconciliations,
    coverage: {
      accepted_count: observations.length,
      source_observation_count: observations.length,
      unresolved_count: 0,
      role_edge_accepted_count: roleEdges.accepted.length,
      role_edge_held_count: roleEdges.held.length,
      role_edge_unresolved_count: roleEdges.unresolved.length,
    },
    provenance: {
      source_dataset: "t3jq-9nkf",
      generated_at: generatedAt || null,
      materialization: "bounded_existing_read_models",
    },
  };
}
