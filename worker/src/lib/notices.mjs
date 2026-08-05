// Search over the D1 notices mirror (adapted from Dev Doshi's crol-alert match.ts,
// itself a port of his crol-analyzer crol_data.py search engine).
//
// AND-of-ORs term matching with a relevance score, plus the data-honesty rules the
// EDA established: money filters only see rows with a VALID contract amount
// (0 < x < $10B — the $96T row is a data-entry error), and due dates in year >= 2090
// are rolling placeholders, surfaced as a deadline_note instead of a fake date.
//
// Pure query-building is exported separately so it unit-tests without a D1 handle.

import { excerptPlain } from "../../../site/text_clean.mjs";
import { loadAttachmentMetadata, mergeAttachments } from "../attachment_metadata.mjs";
import {
  joinAttachmentTexts,
  matchAttachmentTextEvidence,
  TEXT_PROVENANCE,
} from "./attachment_text.mjs";
import {
  joinAttachmentTablesText,
  matchAttachmentTablesEvidence,
  TABLE_PROVENANCE,
} from "./attachment_tables.mjs";

const ROLLING_YEAR = 2090;
const FTS_UNAVAILABLE = [
  /no such table:\s*(?:main\.)?notices_fts/i,
  /no such module:\s*fts5/i,
  /unable to use function bm25/i,
];
const FTS_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does",
  "for", "from", "how", "in", "is", "it", "must", "of", "on", "or", "that",
  "the", "their", "this", "to", "under", "was", "were", "what", "when", "where",
  "which", "who", "with", "would", "about", "can", "city", "new", "public", "rules",
]);

function fmtMoney(x) {
  if (x === null || x === undefined) return null;
  return "$" + Math.round(x).toLocaleString("en-US");
}

// Decode → truncate on plain text (never mid-entity). Callers that embed in HTML
// must escape once — Atom/JSON feed paths already do.
export function snippet(text, n = 240) {
  if (!text) return null;
  const s = excerptPlain(text, n);
  return s || null;
}

// opts: { termGroups?: string[][], section?, agency?, category?, noticeType?,
//         minAmount?, maxAmount?, excludeSpecialCase?, excludeRollingDeadlines?,
//         openOnly?, dueBefore?, sinceDate?, limit?, today?,
//         orderBy?: "start_date" | "contract_amount" | "score" }
// termGroups is AND-of-ORs: every group must match via at least one of its terms.
//
// orderBy default for amount filters used to be contract_amount DESC. That is fine for
// interactive "biggest awards" browse, but fatal for digests: a $637k Construction
// award never enters LIMIT 25 under multi-billion mega-contracts, so the D1 fast path
// silently stopped matching mid-size watches (field case Jul 2026). Digests pass
// orderBy: "start_date" to match the SODA fallback ($order=start_date DESC).
function buildStructuredFilters(opts = {}, alias = "") {
  const where = [];
  const params = [];
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const col = (name) => `${alias}${name}`;

  if (opts.section) { where.push(`${col("section")} = ?`); params.push(opts.section); }
  if (opts.agency) { where.push(`lower(${col("agency")}) LIKE ?`); params.push("%" + String(opts.agency).toLowerCase() + "%"); }
  if (opts.category) { where.push(`${col("category")} = ?`); params.push(opts.category); }
  if (opts.noticeType) { where.push(`${col("type_of_notice")} = ?`); params.push(opts.noticeType); }

  const hasAmount = opts.minAmount != null || opts.maxAmount != null;
  if (hasAmount) {
    where.push(`${col("contract_amount_valid")} = 1`); // corrupt amounts never match money filters
    if (opts.minAmount != null) { where.push(`${col("contract_amount")} >= ?`); params.push(opts.minAmount); }
    if (opts.maxAmount != null) { where.push(`${col("contract_amount")} <= ?`); params.push(opts.maxAmount); }
  }
  if (opts.excludeSpecialCase) where.push(`${col("special_case_reason")} IS NULL`);
  if (opts.excludeRollingDeadlines) { where.push(`${col("due_year")} IS NOT NULL AND ${col("due_year")} < ?`); params.push(ROLLING_YEAR); }
  if (opts.openOnly) { where.push(`${col("due_date")} >= ?`); params.push(today); }
  if (opts.dueBefore) { where.push(`${col("due_date")} <= ?`); params.push(opts.dueBefore); }
  if (opts.sinceDate) { where.push(`${col("start_date")} >= ?`); params.push(opts.sinceDate); }
  return { where, params, hasAmount };
}

export function buildNoticesQuery(opts = {}) {
  const { where, params, hasAmount } = buildStructuredFilters(opts);

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
  const explicit = opts.orderBy;
  if (explicit === "start_date") orderBy = "start_date DESC";
  else if (explicit === "contract_amount") orderBy = "contract_amount DESC, start_date DESC";
  else if (explicit === "score" && allTerms.length) orderBy = "_score DESC, start_date DESC";
  else if (hasAmount) orderBy = "contract_amount DESC, start_date DESC";
  else if (allTerms.length) orderBy = "_score DESC, start_date DESC";
  else orderBy = "start_date DESC";

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 100));
  const sql = `SELECT *, (${scoreExpr}) AS _score FROM notices ${whereSql} ORDER BY ${orderBy} LIMIT ${limit}`;
  return { sql, params, terms: allTerms };
}

function lexicalTokens(value, { keepStopWords = false } = {}) {
  const found = String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,40}/g) || [];
  return found.filter((term) => keepStopWords || !FTS_STOP_WORDS.has(term));
}

/** Shared MCP/evaluation input bound; FTS normalization removes stop words afterward. */
export function noticeSearchTerms(value) {
  return String(value || "").toLowerCase().slice(0, 500).split(/\s+/).filter(Boolean).slice(0, 24);
}

function quoteFtsTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

/** Convert the existing AND-of-ORs term contract into a parameterized FTS5 MATCH expression. */
export function buildFtsMatch(termGroups = []) {
  const expressions = [];
  const terms = [];
  for (const group of termGroups) {
    const raw = [...new Set((group || []).flatMap((value) => lexicalTokens(value, { keepStopWords: true })))];
    let normalized = raw.filter((term) => !FTS_STOP_WORDS.has(term));
    // An all-stopword query should still be a real query, not an unbounded recent-notices read.
    if (!normalized.length) normalized = raw;
    normalized = [...new Set(normalized)];
    if (!normalized.length) continue;
    terms.push(...normalized);
    expressions.push(`(${normalized.map(quoteFtsTerm).join(" OR ")})`);
  }
  return { match: expressions.join(" AND "), terms: [...new Set(terms)] };
}

/** Ranked query for the first production route. All structured predicates precede rank/limit. */
export function buildRankedNoticesQuery(opts = {}) {
  const { match, terms } = buildFtsMatch(opts.termGroups || []);
  if (!match) return null;
  const { where, params } = buildStructuredFilters(opts, "n.");
  where.push("notices_fts MATCH ?");
  params.push(match);
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 100));
  const sql = `SELECT n.*, bm25(notices_fts) AS _score
    FROM notices_fts JOIN notices AS n ON n.rowid = notices_fts.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY _score ASC, n.start_date DESC, n.request_id ASC LIMIT ${limit}`;
  return { sql, params, terms };
}

export function isFtsUnavailable(error) {
  const message = String(error?.message || error || "");
  return FTS_UNAVAILABLE.some((pattern) => pattern.test(message));
}

// Row → display record, honest fields applied.
export function toRecord(r, attachmentMetadata = []) {
  const amt = r.contract_amount_valid ? r.contract_amount : null;
  const rolling = r.due_year != null && r.due_year >= ROLLING_YEAR;
  let docs = [];
  try { docs = r.document_urls ? JSON.parse(r.document_urls) : []; } catch { docs = []; }
  let structuredFacts = { identifiers: [], deadlines: [], parties: [] };
  try {
    if (r.structured_facts) structuredFacts = JSON.parse(r.structured_facts);
  } catch { /* malformed cache data degrades to no extracted facts */ }
  const eventLoc = [r.event_building, r.event_addr1, r.event_city, r.event_state, r.event_zip]
    .filter(Boolean)
    .join(" ");
  const attachments = mergeAttachments(r.request_id, docs, attachmentMetadata);
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
    n_documents: Math.max(r.n_documents || 0, attachments.length),
    documents: attachments.length ? attachments.map((item) => item.url) : docs.slice(0, 8),
    attachments,
    attachment_text: joinAttachmentTexts(attachments) || null,
    attachment_tables_text: joinAttachmentTablesText(attachments) || null,
    structured_facts: structuredFacts,
  };
}

/** Label search hits that matched via attachment text or tables. */
export function annotateSearchMatchProvenance(record, terms = []) {
  if (!record || !terms?.length) return record;
  const title = record.title || "";
  const description = record.snippet || "";
  const titleHit = terms.some((t) => title.toLowerCase().includes(String(t).toLowerCase()));
  if (titleHit) return { ...record, match_provenance: "title" };
  const descHit = terms.some((t) => String(description).toLowerCase().includes(String(t).toLowerCase()));
  if (descHit) return { ...record, match_provenance: "description" };
  const attachEv = matchAttachmentTextEvidence(record.attachment_text, terms);
  if (attachEv) {
    return {
      ...record,
      match_provenance: TEXT_PROVENANCE,
      match_evidence: attachEv,
    };
  }
  const tableEv = matchAttachmentTablesEvidence(record.attachment_tables_text, terms);
  if (tableEv) {
    return {
      ...record,
      match_provenance: TABLE_PROVENANCE,
      match_evidence: tableEv,
    };
  }
  // Haystack may still have matched printout/other_info or prior attachment markers.
  const haystackHint = String(record._haystack || "");
  if (haystackHint.includes(`[${TEXT_PROVENANCE}]`)
    && terms.some((t) => haystackHint.includes(String(t).toLowerCase()))) {
    return { ...record, match_provenance: TEXT_PROVENANCE };
  }
  if (haystackHint.includes(`[${TABLE_PROVENANCE}]`)
    && terms.some((t) => haystackHint.includes(String(t).toLowerCase()))) {
    return { ...record, match_provenance: TABLE_PROVENANCE };
  }
  return { ...record, match_provenance: "other" };
}

export async function searchNotices(db, opts = {}) {
  const ranked = (opts.orderBy == null || opts.orderBy === "score")
    ? buildRankedNoticesQuery(opts)
    : null;
  let query = ranked || buildNoticesQuery(opts);
  let retrievalMethod = ranked ? "fts5_bm25" : "legacy_like";
  let fallbackReason = null;
  const started = performance.now();
  let response;
  try {
    response = await db.prepare(query.sql).bind(...query.params).all();
  } catch (error) {
    if (!ranked || !isFtsUnavailable(error)) throw error;
    query = buildNoticesQuery(opts);
    retrievalMethod = "legacy_like_fallback";
    fallbackReason = "fts_index_unavailable";
    response = await db.prepare(query.sql).bind(...query.params).all();
  }
  const { results, meta } = response;
  const rows = results ?? [];
  const attachments = await loadAttachmentMetadata(db, rows.map((row) => row.request_id));
  return {
    terms_used: query.terms,
    total_matches: rows.length,
    retrieval: {
      method: retrievalMethod,
      fallback_reason: fallbackReason,
      duration_ms: Number((performance.now() - started).toFixed(3)),
      rows_read: Number.isFinite(meta?.rows_read) ? meta.rows_read : null,
      result_count: rows.length,
    },
    results: rows.map((row) => {
      const record = toRecord(row, attachments.get(String(row.request_id)) || []);
      // Carry haystack only for provenance annotation, never to public clients.
      record._haystack = row.haystack || "";
      const annotated = annotateSearchMatchProvenance(record, query.terms);
      delete annotated._haystack;
      return annotated;
    }),
  };
}
