/**
 * LDP-23: register filing obligations, filing documents, and exact project
 * edges. Table-driven schema + negative tests over ontology/land_use_filing.mjs
 * and its registry.v0.json entries.
 *
 * Verify: node --test test/land_filing_ontology.test.mjs test/land_filing_asof.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DRI_INTERPRETATION,
  FILING_APPLICABILITY_STATES,
  FILING_DOCUMENT_TYPES,
  FILING_DOCUMENT_TYPES_BLOCKED_UNTIL_SEQRA04,
  FILING_FULFILLMENT_STATES,
  FORBIDDEN_FILING_OBSERVATION_SYNONYMS,
  LAND_USE_FILING_DOCUMENT_SCHEMA,
  LAND_USE_FILING_OBLIGATION_SCHEMA,
  LAND_USE_FILING_RELATIONS,
  LAND_USE_FILING_RELATION_SCHEMA,
  RACIAL_EQUITY_REPORT_SCHEMA,
  assertNoForbiddenFilingObservationSynonym,
  buildLandUseFilingDocument,
  buildLandUseFilingObligation,
  buildLandUseFilingRelation,
  buildRacialEquityReportEnvelope,
  landUseFilingDocumentId,
  landUseFilingObligationId,
  racialEquityReportGoverningAuthority,
  resolveCurrentFilingDocumentVersions,
  validateLandUseFilingDocument,
  validateLandUseFilingObligation,
  validateLandUseFilingRelation,
  validateRacialEquityReportEnvelope,
} from "../ontology/land_use_filing.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-05T00:00:00.000Z";

const GOVERNING_AUTHORITY = [racialEquityReportGoverningAuthority()];

function baseObligationInput(overrides = {}) {
  return {
    obligation_id: landUseFilingObligationId({ project_ref: "project:2025Q0247", obligation_type: "racial_equity_report" }),
    project_ref: "project:2025Q0247",
    obligation_type: "racial_equity_report",
    governing_authority: GOVERNING_AUTHORITY,
    applicability: { state: "unknown" },
    fulfillment: { state: "not_checked" },
    observed_at: T0,
    available_to_public_at: T0,
    materialized_at: T0,
    source_id: "zap-api-outcomes",
    source_record_id: "2025Q0247",
    source_vintage: T0,
    normalization_version: "ldp23-v1",
    ...overrides,
  };
}

function baseDocumentInput(overrides = {}) {
  return {
    project_ref: "project:2025Q0247",
    document_type: "racial_equity_report",
    publisher_document_id: "artifact-abc123",
    original_name: "Racial Equity Report.pdf",
    first_observed_at: T0,
    available_to_public_at: T0,
    retrieval_status: "not_attempted",
    classification: {
      method: "title_token_plus_markers",
      evidence: ["dcp-name matched /racial equity report/i"],
      confidence: "medium",
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

test("registry registers the three LDP-23 object types and five relations", () => {
  const registry = loadOntologyRegistry();
  const objects = new Map(registry.object_types.map((e) => [e.id, e]));
  const links = new Map(registry.link_types.map((e) => [e.id, e]));

  const obligation = objects.get("land-use-filing-obligation");
  assert.equal(obligation.status, "registered");
  assert.equal(obligation.identity_contract.schema, LAND_USE_FILING_OBLIGATION_SCHEMA);
  assert.equal(obligation.identity_contract.applicability_public_state_requires_publisher_assertion, true);
  assert.equal(obligation.identity_contract.reconstructed_candidate_never_public, true);

  const document = objects.get("land-use-filing-document");
  assert.equal(document.status, "registered");
  assert.equal(document.identity_contract.schema, LAND_USE_FILING_DOCUMENT_SCHEMA);
  assert.equal(document.identity_contract.ceqr_document_link_blocked_until_seqra_04, true);

  const rer = objects.get("racial-equity-report");
  assert.equal(rer.status, "registered");
  assert.equal(rer.identity_contract.schema, RACIAL_EQUITY_REPORT_SCHEMA);
  assert.equal(rer.identity_contract.ceqr_subtype_forbidden, true);

  for (const id of Object.keys(LAND_USE_FILING_RELATIONS)) {
    const link = links.get(id);
    assert.ok(link, `link_types missing ${id}`);
    assert.equal(link.status, "registered");
    assert.equal(link.edge_schema, LAND_USE_FILING_RELATION_SCHEMA);
    assert.equal(link.from, LAND_USE_FILING_RELATIONS[id].from_kind);
    assert.equal(link.to, LAND_USE_FILING_RELATIONS[id].to_kind);
    assert.equal(link.inverse, LAND_USE_FILING_RELATIONS[id].inverse);
  }
});

/* ------------------------------------------------------------------ */
/* Obligation: applicability five-state contract                      */
/* ------------------------------------------------------------------ */

test("applicability 'unknown', 'not_yet_effective', and 'source_conflict' build without a publisher assertion", () => {
  for (const state of ["unknown", "not_yet_effective", "source_conflict"]) {
    const obligation = buildLandUseFilingObligation(baseObligationInput({ applicability: { state } }));
    assert.equal(obligation.applicability.state, state);
    assert.equal(obligation.applicability.publisher_assertion, null);
  }
});

test("applicability 'required' and 'not_required' require an explicit publisher_assertion", () => {
  for (const state of ["required", "not_required"]) {
    assert.throws(
      () => buildLandUseFilingObligation(baseObligationInput({ applicability: { state } })),
      /publisher_assertion/,
      `${state} without publisher_assertion must throw`,
    );
    const obligation = buildLandUseFilingObligation(baseObligationInput({
      applicability: {
        state,
        publisher_assertion: { source_field: "dcp-applicability", source_value: state === "required" ? "Yes" : "No", observed_at: T0 },
      },
    }));
    assert.equal(obligation.applicability.state, state);
    assert.equal(obligation.applicability.publisher_assertion.source_field, "dcp-applicability");
  }
});

test("a title-token artifact match can only ever become reconstructed_candidate, never the public state", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput({
    applicability: {
      state: "unknown",
      reconstructed_candidate: {
        state: "required",
        method: "title_token_artifact_group_match",
        evidence: ["artifact group dcp-name matched /racial equity report/i"],
      },
    },
  }));
  assert.equal(obligation.applicability.state, "unknown", "reconstructed_candidate must not change the public state");
  assert.equal(obligation.applicability.reconstructed_candidate.state, "required");
  assert.equal(obligation.applicability.reconstructed_candidate.public, false, "reconstructed_candidate.public is a hard invariant");
});

test("applicability rejects an unrecognized state", () => {
  assert.throws(() => buildLandUseFilingObligation(baseObligationInput({ applicability: { state: "likely" } })), TypeError);
});

test("every FILING_APPLICABILITY_STATES entry is exercised", () => {
  assert.deepEqual([...FILING_APPLICABILITY_STATES].sort(), ["not_required", "not_yet_effective", "required", "source_conflict", "unknown"].sort());
});

/* ------------------------------------------------------------------ */
/* Obligation: fulfillment five-state contract                        */
/* ------------------------------------------------------------------ */

test("fulfillment 'document_observed' requires at least one document_refs[] entry", () => {
  assert.throws(
    () => buildLandUseFilingObligation(baseObligationInput({ fulfillment: { state: "document_observed", document_refs: [] } })),
    /document_refs/,
  );
  const docRef = landUseFilingDocumentId({ project_ref: "project:2025Q0247", publisher_document_id: "artifact-abc123", first_observed_at: T0 });
  const obligation = buildLandUseFilingObligation(baseObligationInput({
    fulfillment: { state: "document_observed", document_refs: [docRef] },
  }));
  assert.equal(obligation.fulfillment.state, "document_observed");
  assert.deepEqual(obligation.fulfillment.document_refs, [docRef]);
});

test("fulfillment 'publisher_identifies_not_timely_filed' requires an explicit publisher assertion", () => {
  assert.throws(
    () => buildLandUseFilingObligation(baseObligationInput({ fulfillment: { state: "publisher_identifies_not_timely_filed" } })),
    /publisher_assertion/,
  );
  const obligation = buildLandUseFilingObligation(baseObligationInput({
    fulfillment: {
      state: "publisher_identifies_not_timely_filed",
      publisher_assertion: { source_field: "public_status", source_value: "Missing RER", observed_at: T0 },
    },
  }));
  assert.equal(obligation.fulfillment.state, "publisher_identifies_not_timely_filed");
});

test("fulfillment 'not_observed', 'not_checked', 'source_unavailable' build with no document_refs", () => {
  for (const state of ["not_observed", "not_checked", "source_unavailable"]) {
    const obligation = buildLandUseFilingObligation(baseObligationInput({ fulfillment: { state } }));
    assert.equal(obligation.fulfillment.state, state);
    assert.deepEqual(obligation.fulfillment.document_refs, []);
  }
});

test("every FILING_FULFILLMENT_STATES entry is exercised", () => {
  assert.deepEqual(
    [...FILING_FULFILLMENT_STATES].sort(),
    ["document_observed", "not_checked", "not_observed", "publisher_identifies_not_timely_filed", "source_unavailable"].sort(),
  );
});

/* ------------------------------------------------------------------ */
/* Obligation: procedural effect + real ZAP specimens                  */
/* ------------------------------------------------------------------ */

test("racial_equity_report procedural_effect.certification_blocker cannot be set true", () => {
  assert.throws(
    () => buildLandUseFilingObligation(baseObligationInput({ procedural_effect: { certification_blocker: true } })),
    /certification_blocker/,
  );
});

test("2025Q0247 (LDP-22 positive specimen) and 2026K0123 (active/noticed specimen) both stay applicability.state=unknown", () => {
  // LDP-22 census: dcp-applicability reads "Yes" on both projects; it is not
  // an RER-applicability signal. 2025Q0247 has an observed RER artifact
  // group; 2026K0123 has none. Neither fact may set the public applicability
  // state without a real publisher assertion.
  const positive = buildLandUseFilingObligation(baseObligationInput({
    project_ref: "project:2025Q0247",
    fulfillment: {
      state: "document_observed",
      document_refs: [landUseFilingDocumentId({ project_ref: "project:2025Q0247", publisher_document_id: "artifact-abc123", first_observed_at: T0 })],
    },
  }));
  const active = buildLandUseFilingObligation(baseObligationInput({
    obligation_id: landUseFilingObligationId({ project_ref: "project:2026K0123", obligation_type: "racial_equity_report" }),
    project_ref: "project:2026K0123",
    source_record_id: "2026K0123",
    fulfillment: { state: "not_observed" },
  }));
  assert.equal(positive.applicability.state, "unknown");
  assert.equal(active.applicability.state, "unknown");
  assert.equal(positive.fulfillment.state, "document_observed");
  assert.equal(active.fulfillment.state, "not_observed");
  // "not_observed" must not read as "not filed" / "blocked" / "failed" --
  // assert the fulfillment envelope carries no such key.
  assert.deepEqual(Object.keys(active.fulfillment).sort(), ["document_refs", "publisher_assertion", "state"]);
});

/* ------------------------------------------------------------------ */
/* Document: type, identity, classification, versions                 */
/* ------------------------------------------------------------------ */

test("every FILING_DOCUMENT_TYPES entry except ceqr_document_link builds", () => {
  for (const documentType of FILING_DOCUMENT_TYPES) {
    if (FILING_DOCUMENT_TYPES_BLOCKED_UNTIL_SEQRA04.includes(documentType)) continue;
    const classification = documentType === "unknown"
      ? { method: "unknown", confidence: "unknown" }
      : { method: "title_token_plus_markers", evidence: ["matched"], confidence: "medium" };
    const doc = buildLandUseFilingDocument(baseDocumentInput({ document_type: documentType, classification }));
    assert.equal(doc.document_type, documentType);
  }
});

test("ceqr_document_link stays blocked until SEQRA-04", () => {
  assert.throws(
    () => buildLandUseFilingDocument(baseDocumentInput({ document_type: "ceqr_document_link" })),
    /SEQRA-04/,
  );
});

test("same-name, different publisher_document_id: distinct document_id", () => {
  const a = buildLandUseFilingDocument(baseDocumentInput({ publisher_document_id: "artifact-abc123" }));
  const b = buildLandUseFilingDocument(baseDocumentInput({ publisher_document_id: "artifact-def456" }));
  assert.equal(a.original_name, b.original_name);
  assert.notEqual(a.document_id, b.document_id);
});

test("same publisher_document_id re-observed later with different bytes: distinct document_id, linkable via supersedes", () => {
  const first = buildLandUseFilingDocument(baseDocumentInput({
    first_observed_at: T0,
    bytes_sha256: "a".repeat(64),
    byte_length: 100,
    retrieval_status: "fetched",
  }));
  const later = buildLandUseFilingDocument(baseDocumentInput({
    first_observed_at: T1,
    available_to_public_at: T1,
    bytes_sha256: "b".repeat(64),
    byte_length: 120,
    retrieval_status: "fetched",
    supersedes: first.document_id,
    supersession_basis: "re-fetched under the same publisher_document_id with a different byte hash",
  }));
  assert.notEqual(first.document_id, later.document_id, "same-name/different-hash artifacts must not collapse");
  assert.equal(later.supersedes, first.document_id);
  assert.deepEqual([...resolveCurrentFilingDocumentVersions([first, later])].map((d) => d.document_id), [later.document_id]);
});

test("exact byte duplicate is linked via content_duplicate_of, not erased", () => {
  const original = buildLandUseFilingDocument(baseDocumentInput({ publisher_document_id: "artifact-abc123" }));
  const duplicate = buildLandUseFilingDocument(baseDocumentInput({
    publisher_document_id: "artifact-zzz999",
    content_duplicate_of: original.document_id,
  }));
  assert.equal(duplicate.content_duplicate_of, original.document_id);
  assert.notEqual(duplicate.document_id, original.document_id, "a duplicate is still its own manifest entry");
});

test("supersedes requires supersession_basis", () => {
  const first = buildLandUseFilingDocument(baseDocumentInput({ first_observed_at: T0 }));
  assert.throws(
    () => buildLandUseFilingDocument(baseDocumentInput({ first_observed_at: T1, supersedes: first.document_id })),
    /supersession_basis/,
  );
});

test("version chain: version_ordinal and version_label are preserved and inspectable", () => {
  const v1 = buildLandUseFilingDocument(baseDocumentInput({
    document_type: "filed_land_use_package",
    classification: { method: "explicit_publisher_type_or_group", evidence: ["relationship_type=packages"], confidence: "high" },
    version_ordinal: 1,
    version_label: "Filed LU Package v1",
    first_observed_at: T0,
  }));
  const v2 = buildLandUseFilingDocument(baseDocumentInput({
    document_type: "filed_land_use_package",
    classification: { method: "explicit_publisher_type_or_group", evidence: ["relationship_type=packages"], confidence: "high" },
    version_ordinal: 2,
    version_label: "Filed LU Package v2",
    first_observed_at: T1,
    available_to_public_at: T1,
    supersedes: v1.document_id,
    supersession_basis: "dcp-packageversion incremented from 1 to 2",
  }));
  assert.equal(v1.version_ordinal, 1);
  assert.equal(v2.version_ordinal, 2);
  const heads = resolveCurrentFilingDocumentVersions([v1, v2]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].document_id, v2.document_id);
  // Both versions individually remain inspectable in the source list.
  assert.equal(new Set([v1, v2].map((d) => d.document_id)).size, 2);
});

test("classification: method other than 'unknown' requires evidence", () => {
  assert.throws(
    () => buildLandUseFilingDocument(baseDocumentInput({ classification: { method: "title_token_plus_markers", evidence: [], confidence: "medium" } })),
    /classification.evidence/,
  );
});

test("classification: document_type and classification.method must agree on 'unknown'", () => {
  assert.throws(
    () => buildLandUseFilingDocument(baseDocumentInput({
      document_type: "unknown",
      classification: { method: "title_token_plus_markers", evidence: ["x"], confidence: "medium" },
    })),
    /document_type 'unknown'/,
  );
  assert.throws(
    () => buildLandUseFilingDocument(baseDocumentInput({
      document_type: "racial_equity_report",
      classification: { method: "unknown", confidence: "unknown" },
    })),
    /requires classification.method/,
  );
});

test("retrieval_status 'fetched' requires bytes_sha256 and byte_length", () => {
  assert.throws(
    () => buildLandUseFilingDocument(baseDocumentInput({ retrieval_status: "fetched" })),
    /requires bytes_sha256 and byte_length/,
  );
});

/* ------------------------------------------------------------------ */
/* Missing required fields                                             */
/* ------------------------------------------------------------------ */

test("missing IDs and dates throw on both obligation and document builders", () => {
  assert.throws(() => buildLandUseFilingObligation(baseObligationInput({ obligation_id: null })), /obligation_id/);
  assert.throws(() => buildLandUseFilingObligation(baseObligationInput({ observed_at: null })), /observed_at/);
  assert.throws(() => buildLandUseFilingObligation(baseObligationInput({ available_to_public_at: undefined })), /available_to_public_at/);
  assert.throws(() => buildLandUseFilingDocument(baseDocumentInput({ publisher_document_id: null })), /publisher_document_id/);
  assert.throws(() => buildLandUseFilingDocument(baseDocumentInput({ first_observed_at: null })), /first_observed_at/);
  assert.throws(() => buildLandUseFilingDocument(baseDocumentInput({ original_name: "" })), /original_name/);
});

/* ------------------------------------------------------------------ */
/* Racial Equity Report envelope                                       */
/* ------------------------------------------------------------------ */

function baseRerInput(overrides = {}) {
  const documentId = landUseFilingDocumentId({ project_ref: "project:2025Q0247", publisher_document_id: "artifact-abc123", first_observed_at: T0 });
  return {
    document_ref: documentId,
    project_ref: "project:2025Q0247",
    applicant: "Example Applicant LLC",
    preparer: { name: "Example Consultants", role: "consultant" },
    report_preparation_date: "2025-06-01",
    source_bytes_sha256: "c".repeat(64),
    extraction_version: "unextracted",
    extraction_quality: "not_applicable",
    ...overrides,
  };
}

test("racial equity report envelope builds with required identity fields only", () => {
  const rer = buildRacialEquityReportEnvelope(baseRerInput());
  assert.equal(rer.schema, RACIAL_EQUITY_REPORT_SCHEMA);
  assert.equal(rer.applicant.name, "Example Applicant LLC");
  assert.equal(rer.preparer.role, "consultant");
  assert.equal(rer.residential, null, "LDP-23 does not populate report contents");
});

test("racial equity report envelope rejects a document_ref that is not a land_use_filing_document id", () => {
  assert.throws(() => buildRacialEquityReportEnvelope(baseRerInput({ document_ref: "some-other-thing:123" })), /document_ref/);
});

test("racial equity report envelope forbids CEQR-subtype keys", () => {
  for (const key of ["ceqr_ref", "is_ceqr", "seqra_ref", "ceqr_document_link", "environmental_review_ref"]) {
    assert.throws(
      () => buildRacialEquityReportEnvelope(baseRerInput({ [key]: "anything" })),
      /CEQR\/SEQRA subtype/,
      `${key} must be rejected`,
    );
  }
});

test("racial equity report displacement_risk.interpretation must stay contextual_not_project_prediction", () => {
  assert.throws(
    () => buildRacialEquityReportEnvelope(baseRerInput({ displacement_risk: { category: "moderate", interpretation: "predicts_this_project" } })),
    /displacement_risk\.interpretation/,
  );
  const rer = buildRacialEquityReportEnvelope(baseRerInput({ displacement_risk: { category: "moderate", interpretation: DRI_INTERPRETATION } }));
  assert.equal(rer.displacement_risk.interpretation, DRI_INTERPRETATION);
});

/* ------------------------------------------------------------------ */
/* Relations                                                           */
/* ------------------------------------------------------------------ */

test("every commissioned relation builds with accepted status and real source evidence", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput());
  const doc = buildLandUseFilingDocument(baseDocumentInput());
  const doc2 = buildLandUseFilingDocument(baseDocumentInput({ publisher_document_id: "artifact-def456" }));
  const sourceObservation = { source_system: "zap-api", source_record_id: "2025Q0247", source_field: "included[].attributes.documents[].name", source_value: "Racial Equity Report.pdf" };

  const cases = [
    { relation: "has_filing_obligation", from: "project:2025Q0247", to: obligation.obligation_id },
    { relation: "filed_for_project", from: doc.document_id, to: "project:2025Q0247" },
    { relation: "satisfies_obligation", from: doc.document_id, to: obligation.obligation_id },
    { relation: "published_as_evidence", from: doc.document_id, to: obligation.obligation_id },
    { relation: "supersedes_document", from: doc2.document_id, to: doc.document_id },
  ];
  for (const { relation, from, to } of cases) {
    const edge = buildLandUseFilingRelation({ relation, from, to, source_observation: sourceObservation, observed_at: T0, confidence: "high" });
    assert.equal(edge.relation, relation);
    assert.equal(edge.status, "accepted");
    assert.equal(edge.from, from);
    assert.equal(edge.to, to);
    assert.equal(validateLandUseFilingRelation(edge), true);
  }
});

test("accepted relation status requires real source evidence, not filename similarity alone", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput());
  const doc = buildLandUseFilingDocument(baseDocumentInput());
  assert.throws(
    () => buildLandUseFilingRelation({ relation: "satisfies_obligation", from: doc.document_id, to: obligation.obligation_id, observed_at: T0 }),
    /source_observation/,
  );
  assert.throws(
    () => buildLandUseFilingRelation({
      relation: "satisfies_obligation",
      from: doc.document_id,
      to: obligation.obligation_id,
      source_observation: { source_field: "", source_value: "" },
      observed_at: T0,
    }),
    /source_observation/,
  );
});

test("relation endpoints must match the relation's declared ref kind", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput());
  const sourceObservation = { source_field: "x", source_value: "y" };
  assert.throws(
    () => buildLandUseFilingRelation({
      relation: "has_filing_obligation",
      from: obligation.obligation_id, // wrong kind: should be a project ref
      to: obligation.obligation_id,
      source_observation: sourceObservation,
      observed_at: T0,
    }),
    /from must be a project ref/,
  );
});

test("an unknown relation name is rejected", () => {
  assert.throws(() => buildLandUseFilingRelation({ relation: "endorses_obligation", from: "project:x", to: "project:y", observed_at: T0 }), /unknown land-use filing relation/);
});

/* ------------------------------------------------------------------ */
/* Round-trip validators (compatibility)                               */
/* ------------------------------------------------------------------ */

test("validate* functions round-trip a built record without throwing", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput());
  const doc = buildLandUseFilingDocument(baseDocumentInput());
  const rer = buildRacialEquityReportEnvelope(baseRerInput());
  assert.equal(validateLandUseFilingObligation(obligation), true);
  assert.equal(validateLandUseFilingDocument(doc), true);
  assert.equal(validateRacialEquityReportEnvelope(rer), true);
});

test("validate* functions reject a record with the wrong schema string", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput());
  assert.throws(() => buildLandUseFilingObligation({ ...obligation, schema: "cityscroll.something_else.v1" }));
});

/* ------------------------------------------------------------------ */
/* Negative rules: forbidden synonyms, no WRP, no statutory derivation */
/* ------------------------------------------------------------------ */

test("no enum this module exports ever equals a forbidden filing-observation synonym", () => {
  const enums = [
    ...FILING_APPLICABILITY_STATES,
    ...FILING_FULFILLMENT_STATES,
    ...FILING_DOCUMENT_TYPES,
  ];
  for (const value of enums) {
    for (const word of FORBIDDEN_FILING_OBSERVATION_SYNONYMS) {
      assert.notEqual(value, word, `enum value ${JSON.stringify(value)} collides with forbidden synonym`);
    }
  }
  for (const word of FORBIDDEN_FILING_OBSERVATION_SYNONYMS) {
    assert.throws(() => assertNoForbiddenFilingObservationSynonym(`the report was ${word}`, "test"), new RegExp(word));
  }
  assert.doesNotThrow(() => assertNoForbiddenFilingObservationSynonym("document observed", "test"));
});

test("the module source carries no WRP ontology, type, relation, or claim", () => {
  const source = readFileSync(new URL("../ontology/land_use_filing.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bwrp\b/i);
  assert.doesNotMatch(source, /worker\s+retention\s+plan/i);
});

test("the module source performs no statutory-criteria derivation (no action-code or FAR threshold table)", () => {
  const source = readFileSync(new URL("../ontology/land_use_filing.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RER_CRITERIA_ACTION_CODES/, "must not re-implement LDP-22's sampling-frame action codes as an applicability engine");
  assert.doesNotMatch(source, /max_far|zoning.?district.?table|square.?foot(age)?.?delta/i, "no zoning/FAR threshold table");
  assert.doesNotMatch(source, /function\s+derive\w*(Applicab|Threshold)/i, "no derivation function computing applicability from project facts");
});

test("obligation carries no shortcut boolean synonym for RER-required", () => {
  const obligation = buildLandUseFilingObligation(baseObligationInput());
  const keys = Object.keys(obligation);
  for (const forbidden of ["required", "rer_required", "is_required", "compliant"]) {
    assert.ok(!keys.includes(forbidden), `obligation must not carry a top-level "${forbidden}" key`);
  }
});
