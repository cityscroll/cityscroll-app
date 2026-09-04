/**
 * LDP-23: as-of projector for land-use filing obligations, documents, and
 * relations. No later clock may backfill an earlier one -- a fact is visible
 * at a cutoff only once its own public-availability clock has passed, and a
 * relation is visible only once both of its named endpoints are visible too.
 *
 * Verify: node --test test/land_filing_ontology.test.mjs test/land_filing_asof.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLandUseFilingDocument,
  buildLandUseFilingObligation,
  buildLandUseFilingRelation,
  landUseFilingDocumentId,
  landUseFilingObligationId,
  projectLandUseFilingAsOf,
  racialEquityReportGoverningAuthority,
  resolveCurrentFilingDocumentVersions,
} from "../ontology/land_use_filing.mjs";

const EARLY = "2026-01-01T00:00:00.000Z";
const MID = "2026-06-01T00:00:00.000Z";
const LATE = "2026-12-01T00:00:00.000Z";

const GOVERNING_AUTHORITY = [racialEquityReportGoverningAuthority()];

function obligation(overrides = {}) {
  return buildLandUseFilingObligation({
    obligation_id: landUseFilingObligationId({ project_ref: "project:2025Q0247", obligation_type: "racial_equity_report" }),
    project_ref: "project:2025Q0247",
    obligation_type: "racial_equity_report",
    governing_authority: GOVERNING_AUTHORITY,
    applicability: { state: "unknown" },
    fulfillment: { state: "not_checked" },
    observed_at: EARLY,
    available_to_public_at: EARLY,
    materialized_at: EARLY,
    source_id: "zap-api-outcomes",
    source_record_id: "2025Q0247",
    source_vintage: EARLY,
    normalization_version: "ldp23-v1",
    ...overrides,
  });
}

function document(overrides = {}) {
  return buildLandUseFilingDocument({
    project_ref: "project:2025Q0247",
    document_type: "racial_equity_report",
    publisher_document_id: "artifact-abc123",
    original_name: "Racial Equity Report.pdf",
    first_observed_at: EARLY,
    available_to_public_at: EARLY,
    retrieval_status: "not_attempted",
    classification: { method: "title_token_plus_markers", evidence: ["matched"], confidence: "medium" },
    ...overrides,
  });
}

test("an obligation is invisible before its available_to_public_at and visible after", () => {
  const o = obligation({ available_to_public_at: MID });
  const before = projectLandUseFilingAsOf({ obligations: [o], cutoff: EARLY });
  const after = projectLandUseFilingAsOf({ obligations: [o], cutoff: LATE });
  assert.equal(before.obligations.length, 0);
  assert.equal(after.obligations.length, 1);
  assert.equal(after.obligations[0].obligation_id, o.obligation_id);
});

test("a document is invisible before its available_to_public_at and visible after", () => {
  const d = document({ available_to_public_at: MID });
  const before = projectLandUseFilingAsOf({ documents: [d], cutoff: EARLY });
  const after = projectLandUseFilingAsOf({ documents: [d], cutoff: LATE });
  assert.equal(before.documents.length, 0);
  assert.equal(after.documents.length, 1);
});

test("no later clock backfills an earlier one: a version chain's current head reflects only what was visible at the cutoff", () => {
  const v1 = document({ first_observed_at: EARLY, available_to_public_at: EARLY });
  const v2 = document({
    first_observed_at: LATE,
    available_to_public_at: LATE,
    supersedes: v1.document_id,
    supersession_basis: "re-observed with a new hash",
  });

  const midCutoff = projectLandUseFilingAsOf({ documents: [v1, v2], cutoff: MID });
  assert.deepEqual(midCutoff.documents.map((d) => d.document_id), [v1.document_id], "v2 is not yet public at MID");
  const headsAtMid = resolveCurrentFilingDocumentVersions(midCutoff.documents);
  assert.deepEqual(headsAtMid.map((d) => d.document_id), [v1.document_id]);

  const lateCutoff = projectLandUseFilingAsOf({ documents: [v1, v2], cutoff: LATE });
  assert.equal(lateCutoff.documents.length, 2, "both versions remain individually inspectable once visible");
  const headsAtLate = resolveCurrentFilingDocumentVersions(lateCutoff.documents);
  assert.deepEqual(headsAtLate.map((d) => d.document_id), [v2.document_id]);
});

test("a relation is excluded until its own observed_at has passed, even if both endpoints are already visible", () => {
  const o = obligation({ available_to_public_at: EARLY });
  const d = document({ available_to_public_at: EARLY });
  const relation = buildLandUseFilingRelation({
    relation: "satisfies_obligation",
    from: d.document_id,
    to: o.obligation_id,
    source_observation: { source_field: "included[].attributes.documents[].name", source_value: "Racial Equity Report.pdf" },
    observed_at: LATE,
  });
  const mid = projectLandUseFilingAsOf({ obligations: [o], documents: [d], relations: [relation], cutoff: MID });
  assert.equal(mid.relations.length, 0);
  const late = projectLandUseFilingAsOf({ obligations: [o], documents: [d], relations: [relation], cutoff: LATE });
  assert.equal(late.relations.length, 1);
});

test("a relation is excluded when either named endpoint is not yet visible, even if the relation's own clock has passed", () => {
  const o = obligation({ available_to_public_at: LATE }); // obligation not yet public
  const d = document({ available_to_public_at: EARLY });
  const relation = buildLandUseFilingRelation({
    relation: "satisfies_obligation",
    from: d.document_id,
    to: o.obligation_id,
    source_observation: { source_field: "included[].attributes.documents[].name", source_value: "Racial Equity Report.pdf" },
    observed_at: EARLY,
  });
  const mid = projectLandUseFilingAsOf({ obligations: [o], documents: [d], relations: [relation], cutoff: MID });
  assert.equal(mid.relations.length, 0, "relation must not surface while its obligation endpoint is not yet public");
  const late = projectLandUseFilingAsOf({ obligations: [o], documents: [d], relations: [relation], cutoff: LATE });
  assert.equal(late.relations.length, 1);
});

test("a relation naming a project endpoint is not gated by any project-side clock", () => {
  const o = obligation({ available_to_public_at: EARLY });
  const relation = buildLandUseFilingRelation({
    relation: "has_filing_obligation",
    from: "project:2025Q0247",
    to: o.obligation_id,
    source_observation: { source_field: "project_id", source_value: "2025Q0247" },
    observed_at: EARLY,
  });
  const projected = projectLandUseFilingAsOf({ obligations: [o], relations: [relation], cutoff: EARLY });
  assert.equal(projected.relations.length, 1);
});

test("cutoff is required and must be a real timestamp", () => {
  assert.throws(() => projectLandUseFilingAsOf({ cutoff: "not-a-date" }), /cutoff/);
  assert.throws(() => projectLandUseFilingAsOf({}), /cutoff/);
});
