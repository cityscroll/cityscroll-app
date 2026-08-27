/**
 * CC-7: a bounded, fixture-backed correction round-trip pilot.
 *
 * This is deliberately not a production correction engine. It replays four
 * seeded assertions through the existing report target + /feedback validation
 * seam, records a human adjudication decision, and applies a correction only
 * to the named pilot fixture. The explicit scope prevents one passing fixture
 * from being represented as system-wide correctness.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildContractVendorRelationshipReportTarget,
  buildEntityIdentityReportTarget,
  buildEntityProfileReportTarget,
  buildMeetingGroupingReportTarget,
} from "../site/report_issue.mjs";
import { buildRelationshipReportTarget } from "../site/report_target.mjs";
import { validateFeedback } from "../worker/src/lib/feedback.mjs";

export const PILOT_SCHEMA = "cityscroll.correction_round_trip_pilot.v1";
export const PILOT_SCOPE = "seeded_fixture_pilot_only";
export const REPORT_ENDPOINT = "POST /feedback";

const OUTPUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/evidence/cc7-round-trip/pilot.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function identityCase() {
  const source = {
    entity_ref: "entity:official:cc7-1001",
    canonical_url: "/officials/cc7-1001/",
    object_label: "Jordan Lee",
  };
  const target = buildEntityIdentityReportTarget({
    source_target: buildEntityProfileReportTarget(source),
    other_entity_ref: "entity:official:cc7-1002",
    other_entity_label: "Jordan Lee (separate profile)",
    identity_intent: "same_entity",
    source: {
      source_system: "city_record_appointments_fixture",
      source_record_id: "cc7-identity-appointment-001",
      source_url: "fixture://cc7/identity-appointment-001",
    },
  });
  return {
    id: "CC7-IDENTITY-001",
    class: "wrong_identity",
    failure_origin: "entity_resolution",
    target,
    source_truth: {
      canonical_entity_ref: "entity:official:cc7-1001",
      displayed_profile: "Jordan Lee",
    },
    before_assertion: "CityScroll presents Jordan Lee's appointment under a separate profile from the matching public biography.",
    report_category: "same_thing",
    report_message: "These two profiles describe the same person; the appointment and biography share the same published office history.",
    report_evidence: "cc7-identity-biography-001 and cc7-identity-appointment-001 use the same office history and name.",
    adjudication: {
      verdict: "confirmed",
      evidence_reviewed: ["cc7-identity-biography-001", "cc7-identity-appointment-001"],
      rationale: "The two source records identify the same person, so the fixture's canonical profile reference is corrected.",
    },
    correction: {
      source: "pilot fixture identity link",
      path: "canonical_entity_ref",
      before: "entity:official:cc7-1001",
      after: "entity:official:cc7-1002",
    },
  };
}

function relationshipCase() {
  const target = buildContractVendorRelationshipReportTarget({
    procurement_id: "procurement:contract:CC7-2001",
    canonical_href: "/procurements/procurement%3Acontract%3ACC7-2001",
    short_title: "Street repair contract",
    vendor_name: "Northstar Works",
    vendor_entity_ref: "vendor:stem:NORTHSTAR%20WORKS",
    source_observation_refs: ["cc7-contract-2001"],
  });
  return {
    id: "CC7-RELATIONSHIP-001",
    class: "wrong_relationship",
    failure_origin: "joining",
    target,
    source_truth: {
      vendor_ref: "vendor:stem:NORTHSTAR%20WORKS",
      vendor_label: "Northstar Works",
    },
    before_assertion: "CityScroll connects the street repair contract to Northstar Works.",
    report_category: "connection_wrong",
    report_message: "This contract is connected to Harbor Maintenance, not Northstar Works; the contract record and vendor record share the same contract identifier.",
    report_evidence: "cc7-contract-2001 and cc7-vendor-2001 both identify Harbor Maintenance for this contract.",
    adjudication: {
      verdict: "confirmed",
      evidence_reviewed: ["cc7-contract-2001", "cc7-vendor-2001"],
      rationale: "The exact contract identifier agrees across the two retained source records; the vendor edge in this fixture is replaced.",
    },
    correction: {
      source: "pilot fixture contract-vendor edge",
      path: "vendor_ref",
      before: "vendor:stem:NORTHSTAR%20WORKS",
      after: "vendor:stem:HARBOR%20MAINTENANCE",
      after_label: "Harbor Maintenance",
    },
  };
}

function groupingCase() {
  const target = buildMeetingGroupingReportTarget({
    kind: "event",
    notice_count: 2,
    title: "Street safety hearing",
    primary: { meeting_id: "meeting:city_record:cc7-3001", title: "Street safety hearing" },
    members: [
      { request_id: "cc7-notice-3001", source_system: "city_record", source_url: "fixture://cc7/notice-3001" },
      { request_id: "cc7-notice-3002", source_system: "city_record", source_url: "fixture://cc7/notice-3002" },
    ],
  });
  return {
    id: "CC7-GROUPING-001",
    class: "wrong_grouping",
    failure_origin: "derived_interpretation",
    target,
    source_truth: {
      grouping_mode: "one_meeting",
      notice_count: 2,
    },
    before_assertion: "CityScroll presents two separately dated notices as one Street safety hearing.",
    report_category: "connection_wrong",
    report_message: "These notices describe separate hearings and should not be presented as one meeting.",
    report_evidence: "cc7-notice-3001 and cc7-notice-3002 have distinct publisher dates and distinct hearing subjects.",
    adjudication: {
      verdict: "confirmed",
      evidence_reviewed: ["cc7-notice-3001", "cc7-notice-3002"],
      rationale: "The retained publisher records have distinct dates and subjects, so this pilot grouping is split without changing unrelated meeting groups.",
    },
    correction: {
      source: "pilot fixture meeting grouping",
      path: "grouping_mode",
      before: "one_meeting",
      after: "separate_notices",
    },
  };
}

function missingRelationshipCase() {
  const meetingId = "meeting:community_board:cc7-4001";
  const target = buildRelationshipReportTarget({
    object_type: "meeting",
    object_id: meetingId,
    canonical_url: `/meetings/${encodeURIComponent(meetingId)}`,
    object_label: "Community Board 6 public hearing",
    anchor: `${meetingId}#host_board`,
    relation_type: "hosted_by_community_board",
    subject_id: meetingId,
    subject_label: "Community Board 6 public hearing",
    related_object_id: "community-board:manhattan-06",
    related_object_label: "Manhattan Community Board 6",
    field_or_semantic_key: "host_board",
    source: {
      source_system: "community_board_calendar_fixture",
      source_record_id: "cc7-meeting-4001",
      source_url: "fixture://cc7/meeting-4001",
    },
  });
  return {
    id: "CC7-MISSING-001",
    class: "missing_relationship",
    failure_origin: "ingestion",
    target,
    source_truth: {
      host_board_ref: null,
      host_board_label: null,
    },
    before_assertion: "CityScroll shows the public hearing but does not identify its Community Board host.",
    report_category: "something_missing",
    report_message: "The meeting page is missing its Community Board 6 host relationship.",
    report_evidence: "cc7-meeting-4001 is published on the board calendar and names Manhattan Community Board 6.",
    adjudication: {
      verdict: "confirmed",
      evidence_reviewed: ["cc7-meeting-4001"],
      rationale: "The board calendar directly names the host, so the missing relationship is added to this fixture's source-of-truth envelope.",
    },
    correction: {
      source: "pilot fixture meeting source join",
      path: "host_board_ref",
      before: null,
      after: "community-board:manhattan-06",
      after_label: "Manhattan Community Board 6",
    },
  };
}

function negativeInsufficientEvidenceCase() {
  const result = groupingCase();
  return {
    ...result,
    id: "CC7-NEGATIVE-INSUFFICIENT-EVIDENCE-001",
    report_evidence: "The reporter says the notices look different but supplies no source record or date evidence.",
    adjudication: {
      verdict: "unresolved",
      evidence_reviewed: [],
      rationale: "A report alone is evidence of disagreement, not enough evidence to change the grouping.",
    },
  };
}

export const PILOT_CASES = Object.freeze([
  identityCase(),
  relationshipCase(),
  groupingCase(),
  missingRelationshipCase(),
]);

export const PILOT_NEGATIVE_CASES = Object.freeze([negativeInsufficientEvidenceCase()]);

function visibleResult(pilotCase, sourceTruth) {
  switch (pilotCase.class) {
    case "wrong_identity":
      return `${sourceTruth.displayed_profile} is listed under ${sourceTruth.canonical_entity_ref}.`;
    case "wrong_relationship":
      return `Street repair contract is connected to ${sourceTruth.vendor_label || sourceTruth.vendor_ref}.`;
    case "wrong_grouping":
      return sourceTruth.grouping_mode === "separate_notices"
        ? "Two publisher notices are shown as two separate hearings."
        : "Two publisher notices are shown as one Street safety hearing.";
    case "missing_relationship":
      return sourceTruth.host_board_label
        ? `Hosted by ${sourceTruth.host_board_label}.`
        : "Host relationship is not published.";
    default:
      return "No visible result.";
  }
}

function applyCorrection(sourceTruth, correction, verdict) {
  const before = clone(sourceTruth);
  if (verdict !== "confirmed") return { before, after: before, changed: false, applied: false, reason: "unresolved" };
  if (sourceTruth[correction.path] !== correction.before) {
    return { before, after: before, changed: false, applied: false, reason: "source_truth_changed_before_adjudication" };
  }
  const after = clone(sourceTruth);
  after[correction.path] = correction.after;
  if (correction.after_label) {
    if (correction.path === "vendor_ref") after.vendor_label = correction.after_label;
    if (correction.path === "host_board_ref") after.host_board_label = correction.after_label;
  }
  return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after), applied: true, reason: null };
}

function reportPayload(pilotCase) {
  return {
    category: pilotCase.report_category,
    message: pilotCase.report_message,
    evidence: pilotCase.report_evidence,
    report_target: pilotCase.target,
    report: {
      category: pilotCase.report_category,
      explanation: pilotCase.report_message,
      evidence: pilotCase.report_evidence,
    },
  };
}

export function replayPilotCase(pilotCase) {
  const submitted = reportPayload(pilotCase);
  const validation = validateFeedback(submitted);
  if (!validation.ok) throw new Error(`${pilotCase.id}: report validation failed: ${validation.reason}`);
  if (validation.value.report_target.target_id !== pilotCase.target.target_id) {
    throw new Error(`${pilotCase.id}: normalized report target changed identity`);
  }
  const requiredEvidence = pilotCase.adjudication.evidence_reviewed;
  const evidence = String(submitted.evidence);
  const evidenceComplete = requiredEvidence.length > 0
    && requiredEvidence.every((item) => evidence.includes(item));
  const verdict = evidenceComplete ? pilotCase.adjudication.verdict : "unresolved";
  const adjudication = {
    ...clone(pilotCase.adjudication),
    verdict,
    evidence_complete: evidenceComplete,
    scope: PILOT_SCOPE,
    report_is_not_proof: true,
  };
  const sourceTruthChange = applyCorrection(pilotCase.source_truth, pilotCase.correction, verdict);
  const beforeResult = visibleResult(pilotCase, pilotCase.source_truth);
  const afterResult = visibleResult(pilotCase, sourceTruthChange.after);
  return {
    schema: PILOT_SCHEMA,
    pilot_scope: PILOT_SCOPE,
    id: pilotCase.id,
    class: pilotCase.class,
    failure_origin: pilotCase.failure_origin,
    before: {
      assertion: pilotCase.before_assertion,
      provenance: pilotCase.target.provenance,
      source_truth: sourceTruthChange.before,
      visible_result: beforeResult,
    },
    report: {
      path: REPORT_ENDPOINT,
      delivery: "structured correction payload validated locally; no external submission",
      payload: submitted,
      normalized_target_id: validation.value.report_target.target_id,
    },
    adjudication,
    source_of_truth_change: {
      ...sourceTruthChange,
      source: pilotCase.correction.source,
      path: pilotCase.correction.path,
    },
    after: {
      changed: sourceTruthChange.changed,
      visible_result: afterResult,
      provenance: pilotCase.target.provenance,
      source_truth: sourceTruthChange.after,
    },
  };
}

export function runPilot() {
  return {
    schema: PILOT_SCHEMA,
    generated_for: "2026-08-27",
    pilot_scope: PILOT_SCOPE,
    report_endpoint: REPORT_ENDPOINT,
    claim: "These are four bounded seeded replays, not a coverage or correctness claim about equivalent records elsewhere.",
    cases: [...PILOT_CASES, ...PILOT_NEGATIVE_CASES].map(replayPilotCase),
    limitations: [
      "The four fixtures exercise the seam; they do not establish universal challengeability or correctness.",
      "Adjudication evidence is fixture-supplied and reviewed as a pilot record, not automatically inferred from the report.",
      "Corrections are applied only to the named in-memory pilot source-of-truth envelope; production records are not mutated.",
      "The negative case remains unresolved because the supplied disagreement has no source evidence.",
    ],
  };
}

export function writePilot(output = OUTPUT) {
  const result = runPilot();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.includes("--stdout") ? null : (process.argv[2] || OUTPUT);
  const result = output ? writePilot(output) : runPilot();
  if (output) console.log(`wrote ${path.relative(process.cwd(), output)}`);
  else console.log(JSON.stringify(result, null, 2));
}
