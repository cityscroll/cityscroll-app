/**
 * Bounded chronology for one publisher-identified budget request.
 *
 * This projection deliberately consumes the already-reviewed budget request
 * view. It does not match records by text, agency, place, or date, and it
 * never turns a response into a delivery claim.
 */

export const LOCAL_ISSUE_REQUEST_RESPONSE_TRAIL_SCHEMA = "cityscroll.local_issue_request_response_trail.v1";
export const REQUEST_RESPONSE_TRAIL_STATUSES = Object.freeze([
  "submitted", "acknowledged", "supported", "funded", "scheduled", "active", "completed",
]);

const clean = (value, max = 20000) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const day = (value) => { const v = clean(value, 20).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
const href = (value) => { const v = clean(value, 2000); return v.startsWith("/") && !v.startsWith("//") || /^https?:\/\/[^\s<>\"]+$/.test(v) ? v : null; };
const esc = (value) => clean(value, 20000).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

function status(value) {
  const candidate = clean(value, 40).toLowerCase();
  return REQUEST_RESPONSE_TRAIL_STATUSES.includes(candidate) ? candidate : null;
}

function sourceUrl(row, fallback) {
  return href(row?.source_url || row?.source?.url || fallback) || null;
}

function normalizeProject(project) {
  if (!project || typeof project !== "object") return null;
  const code = clean(project.project_code || project.project_id || project.code, 80).toUpperCase();
  if (!code) return null;
  return Object.freeze({
    project_code: code,
    project_name: clean(project.project_name || project.name, 400) || null,
    project_href: href(project.project_href || project.canonical_href || project.href) || null,
    owner: clean(project.owner || project.managing_agency || project.managing?.name, 200) || null,
    dates: Object.freeze({
      forecast_completion: day(project.project_forecast_completion || project.forecast_completion),
      financial_data: day(project.financial_data_date),
      agency_data: day(project.agency_data_date),
    }),
    scope: clean(project.project_scope || project.scope, 20000) || null,
    source_url: sourceUrl(project, null),
    relationship: "accepted explicit project reference; not evidence of fulfillment",
  });
}

/** Build the request, response versions, and reviewed projects as one view. */
export function buildLocalIssueRequestResponseTrail(request, options = {}) {
  if (!request || typeof request !== "object") return null;
  const versions = Array.isArray(request.answers) ? request.answers
    : Array.isArray(request.versions) ? request.versions.filter((version) => version?.servable !== false) : [];
  const boardId = clean(request.board_id || request.board?.id || options.board_id, 120) || null;
  const trackingCode = clean(request.tracking_code || request.request_id || request.code, 40).toUpperCase() || null;
  if (!boardId || !trackingCode) return null;
  const responseEvents = versions.map((version, index) => Object.freeze({
    kind: "response",
    sequence: index + 1,
    date: day(version.publication_date || version.response_date || version.date),
    publication: clean(version.publication || version.release, 80) || null,
    text: clean(version.response || version.response_text || version.answer, 20000) || null,
    changed: version.changed === true,
    wrapper_only: version.wrapper_only === true,
    status: status(version.status || version.stage),
    source_url: sourceUrl(version, request.source_url || request.source?.url),
  }));
  const projects = (Array.isArray(request.project_links) ? request.project_links
    : Array.isArray(options.project_links) ? options.project_links : []).map(normalizeProject).filter(Boolean);
  return Object.freeze({
    schema: LOCAL_ISSUE_REQUEST_RESPONSE_TRAIL_SCHEMA,
    request: Object.freeze({
      board_id: boardId,
      board_label: clean(request.board_label || request.board?.label || options.board_label, 200) || null,
      fiscal_year: Number.isInteger(request.fiscal_year) ? request.fiscal_year : null,
      tracking_code: trackingCode,
      wording: clean(request.title || request.request || request.request_text || request.wording, 20000) || null,
      request_class: clean(request.request_class, 80) || null,
      source_url: sourceUrl(request, null),
    }),
    events: Object.freeze([
      Object.freeze({
        kind: "request", sequence: 0, date: day(request.request_date || request.submitted_date),
        text: clean(request.title || request.request || request.request_text || request.wording, 20000) || null,
        status: status(request.status || request.stage) || "submitted",
        source_url: sourceUrl(request, null),
      }),
      ...responseEvents,
    ]),
    projects: Object.freeze(projects),
    boundary: "A response records what the agency published. An accepted project reference identifies a separate record. Neither proves funding, delivery, or completion.",
  });
}

export function renderLocalIssueRequestResponseTrail(trail) {
  if (!trail || trail.schema !== LOCAL_ISSUE_REQUEST_RESPONSE_TRAIL_SCHEMA) return "";
  const request = trail.request;
  const eventText = (event) => event.kind === "request" ? "Board request" : "Agency response";
  const events = trail.events.map((event) => `<li class="local-issue-request-response-event" data-event-kind="${esc(event.kind)}"${event.status ? ` data-status="${esc(event.status)}"` : ""}>`
    + `<strong>${esc(eventText(event))}</strong>${event.date ? ` <time datetime="${esc(event.date)}">${esc(event.date)}</time>` : ""}`
    + (event.publication ? ` <span class="local-issue-request-response-publication">${esc(event.publication)}</span>` : "")
    + (event.changed ? " <span class=\"local-issue-request-response-changed\">Response changed</span>" : event.wrapper_only ? " <span class=\"local-issue-request-response-wrapper\">Publication wording changed</span>" : "")
    + (event.status ? ` <span class="local-issue-request-response-status">${esc(event.status)}</span>` : "")
    + (event.text ? `<p>${esc(event.text)}</p>` : "")
    + (event.source_url ? `<a href="${esc(event.source_url)}">Source</a>` : "") + `</li>`).join("");
  const projects = trail.projects.length ? `<div class="local-issue-request-response-projects"><h4>Accepted project reference</h4>${trail.projects.map((project) => `<article data-project-code="${esc(project.project_code)}"><h5>${project.project_href ? `<a href="${esc(project.project_href)}">${esc(project.project_name || project.project_code)}</a>` : esc(project.project_name || project.project_code)}</h5>${project.scope ? `<p>${esc(project.scope)}</p>` : ""}${project.source_url ? `<a href="${esc(project.source_url)}">Project source</a>` : ""}</article>`).join("")}</div>` : "";
  return `<section class="local-issue-request-response-trail" data-local-issue-request-response-trail="1" data-tracking-code="${esc(request.tracking_code)}"><h3>Request and agency response trail</h3><p><strong>${esc(request.board_label || request.board_id)}</strong> · FY${esc(request.fiscal_year ?? "unknown")} · <span lang="en" dir="ltr">${esc(request.tracking_code)}</span></p><p>${esc(request.wording || "Request wording unavailable")}</p><ol>${events}</ol>${projects}<p class="local-issue-request-response-boundary">${esc(trail.boundary)}</p></section>`;
}

export const buildRequestResponseTrail = buildLocalIssueRequestResponseTrail;
export const renderRequestResponseTrail = renderLocalIssueRequestResponseTrail;
