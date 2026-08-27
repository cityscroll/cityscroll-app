#!/usr/bin/env node

/**
 * Build the Card 1 baseline census from committed source inventories and the
 * source-native meeting index. This is an inventory artifact, not a runtime
 * projection: title signals are measured and never promoted to graph edges.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCommunityBoardMeetingIndex } from "./lib/community_board_meeting_index_io.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REGISTRY_PATH = "site/data/non_council_outcome_sources/source_registry.json";
const INVENTORY_PATH = "site/data/non_council_outcome_sources/board_source_inventory.json";
const MEETING_INDEX_PATH = "site/data/community_board_meeting_index.json";
const OUTPUT_PATH = "site/data/non_council_outcome_sources/community_board_graph_census.json";

export const COMMUNITY_BOARD_GRAPH_CENSUS_SCHEMA = "cityscroll.community_board_graph_census.v1";
export const CENSUS_STATUSES = Object.freeze([
  "already modeled",
  "already present in source but discarded",
  "requires another official source",
  "not reliably available",
]);

const DIMENSIONS = Object.freeze([
  "official_committee_directory",
  "committee_identity_in_calendar_or_source_data",
  "board_roster",
  "officers",
  "district_manager_staff",
  "bylaws",
  "upcoming_meetings",
  "minutes",
  "agendas",
  "recommendations_resolutions",
  "public_hearings",
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8"));
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasText(value, pattern) {
  return pattern.test(clean(value));
}

function explicitCommitteeRecord(row) {
  return Boolean(
    clean(row?.committee)
    || (row?.committee && typeof row.committee === "object" && clean(row.committee.name))
    || hasText(row?.title, /\bcommittee\b/i),
  );
}

function fullBoardRecord(row) {
  return hasText(row?.title, /\b(?:full board|general board|board meeting)\b/i);
}

function publicHearingRecord(row) {
  return hasText(row?.title, /\bpublic hearing\b/i);
}

function jointCommitteeRecord(row) {
  // A plural publisher title is the only conservative joint-body signal in
  // this baseline. Compound names such as "Housing and Land Use Committee"
  // are deliberately not counted as multiple committees.
  return hasText(row?.title, /\bcommittees\b/i);
}

function sourceRecordEvidence(doc) {
  return [
    doc?.source_record_id,
    doc?.record_id,
    doc?.document_url,
    doc?.source_url,
    doc?.title,
  ].filter(Boolean).join(" ");
}

function sourceRoleState(receipts, boardId, role) {
  return receipts.find((row) => row.board_id === boardId && row.role === role) || null;
}

function sourceStructure(value, receipt, recordCount) {
  return {
    url: value?.url || null,
    adapter: value?.adapter || null,
    format: value?.format || null,
    publisher_kind: value?.publisher_kind || null,
    fetch_mode: value?.fetch_mode || null,
    inventory_status: value?.status || (value?.url ? "observed" : "absent_in_pass"),
    collection_state: receipt?.state || null,
    collection_state_reason: receipt?.state_reason || null,
    current_record_count: recordCount,
  };
}

function slot(status, basis, evidenceCount = 0, note = null) {
  if (!CENSUS_STATUSES.includes(status)) throw new Error(`Unknown census status: ${status}`);
  return {
    status,
    basis,
    evidence_count: evidenceCount,
    note,
  };
}

function sourceBackedOrUnavailable(count, sourceValue, basis) {
  if (count > 0) return slot("already modeled", basis, count);
  if (sourceValue?.url) return slot("not reliably available", `${basis}_no_current_record`, 0, "An explicit source was inventoried, but the current committed collection does not establish the fact.");
  return slot("requires another official source", `${basis}_source_missing`, 0, "The current source inventory has no explicit source for this dimension.");
}

function titleSignalOrUnknown(count, basis, note) {
  if (count > 0) return slot("already present in source but discarded", basis, count, note);
  return slot("not reliably available", `${basis}_not_observed`, 0, "The current committed source data does not establish this fact.");
}

function buildBoardRow(board, registryRow, meetingIndex, receipts) {
  const meetingRows = (meetingIndex.rows || []).filter((row) => row.board_id === board.id);
  const sourceRows = meetingIndex.source_records_by_board?.[board.id] || [];
  const minutesRows = sourceRows.filter((row) => row.source_role === "minutes");
  const agendaRows = minutesRows.filter((row) => /\bagenda\b/i.test(sourceRecordEvidence(row)));
  const committeeRows = meetingRows.filter(explicitCommitteeRecord);
  const fullBoardRows = meetingRows.filter(fullBoardRecord);
  const hearingRows = meetingRows.filter(publicHearingRecord);
  const jointRows = meetingRows.filter(jointCommitteeRecord);
  const typedCommitteeRows = meetingRows.filter((row) => (
    clean(row.committee)
    || (row.committee && typeof row.committee === "object" && clean(row.committee.name))
  ));
  const typedHostRows = meetingRows.filter((row) => (
    clean(row.host_body)
    || clean(row.host_body_id)
    || (Array.isArray(row.institution_refs) && row.institution_refs.length > 0)
    || (Array.isArray(row.host_institution_refs) && row.host_institution_refs.length > 0)
  ));
  const upcomingReceipt = sourceRoleState(receipts, board.id, "upcoming_meetings");
  const minutesReceipt = sourceRoleState(receipts, board.id, "minutes");
  const dimensions = {
    official_committee_directory: slot(
      "requires another official source",
      "no_committee_directory_source_role_or_current_cb_committee_registry",
      0,
      "The current inventory defines upcoming_meetings and minutes only; the Council Legistar committee registry is out of scope.",
    ),
    committee_identity_in_calendar_or_source_data: titleSignalOrUnknown(
      committeeRows.length,
      "meeting_title_explicit_committee_signal",
      "The publisher title names a committee, but the current materialized row has no typed committee identity.",
    ),
    board_roster: slot(
      "requires another official source",
      "no_roster_source_role_or_current_cb_person_model",
      0,
      "Names in unretained document text are not used as roster evidence.",
    ),
    officers: slot(
      "requires another official source",
      "no_officer_source_role_or_current_cb_person_model",
      0,
      "The current source inventory does not retain an officer directory.",
    ),
    district_manager_staff: slot(
      "requires another official source",
      "no_staff_source_role_or_current_cb_person_model",
      0,
      "The current source inventory does not retain a staff or district-manager directory.",
    ),
    bylaws: slot(
      "requires another official source",
      "no_bylaw_source_role_or_current_bylaw_model",
      0,
      "The current source inventory does not retain governing documents.",
    ),
    upcoming_meetings: sourceBackedOrUnavailable(
      meetingRows.length,
      board.upcoming,
      "indexed_meeting_records",
    ),
    minutes: sourceBackedOrUnavailable(
      minutesRows.length,
      board.minutes,
      "indexed_minutes_documents",
    ),
    agendas: titleSignalOrUnknown(
      agendaRows.length,
      "indexed_document_url_or_identifier_agenda_signal",
      "Agenda-looking publisher documents are retained as source records, not as typed agenda objects.",
    ),
    recommendations_resolutions: slot(
      "requires another official source",
      "no_exact_recommendation_or_resolution_source_record_model",
      0,
      "Minutes metadata alone does not establish a recommendation, resolution, or its publisher identity.",
    ),
    public_hearings: titleSignalOrUnknown(
      hearingRows.length,
      "meeting_title_explicit_public_hearing_signal",
      "The publisher title says public hearing, but the current row has no orthogonal typed proceeding field.",
    ),
  };

  const eventTitles = [...new Set(committeeRows.map((row) => clean(row.title)).filter(Boolean))].sort();
  return {
    board_id: board.id,
    name: board.name,
    borough: board.borough,
    district: board.district,
    observed_on: board.observed,
    source_structure: {
      official_home: board.home || registryRow?.homepage_url || null,
      upcoming_meetings: sourceStructure(board.upcoming, upcomingReceipt, meetingRows.length),
      minutes: sourceStructure(board.minutes, minutesReceipt, minutesRows.length),
    },
    dimensions,
    meeting_measurements: {
      record_count: meetingRows.length,
      records_explicitly_identifying_committee: committeeRows.length,
      records_with_structured_committee_field: typedCommitteeRows.length,
      records_whose_title_exactly_matches_known_local_committee: 0,
      full_board_records: fullBoardRows.length,
      explicit_public_hearing_records: hearingRows.length,
      joint_committee_records: jointRows.length,
      records_without_typed_institution_host: meetingRows.length - typedHostRows.length,
      committee_records_with_unresolved_host_body: committeeRows.length - committeeRows.filter((row) => typedHostRows.includes(row)).length,
      explicit_committee_title_samples: eventTitles.slice(0, 12),
    },
  };
}

export function buildCommunityBoardGraphCensus({ registry, inventory, meetingIndex }) {
  const boards = inventory.boards || [];
  const registryById = new Map((registry.sources || []).map((row) => [row.body_id, row]));
  const receipts = meetingIndex.receipts || [];
  const boardRows = boards.map((board) => buildBoardRow(board, registryById.get(board.id), meetingIndex, receipts));
  const dimensionSummary = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const counts = Object.fromEntries(CENSUS_STATUSES.map((status) => [status, 0]));
    for (const board of boardRows) counts[board.dimensions[dimension].status] += 1;
    return [dimension, {
      board_count: boardRows.length,
      counts,
    }];
  }));
  const statusCounts = Object.fromEntries(CENSUS_STATUSES.map((status) => [status, 0]));
  for (const board of boardRows) for (const dimension of DIMENSIONS) statusCounts[board.dimensions[dimension].status] += 1;
  const meetingRows = meetingIndex.rows || [];
  const meetingMeasurements = {
    record_count: meetingRows.length,
    boards_with_records: new Set(meetingRows.map((row) => row.board_id)).size,
    records_explicitly_identifying_committee: meetingRows.filter(explicitCommitteeRecord).length,
    records_with_structured_committee_field: meetingRows.filter((row) => (
      clean(row.committee)
      || (row.committee && typeof row.committee === "object" && clean(row.committee.name))
    )).length,
    records_whose_title_exactly_matches_known_local_committee: 0,
    full_board_records: meetingRows.filter(fullBoardRecord).length,
    explicit_public_hearing_records: meetingRows.filter(publicHearingRecord).length,
    joint_committee_records: meetingRows.filter(jointCommitteeRecord).length,
    records_without_typed_institution_host: meetingRows.filter((row) => !(
      clean(row.host_body)
      || clean(row.host_body_id)
      || (Array.isArray(row.institution_refs) && row.institution_refs.length > 0)
      || (Array.isArray(row.host_institution_refs) && row.host_institution_refs.length > 0)
    )).length,
    committee_records_with_unresolved_host_body: meetingRows.filter((row) => explicitCommitteeRecord(row) && !(
      clean(row.host_body)
      || clean(row.host_body_id)
      || (Array.isArray(row.institution_refs) && row.institution_refs.length > 0)
      || (Array.isArray(row.host_institution_refs) && row.host_institution_refs.length > 0)
    )).length,
    known_local_committee_registry: {
      path: "not present in Card 1; reviewed board-local registry is a later card deliverable",
      known_committee_count: 0,
      exact_title_match_method: "exact comparison against a reviewed board-local committee registry; no fuzzy title classification",
    },
  };
  const totalSlots = boardRows.length * DIMENSIONS.length;
  const summary = {
    board_count: boardRows.length,
    dimension_count: DIMENSIONS.length,
    board_dimension_slots: totalSlots,
    status_counts: statusCounts,
    grounded_slots_already_modeled: statusCounts["already modeled"],
    source_present_but_discarded_slots: statusCounts["already present in source but discarded"],
    unresolved_slots: statusCounts["not reliably available"] + statusCounts["requires another official source"],
    headline: `${statusCounts["already modeled"]} of ${totalSlots} board-dimension slots are already modeled; ${statusCounts["already present in source but discarded"]} have explicit source signals that are not typed; ${statusCounts["not reliably available"] + statusCounts["requires another official source"]} remain unresolved or require another official source.`,
  };
  return {
    schema: COMMUNITY_BOARD_GRAPH_CENSUS_SCHEMA,
    version: 1,
    observed_on: meetingIndex.generated_at?.slice(0, 10) || inventory.observed_on || null,
    policy: {
      source_registry: REGISTRY_PATH,
      source_inventory: INVENTORY_PATH,
      meeting_index: MEETING_INDEX_PATH,
      source_roles_in_scope: ["upcoming_meetings", "minutes"],
      statuses: CENSUS_STATUSES,
      already_modeled_definition: "The fact is represented by the current committed source-native model or board projection.",
      discarded_definition: "The current committed source data contains an explicit signal, but no typed CB institutional object or edge represents it.",
      requires_source_definition: "No current source role supplies a sufficient official assertion for the dimension.",
      not_reliably_available_definition: "The current source collection or metadata does not establish the fact; this is not evidence that the fact does not exist.",
      meeting_universe: "meeting_index.rows, which are current indexed upcoming-meeting records; minutes documents are measured separately.",
      title_signal_rule: "Direct publisher title tokens only; no title-to-committee identity inference is performed.",
      joint_meeting_rule: "Count only titles using plural 'committees'; compound singular committee names are not treated as joint meetings.",
      no_production_inference_rules: true,
    },
    summary,
    dimension_summary: dimensionSummary,
    meeting_measurements: meetingMeasurements,
    boards: boardRows,
  };
}

export function buildAndWriteCommunityBoardGraphCensus({ outputPath = OUTPUT_PATH } = {}) {
  const census = buildCommunityBoardGraphCensus({
    registry: readJson(REGISTRY_PATH),
    inventory: readJson(INVENTORY_PATH),
    meetingIndex: readCommunityBoardMeetingIndex(resolve(ROOT, MEETING_INDEX_PATH)),
  });
  writeFileSync(resolve(ROOT, outputPath), `${JSON.stringify(census, null, 2)}\n`);
  return census;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const census = buildAndWriteCommunityBoardGraphCensus();
  console.log(`wrote ${census.boards.length} boards and ${census.summary.board_dimension_slots} dimension slots to ${OUTPUT_PATH}`);
}
