import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEntityIdentityReportTarget,
  buildEntityProfileReportTarget,
  hasIdentityComparisonCandidates,
  renderReportIssueAffordance,
} from "../site/report_issue.mjs";
import { buildReportTarget } from "../site/report_target.mjs";
import { buildPeopleOrganizationsReadModel } from "../site/people_organizations_read_model.mjs";
import { validateFeedback } from "../worker/src/lib/feedback.mjs";

const profiles = Object.freeze({
  person: Object.freeze({
    entity_ref: "entity:official:7801",
    canonical_url: "/officials/7801/",
    object_label: "Christopher Marte",
  }),
  organization: Object.freeze({
    entity_ref: "agency:id:parks-and-recreation",
    canonical_url: "/agencies/parks-and-recreation/",
    object_label: "Parks and Recreation",
  }),
});

function identityReport(intent, other, category, evidence) {
  const source = buildEntityProfileReportTarget(profiles.person);
  return {
    source,
    target: buildEntityIdentityReportTarget({
      source_target: source,
      other_entity_ref: profiles[other].entity_ref,
      other_entity_label: profiles[other].object_label,
      identity_intent: intent,
    }),
    category,
    evidence,
  };
}

test("merge hypothesis keeps both existing profile ids and intent without changing profiles", () => {
  const originalProfiles = JSON.stringify(profiles);
  const report = identityReport(
    "same_entity",
    "organization",
    "same_thing",
    "The appointment record and agency biography use the same published office history.",
  );

  assert.equal(report.target.claim_anchor.subject_id, profiles.person.entity_ref);
  assert.equal(report.target.claim_anchor.object_id, profiles.organization.entity_ref);
  assert.equal(report.target.claim_anchor.identity_intent, "same_entity");
  assert.equal(report.target.description, "Christopher Marte and Parks and Recreation are reported as the same person or organization");
  assert.deepEqual(validateFeedback({
    category: report.category,
    message: "These profiles should be reviewed as the same civic entity.",
    evidence: report.evidence,
    report_target: report.target,
  }).value.report_target.claim_anchor, report.target.claim_anchor);
  assert.equal(JSON.stringify(profiles), originalProfiles);
});

test("split hypothesis is independently inspectable and never mutates the source profile", () => {
  const original = { ...profiles.person };
  const report = identityReport(
    "different_entities",
    "organization",
    "different_things",
    "The public source identifies a department, while the profile subject is an elected official.",
  );

  assert.equal(report.target.claim_anchor.subject_id, profiles.person.entity_ref);
  assert.equal(report.target.claim_anchor.object_id, profiles.organization.entity_ref);
  assert.equal(report.target.claim_anchor.identity_intent, "different_entities");
  assert.match(report.target.description, /different people or organizations/);
  assert.equal(validateFeedback({
    category: report.category,
    message: "These profiles describe distinct people or organizations.",
    evidence: report.evidence,
    report_target: report.target,
  }).ok, true);
  assert.deepEqual(profiles.person, original);
});

test("profile affordance keeps the picker when comparison context has candidates", () => {
  const target = buildEntityProfileReportTarget({
    ...profiles.person,
    identity_candidates: [{
      ...profiles.organization,
      entity_id: profiles.organization.entity_ref,
      kind: "agency",
      href: profiles.organization.canonical_url,
      label: profiles.organization.object_label,
    }],
  });
  const html = renderReportIssueAffordance(target);
  assert.match(html, /data-report-target=/);
  assert.equal(target.claim_anchor.claim_type, "identity");
  assert.equal(hasIdentityComparisonCandidates(target), true);
  assert.match(JSON.stringify(target), /identity_candidates/);
  assert.match(JSON.stringify(target), /parks-and-recreation/);
});

test("generic object reports have no comparison picker context", () => {
  const profileWithoutCandidates = buildEntityProfileReportTarget(profiles.person);
  assert.equal(hasIdentityComparisonCandidates(profileWithoutCandidates), false);
  const target = buildReportTarget({
    object_type: "entity",
    object_id: profiles.person.entity_ref,
    canonical_url: profiles.person.canonical_url,
    object_label: profiles.person.object_label,
  });
  assert.equal(hasIdentityComparisonCandidates(target), false);
  assert.equal(validateFeedback({
    category: "information_wrong",
    message: "The current profile contains an incorrect fact.",
    report_target: target,
  }).ok, true);
});

test("lookup keeps ambiguous names as separate selectable profiles", () => {
  const model = buildPeopleOrganizationsReadModel({
    people: {
      by_person_id: {
        "101": { person_id: "101", person_name: "Alex Morgan" },
        "202": { person_id: "202", person_name: "Alex Morgan" },
      },
    },
  });
  const matches = model.identity_candidates.filter((candidate) => candidate.label === "Alex Morgan");
  assert.deepEqual(matches.map((candidate) => candidate.entity_id), [
    "entity:official:101",
    "entity:official:202",
  ]);
  assert.notEqual(matches[0].href, matches[1].href);
});
