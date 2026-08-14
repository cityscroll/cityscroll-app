#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchCommunityBoardSource,
  normalizeObservedReceipt,
  COMMUNITY_BOARD_SOURCE_RECORD_SCHEMA,
  sourceAdapterContract,
  communityBoardSourceAdapterId,
} from "../site/community_board_source_adapters.mjs";
import { normalizeCommunityBoardMeeting } from "../site/meeting_object_contract.mjs";

const ROOT = join(import.meta.dirname, "..");
const INVENTORY = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const OUTPUT = join(ROOT, "site/data/community_board_meeting_index.json");
const INDEX_SCHEMA = "cityscroll.community_board_meeting_index.v1";
const JOIN_SCHEMA = "cityscroll.community_board_source_join.v1";
const JOIN_METHOD = "exact_board_date_publisher_identifier";
const SOURCE_STATES = Object.freeze([
  "indexed",
  "checked-empty",
  "unsupported-format",
  "unavailable",
  "stale",
  "not-yet-checked",
]);
const SOURCE_ROLES = ["upcoming_meetings", "minutes"];
export const COMMUNITY_BOARD_SOURCE_STATES = SOURCE_STATES;

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function clean(value, max = 500) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function sourceDescriptors(inventory, registry) {
  const boardNames = new Map((registry.sources || [])
    .filter((row) => row.body_type === "community_board")
    .map((row) => [row.body_id, row.name]));
  return (inventory.boards || []).flatMap((board) => {
    return SOURCE_ROLES.map((role) => {
      const source = role === "upcoming_meetings" ? board.upcoming : board.minutes;
      return {
        ...(source || {}),
        role,
        source_role: role,
        board_id: board.id,
        body_id: board.id,
        body_name: boardNames.get(board.id) || board.name,
      };
    });
  });
}

function sourceReceipt(descriptor, observedAt, result = null) {
  if (result?.receipt) return result.receipt;
  return normalizeObservedReceipt({
    observed_at: observedAt,
    status: "unknown",
    fetch_status: descriptor.verification?.fetchability === "browser_required" ? "browser-required" : null,
    reason: descriptor.url ? "source_not_checked" : "no_explicit_source_observed",
    parser: communityBoardSourceAdapterId(descriptor),
  }, descriptor);
}

function sourceState(descriptor, result, records, observedAt) {
  if (!descriptor.url) return "not-yet-checked";
  if (!sourceAdapterContract(descriptor)) return "unsupported-format";
  if (descriptor.status === "stale" || descriptor.verification?.status === "stale") return "stale";
  if (descriptor.verification?.fetchability === "browser_required") return "unavailable";
  const receipt = result?.receipt || {};
  if (receipt.reason === "source_stale") return "stale";
  if (receipt.status !== "ok") return "unavailable";
  const expectedKind = descriptor.source_role === "minutes" ? "document" : "event";
  const materialized = records.filter((record) => record.record_kind === expectedKind && record.record_id && record.date);
  return materialized.length ? "indexed" : "checked-empty";
}

export { sourceState as classifyCommunityBoardSourceRole };

function sourceRoleReceipt(descriptor, result, records, observedAt) {
  const receipt = sourceReceipt(descriptor, observedAt, result);
  const state = sourceState(descriptor, result, records, observedAt);
  const materialized = records.filter((record) => (
    (descriptor.source_role === "minutes" ? record.record_kind === "document" : record.record_kind === "event")
      && record.record_id && record.date
  ));
  return {
    board_id: descriptor.board_id,
    role: descriptor.source_role,
    source_url: descriptor.url || null,
    adapter: communityBoardSourceAdapterId(descriptor),
    state,
    state_reason: receipt.reason || (state === "checked-empty" ? "no_explicit_records" : null),
    observed_receipt: receipt,
    inventory_receipt: descriptor.verification || null,
    record_count: records.length,
    materialized_record_count: materialized.length,
  };
}

function assertNoDuplicatePublisherIdentifiers(records) {
  const seen = new Map();
  for (const record of records) {
    const identifier = record.publisher_identifier || record.source_record_id || record.record_id;
    if (!identifier) continue;
    const key = `${record.board_id || record.body_id}:${record.source_role || "unknown"}:${identifier}`;
    const previous = seen.get(key);
    if (previous) {
      if (previous.record_url && previous.record_url === record.record_url) continue;
      throw new Error(`duplicate publisher identifier within board: ${key} (${previous.source_url} and ${record.source_url})`);
    }
    seen.set(key, record);
  }
}

function indexedRow(record, board, observedAt) {
  const sourceRecordId = record.source_record_id || record.record_id;
  const sourceUrl = record.record_url || record.source_url;
  const provenance = {
    schema: "cityscroll.community_board_meeting_provenance.v1",
    source_url: sourceUrl,
    source_record_id: sourceRecordId,
    source_index_url: record.source_url,
    observed_receipt: record.observed_receipt || null,
    adapter: record.observed_receipt?.parser || "html_pdf_v1",
  };
  const meeting = normalizeCommunityBoardMeeting({
    source_record_id: sourceRecordId,
    record_id: record.record_id,
    publisher_identifier: record.publisher_identifier || sourceRecordId,
    title: record.title,
    event_date: record.date,
    source_url: sourceUrl,
    source_receipt: record.observed_receipt,
    meeting_origin: "community_board_source_observed",
    board_id: board.id,
    venue: record.address ? { address: record.address, mode: "in-person" } : null,
  });
  const institutionEdge = record.institution_edge || record.community_board_edge || null;
  return {
    ...meeting,
    record_kind: record.record_kind,
    record_id: record.record_id,
    record_url: record.record_url,
    date: record.date,
    title: record.title,
    category: record.category,
    format: record.format,
    publisher_identifier: record.publisher_identifier,
    publisher_identifiers: record.publisher_identifiers,
    source_role: record.source_role || "upcoming_meetings",
    observed_receipt: record.observed_receipt,
    source_record_id: sourceRecordId,
    board_id: board.id,
    board_name: board.name || board.body_name || board.id,
    short_title: meeting.title,
    start_date: observedAt,
    type_of_notice_description: record.category || "Board meeting",
    section_name: "Community Board Meetings",
    meeting_join: {
      schema: JOIN_SCHEMA,
      status: "unknown",
      official: false,
      reason: "no_city_record_notice",
      board_id: board.id,
      meeting_date: record.date,
      source_url: sourceUrl,
      source_record_id: sourceRecordId,
      join: { matched: false, method: JOIN_METHOD, reason: "no_city_record_notice" },
      provenance,
    },
    source_provenance: provenance,
    affected_area: {
      scope: "local",
      boroughs: [board.borough],
      community_boards: [board.id],
      community_districts: [],
      neighborhoods: [],
      addresses: [],
    },
    // Exact typed subjects are the shared scope identity. They do not assert
    // that the board-to-meeting edge is published; that still requires the
    // receipt-backed join above.
    entity_refs_all: [meeting.institution_refs.board_ref, meeting.meeting_id].filter(Boolean),
    institution_edges: institutionEdge ? [institutionEdge] : [],
  };
}

export async function buildCommunityBoardMeetingIndex({ fetchImpl = fetch, observedAt = new Date().toISOString() } = {}) {
  const inventory = readJson(INVENTORY);
  const registry = readJson(REGISTRY);
  const boardById = new Map((inventory.boards || []).map((board) => [board.id, board]));
  const descriptors = sourceDescriptors(inventory, registry);
  const byBoard = {};
  const sourceRecordsByBoard = {};
  const receipts = [];
  let fetched = 0;
  const allRecords = [];
  for (const descriptor of descriptors) {
    const contract = sourceAdapterContract(descriptor);
    const shouldFetch = Boolean(descriptor.url)
      && Boolean(contract)
      && descriptor.verification?.fetchability !== "browser_required";
    const result = shouldFetch
      ? await fetchCommunityBoardSource(descriptor, { fetchImpl, observedAt })
      : { records: [], receipt: sourceReceipt(descriptor, observedAt) };
    if (shouldFetch) fetched += 1;
    const records = result.records.map((record) => ({
      ...record,
      source_role: descriptor.source_role,
      source_url: record.source_url || descriptor.url || null,
    }));
    allRecords.push(...records);
    const roleReceipt = sourceRoleReceipt(descriptor, result, records, observedAt);
    receipts.push(roleReceipt);
    if (records.length) {
      if (!sourceRecordsByBoard[descriptor.board_id]) sourceRecordsByBoard[descriptor.board_id] = [];
      sourceRecordsByBoard[descriptor.board_id].push(...records);
    }
    const board = boardById.get(descriptor.board_id);
    const meetingRows = records
      .filter((record) => descriptor.source_role === "upcoming_meetings")
      .filter((record) => record.record_kind === "event" && record.record_id && record.date)
      .map((record) => indexedRow(record, board, observedAt));
    if (meetingRows.length) byBoard[descriptor.board_id] = [...(byBoard[descriptor.board_id] || []), ...meetingRows];
  }
  assertNoDuplicatePublisherIdentifiers(allRecords);
  const rows = Object.values(byBoard).flat().sort((left, right) => (
    String(left.event_date).localeCompare(String(right.event_date))
    || String(left.board_id).localeCompare(String(right.board_id))
    || String(left.source_record_id).localeCompare(String(right.source_record_id))
  ));
  const institutionEdges = rows.flatMap((row) => row.institution_edges || []);
  return {
    schema: INDEX_SCHEMA,
    generated_at: observedAt,
    source_record_schema: COMMUNITY_BOARD_SOURCE_RECORD_SCHEMA,
    policy: {
      source_inventory: "site/data/non_council_outcome_sources/board_source_inventory.json",
      source_urls_are_explicit: true,
      adapter_scope: "HTML sources with explicit Schema.org Event records",
      no_title_or_date_inference: true,
      unjoined_records_are_not_official: true,
      exact_join_method: JOIN_METHOD,
      source_role_states: SOURCE_STATES,
      event_and_minutes_roles_are_distinct: true,
    },
    coverage: {
      source_urls_checked: fetched,
      boards_indexed: Object.keys(byBoard).length,
      records_indexed: rows.length,
      institution_edges_materialized: institutionEdges.filter((edge) => edge?.status === "promoted" || edge?.status === "official").length,
      boards_in_inventory: inventory.boards.length,
      source_roles_total: receipts.length,
      source_roles_indexed: receipts.filter((row) => row.state === "indexed").length,
      source_roles_checked_empty: receipts.filter((row) => row.state === "checked-empty").length,
      source_roles_unsupported_format: receipts.filter((row) => row.state === "unsupported-format").length,
      source_roles_unavailable: receipts.filter((row) => row.state === "unavailable").length,
      source_roles_stale: receipts.filter((row) => row.state === "stale").length,
      source_roles_not_yet_checked: receipts.filter((row) => row.state === "not-yet-checked").length,
    },
    institution_edges: institutionEdges,
    receipts,
    source_records_by_board: sourceRecordsByBoard,
    by_board: byBoard,
    rows,
  };
}

const check = process.argv.includes("--check");
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (check) {
    if (!existsSync(OUTPUT)) throw new Error("community board meeting index is missing");
    const index = readJson(OUTPUT);
    if (index.schema !== INDEX_SCHEMA || !index.coverage?.records_indexed) throw new Error("community board meeting index is invalid");
    if ((index.rows || []).some((row) => !Array.isArray(row.entity_refs_all)
      || !row.entity_refs_all.includes(row.meeting_id)
      || !row.entity_refs_all.includes(`community-board:${row.board_id}`))) {
      throw new Error("community board meeting rows are missing typed identity references");
    }
    console.log(`checked ${index.coverage.records_indexed} indexed meetings across ${index.coverage.boards_indexed} boards`);
  } else {
    const index = await buildCommunityBoardMeetingIndex();
    writeJson(OUTPUT, index);
    console.log(`wrote ${index.coverage.records_indexed} indexed meetings across ${index.coverage.boards_indexed} boards`);
  }
}
