export const SOURCE_LABELS = Object.freeze({
  search: "Search",
  near_you: "Near You",
  object: "Selected record",
  browse: "Browse",
});

export const PLACE_KEYS = Object.freeze(["boro", "cd", "council", "neighborhood", "scope"]);
const COORDINATE_KEYS = Object.freeze(["lat", "lng", "lon", "latitude", "longitude", "accuracy"]);

/** The canonical record-search route and its canonical query field. */
export const RECORD_SEARCH_ROUTE = "/search/";
export const RECORD_SEARCH_QUERY_KEY = "q";

// Typed collection routes read the canonical `q` topic. A walk that offers one
// hands the resident's topic over as `q` while keeping its own traversal fields,
// so the destination filters records instead of only remembering a journey.
const TYPED_COLLECTION_ROUTE = /^\/browse\/[a-z][a-z0-9-]*\/?$/;

function clean(value, max = 240) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The shared topic normalizer, so a route reading a topic reads it this way. */
export function normalizeTopicQuery(value, max = 240) {
  return clean(value, max);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function first(values) {
  return Array.isArray(values) && values.length ? clean(values[0], 80) : "";
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS.browse;
}

function scopePlaceValues(place = {}) {
  const raw = place && typeof place === "object" ? place : {};
  const nested = raw.place && typeof raw.place === "object" ? raw.place : raw;
  return {
    boro: first(nested.boroughs) || clean(nested.borough ?? nested.boro, 80),
    cd: first(nested.community_districts) || clean(nested.community_district ?? nested.communityDistrict ?? nested.cd, 20),
    council: first(nested.council_districts) || clean(nested.council_district ?? nested.councilDistrict ?? nested.council, 20),
    neighborhood: clean(nested.neighborhood, 80),
    scope: clean(nested.location_scope ?? nested.locationScope ?? nested.scope, 40),
  };
}

export function walkEntryHref(baseHref = "/browse/", { source = "search", query = "", place = {} } = {}) {
  const safeSource = Object.hasOwn(SOURCE_LABELS, source) ? source : "search";
  let url;
  try {
    url = new URL(String(baseHref || "/browse/"), "https://cityscroll.org");
  } catch {
    url = new URL("/browse/", "https://cityscroll.org");
  }
  for (const key of COORDINATE_KEYS) url.searchParams.delete(key);
  const safeQuery = clean(query, 240);
  // Canonical topic first: a typed destination reads `q`, and the walk fields
  // that follow describe the journey rather than the search.
  if (safeQuery && TYPED_COLLECTION_ROUTE.test(url.pathname)) {
    url.searchParams.set(RECORD_SEARCH_QUERY_KEY, safeQuery);
  }
  url.searchParams.set("walk_source", safeSource);
  if (safeQuery) url.searchParams.set("walk_query", safeQuery);
  else url.searchParams.delete("walk_query");
  const values = scopePlaceValues(place);
  for (const key of PLACE_KEYS) url.searchParams.delete(key);
  for (const key of PLACE_KEYS) {
    if (values[key]) url.searchParams.set(key, values[key]);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function walkEntryPlaceLabel(place = {}) {
  const values = scopePlaceValues(place);
  return [values.boro, values.cd && `CD ${values.cd}`, values.council && `Council ${values.council}`, values.neighborhood, values.scope]
    .filter(Boolean)
    .join(" · ");
}

function familyState(family) {
  if (family?.status === "unsupported") return "unsupported";
  if (family?.status === "empty") return "empty";
  if (family?.status === "unknown") return "unknown";
  if (Number.isFinite(Number(family?.count))) return Number(family.count) > 0 ? "available" : "empty";
  return "unknown";
}

function familyStateLabel(state, count) {
  if (state === "available") return `${Number(count).toLocaleString("en-US")} records in this family`;
  if (state === "empty") return "";
  if (state === "unsupported") return "";
  return "Records not shown";
}

export function renderWalkEntry({
  source = "browse",
  query = "",
  place = {},
  placeLabel = "",
  families = [],
  actionHref = "/browse/",
  actionLabel = "Search records",
  title = "Search NYC records",
  description = "Search and Near You become front doors into the same graph.",
  recordSearch = false,
} = {}) {
  const safeSource = Object.hasOwn(SOURCE_LABELS, source) ? source : "browse";
  const safeQuery = clean(query, 240);
  const safePlace = clean(placeLabel, 160);
  const chips = [
    safeQuery ? `<span class="walk-entry-chip"><b>TEXT</b> ${esc(safeQuery)}</span>` : "",
    safePlace ? `<span class="walk-entry-chip walk-entry-chip-place"><b>PLACE</b> ${esc(safePlace)}</span>` : "",
    `<span class="walk-entry-chip walk-entry-chip-source"><b>START</b> ${esc(sourceLabel(safeSource))}</span>`,
  ].filter(Boolean).join("");
  const lanes = (Array.isArray(families) ? families : []).map((family) => {
    const state = familyState(family);
    const label = clean(family?.label || "Records", 80);
    const href = clean(family?.href, 1000);
    const target = href && state !== "unsupported"
      ? `<a data-walk-family="${esc(family.id || label)}" href="${esc(href)}">${esc(label)}</a>`
      : `<span>${esc(label)}</span>`;
    return `<article class="walk-entry-lane" data-walk-family-state="${esc(state)}">
      <p class="walk-entry-lane-kicker">${esc(family?.kicker || label)}</p>
      <h3>${target}</h3>
      <p>${esc(family?.description || "Open the supported public records for this family.")}</p>
      ${familyStateLabel(state, family?.count) ? `<p class="walk-entry-coverage" data-walk-coverage="${esc(state)}">${esc(familyStateLabel(state, family?.count))}</p>` : ""}
    </article>`;
  }).join("");
  // A record-search control submits canonical Search state: the visible field is
  // `q`, the action is the canonical Search route, and no traversal field rides
  // along. A walk control keeps its own traversal fields instead.
  const placeValues = scopePlaceValues(place);
  const preservedPlace = recordSearch
    ? PLACE_KEYS
      .filter((key) => placeValues[key])
      .map((key) => `<input type="hidden" name="${esc(key)}" value="${esc(placeValues[key])}">`)
      .join("")
    : "";
  const form = recordSearch
    ? `<form class="walk-entry-form" method="get" action="${esc(RECORD_SEARCH_ROUTE)}" data-walk-search-form data-walk-record-search="true">
      <label for="walk-entry-query">What are you looking for?</label>
      <div class="walk-entry-form-row"><input id="walk-entry-query" name="${esc(RECORD_SEARCH_QUERY_KEY)}" type="search" value="${esc(safeQuery)}" maxlength="240" autocomplete="off">${preservedPlace}<button type="submit">${esc(actionLabel)}</button></div>
    </form>`
    : `<form class="walk-entry-form" method="get" action="${esc(actionHref)}" data-walk-search-form>
      <label for="walk-entry-query">What are you looking for?</label>
      <div class="walk-entry-form-row"><input id="walk-entry-query" name="walk_query" value="${esc(safeQuery)}" maxlength="240" autocomplete="off"><input type="hidden" name="walk_source" value="${esc(safeSource)}"><button type="submit">${esc(actionLabel)}</button></div>
    </form>`;
  return `<section class="walk-entry" data-walk-entry data-walk-source="${esc(safeSource)}" aria-labelledby="walk-entry-heading">
    <div class="walk-entry-head"><div><p class="walk-entry-kicker">${esc(recordSearch ? "Search" : "Start a walk")}</p><h2 id="walk-entry-heading">${esc(title)}</h2><p>${esc(description)}</p></div><span class="walk-entry-mark">Graph entry</span></div>
    ${form}
    <div class="walk-entry-chips" data-walk-chips aria-label="Walk context">${chips}</div>
    <div class="walk-entry-lanes" data-walk-families>${lanes}</div>
  </section>`;
}
