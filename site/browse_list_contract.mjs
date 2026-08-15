/** Shared contract helpers for static Browse lists with typed rows. */

export const PEOPLE_ORGANIZATIONS_BROWSE_CONFIG = Object.freeze({
  route: "/browse/people/",
  queryParam: "q",
  facetParam: "type",
  facetKey: "kind",
  searchKey: "search_text",
  initialPageSize: 16,
  pageSize: 24,
  facetValues: Object.freeze([
    "official",
    "exact-person-appointment",
    "notice-only-hire",
    "agency",
    "vendor",
    "committee",
    "community-board",
  ]),
});

function clean(value) {
  return String(value ?? "").trim();
}

export function browseListParams(search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const query = clean(params.get(config.queryParam));
  const facet = clean(params.get(config.facetParam));
  return {
    query,
    facet: config.facetValues.includes(facet) ? facet : "",
  };
}

export function filterConfiguredBrowseRows(rows, search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const { query, facet } = browseListParams(search, config);
  const normalizedQuery = query.toLocaleLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (facet && row?.[config.facetKey] !== facet) return false;
    if (!normalizedQuery) return true;
    return clean(row?.[config.searchKey]).toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function browseListShareSearch({ query = "", facet = "" } = {}, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const params = new URLSearchParams();
  const normalizedQuery = clean(query);
  const normalizedFacet = config.facetValues.includes(clean(facet)) ? clean(facet) : "";
  if (normalizedQuery) params.set(config.queryParam, normalizedQuery);
  if (normalizedFacet) params.set(config.facetParam, normalizedFacet);
  return params;
}

export function browseListState(model = {}, search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const allRows = Array.isArray(model.rows) ? model.rows : [];
  const filteredRows = filterConfiguredBrowseRows(allRows, search, config);
  const { query, facet } = browseListParams(search, config);
  return {
    rows: filteredRows,
    total: allRows.length,
    matched: filteredRows.length,
    query,
    facet,
    generatedAt: clean(model.generated_at) || null,
    status: allRows.length ? "published" : (model.generated_at ? "empty" : "unknown"),
    counts: model.counts && typeof model.counts === "object" ? model.counts : {},
  };
}
