import { communityBoardPageHref } from "./community_board_links.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { entityHref } from "./entity_pivot.mjs";
import { renderEntityPivotLink } from "./edge_summary.mjs";
import {
  communityBoardMeetingEdgeAccepted,
  communityBoardMeetingEdgeFromRow,
} from "./community_board_institution_edges.mjs";
import { joinCommunityBoardSourceRecord } from "./community_board_source_join.mjs";
import { meetingCalendarHasEventTime } from "./hearing_attend_pack.mjs";
import { recognizedMeetingUrl } from "./hearing_logistics.mjs";

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

function meetingPlatform(href) {
  let hostname = "";
  try { hostname = new URL(href).hostname.toLowerCase(); } catch { return null; }
  if (hostname.includes("zoom")) return "Zoom";
  if (hostname.includes("teams.microsoft.com") || hostname.includes("teams.live.com")) return "Teams";
  if (hostname.includes("webex")) return "Webex";
  if (hostname === "meet.google.com") return "Google Meet";
  return null;
}

function isRegistrationUrl(href) {
  try {
    const url = new URL(href);
    return /\/(?:register|registration|rsvp)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function participationLink(link) {
  const href = safeHref(link?.url || link?.href);
  if (!href) return null;
  const recognized = recognizedMeetingUrl(href);
  const registration = isRegistrationUrl(href);
  // Keep the accepted meeting URL family plus explicit publisher registration
  // paths. Calendar/product URLs are intentionally rejected by both checks.
  if (!recognized && !registration) return null;
  const platform = meetingPlatform(href);
  const label = registration
    ? "Register to attend"
    : platform
      ? `Join online (${platform})`
      : /nycida-board-meetings-public-hearings|edc\.nyc\/nycida/i.test(href)
        ? "IDA meetings page"
        : String(link?.label || "Participation information");
  return { href, label };
}

function agencyHref(record) {
  const ref = String(record?.institution_refs?.agency_ref || "").trim();
  if (/^agency:id:[a-z0-9-]+$/i.test(ref)) {
    return entityHref({ ref, label: record?.agency || record?.agency_name || "Agency" });
  }
  const identity = resolveAgencyIdentity(record?.agency || record?.agency_name || "");
  return identity?.matched && identity.canonical_id
    ? entityHref({ ref: `agency:id:${identity.canonical_id}`, label: identity.canonical_name || record?.agency || record?.agency_name })
    : null;
}

function meetingSource(record, id, title, canonical) {
  return {
    kind: "meeting",
    id,
    name: title,
    canonical_href: canonical,
  };
}

function boardPivot(record, board, edge, source) {
  if (!board || (record.source_system !== "community_board" && !edge)) return "";
  const href = communityBoardPageHref(board);
  if (!href) return "";
  return renderEntityPivotLink({
    relation_label: "hosted by community board",
    target_kind: "community-board",
    target_id: board,
    target_name: record.board_name || "Community Board",
    canonical_href: href,
    status: edge && !communityBoardMeetingEdgeAccepted(edge) ? "held" : "accepted",
    source,
  }, { className: "meeting-entity-pivot", escape: esc });
}

function agencyPivot(record, agency, source) {
  const href = agencyHref(record);
  if (!agency || !href) return agency ? esc(agency) : "";
  const id = String(record?.institution_refs?.agency_ref || "").replace(/^agency:id:/, "")
    || resolveAgencyIdentity(agency)?.canonical_id;
  return renderEntityPivotLink({
    relation_label: "organized by agency",
    target_kind: "agency",
    target_id: id,
    target_name: agency,
    canonical_href: href,
    source,
  }, { className: "meeting-entity-pivot", escape: esc });
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
  if (!venue.address) {
    const address = [
      record.building_name,
      record.street_address_1,
      record.street_address_2,
      [record.city, record.state, record.zip_code].filter(Boolean).join(", "),
    ].filter(Boolean).join(", ");
    if (address) rows.push(`<span>${esc(address)}</span>`);
  }
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
  const links = [];
  const seen = new Set();
  for (const candidate of participation.links || []) {
    const link = participationLink(candidate);
    if (!link) continue;
    const key = `${link.label}\u0000${link.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  const remote = participationLink({ url: participation.remote_join_url, label: "Join online" });
  if (remote && !links.some((link) => link.href === remote.href)) {
    const key = `${remote.label}\u0000${remote.href}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push(remote);
    }
  }
  const items = links.map((link) => `<li><a href="${esc(link.href)}" rel="noopener noreferrer">${esc(link.label)}</a></li>`);
  for (const email of participation.emails || []) items.push(`<li><a href="mailto:${esc(email)}">${esc(email)}</a></li>`);
  for (const phone of participation.phones || []) {
    const tel = String(phone).replace(/[^0-9+]/g, "");
    if (tel) items.push(`<li><a href="tel:${esc(tel)}">${esc(phone)}</a></li>`);
  }
  return items;
}

function relatedLinksDetails(record) {
  const values = [
    ...(Array.isArray(record.related_links) ? record.related_links : []),
    ...(Array.isArray(record.source_links) ? record.source_links : []),
    ...(Array.isArray(record.document_links) ? record.document_links : []),
  ];
  const seen = new Set();
  const links = values.map((link) => {
    const href = safeHref(typeof link === "string" ? link : link?.url || link?.href);
    if (!href || seen.has(href)) return null;
    seen.add(href);
    return { href, label: typeof link === "string" ? "Related source" : link?.label || link?.title || "Related source" };
  }).filter(Boolean);
  return links.length
    ? `<section class="node-section civic-object-section meeting-section meeting-related-links"><h2>Related links</h2><ul>${links.map((link) => `<li><a href="${esc(link.href)}" rel="noopener noreferrer">${esc(link.label)}</a></li>`).join("")}</ul></section>`
    : "";
}

/** Render the source-qualified canonical meeting document used by every meeting card. */
export function renderMeetingDocument(record = {}) {
  const id = String(record.meeting_id || "").trim();
  const title = String(record.title || "Meeting").trim() || "Meeting";
  const canonical = `/meetings/${encodeURIComponent(id)}/`;
  const source = record.source_url || record.compatibility?.publisher_href || null;
  const edge = communityBoardMeetingEdgeFromRow(record);
  const board = boardId(record);
  const sourceEntity = meetingSource(record, id, title, canonical);
  const boardLink = board && (record.source_system === "community_board" || (edge && communityBoardMeetingEdgeAccepted(edge)))
    ? boardPivot(record, board, edge, sourceEntity)
    : "";
  const committeeName = record.committee?.name || null;
  const committeeHref = safeHref(record.committee?.href);
  const committeeLink = committeeName
    ? (committeeHref ? `<a href="${esc(committeeHref)}">${esc(committeeName)}</a>` : esc(committeeName))
    : "";
  const agency = record.agency || record.agency_name || null;
  const agencyLink = agency
    ? agencyPivot(record, agency, sourceEntity)
    : "";
  const legacy = safeHref(record.compatibility?.legacy_notice_href);
  const checked = record.source_receipt?.observed_at;
  const documentLinks = meetingDocumentLinks(record);
  const sourceDetails = [
    source ? `<a href="${esc(source)}" rel="noopener noreferrer">Official source</a>` : "",
    record.source_record_id ? `<span>Publisher record: <bdi>${esc(record.source_record_id)}</bdi></span>` : "",
    checked ? `<time datetime="${esc(checked)}">Source checked ${esc(checked)}</time>` : "",
  ].filter(Boolean).join(" · ");
  const agendaDocuments = documentLinks.filter((document) => ["Agenda", "Materials", "Recording"].includes(document.label) && safeHref(document.href));
  const documents = agendaDocuments.length
    ? `<section class="node-section civic-object-section meeting-section meeting-documents" data-meeting-documents="1"><h2>Agenda and materials</h2><ul>${agendaDocuments.map((document) => `<li><a href="${esc(safeHref(document.href))}" rel="noopener noreferrer">${esc(document.label)}</a>${document.date ? ` <time datetime="${esc(document.date)}">(${esc(document.date)})</time>` : ""}</li>`).join("")}</ul></section>`
    : "";
  const minutes = documentLinks.filter((document) => document.label === "Minutes" && safeHref(document.href));
  const minutesPublished = record.minutes_freshness?.status === "published" || (!record.minutes_freshness && minutes.length);
  const minutesSection = minutesPublished
    ? `<section class="node-section civic-object-section meeting-section meeting-minutes" data-meeting-minutes="1"><h2>Minutes</h2>${minutes.length ? `<ul>${minutes.map((document) => `<li><a href="${esc(safeHref(document.href))}" rel="noopener noreferrer">Minutes</a>${document.date ? ` <time datetime="${esc(document.date)}">(${esc(document.date)})</time>` : ""}</li>`).join("")}</ul>` : ""}<p class="meeting-freshness">Minutes published${record.minutes_freshness?.latest_date ? ` through <time datetime="${esc(record.minutes_freshness.latest_date)}">${esc(record.minutes_freshness.latest_date)}</time>` : ""}.</p></section>`
    : "";
  const locationRows = locationDetails(record);
  const locationSection = locationRows.length
    ? `<section class="node-section civic-object-section meeting-section meeting-location"><h2>Where</h2><ul>${locationRows.map((row) => `<li>${row}</li>`).join("")}</ul></section>`
    : "";
  const participationRows = participationDetails(record);
  const meetingMode = clean(record.venue?.mode, 80);
  const participationSection = participationRows.length || meetingMode
    ? `<section class="node-section civic-object-section meeting-section meeting-participation"><h2>How to participate</h2>${meetingMode ? `<p>Format: ${esc(meetingMode)}.</p>` : ""}${participationRows.length ? `<ul>${participationRows.join("")}</ul>` : ""}</section>`
    : "";
  const noticeMeta = [
    ["Type", record.type_of_notice_description],
    ["Section", record.section_name],
  ].filter(([, value]) => clean(value, 240));
  const noticeBody = [
    ["Description", record.additional_description_1],
    ["Additional description", record.additional_description_2],
    ["Additional description", record.additional_description_3],
    ["Other information", record.other_info_1],
    ["Other information", record.other_info_2],
    ["Other information", record.other_info_3],
  ].filter(([, value]) => clean(value, 6_000));
  const noticeDetailsSection = noticeMeta.length || noticeBody.length
    ? `<section class="node-section civic-object-section meeting-section meeting-notice-details"><h2>Notice details</h2>${noticeMeta.length ? `<dl>${noticeMeta.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>` : ""}${noticeBody.map(([label, value]) => `<div class="meeting-notice-block"><h3>${esc(label)}</h3><p>${esc(value)}</p></div>`).join("")}</section>`
    : "";
  const contactRows = [
    record.contact_name ? `<span>${esc(record.contact_name)}</span>` : "",
    record.contact_phone ? `<a href="tel:${esc(String(record.contact_phone).replace(/[^0-9+]/g, ""))}">${esc(record.contact_phone)}</a>` : "",
    record.email ? `<a href="mailto:${esc(record.email)}">${esc(record.email)}</a>` : "",
  ].filter(Boolean);
  const contactSection = contactRows.length
    ? `<section class="node-section civic-object-section meeting-section meeting-contact"><h2>Contact</h2><ul>${contactRows.map((row) => `<li>${row}</li>`).join("")}</ul></section>`
    : "";
  const relatedLinksSection = relatedLinksDetails(record);
  const institutionSection = boardLink || agencyLink || committeeLink
    ? `<section class="node-section civic-object-section meeting-section meeting-institution"><h2>Institution</h2>${boardLink ? `<p>${boardLink}</p>` : ""}${agencyLink ? `<p>${agencyLink}</p>` : ""}${committeeLink ? `<p>Committee: ${committeeLink}</p>` : ""}</section>`
    : "";
  const actions = [
    id && meetingCalendarHasEventTime(record) ? `<a class="node-action civic-object-action primary" href="/meeting.ics?id=${encodeURIComponent(id)}">Add to calendar</a>` : "",
    legacy ? `<a class="node-action civic-object-action" href="${esc(legacy)}">Open the City Record notice</a>` : "",
  ].filter(Boolean).join("");
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
<main id="main" class="civic-document node-document meeting-document" data-civic-object-kind="meeting" data-meeting-id="${esc(id)}" data-source-record-id="${esc(record.source_record_id || "")}" tabindex="-1">
  <p class="node-back"><a href="/browse/meetings/">Browse meetings and hearings</a></p>
  <section class="node-hero civic-object-hero meeting-hero"><p class="node-kicker civic-object-kicker">${esc(record.source_system === "community_board" ? "Community board meeting" : "City Record meeting")}</p><h1>${esc(title)}</h1>${record.event_date ? `<p class="node-lede"><time datetime="${esc(record.event_date)}">${esc(record.event_date)}</time></p>` : ""}</section>
  ${actions ? `<div class="node-actions civic-object-actions meeting-actions">${actions}</div>` : ""}
  ${institutionSection}
  ${locationSection}
  ${noticeDetailsSection}
  ${contactSection}
  ${relatedLinksSection}
  ${participationSection}
  ${documents}
  ${minutesSection}
  ${sourceDetails ? `<details class="node-section meeting-source-details"><summary>Source details</summary><p>${sourceDetails}</p></details>` : ""}
</main>
</body>
</html>`;
}
