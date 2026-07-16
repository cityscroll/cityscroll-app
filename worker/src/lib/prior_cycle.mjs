// Pure: the cross-PIN prior-cycle / near-match ranking heuristics that decide whether a Money/
// Contracts Award notice has an earlier same-agency rebid cycle — mirrors index.html's
// client-side priorCycleTitleWords()/rankPriorCycleCandidates() (the strict "who won it last
// time" matcher) and pinPrefixShared()/nearMatchReasons()/rankNearMatchCandidates() (the looser
// w12-18 "maybe" tier). Ported here so the worker can precompute a notice's {strict, near}
// matches server-side (worker/src/prior_cycle.mjs) instead of firing two live SODA calls from
// the browser on every notice-detail open.
//
// The worker and static site can't share an import across that boundary (see AGENTS.md's
// "dual-implemented" convention, used the same way for matchEvidence(), vendorStem(), and
// lib/lineage.mjs's pinBase()/usablePin()/isBlanketChain()) — keep this file in sync BY HAND
// with index.html's copies if the title-word/gap/score/corroboration heuristics ever change.
// The client's index.html functions stay the SOURCE OF TRUTH; this port must not diverge or the
// Phase 1b client swap (which consumes GET /priorcycle/<id>) will surface different results than
// the reader previously saw.
//
// This module is PURE (no fetch, no D1) — the SODA queries and D1 cache live in the caller
// (worker/src/prior_cycle.mjs), exactly mirroring how index.html's priorCycleAwards()/
// nearMatchCandidates() fetch rows and then hand them to these rank steps.

import { usablePin, pinBase } from "./lineage.mjs";

// --- strict tier (index.html:1244 PRIOR-CYCLE AWARDS) -----------------------------------------

export const PRIOR_CYCLE_MIN_GAP_DAYS = 180;
export const PRIOR_CYCLE_MAX_MATCHES = 3;
export const PRIOR_CYCLE_STOPWORDS = new Set("the a an of for and to in on with by at services service contract contracts renewal option year years extension citywide fiscal".split(" "));

export function priorCycleTitleWords(title) {
  const seen = new Set();
  String(title || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).forEach((w) => {
    if (w.length > 2 && !PRIOR_CYCLE_STOPWORDS.has(w)) seen.add(w);
  });
  return [...seen];
}

export function daysBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(da - db) / 86400000;
}

// Pure filter/rank step — the strict tier: same-agency, prior-dated, >=180-day gap, title-word
// score >= 0.5, one row per PIN, max N. Concurrent-cohort awards (same RFP, days apart) must be
// excluded; an explicit renewal-suffix PIN (…R001) far apart in time from the same agency+title
// must be kept.
export function rankPriorCycleCandidates(r, candidates, opts) {
  const maxN = (opts && opts.maxN) || PRIOR_CYCLE_MAX_MATCHES;
  const minGapDays = (opts && opts.minGapDays) || PRIOR_CYCLE_MIN_GAP_DAYS;
  const myWords = priorCycleTitleWords(r.short_title);
  if (!myWords.length) return [];
  const seenPins = new Set();
  return candidates
    .filter((c) => c.request_id !== r.request_id)
    .filter((c) => c.agency_name === r.agency_name) // belt-and-suspenders — the SODA $where already scopes to this agency
    .filter((c) => !usablePin(r.pin) || c.pin !== r.pin) // r's own PIN chain is chainHTML()'s job, not this
    .filter((c) => (c.start_date || "") < (r.start_date || "")) // only PRIOR cycles — "who won it last time"
    .filter((c) => { const g = daysBetween(c.start_date, r.start_date); return g !== null && g >= minGapDays; })
    .map((c) => {
      const overlap = priorCycleTitleWords(c.short_title).filter((w) => myWords.includes(w));
      return { c, score: overlap.length / myWords.length };
    })
    .filter((x) => x.score >= 0.5) // majority of this notice's significant title words must recur
    .sort((a, b) => b.score - a.score || (b.c.start_date || "").localeCompare(a.c.start_date || ""))
    .map((x) => x.c)
    .filter((c) => { // one row per PIN — a multi-vendor pool's own split shouldn't repeat as separate "cycles"
      if (seenPins.has(c.pin)) return false;
      seenPins.add(c.pin);
      return true;
    })
    .slice(0, maxN);
}

// Mirrors rankPriorCycleCandidates()'s pre-score filters (self, agency, own PIN, prior date,
// >=180-day gap) — how many candidates were even eligible, before the 0.5 title-overlap bar.
// Worker-only since the Phase 1b swap: the endpoint returns this count so the client can pick
// 67's no_candidates-vs-low_confidence empty-state message without re-running the strict query
// it no longer fetches (index.html's own copy was deleted in the swap). The rank functions above
// stay dual-implemented and hand-synced with index.html; this eligibility count no longer has a
// client twin to keep in sync.
export function priorCycleEligibleCount(r, candidates) {
  return (candidates || [])
    .filter((c) => c.request_id !== r.request_id)
    .filter((c) => c.agency_name === r.agency_name)
    .filter((c) => !usablePin(r.pin) || c.pin !== r.pin)
    .filter((c) => (c.start_date || "") < (r.start_date || ""))
    .filter((c) => { const g = daysBetween(c.start_date, r.start_date); return g !== null && g >= PRIOR_CYCLE_MIN_GAP_DAYS; })
    .length;
}

// --- near-match tier (index.html:1326 NEAR-MATCH PRIOR CYCLES, w12-18) -------------------------

export const NEAR_MATCH_MIN_SCORE = 0.34; // "at least a third of this notice's significant title words recur" — looser than the strict majority bar, still real overlap, not one coincidental shared word
export const NEAR_MATCH_MAX_MATCHES = 3;
export const NEAR_MATCH_PIN_PREFIX_MIN_LEN = 8; // shared leading chars of the renewal-suffix-stripped PIN — deliberately deeper than a same-agency PIN scheme's own common stem
export const NEAR_MATCH_AMOUNT_RATIO_MAX = 3; // larger/smaller contract_amount no more than 3x apart counts as "comparable"
export const NEAR_MATCH_QUERY_WORDS = 2; // widened $q word count for the lazy reveal fetch — see index.html header

export function pinPrefixShared(a, b) {
  const sa = pinBase(a) || a, sb = pinBase(b) || b;
  let n = 0;
  while (n < sa.length && n < sb.length && sa[n] === sb[n]) n++;
  return n;
}

// A candidate needs the required title overlap PLUS at least one of these two corroborating
// signals (rankNearMatchCandidates() below enforces that) — agency+title alone is too noisy on
// its own, see index.html's file header.
export function nearMatchReasons(r, c, overlapWords) {
  const reasons = [{ kind: "agency" }, { kind: "title", words: overlapWords }];
  if (usablePin(r.pin) && usablePin(c.pin) && pinPrefixShared(r.pin, c.pin) >= NEAR_MATCH_PIN_PREFIX_MIN_LEN) {
    reasons.push({ kind: "pin", prefix: (pinBase(c.pin) || c.pin).slice(0, NEAR_MATCH_PIN_PREFIX_MIN_LEN) });
  }
  const ra = +r.contract_amount, ca = +c.contract_amount;
  if (ra > 0 && ca > 0 && Math.max(ra, ca) / Math.min(ra, ca) <= NEAR_MATCH_AMOUNT_RATIO_MAX) {
    reasons.push({ kind: "amount", a: ra, b: ca });
  }
  return reasons;
}

// Pure filter/rank step, mirroring rankPriorCycleCandidates() above but for the looser tier —
// same gap floor, lower title-overlap floor (score in [0.34, 0.5)), hard requirement for PIN or
// amount corroboration. strictMatches is whatever rankPriorCycleCandidates() already found for
// this notice, kept out so a confident match can never ALSO resurface here as a "maybe".
export function rankNearMatchCandidates(r, candidates, strictMatches, opts) {
  const maxN = (opts && opts.maxN) || NEAR_MATCH_MAX_MATCHES;
  const minGapDays = (opts && opts.minGapDays) || PRIOR_CYCLE_MIN_GAP_DAYS;
  const minScore = (opts && opts.minScore) || NEAR_MATCH_MIN_SCORE;
  const myWords = priorCycleTitleWords(r.short_title);
  if (!myWords.length) return [];
  const strictIds = new Set((strictMatches || []).map((c) => c.request_id));
  const seenPins = new Set();
  return candidates
    .filter((c) => c.request_id !== r.request_id)
    .filter((c) => !strictIds.has(c.request_id)) // never re-surface a confident match as a maybe
    .filter((c) => c.agency_name === r.agency_name)
    .filter((c) => !usablePin(r.pin) || c.pin !== r.pin)
    .filter((c) => (c.start_date || "") < (r.start_date || ""))
    .filter((c) => { const g = daysBetween(c.start_date, r.start_date); return g !== null && g >= minGapDays; })
    .map((c) => {
      const cWords = priorCycleTitleWords(c.short_title);
      const overlap = cWords.filter((w) => myWords.includes(w));
      return { c, score: overlap.length / myWords.length, overlap };
    })
    .filter((x) => x.score >= minScore && x.score < 0.5) // below the strict bar — an equal-or-better match already is one
    .map((x) => ({ ...x, reasons: nearMatchReasons(r, x.c, x.overlap) }))
    .filter((x) => x.reasons.some((rs) => rs.kind === "pin" || rs.kind === "amount")) // title overlap alone is too noisy — see index.html header
    .sort((a, b) => b.score - a.score || (b.c.start_date || "").localeCompare(a.c.start_date || ""))
    .filter((x) => { if (seenPins.has(x.c.pin)) return false; seenPins.add(x.c.pin); return true; }) // one row per PIN
    .slice(0, maxN);
}
