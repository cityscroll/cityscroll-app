// Pure: the PIN-widening / chain-honesty heuristics that decide whether a set of Money/
// Contracts notices has genuine prior-award history — mirrors index.html's client-side
// pinBase()/isBlanketChain()/usablePin() (the w12-04/w12-05/w12-10 paper-trail machinery) so
// the cron-time suggestion-enrichment pass (worker/src/suggest.mjs, w12-17) judges "lineage-
// rich" by the EXACT SAME rule a reader would see after clicking a chip, not a second
// independent guess. The worker and static site can't share an import across that boundary
// (see AGENTS.md's "dual-implemented" convention, used the same way for matchEvidence() and
// vendorStem()) — keep this file in sync BY HAND with index.html's copy if the PIN-widening or
// blanket-chain heuristic ever changes.
//
// This module only has the SUBSET of that machinery a candidate-level (not row-level) honesty
// judgment needs: no rendering, no per-row badge — see computeLineageSignal() below for what's
// new here.

const JUNK_PINS = new Set(["NOPINFOUND", "SEE BELOW", "LINE 17 BELOW", "TBD", "N/A", "NONE", "VARIOUS", "SEE ATTACHED", "123456"]);
const JUNK_PIN_TEXT_RE = /\bsee\b|\bbelow\b|\bline\s*17\b|\bn\/?a\b|\btbd\b|\bvarious\b|\bpending\b|\battached\b/i;

export function usablePin(p) {
  if (!p) return false;
  const s = String(p).trim();
  if (s.length < 4) return false;
  if (!/[A-Za-z0-9]/.test(s)) return false;
  if (/^[0\W_]+$/.test(s)) return false;
  if (JUNK_PINS.has(s.toUpperCase())) return false;
  if (JUNK_PIN_TEXT_RE.test(s)) return false;
  return true;
}

const RENEWAL_SUFFIX_RE = /R0\d+$/;
export function pinBase(pin) {
  const s = String(pin || "").trim();
  const m = s.match(RENEWAL_SUFFIX_RE);
  return m ? s.slice(0, m.index) : null;
}

// A blanket code bundles several simultaneous awards under one PIN (emergency declarations,
// mostly) — those aren't sequential rebid cycles. Same shape isBlanketChain() excludes in
// pastWinnersHTML()/cadenceEstimate() on the notice-detail view.
export function isBlanketChain(chain) {
  return chain.length > 5 && chain.every((c) => c.type_of_notice_description === "Award");
}

// LINEAGE_MAX_STAGES: the same PR #61 (w12-10) honesty gate, ported verbatim — a widened PIN
// match past this many stages reads as a fiscal-year PIN-prefix collision (real production
// case: PIN 82626R0001001, agency "Environmental Protection", widens to base "82626" and
// prefix-matches 125+ unrelated Award/Intent-to-Award rows under that agency's other PINs —
// verified live against dg92-zbpx 2026-07-15), not a legitimate multi-decade renewal history.
export const LINEAGE_MIN_STAGES = 2;
export const LINEAGE_MAX_STAGES = 15;

export function lineageChainKey(r) {
  if (!usablePin(r.pin) || !r.agency_name) return null;
  return { pin: r.pin, base: pinBase(r.pin), agency_name: r.agency_name };
}
export function lineageDedupeKey(k) { return (k.base || k.pin) + "|" + k.agency_name; }

export function lineageBatchClauses(keys) {
  return keys.map((k) => {
    const agency = `agency_name='${k.agency_name.replace(/'/g, "''")}'`;
    const pinClause = k.base
      ? `pin LIKE '${k.base.replace(/'/g, "''")}%'`
      : `pin='${k.pin.replace(/'/g, "''")}'`;
    return `(${pinClause} AND ${agency})`;
  });
}

// Candidate-level signal, not a per-row badge: given a SAMPLE of a suggestion candidate's own
// live result rows (from suggestionSampleParams()) and the batch of Award/Intent-to-Award
// stage rows fetched for their chain keys (same $where shape loadLineageBadges() builds
// client-side), decide how many sampled rows have a genuine prior-award chain and whether that
// makes the candidate "lineage-rich" as a whole.
//
// Thresholds grounded in a live check against dg92-zbpx (2026-07-15) for the real
// "construction contracts over $500k" candidate (SUGGESTION_POOL money idx 0): of a 25-row
// sample, 6 rows resolved to a genuine 2-stage chain (Correction PIN 07222B0008003, Parks and
// Recreation PIN 84623B0128001, and four Environmental Protection Job-Order-Contract PINs each
// widening to their own 2-stage base) — a 24% share — while the one row that widened to 125+
// matches (the PIN-prefix collision above) was correctly excluded as uncertain, not counted as
// a chain. LINEAGE_RICH_MIN_SHARE (0.2) and LINEAGE_RICH_MIN_COUNT (2) sit comfortably under
// that real, observed 24%/6 result without being so low a single fluke chain reads as "rich".
export const LINEAGE_SAMPLE_MIN = 5; // below this, a share is too noisy to trust
export const LINEAGE_RICH_MIN_COUNT = 2;
export const LINEAGE_RICH_MIN_SHARE = 0.2;

export function computeLineageSignal(sampleRows, batchRows) {
  const rows = Array.isArray(sampleRows) ? sampleRows : [];
  const batch = Array.isArray(batchRows) ? batchRows : [];
  const memo = new Map();
  let chainCount = 0;
  for (const r of rows) {
    const k = lineageChainKey(r);
    if (!k) continue;
    const dedupeKey = lineageDedupeKey(k);
    let hasChain = memo.get(dedupeKey);
    if (hasChain === undefined) {
      const stages = batch.filter((row) => row.agency_name === k.agency_name &&
        (k.base ? String(row.pin || "").startsWith(k.base) : row.pin === k.pin));
      hasChain = !isBlanketChain(stages) && stages.length >= LINEAGE_MIN_STAGES && stages.length <= LINEAGE_MAX_STAGES;
      memo.set(dedupeKey, hasChain);
    }
    if (hasChain) chainCount++;
  }
  const share = rows.length ? chainCount / rows.length : 0;
  const lineageRich = rows.length >= LINEAGE_SAMPLE_MIN && chainCount >= LINEAGE_RICH_MIN_COUNT && share >= LINEAGE_RICH_MIN_SHARE;
  return { lineageRich, lineageCount: chainCount, lineageShare: share, sampleSize: rows.length };
}
