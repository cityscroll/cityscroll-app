/**
 * Community-board constellation view model and document renderer.
 *
 * The board is an organization with a place projection. This adapter reuses
 * the agency constellation's typed edge-summary, local-neighborhood, and
 * civic-document grammar; it does not create a board-specific edge format.
 */

import { officialSourceLink } from "./affordance_grammar.mjs";
import { createCalendarOccurrence } from "./calendar_occurrence.mjs";
import { buildCompactMonthView, renderCompactMonth } from "./compact_calendar.mjs";
import {
  ABSENCE_REASONS,
  EDGE_SUMMARY_STATE_MEANINGS,
  edgeSummaryStateCopy,
  renderEdgeSummaryRail,
  renderEntityPivotLink,
  normalizeEdgeSummaryRecords,
} from "./edge_summary.mjs";
import {
  renderCalendarEventPreviewScript,
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
import { communityBoardCommitteePageHref, communityBoardPageHref } from "./community_board_links.mjs";
import { communityBoardMeetingEdgeAccepted } from "./community_board_institution_edges.mjs";
import {
  answerCommunityBoardGovernanceQuestion,
  buildCommunityBoardBylawGraph,
  communityBoardBylawSourceDescriptor,
  renderCommunityBoardBylawPanel,
} from "./community_board_bylaws.mjs";
import {
  buildCommunityBoardMoneyCardView,
  renderCommunityBoardMoneyCard,
} from "./community_board_money.mjs";
import {
  communityBoardPayrollContextForBoard,
  renderCommunityBoardPayrollContext,
} from "./community_board_payroll_context.mjs";
import {
  communityBoardParticipationForBoard,
  renderCommunityBoardParticipationSection,
} from "./community_board_participation.mjs";
import {
  BROOKLYN_CB15_BODY_ID,
  boroughOfficeRolesForBoard,
  renderBoroughOfficeAppointmentSection,
} from "./civic_institution_borough_office.mjs";
import { renderRelatedPublicBodiesFor } from "./civic_institution_related_bodies.mjs";

export const COMMUNITY_BOARD_CONSTELLATION_SCHEMA = "cityscroll.community_board_constellation.v1";
export const COMMUNITY_BOARD_CONSTELLATION_METHOD = "community_board_constellation_v1";

export const COMMUNITY_BOARD_CONSTELLATION_CATEGORIES = Object.freeze([
  Object.freeze({ id: "place", label: "District coverage", relation: "covers", target_kind: "community-district" }),
  Object.freeze({ id: "sources", label: "Sources & coverage", relation: "published_board_source", target_kind: "source" }),
  Object.freeze({ id: "committees", label: "Committees", relation: "has_committee", target_kind: "community-board-committee" }),
  Object.freeze({ id: "meetings", label: "Upcoming & recent proceedings", relation: "hosts_meeting", target_kind: "meeting" }),
  Object.freeze({ id: "members", label: "People", relation: "has_member", target_kind: "community-board-person" }),
  Object.freeze({ id: "recommendations", label: "Matters & actions", relation: "issues_recommendation", target_kind: "recommendation" }),
]);

const SOURCE_ROLE_LABELS = Object.freeze({
  upcoming_meetings: "Upcoming meetings",
  minutes: "Minutes and records",
  committees: "Committee directory",
  roster: "Board roster",
  bylaws: "Bylaws",
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

function sourceRows(scorecardRow, inventoryRow, receipts = []) {
  const scored = scorecardRow?.sources || {};
  const inventory = inventoryRow?.source_roles || {};
  return Object.keys(SOURCE_ROLE_LABELS).map((role) => {
    const source = scored[role] || inventory[role] || {};
    const receipt = (Array.isArray(receipts) ? receipts : []).find((row) => row?.role === role);
    return {
      role,
      label: SOURCE_ROLE_LABELS[role],
      url: source.source_url || source.url || null,
      state: receipt?.state || source.governance_state || source.collection_state || (source.url ? "observed" : "absent_in_pass"),
      publisher: source.publisher || null,
      observed_on: source.observed_on || source.seen_on || null,
      origin_label: source.origin_label || source.publisher || null,
      observed_receipt: receipt?.observed_receipt || source.coverage_receipt?.observed_receipt || null,
      receipt_state: receipt?.state || null,
    };
  });
}

function residentDate(value) {
  const monthOnly = /^\d{4}-\d{2}$/.test(String(value));
  const parsed = new Date(`${value}${monthOnly ? "-01" : ""}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "long", ...(monthOnly ? {} : { day: "numeric" }), year: "numeric", timeZone: "UTC" }).format(parsed);
}

function minutesFreshness(documents = [], source = {}, asOf = null) {
  const dates = (Array.isArray(documents) ? documents : [])
    .map((document) => document.meeting_date || document.publication_date || document.date)
    .filter(Boolean)
    .sort();
  const latest = dates.at(-1) || null;
  const reference = new Date(`${String(asOf || new Date().toISOString()).slice(0, 10)}T00:00:00Z`);
  const latestDate = latest ? new Date(`${latest}${/^\d{4}-\d{2}$/.test(latest) ? "-01" : ""}T00:00:00Z`) : null;
  const ageDays = latestDate && !Number.isNaN(latestDate.getTime()) && !Number.isNaN(reference.getTime())
    ? Math.max(0, Math.floor((reference - latestDate) / 86400000)) : null;
  if (latest) {
    const stale = ageDays != null && ageDays > 365;
    return {
      state: stale ? "stale" : "available",
      latest_date: latest,
      label: stale ? `Minutes last published ${residentDate(latest)}` : `Latest minutes ${residentDate(latest)}`,
      age_days: ageDays,
      absence_reason: null,
    };
  }
  if (["unavailable", "unsupported-format"].includes(source.state)) {
    return { state: "unavailable", latest_date: null, label: "Minutes archive could not be checked", age_days: null, absence_reason: ABSENCE_REASONS.RETRIEVAL_FAILURE };
  }
  if (source.state === "checked-empty") {
    return { state: "available", latest_date: null, label: "No dated minutes found in the checked source", age_days: null, absence_reason: ABSENCE_REASONS.RECORDED_NEGATIVE };
  }
  return { state: "unknown", latest_date: null, label: "Minutes freshness is not yet known", age_days: null, absence_reason: ABSENCE_REASONS.UNSEARCHED };
}

function boardNode(geography, id) {
  return (geography?.nodes || []).find((node) => node?.type === "community-board" && node?.properties?.body_id === id)
    || (geography?.nodes || []).find((node) => node?.id === `community-board:${id}`)
    || null;
}

function sourceRecordIdentityValues(record = {}) {
  return [
    record.record_id,
    record.source_record_id,
    record.meeting_id,
    record.target_id,
  ].map((value) => clean(value, 500)).filter(Boolean);
}

function acceptedMeetingIds(institutionEdges = []) {
  return new Set((Array.isArray(institutionEdges) ? institutionEdges : [])
    .filter((edge) => edge?.relation === "hosts_meeting" || edge?.edge_type === "hosts_meeting")
    .filter(communityBoardMeetingEdgeAccepted)
    .flatMap((edge) => [edge.to, edge.target_id, edge.source_record_id].map((value) => clean(value, 500)).filter(Boolean)));
}

function absoluteCityScrollUrl(href) {
  const value = clean(href, 2000);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith("/") ? `https://cityscroll.org${value}` : null;
}

function communityBoardMeetingEdgeDate(edge = {}) {
  const value = clean(edge.relation_date || edge.meeting_date || edge.join?.event_date || edge.date, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// Adapts one accepted `hosts_meeting` edge into the shared CBICS-01/02
// calendar_display_occurrence contract. Admission stays where it already
// lives (the source join in community_board_source_join.mjs); this only
// projects an already-accepted meeting into the shape the shared compact
// month component understands. A row that fails the contract (no exact date,
// no canonical destination, no stable identity) is dropped, never invented.
function communityBoardProceedingOccurrence(edge = {}) {
  const day = communityBoardMeetingEdgeDate(edge);
  if (!day) return null;
  const canonicalUrl = absoluteCityScrollUrl(edge.canonical_href || edge.href);
  if (!canonicalUrl) return null;
  const uid = clean(edge.target_id || edge.to, 500);
  if (!uid) return null;
  const host = meetingHostLabel(edge);
  const form = proceedingFormLabel(edge);
  const sourceUrl = clean(edge.source_url || edge.provenance?.source_url, 2000) || null;
  try {
    return createCalendarOccurrence({
      uid,
      object_ref: uid,
      kind: "event",
      // The shared renderer's only free-text slot; host and proceeding form
      // (A3) travel here since compact_calendar has no dedicated fields for
      // them.
      title: form ? `${host} · ${form}` : host,
      date: day,
      canonical_url: canonicalUrl,
      source: { kind: "community-board", url: sourceUrl },
      provenance: edge.provenance || null,
    });
  } catch {
    return null;
  }
}

// Two projections of one accepted meeting population (G1): the density
// evaluator decides, per board, whether that population qualifies for a
// month view at all. Sparse and unavailable boards get an explicit
// `render: false` result, never empty calendar chrome (A6).
function communityBoardProceedingsCalendar(meetingEdges = [], today) {
  const occurrences = (Array.isArray(meetingEdges) ? meetingEdges : [])
    .filter(communityBoardMeetingEdgeAccepted)
    .map(communityBoardProceedingOccurrence)
    .filter(Boolean);
  return buildCompactMonthView(occurrences, { today });
}

function genericCommunityBoardPersonRef(value) {
  const match = clean(value, 500).match(/^community-board-person:([^:]+):(.+)$/);
  return match ? `person:community-board:${match[1]}:${match[2]}` : null;
}

function sourceRecordRows(records = [], options = {}) {
  const rows = Array.isArray(records) ? records : records?.records || [];
  const acceptedIds = options.acceptedMeetingIds instanceof Set ? options.acceptedMeetingIds : new Set();
  return rows.filter((record) => record && (record.record_id || record.source_record_id))
    // An accepted event is already represented by its Meeting semantic object.
    // Keep minutes and unmatched/diagnostic records available for provenance,
    // but never create a second event universe from the same source row.
    .filter((record) => {
      const isEvent = record.record_kind === "event"
        || record.source_role === "upcoming_meetings"
        || record.object_type === "meeting";
      return !(isEvent && sourceRecordIdentityValues(record).some((id) => acceptedIds.has(id)));
    })
    .map((record) => ({
    ...record,
    label: record.role === "minutes"
      ? "Minutes"
      : record.record_kind === "video"
      ? "Meeting video"
      : record.record_kind === "event"
        ? (SOURCE_ROLE_LABELS[record.category] || "Board meeting")
        : "Minutes and records",
    state: record.status === "official" || record.join?.matched === true || record.attachment_status === "attached"
      ? "official"
      : record.observed_receipt?.status === "ok" || record.source_provenance?.observed_receipt?.status === "ok" || record.source_receipt?.status === "ok"
        ? "observed"
        : "unknown",
    href: record.document_url || record.record_url || record.source_url || null,
    meeting_document: record.object_type === "meeting_document" || record.role === "minutes",
  }));
}

function relationItem(edge, kind) {
  const sourcePersonIdentity = edge.person_identity?.id || edge.person_ref || edge.to;
  return {
    ...edge,
    generic_person_ref: kind === "member" ? genericCommunityBoardPersonRef(sourcePersonIdentity) : null,
    href: kind === "meeting" && communityBoardMeetingEdgeAccepted(edge)
        ? edge.href || edge.canonical_href || null
        : null,
    date: edge.relation_date || edge.meeting_date || edge.join?.event_date || edge.date,
    source_document: edge.source_document,
    label: edge.person_name || edge.target_name || edge.target_id,
    state: communityBoardMeetingEdgeAccepted(edge) || kind !== "meeting" ? "official" : "held",
  };
}

function buildCategory(spec, board, source, districtEdge, sourceRowsForBoard, relationEdges, institutionEdges) {
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
      // A materialized count of 0 here is a verified fact, not a gap: every
      // row in the registry was already checked for a URL (RU-02 A2).
      absence_reason: count ? null : ABSENCE_REASONS.VALID_ZERO,
      count,
      target_name: "Sources & coverage",
      view_all_href: communityBoardOutputHref(board.body_id),
      source: { ...sourceHref, name: "Sources & coverage", canonical_href: communityBoardOutputHref(board.body_id) },
      provenance: source?.provenance || null,
      items: sourceRowsForBoard,
    };
  }
  if (spec.id === "meetings") {
    const edges = Array.isArray(institutionEdges) ? institutionEdges : [];
    const meetingEdges = edges.filter((edge) => edge?.relation === "hosts_meeting");
    const accepted = meetingEdges.filter(communityBoardMeetingEdgeAccepted);
    const items = meetingEdges.map((edge) => relationItem(edge, "meeting"));
    return {
      ...spec,
      status: accepted.length ? "matched" : "unknown",
      count: accepted.length || null,
      target_name: "Upcoming & recent proceedings",
      view_all_href: accepted[0]?.href || null,
      source: sourceHref,
      provenance: accepted[0]?.provenance || meetingEdges[0]?.provenance || source?.provenance || null,
      items,
      institution_edges: meetingEdges,
    };
  }
  if (spec.id === "committees") {
    const edges = (Array.isArray(institutionEdges) ? institutionEdges : [])
      .filter((edge) => edge?.relation === "has_committee");
    const meetings = (Array.isArray(institutionEdges) ? institutionEdges : [])
      .filter((edge) => edge?.relation === "hosts_meeting" && communityBoardMeetingEdgeAccepted(edge));
    return {
      ...spec,
      status: edges.length ? "matched" : "unknown",
      count: edges.length || null,
      target_name: "Community Board committees",
      view_all_href: null,
      source: sourceHref,
      provenance: edges[0]?.provenance || source?.provenance || null,
      items: edges.map((edge) => {
        const committeeRef = edge.to || edge.target_id;
        const chair = (relationEdges?.person_roles || [])
          .find((role) => role?.relation === "chairs" && (role.to === committeeRef || role.target_id === committeeRef));
        const nextMeeting = meetings
          .filter((meeting) => meeting.from === committeeRef || meeting.committee_ref === committeeRef)
          .sort((a, b) => String(a.join?.event_date || a.meeting_date || a.date || "").localeCompare(String(b.join?.event_date || b.meeting_date || b.date || "")))[0];
        return {
          ...relationItem(edge, "committee"),
          href: communityBoardCommitteePageHref(board.body_id, edge.committee_id || committeeRef?.split(":").at(-1)),
          chair_name: chair?.person_name || chair?.label || chair?.target_name || null,
          next_meeting: nextMeeting ? {
            id: nextMeeting.target_id || nextMeeting.to,
            label: nextMeeting.target_name || nextMeeting.label,
            href: nextMeeting.href || nextMeeting.canonical_href || null,
            date: nextMeeting.join?.event_date || nextMeeting.meeting_date || nextMeeting.date || null,
          } : null,
        };
      }),
      institution_edges: edges,
    };
  }
  if (spec.id === "members" || spec.id === "recommendations") {
    const kind = spec.id === "members" ? "member" : "recommendation";
    const edges = spec.id === "members"
      ? [...(relationEdges?.members || []), ...(relationEdges?.person_roles || [])]
      : (relationEdges?.[spec.id] || []);
    const availability = communityBoardRelationAvailability(sourceRowsForBoard, kind);
    return {
      ...spec,
      status: edges.length ? "matched" : "unknown",
      source_state: edges.length ? "observed" : availability.state,
      // "not_yet_ingested" is a source that has never been checked; an
      // "unknown" availability with a stated reason means the source was
      // checked but returned no exact-identity match (RU-02 A2).
      absence_reason: edges.length
        ? null
        : (availability.state === "not_yet_ingested" || !availability.reason
          ? ABSENCE_REASONS.UNSEARCHED
          : ABSENCE_REASONS.CHECKED_NO_RECORD),
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
  const categoryEdges = categories.map((category) => ({
    source_kind: "community-board",
    source_id: sourceId,
    edge_type: category.relation,
    relation_label: category.id === "place"
      ? "District coverage"
      : category.id === "sources"
        ? "Sources & coverage"
        : category.label,
    target_kind: category.target_kind,
    target_id: ["place", "meetings", "committees"].includes(category.id) ? category.items?.[0]?.target_id || null : null,
    target_name: category.id === "committees"
      ? category.items?.[0]?.label || category.target_name
      : category.target_name,
    count: category.count,
    state: category.status,
    href: category.status === "matched" ? category.view_all_href : null,
    absence_reason: category.absence_reason || null,
    scope: { board: sourceId },
    source: category.source,
    provenance: category.provenance,
  }));
  const bylawEdges = (viewOrCategories?.governed_by_edges || []).map((edge) => ({
    source_kind: "community-board",
    source_id: sourceId,
    edge_type: "governed_by",
    relation_label: "Governing bylaws",
    target_kind: "bylaw-version",
    target_id: edge.target_id || edge.to || null,
    target_name: edge.target_name || "Community Board bylaw",
    count: 1,
    state: edge.status === "promoted" ? "matched" : "unknown",
    href: edge.status === "promoted" ? edge.source_url || null : null,
    scope: { board: sourceId },
    source: { kind: "community-board", id: sourceId, name: "Community Board", canonical_href: communityBoardPageHref(sourceId) },
    provenance: edge.provenance || null,
  }));
  return normalizeEdgeSummaryRecords([...categoryEdges, ...bylawEdges]);
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
  const normalizedBoard = {
    ...board,
    community_district_id: districtId || board.community_district_id || null,
    as_of: sources.generated_at || sources.scorecard?.as_of || null,
  };
  const scorecardRow = (sources.scorecard?.rows || []).find((row) => row?.body_id === requested);
  const inventoryRow = (sources.sourceInventory?.boards || []).find((row) => row?.id === requested || row?.body_id === requested);
  const boardReceipts = (sources.sourceReceipts || []).filter((row) => row?.board_id === requested);
  const bylawGraph = buildCommunityBoardBylawGraph(sources.communityBoardBylaws || sources.bylaws || []);
  const boardBylawSource = communityBoardBylawSourceDescriptor(bylawGraph, requested);
  const boardSources = sourceRows(scorecardRow, inventoryRow || board, boardReceipts);
  if (boardBylawSource) {
    const bylawSource = boardSources.find((row) => row.role === "bylaws");
    if (bylawSource) Object.assign(bylawSource, {
      url: boardBylawSource.source_url,
      publisher: boardBylawSource.publisher,
      observed_on: boardBylawSource.observed_on,
      state: boardBylawSource.state,
      bylaw_version_id: boardBylawSource.bylaw_version_id,
    });
  }
  const suppliedInstitutionEdges = sources.institutionEdges?.[requested]
    || sources.boardInstitutionEdges?.[requested]
    || sources.meetingEdges?.[requested];
  const institutionEdges = Array.isArray(suppliedInstitutionEdges) ? suppliedInstitutionEdges : null;
  const today = /^\d{4}-\d{2}-\d{2}$/.test(clean(sources.today, 10))
    ? clean(sources.today, 10)
    : String(sources.generated_at || sources.scorecard?.as_of || new Date().toISOString()).slice(0, 10);
  const proceedingsCalendar = communityBoardProceedingsCalendar(
    (institutionEdges || []).filter((edge) => edge?.relation === "hosts_meeting"),
    today,
  );
  const boardSourceRecords = sourceRecordRows(
    [
      ...(sources.sourceRecords?.[requested]
      || (Array.isArray(sources.sourceRecords) ? sources.sourceRecords : sources.sourceRecords?.records)
      || []),
      ...(Array.isArray(sources.meetingDocuments)
        ? sources.meetingDocuments.filter((row) => row?.board_id === requested)
        : sources.meetingDocuments?.[requested] || []),
    ],
    { acceptedMeetingIds: acceptedMeetingIds(institutionEdges) },
  );
  const relationInput = sources.boardRelations?.[requested]
    || sources.relations?.[requested]
    || {};
  const relationEdges = promotedCommunityBoardRelationEdges(relationInput);
  const money = buildCommunityBoardMoneyCardView(
    sources.communityBoardMoney || sources.money,
    requested,
  );
  const payroll = communityBoardPayrollContextForBoard(
    sources.communityBoardPayrollContext || sources.payroll,
    requested,
  );
  const participation = communityBoardParticipationForBoard(
    sources.communityBoardParticipation || sources.participation,
    requested,
  );
  const appointmentAuthority = requested === BROOKLYN_CB15_BODY_ID
    ? boroughOfficeRolesForBoard(requested, sources.boroughOffice || sources.boroughOfficeSources || {})
    : null;
  const categories = COMMUNITY_BOARD_CONSTELLATION_CATEGORIES.map((spec) => buildCategory(
    spec,
    normalizedBoard,
    node,
    districtEdge,
    boardSources,
    relationEdges,
    institutionEdges,
  ));
  const governedByEdges = bylawGraph.edges.filter((edge) => edge.from === `community-board:${requested}`);
  const boardBylawVersions = bylawGraph.versions.filter((version) => version.board_id === requested);
  const governanceQuestion = answerCommunityBoardGovernanceQuestion(bylawGraph, requested);
  const edgeSummary = buildCommunityBoardEdgeSummary({ body_id: requested, categories, governed_by_edges: governedByEdges });
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
    institution_edges: institutionEdges || [],
    bylaw_versions: boardBylawVersions,
    governed_by_edges: governedByEdges,
    governance: {
      question: governanceQuestion,
      versions: boardBylawVersions,
    },
    money,
    payroll,
    participation,
    ...(appointmentAuthority ? { appointment_authority: appointmentAuthority } : {}),
    categories,
    edge_summary: edgeSummary,
    local_constellation: localConstellation,
    proceedings_calendar: proceedingsCalendar,
    minutes_freshness: minutesFreshness(
      boardSourceRecords.filter((row) => row.meeting_document || row.source_role === "minutes"),
      boardSources.find((row) => row.role === "minutes") || {},
      normalizedBoard.as_of,
    ),
    summary: {
      matched_categories: categories.filter((category) => category.status === "matched").length,
      category_count: categories.length,
      generated_at: sources.generated_at || sources.scorecard?.as_of || null,
      method: COMMUNITY_BOARD_CONSTELLATION_METHOD,
    },
  };
}

// Resident copy stays in plain task language; the underlying pipeline state
// (adapter names, ingestion vocabulary) is retained only in the non-visible
// data attribute below, never in visible or accessible text (RU-02 A5/F2).
const SOURCE_STATE_ABSENCE_REASON = Object.freeze({
  "unsupported-format": ABSENCE_REASONS.RETRIEVAL_FAILURE,
  unavailable: ABSENCE_REASONS.RETRIEVAL_FAILURE,
  "not-yet-checked": ABSENCE_REASONS.UNSEARCHED,
  absent_in_pass: ABSENCE_REASONS.UNSEARCHED,
  "checked-empty": ABSENCE_REASONS.RECORDED_NEGATIVE,
});

function sourceMarkup(row) {
  const link = row.url
    ? officialSourceLink({ href: row.url, label: row.role === "upcoming_meetings" ? "Open official calendar" : `Open ${row.label.toLowerCase()}`, className: "board-source-link", escape: esc })
    : `<span class="node-muted">Source not listed</span>`;
  const state = {
    indexed: "Records found in the checked source",
    "checked-empty": "Checked; no dated records found",
    "unsupported-format": "This source could not be checked automatically",
    unavailable: "This source could not be checked",
    stale: "Source needs a fresh check",
    "not-yet-checked": "Not yet checked",
    not_yet_ingested: "Source available",
    absent_in_pass: "Source not listed",
  }[row.state] || "Source observed";
  const absenceReason = SOURCE_STATE_ABSENCE_REASON[row.state] || "";
  return `<li class="node-record" data-source-type="${esc(row.role)}"${absenceReason ? ` data-source-absence-reason="${esc(absenceReason)}"` : ""}><div class="node-record-main"><strong>${esc(row.label)}</strong> ${link}</div><span class="muted node-muted">${esc(state)}${row.origin_label ? ` · ${esc(row.origin_label)}` : ""}</span></li>`;
}

function categoryStatus(category) {
  if (category.source_state === "not_yet_ingested") return "Not yet shown — official board records are still being collected";
  return edgeSummaryStateCopy({ state: category.status, count: category.count });
}

function relationRecordMarkup(row, kind, source) {
  const document = row.source_document || {};
  const link = document.url
    ? officialSourceLink({ href: document.url, label: "Open the source document", className: "board-source-link", escape: esc })
    : "";
  const date = row.date ? `Dated ${esc(row.date)}` : "Dated source record";
  const subject = kind === "member"
    ? ({ district_manager: "District Manager", staff: "Community Board staff", public_committee_member: "Public committee member", committee_chair: "Committee chair", committee_member: "Committee member", board_chair: "Board chair", board_officer: "Board officer", appointed_member: "Board member" }[row.role] || "Community Board person")
    : "Board recommendation";
  const evidence = kind === "member"
    ? "The board identity, member identity, date, and source document matched exactly."
    : "The board identity, recommendation identity, date, and source document matched exactly.";
  const target = renderEntityPivotLink({
    relation_label: kind === "member" ? "board member" : "board recommendation",
    target_kind: kind === "member" ? "community-board-person" : (row.target_kind || "recommendation"),
    target_id: kind === "member"
      ? row.person_ref || row.person_identity?.id || row.to || row.target_id || null
      : row.target_id || row.to?.split(":").slice(1).join(":") || null,
    target_name: row.label,
    canonical_href: row.href,
    status: row.status === "held" || !row.href ? "held" : "accepted",
    source,
  }, { className: "board-relation-pivot", escape: esc });
  return `<li class="node-record" data-board-relation="${esc(row.relation)}"><div class="node-record-main"><strong>${target}</strong></div><span class="muted node-muted">${esc(subject)} · ${date}</span><details class="inline-disclose board-relation-details"><summary>How confirmed</summary><div class="inline-disclose-body"><p>${esc(evidence)}</p><p>${link}</p></div></details></li>`;
}

function meetingHostLabel(row) {
  if (row.committee_name) return row.committee_name;
  if (String(row.from || "").startsWith("community-board-committee:")) return "Community Board committee";
  if (/full board/i.test(String(row.target_name || row.label || ""))) return "Full Board";
  return "Community Board";
}

function proceedingFormLabel(row) {
  return {
    public_hearing: "Public hearing",
    special_meeting: "Special meeting",
    meeting: "Meeting",
  }[row.proceeding_form] || null;
}

function meetingRecordMarkup(row) {
  const href = row.href || row.canonical_href || null;
  const title = row.title || row.target_name || row.label || row.target_id;
  const label = href ? `<a href="${esc(href)}">${esc(title)}</a>` : `<span>${esc(title)}</span>`;
  const form = proceedingFormLabel(row);
  const host = meetingHostLabel(row);
  const date = row.date ? ` · ${esc(row.date)}` : "";
  const sourceUrl = row.source_url || row.provenance?.source_url || null;
  const sourceLink = sourceUrl
    ? officialSourceLink({ href: sourceUrl, label: "Open official source", className: "board-source-link", escape: esc })
    : "";
  const checked = row.source_receipt?.observed_at || row.provenance?.observed_receipt?.observed_at || null;
  const accepted = communityBoardMeetingEdgeAccepted(row);
  const details = [
    sourceLink ? `<p>${sourceLink}</p>` : "",
    checked ? `<p>Source checked ${esc(residentDate(String(checked).slice(0, 10)))}</p>` : "",
  ].filter(Boolean).join("");
  return `<li class="node-record" data-semantic-object="meeting" data-meeting-id="${esc(row.target_id || row.to || row.source_record_id)}" data-meeting-state="${accepted ? "accepted" : "held"}"><div class="node-record-main"><strong>${label}</strong></div><span class="muted node-muted">${esc(host)}${form ? ` · ${esc(form)}` : ""}${date} · ${accepted ? "Published event" : "Connection not published"}</span>${details ? `<details class="inline-disclose board-meeting-source-details"><summary>Source details</summary><div class="inline-disclose-body">${details}</div></details>` : ""}</li>`;
}

function committeeRecordMarkup(row) {
  const label = row.href
    ? `<a href="${esc(row.href)}">${esc(row.label || row.target_name || row.target_id)}</a>`
    : `<span>${esc(row.label || row.target_name || row.target_id)}</span>`;
  const details = [
    row.chair_name ? `Chair: ${esc(row.chair_name)}` : "",
    row.next_meeting?.label ? `Next meeting: ${row.next_meeting.href
      ? `<a href="${esc(row.next_meeting.href)}">${esc(row.next_meeting.label)}</a>`
      : esc(row.next_meeting.label)}${row.next_meeting.date ? ` · ${esc(row.next_meeting.date)}` : ""}` : "",
  ].filter(Boolean);
  return `<li class="node-record" data-semantic-object="community-board-committee" data-committee-id="${esc(row.target_id || row.to)}"><div class="node-record-main"><strong>${label}</strong></div><span class="muted node-muted">Community Board committee${details.length ? ` · ${details.join(" · ")}` : ""}</span></li>`;
}

// A board's monthly rhythm alongside its existing list (G1). Sparse and
// coverage-unavailable boards get exactly the prior list-only markup — the
// wrapper, switch, and month panel are never emitted unless the density
// evaluator's `render: true` result says a month view qualifies (A6).
function renderProceedingsSection(category, view) {
  const list = `<ul class="node-record-list">${category.items.map(meetingRecordMarkup).join("")}</ul>`;
  const monthHtml = renderCompactMonth(view.proceedings_calendar);
  if (!monthHtml) return list;
  const boardId = esc(view.body_id);
  const monthId = `board-proceedings-view-month-${boardId}`;
  const listId = `board-proceedings-view-list-${boardId}`;
  const radioGroup = `board-proceedings-view-${boardId}`;
  return `<div class="board-proceedings-view" data-board-proceedings-view="1">` +
    `<fieldset class="board-proceedings-view-switch">` +
    `<legend class="board-proceedings-view-switch-legend">Show proceedings as</legend>` +
    `<input type="radio" id="${monthId}" name="${radioGroup}" class="board-proceedings-view-radio board-proceedings-view-radio-month">` +
    `<label class="board-proceedings-view-tab" for="${monthId}">Month</label>` +
    `<input type="radio" id="${listId}" name="${radioGroup}" class="board-proceedings-view-radio board-proceedings-view-radio-list" checked>` +
    `<label class="board-proceedings-view-tab" for="${listId}">List</label>` +
    `</fieldset>` +
    `<div class="board-proceedings-panel board-proceedings-panel-month" data-board-proceedings-panel="month">${monthHtml}</div>` +
    `<div class="board-proceedings-panel board-proceedings-panel-list" data-board-proceedings-panel="list">${list}</div>` +
    `</div>`;
}

function renderCategory(category, view) {
  const availability = EDGE_SUMMARY_STATE_MEANINGS[category.status] || EDGE_SUMMARY_STATE_MEANINGS.unknown;
  const body = category.id === "sources"
    ? `<ul class="node-record-list">${category.items.map(sourceMarkup).join("")}</ul>${renderMinutesFreshnessMarkup(view)}`
    : category.id === "meetings" && category.items?.length
      ? renderProceedingsSection(category, view)
      : category.id === "committees" && category.items?.length
        ? `<ul class="node-record-list">${category.items.map(committeeRecordMarkup).join("")}</ul>`
      : ["members", "recommendations"].includes(category.id) && category.items?.length
        ? `<ul class="node-record-list">${category.items.map((row) => relationRecordMarkup(row, category.id === "members" ? "member" : "recommendation", {
          kind: "community-board",
          id: view.body_id,
          name: view.display_name,
          canonical_href: view.path,
        })).join("")}</ul>`
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

const EMPTY_COVERAGE_CATEGORY_LABELS = Object.freeze({
  committees: "committees",
  meetings: "proceedings",
  members: "people",
  recommendations: "matters & actions",
});

function renderEmptyCoverageNote(categories) {
  const empty = categories.filter((category) => Object.hasOwn(EMPTY_COVERAGE_CATEGORY_LABELS, category.id) && !category.items?.length);
  if (!empty.length) return "";
  const labels = empty.map((category) => `<span class="board-coverage-category" data-community-board-constellation-category="${esc(category.id)}" data-edge-state="${esc(category.status)}" data-edge-availability="${esc(EDGE_SUMMARY_STATE_MEANINGS[category.status] || EDGE_SUMMARY_STATE_MEANINGS.unknown)}"${category.source_state ? ` data-edge-source-state="${esc(category.source_state)}"` : ""}>${esc(EMPTY_COVERAGE_CATEGORY_LABELS[category.id])}</span>`);
  const joined = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
  return `<p class="node-muted board-coverage-note" data-community-board-empty-coverage="1" data-edge-state="unknown" data-edge-availability="unknown">Not yet established from checked sources: ${joined}.</p>`;
}

function sourceRecordMarkup(row) {
  const institutionEdge = row.edge_type === "hosts_meeting";
  if (institutionEdge) {
    const label = row.href
      ? `<a href="${esc(row.href)}">${esc(row.title || row.label)}</a>`
      : `<span>${esc(row.title || row.label)}</span>`;
    const sourceUrl = row.source_url || row.provenance?.source_url || null;
    const checked = row.source_receipt?.observed_at || row.provenance?.observed_receipt?.observed_at || null;
    const sourceLink = sourceUrl
      ? officialSourceLink({ href: sourceUrl, label: "Open official source", className: "board-source-link", escape: esc })
      : "";
    const evidence = row.state === "official"
      ? "The board, meeting date, and publisher record matched the checked official source."
      : "This record did not pass every publication check, so no meeting link is shown.";
    const detailParts = [
      `<p>${esc(evidence)}</p>`,
      sourceLink ? `<p>${sourceLink}</p>` : "",
      checked ? `<p>Source checked ${esc(residentDate(String(checked).slice(0, 10)))}</p>` : "",
    ].filter(Boolean).join("");
    const details = detailParts
      ? `<details class="inline-disclose board-meeting-source-details"><summary>Source details</summary><div class="inline-disclose-body">${detailParts}</div></details>`
      : "";
    const date = row.date ? ` · ${esc(row.date)}` : "";
    const state = row.state === "official" ? "Hosted meeting" : "Connection not published";
    return `<li class="node-record" data-source-record-kind="meeting"><div class="node-record-main"><strong>${label}</strong></div><span class="muted node-muted">Board meeting${date} · ${esc(state)}</span>${details}</li>`;
  }
  const label = row.href
    ? officialSourceLink({ href: row.href, label: row.title || row.label, className: "board-source-link", escape: esc })
    : `<span>${esc(row.title || row.label)}</span>`;
  const date = row.date ? ` · ${esc(row.date)}` : "";
  const state = row.state === "official" ? "Official board record" : row.state === "observed" ? "Source observed" : "Source status unknown";
  return `<li class="node-record" data-source-record-kind="${esc(row.record_kind || "record")}"><div class="node-record-main"><strong>${label}</strong></div><span class="muted node-muted">${esc(row.label)}${date} · ${esc(state)}</span></li>`;
}

// A resident asking "is there a dated record worth opening" should reach a
// bounded, task-labelled list of official documents, never the full
// reconciliation population (G1/A1). Every record here already carries a
// resident-safe label and source link from sourceRecordRows; unresolved
// matching and adapter detail stay in the retained view.source_records data
// for the diagnostic/Desk boundary and are never spelled out here (A2).
export const COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT = 20;

function documentSortDate(record) {
  const value = clean(record?.date, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function renderUnjoinedSourceSection(records = []) {
  if (!records.length) return "";
  const ordered = [...records].sort((a, b) => documentSortDate(b).localeCompare(documentSortDate(a)));
  const shown = ordered.slice(0, COMMUNITY_BOARD_RESIDENT_DOCUMENT_LIMIT);
  const remaining = ordered.length - shown.length;
  const note = remaining > 0
    ? `<p class="muted node-muted">Showing the ${shown.length} most recently dated of ${ordered.length} official documents; earlier documents are kept on file.</p>`
    : "";
  return renderNodeSection({
    heading: "Official documents",
    extraClass: "node-card civic-object-section",
    attrs: { "data-community-board-official-documents": "1" },
    body: `<ul class="node-record-list">${shown.map(sourceRecordMarkup).join("")}</ul>${note}`,
  });
}

function renderMinutesFreshnessMarkup(view) {
  const freshness = view?.minutes_freshness;
  if (!freshness) return "";
  const source = view.categories.find((category) => category.id === "sources")?.items
    ?.find((row) => row.role === "minutes");
  const sourceLink = source?.url
    ? officialSourceLink({ href: source.url, label: "Open minutes or records", className: "board-source-link", escape: esc })
    : "";
  return `<div class="board-minutes-freshness" data-community-board-minutes="1" data-minutes-freshness="${esc(freshness.state)}"><p>${esc(freshness.label)}</p>${sourceLink ? `<p>${sourceLink}</p>` : ""}</div>`;
}

function renderAboutBoardSection(view) {
  const board = view.board || {};
  const place = view.categories.find((category) => category.id === "place");
  const facts = [];
  const district = place?.items?.[0]?.label;
  if (district) facts.push(`<li>${esc(district)}</li>`);
  if (board.homepage_url) facts.push(`<li><a href="${esc(board.homepage_url)}">Board homepage</a></li>`);
  if (board.directory_url) facts.push(`<li><a href="${esc(board.directory_url)}">City directory entry</a></li>`);
  if (!facts.length) return "";
  return renderNodeSection({
    heading: "About this board",
    extraClass: "node-card civic-object-section",
    attrs: { "data-community-board-about": "1" },
    body: `<ul class="node-record-list">${facts.join("")}</ul>`,
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
    heading: "Connected civic objects",
    id: "community-board-edge-summary-heading",
    className: "community-board-edge-summary",
    // The bounded coverage note above already states, once, which relation
    // categories are not yet established; this rail should not repeat that
    // as a second "Records not shown" line per category (RU-02 A1).
    omitOptionalUnknown: true,
  });
  const local = renderLocalConstellationHTML(view.local_constellation, {
    heading: "Nearby board connections",
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
  const sectionOrder = ["committees", "meetings", "members", "recommendations", "sources"];
  const semanticCategories = view.categories
    .filter((category) => sectionOrder.includes(category.id))
    .sort((a, b) => sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id));
  const renderedCategories = semanticCategories.filter((category) => category.id === "sources" || category.items?.length);
  const emptyCoverageCategories = semanticCategories.filter((category) => Object.hasOwn(EMPTY_COVERAGE_CATEGORY_LABELS, category.id) && !category.items?.length);
  const assetPrefix = options.assetPrefix || "/";
  const prefix = assetPrefix.endsWith("/") ? assetPrefix : `${assetPrefix}/`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Community board constellation · CityScroll</title>
<meta name="description" content="${esc(`Public source and place connections for ${title}.`)}">
<link rel="canonical" href="https://cityscroll.org${esc(view.path)}">${renderCivicDocumentAssets(assetPrefix)}
<link rel="stylesheet" href="${esc(`${prefix}local_constellation.css`)}">
<link rel="stylesheet" href="${esc(`${prefix}compact_calendar.css`)}"></head><body>
<a class="skip" href="#main">Skip to content</a>${renderCivicDocumentMast({ current: "browse", surfaceClass: "civic-object-mast" })}
<main id="main" class="node-document civic-object-document" data-civic-object-kind="community-board-constellation" data-subject-ref="${esc(view.subject_ref)}" data-node-document="1">
${renderNodeBack({ href: "/community-boards/", label: "Back to community board sources", extraClass: "civic-object-back" })}
<header class="node-hero civic-object-hero" data-export-class="object_identity"><p class="node-kicker civic-object-kicker">Community board</p><h1>${esc(title)}</h1><p class="node-lede">A local advisory body, its district, committees, proceedings, people, and official source coverage.</p><p class="node-pivot civic-object-pivot"><a href="${esc(place?.view_all_href || "/near-you/")}">Open this board’s place view</a> · <a href="${esc(institution)}">Open this board institution</a> · <a href="${esc(output)}">Open the source directory</a></p></header>
${renderRelatedPublicBodiesFor(view.body_id)}
  ${renderAboutBoardSection(view)}${renderCommunityBoardParticipationSection(view)}${renderCommunityBoardMoneyCard(view.money)}${renderCommunityBoardPayrollContext(view.payroll)}${renderCommunityBoardBylawPanel(view.governance)}${renderBoroughOfficeAppointmentSection(view.appointment_authority)}${renderEmptyCoverageNote(emptyCoverageCategories)}${renderedCategories.map((category) => renderCategory(category, view)).join("")}${edgeRail}${local}${actions}${renderUnjoinedSourceSection(view.source_records)}
</main>${renderNodeFooter({ extraClass: "civic-object-footer" })}
<script id="civic-object-payload" type="application/json">${payload}</script><script defer src="${esc(`${prefix}export_workflows.js`)}"></script>${renderCalendarEventPreviewScript(assetPrefix)}
</body></html>`;
}
