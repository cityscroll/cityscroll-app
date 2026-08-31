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
  ABOUT_PROJECT_INVERSE,
  ABOUT_PROJECT_READER_LABEL,
  ABOUT_PROJECT_RELATION,
  DECIDES_LAND_PROJECT_COMPATIBILITY,
  EXACT_KEY_EDGE_TIER,
  LAND_PROJECT_DECISION_RELATION_SCHEMA,
  LAND_PROJECT_RELATION_VOCABULARY,
  aboutProjectReaderProjection,
  adaptDecidesLandProjectEdge,
  classifyLandDispositionRelation,
  classifyLandRecommendationRelation,
  classifyMeetingLandProjectRelation,
  documentedDecisionFromDisposition,
  materializeExactNoticeProjectEdge,
} from "../site/land_project_decision_relations.mjs";
import {
  MEETING_LAND_ULURP_METHOD,
  MEETING_LAND_ZAP_METHOD,
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
  assert.equal(vocab.about_project.inverse, ABOUT_PROJECT_INVERSE);
  assert.equal(vocab.about_project.reader_label, ABOUT_PROJECT_READER_LABEL);
  for (const id of ["about_project", "reviews_project", "issues_recommendation", "project_disposition"]) {
    assert.ok(vocab[id].inverse);
    assert.ok(vocab[id].domain);
    assert.ok(
      vocab[id].required_evidence.includes("source_record")
        || vocab[id].required_evidence.includes("source_record_id"),
      id,
    );
  }
  assert.ok(vocab.reviews_project.required_evidence.includes("semantic_threshold"));
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
  assert.equal(meetings.items[0].canonical_relation, ABOUT_PROJECT_RELATION);
  assert.equal(meetings.items[0].proceeding_relation, "reviews_project");
  assert.equal(meetings.items[0].is_decision, false);
  assert.equal(meetings.items[0].reader_label, ABOUT_PROJECT_READER_LABEL);
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
  assert.equal(
    result.evidence.projections["docs/evidence/land-decision-path/about-project-edge.json"]
      .represented_card_ids.includes("cityscroll-land-decision-path/ldp-07-exact-notice-project-edge"),
    true,
  );
  assert.equal(audit.schema, "cityscroll.land_project_decision_relation.audit.v1");
  assert.equal(LAND_PROJECT_DECISION_RELATION_SCHEMA, "cityscroll.land_project_decision_relation.v1");
});

const gold = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/land_project_about_project/gold.v1.json"), "utf8"),
);
const aboutReceipt = JSON.parse(
  readFileSync(join(ROOT, "docs/evidence/land-decision-path/about-project-edge.json"), "utf8"),
);

function goldEvidence(caseRow) {
  const notice = caseRow.notice;
  const hearing = observationFromMeetingsRow(notice);
  const land = observationFromLandRow(caseRow.project);
  const join = joinMeetingsToLandProjects([hearing], [land]);
  const compatibility = join.links.find((link) => link.type === DECIDES_LAND_PROJECT_COMPATIBILITY);
  const about = join.links.find((link) => link.type === ABOUT_PROJECT_RELATION);
  return { hearing, land, join, compatibility, about };
}

test("A1 notice 20260603044 reaches 2023X0149 through about_project with source proof", () => {
  const specimen = gold.positive.find((row) => row.id === "exact-ulurp-20260603044");
  const { join, compatibility, about } = goldEvidence(specimen);
  assert.ok(compatibility, "compatibility decides_land_project remains");
  assert.ok(about, "canonical about_project is materialized");
  assert.equal(about.from, "notice:20260603044");
  assert.equal(about.to, "project:2023X0149");
  assert.equal(about.method, MEETING_LAND_ULURP_METHOD);
  assert.equal(about.tier, EXACT_KEY_EDGE_TIER);
  assert.equal(about.provenance.join_value, "240206ZMX");
  assert.deepEqual(about.provenance.source_fields, ["body", "ulurp_numbers"]);
  assert.equal(about.is_decision, false);
  assert.equal(about.inverse, ABOUT_PROJECT_INVERSE);
  assert.equal(about.reader_label, ABOUT_PROJECT_READER_LABEL);

  const material = materializeExactNoticeProjectEdge({
    ...exactEvidence({
      from: "notice:20260603044",
      source_record: "city_record:20260603044",
      observed_time: specimen.notice.event_date,
      agency_name: specimen.notice.agency_name,
      label: specimen.notice.short_title,
      type_of_notice_description: specimen.notice.type_of_notice_description,
      source_system: "city_record",
      source_url: specimen.notice.source_url,
    }),
  });
  assert.equal(material.accepted, true);
  assert.equal(material.canonical_relation, ABOUT_PROJECT_RELATION);
  assert.equal(material.compatibility_relation, DECIDES_LAND_PROJECT_COMPATIBILITY);
  assert.equal(material.is_decision, false);
  assert.notEqual(material.canonical_relation, "issues_recommendation");
  assert.notEqual(material.canonical_relation, "project_disposition");
  const reader = aboutProjectReaderProjection(material);
  assert.equal(reader.visible, true);
  assert.equal(reader.href, "#land/2023X0149");
  assert.equal(reader.proof.identifier, "240206ZMX");
  assert.equal(reader.proof.source_system, "city_record");
  assert.equal(reader.proof.source_url, specimen.notice.source_url);
  assert.equal(join.by_notice["20260603044"].status, "matched");
  assert.equal(aboutReceipt.specimen.notice_id, "20260603044");
  assert.equal(aboutReceipt.specimen.project_id, "2023X0149");
});

test("exact ZAP URL fixture materializes about_project with full provenance", () => {
  const specimen = gold.positive.find((row) => row.id === "exact-zap-url");
  const { about, compatibility } = goldEvidence(specimen);
  assert.ok(compatibility);
  assert.ok(about);
  assert.equal(about.method, MEETING_LAND_ZAP_METHOD);
  assert.equal(about.to, "project:2023X0149");
  assert.equal(about.provenance.join_key, "project_id");
  assert.equal(about.is_decision, false);
});

test("A2 subject edge never labels a recommendation or decision", () => {
  const material = materializeExactNoticeProjectEdge(exactEvidence({
    from: "notice:20260603044",
    source_record: "city_record:20260603044",
    source_system: "city_record",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260603044",
    agency_name: "Community Boards",
    label: "JUNE 9, 2026 PUBLIC HEARING",
    type_of_notice_description: "Public Hearings",
    observed_time: "2026-06-09T18:30:00.000",
  }));
  assert.equal(material.accepted, true);
  assert.equal(material.canonical_relation, ABOUT_PROJECT_RELATION);
  assert.equal(material.canonical_edge.type, ABOUT_PROJECT_RELATION);
  assert.equal(material.compatibility_edge.type, DECIDES_LAND_PROJECT_COMPATIBILITY);
  assert.match(material.reader_label, /about this project/i);
  assert.doesNotMatch(material.reader_label, /recommend|decid/i);
  assert.equal(material.is_decision, false);
});

test("A4 unknown, ambiguous, title, address, date, draft, and missing-project stop unresolved", () => {
  const base = exactEvidence({
    from: "notice:20260603044",
    source_record: "city_record:20260603044",
    source_system: "city_record",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260603044",
  });
  for (const row of gold.negative) {
    const result = materializeExactNoticeProjectEdge({
      ...base,
      ...row,
      from: row.from === "" ? "" : base.from,
      to: row.from === "" ? "" : base.to,
      project_id: row.project_id === "" ? "" : base.project_id,
    });
    assert.equal(result.accepted, false, row.id);
    assert.equal(result.canonical_edge, null, row.id);
    assert.equal(result.unresolved.status, "unresolved", row.id);
    assert.equal(result.unresolved.inspectable, true, row.id);
    assert.equal(result.unresolved.reason, row.reason, row.id);
    const reader = aboutProjectReaderProjection(result);
    assert.equal(reader.visible, false, row.id);
    assert.equal(reader.href, null, row.id);
  }
});
