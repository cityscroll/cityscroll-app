#!/usr/bin/env node
/**
 * Slim per-board activity lookup for Near You overview projection.
 *
 * Reuses the canonical composeCommunityBoardActivity inputs already retained
 * for board pages. The lookup is request-lazy on the Worker so it stays off the
 * startup JSON graph.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COMMUNITY_BOARD_ACTIVITY_LIMIT,
  COMMUNITY_BOARD_ACTIVITY_LOOKUP_SCHEMA,
  composeCommunityBoardActivity,
} from "../site/community_board_activity.mjs";
import { communityBoardBudgetRequestsForBoard } from "../site/community_board_budget_requests.mjs";
import { communityBoardLandPositionsForBoard } from "../site/community_board_land_positions.mjs";
import { communityBoardPageHref } from "../site/community_board_links.mjs";
import { communityBoardResolutionViewForBoard } from "../site/community_board_resolution_pilot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "data/community_board_activity_lookup.json");
const check = process.argv.includes("--check");

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function boardIdsFromGeography(geography) {
  return (geography.nodes || [])
    .filter((node) => node?.type === "community-board" && node?.properties?.body_id)
    .map((node) => String(node.properties.body_id).toLowerCase())
    .sort();
}

function dayPrefix(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function meetingDateFromEdge(row = {}) {
  const fromId = String(row.target_id || row.to || row.meeting_id || "").match(/(\d{4}-\d{2}-\d{2})/);
  return dayPrefix(row.effective_date)
    || dayPrefix(row.date)
    || dayPrefix(row.meeting_date)
    || dayPrefix(row.relation_date)
    || dayPrefix(row.join?.event_date)
    || dayPrefix(row.source_entry_evidence?.locator?.date)
    || dayPrefix(fromId?.[1]);
}

/**
 * Normalize retained hosts_meeting edges so compose can date and title them
 * without changing board-page meetingRows behavior for constellation fixtures.
 */
function normalizeMeetingEdgeForActivity(edge) {
  if (!edge || edge.relation !== "hosts_meeting") return edge;
  return {
    ...edge,
    meeting_date: meetingDateFromEdge(edge),
    title: edge.target_name || edge.title || edge.name || edge.label,
    source_url: edge.source_url || edge.source_receipt?.source_url || edge.provenance?.source_url,
    observed_through: dayPrefix(edge.observed_through)
      || dayPrefix(edge.source_receipt?.observed_at)
      || dayPrefix(edge.provenance?.observed_receipt?.observed_at)
      || edge.observed_through,
  };
}

function edgesForBoard(meetingIndex, boardId) {
  const ref = `community-board:${boardId}`;
  return (Array.isArray(meetingIndex.institution_edges) ? meetingIndex.institution_edges : [])
    .filter((edge) => edge?.from === ref || edge?.institution_refs?.board_ref === ref)
    .map(normalizeMeetingEdgeForActivity);
}

function sourceForBoard(meetingIndex, boardId, budget) {
  const coverage = Array.isArray(meetingIndex.board_coverage)
    ? meetingIndex.board_coverage.find((row) => row?.board_id === boardId)
    : null;
  const edge = edgesForBoard(meetingIndex, boardId)[0];
  return {
    source_url: coverage?.meetings?.source_url
      || coverage?.minutes?.source_url
      || edge?.source_url
      || budget?.source?.source_url
      || budget?.source?.url
      || "https://www.nyc.gov/",
    observed_through: String(
      coverage?.meetings?.observed_at
      || coverage?.minutes?.observed_at
      || edge?.source_receipt?.observed_at
      || budget?.source?.observed_on
      || meetingIndex.generated_at
      || "",
    ).slice(0, 10) || null,
  };
}

export function buildCommunityBoardActivityLookup(inputs = {}) {
  const geography = inputs.geography || readJson("site/data/community_board_geography_lookup.json");
  const meetingIndex = inputs.meetingIndex || readJson("site/data/community_board_meeting_index.json");
  const resolutionPilot = inputs.resolutionPilot || readJson("site/data/community_board_resolution_pilot.json");
  const landPositions = inputs.landPositions || readJson("site/data/community_board_land_positions.json");
  const budgetRegister = inputs.budgetRegister || readJson("site/data/community_board_budget_register.json");
  const boardIds = inputs.boardIds || boardIdsFromGeography(geography);
  const byBoard = {};

  for (const boardId of boardIds) {
    let budgetDoc = null;
    try {
      budgetDoc = readJson(`site/data/community_board_budget_register/${boardId}.json`);
    } catch {
      budgetDoc = null;
    }
    const budget = budgetDoc
      ? communityBoardBudgetRequestsForBoard(budgetRegister, budgetDoc, boardId)
      : null;
    const source = sourceForBoard(meetingIndex, boardId, budget);
    const activity = composeCommunityBoardActivity({
      board_id: boardId,
      board_href: communityBoardPageHref(boardId),
      source,
      institution_edges: edgesForBoard(meetingIndex, boardId),
      board_decisions: communityBoardResolutionViewForBoard(resolutionPilot, boardId),
      land_positions: communityBoardLandPositionsForBoard(landPositions, boardId),
      budget_requests: budget,
    }, {
      board_id: boardId,
      board_href: communityBoardPageHref(boardId),
      limit: COMMUNITY_BOARD_ACTIVITY_LIMIT,
    });
    byBoard[boardId] = {
      board_id: boardId,
      total_count: activity.total_count,
      limit: activity.limit,
      coverage: activity.coverage,
      entries: activity.entries.map((entry) => ({
        id: entry.id,
        action_type: entry.action_type,
        title: entry.title,
        effective_date: entry.effective_date,
        canonical_href: entry.canonical_href,
        source_url: entry.source_url,
        observed_through: entry.observed_through,
        board_id: entry.board_id,
      })),
    };
  }

  return {
    schema: COMMUNITY_BOARD_ACTIVITY_LOOKUP_SCHEMA,
    generated_at: meetingIndex.generated_at || null,
    board_count: boardIds.length,
    by_board: byBoard,
  };
}

export function writeCommunityBoardActivityLookup({ check: shouldCheck = check } = {}) {
  const lookup = buildCommunityBoardActivityLookup();
  const json = `${JSON.stringify(lookup, null, 2)}\n`;
  const stale = !existsSync(OUT) || readFileSync(OUT, "utf8") !== json;
  if (shouldCheck && stale) {
    throw new Error("site/data/community_board_activity_lookup.json is stale; rebuild with node tools/build_community_board_activity_lookup.mjs");
  }
  if (!shouldCheck && stale) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, json);
  }
  console.log(shouldCheck
    ? `Community board activity lookup is current (${lookup.board_count} boards)`
    : `Community board activity lookup built (${lookup.board_count} boards)`);
  return { lookup, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeCommunityBoardActivityLookup();
}
