import assert from "node:assert/strict";
import test from "node:test";

import {
  CIVIC_INSTITUTION_PROJECTION_SCHEMA,
  ENTITY_LINK_SCHEMA,
  buildCivicInstitutionIdentity,
  buildEntityLink,
  parseCivicInstitutionIdentity,
  projectCivicInstitution,
  resolveCivicInstitutionLink,
  sourceRecordObservation,
  sourceIdentityEvidence,
} from "../ontology/civic_institution.mjs";

const dsny = buildCivicInstitutionIdentity({
  canonicalId: "sanitation",
  canonicalName: "New York City Department of Sanitation",
});

test("source-preserving institution identity retains the agency compatibility subject", () => {
  assert.equal(dsny.schema, CIVIC_INSTITUTION_PROJECTION_SCHEMA);
  assert.equal(dsny.id, "civic-institution:sanitation");
  assert.equal(dsny.legacy_subject_ref, "agency:id:sanitation");
  assert.equal(dsny.institution_kind, null);
  assert.equal(dsny.classification_status, "unclassified");
  assert.deepEqual(parseCivicInstitutionIdentity(dsny.id), {
    id: dsny.id,
    canonical_id: "sanitation",
  });
});

test("exact DSNY observation produces a reversible, provenance-complete link", () => {
  const observation = sourceRecordObservation({
    sourceSystem: "city_record",
    sourceRecordId: "city_record:20260708002",
    sourceField: "agency_name",
    sourceValue: "DEPARTMENT OF SANITATION",
    sourceUrl: "/notices/20260708002",
    sourceDataset: "dg92-zbpx",
    observedAt: "2026-08-25T10:00:00.000Z",
  });
  const link = buildEntityLink({
    sourceObservation: observation,
    institution: dsny,
    method: "exact_normalized_publisher_value",
    confidence: "strong",
  });
  assert.equal(link.schema, ENTITY_LINK_SCHEMA);
  assert.equal(link.relation, "entity_link");
  assert.equal(link.inverse, "has_source_observation");
  assert.equal(link.from, observation.source_record_ref);
  assert.equal(link.to, dsny.id);
  assert.deepEqual(sourceIdentityEvidence(link), {
    entity_link_id: link.id,
    entity_link_relation: "entity_link",
    entity_link_inverse: "has_source_observation",
    source_record_ref: observation.source_record_ref,
    institution_ref: dsny.id,
    source_system: "city_record",
    source_record_id: "city_record:20260708002",
    source_field: "agency_name",
    source_value: "DEPARTMENT OF SANITATION",
    source_url: "/notices/20260708002",
    canonical_id: "sanitation",
    method: "exact_normalized_publisher_value",
    confidence: "strong",
    observed_at: "2026-08-25T10:00:00.000Z",
  });
});

test("OTI org_type is retained as source evidence, never promoted to institution kind", () => {
  const institution = projectCivicInstitution({
    canonicalId: "sanitation",
    canonicalName: dsny.canonical_name,
    observations: [{
      source_system: "oti",
      source_record_id: "sanitation",
      source_field: "org_type",
      source_value: "Mayoral Agency",
      observed_at: "2026-08-09",
    }],
    generatedAt: "2026-08-09T00:00:00Z",
  });
  assert.equal(institution.institution_kind, null);
  assert.equal(institution.observations[0].source_field, "org_type");
  assert.equal(institution.observations[0].source_value, "Mayoral Agency");
});

test("colliding, unresolved, and fuzzy resolutions remain explicitly unknown", () => {
  const observation = sourceRecordObservation({
    sourceSystem: "city_record",
    sourceRecordId: "city_record:eep-collision",
    sourceField: "agency_name",
    sourceValue: "EQUAL EMPLOYMENT PRACTICES COMMISSION",
    observedAt: "2026-08-09",
  });
  assert.equal(buildEntityLink({
    sourceObservation: observation,
    institution: "equal-employment-practices-commission",
    method: "exact_normalized_publisher_value",
    confidence: "strong",
    resolutionStatus: "collision",
  }), null);
  assert.equal(buildEntityLink({
    sourceObservation: observation,
    institution: "equal-employment-practices-commission",
    method: "fuzzy_name_similarity",
    confidence: "strong",
  }), null);
  const result = resolveCivicInstitutionLink({
    sourceObservation: observation,
    resolutionStatus: "collision",
    reason: "publisher_collision",
  });
  assert.deepEqual(result, { status: "unknown", reason: "publisher_collision", link: null });
});

test("display-name equality cannot create a cross-source link", () => {
  const first = sourceRecordObservation({
    sourceSystem: "staffing",
    sourceRecordId: "staffing:exam:6101",
    sourceField: "agency_name",
    sourceValue: "Sanitation",
    observedAt: "2026-08-06",
  });
  const second = sourceRecordObservation({
    sourceSystem: "city_record",
    sourceRecordId: "city_record:other",
    sourceField: "agency_name",
    sourceValue: "Sanitation",
    observedAt: "2026-08-06",
  });
  assert.notEqual(first.source_record_ref, second.source_record_ref);
  assert.equal(buildEntityLink({
    sourceObservation: first,
    institution: dsny,
    method: "display_name_equality",
    confidence: "strong",
  }), null);
});

test("distinct source observations receive distinct reversible link ids", () => {
  const first = sourceRecordObservation({
    sourceSystem: "oti",
    sourceRecordId: "sanitation",
    sourceField: "canonical_name",
    sourceValue: "New York City Department of Sanitation",
    observedAt: "2026-08-09",
  });
  const second = sourceRecordObservation({
    sourceSystem: "oti",
    sourceRecordId: "sanitation",
    sourceField: "variants",
    sourceValue: "DEPARTMENT OF SANITATION",
    observedAt: "2026-08-09",
  });
  const firstLink = buildEntityLink({ sourceObservation: first, institution: dsny, method: "exact_source_identifier" });
  const secondLink = buildEntityLink({ sourceObservation: second, institution: dsny, method: "exact_normalized_publisher_value" });
  assert.notEqual(firstLink.id, secondLink.id);
});

test("route-only identities do not receive synthetic source observations", async () => {
  const { buildAgencyIdentityEvidence } = await import("../tools/lib/agency_identity_evidence.mjs");
  const evidence = buildAgencyIdentityEvidence({
    identity: {
      canonical_id: "department-of-social-services",
      canonical_name: "Department of Social Services",
      matched: true,
      route_classification: "legitimate_non_crosswalk_entity",
    },
    view: {
      categories: [{ items: [{
        id: "notice:route-only",
        href: "/notices/route-only",
        confidence: "strong",
        provenance: {
          source_system: "city_record",
          source_record_id: "city_record:route-only",
          source_fields: ["agency_name"],
          input_value: "Department of Social Services",
          observed_at: "2026-08-09",
        },
      }] }],
    },
    generatedAt: "2026-08-09T00:00:00Z",
  });
  assert.equal(evidence.status, "unknown");
  assert.deepEqual(evidence.observations, []);
  assert.equal(evidence.coverage.source_observation_count, 0);
});
