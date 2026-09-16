import { meetingCanonicalHref } from "./meeting_object_contract.mjs";
import { renderObserveCalendarSubscription } from "./government_observer_calendar_feed.mjs";

export const OBSERVE_SOURCE_SYSTEMS = Object.freeze([
  "pdc_calendar",
  "bsa_calendar",
  "oath_trial_calendar",
]);

export const OBSERVE_GUIDES = Object.freeze([
  { id: "ccrb", title: "CCRB public trials", href: "/guide/how-to/request-trial-observation/#ccrb", source: "https://www.nyc.gov/site/ccrb/complaints/complaint-process/apu-trials.page" },
  { id: "hart-island", title: "Hart Island public visits", href: "/guide/how-to/observe-city-government/#hart-island", source: "https://www.nyc.gov/site/hartisland/hart-island/visitation.page" },
  { id: "ddc", title: "DDC bid openings", href: "/guide/how-to/observe-city-government/#ddc", source: "https://www.nyc.gov/site/ddc/contracts/construction-contracts.page" },
]);

const BODY_LABELS = Object.freeze({
  pdc_calendar: "Public Design Commission",
  bsa_calendar: "Board of Standards and Appeals",
  oath_trial_calendar: "Office of Administrative Trials and Hearings",
});
const ACCESS_LABELS = Object.freeze({ remote: "Remote access", in_person: "In person", unknown: "Access not published" });

const text = (value, max = 500) => String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (value) => text(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function day(value) {
  const match = text(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function accessMethod(row) {
  if (row?.observer_access?.watch_url || row?.observer_access?.remote_join_url || row?.remote_join_url) return "remote";
  if (row?.venue?.name || row?.venue?.address) return "in_person";
  return "unknown";
}

export function normalizeObserveScope(input = {}) {
  const objectInput = input && typeof input === "object" && !(input instanceof URLSearchParams) && !input.search;
  const queryInput = input && typeof input === "object" && input.search ? input.search : input;
  const source = input instanceof URLSearchParams ? input : objectInput ? null : new URLSearchParams(String(queryInput || "").replace(/^\?/, ""));
  const body = objectInput ? input.body || input.agency || null : source.get("body") || source.get("agency") || null;
  const access = objectInput ? input.access || null : source.get("access") || null;
  const placeRole = objectInput ? input.placeRole || null : source.get("placeRole") || null;
  const supportedBodies = new Set(OBSERVE_SOURCE_SYSTEMS);
  const supportedAccess = new Set(["remote", "in_person", "unknown"]);
  const errors = objectInput && Array.isArray(input.errors) ? [...input.errors] : [];
  if (body && !supportedBodies.has(body)) errors.push("body");
  if (access && !supportedAccess.has(access)) errors.push("access");
  if (placeRole && !["venue", "matter", "affected_area"].includes(placeRole)) errors.push("placeRole");
  return Object.freeze({ activity: "observe", body: body && supportedBodies.has(body) ? body : null, access: access && supportedAccess.has(access) ? access : null, placeRole: placeRole || null, errors: Object.freeze(errors) });
}

export function observeScopeUrl(scope = {}, { base = "/observe/" } = {}) {
  const normalized = normalizeObserveScope(scope);
  if (normalized.errors.length) return null;
  const url = new URL(base, "https://cityscroll.invalid");
  url.searchParams.set("activity", "observe");
  if (normalized.body) url.searchParams.set("body", normalized.body);
  if (normalized.access) url.searchParams.set("access", normalized.access);
  if (normalized.placeRole) url.searchParams.set("placeRole", normalized.placeRole);
  return /^[a-z][a-z\d+.-]*:\/\//i.test(base) ? url.toString() : `${url.pathname}${url.search}`;
}

export function buildObserveSurface(readModel = {}, scopeInput = {}) {
  const scope = normalizeObserveScope(scopeInput);
  const rows = Array.isArray(readModel?.rows) ? readModel.rows : [];
  const observations = rows
    .filter((row) => OBSERVE_SOURCE_SYSTEMS.includes(row?.source_system) && day(row?.event_date || row?.date))
    .map((row) => {
      const date = day(row.event_date || row.date);
      const access = accessMethod(row);
      const venue = text(row.venue?.name || row.venue?.address) || "Venue not published";
      return { id: row.meeting_id, title: text(row.title || BODY_LABELS[row.source_system]), body: BODY_LABELS[row.source_system], source_system: row.source_system, date, access, access_label: ACCESS_LABELS[access], venue, purpose: text(row.decides || row.description) || "Observe a scheduled public proceeding.", href: meetingCanonicalHref(row), source_url: text(row.source_url, 2_000) || null };
    })
    .filter((row) => (!scope.body || row.source_system === scope.body) && (!scope.access || row.access === scope.access))
    .sort((a, b) => `${a.date}|${a.title}`.localeCompare(`${b.date}|${b.title}`, "en"));
  return Object.freeze({
    schema: "cityscroll.government_observe.v1",
    scope,
    observations: Object.freeze(observations),
    guides: OBSERVE_GUIDES,
    rows: Object.freeze(rows.filter((row) => OBSERVE_SOURCE_SYSTEMS.includes(row?.source_system))),
  });
}

function renderObserveDocumentRaw(surface) {
  const scope = surface?.scope || normalizeObserveScope();
  const hiddenError = scope.errors.length ? `<p class="observe-error" role="alert">Unsupported observation filter: ${esc(scope.errors.join(", "))}. Choose one of the supported options.</p>` : "";
  const subscription = renderObserveCalendarSubscription(surface, { escape: esc });
  const rows = (surface?.observations || []).map((row) => `<article class="observe-card" data-source-system="${esc(row.source_system)}"><h3>${esc(row.title)}</h3><dl><div><dt>Purpose</dt><dd>${esc(row.purpose)}</dd></div><div><dt>Date</dt><dd><time datetime="${esc(row.date)}">${esc(row.date)}</time></dd></div><div><dt>Body</dt><dd>${esc(row.body)}</dd></div><div><dt>Access</dt><dd>${esc(row.access_label)}</dd></div><div><dt>Venue</dt><dd>${esc(row.venue)}</dd></div></dl><details><summary>Inspect observation</summary><p>${esc(row.purpose)} Source-backed venue: ${esc(row.venue)}.</p></details><p><a class="observe-detail" href="${esc(row.href)}">Open scheduled detail</a> · <a href="${esc(row.source_url || row.href)}">Official source</a></p></article>`).join("\n");
  const guides = (surface?.guides || OBSERVE_GUIDES).map((guide) => `<li><a href="${esc(guide.href)}">${esc(guide.title)}</a><span>Program guide; not an upcoming dated session.</span></li>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observe City Government · CityScroll</title><meta name="description" content="Compare scheduled government observations with separate program guides."><link rel="canonical" href="https://cityscroll.org/observe/"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css"><style>body{font:16px system-ui;max-width:72rem;margin:auto;padding:2rem;line-height:1.5}main{max-width:68rem}form{display:flex;gap:1rem;flex-wrap:wrap;padding:1rem;background:#f3f0e8}label{display:grid;gap:.25rem}.observe-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1rem}.observe-card{border:1px solid #bbb;padding:1rem}.observe-card dt{font-weight:700}.observe-card dl{display:grid;gap:.5rem}.observe-card dd{margin:0}.observe-guides li{margin:.75rem 0}.observe-guides span{display:block;color:#555}.observe-subscription{margin:1.5rem 0;padding:1rem;border:1px solid #bbb;background:#f8f6f0}</style></head><body><main id="main"><p><a href="/">CityScroll</a></p><header><p>Observe</p><h1>Observe City Government</h1><p>Compare scheduled public observations, then choose the preparation step that fits.</p></header>${hiddenError}<form method="get" action="/observe/"><label>Body<select name="body"><option value="">All observation bodies</option>${OBSERVE_SOURCE_SYSTEMS.map((body) => `<option value="${body}"${scope.body === body ? " selected" : ""}>${BODY_LABELS[body]}</option>`).join("")}</select></label><label>Access<select name="access"><option value="">All access methods</option>${Object.entries(ACCESS_LABELS).map(([key, label]) => `<option value="${key}"${scope.access === key ? " selected" : ""}>${label}</option>`).join("")}</select></label><button type="submit">Apply filters</button></form>${subscription}<section aria-labelledby="scheduled-heading"><h2 id="scheduled-heading">Scheduled observations</h2>${rows ? `<div class="observe-grid">${rows}</div>` : "<p>No scheduled observations match these supported filters.</p>"}</section><section aria-labelledby="guides-heading"><h2 id="guides-heading">Program guides</h2><p>These guides explain access to programs that are not represented as upcoming dated sessions.</p><ul class="observe-guides">${guides}</ul></section></main></body></html>`;
}

export function renderObserveDocument(surface) {
  return renderObserveDocumentRaw(surface)
    .replace("<head>", "<head><base href=\"/\">")
    .replace('<main id="main">', '<main id="main" data-document-rendered="true">');
}
