// Organization key + consolidate — influence-graph research method port
// (org_key + consolidate). Conservative ER for lobbying client / vendor names.
// Precision over recall: discriminating-token guard refuses North/South, II/III, City/State.

import { vendorStem } from "../normalizers/vendor_stem.mjs";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const APOS = /['’]/g;
const NON_ALNUM = /[^A-Z0-9 ]/g;
const ORG_NOISE = /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LLC|LLP|LP|LTD|PLC|PC|THE)\b/gi;
const JUNK = new Set(["", "N/A", "NA", "NONE", "UNKNOWN", "VARIOUS", "TBD", "SAME"]);

const DISCRIM = new Set([
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "NORTH", "SOUTH", "EAST", "WEST", "CITY", "STATE", "COUNTY",
  "UPPER", "LOWER", "GREATER", "OLD", "NEW", "NATIONAL", "INTERNATIONAL",
]);

/** Hand-seeded aliases that neither string similarity nor initialism can bridge. */
export const ORG_ALIAS_SEED = Object.freeze([
  ["IBM", "INTERNATIONAL BUSINESS MACHINES"],
]);

/**
 * Canonical org match key (org_key). Null for junk.
 * Distinctive words kept so "ABC Services" ≠ "ABC Consulting".
 */
export function orgKey(name) {
  if (!name) return null;
  let s = clean(name).toUpperCase().replace(APOS, "");
  s = s.replace(NON_ALNUM, " ");
  s = s.replace(ORG_NOISE, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (JUNK.has(s) || JUNK.has(s.replace(/ /g, "")) || s.replace(/ /g, "").length < 2) {
    return null;
  }
  return s;
}

// vendorStem is already used product-wide; prefer it when it yields a non-empty stem,
// but keep orgKey parity with the researched influence-graph key for lobby clients.
export function orgKeyPreferringVendorStem(name) {
  const stem = vendorStem(name);
  if (stem && stem.length >= 2) return stem;
  return orgKey(name);
}

function sequenceRatio(a, b) {
  // difflib.SequenceMatcher-style ratio without importing an extra package.
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcs = dp[m][n];
  return (2 * lcs) / (m + n);
}

/**
 * Cluster org keys with alias / acronym / conservative fuzzy passes.
 * Returns { canon: Map<child, parent>, merges: Array<{merged, into_key, method}> }.
 *
 * @param {Iterable<string>} keys
 * @param {{ aliasSeed?: Array<[string,string]>, fuzzyMin?: number }} [opts]
 */
export function consolidateOrgKeys(keys, opts = {}) {
  const list = [...new Set([...keys].filter(Boolean))];
  const kset = new Set(list);
  const parent = new Map(list.map((k) => [k, k]));
  const method = new Map();
  const aliasSeed = opts.aliasSeed || ORG_ALIAS_SEED;
  const fuzzyMin = opts.fuzzyMin ?? 0.93;

  const find = (x) => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur);
      parent.set(cur, parent.get(p));
      cur = parent.get(cur);
    }
    return cur;
  };

  const union = (a, b, m) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(ra, rb);
    if (!method.has(a)) method.set(a, m);
  };

  for (const [a, b] of aliasSeed) {
    if (kset.has(a) && kset.has(b)) union(a, b, "alias");
  }

  const initMap = new Map();
  for (const k of list) {
    if (k.includes(" ")) {
      const init = k.split(" ").filter(Boolean).map((t) => t[0]).join("");
      if (!initMap.has(init)) initMap.set(init, []);
      initMap.get(init).push(k);
    }
  }
  for (const k of list) {
    if (!k.includes(" ") && k.length >= 2 && k.length <= 6) {
      const expansions = initMap.get(k) || [];
      if (expansions.length === 1) union(k, expansions[0], "acronym");
    }
  }

  const blocks = new Map();
  for (const k of list) {
    const tok = k.split(" ")[0];
    if (!blocks.has(tok)) blocks.set(tok, []);
    blocks.get(tok).push(k);
  }
  for (const [tok, ks] of blocks) {
    if (ks.length < 2 || tok.length < 3) continue;
    for (let i = 0; i < ks.length; i += 1) {
      for (let j = i + 1; j < ks.length; j += 1) {
        const a = ks[i];
        const b = ks[j];
        if (a.length < 8 || b.length < 8 || find(a) === find(b)) continue;
        if (sequenceRatio(a, b) < fuzzyMin) continue;
        const aTok = new Set(a.split(" "));
        const bTok = new Set(b.split(" "));
        const diff = [...aTok].filter((t) => !bTok.has(t))
          .concat([...bTok].filter((t) => !aTok.has(t)));
        if (diff.some((t) => DISCRIM.has(t) || /^\d+$/.test(t))) continue;
        union(a, b, "fuzzy");
      }
    }
  }

  const clusters = new Map();
  for (const k of list) {
    const root = find(k);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(k);
  }
  const canon = new Map();
  for (const members of clusters.values()) {
    const c = members.reduce((best, k) =>
      (k.length > best.length || (k.length === best.length && k < best) ? k : best));
    for (const m of members) canon.set(m, c);
  }
  const merges = list
    .filter((k) => canon.get(k) !== k)
    .map((k) => ({
      merged: k,
      into_key: canon.get(k),
      method: method.get(k) || "cluster",
    }));
  return { canon, merges };
}
