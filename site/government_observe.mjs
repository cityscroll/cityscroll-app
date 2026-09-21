import { meetingCanonicalHref } from "./meeting_object_contract.mjs";
import { observerCalendarOccurrencesForRows } from "./observer_calendar_occurrences.mjs";
import { buildCompactMonthView, renderCompactMonth } from "./compact_calendar.mjs";
import { renderCivicDocumentAssets } from "./civic_document_chrome.mjs";

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
const SPEAKING_RIGHTS = Object.freeze(["allowed", "not_allowed", "requires_registration", "unknown"]);
const OBSERVE_VIEWS = Object.freeze(["list", "calendar"]);

// The shared preview runtime is loaded once at the document boundary.
function renderCalendarEventPreviewScript() { return ""; }

/** Page-level boundary: an open/scheduled proceeding on this list is not a speak invitation. */
export const OBSERVE_SPEAK_BOUNDARY =
  "An open proceeding listed here is for observation. Listing it is not permission to speak.";

const text = (value, max = 500) => String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (value) => text(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function speakingRights(row) {
  const rights = text(row?.speaking_rights, 80).toLowerCase();
  return SPEAKING_RIGHTS.includes(rights) ? rights : "unknown";
}

function day(value) {
  const match = text(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function accessMethod(row) {
  if (row?.observer_access?.watch_url || row?.observer_access?.remote_join_url || row?.remote_join_url) return "remote";
  if (row?.venue?.name || row?.venue?.address) return "in_person";
  return "unknown";
}

function routeText(value, max = 200) {
  const result = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return result && result.length <= max ? result : null;
}

function normalizeObservePresentation(input = {}) {
  const month = routeText(input.month, 7);
  const selected = routeText(input.selected || input.selection, 240);
  const scroll = input.scroll == null || input.scroll === "" ? NaN : Number(input.scroll);
  return {
    view: OBSERVE_VIEWS.includes(input.view) ? input.view : "list",
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : null,
    selected,
    scroll: Number.isInteger(scroll) && scroll >= 0 && scroll <= 10_000_000 ? scroll : null,
    focus: input.focus === "selection" || input.focus === "heading" ? input.focus : null,
  };
}

export function normalizeObserveScope(input = {}) {
  const objectInput = input && typeof input === "object" && !(input instanceof URLSearchParams) && !input.search;
  const queryInput = input && typeof input === "object" && input.search ? input.search : input;
  const source = input instanceof URLSearchParams ? input : objectInput ? null : new URLSearchParams(String(queryInput || "").replace(/^\?/, ""));
  const body = objectInput ? input.body || input.agency || null : source.get("body") || source.get("agency") || null;
  const access = objectInput ? input.access || null : source.get("access") || null;
  const placeRole = objectInput ? input.placeRole || null : source.get("placeRole") || null;
  const presentation = normalizeObservePresentation(objectInput ? input : {
    view: source.get("view"), month: source.get("month"), selected: source.get("selection"),
    scroll: source.get("scroll"), focus: source.get("focus"),
  });
  const supportedBodies = new Set(OBSERVE_SOURCE_SYSTEMS);
  const supportedAccess = new Set(["remote", "in_person", "unknown"]);
  const errors = objectInput && Array.isArray(input.errors) ? [...input.errors] : [];
  if (body && !supportedBodies.has(body)) errors.push("body");
  if (access && !supportedAccess.has(access)) errors.push("access");
  if (placeRole && !["venue", "matter", "affected_area"].includes(placeRole)) errors.push("placeRole");
  return Object.freeze({ activity: "observe", body: body && supportedBodies.has(body) ? body : null, access: access && supportedAccess.has(access) ? access : null, placeRole: placeRole || null, ...presentation, errors: Object.freeze(errors) });
}

export function observeScopeUrl(scope = {}, { base = "/observe/" } = {}) {
  const normalized = normalizeObserveScope(scope);
  if (normalized.errors.length) return null;
  const url = new URL(base, "https://cityscroll.invalid");
  url.searchParams.set("activity", "observe");
  if (normalized.body) url.searchParams.set("body", normalized.body);
  if (normalized.access) url.searchParams.set("access", normalized.access);
  if (normalized.placeRole) url.searchParams.set("placeRole", normalized.placeRole);
  if (normalized.view && normalized.view !== "list") url.searchParams.set("view", normalized.view);
  if (normalized.month) url.searchParams.set("month", normalized.month);
  if (normalized.selected) url.searchParams.set("selection", normalized.selected);
  if (normalized.scroll != null) url.searchParams.set("scroll", String(normalized.scroll));
  if (normalized.focus) url.searchParams.set("focus", normalized.focus);
  return /^[a-z][a-z\d+.-]*:\/\//i.test(base) ? url.toString() : `${url.pathname}${url.search}`;
}

function rawDate(row) {
  return routeText(row?.event_date || row?.date, 80);
}

function purposeFor(row) {
  const purpose = text(row?.decides || row?.description);
  return { value: purpose || "Purpose not published", source_backed: Boolean(purpose) };
}

function venueFor(row) {
  const value = text(row?.venue?.name || row?.venue?.address);
  return { value: value || "Venue not published", source_backed: Boolean(value) };
}

function affectedPlaceFor(row) {
  const affected = row?.affected_area || {};
  const values = [
    ...(Array.isArray(affected.community_districts) ? affected.community_districts : []),
    ...(Array.isArray(affected.boroughs) ? affected.boroughs : []),
    ...(Array.isArray(affected.neighborhoods) ? affected.neighborhoods : []),
  ].map((value) => text(value, 120)).filter(Boolean);
  return values.length ? values.join(", ") : "Affected place not published";
}

function accessStepFor(row) {
  const step = Array.isArray(row?.access_steps) ? row.access_steps.find((item) => item?.destination || item?.source_url) : null;
  if (!step) return null;
  return {
    label: text(step.label || step.title || (step.kind === "observer_instructions" ? "Open observer instructions" : "Open access instructions")),
    href: text(step.destination || step.source_url, 2_000),
    source_url: text(step.source_url, 2_000) || null,
    required: step.required !== false,
  };
}

function matchesPlaceRole(row, role) {
  if (!role) return true;
  if (role === "venue") return venueFor(row).source_backed;
  if (role === "affected_area") return affectedPlaceFor(row) !== "Affected place not published";
  if (role === "matter") return Boolean(row?.agenda_items?.length || row?.description || row?.oath_index);
  return false;
}

function observeDetailHref(href, scope) {
  if (!href) return null;
  const returnTo = observeScopeUrl(scope);
  const url = new URL(href, "https://cityscroll.invalid");
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return /^[a-z][a-z\d+.-]*:\/\//i.test(href) ? url.toString() : `${url.pathname}${url.search}`;
}

function observeOccurrences(rows) {
  const byId = new Map(rows.map((row) => [row.meeting_id, row]));
  return observerCalendarOccurrencesForRows(rows).map((occurrence) => {
    const row = byId.get(occurrence.uid);
    return row ? {
      ...occurrence,
      title: row.title,
      canonical_url: row.href || occurrence.canonical_url,
      source: { ...occurrence.source, url: row.source_url },
    } : occurrence;
  });
}

export function buildObserveSurface(readModel = {}, scopeInput = {}, { today = null } = {}) {
  const scope = normalizeObserveScope(scopeInput);
  // Unsupported filters fail closed: never fall through to the unfiltered collection.
  if (scope.errors.length) {
    return Object.freeze({
      schema: "cityscroll.government_observe.v1",
      scope,
      observations: Object.freeze([]),
      guides: OBSERVE_GUIDES,
    });
  }
  const rows = Array.isArray(readModel?.rows) ? readModel.rows : [];
  const observations = rows
    .filter((row) => OBSERVE_SOURCE_SYSTEMS.includes(row?.source_system) && day(row?.event_date || row?.date))
    .map((row) => {
      const raw = rawDate(row);
      const date = day(raw);
      const access = accessMethod(row);
      const purpose = purposeFor(row);
      const venue = venueFor(row);
      const accessStep = accessStepFor(row);
      return {
        id: row.meeting_id,
        title: text(row.title || BODY_LABELS[row.source_system]),
        body: BODY_LABELS[row.source_system],
        source_system: row.source_system,
        date,
        date_value: raw,
        date_precision: raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? "date" : "local_start",
        starts_at: raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null,
        timezone: row.timezone || "America/New_York",
        access,
        access_label: ACCESS_LABELS[access],
        venue: venue.value,
        venue_source_backed: venue.source_backed,
        affected_place: affectedPlaceFor(row),
        purpose: purpose.value,
        purpose_source_backed: purpose.source_backed,
        access_step: accessStep,
        // Carry source speaking rights; never invent "allowed" from an open/public proceeding.
        speaking_rights: speakingRights(row),
        href: meetingCanonicalHref(row),
        source_url: text(row.source_url, 2_000) || null,
      };
    })
    .filter((row) => (!scope.body || row.source_system === scope.body) && (!scope.access || row.access === scope.access))
    .filter((row) => matchesPlaceRole(rows.find((candidate) => candidate.meeting_id === row.id), scope.placeRole))
    .sort((a, b) => `${a.date_value || a.date}|${a.title}|${a.id}`.localeCompare(`${b.date_value || b.date}|${b.title}|${b.id}`, "en"));
  const selectedRows = rows.filter((row) => observations.some((observation) => observation.id === row.meeting_id));
  const occurrenceRows = observeOccurrences(selectedRows);
  const effectiveToday = today || day(readModel?.generated_at) || observations[0]?.date || "1970-01-01";
  const calendar = buildCompactMonthView(occurrenceRows, { today: effectiveToday, month: scope.month || undefined });
  return Object.freeze({
    schema: "cityscroll.government_observe.v1",
    scope,
    observations: Object.freeze(observations),
    guides: OBSERVE_GUIDES,
    calendar,
    calendar_occurrences: Object.freeze(occurrenceRows),
    route: scope,
    rows: Object.freeze(rows.filter((row) => OBSERVE_SOURCE_SYSTEMS.includes(row?.source_system))),
  });
}

function renderObserveDocumentRaw(surface) {
  const scope = surface?.scope || normalizeObserveScope();
  let hiddenError = scope.errors.length ? `<p class="observe-error" role="alert">Unsupported observation filter: ${esc(scope.errors.join(", "))}. Choose one of the supported options.</p>` : "";
  // The discovery surface is intentionally a preview-free, provider-neutral
  // entry point. Subscription belongs to the dedicated calendar feed route;
  // it must not appear in the observation journey or its preview markup.
  const subscription = "";
  const rows = (surface?.observations || []).map((row) => `<article class="observe-card" data-source-system="${esc(row.source_system)}" data-observe-id="${esc(row.id)}"><h3>${esc(row.title)}</h3><dl><div><dt>Purpose</dt><dd>${esc(row.purpose)}</dd></div><div><dt>Date</dt><dd><time datetime="${esc(row.date_value || row.date)}">${esc(row.date_value || row.date)}</time></dd></div><div><dt>Body</dt><dd>${esc(row.body)}</dd></div><div><dt>Access</dt><dd>${esc(row.access_label)}</dd></div><div><dt>Next step</dt><dd>${row.access_step ? `<a href="${esc(row.access_step.href)}">${esc(row.access_step.label)}</a>` : "Access step not published"}</dd></div><div><dt>Venue</dt><dd>${esc(row.venue)}</dd></div><div><dt>Affected place</dt><dd>${esc(row.affected_place)}</dd></div></dl><details><summary>Inspect observation</summary><p>${esc(row.purpose)} Source-backed venue: ${esc(row.venue)}. Affected place: ${esc(row.affected_place)}.</p></details><p><a class="observe-detail" href="${esc(observeDetailHref(row.href, scope))}">Open scheduled detail</a> · <a href="${esc(row.source_url || row.href)}">Official source</a></p></article>`).join("\n");
  const guides = (surface?.guides || OBSERVE_GUIDES).map((guide) => `<li><a href="${esc(guide.href)}">${esc(guide.title)}</a><span>Program guide; not an upcoming dated session.</span></li>`).join("\n");
  const speakBoundary = `<p class="observe-speak-boundary" role="note">${esc(OBSERVE_SPEAK_BOUNDARY)}</p>`;
  const calendar = scope.view === "calendar" ? renderCompactMonth(surface?.calendar, { fullListHref: observeScopeUrl({ ...scope, view: "list" }), fullListLabel: "View the list" }) : "";
  const hiddenState = [
    ["view", scope.view], ["month", scope.month], ["selection", scope.selected], ["scroll", scope.scroll], ["focus", scope.focus],
  ].filter(([, value]) => value != null && value !== "").map(([key, value]) => `<input type="hidden" name="${key}" value="${esc(value)}">`).join("");
  const selectedPresent = (surface?.observations || []).some((row) => row.id === scope.selected);
 const returnFallback = scope.selected && !selectedPresent
   ? `<p class="observe-return-fallback" role="status">That observation is no longer in this materialized view. <a href="${esc(observeScopeUrl({ ...scope, selected: null, focus: null, scroll: null }))}">Continue with the current observations</a>.</p>`
   : "";
  hiddenError += returnFallback;
  const empty = !rows.length ? "<p>No scheduled observations match these supported filters.</p>" : `<div class="observe-grid">${rows}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Observe City Government · CityScroll</title><meta name="description" content="Compare scheduled government observations with separate program guides.">${renderCivicDocumentAssets("/")}<link rel="stylesheet" href="/compact_calendar.css"><style>body{font:16px system-ui;max-width:72rem;margin:auto;padding:2rem;line-height:1.5}main{max-width:68rem}form{display:flex;gap:1rem;flex-wrap:wrap;padding:1rem;background:#f3f0e8}label{display:grid;gap:.25rem}.observe-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1rem}.observe-card{border:1px solid #bbb;padding:1rem}.observe-card dt{font-weight:700}.observe-card dd{margin:0}.observe-speak-boundary{margin:1rem 0;padding:.75rem 1rem;border-left:4px solid #555;background:#f7f5f0}.observe-guides li{margin:.75rem 0}.observe-guides span{display:block;color:#555}.observe-subscription{margin:1.5rem 0;padding:1rem;background:#f8f6f0}.observe-return-fallback{padding:.75rem 1rem;background:#fff3cd}</style>${renderCalendarEventPreviewScript("/")}</head><body><main id="main" data-observe-root data-observe-view="${esc(scope.view)}" data-observe-selected="${esc(scope.selected || "")}" data-observe-scroll="${esc(scope.scroll || "")}"><p><a href="/">CityScroll</a></p><header><p>Observe</p><h1 data-observe-heading tabindex="-1">Observe City Government</h1><p>Compare scheduled public observations, then choose the preparation step that fits.</p></header>${speakBoundary}${hiddenError}<form method="get" action="/observe/">${hiddenState}<label>Body<select name="body"><option value="">All observation bodies</option>${OBSERVE_SOURCE_SYSTEMS.map((body) => `<option value="${body}"${scope.body === body ? " selected" : ""}>${BODY_LABELS[body]}</option>`).join("")}</select></label><label>Access<select name="access"><option value="">All access methods</option>${Object.entries(ACCESS_LABELS).map(([key, label]) => `<option value="${key}"${scope.access === key ? " selected" : ""}>${label}</option>`).join("")}</label><label>Place relationship<select name="placeRole"><option value="">Any place relationship</option><option value="venue"${scope.placeRole === "venue" ? " selected" : ""}>Venue</option><option value="matter"${scope.placeRole === "matter" ? " selected" : ""}>Matter</option><option value="affected_area"${scope.placeRole === "affected_area" ? " selected" : ""}>Affected place</option></select></label><button type="submit">Apply filters</button></form>${subscription}${calendar}<section aria-labelledby="scheduled-heading"><h2 id="scheduled-heading">Scheduled observations</h2>${empty}</section><section aria-labelledby="guides-heading"><h2 id="guides-heading">Program guides</h2><p>These guides explain access to programs that are not represented as upcoming dated sessions.</p><ul class="observe-guides">${guides}</ul></section></main></body><script type="module" src="/government_observe_runtime.mjs"></script></html>`;
}

export function renderObserveDocument(surface) {
  return renderObserveDocumentRaw(surface)
    .replace("<head>", "<head><base href=\"/\">")
    .replace('<main id="main" data-observe-root', '<main id="main" data-document-rendered="true" data-observe-root');
}
