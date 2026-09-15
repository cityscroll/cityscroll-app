/**
 * Resident-facing projection of a district topic index.
 *
 * This is deliberately a presentation projection: source-family/object-id is
 * the identity key, and grouping never promotes a mention into an action or
 * joins two canonical objects.
 */
import { searchDistrictTopics } from "./district_topic_index.mjs";
import {
  buildLocalIssueRequestResponseTrail,
  renderLocalIssueRequestResponseTrail,
} from "./local_issue_request_response_trail.mjs";

export const LOCAL_ISSUE_RESULTS_SCHEMA = "cityscroll.local_issue_results.v1";
export const LOCAL_ISSUE_RESULTS_VERSION = 1;
export const LOCAL_ISSUE_RESULT_GROUPS = Object.freeze([
  Object.freeze({ id: "upcoming", label: "Upcoming opportunities" }),
  Object.freeze({ id: "formal_board_actions", label: "Formal board actions" }),
  Object.freeze({ id: "projects_procurements", label: "Projects and procurements" }),
  Object.freeze({ id: "board_priorities_responses", label: "Board priorities and responses" }),
  Object.freeze({ id: "supporting_documents", label: "Supporting documents" }),
]);

const GROUP_BY_FAMILY = Object.freeze({
  community_board_meeting: "upcoming",
  community_board_decision: "formal_board_actions",
  community_board_project: "projects_procurements",
  shared_procurement_read_model: "projects_procurements",
  community_board_request: "board_priorities_responses",
  community_board_response: "board_priorities_responses",
  community_board_position: "board_priorities_responses",
  document_excerpt: "supporting_documents",
  district_activity: "supporting_documents",
});
const clean = (value, max = 700) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (value) => clean(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
const internalHref = (value) => { const href = clean(value, 2000); return href.startsWith("/") && !href.startsWith("//") ? href : null; };
const externalHref = (value) => { const href = clean(value, 2000); return /^https?:\/\/[^\s<>"]+$/.test(href) ? href : null; };

function matchReason(entry, terms) {
  const text = clean(entry.text, 8000);
  const lower = text.toLocaleLowerCase("en-US");
  const term = terms.find((candidate) => lower.includes(candidate)) || terms[0] || "the topic";
  const at = Math.max(0, lower.indexOf(term));
  const start = Math.max(0, at - 90);
  const passage = text.slice(start, start + 240).trim();
  return { query_terms: Object.freeze([...terms]), matched_term: term, passage: passage || text.slice(0, 240) };
}

function normalizeParticipation(entry, supplied) {
  const links = Array.isArray(supplied) ? supplied : [];
  return Object.freeze(links.map((link) => ({ label: clean(link?.label, 180), href: internalHref(link?.href) || externalHref(link?.href) }))
    .filter((link) => link.label && link.href));
}

function projectEntry(entry, terms, district, board, participation = [], requestResponseTrail = null) {
  const group = GROUP_BY_FAMILY[entry.source_family];
  if (!group) return null;
  const boardLabel = clean(board?.label || board?.name || board?.id, 180);
  const districtLabel = clean(district, 80).toUpperCase();
  return Object.freeze({
    schema: LOCAL_ISSUE_RESULTS_SCHEMA,
    group,
    source_family: entry.source_family,
    canonical_type: entry.canonical_type,
    object_id: entry.object_id,
    canonical_href: entry.route,
    title: clean(entry.text.split(" ").slice(0, 16).join(" "), 220),
    match: Object.freeze(matchReason(entry, terms)),
    locality: Object.freeze({ district: districtLabel, reason: `Exact district membership: ${districtLabel}`, board: boardLabel || null }),
    relationship: Object.freeze({ label: entry.source_family === "community_board_decision" ? "Formal board action" : "Source record connected to this district", board: boardLabel || null }),
    evidence: Object.freeze({ source_reference: entry.source.reference, source_url: entry.source.url, observed_through: entry.observed_through }),
    participation: normalizeParticipation(entry, participation),
    request_response_trail: requestResponseTrail,
  });
}

function suppliedTrailFor(entry, options, input) {
  if (!entry || entry.source_family !== "community_board_request") return null;
  const supplied = options.request_response_trails ?? input?.request_response_trails;
  const candidates = Array.isArray(supplied) ? supplied : supplied && typeof supplied === "object" ? Object.values(supplied) : [];
  const match = candidates.find((trail) => {
    const request = trail?.request || trail;
    return String(request?.tracking_code || request?.request_id || request?.code || request?.object_id || "") === String(entry.object_id);
  });
  return match ? buildLocalIssueRequestResponseTrail(match, { board_label: options.board?.label || input?.board?.label }) : null;
}

function pageInfo(total, page, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return Object.freeze({ page: current, page_size: pageSize, total, pages, has_previous: current > 1, has_next: current < pages });
}

/** Build the bounded, typed issue-results view from a district topic index. */
export function buildLocalIssueResults(input = {}, options = {}) {
  const index = input?.index || input;
  const query = clean(options.query ?? input?.query, 240);
  const district = clean(options.district ?? index?.district, 80).toLowerCase();
  const terms = query.toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  const matches = query ? searchDistrictTopics(index, query) : [];
  const participation = options.participation_links || input?.participation_links;
  const entries = matches.map((entry) => projectEntry(entry, terms, district, options.board || input?.board, participation, suppliedTrailFor(entry, options, input))).filter(Boolean);
  const pageSize = Math.min(50, Math.max(1, Number(options.page_size ?? input?.page_size) || 10));
  const page = Number(options.page ?? input?.page) || 1;
  const groups = LOCAL_ISSUE_RESULT_GROUPS.map((definition) => {
    const all = entries.filter((entry) => entry.group === definition.id);
    const info = pageInfo(all.length, page, pageSize);
    const from = (info.page - 1) * pageSize;
    return Object.freeze({ ...definition, total: all.length, pagination: info, results: Object.freeze(all.slice(from, from + pageSize)) });
  });
  const tracked = options.tracked_issue || input?.tracked_issue;
  const canonicalIssue = tracked?.exists && internalHref(tracked.href)
    ? Object.freeze({ label: clean(tracked.label, 180) || "Open the canonical issue page", href: internalHref(tracked.href) }) : null;
  return Object.freeze({ schema: LOCAL_ISSUE_RESULTS_SCHEMA, version: LOCAL_ISSUE_RESULTS_VERSION, query, district, groups: Object.freeze(groups), coverage: index?.coverage || null, canonical_issue: canonicalIssue, return_href: internalHref(options.return_href || input?.return_href) });
}

export function renderLocalIssueResults(view) {
  if (!view || view.schema !== LOCAL_ISSUE_RESULTS_SCHEMA) return "";
  const groups = view.groups.map((group) => `<section class="local-issue-results-group" data-issue-group="${esc(group.id)}"><h2>${esc(group.label)}</h2><p class="local-issue-results-count">${group.total} result${group.total === 1 ? "" : "s"}</p>${group.results.length ? `<ol>${group.results.map((entry) => `<li class="local-issue-result" data-source-family="${esc(entry.source_family)}"><h3><a href="${esc(entry.canonical_href)}">${esc(entry.title)}</a></h3><p class="local-issue-match"><strong>Why it matched:</strong> ${esc(entry.match.passage)}</p><p class="local-issue-locality"><strong>Why it is here:</strong> ${esc(entry.locality.reason)}${entry.locality.board ? ` · ${esc(entry.locality.board)}` : ""}</p><p class="local-issue-evidence"><a href="${esc(entry.evidence.source_url)}">Source evidence</a> · observed through ${esc(entry.evidence.observed_through)}</p>${entry.participation.length ? `<p class="local-issue-participation">${entry.participation.map((link) => `<a href="${esc(link.href)}">${esc(link.label)}</a>`).join(" · ")}</p>` : ""}${entry.request_response_trail ? renderLocalIssueRequestResponseTrail(entry.request_response_trail) : ""}</li>`).join("")}</ol>` : "<p>No matching records are shown in this group; the searched source scope is retained in the coverage details.</p>"}</section>`).join("\n");
  const canonical = view.canonical_issue ? `<p class="local-issue-canonical"><a href="${esc(view.canonical_issue.href)}">${esc(view.canonical_issue.label)}</a></p>` : "";
  const back = view.return_href ? `<a class="local-issue-return" href="${esc(view.return_href)}">Return to results</a>` : "";
  return `<div class="local-issue-results" data-local-issue-results="1"><p class="local-issue-scope">Topic: <strong>${esc(view.query)}</strong> · District: <strong>${esc(view.district.toUpperCase())}</strong></p>${canonical}${back}${groups}</div>`;
}

export const buildLocalIssueResultsView = buildLocalIssueResults;
export const renderLocalIssueResultsHTML = renderLocalIssueResults;
