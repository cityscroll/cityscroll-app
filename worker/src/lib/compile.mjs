// Pure: map a stored subscription {lens, filter} → a SODA/ZAP query descriptor the cron replays.
// Mirrors the frontend alert preview (aFetch) so a subscriber's digest matches what they previewed.
// No model call — the filter was already compiled at subscribe time; this is deterministic replay.

import { dateWindowEnd, hearingMatchesLocation } from "./hearings.mjs";
// vendorStem lives in normalize.mjs (er-03); re-export for zero call-site churn.
import { vendorStem } from "./normalize.mjs";
import {
  commercialMatchesFilters,
  extractPropertyCommercial,
  normalizeAssetFilter,
} from "./property_commercial.mjs";
export { vendorStem };

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json"; // City Record
const ZAP = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";  // Zoning Application Portal
const STAFFING_EXAMS = "https://cityscroll.org/data/staffing_exams.json";
const DISTRICT_WEEKLY_DIGESTS = "https://cityscroll.org/data/district_weekly_digests.json";
// additional_description_1 is fetched so a digest item can show WHY a keyword matched when
// the term isn't in the title (see matchEvidence() in lib/digest.mjs) -- not otherwise shown.
// type_of_notice_description + address/method feed digest action rails (handoffs).
// additional_description_1 feeds matchEvidence + package URL extraction.
const CR_SELECT = "request_id,start_date,agency_name,short_title,pin,contract_amount,vendor_name,due_date,contact_name,contact_phone,email,section_name,type_of_notice_description,address_to_request,selection_method_description,additional_description_1";
// Section lenses additionally need the event date + address for a useful digest line.
const CR_SELECT_EV = CR_SELECT + ",event_date,street_address_1,street_address_2,building_name,city,state,zip_code,additional_description_2,additional_description_3,other_info_1,other_info_2,other_info_3,printout_1";
const SECTION_BY_LENS = {
  property: "Property Disposition",
  rules: "Agency Rules",
  meetings: "Public Hearings and Meetings",
};
const ZAP_SELECT = "project_id,project_name,project_brief,primary_applicant,public_status,borough,community_district,mih_flag,current_milestone_date";
const REZ_ALIAS = { "79 rivington": "Allen Street", "79 rivington street": "Allen Street", "allen street mall": "Allen Street" };

// N months after an ISO date, as an ISO date — pure function of todayISO (not Date.now()),
// so compileSub() stays deterministic/testable. Used for the "due within N months" upper
// bound on Solicitation queries. Exported so compile_d1.mjs's D1-mirror path computes the
// exact same bound (its own opts.dueBefore) — the two compilers must agree on this date math
// or a subscriber's D1-fast-path digest could quietly disagree with its SODA-fallback preview.
export function monthsFromISO(iso, months) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function examOpenWindowBand(exam, todayISO) {
  const boundary = exam?.application_start && todayISO < exam.application_start
    ? exam.application_start
    : exam?.application_end && todayISO <= exam.application_end
      ? exam.application_end
      : null;
  if (!boundary) return null;
  const days = Math.round((Date.parse(`${boundary}T12:00:00Z`) - Date.parse(`${todayISO}T12:00:00Z`)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days <= 14) return "imminent";
  if (days <= 90) return "approaching";
  return "far";
}

// sub: { lens, filter }. todayISO: "YYYY-MM-DD" (for the RFP due-date floor). Returns
// { url, params, idField, kind, postFilter? } or null for a lens the cron can't replay yet.
// postFilter (when present) refines fetched rows — the caller applies it after fetching.
export function compileSub(sub, todayISO) {
  const f = (sub && sub.filter) || {};
  const kws = (Array.isArray(f.keywords) ? f.keywords : []).filter(Boolean);

  if (sub.lens === "district") {
    const council = typeof f.councilDistrict === "string" && /^(?:[1-9]|[1-4]\d|5[01])$/.test(f.councilDistrict)
      ? f.councilDistrict
      : null;
    if (!council) return null;
    return {
      url: DISTRICT_WEEKLY_DIGESTS,
      params: {},
      idField: "district_item_id",
      kind: "district",
      transformRows: (payload) => {
        const record = payload?.by_council_district?.[council];
        const rows = Array.isArray(record?.items) ? record.items.filter((row) => row?.district_item_id) : [];
        return record?.total === rows.length ? rows : [];
      },
    };
  }

  if (sub.lens === "people" && f.view === "guide" && f.interestArea) {
    const area = String(f.interestArea);
    return {
      url: STAFFING_EXAMS,
      params: {},
      idField: "alert_id",
      kind: "exam",
      transformRows: (payload) => (Array.isArray(payload?.exams) ? payload.exams : [])
        .filter((exam) => exam?.interest_area === area)
        .filter((exam) => {
          const continuous = /continuous|walk[- ]?in/i.test(`${exam?.application_mode || ""} ${exam?.filing_method || ""}`);
          return continuous || (exam?.application_end && exam.application_end >= todayISO);
        })
        .map((exam) => ({
          ...exam,
          open_window_band: examOpenWindowBand(exam, todayISO),
          // A posted NOE is a positive, actionable state transition and gets one delivery.
          alert_id: `exam:${exam.exam_number}:${exam.notice_url ? "noe-posted" : exam.application_start || "scheduled"}`,
        })),
    };
  }

  if (sub.lens === "money") {
    // Verbatim dataset values; single-quote-escaped for SODA. These two clauses are shared
    // by both branches below — an alert can name a category and/or an agency regardless of
    // whether it's watching awards or open solicitations.
    const catClause = f.category ? ` AND category_description='${String(f.category).replace(/'/g, "''")}'` : "";
    const agency = typeof f.agency === "string" && f.agency.trim() ? f.agency.trim().replace(/'/g, "''") : null;
    const agencyClause = agency ? ` AND agency_name='${agency}'` : "";
    // noticeType, when set, is authoritative. Otherwise fall back to the pre-existing
    // amount-presence heuristic: only Award notices carry a dollar amount in this dataset —
    // open bids do not (EDA) — so an amount bound alone still implies the award query. This
    // fallback is what makes every subscription stored before noticeType existed keep working
    // unchanged.
    // Entity/agency forecast routes are not SODA list queries — handled by the client
    // (location.hash = #agency/…?tab=forecast). Count them as fruitless for list compile.
    if (f.route === "agency" || f.route === "vendor") return null;
    const wantsAward = f.noticeType === "award" || (!f.noticeType && (f.minAmount || f.maxAmount) && !f.closingWeek);
    if (wantsAward) {
      // Amount-validity cap per the crol-analyzer EDA: rows >= $10B are data-entry
      // errors (max legitimate award ≈ $6.68B — the old $5B cap wrongly excluded it).
      let where = `type_of_notice_description='Award' AND contract_amount >= ${Number(f.minAmount) || 1} AND contract_amount < 10000000000`;
      if (f.maxAmount) where += ` AND contract_amount <= ${Number(f.maxAmount)}`;
      const awardParams = {
        "$select": CR_SELECT,
        "$where": where + catClause + agencyClause,
        "$order": "start_date DESC", "$limit": "25",
      };
      // Keywords apply to awards too (w6-16) — the D1 path always filtered by them;
      // without this, the SODA fallback delivered ALL awards over the threshold.
      if (kws.length) awardParams["$q"] = kws.join(" ");
      return { url: SODA, idField: "request_id", kind: "award", params: awardParams };
    }
    let where = `type_of_notice_description='Solicitation' AND due_date > '${todayISO}'`;
    if (f.closingWeek) {
      // Same week window the Money "Closing this week" chip uses (7 calendar days).
      const d = new Date(todayISO + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 7);
      where += ` AND due_date <= '${d.toISOString().slice(0, 10)}'`;
    } else if (f.months) {
      where += ` AND due_date <= '${monthsFromISO(todayISO, Number(f.months))}'`;
    }
    const params = {
      "$select": CR_SELECT,
      "$where": where + catClause + agencyClause,
      "$order": "due_date ASC", "$limit": "25",
    };
    if (kws.length) params["$q"] = kws.join(" ");
    return { url: SODA, idField: "request_id", kind: "rfp", params };
  }

  if (sub.lens === "entity") {
    // Follow-an-entity: every new City Record notice naming a vendor (any variant of the
    // name stem) or published by an agency (across ALL sections).
    const name = typeof f.name === "string" ? f.name.trim() : "";
    const kind = f.kind === "agency" ? "agency" : "vendor";
    if (!name) return null;
    if (kind === "agency") {
      return {
        url: SODA, idField: "request_id", kind: "entity",
        params: { "$select": CR_SELECT_EV, "$where": `agency_name='${name.replace(/'/g, "''")}'`, "$order": "start_date DESC", "$limit": "25" },
      };
    }
    const stem = vendorStem(name);
    if (stem.length < 3) return null;
    // Full-text $q, not a stem-prefix LIKE: the stem strips punctuation but vendor_name keeps
    // it ("LEON D. DEMATTEIS…" never starts with "LEON D DEMATTEIS…"), so the LIKE silently
    // matched nothing for punctuated vendors. $q tokenizes punctuation away on both sides;
    // the exact-stem postFilter keeps precision.
    return {
      url: SODA, idField: "request_id", kind: "entity",
      params: { "$select": CR_SELECT_EV, "$where": "vendor_name IS NOT NULL", "$q": stem, "$order": "start_date DESC", "$limit": "25" },
      postFilter: (row) => vendorStem(row.vendor_name) === stem,
    };
  }

  if (SECTION_BY_LENS[sub.lens]) {
    // property / rules / meetings: a deterministic City Record section query — same shape the
    // lens's own feed uses. Meetings watches mean "upcoming events", not "any new row about a
    // past meeting", so they get an event-date floor and soonest-first ordering.
    let where = sub.lens === "meetings"
      ? "(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL))"
      : `section_name='${SECTION_BY_LENS[sub.lens]}'`;
    const agency = typeof f.agency === "string" && f.agency.trim() ? f.agency.trim().replace(/'/g, "''") : null;
    if (agency) where += ` AND agency_name='${agency}'`;
    let order = "start_date DESC";
    if (sub.lens === "meetings") {
      where += ` AND event_date > '${todayISO}'`;
      const end = dateWindowEnd(todayISO, f.dateWindow || f.when);
      if (end) where += ` AND event_date <= '${end}T23:59:59'`;
      order = "event_date ASC";
    } else if (sub.lens === "property" && f.sort === "closing_soon") {
      // Prefer soonest event when the watch explicitly asks for closing-soon sort.
      order = "event_date ASC";
    }
    const params = { "$select": CR_SELECT_EV, "$where": where, "$order": order, "$limit": "25" };
    if (kws.length) params["$q"] = kws.join(" ");

    let postFilter;
    if (sub.lens === "meetings" && (f.borough || f.neighborhood || f.locationScope)) {
      postFilter = (row) => hearingMatchesLocation(row, f);
    } else if (sub.lens === "property") {
      const asset = normalizeAssetFilter(f.asset);
      const saleMethod = f.saleMethod || "all";
      const priceBand = f.priceBand || "all";
      const commercialActive = asset !== "all" || (saleMethod && saleMethod !== "all") || (priceBand && priceBand !== "all");
      if (commercialActive) {
        postFilter = (row) => {
          const commercial = extractPropertyCommercial(row);
          return commercialMatchesFilters(commercial, {
            asset,
            saleMethod: saleMethod || "all",
            priceBand: priceBand || "all",
            commercialOnly: true,
          });
        };
      }
    }

    return {
      url: SODA,
      idField: "request_id",
      kind: sub.lens,
      params,
      postFilter,
    };
  }

  if (sub.lens === "land") {
    // Mirror the Land tab's zapWhere + district filters so suggestion fruitfulness counts
    // the same surface a click resolves to (borough / community district / council district).
    let where = "ulurp_non='ULURP'";
    if (f.status !== "all") where += " AND project_status='Active'";
    const boro = typeof f.boro === "string" && f.boro.trim() ? f.boro.trim().replace(/'/g, "''") : null;
    if (boro) where += ` AND borough='${boro}'`;
    const cd = typeof f.communityDistrict === "string" && /^(?:M|X|K|Q|R)\d{2}$/.test(f.communityDistrict)
      ? f.communityDistrict
      : null;
    if (cd) where += ` AND community_district like '%${cd}%'`;
    const council = typeof f.councilDistrict === "string" && /^(?:[1-9]|[1-4]\d|5[01])$/.test(f.councilDistrict)
      ? f.councilDistrict
      : null;
    if (council) {
      // Exact match only: multi-district concatenation cells exist, but Socrata rejects
      // LIKE on this column for some field types — exact ids still prove fruitfulness.
      where += ` AND cc_district='${council}'`;
    }
    const params = { "$select": ZAP_SELECT, "$where": where, "$order": "current_milestone_date DESC", "$limit": "25" };
    const q = kws.map((k) => REZ_ALIAS[k.toLowerCase()] || k).join(" ");
    if (q) params["$q"] = q;
    return { url: ZAP, idField: "project_id", kind: "rezone", params };
  }

  return null; // payroll/person-name watches still need a separate replay source
}
