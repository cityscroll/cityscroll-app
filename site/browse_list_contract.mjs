/** Shared contract helpers for static Browse lists with typed rows. */

import { PEOPLE_ORGANIZATIONS_SURFACE } from "./browse_surface_contracts.mjs";
import {
  ORGANIZATIONS_BROWSE_LIMITS,
  validateOrganizationsBrowseInput,
  validateOrganizationsBrowseOutput,
} from "../capabilities/people_organizations.mjs";
import { organizationsBrowseFromModel } from "../capabilities/people_organizations_provider.mjs";

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

function capabilityModel(rows, config) {
  return {
    rows: (Array.isArray(rows) ? rows : []).filter((row) => (
      config.facetValues.includes(row?.[config.facetKey])
    )).map((row, index) => ({
      ...row,
      // Build fixtures and older embedded documents may omit fields that are
      // not needed by the renderer. Give the capability a typed identity
      // without changing the original presentation row.
      id: clean(row.id) || `ui-row:${index}`,
      label: clean(row.label) || clean(row.search_text) || `row ${index}`,
      relation_state: row.relation_state || "unknown",
    })),
  };
}

function scopedRows(rows, search, config) {
  const { institution, role } = browseListParams(search, config);
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    (!institution || row?.[config.institutionKey] === institution)
    && (!role || row?.[config.roleKey] === role)
  ));
}

function capabilityPage(rows, input, config) {
  validateOrganizationsBrowseInput(input);
  const sourceRows = (Array.isArray(rows) ? rows : []).filter((row) => config.facetValues.includes(row?.[config.facetKey]));
  const preparedRows = capabilityModel(sourceRows, config).rows;
  const result = validateOrganizationsBrowseOutput(
    organizationsBrowseFromModel({ rows: preparedRows }, input),
    input,
  );
  const originalRows = new Map(preparedRows.map((row, index) => [row.id, sourceRows[index]]));
  return {
    ...result,
    // `search_text` is intentionally omitted by the public capability. Keep
    // it available to the renderer as a presentation-only data attribute.
    results: result.results.map((row) => {
      const original = originalRows.get(row.id) || {};
      const merged = { ...original, ...row };
      return Object.fromEntries(Object.keys(original).map((field) => [field, merged[field]]));
    }),
  };
}

function capabilityRows(rows, search, config) {
  const { query, facet } = browseListParams(search, config);
  const sourceRows = scopedRows(rows, search, config);
  const all = [];
  let cursor = null;
  do {
    const page = capabilityPage(sourceRows, {
      ...(query ? { query } : {}),
      ...(facet ? { kind: facet } : {}),
      limit: ORGANIZATIONS_BROWSE_LIMITS.maximum,
      ...(cursor ? { cursor } : {}),
    }, config);
    if (page.availability === "unavailable") return [];
    all.push(...page.results);
    cursor = page.pagination.next_cursor;
  } while (cursor);
  return all;
}

/** Return only the visible page while retaining the capability total. */
export function browseConfiguredPage(rows, search, config = PEOPLE_ORGANIZATIONS_BROWSE_CONFIG, limit = config.initialPageSize) {
  const { query, facet } = browseListParams(search, config);
  const pageSize = Math.max(1, Math.floor(Number(limit) || config.initialPageSize));
  const sourceRows = scopedRows(rows, search, config);
  const all = [];
  let cursor = null;
  let firstPage = null;
  do {
    const page = capabilityPage(sourceRows, {
      ...(query ? { query } : {}),
      ...(facet ? { kind: facet } : {}),
      limit: Math.min(ORGANIZATIONS_BROWSE_LIMITS.maximum, pageSize),
      ...(cursor ? { cursor } : {}),
    }, config);
    firstPage ||= page;
    if (page.availability === "unavailable") return { ...page, rows: [], total_matches: 0 };
    all.push(...page.results);
    cursor = page.pagination.next_cursor;
  } while (cursor && all.length < pageSize);
  return {
    ...firstPage,
    rows: all.slice(0, pageSize),
    total_matches: firstPage?.total_matches || 0,
  };
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
  return capabilityRows(rows, search, config);
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
