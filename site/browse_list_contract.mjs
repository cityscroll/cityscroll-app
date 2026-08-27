/** Shared contract helpers for static Browse lists with typed rows. */

import { PEOPLE_ORGANIZATIONS_SURFACE } from "./browse_surface_contracts.mjs";

export const PEOPLE_ORGANIZATIONS_BROWSE_CONFIG = Object.freeze({
  route: PEOPLE_ORGANIZATIONS_SURFACE.canonicalRoute,
  queryParam: "q",
  facetParam: "type",
  facetKey: "kind",
  institutionParam: "institution",
  institutionKey: "institution",
  roleParam: "role",
  roleKey: "role_family",
  roleValues: Object.freeze(["member", "staff"]),
  institutionValues: Object.freeze([
    "community-board",
    "city-council",
    "agency",
    "vendor",
  ]),
  searchKey: "search_text",
  initialPageSize: 16,
  pageSize: 24,
  facetValues: Object.freeze([
    "community-board",
    "community-board-person",
    "community-board-committee",
    "official",
    "exact-person-appointment",
    "committee",
    "agency",
    "vendor",
    "notice-only-hire",
  ]),
});

function clean(value) {
  return String(value ?? "").trim();
}

export function browseListParams(search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const query = clean(params.get(config.queryParam));
  const facet = clean(params.get(config.facetParam));
  const institution = clean(params.get(config.institutionParam));
  const role = clean(params.get(config.roleParam));
  return {
    query,
    facet: config.facetValues.includes(facet) ? facet : "",
    institution: config.institutionValues.includes(institution) ? institution : "",
    role: config.roleValues.includes(role) ? role : "",
  };
}

export function filterConfiguredBrowseRows(rows, search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const { query, facet, institution, role } = browseListParams(search, config);
  const normalizedQuery = query.toLocaleLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (facet && row?.[config.facetKey] !== facet) return false;
    if (institution && row?.[config.institutionKey] !== institution) return false;
    if (role && row?.[config.roleKey] !== role) return false;
    if (!normalizedQuery) return true;
    return clean(row?.[config.searchKey]).toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function browseListShareSearch({ query = "", facet = "", institution = "", role = "" } = {}, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const params = new URLSearchParams();
  const normalizedQuery = clean(query);
  const normalizedFacet = config.facetValues.includes(clean(facet)) ? clean(facet) : "";
  if (normalizedQuery) params.set(config.queryParam, normalizedQuery);
  if (normalizedFacet) params.set(config.facetParam, normalizedFacet);
  const normalizedInstitution = config.institutionValues.includes(clean(institution)) ? clean(institution) : "";
  if (normalizedInstitution) params.set(config.institutionParam, normalizedInstitution);
  const normalizedRole = config.roleValues.includes(clean(role)) ? clean(role) : "";
  if (normalizedRole) params.set(config.roleParam, normalizedRole);
  return params;
}

export function browseListState(model = {}, search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG) {
  const allRows = Array.isArray(model.rows) ? model.rows : [];
  const filteredRows = filterConfiguredBrowseRows(allRows, search, config);
  const { query, facet, institution, role } = browseListParams(search, config);
  return {
    rows: filteredRows,
    total: allRows.length,
    matched: filteredRows.length,
    query,
    facet,
    institution,
    role,
    generatedAt: clean(model.generated_at) || null,
    status: allRows.length ? "published" : (model.generated_at ? "empty" : "unknown"),
    counts: model.counts && typeof model.counts === "object" ? model.counts : {},
  };
}
