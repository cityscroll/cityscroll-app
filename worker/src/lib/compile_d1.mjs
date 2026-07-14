// Translate a compileSub descriptor → buildNoticesQuery opts for the D1 mirror.
//
// Constraints:
//   - land/ZAP lenses are NOT in the D1 mirror; callers must return early for those.
//   - "people" lens is not cron-replayable (compileSub already returns null for it).
//   - The D1 mirror stores only City Record (dg92-zbpx) notices; no ZAP rows.
//
// Field-name mapping: D1 uses the ingest names (agency, section, type_of_notice,
// category, vendor_name, start_date, due_date, contract_amount, contract_amount_valid)
// while digest rendering (subDigestHtml) expects SODA-style names
// (agency_name, section_name, etc.). toDigestRow() bridges the gap so downstream
// rendering keeps working without modification.

import { vendorStem, monthsFromISO } from "./compile.mjs";

// Lenses whose data lives outside the D1 notices mirror — always use SODA for these.
// land (ZAP dataset hgx4-8ukb) is the primary case.
export const OFF_MIRROR_LENSES = new Set(["land"]);

// sub: { lens, filter }. todayISO: "YYYY-MM-DD".
// Returns buildNoticesQuery opts (for notices.mjs) or null if the lens can't be
// expressed as a D1 query (caller must fall back to the SODA path).
export function subToD1Opts(sub, todayISO) {
  const f = (sub && sub.filter) || {};
  const kws = (Array.isArray(f.keywords) ? f.keywords : []).filter(Boolean);
  const lens = sub.lens;

  // land (ZAP) and unknown lenses are not in the mirror — explicit, not accidental.
  if (OFF_MIRROR_LENSES.has(lens)) return null;

  // Section lenses: property / rules / meetings
  const SECTION_NAME = {
    property: "Property Disposition",
    rules: "Agency Rules",
    meetings: "Public Hearings and Meetings",
  };
  if (SECTION_NAME[lens]) {
    const opts = { section: SECTION_NAME[lens], limit: 25 };
    if (f.agency) opts.agency = f.agency;
    if (kws.length) opts.termGroups = [kws];
    if (lens === "meetings") {
      // meetings: upcoming events only, soonest-first — mirrors compile.mjs
      opts.openOnly = true;
      opts.today = todayISO;
    } else {
      // property / rules: recent 30-day window avoids returning stale archive rows
      if (todayISO) opts.sinceDate = subtractDays(todayISO, 30);
    }
    return opts;
  }

  if (lens === "money") {
    // Mirrors compile.mjs's SODA money branch field-for-field (same schema, same
    // award-vs-solicitation rule) — the D1 fast path and the SODA fallback must agree, since
    // either can serve any given digest run depending on mirror freshness.
    const opts = { limit: 25 };
    if (f.category) opts.category = f.category;
    if (f.agency) opts.agency = f.agency;
    if (kws.length) opts.termGroups = [kws];
    // noticeType, when set, is authoritative; otherwise fall back to the pre-existing
    // amount-presence heuristic (open bids carry no dollar amount in this dataset — EDA).
    const wantsAward = f.noticeType === "award" || (!f.noticeType && (f.minAmount || f.maxAmount));
    if (wantsAward) {
      opts.noticeType = "Award";
      if (f.minAmount != null) opts.minAmount = Number(f.minAmount) || 1;
      if (f.maxAmount != null) opts.maxAmount = Number(f.maxAmount);
    } else {
      opts.noticeType = "Solicitation";
      opts.openOnly = true;
      opts.today = todayISO;
      if (f.months) opts.dueBefore = monthsFromISO(todayISO, Number(f.months));
    }
    return opts;
  }

  if (lens === "entity") {
    const name = typeof f.name === "string" ? f.name.trim() : "";
    const kind = f.kind === "agency" ? "agency" : "vendor";
    if (!name) return null;
    if (kind === "agency") {
      // Exact agency match across all sections
      return { agency: name, limit: 25 };
    }
    const stem = vendorStem(name);
    if (stem.length < 3) return null;
    // Vendor: haystack term search on the stem; exact-stem postFilter applied by caller
    return { termGroups: [[stem]], limit: 25 };
  }

  return null; // unrecognised lens → caller falls back to SODA
}

// Full compilation: opts + postFilter mirror.
// Returns { opts, postFilter? } or null when the lens is off-mirror or not expressible.
export function compileSub_d1(sub, todayISO) {
  const opts = subToD1Opts(sub, todayISO);
  if (!opts) return null;

  // entity/vendor watches need the same exact-stem postFilter the SODA path uses
  let postFilter;
  const f = (sub && sub.filter) || {};
  if (sub.lens === "entity" && f.kind !== "agency" && f.name) {
    const stem = vendorStem(f.name);
    postFilter = (row) => vendorStem(row.vendor_name || "") === stem;
  }

  return { opts, postFilter };
}

// Map a D1 notices row → field names that subDigestHtml and the alerts diff expect.
// Mirrors the CR_SELECT field list from compile.mjs (SODA response shape).
// Contact fields (contact_name, contact_phone, email) are absent from the D1 mirror;
// they are null here — the HTML renderer already guards against null contacts.
export function toDigestRow(r) {
  return {
    request_id:      r.request_id           ?? null,
    start_date:      r.start_date           ?? null,
    agency_name:     r.agency               ?? null,  // D1 "agency" → SODA "agency_name"
    short_title:     r.short_title          ?? null,
    pin:             r.pin                  ?? null,
    // Honest-data rule from notices.mjs / EDA: corrupt amounts (contract_amount_valid=0)
    // must not surface as dollar figures.
    contract_amount: r.contract_amount_valid ? (r.contract_amount ?? null) : null,
    vendor_name:     r.vendor_name          ?? null,
    due_date:        r.due_date             ?? null,
    contact_name:    null,                            // not in D1 mirror
    contact_phone:   null,                            // not in D1 mirror
    email:           null,                            // not in D1 mirror
    section_name:    r.section              ?? null,  // D1 "section" → SODA "section_name"
    event_date:      r.event_date           ?? null,
    street_address_1: r.event_addr1         ?? null,
  };
}

// Helper: subtract N calendar days from a YYYY-MM-DD string (UTC, no DST jitter).
function subtractDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
