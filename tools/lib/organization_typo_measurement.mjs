// Deterministic close-spelling measurement. 200 real organization stems are drawn from the index with
// a seeded PRNG; each gets three one-letter misspellings (deletion, adjacent transposition,
// substitution), applied to a letter of the stem (the normalized name a person types without the
// legal ending). Every misspelling is searched and scored.

import { searchOrganizations } from "../../site/organization_search.mjs";

export const TYPO_SEED = 20261113;
export const TYPO_SAMPLE = 200;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Eligible stems: at least 6 letters, letters/digits/spaces only. Sampled without replacement. */
export function sampleStems(stems, n = TYPO_SAMPLE, seed = TYPO_SEED) {
  const pool = stems.filter((s) => /^[A-Z0-9 ]+$/.test(s) && (s.match(/[A-Z]/g) || []).length >= 6);
  const rnd = mulberry32(seed);
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n).sort();
}

export function misspellings(stem, rnd) {
  const letters = [...stem].map((c, i) => (/[A-Z]/.test(c) ? i : -1)).filter((i) => i >= 0);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  const d = pick(letters);
  out.push({ kind: "deletion", query: stem.slice(0, d) + stem.slice(d + 1) });
  const pairs = letters.filter((i) => /[A-Z]/.test(stem[i + 1] || "") && stem[i] !== stem[i + 1]);
  if (pairs.length) { const t = pick(pairs); out.push({ kind: "transposition", query: stem.slice(0, t) + stem[t + 1] + stem[t] + stem.slice(t + 2) }); }
  const s = pick(letters);
  const others = LETTERS.split("").filter((c) => c !== stem[s]);
  out.push({ kind: "substitution", query: stem.slice(0, s) + pick(others) + stem.slice(s + 1) });
  return out;
}

export async function measureTypos(opened, { n = TYPO_SAMPLE, seed = TYPO_SEED } = {}) {
  const stems = sampleStems(opened.index.stems, n, seed);
  const rnd = mulberry32(seed + 1);
  const all = new Set(opened.index.stems);
  const rows = [];
  for (const stem of stems) {
    for (const v of misspellings(stem, rnd)) {
      const r = await searchOrganizations(opened, v.query, { limit: 5 });
      const ranks = (r.results || []).map((x) => x.stem);
      const pos = ranks.indexOf(stem);
      rows.push({ stem, kind: v.kind, query: v.query, status: r.status, rank: pos >= 0 ? pos + 1 : null, first: ranks[0] ?? null, first_reason: r.results?.[0]?.match_reason ?? null, query_is_another_real_stem: all.has(v.query) && v.query !== stem });
    }
  }
  const summarize = (rs) => ({
    queries: rs.length,
    recall_at_5: rs.filter((x) => x.rank !== null).length / rs.length,
    found_first: rs.filter((x) => x.rank === 1).length / rs.length,
    wrong_first: rs.filter((x) => x.first !== null && x.first !== x.stem).length / rs.length,
    no_result: rs.filter((x) => x.first === null).length / rs.length,
  });
  const byKind = {};
  for (const k of ["deletion", "transposition", "substitution"]) byKind[k] = summarize(rows.filter((x) => x.kind === k));
  const wrong = rows.filter((x) => x.first !== null && x.first !== x.stem);
  return {
    seed, sample: stems.length, ...summarize(rows), by_kind: byKind,
    wrong_first_breakdown: {
      query_is_another_real_stem: wrong.filter((x) => x.query_is_another_real_stem).length,
      by_first_reason: wrong.reduce((m, x) => { m[x.first_reason] = (m[x.first_reason] || 0) + 1; return m; }, {}),
    },
    misses: rows.filter((x) => x.rank === null).slice(0, 25),
    wrong_first_examples: wrong.slice(0, 25),
  };
}
