/**
 * T3 attachment-text embeddings — pure helpers (no I/O).
 *
 * Architecture: precomputed related-document edges (ADR
 * docs/adr/attachment-text-embeddings.md). Default embedder is a deterministic
 * hashed n-gram + token TF-IDF vector — local, no paid API, CI-safe.
 * Optional sentence-transformer path records a different method string but
 * materializes the same edge shape.
 */

export const ATTACHMENT_RELATED_SCHEMA = "cityscroll.attachment_related.v1";
export const EMBED_METHOD_HASHED = "hashed_ngram_tfidf_v0";
export const EMBED_DIM = 256;
export const DEFAULT_TOP_K = 5;
/** Product floor: keep only neighbors with substantive shared vocabulary. */
export const DEFAULT_MIN_SCORE = 0.22;
export const MAX_EMBED_CHARS = 12_000;
export const CHUNK_CHARS = 1_800;
export const CHUNK_OVERLAP = 200;

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "by", "with",
  "from", "at", "as", "is", "are", "was", "were", "be", "been", "this", "that",
  "these", "those", "it", "its", "will", "shall", "may", "must", "not", "no",
  "yes", "via", "per", "into", "over", "under", "than", "then", "also", "such",
  "any", "all", "each", "other", "more", "most", "some", "can", "could", "would",
  "should", "has", "have", "had", "do", "does", "did", "new", "york", "city",
  "notice", "public", "please", "see", "http", "https", "www", "com", "org",
]);

function clampText(value, max = MAX_EMBED_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max);
}

/** Word tokens + character n-grams (3–4) for partial morphology. */
export function tokenizeForEmbed(text) {
  const clean = clampText(text).toLowerCase();
  if (!clean) return [];
  const lexemes = [];
  const words = clean.match(/[a-z0-9][a-z0-9'/-]{1,40}/g) || [];
  for (const raw of words) {
    const w = raw.replace(/^['/-]+|['/-]+$/g, "");
    if (w.length < 2 || STOP.has(w)) continue;
    if (/^\d{1,4}$/.test(w)) continue; // bare years / tiny numbers
    lexemes.push(w);
    // Light stemming-ish: drop trailing common suffixes for civic jargon overlap
    if (w.length > 5 && /ings?$|tion$|ments?$|able$|ed$|ly$/.test(w)) {
      lexemes.push(w.replace(/(ings?|tion|ments?|able|ed|ly)$/, ""));
    }
  }
  // Character 3–4 grams on alnum compression (catches partial matches)
  const compact = clean.replace(/[^a-z0-9]+/g, " ");
  for (const word of compact.split(" ")) {
    if (word.length < 4) continue;
    for (let n = 3; n <= 4; n++) {
      for (let i = 0; i + n <= word.length; i++) {
        lexemes.push(`#${word.slice(i, i + n)}`);
      }
    }
  }
  return lexemes;
}

/** FNV-1a style hash → [0, EMBED_DIM) with sign bit. */
function hashToken(token, dim = EMBED_DIM) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = (h >>> 0) % dim;
  const sign = (h & 0x80000000) === 0 ? 1 : -1;
  return { idx, sign };
}

/**
 * Build a document vector. Optional idf map upgrades bag-of-hashes toward TF-IDF.
 * Returns Float64Array length EMBED_DIM, L2-normalized (or zero vector).
 */
export function embedText(text, { idf = null, dim = EMBED_DIM } = {}) {
  const vec = new Float64Array(dim);
  const lexemes = tokenizeForEmbed(text);
  if (!lexemes.length) return vec;
  const tf = new Map();
  for (const t of lexemes) tf.set(t, (tf.get(t) || 0) + 1);
  const maxTf = Math.max(...tf.values());
  for (const [token, count] of tf) {
    const { idx, sign } = hashToken(token, dim);
    const tfw = 0.5 + 0.5 * (count / maxTf);
    const idfw = idf && idf.has(token) ? idf.get(token) : 1;
    vec[idx] += sign * tfw * idfw;
  }
  return l2Normalize(vec);
}

export function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm < 1e-12) return vec;
  const out = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Vectors are L2-normalized; clamp numeric noise.
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}

/** Mean-pool overlapping chunks so long extracts don't drown early terms. */
export function embedDocument(text, options = {}) {
  const clean = clampText(text);
  if (!clean) return new Float64Array(options.dim || EMBED_DIM);
  if (clean.length <= CHUNK_CHARS) return embedText(clean, options);
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + CHUNK_CHARS);
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  const dim = options.dim || EMBED_DIM;
  const acc = new Float64Array(dim);
  for (const chunk of chunks) {
    const v = embedText(chunk, options);
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= chunks.length;
  return l2Normalize(acc);
}

/** Corpus-level IDF from tokenized documents. */
export function buildIdf(documents = []) {
  const df = new Map();
  let n = 0;
  for (const doc of documents) {
    const text = typeof doc === "string" ? doc : doc?.text || "";
    const lexemes = new Set(tokenizeForEmbed(text));
    if (!lexemes.size) continue;
    n += 1;
    for (const t of lexemes) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  if (n < 1) return idf;
  for (const [t, d] of df) {
    idf.set(t, Math.log(1 + n / (1 + d)) + 1);
  }
  return idf;
}

/**
 * One corpus row for embedding.
 * @typedef {{ id: string, text: string, title?: string, section?: string, role?: 'source'|'target'|'both' }} EmbedDoc
 */

/**
 * Nearest neighbors for each source document among targets.
 * Sources are documents with role source|both (attachment-bearing).
 * Targets are all documents (attachment text and/or notice body).
 */
export function nearestNeighbors(docs = [], {
  topK = DEFAULT_TOP_K,
  minScore = DEFAULT_MIN_SCORE,
  idf = null,
} = {}) {
  const list = (Array.isArray(docs) ? docs : [])
    .map((d) => ({
      id: String(d.id || d.request_id || ""),
      text: String(d.text || ""),
      title: d.title || null,
      section: d.section || null,
      role: d.role || "both",
    }))
    .filter((d) => d.id && d.text);

  const idfMap = idf || buildIdf(list);
  const vectors = list.map((d) => ({
    ...d,
    vec: embedDocument(d.text, { idf: idfMap }),
  }));

  const sources = vectors.filter((d) => d.role === "source" || d.role === "both");
  const targets = vectors;
  const byId = {};

  for (const src of sources) {
    const scored = [];
    for (const tgt of targets) {
      if (tgt.id === src.id) continue;
      const score = cosineSimilarity(src.vec, tgt.vec);
      if (score < minScore) continue;
      scored.push({
        request_id: tgt.id,
        score: Number(score.toFixed(4)),
        title: tgt.title,
        section: tgt.section,
        basis: "attachment_text_similarity",
        method: EMBED_METHOD_HASHED,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.request_id.localeCompare(b.request_id));
    byId[src.id] = scored.slice(0, topK);
  }
  return { by_notice: byId, idf_terms: idfMap.size, method: EMBED_METHOD_HASHED, dim: EMBED_DIM };
}

/**
 * Materialize product artifact shape from NN result + provenance meta.
 */
export function buildRelatedArtifact(nn, {
  builtAt = new Date().toISOString(),
  sourceCount = 0,
  targetCount = 0,
  golden = null,
} = {}) {
  const byNotice = {};
  for (const [id, related] of Object.entries(nn.by_notice || {})) {
    if (!related?.length) continue;
    byNotice[id] = {
      related: related.map((r) => ({
        request_id: r.request_id,
        score: r.score,
        title: r.title || null,
        section: r.section || null,
        basis: r.basis || "attachment_text_similarity",
      })),
    };
  }
  const edgeCount = Object.values(byNotice).reduce((n, row) => n + (row.related?.length || 0), 0);
  const sourcesWithEdges = Object.keys(byNotice).length;
  return {
    schema: ATTACHMENT_RELATED_SCHEMA,
    architecture: "precomputed_related_edges",
    method: nn.method || EMBED_METHOD_HASHED,
    dim: nn.dim || EMBED_DIM,
    built_at: builtAt,
    top_k: DEFAULT_TOP_K,
    min_score: DEFAULT_MIN_SCORE,
    source_count: sourceCount,
    target_count: targetCount,
    notices_with_edges: sourcesWithEdges,
    edge_count: edgeCount,
    attachment_related_edge_rate: sourceCount
      ? Number((sourcesWithEdges / sourceCount).toFixed(4))
      : 0,
    by_notice: byNotice,
    golden: golden || null,
    later_tiers: null,
  };
}

/**
 * Keyword hit helper for the golden comparison: does a simple term search over
 * title+text find the target id? Used to prove embedding edges catch neighbors
 * keyword search misses.
 */
export function keywordFindsTarget(queryTerms, targetText) {
  const hay = String(targetText || "").toLowerCase();
  if (!hay) return false;
  const terms = (Array.isArray(queryTerms) ? queryTerms : [queryTerms])
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) return false;
  return terms.every((t) => hay.includes(t));
}

/** Public edge list for one notice (empty when unknown). */
export function relatedForNotice(artifact, requestId, { limit = DEFAULT_TOP_K } = {}) {
  const row = artifact?.by_notice?.[String(requestId)];
  if (!row?.related?.length) return [];
  return row.related.slice(0, limit);
}

/** Render-safe HTML list fragment builder is left to the site module. */
export function publicRelatedPayload(artifact, requestId) {
  const related = relatedForNotice(artifact, requestId);
  if (!related.length) return null;
  return {
    schema: ATTACHMENT_RELATED_SCHEMA,
    request_id: String(requestId),
    method: artifact.method || EMBED_METHOD_HASHED,
    architecture: artifact.architecture || "precomputed_related_edges",
    related,
  };
}
