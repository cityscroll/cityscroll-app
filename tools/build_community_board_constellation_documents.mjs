#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
  COMMUNITY_BOARD_CONSTELLATION_METHOD,
  COMMUNITY_BOARD_CONSTELLATION_SCHEMA,
} from "../site/community_board_constellation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const LOOKUP = join(SITE, "data/community_board_constellation_lookup.json");
const check = process.argv.includes("--check");

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function sourceRows() {
  const sourceRegistry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const sourceInventory = readJson("site/data/non_council_outcome_sources/board_source_inventory.json");
  const meetingIndex = readJson("site/data/community_board_meeting_index.json");
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  const geography = readJson("site/data/community_board_geography_lookup.json");
  const institutionEdges = Object.fromEntries(Object.entries(meetingIndex.by_board || {}).map(([boardId, rows]) => [
    boardId,
    (Array.isArray(rows) ? rows : []).flatMap((row) => [
      ...(Array.isArray(row.institution_edges) ? row.institution_edges : []),
      ...(row.institution_edge ? [row.institution_edge] : []),
    ]),
  ]).filter(([, edges]) => edges.length));
  for (const edge of Array.isArray(meetingIndex.institution_edges) ? meetingIndex.institution_edges : []) {
    const boardId = String(edge?.from || "").replace(/^community-board:/, "");
    if (!boardId) continue;
    institutionEdges[boardId] = [...(institutionEdges[boardId] || []), edge];
  }
  return {
    sourceRegistry,
    sourceInventory,
    scorecard,
    geography,
    sourceRecords: meetingIndex.by_board,
    meetingDocuments: meetingIndex.meeting_documents,
    sourceReceipts: meetingIndex.receipts,
    generated_at: meetingIndex.generated_at,
    institutionEdges,
  };
}

export function buildCommunityBoardConstellationMaterialization(sources = sourceRows()) {
  const boards = sources.sourceRegistry.sources.filter((row) => row.body_type === "community_board");
  const byId = {};
  const documents = [];
  for (const board of boards) {
    const view = buildCommunityBoardConstellationView(board.body_id, sources);
    if (!view) continue;
    byId[board.body_id] = {
      body_id: view.body_id,
      display_name: view.display_name,
      path: view.path,
      summary: view.summary,
      edge_summary: view.edge_summary,
    };
    documents.push([
      join(SITE, "community-boards", board.body_id, "index.html"),
      renderCommunityBoardConstellationDocument(view),
    ]);
  }
  const lookup = {
    schema: COMMUNITY_BOARD_CONSTELLATION_SCHEMA,
    method: COMMUNITY_BOARD_CONSTELLATION_METHOD,
    generated_at: sources.scorecard.as_of || null,
    board_count: Object.keys(byId).length,
    by_id: byId,
  };
  return { lookup, documents };
}

export function writeCommunityBoardConstellationArtifacts({ check: shouldCheck = check } = {}) {
  const { lookup, documents } = buildCommunityBoardConstellationMaterialization();
  const lookupJson = `${JSON.stringify(lookup, null, 2)}\n`;
  let stale = 0;
  if (!existsSync(LOOKUP) || readFileSync(LOOKUP, "utf8") !== lookupJson) {
    stale += 1;
    if (!shouldCheck) {
      mkdirSync(dirname(LOOKUP), { recursive: true });
      writeFileSync(LOOKUP, lookupJson);
    }
  }
  for (const [path, content] of documents) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      stale += 1;
      if (!shouldCheck) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }
  }
  if (shouldCheck && stale) throw new Error(`${stale} community board constellation artifact(s) are stale; rebuild with node tools/build_community_board_constellation_documents.mjs`);
  console.log(shouldCheck
    ? `Community board constellation documents are current (${documents.length} pages)`
    : `Community board constellation documents built (${documents.length} pages)`);
  return { lookup, documents, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeCommunityBoardConstellationArtifacts();
