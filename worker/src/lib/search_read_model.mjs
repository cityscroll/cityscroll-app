import { matchKeywordDocument, searchKeywordDocuments } from "../../../site/keyword_matcher.mjs";

const FAMILY_LIMIT = 20_000;

function ftsToken(value) {
  const token = String(value || "").replace(/[^\p{L}\p{N}_-]/gu, "");
  return token ? `"${token.replaceAll('"', '""')}"` : null;
}

function pluralVariants(token) {
  const value = String(token || "");
  const variants = [value];
  if (value.length > 3 && !/(ss|us|is)$/.test(value)) {
    variants.push(value.endsWith("s") ? value.slice(0, -1) : `${value}s`);
  }
  return [...new Set(variants)];
}

function ftsQuery(resolved) {
  const groups = resolved?.retrieval_groups?.length
    ? resolved.retrieval_groups
    : (resolved?.canonical_tokens || []).map((token) => [token]);
  const clauses = groups.map((group) => {
    const variants = group.flatMap(pluralVariants).map(ftsToken).filter(Boolean);
    return variants.length > 1 ? `(${variants.join(" OR ")})` : variants[0];
  }).filter(Boolean);
  return clauses.join(" AND ");
}

function parseDocument(row) {
  try {
    return JSON.parse(row.document_json);
  } catch {
    return null;
  }
}

async function familyMeta(db, familyId) {
  const row = await db.prepare(
    "SELECT source, as_of, source_row_count, indexed_count, coverage_json FROM keyword_search_families WHERE family_id = ?",
  ).bind(familyId).first();
  if (!row) return null;
  let coverage = [];
  try { coverage = JSON.parse(row.coverage_json || "[]"); } catch { coverage = []; }
  return {
    source: row.source || null,
    as_of: row.as_of || null,
    source_row_count: Number(row.source_row_count) || 0,
    indexed_count: Number(row.indexed_count) || 0,
    coverage,
    documents: [],
  };
}

/**
 * Query FTS candidates, then run the canonical exact-token matcher over only
 * those rows. A D1 error is intentionally thrown so callers can publish the
 * existing unknown state instead of falling back to a corpus import.
 */
export async function searchKeywordFamilyFromD1(db, familyId, resolved, { limit = FAMILY_LIMIT } = {}) {
  if (!db) throw new Error("keyword read model unavailable");
  const family = await familyMeta(db, familyId);
  if (!family) return { family: null, matches: [] };
  const query = ftsQuery(resolved);
  if (!query) return { family, matches: [] };
  const candidateLimit = Math.min(FAMILY_LIMIT, Math.max(Number(limit) || FAMILY_LIMIT, 1));
  const result = await db.prepare(`
    SELECT d.document_json
    FROM keyword_search_fts f
    JOIN keyword_search_documents d ON d.document_id = f.document_id
    WHERE f.family_id = ? AND keyword_search_fts MATCH ?
    ORDER BY d.ordinal
    LIMIT ?
  `).bind(familyId, query, candidateLimit).all();
  const documents = (result?.results || []).map(parseDocument).filter(Boolean);
  const matches = searchKeywordDocuments(documents, resolved, { limit: candidateLimit });
  return { family, matches };
}

export async function exactKeywordDocumentFromD1(db, familyId, objectRef, sourceRef) {
  if (!db) return null;
  const result = await db.prepare(
    "SELECT document_json, source_observation_refs_json FROM keyword_search_documents WHERE family_id = ? AND object_ref = ?",
  ).bind(familyId, objectRef).all();
  for (const row of result?.results || []) {
    let refs = [];
    try { refs = JSON.parse(row.source_observation_refs_json || "[]"); } catch { refs = []; }
    if (!refs.includes(sourceRef)) continue;
    try { return JSON.parse(row.document_json); } catch { return null; }
  }
  return null;
}

export function keywordDocumentMatches(document, resolved) {
  return matchKeywordDocument(document, resolved);
}
