#!/usr/bin/env node
/**
 * Bounded per-board budget-request lookup for the Near You overview.
 *
 * The register documents are too heavy to read on a resident request, so this
 * builder projects each supported board's servable population — the same
 * reading `communityBoardBudgetRequestsForBoard` holds — into one committed
 * lookup: per-board state (including retained failures), counts, and the same
 * deterministic preview the overview shows. The Worker loads it lazily, so it
 * stays off the startup JSON graph exactly like the board activity lookup.
 *
 * Usage:
 *   node tools/build_community_board_budget_requests_lookup.mjs           # write
 *   node tools/build_community_board_budget_requests_lookup.mjs --check   # verify
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUDGET_REQUEST_STATES,
  COMMUNITY_BOARD_BUDGET_REQUESTS_LOOKUP_SCHEMA,
  NEAR_YOU_BOARD_BUDGET_REQUESTS_PREVIEW_LIMIT,
  communityBoardBudgetRequestsForBoard,
  selectNearYouBoardBudgetRequestRows,
} from "../site/community_board_budget_requests.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/data/community_board_budget_requests_lookup.json");
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

/**
 * The preview row a lookup carries: exactly what the Near You projection reads.
 * The publisher's answer text stays on the board page; here only the fact that
 * the shown publication carries a written answer is retained, because that is
 * the whole of the answer context the overview states.
 */
function previewRow(row) {
  return {
    tracking_code: row.tracking_code,
    anchor: row.anchor,
    title: row.title,
    fiscal_year: row.fiscal_year,
    request_class: row.request_class,
    agency: {
      source_label: row.agency.source_label,
      agency_id: row.agency.agency_id,
      href: row.agency.href,
      binding: row.agency.binding,
    },
    latest_answer: row.latest_answer
      ? {
        publication: row.latest_answer.publication,
        publication_date: row.latest_answer.publication_date,
        answered: row.latest_answer.response != null && String(row.latest_answer.response).trim() !== "",
      }
      : null,
  };
}

export function buildCommunityBoardBudgetRequestsLookup(inputs = {}) {
  const geography = inputs.geography || readJson("site/data/community_board_geography_lookup.json");
  const registerIndex = inputs.registerIndex || readJson("site/data/community_board_budget_register.json");
  const boardIds = inputs.boardIds || boardIdsFromGeography(geography);
  const byBoard = {};

  for (const boardId of boardIds) {
    let document = null;
    try {
      document = inputs.documents?.[boardId] !== undefined
        ? inputs.documents[boardId]
        : readJson(`site/data/community_board_budget_register/${boardId}.json`);
    } catch {
      document = null;
    }
    const view = communityBoardBudgetRequestsForBoard(registerIndex, document, boardId);
    if (!view) continue;
    byBoard[boardId] = {
      board_id: boardId,
      state: view.state,
      request_count: view.request_count,
      agency_count: view.agency_count,
      changed_answer_count: view.changed_answer_count,
      fiscal_years: view.fiscal_years,
      ...(view.state === BUDGET_REQUEST_STATES.UNAVAILABLE
        ? { unavailable_reason: document?.unavailable_reason || registerIndex?.unavailable_reason || "budget register read failed" }
        : {}),
      // The preview is bounded and deterministic, so the committed lookup and
      // the board page can never disagree about which requests lead.
      requests: selectNearYouBoardBudgetRequestRows(view, { limit: NEAR_YOU_BOARD_BUDGET_REQUESTS_PREVIEW_LIMIT })
        .map(previewRow),
    };
  }

  return {
    schema: COMMUNITY_BOARD_BUDGET_REQUESTS_LOOKUP_SCHEMA,
    generated_at: registerIndex.materialized_at || registerIndex.acquired_at || null,
    board_count: Object.keys(byBoard).length,
    source: {
      publisher: registerIndex.source?.publisher || null,
      name: registerIndex.source?.name || null,
      source_url: registerIndex.source?.source_url || null,
      dataset_id: registerIndex.source?.dataset_id || null,
      as_of: registerIndex.publication_selection?.as_of || null,
    },
    publication_selection: {
      as_of: registerIndex.publication_selection?.as_of || null,
      servable: registerIndex.publication_selection?.servable || [],
    },
    publications: registerIndex.publications || [],
    by_board: byBoard,
  };
}

export function writeCommunityBoardBudgetRequestsLookup({ check: shouldCheck = check } = {}) {
  const lookup = buildCommunityBoardBudgetRequestsLookup();
  const json = `${JSON.stringify(lookup, null, 2)}\n`;
  const stale = !existsSync(OUT) || readFileSync(OUT, "utf8") !== json;
  if (shouldCheck && stale) {
    throw new Error("site/data/community_board_budget_requests_lookup.json is stale; rebuild with node tools/build_community_board_budget_requests_lookup.mjs");
  }
  if (!shouldCheck && stale) {
    writeFileSync(OUT, json);
  }
  console.log(shouldCheck
    ? `Community board budget requests lookup is current (${lookup.board_count} boards)`
    : `Community board budget requests lookup built (${lookup.board_count} boards)`);
  return { lookup, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeCommunityBoardBudgetRequestsLookup();
}
