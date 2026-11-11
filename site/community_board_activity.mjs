/**
 * Bounded, typed activity projection for a Community Board.
 *
 * This is a composition layer, not a new source or identity system. Only
 * records already accepted by the board read models enter the stream.
 */
import { communityBoardDecisionHref } from "./community_board_resolution_pilot.mjs";

export const COMMUNITY_BOARD_ACTIVITY_SCHEMA = "cityscroll.community_board_activity.v1";
export const COMMUNITY_BOARD_ACTIVITY_LOOKUP_SCHEMA = "cityscroll.community_board_activity_lookup.v1";
export const COMMUNITY_BOARD_ACTIVITY_LIMIT = 24;
export const NEAR_YOU_BOARD_ACTIVITY_PREVIEW_LIMIT = 3;
export const COMMUNITY_BOARD_ACTIVITY_TYPES = Object.freeze([
  "meeting", "decision", "resolution", "land_position", "budget_request",
  "agency_response_change", "document_publication",
]);
export const COMMUNITY_BOARD_ACTIVITY_TYPE_LABELS = Object.freeze({
  meeting: "Board meeting",
  decision: "Board decision",
  resolution: "Board resolution",
  land_position: "Land position",
  budget_request: "Budget request",
  agency_response_change: "Agency response",
  document_publication: "Board document",
});
export const BUDGET_RELATED_ACTIVITY_TYPES = Object.freeze([
  "budget_request",
  "agency_response_change",
]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BOARD = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const clean = (value, max = 500) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const day = (value) => { const v = clean(value, 20); return DAY.test(v) ? v : null; };
const url = (value) => { const v = clean(value, 2000); return /^https:\/\/[^\s<>"']+$/.test(v) ? v : null; };
const href = (value) => { const v = clean(value, 2000); return v.startsWith("/") && !v.startsWith("//") ? v : null; };
const first = (...values) => values.map(day).find(Boolean) || null;

function base(type, row, boardId, defaults = {}) {
  const board = clean(row.board_id || boardId, 100).toLowerCase();
  const source = row.source || row.provenance || {};
  const observed = day(row.observed_through || row.observed_on || row.document?.observed_through || row.document?.observed_on || source.observed_through || source.observed_on || defaults.observed_through);
  const sourceUrl = url(row.source_url || row.document?.document_url || row.document?.source_url || source.source_url || defaults.source_url);
  const canonical = href(row.canonical_href || row.href || defaults.canonical_href);
  if (!BOARD.test(board) || !canonical || !sourceUrl || !observed) return null;
  return {
    schema: COMMUNITY_BOARD_ACTIVITY_SCHEMA,
    id: clean(row.id || row.candidate_id || row.meeting_id || row.project_id || row.tracking_code || row.document_id, 400) || `${type}:${board}:${canonical}`,
    action_type: type, board_id: board, effective_date: first(row.effective_date, row.date, row.meeting_date, row.document?.meeting_date, row.recorded_on, row.request_date, row.published_date, row.publication_date),
    canonical_href: canonical, source_url: sourceUrl, observed_through: observed,
    title: clean(row.title || row.name || row.label, 500) || type.replaceAll("_", " "),
  };
}

function meetingRows(view, boardId, defaults) {
  return (Array.isArray(view.institution_edges) ? view.institution_edges : view.meetings || [])
    .filter((row) => row?.relation === "hosts_meeting" && (row.accepted !== false))
    .map((row) => base("meeting", row, boardId, { ...defaults, canonical_href: row.canonical_href || row.href }))
    .filter(Boolean);
}

function decisionRows(view, boardId, defaults) {
  const decisions = view.board_decisions?.decisions || view.decisions || [];
  return decisions.filter((row) => row?.admission !== "held" && row?.document)
    .flatMap((row) => {
      const type = row.position && row.passages?.some((passage) => passage.role === "operative") ? "resolution" : "decision";
      const decisionHref = communityBoardDecisionHref(boardId, row.candidate_id || row.id)
        || `${defaults.board_href}#${encodeURIComponent(row.candidate_id || row.id || "record")}`;
      return [base(type, row, boardId, { ...defaults, canonical_href: decisionHref })].filter(Boolean);
    });
}

function landRows(view, boardId, defaults) {
  return (view.land_positions?.positions || []).map((row) => base("land_position", row, boardId, {
    ...defaults, canonical_href: row.canonical_href || `/land/${encodeURIComponent(row.project_id || "")}/`,
  })).filter(Boolean);
}

function budgetRows(view, boardId, defaults) {
  const groups = view.budget_requests?.groups || [];
  return groups.flatMap((group) => (group.requests || []).flatMap((row) => {
    const answers = row.answers || row.versions || [];
    const request = base("budget_request", { ...row, effective_date: row.effective_date || answers[0]?.publication_date }, boardId, {
      ...defaults, source_url: viewBudgetSource(row, defaults), canonical_href: `${defaults.board_href}#budget-request-${encodeURIComponent(row.tracking_code || "record")}`,
    });
    const changes = answers.filter((answer) => answer.changed === true);
    return [request, ...changes.map((answer) => base("agency_response_change", {
      ...row, ...answer, id: `${row.tracking_code}:response:${answer.publication || answer.publication_date}`,
      effective_date: answer.publication_date, title: `Agency response for ${row.tracking_code}`,
    }, boardId, { ...defaults, canonical_href: request?.canonical_href }))].filter(Boolean);
  }));
}

function viewBudgetSource(row, defaults) {
  return row.source_url || defaults.budget_source_url || defaults.source_url;
}

function documentRows(view, boardId, defaults) {
  return (view.source_records || []).filter((row) => row.meeting_document || row.role === "minutes" || row.document_role)
    .map((row) => base("document_publication", row, boardId, {
      ...defaults, canonical_href: `${defaults.board_href}#source-${encodeURIComponent(row.role || row.document_id || "document")}`,
    })).filter(Boolean);
}

export function composeCommunityBoardActivity(view = {}, options = {}) {
  const boardId = clean(options.board_id || view.board_id || view.body_id, 100).toLowerCase();
  const boardHref = href(options.board_href || view.board_href || `/community-boards/#board-${encodeURIComponent(boardId)}`);
  const source = view.source || view.provenance || {};
  const defaults = { board_href: boardHref, source_url: source.source_url || source.url, budget_source_url: view.budget_requests?.source?.source_url || view.budget_requests?.source?.url, observed_through: source.observed_through || source.observed_on || view.budget_requests?.source?.observed_on || view.as_of };
  const rows = [...meetingRows(view, boardId, defaults), ...decisionRows(view, boardId, defaults), ...landRows(view, boardId, defaults), ...budgetRows(view, boardId, defaults), ...documentRows(view, boardId, defaults)];
  const seen = new Set();
  const entries = rows.filter((row) => { if (!row.effective_date || seen.has(`${row.action_type}|${row.id}`)) return false; seen.add(`${row.action_type}|${row.id}`); return true; })
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date) || a.action_type.localeCompare(b.action_type) || a.id.localeCompare(b.id));
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : (Number.isInteger(view.activity_limit) ? view.activity_limit : COMMUNITY_BOARD_ACTIVITY_LIMIT);
  return { schema: COMMUNITY_BOARD_ACTIVITY_SCHEMA, board_id: boardId, entries: entries.slice(0, limit), total_count: entries.length, limit, coverage: { state: entries.length ? "records_present" : "no_action_recorded", observed_through: defaults.observed_through || null, source_url: url(defaults.source_url) } };
}

export const communityBoardActivityForBoard = composeCommunityBoardActivity;

export function paginateCommunityBoardActivity(activity, page = 1, pageSize = COMMUNITY_BOARD_ACTIVITY_LIMIT) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : COMMUNITY_BOARD_ACTIVITY_LIMIT;
  const number = Number.isInteger(page) && page > 0 ? page : 1;
  const all = Array.isArray(activity?.entries) ? activity.entries : [];
  return { ...activity, page: number, page_size: size, has_next: number * size < (activity?.total_count || all.length), entries: all.slice((number - 1) * size, number * size) };
}

export function renderCommunityBoardActivitySection(activity) {
  if (!activity || activity.schema !== COMMUNITY_BOARD_ACTIVITY_SCHEMA) return "";
  const items = activity.entries.map((entry) => `<li class="board-activity-entry" data-action-type="${clean(entry.action_type, 60)}"><a href="${entry.canonical_href}">${clean(entry.title, 500)}</a> <time datetime="${entry.effective_date}">${entry.effective_date}</time><details><summary>Sources</summary><a href="${entry.source_url}">Official source</a><span> Observed through ${entry.observed_through}</span></details></li>`).join("");
  return `<section id="board-activity" class="node-card civic-object-section board-activity" data-community-board-activity="${activity.entries.length}"><h2>Board activity</h2><p class="muted">Typed records published by this board, ordered by date. A request is not funding or completion; a district project is not board action.</p>${items ? `<ol class="board-activity-list">${items}</ol>` : "<p>No board action is recorded in the retained sources for this board.</p>"}</section>`;
}

export function isServableBoardActivity(activity) {
  return Boolean(
    activity
    && (activity.schema === COMMUNITY_BOARD_ACTIVITY_SCHEMA || Array.isArray(activity.entries))
    && Array.isArray(activity.entries)
    && activity.entries.length > 0,
  );
}

export function communityBoardActivityTypeLabel(actionType, title = "") {
  if (actionType === "agency_response_change") return COMMUNITY_BOARD_ACTIVITY_TYPE_LABELS.agency_response_change;
  if (actionType === "resolution") return COMMUNITY_BOARD_ACTIVITY_TYPE_LABELS.resolution;
  if (actionType === "decision" && /^Resolution\b/i.test(String(title || ""))) {
    return COMMUNITY_BOARD_ACTIVITY_TYPE_LABELS.resolution;
  }
  return COMMUNITY_BOARD_ACTIVITY_TYPE_LABELS[actionType]
    || clean(actionType, 60).replaceAll("_", " ")
    || "Board record";
}

const FEATURED_NEAR_YOU_ACTIVITY_TYPES = Object.freeze([
  "resolution",
  "decision",
  "agency_response_change",
  "land_position",
  "document_publication",
]);

export function selectNearYouBoardActivityEntries(activity, {
  limit = NEAR_YOU_BOARD_ACTIVITY_PREVIEW_LIMIT,
  preferNonBudget = true,
} = {}) {
  const entries = Array.isArray(activity?.entries) ? activity.entries : [];
  if (!entries.length) return [];
  const size = Number.isInteger(limit) && limit >= 0 ? limit : NEAR_YOU_BOARD_ACTIVITY_PREVIEW_LIMIT;
  const nonBudget = entries.filter((entry) => !BUDGET_RELATED_ACTIVITY_TYPES.includes(entry.action_type));
  const pool = preferNonBudget && nonBudget.length ? nonBudget : entries;
  // Keep dated order, but surface typed actions ahead of recurring meetings so
  // the bounded overview preview is not only calendar rows.
  const featured = pool.filter((entry) => FEATURED_NEAR_YOU_ACTIVITY_TYPES.includes(entry.action_type));
  const rest = pool.filter((entry) => !FEATURED_NEAR_YOU_ACTIVITY_TYPES.includes(entry.action_type));
  return [...featured, ...rest].slice(0, size);
}

export function projectNearYouBoardActivityRecords(activity, {
  boardLabel = null,
  limit = NEAR_YOU_BOARD_ACTIVITY_PREVIEW_LIMIT,
  preferNonBudget = true,
} = {}) {
  const scopeLabel = boardLabel
    ? `${boardLabel} · full community district`
    : "Full community district covered by this board";
  return selectNearYouBoardActivityEntries(activity, { limit, preferNonBudget }).map((entry) => {
    const typeLabel = communityBoardActivityTypeLabel(entry.action_type, entry.title);
    return {
      id: entry.id,
      title: entry.title,
      date: entry.effective_date,
      agency: boardLabel || "Community Board",
      type: typeLabel,
      action_type: entry.action_type,
      basis: scopeLabel,
      route: entry.canonical_href,
      source_url: entry.source_url,
      observed_through: entry.observed_through,
      board_id: entry.board_id,
      geography_scope: "community_district",
      geography_evidence: {
        label: boardLabel || "Community Board district",
        basis: scopeLabel,
        location_role: "affected_area",
        method: "covering_board_register",
        tier: "derived",
        resident_label: scopeLabel,
      },
    };
  });
}

/**
 * Near You overview section for typed covering-board activity.
 *
 * Returns null to omit the optional card. A failed board-activity read never
 * becomes a verified empty or "no activity" claim. When readState is omitted,
 * callers may still pass legacyCoverage to preserve the prior board-link note.
 */
export function buildNearYouBoardActivityOverviewSection({
  coveringBoardId = null,
  boardHref = null,
  boardLabel = null,
  activity = null,
  readState = undefined,
  legacyCoverage = null,
  preferNonBudget = true,
  limit = NEAR_YOU_BOARD_ACTIVITY_PREVIEW_LIMIT,
} = {}) {
  const key = "board-activity";
  const title = "Board activity";
  const lens = "meetings";
  const normalizedHref = href(boardHref);
  const destinationHref = normalizedHref
    ? `${normalizedHref.replace(/\/?$/, "/")}#board-activity`
    : null;

  if (readState === "error") return null;

  if (readState === "ready" || readState === "absent") {
    if (!isServableBoardActivity(activity)) return null;
    const records = projectNearYouBoardActivityRecords(activity, {
      boardLabel,
      preferNonBudget,
      limit,
    });
    if (!records.length) return null;
    return {
      key,
      title,
      lens,
      count: Number.isInteger(activity.total_count) ? activity.total_count : records.length,
      records,
      coverage: "These records cover the full Community Board district, which is wider than one neighborhood.",
      destinationHref,
      destinationLabel: "Open board activity",
    };
  }

  if (!coveringBoardId && !normalizedHref) return null;
  if (!legacyCoverage) return null;
  return {
    key,
    title,
    lens,
    count: null,
    records: [],
    coverage: legacyCoverage,
    destinationHref: normalizedHref,
    destinationLabel: normalizedHref ? "Open board page" : null,
  };
}

export function activityFromBoardActivityLookup(lookup, boardId) {
  const id = clean(boardId, 100).toLowerCase();
  if (!BOARD.test(id) || !lookup || typeof lookup !== "object") return null;
  const row = lookup.by_board?.[id] || lookup.boards?.[id] || null;
  if (!row) return null;
  const entries = Array.isArray(row.entries) ? row.entries : [];
  return {
    schema: COMMUNITY_BOARD_ACTIVITY_SCHEMA,
    board_id: id,
    entries,
    total_count: Number.isInteger(row.total_count) ? row.total_count : entries.length,
    limit: Number.isInteger(row.limit) ? row.limit : COMMUNITY_BOARD_ACTIVITY_LIMIT,
    coverage: row.coverage || {
      state: entries.length ? "records_present" : "no_action_recorded",
      observed_through: null,
      source_url: null,
    },
  };
}
