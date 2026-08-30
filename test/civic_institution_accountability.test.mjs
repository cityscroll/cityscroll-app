import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadOntologyRegistry } from "../ontology/index.mjs";
import {
  CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA,
  CIVIC_INSTITUTION_ROLE_RELATIONS,
  buildCivicInstitutionRoleEdge,
} from "../ontology/civic_institution.mjs";
import { renderAgencyIdentitySection } from "../site/agency_identity_evidence.mjs";
import {
  BOC_CANONICAL_ID,
  COUNCIL_CANONICAL_ID,
  DOC_ACCOUNTABILITY_OBLIGATION_ID,
  DOC_CANONICAL_ID,
  accountabilityRolesForInstitution,
  extractExplicitReportRecipients,
  findDocAccountabilityObligation,
  isOversightInferenceForbidden,
  resolveDocAccountabilityRoles,
} from "../site/civic_institution_accountability.mjs";
import {
  AGENCY_CONSTELLATION_CATEGORIES,
  buildAgencyConstellationView,
} from "../site/agency_constellation.mjs";
import { claimInspectHref } from "../site/graph_edge_provenance.mjs";
import { buildAgencyIdentityEvidence } from "../tools/lib/agency_identity_evidence.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(
  readFileSync(new URL("./fixtures/civic_institution_accountability/cases.json", import.meta.url), "utf8"),
);
const LOOKUP_PATH = join(ROOT, "site/data/agency_obligations_lookup.json");
const lookup = existsSync(LOOKUP_PATH)
  ? JSON.parse(readFileSync(LOOKUP_PATH, "utf8"))
  : null;
const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
const certification = JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"));
const staffingExams = JSON.parse(readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"));

function profileHtml(canonicalId, displayName, sources) {
  const evidence = buildAgencyIdentityEvidence({
    identity: { canonical_id: canonicalId, canonical_name: displayName },
    publisherRow: {
      canonical_name: displayName,
      org_type: "Mayoral Agency",
      match_method: "normalized",
      variants: [displayName],
    },
    view: { path: `/agencies/${canonicalId}/`, categories: [] },
    generatedAt: "2020-01-01T00:00:00.000Z",
    accountabilitySources: sources,
  });
  return {
    evidence,
    html: renderAgencyIdentitySection({
      path: `/agencies/${canonicalId}/`,
      display_name: displayName,
      identity_evidence: evidence,
    }),
  };
}

test("registry registers the duty-bearer relation beside must_report_to", () => {
  const registry = loadOntologyRegistry();
  const ids = new Map(registry.link_types.map((row) => [row.id, row]));
  assert.equal(ids.get("duty_bearer").from, "mandate");
  assert.equal(ids.get("duty_bearer").to, "civic-institution");
  assert.equal(ids.get("duty_bearer").inverse, "holds_duty");
  assert.equal(ids.get("must_report_to").inverse, "receives_report_from");
  assert.equal(CIVIC_INSTITUTION_ROLE_RELATIONS.duty_bearer.from_kind, "obligation");
  assert.match(ids.get("duty_bearer").negative_rule, /generic DOC obligation/);
});

test("exact obligation 63842-001 mints duty-bearer and two report-recipient edges", () => {
  const retained = findDocAccountabilityObligation(lookup);
  assert.equal(retained.obligation_id, DOC_ACCOUNTABILITY_OBLIGATION_ID);
  assert.equal(retained.agency_id, DOC_CANONICAL_ID);
  assert.equal(retained.certification.quote_verified, true);
  const resolved = resolveDocAccountabilityRoles({ lookup });
  const duty = resolved.accepted.find((edge) => edge.relation_id === "duty_bearer");
  const council = resolved.accepted.find((edge) => (
    edge.relation_id === "must_report_to" && edge.object_canonical_id === COUNCIL_CANONICAL_ID
  ));
  const board = resolved.accepted.find((edge) => (
    edge.relation_id === "must_report_to" && edge.object_canonical_id === BOC_CANONICAL_ID
  ));
  assert.equal(duty.status, "accepted");
  assert.equal(duty.schema, CIVIC_INSTITUTION_ROLE_EDGE_SCHEMA);
  assert.equal(duty.from, `obligation:${DOC_ACCOUNTABILITY_OBLIGATION_ID}`);
  assert.equal(duty.to, `civic-institution:${DOC_CANONICAL_ID}`);
  assert.equal(duty.href, `/agencies/${DOC_CANONICAL_ID}/`);
  assert.equal(duty.mandate_href, `/mandates/${DOC_ACCOUNTABILITY_OBLIGATION_ID}`);
  assert.equal(council.to, `civic-institution:${COUNCIL_CANONICAL_ID}`);
  assert.equal(board.to, `civic-institution:${BOC_CANONICAL_ID}`);
  assert.equal(council.recipient_phrase, "to the council");
  assert.equal(board.recipient_phrase, "to the board of correction");
  assert.equal(council.citation, retained.citation);
  assert.equal(council.source_url, retained.source.legistar_url);
  assert.equal(council.quote_verified, true);
  assert.equal(council.duty_text, retained.duty_text);
  assert.ok(council.source_receipt);
  assert.equal(council.provenance.source_system, "legistar");
  assert.deepEqual(council.evidence_refs, [
    `obligation:${DOC_ACCOUNTABILITY_OBLIGATION_ID}`,
    "legistar:63842",
  ]);
  assert.equal(resolved.accepted.some((edge) => edge.relation_id === "oversees"), false);
  assert.equal(resolved.accepted.filter((edge) => edge.relation_id === "must_report_to").length, 2);
});

test("DOC and BOC profiles expose reciprocal Accountability links for the same duty", () => {
  const sources = { lookup };
  const doc = profileHtml(DOC_CANONICAL_ID, "Department of Correction", sources);
  const boc = profileHtml(BOC_CANONICAL_ID, "Board of Correction", sources);
  const council = accountabilityRolesForInstitution(COUNCIL_CANONICAL_ID, sources);
  assert.equal(doc.evidence.role_edges.some((edge) => edge.relation_id === "must_report_to"), true);
  assert.equal(doc.evidence.role_edges.some((edge) => edge.relation_id === "holds_duty"), true);
  assert.match(doc.html, /id="agency-institution-accountability"/);
  assert.match(doc.html, /data-accountability-obligation="63842-001"/);
  assert.match(doc.html, /href="\/mandates\/63842-001"/);
  assert.match(doc.html, /href="\/agencies\/board-of-correction\/"/);
  assert.match(doc.html, /href="\/agencies\/city-council\/"/);
  assert.match(doc.html, /to the board of correction/);
  assert.match(doc.html, /No broader oversight or governance edge is sourced/);
  assert.match(boc.html, /id="agency-institution-accountability"/);
  assert.match(boc.html, /data-accountability-obligation="63842-001"/);
  assert.match(boc.html, /data-role-relation="receives_report_from"/);
  assert.match(boc.html, /href="\/agencies\/correction\/"/);
  assert.match(boc.html, /data-accountability-recipient="city-council"/);
  assert.match(boc.html, /href="\/mandates\/63842-001"/);
  assert.equal(
    council.accepted.some((edge) => (
      edge.relation_id === "receives_report_from" && edge.object_canonical_id === DOC_CANONICAL_ID
    )),
    true,
  );
  assert.doesNotMatch(doc.html, /data-role-relation="oversees"|data-role-relation="governed_by"/);
  assert.doesNotMatch(boc.html, /data-role-relation="oversees"|data-role-relation="governed_by"/);
});

test("generic DOC duties, board language, meetings, and unverified quotes never mint oversight", () => {
  const generic = resolveDocAccountabilityRoles({
    obligations: [FIXTURES.generic_doc_website_obligation, FIXTURES.gold_obligation],
    meetings: [FIXTURES.boc_meeting],
  });
  assert.equal(generic.accepted.every((edge) => edge.obligation_id === DOC_ACCOUNTABILITY_OBLIGATION_ID), true);
  assert.equal(generic.accepted.some((edge) => edge.obligation_id === "63842-002"), false);

  const boardOnly = resolveDocAccountabilityRoles({ obligation: FIXTURES.generic_board_language });
  assert.equal(boardOnly.accepted.some((edge) => edge.relation_id === "must_report_to"), false);
  assert.equal(boardOnly.unresolved.some((edge) => edge.reason === "recipient_phrase_missing"), true);
  assert.equal(extractExplicitReportRecipients(FIXTURES.generic_board_language.duty_text).length, 0);

  const unverified = resolveDocAccountabilityRoles({ obligation: FIXTURES.unverified_quote });
  assert.equal(unverified.accepted.length, 0);
  assert.equal(unverified.unresolved.some((edge) => edge.reason === "quote_verification_incomplete"), true);

  const oversees = buildCivicInstitutionRoleEdge({
    subject: "civic-institution:board-of-correction",
    object: "civic-institution:correction",
    relation: "oversees",
    sourceObservation: {
      source_system: "legistar",
      source_record_id: "legistar:63842-001",
      source_record_ref: "source_record:legistar:63842-001",
      source_field: "duty_text",
      source_value: "report",
      observed_at: "2020-01-01T00:00:00.000Z",
    },
    evidenceRefs: ["obligation:63842-001"],
    method: "exact_source_identifier",
    confidence: "strong",
  });
  const governed = buildCivicInstitutionRoleEdge({
    subject: "civic-institution:correction",
    object: "civic-institution:board-of-correction",
    relation: "governed_by",
    sourceObservation: oversees.source_observation,
    evidenceRefs: ["obligation:63842-001"],
    method: "exact_source_identifier",
    confidence: "strong",
  });
  assert.equal(isOversightInferenceForbidden("oversees"), true);
  assert.equal(oversees.status, "held");
  assert.equal(oversees.reason, "unsupported_i2i_relation");
  assert.equal(oversees.linking, false);
  assert.equal(governed.status, "held");
  assert.equal(governed.linking, false);
});

test("mandate claim URLs, agency ids, statute_duty category, and citations stay unchanged", () => {
  const view = buildAgencyConstellationView(DOC_CANONICAL_ID, {
    intelligence,
    certification,
    staffing_exams: staffingExams,
    obligations: lookup,
  });
  assert.equal(view.subject_ref, "agency:id:correction");
  assert.equal(view.canonical_id, "correction");
  const mandates = view.categories.find((category) => category.id === "obligations");
  assert.equal(mandates.relation, "statute_duty");
  assert.equal(AGENCY_CONSTELLATION_CATEGORIES.find((row) => row.id === "obligations").relation, "statute_duty");
  const retained = findDocAccountabilityObligation(lookup);
  const bucketRow = lookup.by_agency.correction.obligations.find((row) => row.obligation_id === DOC_ACCOUNTABILITY_OBLIGATION_ID);
  assert.equal(bucketRow.citation, retained.citation);
  assert.equal(bucketRow.source.legistar_url, retained.source.legistar_url);
  assert.equal(bucketRow.agency_id, "correction");
  const sample = mandates.items[0];
  assert.ok(sample?.claim?.inspect_href);
  assert.match(sample.claim.inspect_href, /\/agencies\/correction\/\?claim=/);
  assert.equal(
    sample.claim.inspect_href,
    claimInspectHref(view.path, sample.claim.claim_id),
  );
  assert.match(mandates.view_all_href || "", /\/agencies\/correction\//);
  assert.ok(Number(mandates.count) >= mandates.items.length);
  assert.doesNotMatch(JSON.stringify(view.categories), /"relation":"oversees"/);
});
