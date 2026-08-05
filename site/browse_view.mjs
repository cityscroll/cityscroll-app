export const BROWSE_FACETS = Object.freeze({
  contracts: {
    tab: "money",
    label: "Contracts",
    container: "list",
    dataPath: "/data/money_default_open.json",
    rowsKey: "notices",
  },
  staffing: {
    tab: "people",
    label: "Staffing",
    container: "staffing-notice-list",
    dataPath: "/data/staffing_default_hires.json",
    rowsKey: "notices",
  },
  zoning: {
    tab: "land",
    label: "Zoning",
    container: "llist",
    dataPath: "/data/land_default_ulurp.json",
    rowsKey: "projects",
  },
  property: {
    tab: "property",
    label: "Property",
    container: "propertyfeed",
    dataPath: "/data/property_domain_observations.json",
    rowsKey: "property_rows",
  },
  rules: {
    tab: "rules",
    label: "Rules",
    container: "rulesfeed",
    dataPath: "/data/rules_domain_observations.json",
    rowsKey: "rows",
  },
  meetings: {
    tab: "meetings",
    label: "Meetings",
    container: "meetingsfeed",
    dataPath: "/data/meetings_domain_observations.json",
    rowsKey: "rows",
  },
});

const EDGE_FILTERS = new Set(["q", "agency", "boro", "closing", "when", "status"]);
const DOCUMENT_FILTERS = new Set(["lang", "legacy"]);

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isoDay(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function rowId(facet, row) {
  if (facet === "zoning") return row.project_id || null;
  return row.request_id || null;
}

function rowTitle(facet, row) {
  if (facet === "zoning") return row.project_name || row.project_id;
  return row.short_title || row.title || row.request_id;
}

function rowAgency(facet, row) {
  if (facet === "zoning") return row.primary_applicant || null;
  return row.agency_name || row.agency || null;
}

function rowDate(facet, row) {
  if (facet === "contracts") return row.due_date || row.start_date;
  if (facet === "meetings") return row.event_date || row.start_date;
  return row.start_date || row.event_date || null;
}

function rowPlace(facet, row) {
  if (facet === "zoning") return row.borough || row.community_district || "";
  const area = row.affected_area || row.rule_location || {};
  const boroughs = Array.isArray(area.boroughs) ? area.boroughs : [];
  return [row.borough, row.property_location, row.street_address_1, area.borough, ...boroughs]
    .filter(Boolean).join(" ");
}

function rowHref(facet, row) {
  const id = rowId(facet, row);
  if (!id) return null;
  if (facet === "zoning") return `/#land/${encodeURIComponent(id)}`;
  return `/notices/${encodeURIComponent(id)}`;
}

function corpus(row) {
  return Object.values(row || {}).flatMap((value) => {
    if (value == null) return [];
    if (typeof value === "object") return [JSON.stringify(value)];
    return [String(value)];
  }).join(" ").toLocaleLowerCase();
}

function matchesClosing(row, value, asOf) {
  if (!value) return true;
  const due = isoDay(row.due_date);
  const start = isoDay(asOf);
  if (!due || !start) return false;
  const days = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
  if (value === "week") return days >= 0 && days <= 7;
  if (value === "month") return days >= 0 && days <= 30;
  return true;
}

function liveOnlyFilters(params) {
  const liveOnly = [];
  for (const [key] of params) {
    if (DOCUMENT_FILTERS.has(key) || EDGE_FILTERS.has(key)) continue;
    liveOnly.push(key);
  }
  return [...new Set(liveOnly)].sort();
}

export function buildBrowseView(facet, payload = {}, params = new URLSearchParams(), options = {}) {
  const config = BROWSE_FACETS[facet];
  if (!config) return null;
  const search = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const query = String(search.get("q") || "").trim().toLocaleLowerCase();
  const agency = String(search.get("agency") || "").trim().toLocaleLowerCase();
  const borough = String(search.get("boro") || "").trim().toLocaleLowerCase();
  const status = String(search.get("status") || "").trim().toLocaleLowerCase();
  const asOf = payload.open_as_of || payload.generated_at || payload.retrieved_at || null;
  const rows = Array.isArray(payload[config.rowsKey]) ? payload[config.rowsKey] : [];
  const matched = rows.filter((row) => {
    const text = corpus(row);
    if (query && !text.includes(query)) return false;
    if (agency && !String(rowAgency(facet, row) || "").toLocaleLowerCase().includes(agency)) return false;
    if (borough && !rowPlace(facet, row).toLocaleLowerCase().includes(borough)) return false;
    if (status && !String(row.public_status || row.project_status || row.disposition_stage || "").toLocaleLowerCase().includes(status)) return false;
    if (facet === "contracts" && !matchesClosing(row, search.get("closing"), asOf)) return false;
    return true;
  });
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 40;
  return {
    facet,
    config,
    total: matched.length,
    rows: matched.slice(0, limit),
    asOf: isoDay(asOf),
    liveOnlyFilters: liveOnlyFilters(search),
    hasQuery: [...search].some(([key]) => !DOCUMENT_FILTERS.has(key)),
  };
}

function renderedDate(value) {
  const day = isoDay(value);
  if (!day) return "";
  return `<time datetime="${esc(day)}">${esc(day)}</time>`;
}

export function renderBrowseView(view) {
  if (!view) return "";
  const disclosure = view.liveOnlyFilters.length
    ? `<p class="note warn browse-filter-disclosure" role="status">These filters need the live Browse controls: ${esc(view.liveOnlyFilters.join(", "))}. The bounded default is shown until the page is enhanced.</p>`
    : "";
  const cards = view.rows.map((row) => {
    const href = rowHref(view.facet, row);
    const title = rowTitle(view.facet, row) || "Untitled record";
    const agency = rowAgency(view.facet, row);
    const date = renderedDate(rowDate(view.facet, row));
    const place = rowPlace(view.facet, row);
    return `<article class="browse-static-record" data-record-id="${esc(rowId(view.facet, row) || "")}">
      <h3>${href ? `<a href="${esc(href)}" lang="en" dir="ltr">${esc(title)}</a>` : `<span lang="en" dir="ltr">${esc(title)}</span>`}</h3>
      <p class="browse-static-meta">${[agency && esc(agency), date, place && esc(place)].filter(Boolean).join(" · ")}</p>
    </article>`;
  }).join("");
  const summary = `<p class="browse-static-summary" data-build-summary>${esc(view.config.label)} · ${view.total} bounded ${view.total === 1 ? "record" : "records"}${view.asOf ? ` · source snapshot ${esc(view.asOf)}` : ""}</p>`;
  return `<div class="browse-build-view" data-build-rendered="browse" data-browse-facet="${esc(view.facet)}">${summary}${disclosure}${cards || `<div class="empty">No records match this bounded view.</div>`}</div>`;
}

export function browseAssetPath(facet) {
  return BROWSE_FACETS[facet]?.dataPath || null;
}

export function browseContainerId(facet) {
  return BROWSE_FACETS[facet]?.container || null;
}
