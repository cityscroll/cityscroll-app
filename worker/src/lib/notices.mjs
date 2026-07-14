// Search over the D1 notices mirror (adapted from Dev Doshi's crol-alert match.ts,
// itself a port of his crol-analyzer crol_data.py search engine).
//
// AND-of-ORs term matching with a relevance score, plus the data-honesty rules the
// EDA established: money filters only see rows with a VALID contract amount
// (0 < x < $10B — the $96T row is a data-entry error), and due dates in year >= 2090
// are rolling placeholders, surfaced as a deadline_note instead of a fake date.
//
// Pure query-building is exported separately so it unit-tests without a D1 handle.

const ROLLING_YEAR = 2090;

function fmtMoney(x) {
  if (x === null || x === undefined) return null;
  return "$" + Math.round(x).toLocaleString("en-US");
}

export function snippet(text, n = 240) {
  if (!text) return null;
  let s = String(text).replace(/<[^>]+>/g, " "); // recent notices carry HTML payloads
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// opts: { termGroups?: string[][], section?, agency?, category?, noticeType?,
//         minAmount?, maxAmount?, excludeSpecialCase?, excludeRollingDeadlines?,
//         openOnly?, dueBefore?, sinceDate?, limit?, today? }
// termGroups is AND-of-ORs: every group must match via at least one of its terms.
export function buildNoticesQuery(opts = {}) {
  const where = [];
  const params = [];
  const today = opts.today || new Date().toISOString().slice(0, 10);

  if (opts.section) { where.push("section = ?"); params.push(opts.section); }
  if (opts.agency) { where.push("lower(agency) LIKE ?"); params.push("%" + String(opts.agency).toLowerCase() + "%"); }
  if (opts.category) { where.push("category = ?"); params.push(opts.category); }
  if (opts.noticeType) { where.push("type_of_notice = ?"); params.push(opts.noticeType); }

  const hasAmount = opts.minAmount != null || opts.maxAmount != null;
  if (hasAmount) {
    where.push("contract_amount_valid = 1"); // honest-data rule: corrupt amounts never match money filters
    if (opts.minAmount != null) { where.push("contract_amount >= ?"); params.push(opts.minAmount); }
    if (opts.maxAmount != null) { where.push("contract_amount <= ?"); params.push(opts.maxAmount); }
  }
  if (opts.excludeSpecialCase) where.push("special_case_reason IS NULL");
  if (opts.excludeRollingDeadlines) { where.push("due_year IS NOT NULL AND due_year < ?"); params.push(ROLLING_YEAR); }
  if (opts.openOnly) { where.push("due_date >= ?"); params.push(today); }
  if (opts.dueBefore) { where.push("due_date <= ?"); params.push(opts.dueBefore); }
  if (opts.sinceDate) { where.push("start_date >= ?"); params.push(opts.sinceDate); }

  const groups = opts.termGroups || [];
  const allTerms = [];
  for (const g of groups) {
    const ors = [];
    for (const t of g) {
      ors.push("haystack LIKE ?");
      params.push("%" + String(t).toLowerCase() + "%");
      allTerms.push(String(t).toLowerCase());
    }
    if (ors.length) where.push("(" + ors.join(" OR ") + ")");
  }
  // Relevance score: count of matching terms. Terms are inline-escaped (parameter
  // ordering would break otherwise); they are already lowercased above.
  const scoreParts = allTerms.map((t) => `(haystack LIKE '%${t.replace(/'/g, "''")}%')`);
  const scoreExpr = scoreParts.length ? scoreParts.join(" + ") : "0";

  let orderBy;
  if (hasAmount) orderBy = "contract_amount DESC, start_date DESC";
  else if (allTerms.length) orderBy = "_score DESC, start_date DESC";
  else orderBy = "start_date DESC";

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 100));
  const sql = `SELECT *, (${scoreExpr}) AS _score FROM notices ${whereSql} ORDER BY ${orderBy} LIMIT ${limit}`;
  return { sql, params, terms: allTerms };
}

// Row → display record, honest fields applied.
export function toRecord(r) {
  const amt = r.contract_amount_valid ? r.contract_amount : null;
  const rolling = r.due_year != null && r.due_year >= ROLLING_YEAR;
  let docs = [];
  try { docs = r.document_urls ? JSON.parse(r.document_urls) : []; } catch { docs = []; }
  const eventLoc = [r.event_building, r.event_addr1, r.event_city, r.event_state, r.event_zip]
    .filter(Boolean)
    .join(" ");
  return {
    request_id: r.request_id,
    date: r.start_date || null,
    section: r.section || null,
    agency: r.agency || null,
    notice_type: r.type_of_notice || null,
    category: r.category || null,
    title: r.short_title || null,
    snippet: snippet(r.description || null),
    contract_amount: amt,
    contract_amount_display: fmtMoney(amt),
    selection_method: r.selection_method || null,
    pin: r.pin || null,
    vendor: r.vendor_name || null,
    due_date: rolling ? null : (r.due_date || null),
    deadline_note: rolling ? "rolling / no fixed deadline (e.g. pre-qualified list)" : null,
    event_date: r.event_date || null,
    event_location: eventLoc || null,
    n_documents: r.n_documents || 0,
    documents: docs.slice(0, 8),
  };
}

export async function searchNotices(db, opts = {}) {
  const { sql, params, terms } = buildNoticesQuery(opts);
  const { results } = await db.prepare(sql).bind(...params).all();
  const rows = results ?? [];
  return { terms_used: terms, total_matches: rows.length, results: rows.map(toRecord) };
}
