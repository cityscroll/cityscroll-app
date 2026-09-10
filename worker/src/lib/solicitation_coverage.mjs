// Open solicitation digest coverage: imminent deadlines plus recent publications.
//
// The due-date page alone hides a newly published row whose due date is later
// than the 25 soonest. Merge a start_date DESC page, keep due-date rows first,
// and cap the union.

export const SOLICITATION_PAGE_LIMIT = 25;
export const SOLICITATION_COVERAGE_CAP = 50;

function rowId(row, idField) {
  return row?.[idField] || row?.request_id || row?.digest_id || null;
}

export function mergeSolicitationCoverageRows(dueRows = [], recentRows = [], {
  idField = "digest_id",
  cap = SOLICITATION_COVERAGE_CAP,
} = {}) {
  const out = [];
  const seen = new Set();
  const limit = Math.max(1, Number(cap) || SOLICITATION_COVERAGE_CAP);
  for (const row of [...dueRows, ...recentRows]) {
    const id = rowId(row, idField);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function solicitationRecentParams(params = {}) {
  return { ...params, "$order": "start_date DESC" };
}
