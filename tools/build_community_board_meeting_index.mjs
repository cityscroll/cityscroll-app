#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchCommunityBoardSource,
  COMMUNITY_BOARD_SOURCE_RECORD_SCHEMA,
} from "../site/community_board_source_adapters.mjs";
import { normalizeCommunityBoardMeeting } from "../site/meeting_object_contract.mjs";

const ROOT = join(import.meta.dirname, "..");
const INVENTORY = join(ROOT, "site/data/non_council_outcome_sources/board_source_inventory.json");
const REGISTRY = join(ROOT, "site/data/non_council_outcome_sources/source_registry.json");
const OUTPUT = join(ROOT, "site/data/community_board_meeting_index.json");
const INDEX_SCHEMA = "cityscroll.community_board_meeting_index.v1";
const JOIN_SCHEMA = "cityscroll.community_board_source_join.v1";
const JOIN_METHOD = "exact_board_date_publisher_identifier";

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function clean(value, max = 500) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function sourceDescriptors(inventory, registry) {
  const boardNames = new Map((registry.sources || [])
    .filter((row) => row.body_type === "community_board")
    .map((row) => [row.body_id, row.name]));
  return (inventory.boards || []).flatMap((board) => {
    const source = board.upcoming;
    if (!source?.url) return [];
    return [{
      ...source,
      adapter: "html_pdf_v1",
      role: "upcoming_meetings",
      board_id: board.id,
      body_id: board.id,
      body_name: boardNames.get(board.id) || board.name,
    }];
  });
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
  const receipts = [];
  let fetched = 0;
  for (const descriptor of descriptors) {
    const result = await fetchCommunityBoardSource(descriptor, { fetchImpl, observedAt });
    fetched += 1;
    receipts.push({
      board_id: descriptor.board_id,
      source_url: descriptor.url,
      observed_receipt: result.receipt,
      record_count: result.records.length,
    });
    const board = boardById.get(descriptor.board_id);
    const records = result.records
      .filter((record) => record.record_kind === "event" && record.record_id && record.date)
      .map((record) => indexedRow(record, board, observedAt));
    if (records.length) byBoard[descriptor.board_id] = records;
  }
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
    },
    coverage: {
      source_urls_checked: fetched,
      boards_indexed: Object.keys(byBoard).length,
      records_indexed: rows.length,
      institution_edges_materialized: institutionEdges.filter((edge) => edge?.status === "promoted" || edge?.status === "official").length,
      boards_in_inventory: inventory.boards.length,
    },
    institution_edges: institutionEdges,
    receipts,
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
