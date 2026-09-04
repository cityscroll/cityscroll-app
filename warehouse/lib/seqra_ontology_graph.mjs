/**
 * SEQRA-02: relation-integrity validation over a set of ontology entities.
 *
 * Schema validation (warehouse/lib/seqra_ontology_spec.mjs) only checks one
 * entity in isolation. This module checks the fourteen required relations
 * actually resolve -- every foreign key an entity carries must name a key
 * that exists among the entities it is validated against -- and that no
 * entity type admits a duplicate primary key (the collision-safety half of
 * "stable-key functions are deterministic and collision-tested").
 */

import { SEQRA_ONTOLOGY_ENTITY_TYPES, validateSeqraEntity } from "./seqra_ontology_spec.mjs";

const KEY_FIELD_BY_TYPE = Object.freeze({
  project: "project_key",
  government_action: "action_key",
  environmental_review: "review_key",
  review_document: "document_key",
  review_event: "event_key",
  technical_topic_assessment: "assessment_key",
  mitigation_commitment: "commitment_key",
  alternative: "alternative_key",
  organization: "organization_key",
  public_position: "position_key",
  land_use_determination: "determination_key",
  judicial_case: "case_key",
  case_filing: "filing_key",
  claim_theory: "claim_key",
  search_coverage: "coverage_key",
});

/**
 * Foreign-key checks: [entityType, fkField, targetType, { nullable }].
 * Self-referential supersession edges (later_document -> supersedes_document
 * -> earlier_document, later_decision -> decision_supersedes ->
 * earlier_decision) target their own entity type.
 */
const FOREIGN_KEYS = [
  ["government_action", "project_key", "project", {}],
  ["environmental_review", "action_key", "government_action", {}],
  ["review_document", "review_key", "environmental_review", {}],
  ["review_document", "supersedes_document_key", "review_document", { nullable: true }],
  ["technical_topic_assessment", "review_key", "environmental_review", {}],
  ["technical_topic_assessment", "document_key", "review_document", { nullable: true }],
  ["mitigation_commitment", "review_key", "environmental_review", {}],
  ["alternative", "review_key", "environmental_review", {}],
  ["public_position", "organization_key", "organization", {}],
  ["public_position", "review_key", "environmental_review", {}],
  ["land_use_determination", "action_key", "government_action", {}],
  ["land_use_determination", "review_key", "environmental_review", {}],
  ["land_use_determination", "supersedes_determination_key", "land_use_determination", { nullable: true }],
  ["judicial_case", "determination_key", "land_use_determination", {}],
  ["case_filing", "case_key", "judicial_case", {}],
  ["claim_theory", "case_key", "judicial_case", {}],
  ["search_coverage", "determination_key", "land_use_determination", { nullable: true }],
];

/**
 * Validate a set of entities keyed by entity type. `entitiesByType` need not
 * carry every type -- absent types are simply not checked, which is how a
 * fixture can exercise a partial slice of the graph.
 */
export function validateOntologyGraph(entitiesByType = {}) {
  const findings = [];
  const keysByType = {};

  for (const entityType of Object.keys(entitiesByType)) {
    if (!SEQRA_ONTOLOGY_ENTITY_TYPES.includes(entityType)) {
      findings.push(`unknown entity type in graph: ${entityType}`);
      continue;
    }
    const rows = entitiesByType[entityType] ?? [];
    const keyField = KEY_FIELD_BY_TYPE[entityType];
    const seen = new Set();
    rows.forEach((row, index) => {
      const label = `${entityType}[${index}]`;
      findings.push(...validateSeqraEntity(entityType, row, label));
      const key = row?.[keyField];
      if (typeof key === "string") {
        if (seen.has(key)) findings.push(`${label}: duplicate ${keyField} ${key} within ${entityType}`);
        seen.add(key);
      }
    });
    keysByType[entityType] = seen;
  }

  for (const [entityType, fkField, targetType, { nullable }] of FOREIGN_KEYS) {
    const rows = entitiesByType[entityType];
    if (!rows) continue;
    const targetKeys = keysByType[targetType] ?? new Set();
    rows.forEach((row, index) => {
      const value = row?.[fkField];
      if (value == null) {
        if (!nullable) findings.push(`${entityType}[${index}]: ${fkField} is required and must reference an existing ${targetType}`);
        return;
      }
      if (!targetKeys.has(value)) {
        findings.push(`${entityType}[${index}]: ${fkField}=${JSON.stringify(value)} does not resolve to a known ${targetType}`);
      }
    });
  }

  return findings;
}

export { KEY_FIELD_BY_TYPE, FOREIGN_KEYS };
