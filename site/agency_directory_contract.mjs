/**
 * Shared query contract for the public-body directory at /agencies/.
 *
 * The static document renders every row, and this module decides which of them
 * a query and a browse group keep. The build tool, the browser enhancement and
 * the tests all read the same rules, so what a reader sees after typing is what
 * a shared link, a reload and the browser's Back button reproduce.
 *
 * Both parameters are ordinary URL search parameters on a real anchor or form,
 * which is why the page keeps working with scripting unavailable: the browser
 * navigates, the group anchor still lands on that group's section, and no row
 * is hidden behind a script that never ran.
 */

export const AGENCY_DIRECTORY_CONFIG = Object.freeze({
  route: "/agencies/",
  queryParam: "q",
  groupParam: "group",
  allGroupId: "",
  maxQueryLength: 120,
});

function directoryClean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function directoryFold(value) {
  return directoryClean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The folded haystack one row is matched against. */
export function agencyDirectoryRowHaystack(row) {
  return directoryFold([
    row?.name,
    row?.canonical_id,
    ...(Array.isArray(row?.acronyms) ? row.acronyms : []),
    ...(Array.isArray(row?.source_spellings) ? row.source_spellings : []),
  ].filter(Boolean).join(" "));
}

/**
 * Read the query and group from a URL search string.
 *
 * A group the page does not publish is dropped rather than honoured, so a
 * stale or hand-edited link degrades to the full directory instead of an empty
 * result a reader would read as "nothing here".
 */
export function agencyDirectoryParams(search, groupIds = []) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search || "");
  const query = directoryClean(params.get(AGENCY_DIRECTORY_CONFIG.queryParam))
    .slice(0, AGENCY_DIRECTORY_CONFIG.maxQueryLength);
  const requested = directoryClean(params.get(AGENCY_DIRECTORY_CONFIG.groupParam)).toLowerCase();
  const known = new Set(groupIds);
  return {
    query,
    group: known.has(requested) ? requested : AGENCY_DIRECTORY_CONFIG.allGroupId,
  };
}

/** The search string a shared link carries for one directory state. */
export function agencyDirectoryShareSearch({ query = "", group = "" } = {}, groupIds = []) {
  const params = new URLSearchParams();
  const cleanQuery = directoryClean(query).slice(0, AGENCY_DIRECTORY_CONFIG.maxQueryLength);
  const cleanGroup = directoryClean(group).toLowerCase();
  if (cleanQuery) params.set(AGENCY_DIRECTORY_CONFIG.queryParam, cleanQuery);
  if (cleanGroup && new Set(groupIds).has(cleanGroup)) {
    params.set(AGENCY_DIRECTORY_CONFIG.groupParam, cleanGroup);
  }
  return params;
}

/**
 * True when a row belongs to a browse group.
 *
 * A group is a navigation placement, not an exclusive legal class, so a row
 * matches its primary placement and any secondary group its reviewed evidence
 * supports. The same institution is still one row: grouping never duplicates it.
 */
export function agencyDirectoryRowInGroup(row, group) {
  if (!group) return true;
  if (row?.group === group) return true;
  return Array.isArray(row?.secondary_groups) && row.secondary_groups.includes(group);
}

/**
 * True when every token a reader typed starts a word in the row's surfaces.
 *
 * Matching at a word boundary rather than anywhere in the string is what keeps
 * one body's shorthand out of another body's row: "ORE" reaches the Office of
 * Racial Equity without also matching the "CORE" that belongs to the
 * Commission on Racial Equity. Partial typing still works, because a token
 * matches the start of a word.
 */
export function agencyDirectoryMatchesQuery(row, query) {
  const folded = directoryFold(query);
  if (!folded) return true;
  const haystack = ` ${row?.haystack || agencyDirectoryRowHaystack(row)}`;
  return folded.split(" ").every((token) => haystack.includes(` ${token}`));
}

/** The rows one directory state keeps, in the order they were given. */
export function filterAgencyDirectoryRows(rows, { query = "", group = "" } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    agencyDirectoryRowInGroup(row, group) && agencyDirectoryMatchesQuery(row, query)
  ));
}

/**
 * The sentence under the search box.
 *
 * It always states a matched count against a total, so a filtered view is
 * never mistaken for the whole directory and an empty result is never
 * mistaken for a failed load.
 */
export function agencyDirectorySummary({ matched = 0, total = 0, query = "", groupLabel = "" } = {}) {
  const body = matched === total
    ? `Showing all ${total} public ${total === 1 ? "body" : "bodies"}`
    : `Showing ${matched} of ${total} public ${total === 1 ? "body" : "bodies"}`;
  const within = groupLabel ? ` in ${groupLabel}` : "";
  const searched = directoryClean(query) ? ` matching “${directoryClean(query)}”` : "";
  return `${body}${within}${searched}.`;
}
