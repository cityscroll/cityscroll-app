/**
 * Audited land-project relation split.
 *
 *   node --test test/land_project_decision_relations.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DECIDES_LAND_PROJECT_COMPATIBILITY,
  EXACT_KEY_EDGE_TIER,
  LAND_PROJECT_DECISION_RELATION_SCHEMA,
  LAND_PROJECT_RELATION_VOCABULARY,
  adaptDecidesLandProjectEdge,
  classifyLandDispositionRelation,
  classifyLandRecommendationRelation,
  classifyMeetingLandProjectRelation,
  documentedDecisionFromDisposition,
} from "../site/land_project_decision_relations.mjs";
import {
  MEETING_LAND_ULURP_METHOD,
  joinMeetingsToLandProjects,
  observationFromLandRow,
  observationFromMeetingsRow,
} from "../entity_resolution/cross_domain/object_links.mjs";
import { buildProjectConnectionEvidence } from "../site/project_connections.mjs";
import { loadOntologyRegistry } from "../ontology/index.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const audit = JSON.parse(
  readFileSync(join(ROOT, "docs/evidence/land-decision-path/decides-land-project-audit.json"), "utf8"),
);
const landDefault = JSON.parse(readFileSync(join(ROOT, "site/data/land_default_ulurp.json"), "utf8"));

const HEARING_2023X0149 = Object.freeze({
  request_id: "20260608005",
  agency_name: "Borough President - Bronx",
  short_title: "Public Hearing Notice - Sojourner Truth-Mapes Rezoning - Bronx Borough Presidents Office",
  event_date: "2026-06-15T12:00:00.000",
  type_of_notice_description: "Public Hearings",
  additional_description_1:
    "IN THE MATTER OF Uniform Land Use Review Procedure applications #240206ZMX and #N240207ZRX.",
});

const PROJECT_2023X0149 = Object.freeze({
  project_id: "2023X0149",
  project_name: "Sojourner Truth-Mapes Rezoning",
  primary_applicant: "Applicant",
  ulurp_numbers: "240206ZMX; N240207ZRX",
});

function exactEvidence(overrides = {}) {
  return {
    from: "notice:20260608005",
    to: "project:2023X0149",
    project_id: "2023X0149",
    agency_name: "Borough President - Bronx",
    label: HEARING_2023X0149.short_title,
    type_of_notice_description: "Public Hearings",
    method: MEETING_LAND_ULURP_METHOD,
    method_version: "1",
    source_record: "city_record:20260608005",
    source_fields: ["body", "ulurp_numbers"],
    join_key: "ulurp_number",
    join_value: "240206ZMX",
    observed_time: "2026-06-15T12:00:00.000",
    tier: EXACT_KEY_EDGE_TIER,
    ...overrides,
  };
}

test("canonical vocabulary distinguishes concern, review, recommendation, and decision", () => {
  const vocab = LAND_PROJECT_RELATION_VOCABULARY;
  assert.equal(vocab.about_project.family, "concern");
  assert.equal(vocab.reviews_project.family, "review");
  assert.equal(vocab.issues_recommendation.family, "recommendation");
  assert.equal(vocab.project_disposition.family, "decision");
  assert.equal(vocab.adopts.family, "decision");
  assert.equal(vocab.rejects.family, "decision");
  assert.equal(vocab.decides_land_project.family, "compatibility");
  assert.equal(vocab.about_project.is_decision, false);
  assert.equal(vocab.reviews_project.is_decision, false);
  assert.equal(vocab.issues_recommendation.is_decision, false);
  assert.equal(vocab.project_disposition.is_decision, true);
  assert.equal(vocab.about_project.semantic_threshold, "exact_project_or_application_or_ulurp_reference");
  assert.equal(vocab.issues_recommendation.semantic_threshold, "documentary_recommendation_evidence");
  assert.equal(vocab.project_disposition.semantic_threshold, "explicit_authoritative_disposition");
  for (const id of ["about_project", "reviews_project", "issues_recommendation", "project_disposition"]) {
    assert.ok(vocab[id].inverse);
    assert.ok(vocab[id].domain);
    assert.ok(vocab[id].required_evidence.includes("source_record"));
    assert.ok(vocab[id].required_evidence.includes("semantic_threshold"));
  }
});

test("registry registers the split vocabulary with inverses and evidence thresholds", () => {
  const registry = loadOntologyRegistry();
  const links = new Map(registry.link_types.map((entry) => [entry.id, entry]));
  for (const id of ["about_project", "reviews_project", "decides_land_project", "project_disposition"]) {
    const entry = links.get(id);
    assert.ok(entry, id);
    assert.equal(entry.status, "registered", id);
    assert.ok(entry.inverse, id);
    assert.ok(entry.semantic_threshold, id);
    assert.ok(Array.isArray(entry.required_evidence) && entry.required_evidence.length >= 6, id);
    assert.match(entry.negative_rule, /never|not a documented|does not mean/i, id);
  }
  assert.deepEqual(links.get("decides_land_project").compatibility_for, [
    "about_project",
    "reviews_project",
  ]);
});

test("A1 hearing 2023X0149 is an exact project-related proceeding, not a decision", () => {
  const hearing = observationFromMeetingsRow(HEARING_2023X0149);
  const land = observationFromLandRow(PROJECT_2023X0149);
  const join = joinMeetingsToLandProjects([hearing], [land]);
  const edge = join.links.find((link) => link.type === DECIDES_LAND_PROJECT_COMPATIBILITY);
  assert.ok(edge, "compatibility join remains for existing consumers");
  assert.equal(edge.to, "project:2023X0149");
  assert.equal(edge.method, MEETING_LAND_ULURP_METHOD);
  assert.equal(edge.tier, EXACT_KEY_EDGE_TIER);
  assert.equal(edge.provenance.join_key, "ulurp_number");
  assert.equal(edge.provenance.join_value, "240206ZMX");
  assert.deepEqual(edge.provenance.source_fields, ["body", "ulurp_numbers"]);

  const adapted = adaptDecidesLandProjectEdge(edge, {
    agency_name: HEARING_2023X0149.agency_name,
    label: HEARING_2023X0149.short_title,
    type_of_notice_description: HEARING_2023X0149.type_of_notice_description,
    observed_time: HEARING_2023X0149.event_date,
  });
  assert.equal(adapted.type, DECIDES_LAND_PROJECT_COMPATIBILITY);
  assert.equal(adapted.canonical_relation, "reviews_project");
  assert.equal(adapted.is_decision, false);
  assert.equal(adapted.reader_label, "Hearing that reviews this project");
  assert.notEqual(adapted.canonical_relation, "project_disposition");
  assert.equal(documentedDecisionFromDisposition({ status: "Draft" }), null);

  const connections = buildProjectConnectionEvidence({
    projectId: "2023X0149",
    projectRows: [PROJECT_2023X0149],
    graphLinks: [{
      type: DECIDES_LAND_PROJECT_COMPATIBILITY,
      from: "notice:20260608005",
      to: "project:2023X0149",
      confidence: "strong",
      method: MEETING_LAND_ULURP_METHOD,
      method_version: "1",
      label: HEARING_2023X0149.short_title,
      agency_name: HEARING_2023X0149.agency_name,
      when: HEARING_2023X0149.event_date,
      provenance: edge.provenance,
    }],
  });
  const meetings = connections.groups.find((group) => group.id === "meetings");
  const decisions = connections.groups.find((group) => group.id === "decisions");
  assert.equal(meetings.items[0].relation, DECIDES_LAND_PROJECT_COMPATIBILITY);
  assert.equal(meetings.items[0].canonical_relation, "reviews_project");
  assert.equal(meetings.items[0].is_decision, false);
  assert.match(meetings.items[0].reader_label, /project-related proceeding|reviews this project/i);
  assert.equal(decisions.items.length, 0);
  assert.equal(audit.specimens.hearing_2023X0149.project_id, "2023X0149");
});

test("A4 draft 2025K0305 CB11/CB13/Borough Board rows are not decisions", () => {
  const outcome = landDefault.outcomes.by_project["2025K0305"];
  assert.ok(outcome);
  const drafts = outcome.dispositions.filter((row) => row.status === "Draft");
  assert.ok(drafts.length >= 3);
  assert.ok(drafts.some((row) => /CB11/.test(row.name)));
  assert.ok(drafts.some((row) => /CB13/.test(row.name)));
  assert.ok(drafts.some((row) => /Borough Board|BP/.test(row.representing + row.name)));
  for (const row of drafts) {
    const classified = classifyLandDispositionRelation({
      disposition: row,
      project_id: "2025K0305",
    });
    assert.equal(classified.accepted, false, row.name);
    assert.equal(classified.reason, "draft_only");
    assert.equal(classified.is_decision, false);
    assert.equal(documentedDecisionFromDisposition(row, { project_id: "2025K0305" }), null);
  }
  const connections = buildProjectConnectionEvidence({
    projectId: "2025K0305",
    projectRows: [{ project_id: "2025K0305", project_name: "2025K0305" }],
    outcome,
  });
  const decisions = connections.groups.find((group) => group.id === "decisions");
  assert.equal(decisions.items.some((item) => item.is_decision), false);
  assert.equal(decisions.items.length, 0);
});

test("unknown, fuzzy, missing-identifier, and meeting-only inputs stay non-decisional", () => {
  assert.equal(classifyMeetingLandProjectRelation(exactEvidence({ unknown: true })).accepted, false);
  assert.equal(classifyMeetingLandProjectRelation(exactEvidence({ fuzzy: true })).accepted, false);
  assert.equal(classifyMeetingLandProjectRelation(exactEvidence({ from: "", project_id: "" })).reason, "missing_identifier");
  assert.equal(classifyMeetingLandProjectRelation(exactEvidence({ join_value: "" })).reason, "missing_exact_join");
  assert.equal(
    classifyLandRecommendationRelation(exactEvidence({ document_url: "" })).reason,
    "missing_recommendation_document",
  );
  const meetingOnly = classifyMeetingLandProjectRelation(exactEvidence());
  assert.equal(meetingOnly.accepted, true);
  assert.equal(meetingOnly.is_decision, false);
  assert.equal(meetingOnly.compatibility_relation, DECIDES_LAND_PROJECT_COMPATIBILITY);
});

test("documented Conditional Favorable remains a decision; pending dated rows stay calendar-only", () => {
  const documented = classifyLandDispositionRelation({
    disposition: {
      id: "cb-11-vote",
      representing: "Community Board",
      community_board: "Conditional Favorable",
      vote_date: "2023-10-24",
    },
    project_id: "2022M0258",
  });
  assert.equal(documented.accepted, true);
  assert.equal(documented.is_decision, true);
  assert.equal(documented.canonical_relation, "project_disposition");

  const pending = classifyLandDispositionRelation({
    disposition: {
      id: "future-vote",
      representing: "Community Board",
      community_board: "Pending",
      vote_date: "2026-09-22",
    },
    project_id: "2022M0258",
  });
  assert.equal(pending.accepted, true);
  assert.equal(pending.is_decision, false);
  assert.equal(pending.canonical_relation, "reviews_project");
  assert.equal(pending.compatibility_relation, "project_disposition");
});

test("architecture-evidence projections reconcile the audit card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["docs/evidence/land-decision-path/decides-land-project-audit.json"]
      .represented_card_ids.includes("cityscroll-land-decision-path/ldp-06-decides-land-project-audit"),
    true,
  );
  assert.equal(audit.schema, "cityscroll.land_project_decision_relation.audit.v1");
  assert.equal(LAND_PROJECT_DECISION_RELATION_SCHEMA, "cityscroll.land_project_decision_relation.v1");
});
