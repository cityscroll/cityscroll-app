/** Exact community-board scope links for the Meetings lens. */

import { communityBoardPageHref } from "./community_board_links.mjs";
import { routeHashFromScope, scopeFromRouteHash, scopeWithEntity } from "./scope_v0.mjs";
import { renderCardinalityAdaptiveFacet } from "./cardinality_adaptive_facets.mjs";

const BOARD_REF = /^community-board:([a-z]+(?:-[a-z]+)*-cb-\d{2})$/i;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function escape(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function communityBoardIdFromRef(value) {
  const match = clean(value).match(BOARD_REF);
  return match ? match[1].toLowerCase() : "";
}

function boardRefFromRow(row) {
  const direct = communityBoardIdFromRef(row?.institution_refs?.board_ref);
  if (direct) return `community-board:${direct}`;
  const refs = Array.isArray(row?.entity_refs_all) ? row.entity_refs_all : [];
  const ref = refs.find((value) => communityBoardIdFromRef(value));
  if (ref) return `community-board:${communityBoardIdFromRef(ref)}`;
  const board = clean(row?.board_id).toLowerCase();
  return communityBoardIdFromRef(`community-board:${board}`)
    ? `community-board:${board}` : "";
}

function boardLabel(id, row) {
  const explicit = clean(row?.board_name);
  if (explicit) return explicit;
  const match = String(id || "").match(/^([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/i);
  if (!match) return "Community board";
  const borough = match[1].split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  return `${borough} Community Board ${Number(match[2])}`;
}

function withoutBoardScope(scope) {
  const values = scope.facets.values || {};
  const refs = Array.isArray(values.entity_refs_all)
    ? values.entity_refs_all.filter((ref) => !communityBoardIdFromRef(ref))
    : [];
  if (refs.length) values.entity_refs_all = refs;
  else delete values.entity_refs_all;
  return scope;
}

/** Replace the exact board axis while preserving the rest of the shared scope. */
export function communityBoardScopeHref(surface, boardId, currentHash = `#${surface}`) {
  const id = communityBoardIdFromRef(`community-board:${boardId}`);
  const base = withoutBoardScope(scopeFromRouteHash(currentHash));
  const scoped = id ? scopeWithEntity(base, `community-board:${id}`) : base;
  return routeHashFromScope(scoped, { surface });
}

export function communityBoardRows(rows = []) {
  const choices = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ref = boardRefFromRow(row);
    const id = communityBoardIdFromRef(ref);
    if (!id || choices.has(id)) continue;
    choices.set(id, { id, label: boardLabel(id, row), ref });
  }
  return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function communityBoardScopeLinksHTML({
  surface = "meetings",
  rows = [],
  selected = "",
  currentHash = `#${surface}`,
  label = "Community board",
  allLabel = "All community boards",
  searchQuery = "",
  escape: escapeValue = escape,
} = {}) {
  const selectedId = communityBoardIdFromRef(selected);
  const choices = communityBoardRows(rows).map((choice) => ({
    ...choice,
    scopeEdge: `${surface}.community_board.${choice.id}`,
  }));
  const allHref = communityBoardScopeHref(surface, "", currentHash);
  return renderCardinalityAdaptiveFacet({
    id: `${surface}-board`,
    label,
    choices,
    selectedId,
    allLabel,
    allHref,
    entityHref: (choice) => communityBoardPageHref(choice.id) || "/browse/people/#community-boards",
    scopeHref: (choice) => communityBoardScopeHref(surface, choice.id, currentHash),
    searchQuery,
    escape: escapeValue,
  });
}
