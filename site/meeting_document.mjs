import { communityBoardCommitteePageHref, communityBoardPageHref } from "./community_board_links.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import {
  communityBoardMeetingEdgeAccepted,
  communityBoardMeetingEdgeFromRow,
} from "./community_board_institution_edges.mjs";
import { joinCommunityBoardSourceRecord } from "./community_board_source_join.mjs";

export const MEETING_DOCUMENT_SCHEMA = "cityscroll.meeting_document.v1";
export const MEETING_DOCUMENT_ROLES = Object.freeze([
  "minutes",
  "agenda",
  "materials",
  "recording",
  "source_record",
]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}(?:-\d{2})?)/);
  return match?.[1] || null;
}

function receiptFor(row) {
  return row.source_receipt || row.observed_receipt || row.source_provenance?.observed_receipt || null;
}

function documentId(row) {
  return clean(
    row.document_id
      || row.publisher_document_id
      || row.source_document_id
      || row.source_record_id
      || row.record_id,
    2_000,
  ) || null;
}

function canonicalMeetingKey(row) {
  return clean(
    row.meeting_id
      || row.meeting_key
      || row.canonical_meeting_id
      || row.meeting_join?.meeting_id
      || row.meeting_join?.join?.meeting_id,
    2_000,
  ) || null;
}

function role(row) {
  const value = clean(row.role || row.document_role || row.source_role || row.category, 80).toLowerCase();
  if (MEETING_DOCUMENT_ROLES.includes(value)) return value;
  if (/minute/.test(value)) return "minutes";
  if (/agenda/.test(value)) return "agenda";
  if (/material|packet|item/.test(value)) return "materials";
  if (/record|video|audio/.test(value)) return "recording";
  return "source_record";
}

function sourceStatus(receipt) {
  if (!receipt || receipt.status !== "ok") return "unavailable";
  if (!receipt.observed_at) return "unknown";
  return "available";
}

/**
 * Normalize one publisher document without turning its URL or date into a
 * meeting identity. A meeting key is retained only when the source supplied
 * the exact canonical meeting id.
 */
export function normalizeMeetingDocument(row = {}) {
  const id = documentId(row);
  const sourceUrl = clean(row.document_url || row.record_url || row.source_url, 2_000) || null;
  const receipt = receiptFor(row);
  const meetingDate = date(row.meeting_date || row.event_date || row.date);
  const publicationDate = date(row.publication_date || row.published_date || row.published_at);
  const boardId = clean(row.board_id || row.body_id, 100) || null;
  const meetingKey = canonicalMeetingKey(row);
  return {
    object_type: "meeting_document",
    schema: MEETING_DOCUMENT_SCHEMA,
    role: role(row),
    document_id: id,
    publisher_document_id: id,
    source_document_id: id,
    document_url: sourceUrl,
    source_url: clean(row.source_url || sourceUrl, 2_000) || null,
    board_id: boardId,
    body_id: boardId,
    title: clean(row.title || row.name, 500) || null,
    meeting_date: meetingDate,
    publication_date: publicationDate,
    date: meetingDate || publicationDate,
    format: clean(row.format || "unknown", 80) || "unknown",
    adapter: clean(row.adapter || row.adapter_id || receipt?.parser, 120) || null,
    source_receipt: receipt,
    source_status: sourceStatus(receipt),
    meeting_key: meetingKey,
    meeting_id: meetingKey,
    publisher_identifier: clean(row.publisher_identifier || row.publisher_document_id || id, 2_000) || null,
    source_record_id: id,
    join: row.join || row.meeting_join || null,
    attachment_status: ["attached", "ambiguous", "unavailable"].includes(row.attachment_status)
      ? row.attachment_status
      : "unlinked",
    attachment_reason: row.attachment_reason || "no_exact_meeting_key",
    attachment_method: clean(row.attachment_method, 80) || null,
  };
}

function exactKeyForMeeting(document, meeting) {
  const key = document.meeting_id || document.meeting_key;
  return Boolean(key && meeting?.meeting_id && key === meeting.meeting_id);
}

function exactEvidenceForMeeting(document, meeting, options = {}) {
  if (!meeting?.meeting_id || !document?.board_id) return null;
  const joined = joinCommunityBoardSourceRecord(meeting, {
    ...document,
    record_kind: "document",
    record_id: document.document_id,
    source_record_id: document.source_record_id,
    record_url: document.document_url,
    date: document.meeting_date || document.date,
    observed_receipt: document.source_receipt,
    publisher_identifier: document.publisher_identifier,
    board_id: document.board_id,
    body_id: document.body_id,
  }, options);
  return joined.official ? joined : null;
}

function attach(document, meeting, method, join = null) {
  return {
    ...document,
    meeting_id: meeting.meeting_id,
    meeting_key: meeting.meeting_id,
    attachment_status: "attached",
    attachment_reason: null,
    attachment_method: method,
    join: join || document.join || null,
  };
}

/**
 * Attach documents only through an exact canonical meeting key or the
 * existing exact board/date/publisher join. Date and title are never enough.
 * Every document remains in `documents`, including orphan and ambiguous rows.
 */
export function attachMeetingDocuments(meetings = [], documents = [], options = {}) {
  const meetingRows = Array.isArray(meetings) ? meetings : [];
  const normalized = (Array.isArray(documents) ? documents : []).map(normalizeMeetingDocument);
  const attachedByMeeting = new Map(meetingRows.map((meeting) => [meeting.meeting_id, []]));
  const output = normalized.map((document) => {
    const exact = meetingRows.filter((meeting) => exactKeyForMeeting(document, meeting));
    if (exact.length === 1) {
      if (document.source_status !== "available") {
        return { ...document, attachment_status: "unavailable", attachment_reason: "source_unavailable" };
      }
      const attached = attach(document, exact[0], "exact_meeting_key");
      attachedByMeeting.get(exact[0].meeting_id)?.push(attached);
      return attached;
    }
    if (exact.length > 1) {
      return { ...document, attachment_status: "ambiguous", attachment_reason: "duplicate_meeting_key" };
    }
    const evidence = meetingRows.flatMap((meeting) => {
      const join = exactEvidenceForMeeting(document, meeting, options);
      return join ? [{ meeting, join }] : [];
    });
    if (evidence.length === 1) {
      const attached = attach(document, evidence[0].meeting, "exact_source_join", evidence[0].join);
      attachedByMeeting.get(evidence[0].meeting.meeting_id)?.push(attached);
      return attached;
    }
    if (evidence.length > 1) {
      return { ...document, attachment_status: "ambiguous", attachment_reason: "ambiguous_exact_source_join" };
    }
    return {
      ...document,
      attachment_status: document.source_status === "unavailable" ? "unavailable" : "unlinked",
      attachment_reason: document.source_status === "unavailable" ? "source_unavailable" : "no_exact_meeting_key",
    };
  });
  const rows = meetingRows.map((meeting) => ({
    ...meeting,
    meeting_documents: attachedByMeeting.get(meeting.meeting_id) || [],
  }));
  return {
    meetings: rows,
    documents: output,
    attached_documents: output.filter((document) => document.attachment_status === "attached"),
    orphan_documents: output.filter((document) => ["unlinked", "unavailable"].includes(document.attachment_status)),
    ambiguous_documents: output.filter((document) => document.attachment_status === "ambiguous"),
  };
}

export function meetingDocumentLinks(record = {}) {
  const documents = Array.isArray(record.meeting_documents) ? record.meeting_documents : [];
  return documents
    .filter((document) => document?.attachment_status === "attached" && document.document_url)
    .map((document) => ({
      role: document.role,
      label: document.role === "minutes" ? "Minutes" : document.role === "agenda" ? "Agenda" : document.role === "materials" ? "Materials" : document.role === "recording" ? "Recording" : "Source record",
      href: document.document_url,
      date: document.meeting_date || document.publication_date || document.date || null,
      source_status: document.source_status,
    }));
}

export function latestMeetingDocumentDate(documents = [], roleName = "minutes") {
  const dates = (Array.isArray(documents) ? documents : [])
    .filter((document) => document?.attachment_status === "attached" && (!roleName || document.role === roleName))
    .map((document) => document.meeting_date || document.publication_date || document.date)
    .filter(Boolean)
    .sort();
  return dates.at(-1) || null;
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function boardId(record) {
  const edge = communityBoardMeetingEdgeFromRow(record);
  return edge?.from?.replace(/^community-board:/, "")
    || record?.institution_refs?.board_ref?.replace(/^community-board:/, "")
    || record?.board_id
    || null;
}

function safeHref(value) {
  const text = String(value || "").trim();
  if (/^https:\/\//i.test(text) || /^\//.test(text)) return text;
  return null;
}

function agencyHref(record) {
  const ref = String(record?.institution_refs?.agency_ref || "").trim();
  if (/^agency:id:[a-z0-9-]+$/i.test(ref)) return `/agencies/${encodeURIComponent(ref.slice("agency:id:".length))}/`;
  const identity = resolveAgencyIdentity(record?.agency || record?.agency_name || "");
  return identity?.matched && identity.canonical_id
    ? `/agencies/${encodeURIComponent(identity.canonical_id)}/`
    : null;
}

function nearYouHref(kind, value, borough = null) {
  const text = String(value || "").trim();
  if (!text) return null;
  const params = new URLSearchParams({ v: "0", lens: "meetings" });
  if (kind === "borough") params.set("boro", text);
  if (kind === "community_district") {
    params.set("level", "community_district");
    params.set("id", text);
    if (borough) params.set("parent", borough);
  }
  if (kind === "council_district") params.set("council", text);
  return `/near-you/?${params}`;
}

function locationDetails(record) {
  const venue = record.venue || {};
  const area = record.affected_area || {};
  const borough = venue.borough || area.boroughs?.[0] || null;
  const rows = [];
  if (venue.name) rows.push(`<span>${esc(venue.name)}</span>`);
  if (venue.address) rows.push(`<span>${esc(venue.address)}</span>`);
  if (borough) rows.push(`<a href="${esc(nearYouHref("borough", borough))}">${esc(borough)}</a>`);
  for (const value of area.community_districts || []) {
    rows.push(`<a href="${esc(nearYouHref("community_district", value, borough))}">Community District ${esc(value)}</a>`);
  }
  for (const value of area.council_districts || []) {
    rows.push(`<a href="${esc(nearYouHref("council_district", value))}">Council District ${esc(value)}</a>`);
  }
  return rows;
}

function participationDetails(record) {
  const participation = record.participation || {};
  const links = (participation.links || []).filter((link) => safeHref(link?.url));
  const items = links.map((link) => `<li><a href="${esc(safeHref(link.url))}" rel="noopener noreferrer">${esc(link.label || "Participation information")}</a></li>`);
  if (participation.remote_join_url && !links.some((link) => link.url === participation.remote_join_url)) {
    items.push(`<li><a href="${esc(safeHref(participation.remote_join_url))}" rel="noopener noreferrer">Join online</a></li>`);
  }
  for (const email of participation.emails || []) items.push(`<li><a href="mailto:${esc(email)}">${esc(email)}</a></li>`);
  for (const phone of participation.phones || []) items.push(`<li><a href="tel:${esc(String(phone).replace(/[^0-9+]/g, ""))}">${esc(phone)}</a></li>`);
  return items;
}

function emptyDetail(label) {
  return `<p class="meeting-empty"><span class="meeting-detail-label">${esc(label)}:</span> Not published.</p>`;
}

/** Render the source-qualified canonical meeting document used by every meeting card. */
export function renderMeetingDocument(record = {}) {
  const id = String(record.meeting_id || "").trim();
  const title = String(record.title || "Meeting").trim() || "Meeting";
  const canonical = `/meetings/${encodeURIComponent(id)}/`;
  const source = record.source_url || record.compatibility?.publisher_href || null;
  const edge = communityBoardMeetingEdgeFromRow(record);
  const board = boardId(record);
  const boardLink = board && (record.source_system === "community_board" || (edge && communityBoardMeetingEdgeAccepted(edge)))
    ? `<a href="${esc(communityBoardPageHref(board))}">${esc(record.board_name || "Community Board")}</a>`
    : "";
  const committeeName = record.committee?.name || null;
  const committeeHref = safeHref(record.committee?.href)
    || (committeeName && board ? communityBoardCommitteePageHref(board, committeeName) : null);
  const committeeLink = committeeName
    ? (committeeHref ? `<a href="${esc(committeeHref)}">${esc(committeeName)}</a>` : esc(committeeName))
    : "";
  const agency = record.agency || record.agency_name || null;
  const agencyLink = agency
    ? (agencyHref(record) ? `<a href="${esc(agencyHref(record))}">${esc(agency)}</a>` : esc(agency))
    : "";
  const legacy = record.compatibility?.legacy_notice_href;
  const checked = record.source_receipt?.observed_at;
  const documentLinks = meetingDocumentLinks(record);
  const sourceDetails = [
    source ? `<a href="${esc(source)}" rel="noopener noreferrer">Official source</a>` : "",
    record.source_record_id ? `<span>Publisher record: <bdi>${esc(record.source_record_id)}</bdi></span>` : "",
    checked ? `<time datetime="${esc(checked)}">Source checked ${esc(checked)}</time>` : "",
  ].filter(Boolean).join(" · ");
  const documents = documentLinks.length
    ? `<section class="meeting-documents" data-meeting-documents="1"><h2>Agenda and materials <span class="sr-only">Minutes and records</span></h2><ul>${documentLinks.filter((document) => ["Agenda", "Materials", "Recording", "Source record"].includes(document.label)).map((document) => `<li><a href="${esc(document.href)}" rel="noopener noreferrer">${esc(document.label)}</a>${document.date ? ` <time datetime="${esc(document.date)}">(${esc(document.date)})</time>` : ""}</li>`).join("") || `<li>Not published.</li>`}</ul></section>`
    : `<section class="meeting-documents"><h2>Agenda and materials</h2>${emptyDetail("Agenda and materials")}</section>`;
  const minutes = documentLinks.filter((document) => document.label === "Minutes");
  const minutesStatus = record.minutes_freshness?.status === "published" || (!record.minutes_freshness && minutes.length)
    ? `Published${record.minutes_freshness?.latest_date ? ` through ${esc(record.minutes_freshness.latest_date)}` : ""}`
    : record.minutes_freshness?.status === "unknown" ? "Status unknown." : "Not published.";
  const minutesSection = `<section class="meeting-minutes" data-meeting-minutes="1"><h2>Minutes</h2>${minutes.length ? `<ul>${minutes.map((document) => `<li><a href="${esc(document.href)}" rel="noopener noreferrer">Minutes</a>${document.date ? ` <time datetime="${esc(document.date)}">(${esc(document.date)})</time>` : ""}</li>`).join("")}</ul>` : ""}<p>Minutes status: ${minutesStatus}</p></section>`;
  const locationRows = locationDetails(record);
  const locationSection = `<section class="meeting-location"><h2>Where</h2>${locationRows.length ? `<ul>${locationRows.map((row) => `<li>${row}</li>`).join("")}</ul>` : emptyDetail("Where")}</section>`;
  const participationRows = participationDetails(record);
  const participationSection = `<section class="meeting-participation"><h2>How to participate</h2>${record.event_date ? `<p>Scheduled for <time datetime="${esc(record.event_date)}">${esc(record.event_date)}</time>${record.venue?.mode ? ` · ${esc(record.venue.mode)}` : ""}.</p>` : ""}${participationRows.length ? `<ul>${participationRows.join("")}</ul>` : emptyDetail("Participation")}</section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CityScroll</title>
<meta name="description" content="Public meeting record from CityScroll.">
<link rel="canonical" href="https://cityscroll.org${esc(canonical)}">
<link rel="stylesheet" href="/brand.css">
<link rel="stylesheet" href="/civic-documents.css">
</head>
<body>
<header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/">CityScroll</a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/following/">Following</a><a href="/browse/">Browse</a></nav></div></header>
<main id="main" class="civic-document meeting-document" data-civic-object-kind="meeting" data-meeting-id="${esc(id)}" data-source-record-id="${esc(record.source_record_id || "")}">
  <p class="node-back"><a href="/browse/meetings/">Browse meetings and hearings</a></p>
  <p class="node-kicker">${esc(record.source_system === "community_board" ? "Community board meeting" : "City Record meeting")}</p>
  <h1>${esc(title)}</h1>
  ${record.event_date ? `<p><time datetime="${esc(record.event_date)}">${esc(record.event_date)}</time></p>` : ""}
  <section class="meeting-institution"><h2>Institution</h2>${boardLink ? `<p>${boardLink}</p>` : agencyLink ? `<p>${agencyLink}</p>` : emptyDetail("Institution")}${committeeLink ? `<p>Committee: ${committeeLink}</p>` : ""}</section>
  ${locationSection}
  ${participationSection}
  ${documents}
  ${minutesSection}
  <p><a class="node-action primary" href="/meeting.ics?id=${encodeURIComponent(id)}">Add to calendar</a>${legacy ? ` · <a href="${esc(legacy)}">Open the City Record notice</a>` : ""}</p>
  ${sourceDetails ? `<details class="meeting-source-details"><summary>Source details</summary><p>${sourceDetails}</p></details>` : ""}
</main>
</body>
</html>`;
}
