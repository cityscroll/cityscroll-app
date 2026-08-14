/**
 * Community-board constellation view model and document renderer.
 *
 * The board is an organization with a place projection. This adapter reuses
 * the agency constellation's typed edge-summary, local-neighborhood, and
 * civic-document grammar; it does not create a board-specific edge format.
 */

import { officialSourceLink } from "./affordance_grammar.mjs";
import {
  EDGE_SUMMARY_STATE_MEANINGS,
  edgeSummaryStateCopy,
  renderEdgeSummaryRail,
  normalizeEdgeSummaryRecords,
} from "./edge_summary.mjs";
import {
  renderCivicDocumentAssets,
  renderCivicDocumentMast,
  renderNodeActions,
  renderNodeBack,
  renderNodeFooter,
  renderNodeSection,
} from "./civic_document_chrome.mjs";
import { buildLocalConstellation, renderLocalConstellationHTML } from "./local_constellation.mjs";
import {
  communityBoardRelationAvailability,
  promotedCommunityBoardRelationEdges,
} from "./community_board_relations.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";

export const COMMUNITY_BOARD_CONSTELLATION_SCHEMA = "cityscroll.community_board_constellation.v1";
export const COMMUNITY_BOARD_CONSTELLATION_METHOD = "community_board_constellation_v1";

export const COMMUNITY_BOARD_CONSTELLATION_CATEGORIES = Object.freeze([
  Object.freeze({ id: "place", label: "District coverage", relation: "covers", target_kind: "community-district" }),
  Object.freeze({ id: "sources", label: "Official source inventory", relation: "published_board_source", target_kind: "source" }),
  Object.freeze({ id: "meetings", label: "Meetings and hearings", relation: "hosts_meeting", target_kind: "meeting" }),
  Object.freeze({ id: "members", label: "Board members", relation: "has_member", target_kind: "official" }),
  Object.freeze({ id: "recommendations", label: "Board recommendations", relation: "issues_recommendation", target_kind: "recommendation" }),
]);

const SOURCE_ROLE_LABELS = Object.freeze({
  upcoming_meetings: "Upcoming meetings",
  minutes: "Minutes and records",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function bodyId(value) {
  const id = clean(value, 80).toLowerCase();
  return /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/.test(id) ? id : null;
}

export function communityBoardPath(value) {
  return communityBoardPageHref(value);
}

export function communityBoardPlaceHref(board = {}) {
  const district = clean(board.community_district_id || board.communityDistrict, 20);
  if (!district) return "/near-you/";
  return `/near-you/#map?level=community_district&parent=${encodeURIComponent(clean(board.borough, 80))}&id=${encodeURIComponent(district)}&lens=meetings`;
}

export function communityBoardInstitutionHref(value) {
  return communityBoardPageHref(value);
}

export function communityBoardOutputHref(value) {
  const id = bodyId(value);
  return id ? `/community-boards/#board-${encodeURIComponent(id)}` : "/community-boards/";
}

function registrySource(board) {
  return {
    kind: "community board source registry",
    id: board.body_id,
    name: "Community board source registry",
    canonical_href: board.directory_url || board.homepage_url || null,
  };
}

function sourceRows(scorecardRow, inventoryRow) {
  const scored = scorecardRow?.sources || {};
  const inventory = inventoryRow?.source_roles || {};
  return Object.keys(SOURCE_ROLE_LABELS).map((role) => {
    const source = scored[role] || inventory[role] || {};
    return {
      role,
      label: SOURCE_ROLE_LABELS[role],
      url: source.source_url || source.url || null,
      state: source.collection_state || (source.url ? "observed" : "absent_in_pass"),
      publisher: source.publisher || null,
      observed_on: source.observed_on || source.seen_on || null,
      origin_label: source.origin_label || source.publisher || null,
    };
  });
}

function boardNode(geography, id) {
  return (geography?.nodes || []).find((node) => node?.type === "community-board" && node?.properties?.body_id === id)
    || (geography?.nodes || []).find((node) => node?.id === `community-board:${id}`)
    || null;
}

function sourceRecordRows(records = []) {
  const rows = Array.isArray(records) ? records : records?.records || [];
  return rows.filter((record) => record && (record.record_id || record.source_record_id)).map((record) => ({
    ...record,
    label: record.record_kind === "video"
      ? "Meeting video"
      : record.record_kind === "event"
        ? (record.category || "Board meeting")
        : "Minutes and records",
    state: record.status === "official" || record.join?.matched === true
      ? "official"
      : record.observed_receipt?.status === "ok"
        ? "observed"
        : "unknown",
    href: record.record_url || record.source_url || null,
  }));
}

function relationItem(edge, kind) {
  return {
    ...edge,
    href: kind === "member" && /^official:\d+$/.test(edge.to || "")
      ? `/officials/${encodeURIComponent(edge.target_id)}/`
      : null,
    date: edge.relation_date,
    source_document: edge.source_document,
    label: edge.target_name || edge.target_id,
    state: "official",
  };
}

function buildCategory(spec, board, source, districtEdge, sourceRowsForBoard, sourceRecordRowsForBoard, relationEdges) {
  const sourceHref = registrySource(board);
  if (spec.id === "place") {
    const districtId = clean(districtEdge?.to || "").replace(/^community-district:/, "");
    const target = districtId || board.community_district_id;
    const href = target ? communityBoardPlaceHref({ ...board, community_district_id: target }) : null;
    return {
      ...spec,
      status: target && href ? "matched" : "unknown",
      count: target && href ? 1 : null,
      target_name: target ? `${board.borough} Community District ${target}` : "Community district",
      view_all_href: href,
      source: sourceHref,
      provenance: districtEdge?.provenance || null,
      items: target && href ? [{ label: `${board.borough} Community District ${target}`, href, target_id: target, source: sourceHref }] : [],
    };
  }
  if (spec.id === "sources") {
    const count = sourceRowsForBoard.filter((row) => row.url).length;
    return {
      ...spec,
      status: count ? "matched" : "empty",
      count,
      target_name: "Official source inventory",
      view_all_href: communityBoardOutputHref(board.body_id),
      source: { ...sourceHref, name: "Official source inventory", canonical_href: communityBoardOutputHref(board.body_id) },
      provenance: source?.provenance || null,
      items: sourceRowsForBoard,
    };
  }
  if (spec.id === "meetings") {
    const joined = sourceRecordRowsForBoard.filter((row) => row.state === "official");
    return {
      ...spec,
      status: joined.length ? "matched" : "unknown",
      count: joined.length || null,
      target_name: "Meetings and hearings",
      view_all_href: joined.length ? joined[0].href : null,
      source: sourceHref,
      provenance: joined[0]?.provenance || source?.provenance || null,
      items: joined,
    };
  }
  if (spec.id === "members" || spec.id === "recommendations") {
    const kind = spec.id === "members" ? "member" : "recommendation";
    const edges = relationEdges?.[spec.id] || [];
    const availability = communityBoardRelationAvailability(sourceRowsForBoard, kind);
    return {
      ...spec,
      status: edges.length ? "matched" : "unknown",
      source_state: edges.length ? "observed" : availability.state,
      count: edges.length || null,
      target_name: spec.label,
      view_all_href: null,
      source: sourceHref,
      provenance: edges[0]?.provenance || source?.provenance || null,
      pending_reason: edges.length ? null : availability.reason,
      items: edges.map((edge) => relationItem(edge, kind)),
    };
  }
  return {
    ...spec,
    status: "unknown",
    count: null,
    target_name: spec.label,
    view_all_href: null,
    source: sourceHref,
    provenance: source?.provenance || null,
    items: [],
  };
}

export function buildCommunityBoardEdgeSummary(viewOrCategories) {
  const categories = Array.isArray(viewOrCategories) ? viewOrCategories : viewOrCategories?.categories || [];
  const sourceId = viewOrCategories?.body_id || viewOrCategories?.id || null;
  return normalizeEdgeSummaryRecords(categories.map((category) => ({
    source_kind: "community-board",
    source_id: sourceId,
    edge_type: category.relation,
    relation_label: category.id === "place"
      ? "District coverage"
      : category.id === "sources"
        ? "Official source inventory"
        : category.label,
    target_kind: category.target_kind,
    target_id: category.id === "place" ? category.items?.[0]?.target_id || null : null,
    target_name: category.target_name,
    count: category.count,
    state: category.status,
    href: category.status === "matched" ? category.view_all_href : null,
    scope: { board: sourceId },
    source: category.source,
    provenance: category.provenance,
  })));
}

export function buildCommunityBoardConstellationView(idOrName, sources = {}) {
  const requested = bodyId(idOrName);
  const registryBoard = (sources.sourceRegistry?.sources || []).find((row) => row?.body_id === requested)
    || (sources.boards || []).find((row) => row?.body_id === requested)
    || null;
  const node = boardNode(sources.geography, requested);
  const board = registryBoard || (node ? {
    body_id: requested,
    name: node.name,
    borough: node.properties?.borough,
    district: node.properties?.district,
    community_district_id: node.properties?.community_district_id,
    directory_url: node.properties?.directory_url,
    homepage_url: node.properties?.homepage_url,
  } : null);
  if (!requested || !board) return null;
  const districtEdge = (sources.geography?.public_edges || []).find((edge) => edge?.type === "covers" && edge.from === `community-board:${requested}`);
  const districtId = clean(districtEdge?.to || "").replace(/^community-district:/, "");
  const normalizedBoard = { ...board, community_district_id: districtId || board.community_district_id || null };
  const scorecardRow = (sources.scorecard?.rows || []).find((row) => row?.body_id === requested);
  const inventoryRow = (sources.sourceInventory?.boards || []).find((row) => row?.id === requested || row?.body_id === requested);
  const boardSources = sourceRows(scorecardRow, inventoryRow || board);
  const boardSourceRecords = sourceRecordRows(
    sources.sourceRecords?.[requested]
      || (Array.isArray(sources.sourceRecords) ? sources.sourceRecords : sources.sourceRecords?.records)
      || [],
  );
  const relationInput = sources.boardRelations?.[requested]
    || sources.relations?.[requested]
    || {};
  const relationEdges = promotedCommunityBoardRelationEdges(relationInput);
  const categories = COMMUNITY_BOARD_CONSTELLATION_CATEGORIES.map((spec) => buildCategory(
    spec,
    normalizedBoard,
    node,
    districtEdge,
    boardSources,
    boardSourceRecords,
    relationEdges,
  ));
  const edgeSummary = buildCommunityBoardEdgeSummary({ body_id: requested, categories });
  const localConstellation = buildLocalConstellation({
    kind: "community-board",
    subject_ref: `community-board:${requested}`,
    subject_id: requested,
    subject_name: normalizedBoard.name,
    source: registrySource(normalizedBoard),
    provenance: { method: COMMUNITY_BOARD_CONSTELLATION_METHOD },
    neighbors: edgeSummary,
  });
  return {
    schema: COMMUNITY_BOARD_CONSTELLATION_SCHEMA,
    kind: "community-board-constellation",
    id: requested,
    body_id: requested,
    path: communityBoardPath(requested),
    subject_ref: `community-board:${requested}`,
    display_name: normalizedBoard.name,
    board: normalizedBoard,
    source_records: boardSourceRecords,
    categories,
    edge_summary: edgeSummary,
    local_constellation: localConstellation,
    summary: {
      matched_categories: categories.filter((category) => category.status === "matched").length,
      category_count: categories.length,
      generated_at: sources.generated_at || sources.scorecard?.as_of || null,
      method: COMMUNITY_BOARD_CONSTELLATION_METHOD,
    },
  };
}

function sourceMarkup(row) {
  const link = row.url
    ? officialSourceLink({ href: row.url, label: row.role === "upcoming_meetings" ? "Open official calendar" : "Open minutes or records", className: "board-source-link", escape: esc })
    : `<span class="node-muted">Source not listed</span>`;
  const state = row.state === "not_yet_ingested" ? "Source available" : row.state === "absent_in_pass" ? "Source not listed" : "Source observed";
  return `<li class="node-record" data-source-type="${esc(row.role)}"><div class="node-record-main"><strong>${esc(row.label)}</strong> ${link}</div><span class="muted node-muted">${esc(state)}${row.origin_label ? ` · ${esc(row.origin_label)}` : ""}</span></li>`;
}

function categoryStatus(category) {
  if (category.source_state === "not_yet_ingested") return "Not yet shown — official board records are still being collected";
  return edgeSummaryStateCopy({ state: category.status, count: category.count });
}

function relationRecordMarkup(row, kind) {
  const document = row.source_document || {};
  const link = document.url
    ? officialSourceLink({ href: document.url, label: "Open the source document", className: "board-source-link", escape: esc })
    : "";
  const date = row.date ? `Dated ${esc(row.date)}` : "Dated source record";
  const subject = kind === "member" ? "Board member" : "Board recommendation";
  const evidence = kind === "member"
    ? "The board identity, member identity, date, and source document matched exactly."
    : "The board identity, recommendation identity, date, and source document matched exactly.";
  return `<li class="node-record" data-board-relation="${esc(row.relation)}"><div class="node-record-main"><strong>${row.href ? `<a href="${esc(row.href)}">${esc(row.label)}</a>` : esc(row.label)}</strong></div><span class="muted node-muted">${esc(subject)} · ${date}</span><details class="inline-disclose board-relation-details"><summary>How confirmed</summary><div class="inline-disclose-body"><p>${esc(evidence)}</p><p>${link}</p></div></details></li>`;
}

function renderCategory(category) {
  const availability = EDGE_SUMMARY_STATE_MEANINGS[category.status] || EDGE_SUMMARY_STATE_MEANINGS.unknown;
  const body = category.id === "sources"
    ? `<ul class="node-record-list">${category.items.map(sourceMarkup).join("")}</ul>`
    : category.id === "meetings" && category.items?.length
      ? `<ul class="node-record-list">${category.items.map(sourceRecordMarkup).join("")}</ul>`
      : ["members", "recommendations"].includes(category.id) && category.items?.length
        ? `<ul class="node-record-list">${category.items.map((row) => relationRecordMarkup(row, category.id === "members" ? "member" : "recommendation")).join("")}</ul>`
        : ["members", "recommendations"].includes(category.id) && category.source_state === "not_yet_ingested"
          ? `<p class="node-muted" data-edge-state="unknown" data-edge-availability="pending">${esc(category.pending_reason)}</p>`
    : `<p class="node-muted" data-edge-state="${esc(category.status)}" data-edge-availability="${esc(availability)}">${esc(categoryStatus(category))}</p>`;
  return renderNodeSection({
    heading: `${category.label} (${categoryStatus(category)})`,
    extraClass: "node-card civic-object-section",
    attrs: {
      "data-community-board-constellation-category": category.id,
      "data-edge-state": category.status,
      "data-edge-availability": availability,
    },
    body,
  });
}

function sourceRecordMarkup(row) {
  const label = row.href
    ? officialSourceLink({ href: row.href, label: row.title || row.label, className: "board-source-link", escape: esc })
    : `<span>${esc(row.title || row.label)}</span>`;
  const date = row.date ? ` · ${esc(row.date)}` : "";
  const state = row.state === "official" ? "Official board record" : row.state === "observed" ? "Source observed" : "Source status unknown";
  return `<li class="node-record" data-source-record-kind="${esc(row.record_kind || "record")}"><div class="node-record-main"><strong>${label}</strong></div><span class="muted node-muted">${esc(row.label)}${date} · ${esc(state)}</span></li>`;
}

function renderSourceRecordSection(records = []) {
  if (!records.length) return "";
  return renderNodeSection({
    heading: "Board records from official sources",
    extraClass: "node-card civic-object-section",
    attrs: { "data-community-board-source-records": "1" },
    body: `<ul class="node-record-list">${records.map(sourceRecordMarkup).join("")}</ul>`,
  });
}

export function renderCommunityBoardConstellationDocument(view, options = {}) {
  if (!view || view.kind !== "community-board-constellation") throw new Error("Unknown community board constellation view");
  const title = view.display_name;
  const payload = JSON.stringify(view).replace(/<\/script/gi, "<\\/script");
  const place = view.categories.find((category) => category.id === "place");
  const institution = communityBoardInstitutionHref(view.body_id);
  const output = communityBoardOutputHref(view.body_id);
  const edgeRail = renderEdgeSummaryRail(view.edge_summary, {
    heading: "Connected board records",
    id: "community-board-edge-summary-heading",
    className: "community-board-edge-summary",
  });
  const local = renderLocalConstellationHTML(view.local_constellation, {
    heading: "Nearby board records",
    id: "community-board-local-constellation-heading",
  });
  const actions = renderNodeActions([
    { kind: "link", label: "Open the place view", href: place?.view_all_href || "/near-you/", primary: true, className: "civic-object-action" },
    { kind: "link", label: "Open the board institution", href: institution, className: "civic-object-action" },
    { kind: "link", label: "Open the source directory", href: output, className: "civic-object-action" },
    { kind: "button", label: "Copy link", attrs: { "data-object-copy": true }, className: "civic-object-action" },
    { kind: "button", label: "Print / save PDF", attrs: { "data-object-print": true }, className: "civic-object-action" },
    { kind: "button", label: "Download JSON", attrs: { "data-object-export": "json" }, className: "civic-object-action" },
  ], { ariaLabel: "Document actions", exportClass: "object_actions", extraClass: "civic-object-actions" });
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Community board constellation · CityScroll</title>
<meta name="description" content="${esc(`Public source and place connections for ${title}.`)}">
<link rel="canonical" href="https://cityscroll.org${esc(view.path)}">${renderCivicDocumentAssets(assetPrefix)}
<link rel="stylesheet" href="${esc(`${prefix}local_constellation.css`)}"></head><body>
<a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
<main id="main" class="node-document civic-object-document" data-civic-object-kind="community-board-constellation" data-subject-ref="${esc(view.subject_ref)}" data-node-document="1">
${renderNodeBack({ href: "/community-boards/", label: "Back to community board sources", extraClass: "civic-object-back" })}
<header class="node-hero civic-object-hero" data-export-class="object_identity"><p class="node-kicker civic-object-kicker">Community board constellation</p><h1>${esc(title)}</h1><p class="node-lede">Public source records and the district this board covers, with institutional records shown when they are joined.</p><p class="node-pivot civic-object-pivot"><a href="${esc(place?.view_all_href || "/near-you/")}">Open this board’s place view</a> · <a href="${esc(institution)}">Open this board institution</a> · <a href="${esc(output)}">Open the source directory</a></p></header>
${edgeRail}${local}${actions}${renderSourceRecordSection(view.source_records)}${view.categories.map(renderCategory).join("")}
</main>${renderNodeFooter({ extraClass: "civic-object-footer" })}
<script id="civic-object-payload" type="application/json">${payload}</script><script defer src="${esc(`${prefix}export_workflows.js`)}"></script>
</body></html>`;
}
