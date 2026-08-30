import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENCY_ROLE_COMPATIBILITY_SCHEMA,
  CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
  CIVIC_INSTITUTION_ROLE_RELATIONS,
  LEGACY_AGENCY_ROLE_PROJECTIONS,
  buildCivicInstitutionRoleEdge,
  civicInstitutionRoleHref,
  invertCivicInstitutionRoleEdge,
  legacyAgencyRoleProjection,
  projectLegacyAgencyRole,
  resolveCivicInstitutionRoleEdges,
  sourceRecordObservation,
} from "../ontology/civic_institution.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";
import { AGENCY_CONNECTION_DOMAINS } from "../site/agency_connections.mjs";
import { renderAgencyIdentitySection } from "../site/agency_identity_evidence.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";

const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_role_edges/cases.json", import.meta.url), "utf8"),
);

function observationFrom(row) {
  return row?.sourceObservation ? sourceRecordObservation(row.sourceObservation) : null;
}

function candidateFrom(row) {
  return {
    subject: row.subject,
    object: row.object,
    objectCandidates: row.objectCandidates,
    objectDisplayName: row.objectDisplayName,
    relation: row.relation,
    sourceObservation: observationFrom(row),
    evidenceRefs: row.evidenceRefs,
    confidence: row.confidence,
    basis: row.basis,
    asOf: FIXTURES.as_of,
    vintage: FIXTURES.vintage,
    method: row.method,
    resolutionStatus: row.resolutionStatus,
  };
}

test("registry registers the civic-institution role-edge contract", () => {
  const registry = loadOntologyRegistry();
  const institution = registry.object_types.find(({ id }) => id === "civic-institution");
  const role = registry.link_types.find(({ id }) => id === "must_report_to");
  assert.equal(institution.identity_contract.role_edge_schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(role.status, "registered");
  assert.equal(role.from, "civic-institution");
  assert.equal(role.to, "civic-institution");
  assert.equal(role.inverse, "receives_report_from");
  assert.equal(role.edge_schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(role.legacy_agency_relation, "statute_duty");
  assert.deepEqual(role.allowed_statuses, ["accepted", "unknown", "held", "unresolved"]);
  assert.match(role.negative_rule, /related_to/);
});

test("exact DOC mandate observations produce provenance-complete role edges", () => {
  const board = buildCivicInstitutionRoleEdge(candidateFrom(FIXTURES.cases.accepted_doc_board_of_correction));
  const council = buildCivicInstitutionRoleEdge(candidateFrom(FIXTURES.cases.accepted_doc_city_council));
  assert.equal(board.status, "accepted");
  assert.equal(board.linking, true);
  assert.equal(board.schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(board.relation_id, "must_report_to");
  assert.equal(board.role, "report_submitter");
  assert.equal(board.from, "civic-institution:correction");
  assert.equal(board.to, "civic-institution:board-of-correction");
  assert.equal(board.href, "/agencies/board-of-correction/");
  assert.equal(board.source_contract, CIVIC_INSTITUTION_ROLE_RELATIONS.must_report_to.source_contract);
  assert.equal(board.confidence, "strong");
  assert.equal(board.basis, "exact_statute_addressee");
  assert.equal(board.as_of, "2020-01-01");
  assert.equal(board.vintage, "obligation:63842-001");
  assert.equal(board.provenance.source_system, "legistar");
  assert.equal(board.provenance.source_record_id, "legistar:63842-001");
  assert.equal(board.provenance.source_field, "duty_addressee");
  assert.deepEqual(board.evidence_refs, ["obligation:63842-001", "legistar:63842"]);
  assert.equal(council.to, "civic-institution:city-council");
  assert.notEqual(board.id, council.id);
});

test("inverse of an accepted role edge is deterministic and reversible", () => {
  const forward = buildCivicInstitutionRoleEdge(candidateFrom(FIXTURES.cases.accepted_doc_board_of_correction));
  const inverse = invertCivicInstitutionRoleEdge(forward);
  const restored = invertCivicInstitutionRoleEdge(inverse);
  assert.equal(inverse.status, "accepted");
  assert.equal(inverse.linking, true);
  assert.equal(inverse.relation_id, "receives_report_from");
  assert.equal(inverse.role, "report_recipient");
  assert.equal(inverse.from, "civic-institution:board-of-correction");
  assert.equal(inverse.to, "civic-institution:correction");
  assert.equal(inverse.href, "/agencies/correction/");
  assert.equal(inverse.inverse, "must_report_to");
  assert.equal(restored.id, forward.id);
  assert.equal(restored.relation_id, forward.relation_id);
  assert.equal(restored.from, forward.from);
  assert.equal(restored.to, forward.to);
});

test("missing source, conflicting endpoints, held OTI reports_to, and related_to stay non-linking", () => {
  const missing = buildCivicInstitutionRoleEdge(candidateFrom(FIXTURES.cases.missing_source));
  assert.equal(missing.status, "unknown");
  assert.equal(missing.reason, "source_observation_missing");
  assert.equal(missing.linking, false);
  assert.equal(civicInstitutionRoleHref(missing), null);

  const resolved = resolveCivicInstitutionRoleEdges([
    candidateFrom(FIXTURES.cases.accepted_doc_board_of_correction),
    candidateFrom(FIXTURES.cases.accepted_doc_city_council),
    candidateFrom(FIXTURES.cases.missing_source),
    candidateFrom(FIXTURES.cases.conflicting_eep),
    candidateFrom(FIXTURES.cases.held_oti_reports_to),
    candidateFrom(FIXTURES.cases.generic_related_to),
  ]);
  assert.equal(resolved.accepted.length, 2);
  assert.equal(resolved.unknown[0].reason, "source_observation_missing");
  assert.equal(resolved.unresolved.some((edge) => edge.reason === "conflicting_endpoints"), true);
  assert.equal(resolved.unresolved.some((edge) => edge.reason === "generic_relation_forbidden"), true);
  assert.equal(resolved.held[0].status, "held");
  assert.equal(resolved.held[0].reason, "oti_reports_to_is_not_oversight");
  assert.equal(resolved.held[0].linking, false);
  assert.equal(resolved.accepted.every((edge) => edge.relation_id !== "related_to"), true);
});

test("name-only and record-targeted families never mint civic-institution role edges", () => {
  const named = buildCivicInstitutionRoleEdge({
    subject: "civic-institution:correction",
    object: "Board of Correction",
    objectDisplayName: "Board of Correction",
    relation: "must_report_to",
    sourceObservation: observationFrom(FIXTURES.cases.accepted_doc_board_of_correction),
    evidenceRefs: ["obligation:63842-001"],
    method: "exact_source_identifier",
    confidence: "strong",
  });
  assert.equal(named.status, "unresolved");
  assert.equal(named.reason, "name_only_endpoint");
  assert.equal(named.linking, false);

  const heldRecord = buildCivicInstitutionRoleEdge({
    subject: "civic-institution:sanitation",
    object: "civic-institution:sanitation",
    relation: "published_by_agency",
    sourceObservation: observationFrom(FIXTURES.cases.accepted_doc_board_of_correction),
    evidenceRefs: ["notice:20260708002"],
    method: "exact_source_identifier",
    confidence: "strong",
  });
  assert.equal(heldRecord.status, "held");
  assert.equal(heldRecord.reason, "unsupported_i2i_relation");
  assert.equal(heldRecord.linking, false);
});

test("legacy agency consumers keep original relation ids and agency subjects", () => {
  const edge = buildCivicInstitutionRoleEdge(candidateFrom(FIXTURES.cases.accepted_doc_board_of_correction));
  const compatibility = legacyAgencyRoleProjection(edge);
  assert.equal(compatibility.schema, AGENCY_ROLE_COMPATIBILITY_SCHEMA);
  assert.equal(compatibility.subject_ref, "agency:id:correction");
  assert.equal(compatibility.object_ref, "agency:id:board-of-correction");
  assert.equal(compatibility.relation, "statute_duty");
  assert.equal(compatibility.role_relation, "must_report_to");
  assert.equal(compatibility.href, "/agencies/board-of-correction/");

  const published = projectLegacyAgencyRole(FIXTURES.cases.legacy_published_by_agency);
  assert.equal(published.subject_ref, "agency:id:sanitation");
  assert.equal(published.relation, "published_by_agency");
  assert.equal(published.object_kind, "record");
  assert.equal(published.civic_institution_role_edge, null);
  assert.equal(published.href, "/notices/20260708002");
  assert.equal(LEGACY_AGENCY_ROLE_PROJECTIONS.published_by_agency.relation, "published_by_agency");
  assert.deepEqual(
    AGENCY_CONNECTION_DOMAINS.map((row) => row.relation),
    [
      "published_by_agency",
      "applicant_agency",
      "published_by_agency",
      "issued_rule",
      "hosts_meeting",
      "votes_as_official",
      "named_franchisee",
    ],
  );
});

test("agency profile role rail links accepted edges and leaves held or unresolved unlinked", async () => {
  const identity = {
    canonical_id: "correction",
    canonical_name: "Department of Correction",
  };
  const evidence = buildAgencyIdentityEvidence({
    identity,
    publisherRow: {
      canonical_name: identity.canonical_name,
      org_type: "Mayoral Agency",
      match_method: "normalized+budget",
      variants: ["DEPARTMENT OF CORRECTION"],
    },
    view: {
      path: "/agencies/correction/",
      categories: [],
    },
    generatedAt: "2026-08-09T00:00:00Z",
    roleCandidates: [
      candidateFrom(FIXTURES.cases.accepted_doc_board_of_correction),
      candidateFrom(FIXTURES.cases.held_oti_reports_to),
      candidateFrom(FIXTURES.cases.conflicting_eep),
      candidateFrom(FIXTURES.cases.generic_related_to),
    ],
  });
  assert.equal(evidence.role_edges.length, 1);
  assert.equal(evidence.role_edges[0].href, "/agencies/board-of-correction/");
  assert.equal(evidence.legacy_subject_ref || evidence.institution.legacy_subject_ref, "agency:id:correction");
  const html = renderAgencyIdentitySection({
    path: "/agencies/correction/",
    display_name: identity.canonical_name,
    identity_evidence: evidence,
  });
  assert.match(html, /data-identity-schema="cityscroll\.civic_institution_identity_evidence\.v1"/);
  assert.match(html, /id="agency-institution-roles"/);
  assert.match(html, /href="\/agencies\/board-of-correction\/"/);
  assert.match(html, /data-role-linking="1"/);
  assert.match(html, /data-role-status="held"/);
  assert.match(html, /data-role-unlinked="1"/);
  assert.doesNotMatch(html, /related_to/);
  assert.doesNotMatch(html, /href="\/agencies\/equal-employment-practices-commission\/"/);
});
