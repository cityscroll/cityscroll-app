/**
 * Resident-facing view of the materialized parcel history.
 *
 * A parcel is a shared place anchor. Membership here is navigation context,
 * not an assertion that records form one project, ownership chain, or cause.
 */

export const SITE_LIFECYCLE_CONTEXT_SCHEMA = "cityscroll.site_lifecycle_context.v1";
export const SITE_LIFECYCLE_LOAD_FAILED_SCHEMA = "cityscroll.detail_context_unavailable.v1";

const text = (value, max = 600) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (value) => text(value).replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));
const date = (value) => /^\d{4}-\d{2}-\d{2}/.test(text(value, 40)) ? text(value, 40).slice(0, 10) : null;
const dateLabel = (value) => {
  const d = date(value);
  if (!d) return null;
  const [year, month, day] = d.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
};

function canonicalHref(member) {
  const id = text(member?.subject_id, 320);
  if (id.startsWith("procurement:contract:")) return `/procurements/${encodeURIComponent(id)}`;
  return text(member?.subject_href, 1200) || null;
}

function sourceHref(member) {
  const path = text(member?.evidence_path, 1200);
  if (/^https?:\/\//i.test(path)) return path;
  const system = text(member?.source_system, 100);
  const id = text(member?.subject_id, 320);
  if (system === "zap-projects-open-data") return `https://data.cityofnewyork.us/resource/hgx4-8ukb.json?project_id=${encodeURIComponent(id.replace(["land", "project", ""].join(":"), ""))}`;
  if (system === "passport_public_contracts") return "https://www.pasport.org/public-search";
  if (system === "ocp_recent_contract_awards") return "https://data.cityofnewyork.us/d/qyyg-4tf5";
  if (system === "city_record_online") return "https://a856-cityrecord.nyc.gov/";
  return null;
}

/** Official source for the native subject when site-history loading fails. */
export function nativeSourceHrefForSubject(subjectId) {
  const id = text(subjectId, 320);
  if (id.startsWith("land:project:")) {
    const projectId = id.slice("land:project:".length);
    return projectId ? `https://zap.planning.nyc.gov/projects/${encodeURIComponent(projectId)}` : null;
  }
  if (id.startsWith("procurement:contract:")) {
    return `/procurements/${encodeURIComponent(id)}`;
  }
  return null;
}

/** Explicit failure marker: distinct from absent optional context (null). */
export function siteLifecycleLoadFailure({ subjectId = null, reason = "load_failed", sourceHref = null } = {}) {
  const subject = text(subjectId, 320) || null;
  return {
    schema: SITE_LIFECYCLE_LOAD_FAILED_SCHEMA,
    status: "unavailable",
    reason: text(reason, 120) || "load_failed",
    subject_id: subject,
    source_href: text(sourceHref, 1200) || nativeSourceHrefForSubject(subject),
  };
}

function isLoadFailure(value) {
  return value?.schema === SITE_LIFECYCLE_LOAD_FAILED_SCHEMA;
}

/** Return the stable members on the first exact parcel used by a subject. */
export function siteLifecycleMembersForSubject(lifecycle, subjectId) {
  const reverse = lifecycle?.reverse?.members || lifecycle?.members || {};
  const subject = text(subjectId, 320);
  const parcelIds = (reverse[subject]?.parcel_ids || []).filter((id) => /^\d{10}$/.test(String(id))).sort();
  if (!parcelIds.length) return { parcelId: null, parcelIds: [], members: [] };
  const parcel = lifecycle?.parcels?.[parcelIds[0]];
  return { parcelId: parcelIds[0], parcelIds, members: Array.isArray(parcel?.members) ? parcel.members : [] };
}

/** Build the reciprocal, kind-filtered view used by both native detail surfaces. */
export function buildSiteLifecycleContext(lifecycle, { subjectId, surface = "procurement" } = {}) {
  if (!lifecycle || lifecycle.schema !== "cityscroll.site_lifecycle.v1" || !text(subjectId)) return null;
  const located = siteLifecycleMembersForSubject(lifecycle, subjectId);
  if (!located.members.length) return null;
  const wanted = surface === "land" ? ["procurement"] : ["land_project", "land_application"];
  const members = located.members.filter((member) => {
    if (text(member.subject_id) === text(subjectId)) return false;
    return wanted.some((kind) => text(member.record_kind).startsWith(kind));
  });
  if (!members.length) return null;
  return {
    schema: SITE_LIFECYCLE_CONTEXT_SCHEMA,
    parcel_id: located.parcelId,
    parcel_ids: located.parcelIds,
    subject_id: text(subjectId, 320),
    surface,
    members,
    source: members.map(sourceHref).filter(Boolean),
  };
}

function readJsonResponse(response, label) {
  if (!response?.ok) {
    throw new Error(`${label}_http_${response?.status ?? "unavailable"}`);
  }
  return response.json().then((body) => {
    if (body == null) throw new Error(`${label}_empty`);
    return body;
  });
}

/**
 * Load the materialized site-history shards.
 * Resolves to the lifecycle document on success, or a load-failure marker.
 * Never collapses a failed fetch into an empty successful document.
 */
export function loadSiteLifecycleContext() {
  return Promise.all([
    fetch("data/site_lifecycle/0000.json", { cache: "force-cache", credentials: "omit" })
      .then((response) => readJsonResponse(response, "site_lifecycle_shard")),
    fetch("data/site_lifecycle/reverse.json", { cache: "force-cache", credentials: "omit" })
      .then((response) => readJsonResponse(response, "site_lifecycle_reverse")),
  ]).then(([shard, reverse]) => ({
    schema: "cityscroll.site_lifecycle.v1",
    parcels: Object.fromEntries((shard?.rows || []).map((row) => [row.parcel_id, row])),
    members: reverse?.members || {},
  })).catch((error) => siteLifecycleLoadFailure({
    reason: text(error?.message, 120) || "load_failed",
  }));
}

export function mountSiteLifecycleContext(host, data, subjectId) {
  if (!host) return;
  if (isLoadFailure(data)) {
    host.innerHTML = renderSiteLifecycleContext(siteLifecycleLoadFailure({
      subjectId: data.subject_id || subjectId,
      reason: data.reason,
      sourceHref: data.source_href,
    }));
    return;
  }
  host.innerHTML = renderSiteLifecycleContext(buildSiteLifecycleContext(data, { subjectId, surface: "land" }));
}

function memberDate(member) {
  return dateLabel(member?.source_event_date) || dateLabel(member?.source_events?.[0]?.date);
}

function memberTitle(member) {
  return text(member?.source_title) || text(member?.subject_id);
}

function memberLink(member) {
  const href = canonicalHref(member);
  return href ? `<a href="${esc(href)}">${esc(memberTitle(member))}</a>` : esc(memberTitle(member));
}

/** Recovery UI for a failed site-history load — never claims the place has no records. */
export function renderSiteLifecycleLoadFailure(failure) {
  if (!isLoadFailure(failure)) return "";
  const sourceHref = text(failure.source_href, 1200) || nativeSourceHrefForSubject(failure.subject_id);
  const source = sourceHref
    ? `<p><a href="${esc(sourceHref)}">Open the official source</a></p>`
    : "";
  return `<section class="node-section node-card site-lifecycle-context site-lifecycle-context-unavailable" data-site-lifecycle-context="1" data-site-lifecycle-state="unavailable" aria-labelledby="site-lifecycle-heading"><h2 id="site-lifecycle-heading">Other government activity at this site</h2><p>Related records for this place could not be loaded just now. That is a failure to read them, not a finding that none exist.</p><p><a href="">Reload this page to retry</a></p>${source}</section>`;
}

/** Render nothing for absent optional context; render recovery for a failed load. */
export function renderSiteLifecycleContext(context) {
  if (isLoadFailure(context)) return renderSiteLifecycleLoadFailure(context);
  if (!context?.members?.length || !context.parcel_id) return "";
  const land = context.surface === "land";
  const heading = land ? "Other government activity at this site" : "Land-use history at this site";
  const rows = context.members.map((member) => {
    const dateText = memberDate(member);
    const detail = [dateText, text(member.agency), text(member.stage), text(member.vendor)].filter(Boolean).join(" · ");
    return `<li class="site-lifecycle-record" data-site-lifecycle-subject="${esc(member.subject_id)}"><span>${memberLink(member)}</span>${detail ? ` <span class="site-lifecycle-meta">${esc(detail)}</span>` : ""}</li>`;
  }).join("");
  const scope = context.parcel_ids.length > 1
    ? ` This record covers ${context.parcel_ids.length} tax parcels, including ${context.parcel_ids.join(" and ")}.`
    : "";
  const source = context.source[0]
    ? `<details><summary>Source evidence</summary><p>Connected through the same tax parcel (BBL ${esc(context.parcel_id)}).${esc(scope)} <a href="${esc(context.source[0])}">Open the official source</a></p></details>`
    : `<details><summary>Source evidence</summary><p>Connected through the same tax parcel (BBL ${esc(context.parcel_id)}).${esc(scope)}</p></details>`;
  return `<section class="node-section node-card site-lifecycle-context" data-site-lifecycle-context="1" data-site-lifecycle-parcel="${esc(context.parcel_id)}" aria-labelledby="site-lifecycle-heading"><h2 id="site-lifecycle-heading">${heading}</h2><p>These are distinct public records connected by a shared place, not one continuous project.${scope}</p><ul>${rows}</ul>${source}<p><a href="${esc(`/parcels/${context.parcel_id}/`)}">Open parcel history</a></p></section>`;
}
