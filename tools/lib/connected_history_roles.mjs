/**
 * Fixed six-case dossier participant-role candidates and materialization.
 *
 * Candidates are commissioning inputs: named actors, source locators, and
 * role dates from the dossier. Admission runs through
 * site/connected_history_roles.mjs. This module never searches for substitute
 * examples. Missing role strata remain reportable outcomes.
 */

import { createHash } from "node:crypto";

import {
  CONNECTED_HISTORY_ROLE_METHOD,
  CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA,
  CONNECTED_HISTORY_ROLES_VERSION,
  projectConnectedHistoryRoles,
} from "../../site/connected_history_roles.mjs";

export const CONNECTED_HISTORY_ROLES_RECEIPT_SCHEMA =
  "cityscroll.connected_history_roles_receipt.v1";

const OBSERVED_AT = "2026-09-26T00:00:00.000Z";

/**
 * Positive and hard-negative candidates for the fixed dossier.
 * Hard negatives carry rejected bases or forbidden formal upgrades.
 */
export const CONNECTED_HISTORY_ROLE_CANDIDATES = Object.freeze([
  // --- Franklin Avenue: dated applicants; source-qualified company identity ---
  Object.freeze({
    candidate_id: "franklin-applicant-c200184zmk",
    family_id: "franklin-avenue",
    role: "applicant",
    entity_id: "source_qualified:zap:application:C200184ZMK:primary_applicant",
    entity_qualifier: "zap:application:C200184ZMK#primary_applicant",
    entity_spelling: "Franklin Avenue applicant label",
    identity_status: "source_qualified",
    subject: "land:application:C200184ZMK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: Object.freeze({
      locator: "official_report_predecessor_application_applicant",
      quote: "C200184ZMK",
    }),
    role_date: Object.freeze({ value: "2021", precision: "year" }),
    scope: Object.freeze(["franklin-avenue", "brooklyn-1192"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),
  Object.freeze({
    candidate_id: "franklin-applicant-c230356zmk",
    family_id: "franklin-avenue",
    role: "applicant",
    entity_id: "source_qualified:zap:application:C230356ZMK:primary_applicant",
    entity_qualifier: "zap:application:C230356ZMK#primary_applicant",
    entity_spelling: "Franklin Avenue applicant label",
    identity_status: "source_qualified",
    subject: "land:application:C230356ZMK",
    source_system: "zap-project-action-report",
    source_record_id: "zap:document:230356-official-report",
    source_span: Object.freeze({
      locator: "official_report_later_application_applicant",
      quote: "C230356ZMK",
    }),
    role_date: Object.freeze({ value: "2024", precision: "year" }),
    scope: Object.freeze(["franklin-avenue", "brooklyn-1192"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),

  // --- Lighthouse Point: chair quotation as speaker; EDC lease operator ---
  Object.freeze({
    candidate_id: "lighthouse-cb1-chair-speaker",
    family_id: "lighthouse-point",
    role: "speaker",
    claimed_as: "chair_statement",
    entity_id: "source_qualified:edc:press-release:lighthouse-point-opening:cb1-chair",
    entity_qualifier: "edc:press-release:lighthouse-point-opening-2025-06-05#cb1-chair",
    entity_display_name: "Community Board 1 chair",
    identity_status: "source_qualified",
    subject: "edc:project:lighthouse-point",
    source_system: "edc-press-release",
    source_record_id: "edc:press-release:lighthouse-point-opening-2025-06-05",
    source_span: Object.freeze({
      locator: "opening_announcement_chair_quotation",
      quote: "quoted community board chair statement",
    }),
    role_date: Object.freeze({ value: "2025-06-05", precision: "day" }),
    scope: Object.freeze(["lighthouse-point", "staten-island-cb-1"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),
  Object.freeze({
    candidate_id: "lighthouse-edc-operator-lease",
    family_id: "lighthouse-point",
    role: "operator",
    entity_id: "source_qualified:edc:project:lighthouse-point:leaseholder",
    entity_qualifier: "edc:project:lighthouse-point#2014-lease",
    entity_display_name: "NYCEDC project leaseholder",
    identity_status: "source_qualified",
    subject: "edc:project:lighthouse-point",
    source_system: "edc-project-page",
    source_record_id: "edc:project:lighthouse-point",
    source_span: Object.freeze({
      locator: "project_page_lease_and_planned_components",
      quote: "2014 lease",
    }),
    role_date: Object.freeze({ value: "2014", precision: "year" }),
    scope: Object.freeze(["lighthouse-point", "phase-plan"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),

  // --- Hard negatives (must reject) ---
  Object.freeze({
    candidate_id: "negative-lighthouse-chair-as-formal-board-action",
    family_id: "lighthouse-point",
    role: "formal_board_action",
    claimed_as: "chair_statement",
    basis: "chair_quote_as_formal_board_action",
    entity_id: "source_qualified:edc:press-release:lighthouse-point-opening:cb1-chair",
    entity_qualifier: "edc:press-release:lighthouse-point-opening-2025-06-05#cb1-chair",
    subject: "edc:project:lighthouse-point",
    source_system: "edc-press-release",
    source_record_id: "edc:press-release:lighthouse-point-opening-2025-06-05",
    source_span: Object.freeze({
      locator: "opening_announcement_chair_quotation",
      quote: "quoted community board chair statement",
    }),
    role_date: Object.freeze({ value: "2025-06-05", precision: "day" }),
    scope: Object.freeze(["lighthouse-point", "staten-island-cb-1"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-dot-presentation-as-formal-board-action",
    family_id: "sixth-avenue",
    role: "formal_board_action",
    claimed_as: "presentation",
    basis: "presentation_as_formal_board_action",
    entity_id: "source_qualified:dot:corridor:sixth-avenue:presenter",
    entity_qualifier: "dot:heading:sixth-avenue-watts-w59#presentation",
    subject: "dot:corridor:sixth-avenue-watts-w59",
    source_system: "dot-current-projects",
    source_record_id: "dot:heading:sixth-avenue-watts-w59",
    source_span: Object.freeze({
      locator: "dot_current_projects_june_2026_attachment",
      quote: "June 2026 CB2/CB4/CB5",
    }),
    role_date: Object.freeze({ value: "2026-06", precision: "month" }),
    scope: Object.freeze(["sixth-avenue", "watts-to-west-59th"]),
    board_presentation: true,
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-same-applicant-spelling-beneficial-ownership",
    family_id: "franklin-avenue",
    role: "recorded_owner",
    basis: "same_applicant_spelling",
    entity_id: "source_qualified:zap:application:C230356ZMK:primary_applicant",
    entity_qualifier: "zap:application:C230356ZMK#primary_applicant",
    entity_spelling: "Franklin Avenue applicant label",
    subject: "parcel:brooklyn-1192-63",
    source_system: "applicant-label-heuristic",
    source_record_id: "synthetic:franklin-same-applicant-ownership",
    source_span: Object.freeze({
      locator: "primary_applicant",
      quote: "same applicant label",
    }),
    role_date: Object.freeze({ value: "2024", precision: "year" }),
    scope: Object.freeze(["franklin-avenue", "brooklyn-1192"]),
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),
  Object.freeze({
    candidate_id: "negative-testimony-flags-as-resolution",
    family_id: "coyle",
    role: "formal_board_action",
    claimed_as: "testimony",
    basis: "testimony_flags_as_resolution",
    formal_evidence_role: "testimony",
    entity_id: "source_qualified:brooklyn-cb-15:testimony:coyle",
    entity_qualifier: "brooklyn-cb-15:Agenda-4-28-26.pdf#testimony",
    subject: "bsa:case:2025-54-A",
    source_system: "community-board-agenda",
    source_record_id: "brooklyn-cb-15:Agenda-4-28-26.pdf",
    source_span: Object.freeze({
      locator: "agenda_public_testimony_item",
      quote: "2025-54-A",
    }),
    role_date: Object.freeze({ value: "2026-04-28", precision: "day" }),
    scope: Object.freeze(["coyle", "brooklyn-cb-15"]),
    // Flags alone must not certify formal action.
    formal_evidence: true,
    board_action: true,
    formal_stance: "support",
    observed_time: OBSERVED_AT,
    method_version: CONNECTED_HISTORY_ROLE_METHOD,
  }),
]);

const DEMO_FAMILY_IDS = Object.freeze([
  "coyle",
  "franklin-avenue",
  "kingsbridge-armory",
  "sixth-avenue",
  "thirty-first-avenue",
  "lighthouse-point",
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function buildConnectedHistoryRolesArtifact(options = {}) {
  const candidates = options.candidates || CONNECTED_HISTORY_ROLE_CANDIDATES;
  const generatedAt = options.generatedAt || OBSERVED_AT;
  const projected = projectConnectedHistoryRoles(candidates);

  const familyCounts = {};
  for (const familyId of DEMO_FAMILY_IDS) familyCounts[familyId] = { admitted: 0, rejected: 0 };
  for (const row of projected.observations) {
    const familyId = row.family_id || "unscoped";
    familyCounts[familyId] = familyCounts[familyId] || { admitted: 0, rejected: 0 };
    familyCounts[familyId].admitted += 1;
  }
  for (const row of projected.rejections) {
    const candidate = candidates.find((item) => item.candidate_id === row.candidate_id);
    const familyId = candidate?.family_id || "unscoped";
    familyCounts[familyId] = familyCounts[familyId] || { admitted: 0, rejected: 0 };
    familyCounts[familyId].rejected += 1;
  }

  const selectionHash = sha256(stableStringify({
    schema: CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA,
    version: CONNECTED_HISTORY_ROLES_VERSION,
    candidate_ids: candidates.map((row) => row.candidate_id),
    admitted: projected.observations.map((row) => ({
      candidate_id: row.candidate_id || null,
      role: row.role,
      from: row.from,
      to: row.to,
      role_date: row.role_date,
    })),
    rejected: projected.rejections,
  }));

  return {
    ...projected,
    generated_at: generatedAt,
    source_policy: "fixed-six-case-dossier-only",
    dossier_families: [...DEMO_FAMILY_IDS],
    family_counts: familyCounts,
    selection_hash: selectionHash,
    boundaries: {
      no_beneficial_ownership_from_applicant_spelling: true,
      no_chair_quote_as_formal_board_action: true,
      no_presentation_as_formal_board_action: true,
      no_testimony_flags_as_resolution: true,
      absence_is_not_adverse_inference: true,
      formal_stance_uses_board_document_gate: true,
      unresolved_company_identity_preserved: true,
    },
  };
}

export function buildConnectedHistoryRolesReceipt(artifact, options = {}) {
  return {
    schema: CONNECTED_HISTORY_ROLES_RECEIPT_SCHEMA,
    version: 1,
    artifact: "site/data/connected_history_roles.json",
    generated_at: artifact.generated_at,
    selection_hash: artifact.selection_hash,
    counts: artifact.counts,
    missing_strata: artifact.missing_strata,
    method: CONNECTED_HISTORY_ROLE_METHOD,
    source_policy: artifact.source_policy,
    candidate_count: options.candidateCount
      ?? CONNECTED_HISTORY_ROLE_CANDIDATES.length,
  };
}

export function materializeConnectedHistoryRoles(options = {}) {
  const artifact = buildConnectedHistoryRolesArtifact(options);
  const receipt = buildConnectedHistoryRolesReceipt(artifact, {
    candidateCount: (options.candidates || CONNECTED_HISTORY_ROLE_CANDIDATES).length,
  });
  return { artifact, receipt };
}

export const CONNECTED_HISTORY_ROLES_ARTIFACT_PATH = "site/data/connected_history_roles.json";
export const CONNECTED_HISTORY_ROLES_RECEIPT_PATH =
  "site/data/connected_history_sources/verification_receipts/connected_history_roles_latest.json";

/** The exact bytes the builder writes for an artifact or receipt. */
export function serializeConnectedHistoryRolesJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function firstDifference(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : length;
}

/**
 * Byte-exact drift between committed texts and a fresh materialization. Equal
 * selection hashes, counts and strata do not make an artifact current: only
 * identical bytes do, for the artifact and for the receipt that describes it.
 * Returns one finding per file that differs; an empty list means current.
 */
export function connectedHistoryRolesDrift({ artifactText, receiptText }, materialized = materializeConnectedHistoryRoles()) {
  const findings = [];
  for (const [path, committed, value] of [
    [CONNECTED_HISTORY_ROLES_ARTIFACT_PATH, artifactText, materialized.artifact],
    [CONNECTED_HISTORY_ROLES_RECEIPT_PATH, receiptText, materialized.receipt],
  ]) {
    const expected = serializeConnectedHistoryRolesJson(value);
    if (committed === expected) continue;
    const committedBytes = Buffer.from(String(committed ?? ""), "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    findings.push({
      path,
      committed_bytes: committedBytes.length,
      materialized_bytes: expectedBytes.length,
      committed_sha256: sha256(String(committed ?? "")),
      materialized_sha256: sha256(expected),
      first_difference_at: firstDifference(committedBytes, expectedBytes),
    });
  }
  return findings;
}
