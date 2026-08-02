// City Record Housing Authority solicitation ↔ Checkbook Contracts_NYCHA join.
//
// Measured 2026-08-01 (see site/data/nycha_award_sources/ and
// site/data/source_contracts.json join_measurement for checkbook-nycha-contracts):
//
//   Product window (Housing Authority solicitations with PIN in the live notice mirror):
//     temporal exact-PIN join rate 0% on sampled notices — all completed lookups are either
//     Checkbook misses or pre-solicitation PIN-reuse agreements correctly rejected.
//   Historical City Record sample (solicitation + PIN, start_date in [2019-01-01, 2023-01-01)):
//     any-agreement PIN hit rate low; temporal (contract date after notice start) ≈ 0% before
//     Checkbook WAF rate limits cut the probe short.
//
// Accepted strategy (strict only):
//   exact_pin_temporal — Checkbook Agreement.pin equals notice.pin AND
//                        (approved_date || start_date) > notice.start_date
//
// Rejected as weak (measured for contrast; do not ship as confident exact matches):
//   pin_reuse_without_temporal — same PIN, contract dated on/before the solicitation
//   purpose_title_fuzzy        — free-text purpose ↔ short_title (false positives; key spaces differ)
//
// Verdict: below usefulness threshold (~30%) for confident product materialization of
// exact solicitation→award matches. Keep the pure ranker and on-demand path for rare true
// positives; do not claim a live dense exact-match product surface.

import { rankNychaAwardCandidates } from "./external_award.mjs";

/** Classify one notice against already-fetched Checkbook Agreement rows. */
export function classifyNychaPinJoin(notice, agreements) {
  const pin = String((notice && notice.pin) || "").trim();
  const noticeAt = Date.parse((notice && notice.start_date) || "");
  if (!pin || pin.length < 4 || !Number.isFinite(noticeAt)) {
    return { status: "ineligible", matches: [], agreements: 0, reuse_only: 0 };
  }
  const rows = Array.isArray(agreements) ? agreements : [];
  const agreementsOnly = rows.filter((r) => r && r.recordType === "Agreement");
  let reuseOnly = 0;
  for (const row of agreementsOnly) {
    if (String(row.pin || "").trim() !== pin || !row.id) continue;
    const contractAt = Date.parse(row.approved || row.start || "");
    if (!Number.isFinite(contractAt) || contractAt <= noticeAt) reuseOnly++;
  }
  const matches = rankNychaAwardCandidates(notice, rows);
  if (matches.length) return { status: "matched", matches, agreements: agreementsOnly.length, reuse_only: reuseOnly };
  if (reuseOnly > 0) return { status: "reuse_only", matches: [], agreements: agreementsOnly.length, reuse_only: reuseOnly };
  if (agreementsOnly.length) return { status: "no_temporal", matches: [], agreements: agreementsOnly.length, reuse_only: 0 };
  return { status: "no_agreement", matches: [], agreements: 0, reuse_only: 0 };
}

/**
 * Summarize join outcomes over a fixture sample (characterization / scorecard).
 * @param {Array<{ notice: object, agreements: object[] }>} pairs
 */
export function measureNychaTemporalJoinRate(pairs) {
  let eligible = 0;
  let matched = 0;
  let reuseOnly = 0;
  let noAgreement = 0;
  let ineligible = 0;
  for (const pair of pairs || []) {
    const r = classifyNychaPinJoin(pair.notice, pair.agreements);
    if (r.status === "ineligible") {
      ineligible++;
      continue;
    }
    eligible++;
    if (r.status === "matched") matched++;
    else if (r.status === "reuse_only") reuseOnly++;
    else noAgreement++;
  }
  const rate = eligible ? matched / eligible : 0;
  return {
    eligible,
    matched,
    reuse_only: reuseOnly,
    no_agreement: noAgreement,
    ineligible,
    temporal_exact_rate: rate,
  };
}

export { rankNychaAwardCandidates };
