import { BROWSE_FACETS, BROWSE_OBJECTS, buildBrowseView, renderBrowseView } from "./browse_view.mjs";
import { BROWSE_CONCEPTS } from "./browse_concept_view.mjs";
import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import { agencyRouteAliasTarget, resolveAgencyIdentity } from "./agency_identity.mjs";
import { renderAgencyIdentityCoverageSection } from "./civic_institution_identity_coverage.mjs";
import {
  agencyRouteUncertaintyKind,
  defaultRouteIdentityReport,
  projectInstitutionProfileNavigation,
  renderInstitutionUncertaintyDocument,
} from "./civic_institution_profile_navigation.mjs";
import { renderMeetingOutcomesFirstPaint } from "./meeting_outcomes_static.mjs";
import { renderMeetingDocument } from "./meeting_document.mjs";
import { renderProcurementDocument } from "./procurement_document.mjs";
import { procurementShardPathForId } from "./procurement_read_model_shards.mjs";
import { meetingCalendarICS } from "./hearing_attend_pack.mjs";
import sharedMeetingSnapshot from "./data/shared_meeting_read_model.json" with { type: "json" };
import rulesSemanticLaneArtifact from "./data/rules_semantic_lane.json" with { type: "json" };
import { renderNoticeMandateBacklinksForId } from "./notice_mandate_backlinks.mjs";
import { projectNoticeObjectTarget } from "./notice_object_links.mjs";
import {
  findMandateById,
  noticeEvidenceForMandate,
  relatedCivicEdgesForMandate,
  renderMandateDocument,
} from "./mandate_document.mjs";
import {
  joinMandateToProvisions,
  joinsForProvision,
  mandateRowsFromLookup,
} from "./statutory_mandate_provision_join.mjs";
import { canonicalizeBrowseUrl, legacyBrowseRecordSearchTarget } from "./route_migration.mjs";
import { entityHref, entityRouteRef } from "./entity_pivot.mjs";
import { renderEntityPivotLink } from "./edge_summary.mjs";
import { buildLocalConstellation, renderLocalConstellationHTML } from "./local_constellation.mjs";
import {
  communityBoardMeetingEdgeAccepted,
  communityBoardMeetingEdgeFromRow,
} from "./community_board_institution_edges.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import { renderNodeBack } from "./civic_document_chrome.mjs";
import {
  buildCanonicalDocumentReportTarget,
  buildCanonicalDocumentRelationshipReportTarget,
  renderReportIssueAffordance,
} from "./report_issue.mjs";
import { renderRulemakingDocument } from "./rulemaking_document.mjs";
import { renderRegulatoryAgendaDocument } from "./regulatory_agenda_document.mjs";
import regulatoryAgenda from "./data/regulatory_agenda.json" with { type: "json" };
import { buildRulemakingObjects, rulemakingObjectForId } from "../worker/src/lib/rulemaking.mjs";
import { buildCommitteeDocumentView, renderCommitteeDocument } from "./committee_document.mjs";
import { buildLegislativeMatterDocument, renderLegislativeMatterDocument } from "./legislative_matter_document.mjs";
import { renderNoticeBitemporalHistory } from "./civic_time_ledger.mjs";
import {
  buildPublicAssertionGraph,
  hydratePublicAssertionInspector,
  renderAssertionInspectorDocument,
} from "./assertion_inspector.mjs";
import {
  DATA_HEALTH_PUBLIC,
  isDataHealthPath,
  renderDataHealthUnavailableDocument,
} from "./data_health_navigation.mjs";
import {
  ADMIN_CODE_MANIFEST,
  lookupAdminCodeCitation,
  renderAdminCodeProvisionDocument,
} from "./admin_code.mjs";
import { provisionBackfill, provisionHistoricalChanges } from "./code_history_backfill.mjs";

const CITY_RECORD_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const NOTICE_READ_MODEL = "https://api.cityscroll.org/notice";
const RULES_READ_MODEL = "https://api.cityscroll.org/rules";
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

function safeRulemaking(pathname) {
  const match = pathname.match(/^\/rules\/([^/?#]{1,700})\/?$/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id.startsWith("rulemaking:") && id.length <= 700 ? id : null;
  } catch {
    return null;
  }
}

function safeRegulatoryAgendaItem(pathname) {
  const match = pathname.match(/^\/rules\/agenda\/([^/?#]{1,700})\/?$/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id.startsWith("regulatory-agenda-item:") && id.length <= 700 ? match[1] : null;
  } catch {
    return null;
  }
}

function safeMeeting(pathname) {
  const match = pathname.match(/^\/meetings\/([^/?#]{1,320})\/?$/);
  return match ? match[1] : null;
}

function safeMatter(pathname) {
  const match = pathname.match(/^\/matters\/(\d+)\/?$/);
  return match ? match[1] : null;
}

function safeProcurement(pathname) {
  const match = pathname.match(/^\/procurements\/([^/?#]{1,500})\/?$/);
  return match ? match[1] : null;
}

function safeMandate(pathname) {
  const match = pathname.match(/^\/mandates\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/?$/);
  return match ? match[1] : null;
}

function assertionTarget(url) {
  const match = url.pathname.match(/^\/assertions\/([^/?#]{1,700})\/?$/);
  if (match) {
    try {
      const assertionId = decodeURIComponent(match[1]);
      return assertionId.length <= 512 ? { assertion_id: assertionId } : null;
    } catch {
      return null;
    }
  }
  if (!/^\/assertions\/?$/.test(url.pathname)) return null;
  const subjectRef = String(url.searchParams.get("subject") || "").trim();
  return subjectRef && subjectRef.length <= 320 ? { subject_ref: subjectRef } : null;
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

function safeCommittee(pathname) {
  const match = pathname.match(/^\/committees\/(\d+)\/?$/);
  return match ? match[1] : null;
}

function safeAdminCode(pathname) {
  const match = pathname.match(/^\/administrative-code\/([^/?#]{1,80})\/?$/);
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
  if (assertionTarget(url)) return "assertion";
  if (safeRegulatoryAgendaItem(url.pathname)) return "regulatory-agenda-item";
  if (safeRulemaking(url.pathname)) return "rulemaking";
  if (safeId(url.pathname)) return "notice";
  if (safeMandate(url.pathname)) return "mandate";
  if (safeMatter(url.pathname)) return "matter";
  if (safeMeeting(url.pathname)) return "meeting";
  if (safeProcurement(url.pathname)) return "procurement";
  if (safeExamNumber(url.pathname)) return "exam";
  if (safeMonitorPack(url.pathname)) return "monitor-pack";
  if (safeDistrictDigest(url.pathname)) return "district-digest";
  if (safeParcel(url.pathname)) return "parcel";
  if (safeCommittee(url.pathname)) return "committee";
  if (safeAdminCode(url.pathname)) return "legal-code";
  if (browseFacet(url.pathname) || browseConcept(url.pathname) || browseObject(url.pathname)) return "browse";
  if (entityDocument(url.pathname)) return "entity";
  if (isDataHealthPath(url.pathname)) return "data-health";
  return "asset";
}

function adminCodeUnavailableResponse(request, status = 404) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=60, s-maxage=60",
    "X-Content-Type-Options": "nosniff",
  };
  const body = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Administrative Code provision not found · CityScroll</title></head><body><main><h1>Administrative Code provision not found</h1><p><a href=\"/\">Back to CityScroll</a></p></main></body></html>";
  return request.method === "HEAD" ? new Response(null, { status, headers }) : new Response(body, { status, headers });
}

async function handleAdminCode(request, env, encodedCitation) {
  let citation;
  try { citation = decodeURIComponent(encodedCitation); } catch (_error) { return adminCodeUnavailableResponse(request, 400); }
  const entry = lookupAdminCodeCitation(citation, ADMIN_CODE_MANIFEST);
  if (!entry) return adminCodeUnavailableResponse(request);
  const snapshotRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
  const response = await staticAsset(env, snapshotRequest, `/data/legal_code/${entry.shard}`);
  if (!response.ok) return adminCodeUnavailableResponse(request, 503);
  let row = null;
  try {
    const payload = await response.json();
    row = Array.isArray(payload?.rows) ? payload.rows.find((candidate) => candidate.id === entry.id) : null;
  } catch (_error) {
    row = null;
  }
  if (!row) return adminCodeUnavailableResponse(request);
  let mandateJoins = [];
  try {
    const obligationsResponse = await staticAsset(env, snapshotRequest, "/data/agency_obligations_lookup.json");
    const lookup = obligationsResponse.ok ? await obligationsResponse.json() : null;
    mandateJoins = joinsForProvision(row.id, mandateRowsFromLookup(lookup), {
      lookupProvision: lookupAdminCodeCitation,
    });
  } catch (_error) {
    mandateJoins = [];
  }
  const html = renderAdminCodeProvisionDocument(row, {
    currentHref: request.url,
    mandateJoins,
    backfill: provisionBackfill(row.id),
    changes: provisionHistoricalChanges(row.id),
  });
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(html, { status: 200, headers });
}

async function handleAssertion(request, env, selector) {
  const snapshot = await staticAsset(env, request, "/data/entity_intelligence_lookup.json");
  let view = null;
  if (snapshot.ok) {
    try {
      const projection = buildPublicAssertionGraph(await snapshot.json());
      view = hydratePublicAssertionInspector(projection, selector);
    } catch (_error) {
      view = null;
    }
  }
  if (!view) {
    return new Response(
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Assertion not found · CityScroll</title></head><body><main><h1>Assertion not found</h1><p><a href=\"/browse/\">Browse civic records</a></p></main></body></html>",
      {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60, s-maxage=60",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  const html = renderAssertionInspectorDocument(view, { currentHref: request.url });
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(html, { status: 200, headers });
}

async function handleMeeting(request, env, meetingId) {
  let decoded;
  try { decoded = decodeURIComponent(meetingId); } catch (_error) {
    return new Response("Invalid meeting link", { status: 400 });
  }
  const snapshotRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
  const snapshot = await staticAsset(env, snapshotRequest, "/data/shared_meeting_read_model.json");
  let record = null;
  let payload = null;
  if (snapshot.ok) {
    try {
      payload = await snapshot.json();
      const rows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.hearings) ? payload.hearings : [];
      record = rows.find((row) => row?.meeting_id === decoded) || null;
    } catch (_error) {
      record = null;
    }
  }
  if (record) {
    const html = renderMeetingDocument(record, payload);
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

function matterUnavailableResponse(matterId) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matter record not found · CityScroll</title></head><body><main><h1>Matter record not found</h1><p>This legislative matter is not in the current CityScroll materialization.</p><p><a href="/browse/meetings/">Browse meetings</a></p></main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "X-Content-Type-Options": "nosniff",
      "X-Matter-Id": String(matterId || ""),
    },
  });
}

async function handleMatter(request, env, matterId) {
  const snapshotRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
  const snapshot = await staticAsset(env, snapshotRequest, "/data/legislative_matter_lookup.json");
  if (!snapshot.ok) return matterUnavailableResponse(matterId);
  let view = null;
  try {
    view = buildLegislativeMatterDocument(await snapshot.json(), matterId);
  } catch (_error) {
    view = null;
  }
  if (!view) return matterUnavailableResponse(matterId);
  const html = renderLegislativeMatterDocument(view, {
    currentHref: request.url,
    // determinism-lint: allow clock the edge worker is the boundary that reads the day and passes it in; renderLegislativeMatterDocument() itself stays a pure function of its arguments.
    today: new Date().toISOString().slice(0, 10),
  });
  if (!html) return matterUnavailableResponse(matterId);
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(html, { status: 200, headers });
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
  <p>This exam is not in the current exam guide on CityScroll.</p>
  <p><a href="/browse/exams/">Browse exams</a></p>
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

function noticeReportSource(id) {
  return {
    source_system: "city_record",
    source_record_id: id,
    source_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`,
  };
}

function noticeDocumentReportTarget(row, id, title) {
  if (!row || !id) return null;
  return buildCanonicalDocumentReportTarget({
    object_type: "notice",
    object_id: `notice:${id}`,
    canonical_url: `/notices/${encodeURIComponent(id)}`,
    object_label: title,
    source: noticeReportSource(id),
  });
}

function noticeRelationshipReportTarget(row, id, title, {
  semantic_key,
  relation_type,
  related_object_id,
  related_object_label,
  edge = null,
} = {}) {
  if (!row || !id) return null;
  return buildCanonicalDocumentRelationshipReportTarget({
    object_type: "notice",
    object_id: `notice:${id}`,
    canonical_url: `/notices/${encodeURIComponent(id)}`,
    object_label: title,
    semantic_key,
    relation_type,
    related_object_id,
    related_object_label,
    source: noticeReportSource(id),
    edge,
  });
}

export function renderEdgeNotice(row, id, meetingOutcome = null, mandateBacklinksLookup = null, options = {}) {
  const kind = row?.type_of_notice_description || row?.section_name || "Public record";
  const title = row?.short_title || (row ? `${kind} ${id}` : `CityScroll public record ${id}`);
  const agency = row?.agency_name || "Agency not listed";
  const source = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  const browseLink = constellationLink({ href: "/browse/", label: "Browse public records", className: "act primary", escape: esc });
  const followingLink = constellationLink({ href: "/following/", label: "Follow public records", className: "act", escape: esc });
  const sourceLink = officialSourceLink({ href: source, label: "Official record", escape: esc });
  const identity = resolveAgencyIdentity(agency);
  const vendor = String(row?.vendor_name || "").trim();
  const objectProjection = projectNoticeObjectTarget({ ...row, request_id: id });
  const projectedTarget = objectProjection.state === "matched"
    && objectProjection.target?.kind !== "notice"
    ? objectProjection.target
    : null;
  const noticeLocalConstellation = buildLocalConstellation({
    kind: "record",
    subject_ref: `notice:${id}`,
    subject_id: id,
    subject_name: title,
    source: null,
    provenance: null,
    neighbors: row ? [
      projectedTarget ? {
        edge_type: "related_record",
        relation_label: `identified ${projectedTarget.kind} object`,
        target_kind: projectedTarget.kind,
        target_id: projectedTarget.id,
        target_name: projectedTarget.label,
        href: projectedTarget.href,
        state: "matched",
        provenance: null,
      } : null,
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
  const documentReport = renderReportIssueAffordance(noticeDocumentReportTarget(row, id, title));
  const agencyReport = identity.matched
    ? renderReportIssueAffordance(noticeRelationshipReportTarget(row, id, title, {
      semantic_key: "agency",
      relation_type: "published_by_agency",
      related_object_id: `agency:id:${identity.canonical_id}`,
      related_object_label: agency,
    }))
    : "";
  const vendorReport = vendor
    ? renderReportIssueAffordance(noticeRelationshipReportTarget(row, id, title, {
      semantic_key: "vendor",
      relation_type: "named_vendor",
      related_object_id: entityRouteRef("vendor", vendor),
      related_object_label: vendor,
    }))
    : "";
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
  const civicTimeHistoryHTML = renderNoticeBitemporalHistory({
    notice: row,
    events: options.civicTime?.events || [],
    state: options.civicTime?.state || "ok",
  });
  // Public mandate backlinks only — empty lookup / unmatched notice → no section.
  const mandateBacklinksHTML = renderNoticeMandateBacklinksForId(mandateBacklinksLookup, id, { esc });
  const projectId = String(row.project_id || row.project || row.ulurp_number || "").trim();
  const projectReport = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(projectId)
    ? renderReportIssueAffordance(noticeRelationshipReportTarget(row, id, title, {
      semantic_key: "project",
      relation_type: "related_land_use_project",
      related_object_id: `project:${projectId}`,
      related_object_label: row.project_name || projectId,
    }))
    : "";
  const projectPivot = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(projectId)
    ? `<p class="notice-entity-pivot">${renderEntityPivotLink({
      relation_label: "related land-use project",
      target_kind: "project",
      target_id: projectId,
      target_name: row.project_name || projectId,
      canonical_href: `#land/${encodeURIComponent(projectId)}`,
      source: noticeSource,
    }, { className: "notice-project-link", escape: esc })}${projectReport ? ` ${projectReport}` : ""}</p>`
    : "";
  const boardEdge = communityBoardMeetingEdgeFromRow(row);
  const boardId = boardEdge?.from?.replace(/^community-board:/, "")
    || row.institution_refs?.board_ref?.replace(/^community-board:/, "")
    || row.board_id;
  const boardHref = boardEdge?.board_href || communityBoardPageHref(boardId);
  const boardName = row.board_name || boardEdge?.board_name
    || (boardId ? `Community Board ${boardId.replace(/^[a-z-]+-cb-/, "")}` : null);
  const boardReport = boardEdge && communityBoardMeetingEdgeAccepted(boardEdge) && boardHref && boardId
    ? renderReportIssueAffordance(noticeRelationshipReportTarget(row, id, title, {
      semantic_key: "community-board",
      relation_type: "hosted_by_community_board",
      related_object_id: `community-board:${boardId}`,
      related_object_label: boardName,
      edge: boardEdge,
    }))
    : "";
  const boardPivot = boardEdge && communityBoardMeetingEdgeAccepted(boardEdge) && boardHref
    ? `<p class="notice-entity-pivot">${renderEntityPivotLink({
      relation_label: "hosted by community board",
      target_kind: "community-board",
      target_id: boardId,
      target_name: boardName,
      canonical_href: boardHref,
      source: { kind: "meeting", id: row.meeting_id || `meeting:city_record:${id}`, name: title, canonical_href: `/notices/${encodeURIComponent(id)}` },
    }, { className: "notice-community-board-link", escape: esc })}${boardReport ? ` ${boardReport}` : ""}</p>`
    : "";
  const relatedObjectReport = projectedTarget
    && projectedTarget.id
    && `project:${projectedTarget.id}` !== `project:${projectId}`
    ? renderReportIssueAffordance(noticeRelationshipReportTarget(row, id, title, {
      semantic_key: "related_object",
      relation_type: "identified_canonical_object",
      related_object_id: projectedTarget.id,
      related_object_label: projectedTarget.label,
    }))
    : "";
  return `<div style="max-width:880px;margin:0 auto" data-edge-rendered="notice" data-notice-id="${esc(id)}">
    ${renderNodeBack({ href: "/browse/", label: "Back to Browse", currentHref: options.currentHref, extraClass: "edge-notice-back" })}
    <article class="panel route-item" tabindex="-1">
      <p class="ftype">${esc(kind)}${row.section_name && row.section_name !== kind ? ` · ${esc(row.section_name)}` : ""} · ${agencyLink}</p>
      <h2 class="rolename" lang="en" dir="ltr">${esc(title)}</h2>
      ${projectPivot}
      ${boardPivot}
      <dl class="glance"><dt>Agency</dt><dd lang="en" dir="ltr">${agencyLink}${agencyReport ? ` ${agencyReport}` : ""}</dd>${vendorLink ? `<dt>Vendor</dt><dd lang="en" dir="ltr">${vendorLink}${vendorReport ? ` ${vendorReport}` : ""}</dd>` : ""}${facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd lang="en" dir="ltr">${esc(value)}</dd>`).join("")}</dl>
      ${civicTimeHistoryHTML}
      ${attachmentUrl ? `<p class="notice-attachment-fallback">The official notice content is in an attachment: <a href="${esc(attachmentUrl)}" target="_blank" rel="noopener noreferrer">Read the attachment</a>.</p>` : ""}
      ${row.additional_description_1 ? `<details class="scope"><summary>Notice text</summary><p lang="en" dir="ltr">${esc(row.additional_description_1)}</p></details>` : ""}
      ${mandateBacklinksHTML}
      ${noticeLocalConstellationHTML}
      ${renderMeetingOutcomesFirstPaint(meetingOutcome, id)}
      <div class="actions">${browseLink}${followingLink}${documentReport}${relatedObjectReport}</div>
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

async function procurementObjectFromAsset(env, request, id) {
  const manifestRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
  const manifestResponse = await staticAsset(env, manifestRequest, "/data/shared_procurement_read_model.json");
  if (!manifestResponse.ok) return null;
  try {
    const manifest = await manifestResponse.json();
    if (Array.isArray(manifest?.rows)) {
      const object = manifest.rows.find((row) => row?.procurement_id === id);
      return object ? {
        object,
        observations: manifest.observations,
        sources: manifest.sources,
        generated_at: manifest.generated_at,
      } : null;
    }
    const relativeShardPath = procurementShardPathForId(manifest, id);
    if (!relativeShardPath) return null;
    const shardResponse = await staticAsset(env, manifestRequest, `/data/${relativeShardPath}`);
    if (!shardResponse.ok) return null;
    const shard = await shardResponse.json();
    const object = Array.isArray(shard?.rows)
      ? shard.rows.find((row) => row?.procurement_id === id)
      : null;
    return object ? {
      object,
      observations: shard.observations,
      sources: manifest.sources,
      generated_at: manifest.generated_at,
    } : null;
  } catch {
    return null;
  }
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
      return { row: payload?.row || null, civic_time: payload?.civic_time || null };
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
  return Array.isArray(rows) ? { row: rows[0] || null, civic_time: null } : { row: null, civic_time: null };
}

function rulemakingUnavailableResponse() {
  return new Response("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Rulemaking not found · CityScroll</title></head><body><main><h1>Rulemaking not found</h1><p><a href=\"/browse/rules/\">Browse Rules</a></p></main></body></html>", {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

async function handleRulemaking(request, encodedId) {
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return rulemakingUnavailableResponse(); }
  let object = null;
  try {
    const response = await fetch(RULES_READ_MODEL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (response.ok) {
      const payload = await response.json();
      object = Array.isArray(payload?.rulemakings)
        ? payload.rulemakings.find((row) => row?.rulemaking_id === id) || null
        // determinism-lint: allow clock the edge worker is the boundary that reads the day and passes it in; rulemakingObjectForId() itself stays a pure function of its arguments.
        : rulemakingObjectForId(payload?.rules || [], id, { now: new Date().toISOString().slice(0, 10) });
      // A materialized object is authoritative; this fallback only supports a
      // young API snapshot while the v8 view rolls out.
      if (!object && Array.isArray(payload?.rules)) {
        // determinism-lint: allow clock the edge worker is the boundary that reads the day and passes it in; buildRulemakingObjects() itself stays a pure function of its arguments.
        object = buildRulemakingObjects(payload.rules, { now: new Date().toISOString().slice(0, 10) })
          .find((row) => row.rulemaking_id === id) || null;
      }
    }
  } catch (_error) {
    object = null;
  }
  if (!object) return rulemakingUnavailableResponse();
  const html = renderRulemakingDocument(object, { currentHref: request.url });
  if (!html) return rulemakingUnavailableResponse();
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(html, { status: 200, headers });
}

function agendaItemUnavailableResponse() {
  return new Response("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Agenda item not found · CityScroll</title></head><body><main><h1>Agenda item not found</h1><p><a href=\"/browse/rules/\">Browse Rules</a></p></main></body></html>", {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

async function handleRegulatoryAgendaItem(request, encodedId) {
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return agendaItemUnavailableResponse(); }
  const item = (regulatoryAgenda?.agenda_items || []).find((row) => row?.id === id) || null;
  const html = renderRegulatoryAgendaDocument(item, { currentHref: request.url });
  if (!html) return agendaItemUnavailableResponse();
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(html, { status: 200, headers });
}

async function handleProcurement(request, env, encodedId) {
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return new Response("Invalid procurement link", { status: 400 }); }
  let html = null;
  const result = await procurementObjectFromAsset(env, request, id);
  if (result) {
    html = renderProcurementDocument(result.object, result.observations, {
      currentHref: request.url,
      sourceStatus: result.sources,
    });
  }
  if (!html) {
    return new Response("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Procurement not found · CityScroll</title></head><body><main><h1>Procurement not found</h1><p><a href=\"/browse/contracts/\">Browse contracts</a></p></main></body></html>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
    });
  }
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(html, { status: 200, headers });
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
  let civicTime = null;
  let upstreamFailed = false;
  try {
    const result = await noticeRow(id);
    row = result?.row || null;
    civicTime = result?.civic_time || null;
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
        renderEdgeNotice(row, id, meetingOutcome, mandateBacklinksLookup, { currentHref: request.url, civicTime }),
        { html: true },
      );
    } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status, headers: transformed.headers });
  return transformed;
}

async function handleMandate(request, env, id) {
  const [lookupResponse, backlinksResponse, conformanceResponse] = await Promise.all([
    staticAsset(env, request, "/data/agency_obligations_lookup.json"),
    staticAsset(env, request, "/data/notice_mandate_backlinks_lookup.json"),
    staticAsset(env, request, "/data/process_conformance_lookup.json"),
  ]);
  let lookup = null;
  let backlinks = null;
  let conformance = null;
  try { lookup = lookupResponse.ok ? await lookupResponse.json() : null; } catch (_error) { lookup = null; }
  try { backlinks = backlinksResponse.ok ? await backlinksResponse.json() : null; } catch (_error) { backlinks = null; }
  try { conformance = conformanceResponse.ok ? await conformanceResponse.json() : null; } catch (_error) { conformance = null; }
  const row = findMandateById(lookup, id);
  const html = row ? renderMandateDocument(row, {
    noticeEvidence: noticeEvidenceForMandate(backlinks, id),
    relatedEdges: relatedCivicEdgesForMandate(conformance, id),
    provisionJoin: joinMandateToProvisions(row, { lookupProvision: lookupAdminCodeCitation }),
  }) : "";
  if (!html) {
    return new Response(
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Mandate not found · CityScroll</title></head><body><main><h1>Mandate not found</h1><p><a href=\"/browse/\">Browse civic records</a></p></main></body></html>",
      {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60, s-maxage=60",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(html, { status: 200, headers });
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
    if (facet === "zoning") {
      const hearingsResponse = await staticAsset(env, request, "/data/land_upcoming_hearings.json");
      if (hearingsResponse.ok) payload.hearings = (await hearingsResponse.json()).hearings || [];
    }
    const view = buildBrowseView(facet, payload, url.searchParams, {
      semanticArtifact: facet === "rules" ? rulesSemanticLaneArtifact : null,
    });
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
    let probe = "";
    if (document.ok) {
      probe = await document.clone().text();
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
    const uncertaintyKind = agencyRouteUncertaintyKind(id, defaultRouteIdentityReport);
    if (uncertaintyKind && !probe.includes('data-civic-object-kind="agency-constellation"')) {
      const projection = projectInstitutionProfileNavigation({
        identity: { canonical_id: id, canonical_name: id.replace(/-/g, " ") },
        publisherRow: null,
        hasRoute: uncertaintyKind === "unresolved",
        routeIdentityReport: defaultRouteIdentityReport,
      });
      const body = renderInstitutionUncertaintyDocument(projection, {
        title: uncertaintyKind === "collision" ? "Publisher identity collision" : "Unresolved agency route",
        renderNavigation: renderAgencyIdentityCoverageSection,
      });
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=3600",
        },
      });
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

function committeeUnavailableResponse() {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Committee record not found · CityScroll</title></head><body><main><h1>Committee record not found</h1><p><a href="/browse/people/">Browse people and organizations</a></p></main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleCommittee(request, env, id) {
  const snapshotRequest = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
  const [graphResponse, peopleResponse] = await Promise.all([
    staticAsset(env, snapshotRequest, "/data/committee_graph_lookup.json"),
    staticAsset(env, snapshotRequest, "/data/person_hub_lookup.json"),
  ]);
  if (!graphResponse.ok || !peopleResponse.ok) return committeeUnavailableResponse();
  let view = null;
  try {
    const [graph, people] = await Promise.all([graphResponse.json(), peopleResponse.json()]);
    view = buildCommitteeDocumentView(graph, people, id);
  } catch (_error) {
    view = null;
  }
  if (!view) return committeeUnavailableResponse();
  const html = renderCommitteeDocument(view, { currentHref: request.url });
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
  };
  return request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(html, { status: 200, headers });
}

function handleDataHealth(request, env) {
  if (!DATA_HEALTH_PUBLIC) {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "X-Content-Type-Options": "nosniff",
    };
    return request.method === "HEAD"
      ? new Response(null, { status: 404, headers })
      : new Response(renderDataHealthUnavailableDocument(), { status: 404, headers });
  }
  const url = new URL(request.url);
  if (url.pathname === "/data-health") {
    url.pathname = "/data-health/";
    return Response.redirect(url, 308);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    if (!env?.ASSETS) return new Response("Static asset binding unavailable", { status: 503 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    const assertion = assertionTarget(url);
    if (assertion) return handleAssertion(request, env, assertion);
    const agendaItem = safeRegulatoryAgendaItem(url.pathname);
    if (agendaItem) return handleRegulatoryAgendaItem(request, agendaItem);
    const rulemaking = safeRulemaking(url.pathname);
    if (rulemaking) return handleRulemaking(request, rulemaking);
    const id = safeId(url.pathname);
    if (id) return handleNotice(request, env, id);
    const mandateId = safeMandate(url.pathname);
    if (mandateId) return handleMandate(request, env, mandateId);
    const matterId = safeMatter(url.pathname);
    if (matterId) return handleMatter(request, env, matterId);
    if (url.pathname === "/meeting.ics") return handleMeetingICS(request, env);
    const meetingId = safeMeeting(url.pathname);
    if (meetingId) return handleMeeting(request, env, meetingId);
    const procurementId = safeProcurement(url.pathname);
    if (procurementId) return handleProcurement(request, env, procurementId);
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
    const committee = safeCommittee(url.pathname);
    if (committee) return handleCommittee(request, env, committee);
    const adminCode = safeAdminCode(url.pathname);
    if (adminCode) return handleAdminCode(request, env, adminCode);
    const browse = browseRoute(url.pathname);
    if (browse.kind === "landing") {
      // A record search that was posted back to Browse as traversal metadata is
      // canonically a Search request.
      const recordSearch = legacyBrowseRecordSearchTarget(url.href);
      if (recordSearch) return Response.redirect(new URL(recordSearch, url.origin), 302);
    }
    if (browse.kind === "facet") return handleBrowse(request, env, browse.facet);
    if (browse.kind === "concept") return handleBrowseConcept(request, env, browse.concept);
    if (browse.kind === "object") return handleBrowseObject(request, env, browse.object);
    if (browse.kind === "unknown") {
      if (browse.facet === "land") return Response.redirect(new URL("/browse/zoning/", request.url), 302);
      return unavailableBrowseResponse(browse.facet);
    }
    const entity = entityDocument(url.pathname);
    if (entity) return handleEntity(request, env, entity);
    if (isDataHealthPath(url.pathname)) return handleDataHealth(request, env);
    return env.ASSETS.fetch(request);
  },
};
