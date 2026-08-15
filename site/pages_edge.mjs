import { BROWSE_FACETS, BROWSE_OBJECTS, buildBrowseView, renderBrowseView } from "./browse_view.mjs";
import { BROWSE_CONCEPTS } from "./browse_concept_view.mjs";
import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import { agencyRouteAliasTarget, resolveAgencyIdentity } from "./agency_identity.mjs";
import { renderMeetingOutcomesFirstPaint } from "./meeting_outcomes_static.mjs";
import { renderMeetingDocument } from "./meeting_document.mjs";
import { meetingCalendarICS } from "./hearing_attend_pack.mjs";
import sharedMeetingSnapshot from "./data/shared_meeting_read_model.json" with { type: "json" };
import { renderNoticeMandateBacklinksForId } from "./notice_mandate_backlinks.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { renderEntityPivotLink } from "./edge_summary.mjs";
import { buildLocalConstellation, renderLocalConstellationHTML } from "./local_constellation.mjs";
import {
  communityBoardMeetingEdgeAccepted,
  communityBoardMeetingEdgeFromRow,
} from "./community_board_institution_edges.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";

const CITY_RECORD_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const NOTICE_READ_MODEL = "https://api.cityscroll.org/notice";
const HEARINGS_READ_MODEL = "https://api.cityscroll.org/hearings";
const NOTICE_FIELDS = [
  "request_id", "start_date", "event_date", "due_date", "agency_name",
  "type_of_notice_description", "section_name", "short_title", "pin",
  "category_description", "selection_method_description", "street_address_1",
  "additional_description_1", "vendor_name",
].join(",");

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function firstNoticeAttachmentUrl(row) {
  const value = row?.document_links;
  const candidate = Array.isArray(value) ? value[0] : value && typeof value === "object" ? (value.url || value.href || value.link) : value;
  if (!candidate) return null;
  try {
    const url = new URL(String(candidate).replaceAll("&amp;", "&"));
    const documentId = url.searchParams.get("documentId") || url.searchParams.get("DocumentID") || url.searchParams.get("documentid");
    if (url.protocol !== "https:" || url.hostname !== "a856-cityrecord.nyc.gov" || !/^\/Search\/GetFile$/i.test(url.pathname) || !documentId) return null;
    return url.href;
  } catch (_error) {
    return null;
  }
}

function safeId(pathname) {
  const match = pathname.match(/^\/notices\/([A-Za-z0-9_-]{1,80})\/?$/);
  return match ? match[1] : null;
}

function safeMeeting(pathname) {
  const match = pathname.match(/^\/meetings\/([^/?#]{1,320})\/?$/);
  return match ? match[1] : null;
}

function safeExamNumber(pathname) {
  const match = pathname.match(/^\/exams\/(\d{4})\/?$/);
  return match ? match[1] : null;
}

function safeMonitorPack(pathname) {
  const match = pathname.match(/^\/following\/packs\/([a-z0-9][a-z0-9-]{0,79})\/?$/);
  return match ? match[1] : null;
}

function safeDistrictDigest(pathname) {
  const match = pathname.match(/^\/districts\/council\/((?:[1-9]|[1-4]\d|5[01]))\/digest\/?$/);
  return match ? match[1] : null;
}

function safeParcel(pathname) {
  const match = pathname.match(/^\/parcels\/(\d{10})\/?$/);
  return match ? match[1] : null;
}

export function browseFacet(pathname) {
  const match = pathname.match(/^\/browse(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const facet = match[1];
  if (!facet) return null;
  return Object.hasOwn(BROWSE_FACETS, facet) ? facet : null;
}

export function browseConcept(pathname) {
  const match = String(pathname || "").match(/^\/browse\/([^/]+)\/?$/);
  return match && Object.hasOwn(BROWSE_CONCEPTS, match[1]) ? match[1] : null;
}

export function browseObject(pathname) {
  const match = String(pathname || "").match(/^\/browse\/([^/]+)\/?$/);
  return match && Object.hasOwn(BROWSE_OBJECTS, match[1]) ? match[1] : null;
}

export function browseRoute(pathname) {
  const match = String(pathname || "").match(/^\/browse(?:\/([^/]+))?\/?$/);
  if (!match) return { kind: "other", facet: null };
  if (!match[1]) return { kind: "landing", facet: null };
  const facet = browseFacet(pathname);
  const concept = browseConcept(pathname);
  const object = browseObject(pathname);
  if (concept) return { kind: "concept", concept };
  if (object) return { kind: "object", object };
  return facet ? { kind: "facet", facet } : { kind: "unknown", facet: match[1] };
}

function entityDocument(pathname) {
  const match = pathname.match(/^\/(agencies|vendors|officials)\/([^/]{1,320})\/?$/);
  return match ? { family: match[1], id: match[2] } : null;
}

export function edgeRequestKind(urlValue) {
  const url = new URL(urlValue);
  if (safeId(url.pathname)) return "notice";
  if (safeMeeting(url.pathname)) return "meeting";
  if (safeExamNumber(url.pathname)) return "exam";
  if (safeMonitorPack(url.pathname)) return "monitor-pack";
  if (safeDistrictDigest(url.pathname)) return "district-digest";
  if (safeParcel(url.pathname)) return "parcel";
  if (browseFacet(url.pathname) || browseConcept(url.pathname) || browseObject(url.pathname)) return "browse";
  if (entityDocument(url.pathname)) return "entity";
  return "asset";
}

async function handleMeeting(request, env, meetingId) {
  let decoded;
  try { decoded = decodeURIComponent(meetingId); } catch (_error) {
    return new Response("Invalid meeting link", { status: 400 });
  }
  const snapshotRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
  const snapshot = await staticAsset(env, snapshotRequest, "/data/shared_meeting_read_model.json");
  let record = null;
  if (snapshot.ok) {
    try {
      const payload = await snapshot.json();
      const rows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.hearings) ? payload.hearings : [];
      record = rows.find((row) => row?.meeting_id === decoded) || null;
    } catch (_error) {
      record = null;
    }
  }
  // The static catalog is the normal resolver source, but the Meetings lens can
  // contain a newer City Record row from the Worker materialization between
  // Pages builds. Resolve that exact canonical id against the same fresh
  // catalog the lens reads before declaring it genuinely unknown.
  if (!record && /^meeting:city_record:\d+$/.test(decoded)) {
    try {
      const url = new URL(HEARINGS_READ_MODEL);
      url.searchParams.set("id", decoded);
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (response.ok) {
        const payload = await response.json();
        const rows = Array.isArray(payload?.rows)
          ? payload.rows
          : Array.isArray(payload?.hearings) ? payload.hearings : [];
        record = rows.find((row) => row?.meeting_id === decoded) || null;
      }
    } catch (_error) {
      // Preserve the fail-closed not-found response when the fresh catalog is
      // unavailable or malformed.
    }
  }
  if (record) {
    const html = renderMeetingDocument(record);
    if (isMeetingDocumentHtml(html, decoded)) {
      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff",
      });
      return request.method === "HEAD"
        ? new Response(null, { status: 200, headers })
        : new Response(html, { status: 200, headers });
    }
  }
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Meeting · CityScroll</title></head><body><main><h1>Meeting</h1><p>This meeting is not in the current Meetings view.</p><p><a href="/browse/meetings/">Browse meetings</a></p></main></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } },
  );
}

function meetingRows(payload) {
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.hearings)) return payload.hearings;
  return [];
}

function meetingForCalendar(rows, id) {
  return meetingRows(rows).find((row) => row?.meeting_id === id)
    || meetingRows(rows).find((row) => row?.source_system === "city_record" && (
      row?.request_id === id || row?.source_record_id === id
    ))
    || null;
}

/** Serve a calendar event from the shared materialized meeting projection. */
async function handleMeetingICS(request, env) {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  }
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id || id.length > 320 || /[\r\n]/.test(id)) return new Response("invalid meeting id", { status: 400 });

  let snapshot = sharedMeetingSnapshot;
  const asset = await staticAsset(env, request, "/data/shared_meeting_read_model.json");
  if (asset.ok) {
    try { snapshot = await asset.json(); } catch (_error) { /* use the bundled projection */ }
  }
  const record = meetingForCalendar(snapshot, id);
  if (!record) return new Response("meeting not found", { status: 404 });
  const ics = meetingCalendarICS(record);
  if (!ics) return new Response("meeting has no event time", { status: 404 });
  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-${id.replace(/[^A-Za-z0-9_-]+/g, "-")}.ics"`,
      "Cache-Control": "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const DOCUMENT_LANGS = new Set(["en", "es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]);

function decodeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** True when HTML is a built meeting document for this exact canonical id. */
export function isMeetingDocumentHtml(html, meetingId) {
  if (typeof html !== "string" || !html.match(/\bdata-civic-object-kind\s*=\s*(["'])meeting\1/i)) return false;
  const idMatch = html.match(/\bdata-meeting-id\s*=\s*(["'])(.*?)\1/i);
  return Boolean(idMatch && decodeHtmlAttribute(idMatch[2]) === String(meetingId));
}

/** True when HTML is a built exam document, not the SPA shell or another surface. */
export function isExamDocumentHtml(html) {
  return typeof html === "string" && html.includes('data-exam-document="1"');
}

/**
 * Honest not-found for an exam id with no staffing document.
 * Never fall through to the contracts SPA shell.
 */
export function renderExamUnavailable(examNumber) {
  const id = String(examNumber || "").trim();
  const title = id ? `Exam ${id}` : "Exam";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · CityScroll</title>
<link rel="canonical" href="https://cityscroll.org/exams/${esc(id)}/">
</head>
<body>
<main id="main" class="panel route-item" data-edge-rendered="exam-unavailable" data-exam-number="${esc(id)}" tabindex="-1">
  <p class="ftype">Civil service exam</p>
  <h1 class="rolename">${esc(title)}</h1>
  <p>This exam is not in the current staffing guide on CityScroll.</p>
  <p><a href="/browse/staffing/">Browse staffing exams</a></p>
</main>
</body>
</html>`;
}

function examUnavailableResponse(examNumber, status = 404) {
  return new Response(renderExamUnavailable(examNumber), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleExam(request, env, examNumber) {
  const url = new URL(request.url);
  const asset = await staticAsset(env, request, `/exams/${examNumber}/`);
  // Missing document or SPA-fallback body: never rewrite the home shell as an exam page.
  if (!asset.ok) return examUnavailableResponse(examNumber, asset.status === 404 ? 404 : asset.status);
  const body = await asset.text();
  if (!isExamDocumentHtml(body)) return examUnavailableResponse(examNumber, 404);
  const language = DOCUMENT_LANGS.has(url.searchParams.get("lang")) && url.searchParams.get("lang") !== "en"
    ? url.searchParams.get("lang") : null;
  const canonical = `https://cityscroll.org/exams/${examNumber}/${language ? `?lang=${encodeURIComponent(language)}` : ""}`;
  const document = new Response(body, { status: 200, headers: asset.headers });
  const response = rewrittenResponse(document, 200, "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400");
  // Node unit tests do not provide the Workers HTMLRewriter runtime.
  if (typeof HTMLRewriter === "undefined") {
    return request.method === "HEAD"
      ? new Response(null, { status: 200, headers: response.headers })
      : response;
  }
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

async function handleComposedObject(request, env, pathname, canonicalPath) {
  const asset = await staticAsset(env, request, pathname);
  if (!asset.ok) return asset;
  const canonical = `https://cityscroll.org${canonicalPath}`;
  const response = rewrittenResponse(asset, 200, "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400");
  // Node unit tests do not provide the Workers HTMLRewriter runtime.
  if (typeof HTMLRewriter === "undefined") {
    return request.method === "HEAD"
      ? new Response(null, { status: 200, headers: response.headers })
      : response;
  }
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

export function renderEdgeNotice(row, id, meetingOutcome = null, mandateBacklinksLookup = null) {
  const kind = row?.type_of_notice_description || row?.section_name || "Public record";
  const title = row?.short_title || (row ? `${kind} ${id}` : `CityScroll public record ${id}`);
  const agency = row?.agency_name || "Agency not listed";
  const source = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  const browseLink = constellationLink({ href: "/browse/", label: "Browse public records", className: "act primary", escape: esc });
  const followingLink = constellationLink({ href: "/following/", label: "Follow public records", className: "act", escape: esc });
  const sourceLink = officialSourceLink({ href: source, label: "Official record", escape: esc });
  const identity = resolveAgencyIdentity(agency);
  const vendor = String(row?.vendor_name || "").trim();
  const noticeLocalConstellation = buildLocalConstellation({
    kind: "record",
    subject_ref: `notice:${id}`,
    subject_id: id,
    subject_name: title,
    source: null,
    provenance: null,
    neighbors: row ? [
      identity.matched ? {
        edge_type: "published_by_agency",
        relation_label: "published by agency",
        target_kind: "agency",
        target_id: identity.canonical_id,
        target_name: agency,
        href: `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
        state: "matched",
        provenance: null,
      } : null,
      vendor ? {
        edge_type: "named_vendor",
        relation_label: "named vendor",
        target_kind: "vendor",
        target_id: vendor,
        target_name: vendor,
        href: entityHref({ ref: entityRouteRef("vendor", vendor), label: vendor }),
        state: "matched",
        provenance: null,
      } : null,
      /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(String(row.project_id || row.project || row.ulurp_number || "").trim()) ? {
        edge_type: "related_land_use_project",
        relation_label: "related land-use project",
        target_kind: "project",
        target_id: String(row.project_id || row.project || row.ulurp_number).trim(),
        target_name: row.project_name || String(row.project_id || row.project || row.ulurp_number).trim(),
        href: `#land/${encodeURIComponent(String(row.project_id || row.project || row.ulurp_number).trim())}`,
        state: "matched",
        provenance: null,
      } : null,
    ].filter(Boolean) : [],
  });
  const noticeLocalConstellationHTML = renderLocalConstellationHTML(noticeLocalConstellation, {
    heading: "Nearby record connections",
    id: "notice-local-constellation-heading",
  });
  if (!row) {
    return `<div class="panel route-item" tabindex="-1" data-edge-rendered="notice-unavailable" data-notice-id="${esc(id)}">
      <p class="ftype">${esc(kind)}</p><h2 class="rolename">${esc(title)}</h2>
      <p>Continue with related public records or check the official record.</p>
      ${noticeLocalConstellationHTML}
      <div class="actions">${browseLink}${followingLink}</div>
      <p>${sourceLink}</p>
    </div>`;
  }
  const noticeSource = {
    kind: "notice",
    id: id,
    name: title,
    canonical_href: `/notices/${encodeURIComponent(id)}`,
  };
  const agencyLink = identity.matched
    ? renderEntityPivotLink({
      relation_label: "published by agency",
      target_kind: "agency",
      target_id: identity.canonical_id,
      target_name: agency,
      canonical_href: `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
      source: noticeSource,
    }, { className: "notice-agency-link", escape: esc })
    : esc(agency);
  const vendorLink = vendor
    ? renderEntityPivotLink({
      relation_label: "named vendor",
      target_kind: "vendor",
      target_id: vendor,
      target_name: vendor,
      link_confidence: "strong",
      canonical_href: entityHref({ ref: entityRouteRef("vendor", vendor), label: vendor }),
      source: noticeSource,
    }, { className: "notice-vendor-link", escape: esc })
    : "";
  const attachmentUrl = !row.additional_description_1 ? firstNoticeAttachmentUrl(row) : null;
  const facts = [
    ["Published", row.start_date], ["Event", row.event_date],
    ["Responses due", row.due_date], ["PIN", row.pin], ["Category", row.category_description],
    ["Selection method", row.selection_method_description], ["Address", row.street_address_1],
  ].filter(([, value]) => value);
  // Public mandate backlinks only — empty lookup / unmatched notice → no section.
  const mandateBacklinksHTML = renderNoticeMandateBacklinksForId(mandateBacklinksLookup, id, { esc });
  const projectId = String(row.project_id || row.project || row.ulurp_number || "").trim();
  const projectPivot = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(projectId)
    ? `<p class="notice-entity-pivot">${renderEntityPivotLink({
      relation_label: "related land-use project",
      target_kind: "project",
      target_id: projectId,
      target_name: row.project_name || projectId,
      canonical_href: `#land/${encodeURIComponent(projectId)}`,
      source: noticeSource,
    }, { className: "notice-project-link", escape: esc })}</p>`
    : "";
  const boardEdge = communityBoardMeetingEdgeFromRow(row);
  const boardId = boardEdge?.from?.replace(/^community-board:/, "")
    || row.institution_refs?.board_ref?.replace(/^community-board:/, "")
    || row.board_id;
  const boardHref = boardEdge?.board_href || communityBoardPageHref(boardId);
  const boardName = row.board_name || boardEdge?.board_name
    || (boardId ? `Community Board ${boardId.replace(/^[a-z-]+-cb-/, "")}` : null);
  const boardPivot = boardEdge && communityBoardMeetingEdgeAccepted(boardEdge) && boardHref
    ? `<p class="notice-entity-pivot">${renderEntityPivotLink({
      relation_label: "hosted by community board",
      target_kind: "community-board",
      target_id: boardId,
      target_name: boardName,
      canonical_href: boardHref,
      source: { kind: "meeting", id: row.meeting_id || `meeting:city_record:${id}`, name: title, canonical_href: `/notices/${encodeURIComponent(id)}` },
    }, { className: "notice-community-board-link", escape: esc })}</p>`
    : "";
  return `<div style="max-width:880px;margin:0 auto" data-edge-rendered="notice" data-notice-id="${esc(id)}">
    <p style="margin:4px 0 12px"><a href="/browse/">Back to Browse</a></p>
    <article class="panel route-item" tabindex="-1">
      <p class="ftype">${esc(kind)}${row.section_name && row.section_name !== kind ? ` · ${esc(row.section_name)}` : ""} · ${agencyLink}</p>
      <h2 class="rolename" lang="en" dir="ltr">${esc(title)}</h2>
      ${projectPivot}
      ${boardPivot}
      <dl class="glance"><dt>Agency</dt><dd lang="en" dir="ltr">${agencyLink}</dd>${vendorLink ? `<dt>Vendor</dt><dd lang="en" dir="ltr">${vendorLink}</dd>` : ""}${facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd lang="en" dir="ltr">${esc(value)}</dd>`).join("")}</dl>
      ${attachmentUrl ? `<p class="notice-attachment-fallback">The official notice content is in an attachment: <a href="${esc(attachmentUrl)}" target="_blank" rel="noopener noreferrer">Read the attachment</a>.</p>` : ""}
      ${row.additional_description_1 ? `<details class="scope"><summary>Notice text</summary><p lang="en" dir="ltr">${esc(row.additional_description_1)}</p></details>` : ""}
      ${mandateBacklinksHTML}
      ${noticeLocalConstellationHTML}
      ${renderMeetingOutcomesFirstPaint(meetingOutcome, id)}
      <div class="actions">${browseLink}${followingLink}</div>
      <p>${sourceLink}</p>
    </article>
  </div>`;
}

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return new Request(url, request);
}

async function staticAsset(env, request, pathname) {
  return env.ASSETS.fetch(assetRequest(request, pathname));
}

function rewrittenResponse(asset, status, cacheControl) {
  const headers = new Headers(asset.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Location");
  headers.set("Cache-Control", cacheControl);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(asset.body, { status, headers });
}

async function noticeRow(id) {
  // Ordinary document reads use the Worker/D1 projection. Socrata remains an exceptional
  // degradation path for an older id or an unavailable/partial mirror.
  try {
    const readModel = new URL(NOTICE_READ_MODEL);
    readModel.searchParams.set("id", id);
    const response = await fetch(readModel, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (response.ok) {
      const payload = await response.json();
      return payload?.row || null;
    }
    if (response.status === 404) return null;
  } catch (_error) {
    // Fall through to the public-source degradation path.
  }
  const url = new URL(CITY_RECORD_SODA);
  url.searchParams.set("$select", NOTICE_FIELDS);
  url.searchParams.set("$where", `request_id='${id}'`);
  url.searchParams.set("$limit", "1");
  const response = await fetch(url, { headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`City Record HTTP ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function handleNotice(request, env, id) {
  const [asset, meetingSnapshotResponse, mandateBacklinksResponse] = await Promise.all([
    staticAsset(env, request, "/"),
    staticAsset(env, request, "/data/meeting_outcomes_snapshot.json"),
    staticAsset(env, request, "/data/notice_mandate_backlinks_lookup.json"),
  ]);
  let meetingOutcome = null;
  try {
    const snapshot = meetingSnapshotResponse.ok ? await meetingSnapshotResponse.json() : null;
    meetingOutcome = snapshot?.by_notice?.[id] || null;
  } catch (_error) {
    meetingOutcome = null;
  }
  let mandateBacklinksLookup = null;
  try {
    mandateBacklinksLookup = mandateBacklinksResponse.ok
      ? await mandateBacklinksResponse.json()
      : null;
  } catch (_error) {
    mandateBacklinksLookup = null;
  }
  let row = null;
  let upstreamFailed = false;
  try {
    row = await noticeRow(id);
  } catch (_error) {
    upstreamFailed = true;
  }
  const status = upstreamFailed ? 503 : row ? 200 : 404;
  const kind = row?.type_of_notice_description || row?.section_name || "Public record";
  const title = row?.short_title || (row ? `${kind} ${id}` : `CityScroll public record ${id}`);
  const canonical = `https://cityscroll.org/notices/${encodeURIComponent(id)}`;
  const cacheControl = status === 200
    ? "public, max-age=60, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800"
    : "public, max-age=60, s-maxage=60, stale-while-revalidate=60, stale-if-error=60";
  const response = rewrittenResponse(asset, status, cacheControl);
  const transformed = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(`${title} · CityScroll`); } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:title"]', { element(element) { element.setAttribute("content", `${title} · CityScroll`); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .on(".tabbtn.active", { element(element) { element.setAttribute("class", "tabbtn"); } })
    .on("section.tabpane.active", { element(element) { element.setAttribute("class", "tabpane"); } })
    .on("#tab-notice", { element(element) { element.setAttribute("class", "tabpane active"); } })
    .on("#noticeview", { element(element) {
      element.setInnerContent(
        renderEdgeNotice(row, id, meetingOutcome, mandateBacklinksLookup),
        { html: true },
      );
    } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status, headers: transformed.headers });
  return transformed;
}

function browseAssetPath(facet, pathname) {
  const requested = String(pathname || "").replace(/\/+$/, "");
  if (facet === "contracts" && requested === "/browse/contracts") return "/browse/contracts/";
  return facet === "contracts" ? "/browse/" : `/browse/${facet}/`;
}

function hasBrowseFilters(url) {
  return [...url.searchParams].some(([key]) => key !== "lang");
}

async function handleBrowse(request, env, facet) {
  const url = new URL(request.url);
  const canonical = canonicalizeBrowseUrl(url.href);
  if (canonical !== `${url.pathname}${url.search}`) {
    return Response.redirect(new URL(canonical, url.origin), 302);
  }
  const asset = await staticAsset(env, request, browseAssetPath(facet, url.pathname));
  if (!hasBrowseFilters(url) || request.method === "HEAD") return asset;
  try {
    const config = BROWSE_FACETS[facet];
    const dataResponse = await staticAsset(env, request, config.dataPath);
    if (!dataResponse.ok) return asset;
    const payload = await dataResponse.json();
    const view = buildBrowseView(facet, payload, url.searchParams);
    const response = rewrittenResponse(asset, 200, "public, max-age=120, s-maxage=300, stale-while-revalidate=3600");
    return new HTMLRewriter()
      .on(`#${config.container}`, { element(element) {
        element.setAttribute("data-edge-filtered", "true");
        element.setInnerContent(renderBrowseView(view), { html: true });
      } })
      .transform(response);
  } catch (_error) {
    return asset;
  }
}

async function handleBrowseConcept(request, env, concept) {
  const asset = await staticAsset(env, request, `/browse/${concept}/`);
  return asset;
}

async function handleBrowseObject(request, env, object) {
  return staticAsset(env, request, BROWSE_OBJECTS[object].route);
}

function unavailableBrowseResponse(facet) {
  const canonical = facet === "land" ? "/browse/zoning/" : "/browse/";
  const label = facet === "land" ? "Land is now Browse → Zoning" : "That Browse section is unavailable";
  const linkLabel = canonical === "/browse/zoning/" ? "Open Zoning" : "Back to Browse";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${label} · CityScroll</title></head><body><main><h1>${label}</h1><p>Choose a current Browse section to continue.</p><p><a href="${canonical}">${linkLabel}</a></p></main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

async function handleEntity(request, env, entity) {
  let id = entity.id;
  try { id = decodeURIComponent(entity.id); } catch (_error) { return new Response("Invalid entity id", { status: 400 }); }
  const url = new URL(request.url);
  if (entity.family === "agencies") {
    const aliasTarget = agencyRouteAliasTarget(id);
    if (aliasTarget && aliasTarget !== id) {
      url.pathname = `/agencies/${encodeURIComponent(aliasTarget)}/`;
      return new Response(null, {
        status: 308,
        headers: {
          Location: url.toString(),
          "Cache-Control": "public, max-age=86400, s-maxage=31536000, immutable",
        },
      });
    }
  }
  const wantsInteractive = url.searchParams.has("tab");
  // Agency constellation documents are static-first (parcel-biography shape).
  // ?tab= keeps the interactive SPA profile for forecast/deep tabs. Only treat
  // a path hit as a constellation when the body is that document — ASSETS may
  // fall through to the SPA shell for unknown agency ids.
  if (entity.family === "agencies" && !wantsInteractive) {
    const documentPath = `/agencies/${encodeURIComponent(id)}/`;
    const document = await staticAsset(env, request, documentPath);
    if (document.ok) {
      const probe = await document.clone().text();
      if (probe.includes('data-civic-object-kind="agency-constellation"')) {
        // Preserve shareable as_of + claim query params on the composed document canonical.
        const params = new URLSearchParams();
        const asOf = String(url.searchParams.get("as_of") || "").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) params.set("as_of", asOf);
        const claim = String(url.searchParams.get("claim") || "").trim().slice(0, 200);
        if (claim) params.set("claim", claim);
        const query = params.toString();
        const canonicalPath = query ? `${documentPath}?${query}` : documentPath;
        return handleComposedObject(request, env, documentPath, canonicalPath);
      }
    }
  }
  const asset = await staticAsset(env, request, "/");
  if (!asset.ok) return asset;
  const canonical = `https://cityscroll.org/${entity.family}/${encodeURIComponent(id)}/`;
  const response = rewrittenResponse(asset, 200, "public, max-age=120, s-maxage=300, stale-while-revalidate=3600");
  // Node unit tests do not provide the Workers HTMLRewriter runtime. The route
  // contract is still testable there; production applies the metadata rewrite.
  if (typeof HTMLRewriter === "undefined") return request.method === "HEAD"
    ? new Response(null, { status: 200, headers: response.headers })
    : response;
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

export default {
  async fetch(request, env) {
    if (!env?.ASSETS) return new Response("Static asset binding unavailable", { status: 503 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    const id = safeId(url.pathname);
    if (id) return handleNotice(request, env, id);
    if (url.pathname === "/meeting.ics") return handleMeetingICS(request, env);
    const meetingId = safeMeeting(url.pathname);
    if (meetingId) return handleMeeting(request, env, meetingId);
    const examNumber = safeExamNumber(url.pathname);
    if (examNumber) return handleExam(request, env, examNumber);
    const pack = safeMonitorPack(url.pathname);
    if (pack) return handleComposedObject(request, env, `/following/packs/${pack}/`, `/following/packs/${pack}/`);
    const district = safeDistrictDigest(url.pathname);
    if (district) return handleComposedObject(request, env, `/districts/council/${district}/digest/`, `/districts/council/${district}/digest/`);
    const parcel = safeParcel(url.pathname);
    if (parcel) {
      const path = `/parcels/${parcel}/`;
      const asOf = String(url.searchParams.get("as_of") || "").trim();
      const canonical = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${path}?as_of=${asOf}` : path;
      return handleComposedObject(request, env, path, canonical);
    }
    const browse = browseRoute(url.pathname);
    if (browse.kind === "facet") return handleBrowse(request, env, browse.facet);
    if (browse.kind === "concept") return handleBrowseConcept(request, env, browse.concept);
    if (browse.kind === "object") return handleBrowseObject(request, env, browse.object);
    if (browse.kind === "unknown") {
      if (browse.facet === "land") return Response.redirect(new URL("/browse/zoning/", request.url), 302);
      return unavailableBrowseResponse(browse.facet);
    }
    const entity = entityDocument(url.pathname);
    if (entity) return handleEntity(request, env, entity);
    return env.ASSETS.fetch(request);
  },
};
