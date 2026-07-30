// Strict City Record PIN ↔ Bid Tabulations Historical (9k82-ys7w) join.
//
// Measured 2026-07-30 (see site/data/bid_tabulation_sources/ and
// site/data/source_contracts.json join_measurement for bid-tabulations-historical):
//
//   Product universe (Procurement notices with PIN, start_date >= 2025-01-01):
//     strict join rate 0% (dataset openings end 2021-03-24).
//   Historical overlap (same, start_date in [2016-01-01, 2022-01-01)):
//     strict join rate 9.07% (2,158 / 23,804).
//
// Accepted strategies (strict only):
//   exact                     — alnum-normalized PIN equals bid_number
//   agency_prefix_bid_suffix  — PIN is 2–4 digit agency code + known 7-digit bid_number
//                               (covers DCAS commodity PINs like 8571600131 → 1600131)
//
// Rejected as weak (measured for contrast; do not ship):
//   title_unique              — unique normalized short_title match (false positives across years)
//   pin_contains_bid_number   — shared digit substring without agency-prefix structure
//   title_only without date   — same title collisions across re-ads
//
// Verdict: below usefulness threshold (~30%) → no edge materialization.

/** Alphanumeric uppercase form used as a join key. */
export function normId(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Build an index of bid_number strings from Bid Tabulations Historical.
 * @param {Iterable<string>} bidNumbers
 * @returns {{ exact: Set<string> }}
 */
export function buildBidNumberIndex(bidNumbers) {
  const exact = new Set();
  for (const raw of bidNumbers || []) {
    const b = normId(raw);
    if (b) exact.add(b);
  }
  return { exact };
}

/**
 * Join a City Record PIN to a bid_number index using strict strategies only.
 * @returns {{ method: string, bid_number: string } | null}
 */
export function joinPinToBidNumber(pin, index) {
  if (!index?.exact) return null;
  const p = normId(pin);
  if (!p) return null;

  if (index.exact.has(p)) {
    return { method: "exact", bid_number: p };
  }

  // 2–4 digit agency prefix + known 7-digit bid_number (DCAS CSB commodity shape).
  if (p.length >= 9 && p.length <= 11) {
    const suffix = p.slice(-7);
    const prefix = p.slice(0, -7);
    if (/^\d{2,4}$/.test(prefix) && index.exact.has(suffix)) {
      return { method: "agency_prefix_bid_suffix", bid_number: suffix };
    }
  }

  return null;
}

/**
 * Aggregate distinct bidders for one bid_number from line-item tabulation rows.
 * @param {Array<{ bidder_name?: string, bid_price?: string|number }>} rows
 */
export function summarizeBidTabulation(rows) {
  const bidders = new Map();
  for (const row of rows || []) {
    const name = String(row?.bidder_name || "").trim();
    if (!name) continue;
    if (!bidders.has(name)) bidders.set(name, { bidder_name: name, line_items: 0 });
    bidders.get(name).line_items += 1;
  }
  const list = [...bidders.values()].sort((a, b) => a.bidder_name.localeCompare(b.bidder_name));
  return {
    bidder_count: list.length,
    bidders: list,
  };
}
