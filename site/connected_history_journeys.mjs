/**
 * Resident projection for the fixed connected-history dossier.
 *
 * This module does not acquire publisher data or mint new graph edges. It
 * projects the committed relation, temporal, and participant materializations
 * into the existing Search document. Query aliases are deliberately closed:
 * missing evidence is reported and no replacement example is sought.
 */

export const CONNECTED_HISTORY_JOURNEY_SCHEMA = "cityscroll.connected_history_journey.v1";
export const CONNECTED_HISTORY_RELATIONS_SCHEMA = "cityscroll.connected_history_relations.v1";
export const CONNECTED_HISTORY_TIME_SCHEMA = "cityscroll.connected_history_time_artifact.v1";
export const CONNECTED_HISTORY_ROLES_SCHEMA = "cityscroll.connected_history_roles.v1";

const DATA_URLS = Object.freeze({
  relations: new URL("./data/connected_history_relations.json", import.meta.url),
  time: new URL("./data/connected_history_time.json", import.meta.url),
  roles: new URL("./data/connected_history_roles.json", import.meta.url),
});

const CASES = [
  {
    family_id: "coyle",
    title: "Coyle Street BSA cases",
    scope: "Brooklyn Community Board 15 · 2114 and 2140 Coyle Street",
    queries: ["2025-54-A", "2026-09-A"],
    continue_href: "/browse/zoning/?status=active&borough=Brooklyn#land/2020K0270",
    continue_label: "Continue to the related land record",
    sources: [
      ["City Record BSA notice", "https://a856-cityrecord.nyc.gov/RequestDetail/20260723030"],
      ["January 27, 2026 CB15 agenda", "https://www.nyc.gov/assets/brooklyncb15/downloads/pdf/agendas/2026/Agenda-1-27-26-Revised.pdf"],
      ["February 24, 2026 CB15 minutes", "https://www.nyc.gov/assets/brooklyncb15/downloads/pdf/minutes/2026/Board-Meeting-Minutes-February-24-2026.pdf"],
    ],
    relation_dates: {
      "coyle-bsa-2025-54-a-cb15-agenda": ["2026-01-27", "day"],
      "coyle-bsa-2026-09-a-cb15-minutes": ["2026-02-24", "day"],
    },
  },
  {
    family_id: "franklin-avenue",
    title: "Franklin Avenue application history",
    scope: "Brooklyn Community Board 9 · 960 and 962–972 Franklin Avenue",
    queries: ["960 Franklin Avenue", "962-972 Franklin Avenue"],
    continue_href: "https://legistar.council.nyc.gov/LegislationDetail.aspx?GUID=AA282E61-19E6-44F0-A861-F7304A3E2740&ID=6874689&Options=&Search=",
    continue_label: "Continue to the Council record",
    sources: [
      ["2024 official land-use report", "https://zap-api-production.herokuapp.com/document/projectaction/sites/nycdcppfs/dcp_projectaction/ZM%20-%20Zoning%20Map%20Amendment%20_90047288D727ED11B83C001DD80696EC/230356.pdf"],
      ["Council matter", "https://legistar.council.nyc.gov/LegislationDetail.aspx?GUID=AA282E61-19E6-44F0-A861-F7304A3E2740&ID=6874689&Options=&Search="],
    ],
    relation_dates: {
      "franklin-c230356zmk-references-c200184zmk": ["2024", "year"],
      "franklin-c230356zmk-references-c200186zsk": ["2024", "year"],
      "franklin-c230356zmk-references-c200187zsk": ["2024", "year"],
      "franklin-c230356zmk-references-n200185zrk": ["2024", "year"],
    },
  },
  {
    family_id: "kingsbridge-armory",
    title: "Kingsbridge Armory proposal history",
    scope: "Bronx Community Board 7 · blocks 3247, lots 10 and 2",
    queries: ["Kingsbridge Armory"],
    continue_href: "https://zap.planning.nyc.gov/projects/2025X0262",
    continue_label: "Continue to the current planning record",
    sources: [
      ["2013 environmental review", "https://www.nyc.gov/site/oec/environmental-quality-review/13DME013X.page"],
      ["2025 planning project", "https://zap.planning.nyc.gov/projects/2025X0262"],
      ["2025 environmental review", "https://a002-ceqraccess.nyc.gov/ceqr/Details?data=MjVETUUwMDZY0&signature=7baabc56de3147946d9415dc8b59f436a8e7c9ca"],
    ],
    relation_dates: {
      "kingsbridge-13dme013x-successive-of-08dme004x": ["2013", "year"],
      "kingsbridge-2025x0262-footprint-3247-10": ["2025", "year"],
      "kingsbridge-2025x0262-footprint-3247-2": ["2025", "year"],
      "kingsbridge-25dme006x-successive-of-13dme013x": ["2025", "year"],
    },
  },
  {
    family_id: "sixth-avenue",
    title: "Sixth Avenue corridor history",
    scope: "Manhattan Community Boards 2, 4 and 5 · three documented segments",
    queries: ["Sixth Avenue"],
    continue_href: "https://www.nyc.gov/html/dot/html/about/current-projects.shtml",
    continue_label: "Continue to NYC DOT projects",
    sources: [
      ["NYC DOT current projects", "https://www.nyc.gov/html/dot/html/about/current-projects.shtml"],
    ],
    relation_dates: {
      "sixth-ave-lispenard-w14-segment": ["2024-06", "month"],
      "sixth-ave-w14-w35-segment": ["2025-02", "month"],
      "sixth-ave-watts-w59-segment": ["2026-06", "month"],
    },
  },
  {
    family_id: "thirty-first-avenue",
    title: "31st Avenue corridor history",
    scope: "Queens Community Board 1 · Vernon Boulevard to 51st Street",
    queries: ["31st Avenue"],
    continue_href: "https://www.nyc.gov/html/dot/downloads/pdf/31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf",
    continue_label: "Continue to the Phase II materials",
    sources: [
      ["May 2026 Phase II materials", "https://www.nyc.gov/html/dot/downloads/pdf/31-ave-phase-ii-steinway-st-51-st-may2026-2.pdf"],
    ],
    relation_dates: {
      "thirty-first-ave-phase-i-of-corridor": ["2024", "year"],
      "thirty-first-ave-phase-ii-of-corridor": ["2026-05", "month"],
    },
  },
  {
    family_id: "lighthouse-point",
    title: "Lighthouse Point component history",
    scope: "Staten Island Community Board 1 · phase-scoped project record",
    queries: ["Lighthouse Point"],
    continue_href: "https://edc.nyc/project/lighthouse-point",
    continue_label: "Continue to the project record",
    sources: [
      ["NYCEDC project page", "https://edc.nyc/project/lighthouse-point"],
      ["June 5, 2025 opening announcement", "https://edc.nyc/press-release/mixed-use-housing-complex-opens-lighthouse-point"],
    ],
    relation_dates: {
      "lighthouse-phase1-opening-component": ["2025-06-05", "day"],
      "lighthouse-phase2-future-component": ["2025-06-05", "day"],
    },
  },
];

export const CONNECTED_HISTORY_CASES = deepFreeze(CASES);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function clean(value, max = 600) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeConnectedHistoryQuery(value) {
  return clean(value, 240)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
}

const QUERY_CASES = new Map(
  CONNECTED_HISTORY_CASES.flatMap((entry) => entry.queries.map((query) => [normalizeConnectedHistoryQuery(query), entry])),
);

export function connectedHistoryCaseForQuery(query) {
  return QUERY_CASES.get(normalizeConnectedHistoryQuery(query)) || null;
}

function assertArtifact(payload, schema, collection) {
  if (!payload || payload.schema !== schema || !Array.isArray(payload[collection])) {
    throw new TypeError(`invalid ${schema} materialization`);
  }
  return payload;
}

function relationDate(entry, relation) {
  const tuple = entry.relation_dates?.[relation.candidate_id];
  return tuple ? { value: tuple[0], precision: tuple[1] } : null;
}

function sourceEvidence(source) {
  return source?.source_span || source?.source_judgment?.source_span || null;
}

function scopedValues(scope) {
  if (!scope) return [];
  if (Array.isArray(scope)) return scope.map((value) => clean(value, 160)).filter(Boolean);
  if (typeof scope !== "object") return [clean(scope, 160)].filter(Boolean);
  return Object.entries(scope)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${clean(value, 160)}`);
}

function timeEvent(row) {
  return {
    id: row.observation_id,
    kind: "dated_change",
    date: row.event_time,
    label: `${clean(row.lifecycle_action, 60).replaceAll("_", " ")} · ${clean(row.fact_kind, 100).replaceAll("_", " ")}`,
    subject_ids: [clean(row.subject_ref, 220)].filter(Boolean),
    scope: scopedValues(row.scope),
    source_system: clean(row.source_judgment?.source_system, 120),
    source_record_id: clean(row.source_judgment?.source_record_id, 220),
    evidence: sourceEvidence(row),
    preliminary: row.preliminary === true,
    event_class: clean(row.event_class, 60),
  };
}

function relationEvent(entry, row) {
  return {
    id: row.candidate_id,
    kind: "documented_connection",
    date: relationDate(entry, row),
    label: clean(row.reader_label, 100) || clean(row.relation, 100).replaceAll("_", " "),
    subject_ids: [clean(row.from, 220), clean(row.to, 220)].filter(Boolean),
    scope: [
      ...scopedValues(row.scope),
      ...scopedValues(row.geographic_scope),
      ...scopedValues(row.component_scope),
    ],
    source_system: clean(row.source_system, 120),
    source_record_id: clean(row.source_record_id, 220),
    evidence: sourceEvidence(row),
    preliminary: false,
    event_class: "documented connection",
  };
}

function dateSortKey(event) {
  return event.date?.start || event.date?.value || "9999-99-99";
}

function participant(row) {
  return {
    id: clean(row.candidate_id || `${row.role}:${row.subject}`, 240),
    role: clean(row.reader_label || row.role, 100),
    name: clean(row.actor?.display_name || row.actor?.spelling || "Source-qualified participant", 240),
    date: row.role_date || null,
    scope: scopedValues(row.scope),
    subject_id: clean(row.subject || row.to, 220),
    source: row.source_locator || null,
  };
}

/** Project one closed-dossier family from already-admitted materializations. */
export function projectConnectedHistoryJourney(artifacts, query) {
  const entry = connectedHistoryCaseForQuery(query);
  if (!entry) return null;
  const relations = assertArtifact(artifacts?.relations, CONNECTED_HISTORY_RELATIONS_SCHEMA, "relations");
  const time = assertArtifact(artifacts?.time, CONNECTED_HISTORY_TIME_SCHEMA, "observations");
  const roles = assertArtifact(artifacts?.roles, CONNECTED_HISTORY_ROLES_SCHEMA, "observations");

  const admittedRelations = relations.relations.filter((row) => row.family_id === entry.family_id);
  if (!admittedRelations.length) throw new Error(`connected history unavailable for ${entry.family_id}`);
  const dated = time.observations.filter((row) => row.family_id === entry.family_id).map(timeEvent);
  const connections = admittedRelations.map((row) => relationEvent(entry, row));
  const events = [...dated, ...connections].sort((left, right) => (
    dateSortKey(left).localeCompare(dateSortKey(right), "en-US") || left.id.localeCompare(right.id, "en-US")
  ));
  const participants = roles.observations.filter((row) => row.family_id === entry.family_id).map(participant);
  const identities = [...new Set(events.flatMap((event) => event.subject_ids))].sort((a, b) => a.localeCompare(b, "en-US"));
  if (identities.length < 2) throw new Error(`connected history identities collapsed for ${entry.family_id}`);

  return deepFreeze({
    schema: CONNECTED_HISTORY_JOURNEY_SCHEMA,
    family_id: entry.family_id,
    title: entry.title,
    matched_query: clean(query, 240),
    accepted_queries: [...entry.queries],
    scope: entry.scope,
    identities,
    events,
    participants,
    sources: entry.sources.map(([label, href]) => ({ label, href })),
    continue_href: entry.continue_href,
    continue_label: entry.continue_label,
    data_vintage: [relations.generated_at, time.generated_at, roles.generated_at].filter(Boolean).sort().at(-1) || null,
    source_policy: "fixed-six-case-dossier-and-retained-inputs-only",
  });
}

export async function loadConnectedHistoryJourney(query, options = {}) {
  const entry = connectedHistoryCaseForQuery(query);
  if (!entry) return { state: "not_applicable", journey: null };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const load = async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response?.ok) throw new Error(`history materialization HTTP ${response?.status || "unknown"}`);
    return response.json();
  };
  const [relations, time, roles] = await Promise.all([
    load(DATA_URLS.relations),
    load(DATA_URLS.time),
    load(DATA_URLS.roles),
  ]);
  return { state: "ready", journey: projectConnectedHistoryJourney({ relations, time, roles }, query) };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayIdentity(value) {
  const parts = clean(value, 240).split(":");
  return parts.at(-1)?.replaceAll("-", " ") || value;
}

function dateLabel(date) {
  if (!date?.value) return "Date not published in the retained connection";
  return `${date.value} · ${date.precision || "unknown"} precision`;
}

function sourceHref(journey, event) {
  const matching = journey.sources.find((source) => (
    source.label.toLocaleLowerCase("en-US").includes(event.source_system?.split("-")[0] || "")
  ));
  return matching?.href || journey.sources[0]?.href || journey.continue_href;
}

function eventHtml(journey, event) {
  const esc = escapeHtml;
  const scope = event.scope.length
    ? `<p class="connected-history-event-scope"><strong>Scope:</strong> ${esc(event.scope.join(" · "))}</p>`
    : "";
  const identities = event.subject_ids.map(displayIdentity).join(" · ");
  const quote = clean(event.evidence?.quote, 500);
  const source = sourceHref(journey, event);
  return `<li class="connected-history-event" data-connected-history-event="${esc(event.id)}">` +
    `<p class="connected-history-event-heading"><time>${esc(dateLabel(event.date))}</time>` +
    `<strong>${esc(event.label)}</strong>${event.preliminary ? '<span class="connected-history-marker">Preliminary</span>' : ""}</p>` +
    scope +
    `<details><summary>Inspect source-backed event</summary>` +
    `<div class="connected-history-event-evidence"><p><strong>Public record identities:</strong> ${esc(identities)}</p>` +
    (quote ? `<p><strong>Documented source span:</strong> “${esc(quote)}”</p>` : "") +
    `<p><a href="${esc(source)}" data-connected-history-open>Open the official source</a></p>` +
    `<button type="button" class="mini" data-connected-history-dismiss>Dismiss details</button></div></details></li>`;
}

function participantsHtml(journey) {
  if (!journey.participants.length) return "";
  const rows = journey.participants.map((row) => `<li><strong>${escapeHtml(row.role)}:</strong> ` +
    `${escapeHtml(row.name)} <span>${escapeHtml(dateLabel(row.date))}</span></li>`).join("");
  return `<section class="connected-history-participants" aria-labelledby="connected-history-participants-heading">` +
    `<h4 id="connected-history-participants-heading">Documented participants</h4><ul>${rows}</ul></section>`;
}

export function renderConnectedHistoryJourney(journey) {
  if (!journey) return "";
  const esc = escapeHtml;
  const identities = journey.identities.map(displayIdentity).join(" · ");
  const sourceLinks = journey.sources.map((source) => (
    `<li><a href="${esc(source.href)}">${esc(source.label)}</a></li>`
  )).join("");
  return `<p class="connected-history-kicker">Documented history</p>` +
    `<header><h3 id="connected-history-heading">${esc(journey.title)}</h3>` +
    `<p>Matched “${esc(journey.matched_query)}” · ${esc(journey.scope)}</p></header>` +
    `<p class="connected-history-boundary">These are distinct public records connected by admitted evidence, not one merged project. Dates keep the precision published by the source.</p>` +
    `<p class="connected-history-identities"><strong>Record identities:</strong> ${esc(identities)}</p>` +
    `<ol class="connected-history-timeline">${journey.events.map((event) => eventHtml(journey, event)).join("")}</ol>` +
    participantsHtml(journey) +
    `<details class="connected-history-sources"><summary>All retained source destinations</summary><ul>${sourceLinks}</ul></details>` +
    `<p class="connected-history-actions"><a href="${esc(journey.continue_href)}" data-connected-history-continue>${esc(journey.continue_label)}</a></p>`;
}

export function renderConnectedHistoryFailure(query, entry = connectedHistoryCaseForQuery(query)) {
  if (!entry) return "";
  const escapedQuery = escapeHtml(clean(query, 240));
  const retry = `/search/?q=${encodeURIComponent(clean(query, 240))}#connected-history`;
  const source = entry.sources[0];
  return `<p class="connected-history-kicker">Documented history</p>` +
    `<h3 id="connected-history-heading">History details did not load</h3>` +
    `<p>The request for “${escapedQuery}” is still in the address bar. This is an unavailable result, not a successful empty result.</p>` +
    `<p class="connected-history-actions"><a href="${escapeHtml(retry)}" data-connected-history-retry>Try again</a>` +
    `<a href="${escapeHtml(source[1])}">Open ${escapeHtml(source[0])}</a></p>`;
}

function bindJourneyControls(container) {
  if (!container || container.dataset.connectedHistoryBound === "true") return;
  container.dataset.connectedHistoryBound = "true";
  container.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-connected-history-dismiss]");
    if (!button) return;
    const details = button.closest("details");
    const summary = details?.querySelector("summary");
    if (details) details.open = false;
    summary?.focus();
  });
}

/** Paint the existing Search island without affecting the canonical result lanes. */
export async function paintConnectedHistoryJourney(root, query, options = {}) {
  const container = root?.querySelector?.("[data-connected-history]");
  const entry = connectedHistoryCaseForQuery(query);
  if (!container) return { state: "missing_container" };
  if (!entry) {
    container.hidden = true;
    container.replaceChildren();
    delete container.dataset.connectedHistoryState;
    return { state: "not_applicable" };
  }
  container.hidden = false;
  container.dataset.connectedHistoryState = "loading";
  container.dataset.connectedHistoryFamily = entry.family_id;
  container.setAttribute("aria-busy", "true");
  container.innerHTML = `<p class="connected-history-kicker">Documented history</p><p><span class="loading" aria-hidden="true"></span> Loading the retained history for “${escapeHtml(clean(query, 240))}”…</p>`;
  try {
    const result = await loadConnectedHistoryJourney(query, options);
    container.innerHTML = renderConnectedHistoryJourney(result.journey);
    container.dataset.connectedHistoryState = "ready";
    container.removeAttribute("aria-busy");
    container.setAttribute("aria-labelledby", "connected-history-heading");
    bindJourneyControls(container);
    if (location.hash === "#connected-history") container.scrollIntoView({ block: "start" });
    return result;
  } catch (error) {
    container.innerHTML = renderConnectedHistoryFailure(query, entry);
    container.dataset.connectedHistoryState = "unavailable";
    container.removeAttribute("aria-busy");
    container.setAttribute("aria-labelledby", "connected-history-heading");
    bindJourneyControls(container);
    return { state: "unavailable", error };
  }
}
