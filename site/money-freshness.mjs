import { nyNaiveTimestampToInstantMs, OPEN_CONTRACTS_FRESHNESS_STATES } from "../resident_snapshot_queries.mjs";

// The resident's real civic day, not the fixture vintage: a harness-pinned day
// (CROL_PINNED_TODAY) is honored so fixture-pinned browser checks stay
// deterministic, but nothing shipped ever assigns the pin itself.
export function moneyEvaluationClockMs(){
  const pinned=globalThis.CROL_PINNED_TODAY;
  if(typeof pinned==="string" && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return nyNaiveTimestampToInstantMs(`${pinned}T00:00:00`);
  // determinism-lint: allow clock the live evaluation instant for the open-contract projection; openContractSnapshotProjection stays a pure function of the clock this passes in.
  return Date.now();
}

// Source-honest copy for the two freshness states that must never resolve to
// the ordinary empty state: a stale committed snapshot (still shows any
// future-dated rows it retained, qualified by this note) and an unavailable
// one (no snapshot to show at all).
export function moneyStaleSourceNoticeHTML(freshness){
  if(!freshness) return "";
  if(freshness.freshnessState===OPEN_CONTRACTS_FRESHNESS_STATES.UNAVAILABLE){
    return `<div class="note warn contracts-freshness-note" role="status" data-contracts-freshness="unavailable">${t("retry_open_data")}</div>`;
  }
  if(freshness.freshnessState===OPEN_CONTRACTS_FRESHNESS_STATES.STALE){
    const date=String(freshness.sourceVintage||"").slice(0,10);
    return `<div class="note warn contracts-freshness-note" role="status" data-contracts-freshness="stale">${t("contracts_source_stale",{date})}</div>`;
  }
  return "";
}
