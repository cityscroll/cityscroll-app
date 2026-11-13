// Organization search over the static organization index. Pure: the caller injects
// `readFile(path) -> Promise<object>` (parsed JSON of a published file under site/). In the engine
// the Worker passes a fetch of https://cityscroll.org/<path> with an isolate cache; tests pass the
// file system.
//
// Results are candidates. One result is one vendor stem with its sources listed side by side; the
// only link labels are same_normalized_name and same_normalized_name_and_zip. Nothing here says two
// sources are the same organization.

import { vendorStem } from "./vendor_stem.mjs";
import {
  SOURCES, SOURCE_BY_ID, INDEX_SCHEMA, ENTRY_SHARD_SCHEMA, ID_SHARD_SCHEMA, STEMS_SCHEMA, MANIFEST_PATH,
  IDENTIFIER_KINDS, decodeEntry, keyBucket, stemTokens,
} from "./organization_index_contract.mjs";

export const RESPONSE_SCHEMA = "cityscroll.organization_search_response.v1";
export const MATCH_REASONS = Object.freeze(["identifier", "exact_name", "dba", "prefix", "tokens", "close_spelling", "facet"]);
export const LINK_LABELS = Object.freeze(["same_normalized_name", "same_normalized_name_and_zip"]);
export const STATUSES = Object.freeze(["matched", "no_match", "query_refused", "not_indexed", "provider_unavailable"]);
export const LIMITS = Object.freeze({
  min_alnum_chars: 3,
  max_query_length: 200,
  default_results: 10,
  max_results: 25,
  max_prefix_candidates: 2000,
  close_spelling_min_alnum: 4,
  close_spelling_token_min_length: 4,
  close_spelling_max_candidates: 5000,
  max_facet_results: 25,
  shard_cache_entries: 32,
});
/** Reader-visible English strings. The engine moves these to site/i18n.js keys. */
export const READER_STRINGS = Object.freeze({
  match_reason: {
    identifier: "Matched the identifier you entered",
    exact_name: "Same name",
    dba: "Matched a name the business uses (doing business as)",
    prefix: "Name starts with what you typed",
    tokens: "Has every word you typed",
    close_spelling: "Close spelling",
    facet: "Matches the filters you chose",
  },
  link_label: {
    same_normalized_name: "Same name in both lists",
    same_normalized_name_and_zip: "Same name and ZIP code in both lists",
  },
  identity_note: "These lists are shown together because the names match after removing punctuation and endings like Inc or LLC. CityScroll has not confirmed they are the same organization.",
  several_sbs_accounts: "The SBS list has more than one business under this name.",
  status: {
    no_match: "No organization with that name is in the lists CityScroll reads.",
    query_refused: "Type at least three letters or numbers.",
    not_indexed: "Organization search is not available right now. Try again later.",
    provider_unavailable: "That source did not answer just now. Try again later.",
  },
  refusal: {
    input_not_text: "Type a name or an identifier.",
    input_too_long: "That is too long. Use 200 characters or fewer.",
    input_too_short: "Type at least three letters or numbers.",
    input_has_no_letters_or_digits: "Type letters or numbers. Wildcards like * are not needed.",
    unknown_identifier_kind: "Use sbs:, ein: or dos: before an identifier.",
    invalid_identifier: "That identifier is not in the published format.",
    no_criteria: "Choose at least one filter or type a name.",
    unknown_criterion: "That filter is not available.",
    invalid_limit: "Ask for between 1 and 25 results.",
  },
});

const refuse = (reason, detail = null) => ({ schema: RESPONSE_SCHEMA, ok: false, status: "query_refused", reason, detail, message: READER_STRINGS.refusal[reason] || READER_STRINGS.status.query_refused, results: [] });
const notIndexed = (reason, detail = null) => ({ schema: RESPONSE_SCHEMA, ok: false, status: "not_indexed", reason, detail, message: READER_STRINGS.status.not_indexed, results: [] });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions), bounded. */
export function osaDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length; const m = b.length;
  let p2 = new Array(m + 1).fill(0); let p1 = Array.from({ length: m + 1 }, (_, j) => j); let cur = new Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i; let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [p2, p1, cur] = [p1, cur, p2];
  }
  return p1[m];
}
/** Padded character-trigram Jaccard similarity (pg_trgm style), used to order close spellings. */
export function trigramSimilarity(a, b) {
  const grams = (s) => { const t = `  ${s} `; const g = new Set(); for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3)); return g; };
  const A = grams(a); const B = grams(b);
  let inter = 0; for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Upper-case and punctuation folding of vendorStem without stripping legal suffixes (prefix text). */
export function normalizedText(name) {
  return String(name || "").replace(/<[^>]*>/g, " ").toUpperCase().replace(/[.,'’&]/g, " ").replace(/\s+/g, " ").trim();
}
const WILDCARDS = /[*%?_]/g;
const alnumCount = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;
const popcount = (m) => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };

/**
 * Open the index from its manifest and stems file. Returns {status:"ok", index} or a not_indexed
 * response. Builds the in-memory token postings and vocabulary (per isolate, once).
 */
export async function openOrganizationIndex(readFile) {
  let manifest; let stemsDoc;
  try { manifest = await readFile(MANIFEST_PATH); } catch (e) { return notIndexed("manifest_unavailable", String(e?.message || e)); }
  if (!manifest || manifest.schema !== INDEX_SCHEMA) return notIndexed("manifest_schema", manifest?.schema ?? null);
  if (!manifest.stems?.path || !Array.isArray(manifest.entry_shards) || !Array.isArray(manifest.id_shards)) return notIndexed("manifest_incomplete");
  try { stemsDoc = await readFile(manifest.stems.path); } catch (e) { return notIndexed("stems_unavailable", String(e?.message || e)); }
  if (!stemsDoc || stemsDoc.schema !== STEMS_SCHEMA) return notIndexed("stems_schema");
  if (stemsDoc.generation !== manifest.generation) return notIndexed("generation_mismatch", `stems ${stemsDoc.generation} != manifest ${manifest.generation}`);
  if (!Array.isArray(stemsDoc.stems) || stemsDoc.stems.length !== manifest.entry_count) return notIndexed("stems_count");
  const stems = new Array(stemsDoc.stems.length); const masks = new Uint32Array(stemsDoc.stems.length);
  const nameWithheld = new Uint8Array(stemsDoc.stems.length);
  const postings = new Map();
  for (let i = 0; i < stemsDoc.stems.length; i++) {
    const [s, m, withheld] = stemsDoc.stems[i];
    if (i > 0 && !(s > stems[i - 1])) return notIndexed("stems_order", s);
    stems[i] = s; masks[i] = m; nameWithheld[i] = withheld ? 1 : 0;
    if (withheld) continue;
    for (const t of new Set(stemTokens(s))) {
      let p = postings.get(t); if (!p) { p = []; postings.set(t, p); } p.push(i);
    }
  }
  for (const [t, p] of postings) postings.set(t, Int32Array.from(p));
  const index = { manifest, stems, masks, nameWithheld, postings, blocks: null, readFile, shardCache: new Map() };
  vocabularyBlocks(index);
  return { status: "ok", index };
}

/** Ordinal of an exact stem, or -1. */
export function ordinalForStem(index, stem) { const o = lowerBound(index.stems, stem); return index.stems[o] === stem ? o : -1; }

function lowerBound(arr, x) { let lo = 0; let hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; }

async function loadShard(index, path, schema) {
  if (index.shardCache.has(path)) return index.shardCache.get(path);
  let doc;
  try { doc = await index.readFile(path); } catch (e) { return { error: "shard_unavailable", detail: `${path}: ${e?.message || e}` }; }
  if (!doc || doc.schema !== schema) return { error: "shard_schema", detail: path };
  if (doc.generation !== index.manifest.generation) return { error: "generation_mismatch", detail: `${path} ${doc.generation} != ${index.manifest.generation}` };
  index.shardCache.set(path, doc);
  // bounded per isolate: at most LIMITS.shard_cache_entries shards (each <= 256 KiB raw) stay parsed
  while (index.shardCache.size > LIMITS.shard_cache_entries) index.shardCache.delete(index.shardCache.keys().next().value);
  return doc;
}

/** Load decoded entries for ordinals. -> {entries: Map(ordinal -> entry)} | {error, detail} */
export async function entriesFor(index, ordinals) {
  const out = new Map();
  for (const o of ordinals) {
    const sh = index.manifest.entry_shards.find((s) => o >= s.first_ordinal && o < s.first_ordinal + s.entries);
    if (!sh) return { error: "ordinal_outside_shards", detail: String(o) };
    const doc = await loadShard(index, sh.path, ENTRY_SHARD_SCHEMA);
    if (doc.error) return doc;
    const raw = doc.entries[o - doc.first_ordinal];
    if (!raw || raw.s !== index.stems[o]) return { error: "entry_stem_mismatch", detail: String(o) };
    out.set(o, decodeEntry(raw, o));
  }
  return { entries: out };
}

/** Identifier -> ordinals through the id shards. kind in sbs|ein|dol|sca. */
export async function ordinalsForIdentifier(index, kind, id) {
  const key = `${kind}:${id}`;
  const b = keyBucket(key, index.manifest.limits.id_buckets);
  const sh = index.manifest.id_shards.find((s) => s.bucket === b);
  if (!sh) return { error: "id_bucket_missing", detail: b };
  const doc = await loadShard(index, sh.path, ID_SHARD_SCHEMA);
  if (doc.error) return doc;
  return { ordinals: doc.ids[key] || [] };
}

/**
 * Parse an identifier query. Accepted: sbs:<digits>, ein:<9 digits or NN-NNNNNNN>, dos:<digits>,
 * dol:<certificate>, sca:<firm name as listed>; a bare all-digit string is tried as an SBS account
 * number and, when it has 9 digits (or NN-NNNNNNN), as an EIN.
 */
export function parseIdentifier(q) {
  const m = /^(sbs|ein|dos|dol|sca)\s*:\s*(.+)$/i.exec(q);
  if (m) {
    const kind = m[1].toLowerCase(); let id = m[2].trim();
    if (kind === "sbs" && !/^\d{1,9}$/.test(id)) return { error: "invalid_identifier" };
    if (kind === "ein") { id = id.replace(/-/g, ""); if (!/^\d{9}$/.test(id)) return { error: "invalid_identifier" }; }
    if (kind === "dos" && !/^\d{1,12}$/.test(id)) return { error: "invalid_identifier" };
    if (kind === "sca") id = id.toUpperCase();
    return { lookups: [{ kind, id }], explicit: true };
  }
  if (/^[a-z]{2,6}\s*:/i.test(q)) return { error: "unknown_identifier_kind" };
  const digits = q.replace(/-/g, "");
  if (/^\d+$/.test(q) || /^\d{2}-\d{7}$/.test(q)) {
    const lookups = [];
    if (/^\d{1,9}$/.test(q)) lookups.push({ kind: "sbs", id: q });
    if (/^\d{9}$/.test(digits)) lookups.push({ kind: "ein", id: digits });
    return { lookups, explicit: false };
  }
  return null;
}

/**
 * Vocabulary blocking for close spelling, built once per open index. A single edit leaves either the
 * first three or the last three characters of a token unchanged when both tokens have at least 7
 * characters, and leaves either the first or the last character unchanged for any token of three or
 * more characters; short tokens (4 to 7) are therefore blocked by (length, first character) and
 * (length, last character).
 */
function vocabularyBlocks(index) {
  if (index.blocks) return index.blocks;
  const pre = new Map(); const suf = new Map(); const short = new Map();
  const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const t of index.postings.keys()) {
    if (t.length < LIMITS.close_spelling_token_min_length) continue;
    if (t.length <= 7) { push(short, `F${t.length}:${t[0]}`, t); push(short, `L${t.length}:${t.at(-1)}`, t); }
    push(pre, t.slice(0, 3), t); push(suf, t.slice(-3), t);
  }
  index.blocks = { pre, suf, short };
  return index.blocks;
}
/** Vocabulary tokens within one edit (OSA: insertion, deletion, substitution, adjacent transposition). */
function nearTokens(index, t) {
  const out = new Set();
  if (index.postings.has(t)) out.add(t);
  if (t.length < LIMITS.close_spelling_token_min_length - 1) return [...out];
  const { pre, suf, short } = vocabularyBlocks(index);
  const consider = (v) => { if (!out.has(v) && Math.abs(v.length - t.length) <= 1 && osaDistance(t, v, 1) <= 1) out.add(v); };
  for (const v of pre.get(t.slice(0, 3)) || []) consider(v);
  for (const v of suf.get(t.slice(-3)) || []) consider(v);
  if (t.length <= 7) {
    for (let l = Math.max(LIMITS.close_spelling_token_min_length, t.length - 1); l <= Math.min(7, t.length + 1); l++) {
      for (const v of short.get(`F${l}:${t[0]}`) || []) consider(v);
      for (const v of short.get(`L${l}:${t.at(-1)}`) || []) consider(v);
    }
  }
  return [...out];
}
function intersectAll(lists) {
  if (!lists.length) return [];
  lists.sort((a, b) => a.length - b.length);
  let acc = new Set(lists[0]);
  for (let i = 1; i < lists.length && acc.size; i++) { const s = new Set(lists[i]); acc = new Set([...acc].filter((x) => s.has(x))); }
  return [...acc];
}
const maxEdits = (len) => (len <= 10 ? 1 : 2);

/** Name matching only (no entry loads). -> [{ordinal, reason, score:[...]}] */
export function matchName(index, q, { limit = LIMITS.default_results } = {}) {
  const clean = q.replace(WILDCARDS, " ").replace(/\s+/g, " ").trim();
  const stem = vendorStem(clean);
  const prefixText = normalizedText(clean);
  const tokens = [...new Set(stemTokens(stem))];
  const hits = new Map();
  const named = (o) => !index.nameWithheld[o];
  const add = (o, reason, score) => { if (named(o) && !hits.has(o)) hits.set(o, { ordinal: o, reason, score }); };
  // exact (reason refined to dba after the entry is loaded). A withheld name is not a name match.
  const e = lowerBound(index.stems, stem);
  if (index.stems[e] === stem) add(e, "exact_name", [0]);
  // prefix: stems that begin with the typed text (legal endings not removed, so "ACME CO" is a prefix of "ACME CONSTRUCTION")
  let prefixTotal = 0; let prefixTruncated = false;
  for (const p of new Set([prefixText, stem])) {
    if (alnumCount(p) < LIMITS.min_alnum_chars) continue;
    let i = lowerBound(index.stems, p);
    while (i < index.stems.length && index.stems[i].startsWith(p)) {
      if (!index.nameWithheld[i] && !hits.has(i)) { prefixTotal += 1; if (prefixTotal > LIMITS.max_prefix_candidates) { prefixTruncated = true; break; } add(i, "prefix", [index.stems[i].length]); }
      i += 1;
    }
  }
  // all tokens in any order
  if (tokens.length && tokens.every((t) => index.postings.has(t))) {
    for (const o of intersectAll(tokens.map((t) => index.postings.get(t)))) add(o, "tokens", [index.stems[o].length]);
  }
  // close spelling: every typed token within one edit of a token of the stem, whole stem within maxEdits
  // close spelling fills the page only when the other methods found fewer than `limit` names
  let closeConsidered = 0;
  const closeRan = hits.size < limit && alnumCount(stem) >= LIMITS.close_spelling_min_alnum && tokens.length > 0;
  if (closeRan) {
    const lists = tokens.map((t) => {
      const u = new Set(); for (const v of nearTokens(index, t)) for (const o of index.postings.get(v)) u.add(o);
      return [...u];
    });
    const k = maxEdits(stem.length);
    const consider = (cands) => {
      const sorted = cands.sort((a, b) => a - b).slice(0, LIMITS.close_spelling_max_candidates);
      closeConsidered += sorted.length;
      let found = 0;
      for (const o of sorted) {
        if (hits.has(o)) continue;
        const d = osaDistance(stem, index.stems[o], k);
        if (d <= k) { add(o, "close_spelling", [d, -trigramSimilarity(stem, index.stems[o])]); found += 1; }
      }
      return found;
    };
    // Pass 1: every typed token within one edit of a stem token.
    const strict = lists.every((l) => l.length) ? consider(intersectAll(lists.map((l) => [...l]))) : 0;
    // Pass 2 (only if pass 1 found nothing): a misspelt short token (under 4 letters, or one that lost a
    // letter) can match no vocabulary token; leave out one token at a time and let the whole-stem
    // distance decide. Needs at least two typed tokens.
    if (!strict && tokens.length >= 2) {
      const u = new Set();
      for (let skip = 0; skip < tokens.length; skip++) {
        const rest = lists.filter((_, i) => i !== skip);
        if (rest.every((l) => l.length)) for (const o of intersectAll(rest.map((l) => [...l]))) u.add(o);
      }
      consider([...u]);
    }
  }
  return { stem, prefixText, tokens, hits: [...hits.values()], prefixTotal, prefixTruncated, closeRan, closeConsidered };
}

const REASON_ORDER = Object.fromEntries(MATCH_REASONS.map((r, i) => [r, i]));
/** Deterministic order: reason, reason score, number of sources (more first), stem. */
export function rankHits(index, hits) {
  return hits.sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason]
    || compareScores(a.score, b.score)
    || popcount(index.masks[b.ordinal]) - popcount(index.masks[a.ordinal])
    || cmp(index.stems[a.ordinal], index.stems[b.ordinal]));
}
function compareScores(a = [], b = []) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; }

/** Links between every pair of sources on one entry: name equality, upgraded only on a shared published ZIP. */
export function sourceLinks(entry) {
  const links = [];
  const ids = entry.source_ids;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = entry.sources[ids[i]]; const b = entry.sources[ids[j]];
    const shared = a.zips.filter((z) => b.zips.includes(z));
    const label = a.zips.length && b.zips.length && shared.length ? "same_normalized_name_and_zip" : "same_normalized_name";
    links.push({ between: [ids[i], ids[j]], via: [a.via, b.via], label, label_text: READER_STRINGS.link_label[label], ...(label === "same_normalized_name_and_zip" ? { shared_zips: shared } : {}) });
  }
  return links;
}

function explain(reason, entry, matched) {
  const base = READER_STRINGS.match_reason[reason];
  return matched ? `${base}: ${matched}` : base;
}

/** One reader-ready result row. Keys are a closed set (RESULT_KEYS). */
export function resultRow(index, hit, entry, q) {
  let reason = hit.reason;
  let matched = null;
  const upper = q.trim().toUpperCase();
  if (reason === "exact_name") {
    const formal = entry.names.filter((n) => n.via === "name");
    const dbaHit = entry.names.find((n) => n.via === "dba" && n.name.trim().toUpperCase() === upper);
    const formalHit = formal.find((n) => n.name.trim().toUpperCase() === upper);
    if (!formal.length || (dbaHit && !formalHit)) {
      const fallback = dbaHit || entry.names[0];
      if (fallback) { reason = "dba"; matched = fallback.name; }
    } else matched = (formalHit || formal[0]).name;
  } else if (reason === "identifier") matched = hit.matched;
  else matched = entry.display_name;
  const sources = entry.source_ids.map((id) => {
    const s = entry.sources[id]; const src = SOURCE_BY_ID[id];
    return {
      source: id, label: src.label, source_url: src.url, records: s.records, via: s.via,
      amount_total: s.amount_total, last_date: s.last_date, record_ids: s.refs, record_id_count: s.ref_count, zips: s.zips,
      ...(s.sbs_programmes ? { sbs_programmes: s.sbs_programmes } : {}),
      ...(s.mwbe_categories ? { checkbook_mwbe_categories: s.mwbe_categories } : {}),
      collected_at: index.manifest.sources.find((x) => x.id === id)?.receipt?.collected_at ?? null,
    };
  });
  return {
    entity_ref: `org:${entry.stem}`,
    stem: entry.stem,
    display_name: entry.display_name,
    match_reason: reason,
    match_reason_text: explain(reason, entry, matched),
    matched_text: matched,
    names: entry.names,
    sources,
    links: sourceLinks(entry),
    facets: entry.facets,
    several_sbs_accounts: (entry.ids.sbs || []).length > 1 ? entry.ids.sbs : null,
    identity_note: READER_STRINGS.identity_note,
    record_href: `/vendor-profile?ref=${encodeURIComponent(`org:${entry.stem}`)}`,
  };
}
export const RESULT_KEYS = Object.freeze(["entity_ref", "stem", "display_name", "match_reason", "match_reason_text", "matched_text", "names", "sources", "links", "facets", "several_sbs_accounts", "identity_note", "record_href"]);

/**
 * Search. opts = { limit, dosCommitted?: { byId, byStem } from the committed New York State vendor lookup }.
 * Statuses: matched | no_match | query_refused | not_indexed. The route is snapshot-only: it never calls
 * a publisher. provider_unavailable belongs to the on-demand state-register block (organization_record.mjs).
 */
export async function searchOrganizations(opened, query, opts = {}) {
  if (!opened || opened.status !== "ok") return opened?.status === "not_indexed" ? opened : notIndexed("index_not_open");
  const index = opened.index;
  if (typeof query !== "string") return refuse("input_not_text");
  const q = query.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length > LIMITS.max_query_length) return refuse("input_too_long");
  const limit = opts.limit === undefined ? LIMITS.default_results : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.max_results) return refuse("invalid_limit");
  if (!q) return refuse("input_too_short");
  if (alnumCount(q) === 0) return refuse("input_has_no_letters_or_digits");

  const hits = [];
  const id = parseIdentifier(q);
  let state = null;
  if (id?.error) return refuse(id.error);
  if (id) {
    for (const l of id.lookups) {
      if (l.kind === "dos") {
        // Snapshot only: the committed New York State lookup. A DOS id outside it is outside the
        // index, with the on-demand state route to ask.
        const ix = opts.dosCommitted;
        if (!ix) return notIndexed("committed_state_lookup_unavailable");
        const r = ix.byId.get(l.id) || [];
        if (!r.length) return { ...notIndexed("dos_id_outside_committed_state_lookup", l.id), on_demand: `/org-register/dos?dos_id=${encodeURIComponent(l.id)}` };
        state = { status: "committed", queried_at: r[0].queried_at };
        for (const rec of r) {
          const o = lowerBound(index.stems, rec.name_stem);
          if (index.stems[o] === rec.name_stem) hits.push({ ordinal: o, reason: "identifier", score: [0], matched: `dos:${l.id}` });
        }
        continue;
      }
      const r = await ordinalsForIdentifier(index, l.kind, l.id);
      if (r.error) return notIndexed(r.error, r.detail);
      for (const o of r.ordinals) hits.push({ ordinal: o, reason: "identifier", score: [0], matched: `${l.kind}:${l.id}` });
    }
  }
  let name = null;
  if (!id?.explicit) {
    const qstem = vendorStem(q.replace(WILDCARDS, " "));
    if (alnumCount(qstem) < LIMITS.min_alnum_chars && !hits.length) return refuse(alnumCount(q.replace(WILDCARDS, "")) === 0 ? "input_has_no_letters_or_digits" : "input_too_short");
    if (alnumCount(qstem) >= LIMITS.min_alnum_chars) {
      name = matchName(index, q, { limit: Math.max(0, limit - hits.length) || 1 });
      const seen = new Set(hits.map((h) => h.ordinal));
      for (const h of name.hits) if (!seen.has(h.ordinal)) hits.push(h);
    }
  }
  rankHits(index, hits);
  const page = hits.slice(0, limit);
  const loaded = await entriesFor(index, page.map((h) => h.ordinal));
  if (loaded.error) return notIndexed(loaded.error, loaded.detail);
  const results = page.map((h, i) => ({ rank: i + 1, ...resultRow(index, h, loaded.entries.get(h.ordinal), q) }));
  // exact-name hits refined to dba can change order between exact and dba: re-sort stably by reason
  results.sort((a, b) => REASON_ORDER[a.match_reason] - REASON_ORDER[b.match_reason] || a.rank - b.rank);
  results.forEach((r, i) => { r.rank = i + 1; });
  return {
    schema: RESPONSE_SCHEMA,
    ok: true,
    status: results.length ? "matched" : "no_match",
    ...(results.length ? {} : { message: READER_STRINGS.status.no_match }),
    query: { text: q, stem: name?.stem ?? null, prefix_text: name?.prefixText ?? null, tokens: name?.tokens ?? [], identifier: id?.lookups ?? null },
    index: { generation: index.manifest.generation, entry_count: index.manifest.entry_count, sources: index.manifest.sources.map((s) => ({ id: s.id, collected_at: s.receipt?.collected_at ?? null })) },
    limit,
    total: hits.length,
    truncated: Boolean(name?.prefixTruncated),
    close_spelling_ran: Boolean(name?.closeRan),
    ...(state ? { state_register: { status: state.status, queried_at: state.queried_at ?? null } } : {}),
    results,
  };
}

export const FACET_CRITERIA = Object.freeze(["programme", "naics6", "naics_sector", "nigp", "borough", "zip"]);
export const SBS_FACETS_SCHEMA = "cityscroll.sbs_certified_businesses.facets.v1";

/**
 * Accounts matching every criterion, read from the certified-business directory's published
 * facets.json (programme, naics6, naics_sector, nigp = City commodity code, borough, zip). The
 * validation and folding follow filterBusinesses; a test proves the same account set. Only account
 * numbers are read: no row shard is loaded for a facet query.
 */
export function facetAccounts(facetsDoc, criteria = {}) {
  if (!facetsDoc || facetsDoc.schema !== SBS_FACETS_SCHEMA || typeof facetsDoc.facets !== "object") return { error: "sbs_facets_unavailable" };
  const keys = Object.keys(criteria).filter((k) => criteria[k] !== undefined && criteria[k] !== null && criteria[k] !== "");
  if (!keys.length) return { refuse: "no_criteria" };
  if (keys.some((k) => !FACET_CRITERIA.includes(k))) return { refuse: "unknown_criterion" };
  let acc = null;
  for (const k of keys) {
    let v = String(criteria[k]).trim();
    if (k === "programme") v = v.toUpperCase();
    if (k === "zip") { if (!/^\d{3,5}$/.test(v)) return { refuse: "invalid_identifier", detail: "invalid_zip" }; v = v.padStart(5, "0"); }
    if (k === "naics6" && !/^\d{6}$/.test(v)) return { refuse: "invalid_identifier", detail: "invalid_naics6" };
    if (k === "nigp" && !/^\d+$/.test(v)) return { refuse: "invalid_identifier", detail: "invalid_nigp" };
    if (k === "naics_sector" || k === "borough") v = Object.keys(facetsDoc.facets[k] || {}).find((x) => x.toLowerCase() === v.toLowerCase()) ?? v;
    const list = facetsDoc.facets[k]?.[v] || [];
    const have = new Set(list);
    acc = acc === null ? [...list] : acc.filter((x) => have.has(x));
    if (!acc.length) break;
  }
  return { accounts: acc };
}

/** Facet search: SBS facets -> account numbers -> organization entries (match_reason facet), stem order. */
export async function searchByFacets(opened, facetsDoc, criteria, opts = {}) {
  if (!opened || opened.status !== "ok") return opened?.status === "not_indexed" ? opened : notIndexed("index_not_open");
  const index = opened.index;
  const limit = opts.limit === undefined ? LIMITS.default_results : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.max_facet_results) return refuse("invalid_limit");
  const f = facetAccounts(facetsDoc, criteria);
  if (f.error) return notIndexed(f.error);
  if (f.refuse) return refuse(f.refuse, f.detail ?? null);
  const ords = new Set();
  for (const a of f.accounts) {
    const x = await ordinalsForIdentifier(index, "sbs", a);
    if (x.error) return notIndexed(x.error, x.detail);
    for (const o of x.ordinals) ords.add(o);
  }
  const sorted = [...ords].sort((a, b) => a - b);
  const page = sorted.slice(0, limit);
  const loaded = await entriesFor(index, page);
  if (loaded.error) return notIndexed(loaded.error, loaded.detail);
  const results = page.map((o, i) => ({ rank: i + 1, ...resultRow(index, { ordinal: o, reason: "facet" }, loaded.entries.get(o), "") }));
  return { schema: RESPONSE_SCHEMA, ok: true, status: results.length ? "matched" : "no_match", ...(results.length ? {} : { message: READER_STRINGS.status.no_match }), query: { facets: criteria }, index: { generation: index.manifest.generation, entry_count: index.manifest.entry_count }, limit, total: sorted.length, accounts_matched: f.accounts.length, truncated: false, results };
}

export const ENTITY_REF_PATTERN = /^org:([^#]+)(?:#(sbs|ein|dos|dol|sca):([^#]+))?$/;
/** Parse and validate an entityRef: org:{stem} or org:{stem}#{kind}:{id}. The stem must be a vendorStem fixed point. */
export function parseEntityRef(ref) {
  const m = ENTITY_REF_PATTERN.exec(String(ref ?? ""));
  if (!m) return { ok: false, reason: "invalid_entity_ref" };
  const stem = m[1];
  // A withheld name is stored under its published account key (`sbs:` + digits), which is not a
  // vendor stem. Every other ref must already be a vendor stem.
  const accountKey = /^sbs:\d{1,9}$/.test(stem);
  if (!accountKey && (vendorStem(stem) !== stem || stem.length < 3)) return { ok: false, reason: "invalid_entity_ref_stem" };
  return { ok: true, stem, source_record: m[2] ? { kind: m[2], id: m[3] } : null };
}
export function entityRef(stem, kind = null, id = null) {
  return kind ? `org:${stem}#${kind}:${id}` : `org:${stem}`;
}
export { IDENTIFIER_KINDS, SOURCES };
