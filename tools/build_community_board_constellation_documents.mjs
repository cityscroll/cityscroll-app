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
import {
  buildCommunityBoardInstitutionEdges,
  communityBoardMeetingEdgeFromSourceRow,
} from "../site/community_board_institution_edges.mjs";
import { readCommunityBoardMeetingIndex } from "./lib/community_board_meeting_index_io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const LOOKUP = join(SITE, "data/community_board_constellation_lookup.json");
const check = process.argv.includes("--check");

function readJson(relative) {
  if (relative === "site/data/community_board_meeting_index.json") {
    return readCommunityBoardMeetingIndex(join(ROOT, relative));
  }
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function sourceRows() {
  const sourceRegistry = readJson("site/data/non_council_outcome_sources/source_registry.json");
  const sourceInventory = readJson("site/data/non_council_outcome_sources/board_source_inventory.json");
  const meetingIndex = readJson("site/data/community_board_meeting_index.json");
  const scorecard = readJson("site/data/community_board_minutes_scorecard.json");
  const geography = readJson("site/data/community_board_geography_lookup.json");
  const committeeRegistry = readJson("site/data/non_council_outcome_sources/community_board_committees.json");
  const people = readJson("site/data/community_board_people.json");
  const communityBoardBylaws = readJson("site/data/community_board_bylaws.json");
  const communityBoardMoney = readJson("site/data/community_board_money.json");
  const communityBoardPayrollContext = readJson("site/data/community_board_payroll_staff_count.json");
  const communityBoardParticipation = readJson("site/data/community_board_participation.json");
  // The district-project list is an optional enrichment. If its artifact cannot
  // be read, the board pages must say the list failed to load rather than build
  // as though every district had no projects, so the failure is carried
  // forward as a state instead of being swallowed here.
  let communityBoardDistrictProjects;
  try {
    communityBoardDistrictProjects = readJson("site/data/community_board_district_projects.json");
  } catch (error) {
    communityBoardDistrictProjects = { error: `community_board_district_projects unreadable: ${error.message}` };
  }
  // The recorded-position index is read the same way and for the same reason:
  // a board whose positions could not be read must say so rather than build as
  // though this source held nothing for it.
  let communityBoardLandPositions;
  try {
    communityBoardLandPositions = readJson("site/data/community_board_land_positions.json");
  } catch (error) {
    communityBoardLandPositions = { error: `community_board_land_positions unreadable: ${error.message}` };
  }
  // The bounded decision reading is a retained artifact like the others. It is
  // read here rather than at render time so a board page never depends on a
  // publisher. Unlike the enrichments above it fails the build rather than
  // degrading: a board page missing the decisions it is supposed to carry would
  // read as a board that decided nothing, which is the confusion this reading
  // exists to avoid.
  const communityBoardResolutionPilot = readJson("site/data/community_board_resolution_pilot.json");
  // The budget request register is read the same way the enrichments above are,
  // and for the same reason: a board whose requests could not be read must say
  // so rather than build as though this district had asked its agencies for
  // nothing. The header and the per-board documents fail independently, because
  // a missing board document is a different fact from an unreadable register.
  let communityBoardBudgetRegister;
  let communityBoardBudgetRequests = {};
  try {
    communityBoardBudgetRegister = readJson("site/data/community_board_budget_register.json");
    for (const entry of communityBoardBudgetRegister.boards || []) {
      const boardId = String(entry?.board_id || "");
      if (!boardId) continue;
      try {
        communityBoardBudgetRequests[boardId] = readJson(`site/data/community_board_budget_register/${boardId}.json`);
      } catch (error) {
        communityBoardBudgetRequests[boardId] = { error: `community_board_budget_register/${boardId} unreadable: ${error.message}` };
      }
    }
  } catch (error) {
    communityBoardBudgetRegister = { error: `community_board_budget_register unreadable: ${error.message}` };
    communityBoardBudgetRequests = {};
  }
  // The hearing preparation reading covers only the boards someone has
  // confirmed publish an agenda with times. It degrades rather than failing the
  // build, for the same reason the enrichments above do: a board page that
  // could not read this artifact says so, and a board the artifact does not
  // cover simply carries no such section.
  let communityBoardHearingContext;
  try {
    communityBoardHearingContext = readJson("site/data/community_board_hearing_context.json");
  } catch (error) {
    communityBoardHearingContext = { error: `community_board_hearing_context unreadable: ${error.message}` };
  }
  // The reviewed request-to-capital-project links. This one is genuinely
  // optional: an absent or unreadable materialization removes the relation from
  // every request rather than failing the board, because a request with no link
  // renders exactly as it did before the relation existed.
  let communityBoardRequestProjectLinks = null;
  try {
    communityBoardRequestProjectLinks = readJson("site/data/community_board_request_project_links.json");
  } catch (_error) {
    communityBoardRequestProjectLinks = null;
  }
  const institutionEdges = {};
  const edgeKeys = new Set();
  const retainEdge = (edge) => {
    const boardId = String(edge?.parent_board_ref || edge?.from || "").replace(/^community-board:/, "");
    if (!boardId) return;
    const key = edge.relation === "has_committee"
      ? [edge.from, edge.to].join("|")
      : [edge.from, edge.to, edge.source_record_id, edge.status].join("|");
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    institutionEdges[boardId] = [...(institutionEdges[boardId] || []), edge];
  };
  for (const rows of Object.values(meetingIndex.by_board || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const roleReceipt = (meetingIndex.receipts || []).find((receipt) => (
        receipt?.board_id === row.board_id && receipt?.role === "upcoming_meetings"
      ));
      const edgeOptions = {
        asOf: meetingIndex.generated_at,
        sourceRoleState: roleReceipt?.state || "unavailable",
      };
      const carried = [
        ...(Array.isArray(row.institution_edges) ? row.institution_edges : []),
        ...(row.institution_edge ? [row.institution_edge] : []),
      ];
      if (carried.length) carried.forEach((carriedEdge) => {
        retainEdge(communityBoardMeetingEdgeFromSourceRow({
          ...row,
          institution_edge: carriedEdge,
          institution_edges: [],
        }, edgeOptions));
      });
      else {
        const edges = buildCommunityBoardInstitutionEdges([{
          meeting: row,
          source_record: row,
        }], { ...edgeOptions, committeeRegistry });
        edges.forEach(retainEdge);
      }
    }
  }
  for (const edge of Array.isArray(meetingIndex.institution_edges) ? meetingIndex.institution_edges : []) {
    retainEdge(edge);
  }
  return {
    sourceRegistry,
    sourceInventory,
    scorecard,
    geography,
    sourceRecords: meetingIndex.by_board,
    meetingDocuments: meetingIndex.meeting_documents,
    sourceReceipts: meetingIndex.receipts,
    boardRelations: Object.fromEntries(Object.entries(people.boards || {}).map(([boardId, value]) => [
      boardId,
      {
        ...value,
        relationships: (value.relationships || []).map((row) => ({ ...row, board_id: row.board_id || boardId })),
      },
    ])),
    // The meeting index timestamp is a refresh/freshness clock and changes on
    // every rebuild. Constellation lookup summaries use the stable scorecard
    // date so the committed artifact remains byte-idempotent between changes.
    generated_at: scorecard.as_of,
    communityBoardBylaws,
    communityBoardMoney,
    communityBoardPayrollContext,
    communityBoardParticipation,
    communityBoardDistrictProjects,
    communityBoardLandPositions,
    institutionEdges,
    communityBoardResolutionPilot,
    communityBoardBudgetRegister,
    communityBoardBudgetRequests,
    communityBoardHearingContext,
    communityBoardRequestProjectLinks,
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
