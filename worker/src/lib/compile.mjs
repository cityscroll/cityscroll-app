// Pure: map a stored subscription {lens, filter} → a SODA/ZAP query descriptor the cron replays.
// Mirrors the frontend alert preview (aFetch) so a subscriber's digest matches what they previewed.
// No model call — the filter was already compiled at subscribe time; this is deterministic replay.

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json"; // City Record
const ZAP = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";  // Zoning Application Portal
const CR_SELECT = "request_id,start_date,agency_name,short_title,pin,contract_amount,vendor_name,due_date,contact_name,contact_phone,email,section_name";
// Section lenses additionally need the event date + address for a useful digest line.
const CR_SELECT_EV = CR_SELECT + ",event_date,street_address_1";
const SECTION_BY_LENS = {
  property: "Property Disposition",
  rules: "Agency Rules",
  meetings: "Public Hearings and Meetings",
};
const ZAP_SELECT = "project_id,project_name,project_brief,primary_applicant,public_status,borough,community_district,mih_flag,current_milestone_date";
const REZ_ALIAS = { "79 rivington": "Allen Street", "79 rivington street": "Allen Street", "allen street mall": "Allen Street" };

// Vendor-name identity: normalize to a stem (case / punctuation / legal suffixes) — mirrors
// the frontend's read-time resolution, so a watch on "Sinergia Inc" also catches
// "Sinergia Incorporated". Prefix-match server-side, exact-stem postFilter client-side.
const VENDOR_SUFFIX = /\s+(INCORPORATED|INC|LLC|L\.L\.C|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|LP|LLP|PLLC|P\.C|PC|USA|OF NY|OF NEW YORK)\.?$/;
export function vendorStem(name) {
  let s = String(name || "").replace(/<[^>]*>/g, " ").toUpperCase().replace(/[.,'’&]/g, " ").replace(/\s+/g, " ").trim();
  let prev;
  do { prev = s; s = s.replace(VENDOR_SUFFIX, "").trim(); } while (s !== prev && s.length > 3);
  return s;
}

// sub: { lens, filter }. todayISO: "YYYY-MM-DD" (for the RFP due-date floor). Returns
// { url, params, idField, kind, postFilter? } or null for a lens the cron can't replay yet.
// postFilter (when present) refines fetched rows — the caller applies it after fetching.
export function compileSub(sub, todayISO) {
  const f = (sub && sub.filter) || {};
  const kws = (Array.isArray(f.keywords) ? f.keywords : []).filter(Boolean);

  if (sub.lens === "money") {
    if (f.minAmount) {
      return {
        url: SODA, idField: "request_id", kind: "award",
        params: {
          "$select": CR_SELECT,
          // Amount-validity cap per the crol-analyzer EDA: rows >= $10B are data-entry
          // errors (max legitimate award ≈ $6.68B — the old $5B cap wrongly excluded it).
          "$where": `type_of_notice_description='Award' AND contract_amount >= ${Number(f.minAmount)} AND contract_amount < 10000000000`,
          "$order": "start_date DESC", "$limit": "25",
        },
      };
    }
    const params = {
      "$select": CR_SELECT,
      "$where": `type_of_notice_description='Solicitation' AND due_date > '${todayISO}'`,
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
    let where = `section_name='${SECTION_BY_LENS[sub.lens]}'`;
    const agency = typeof f.agency === "string" && f.agency.trim() ? f.agency.trim().replace(/'/g, "''") : null;
    if (agency) where += ` AND agency_name='${agency}'`;
    let order = "start_date DESC";
    if (sub.lens === "meetings") { where += ` AND event_date > '${todayISO}'`; order = "event_date ASC"; }
    const params = { "$select": CR_SELECT_EV, "$where": where, "$order": order, "$limit": "25" };
    if (kws.length) params["$q"] = kws.join(" ");
    return { url: SODA, idField: "request_id", kind: sub.lens, params };
  }

  if (sub.lens === "land") {
    const params = { "$select": ZAP_SELECT, "$where": "ulurp_non='ULURP'", "$order": "current_milestone_date DESC", "$limit": "25" };
    const q = kws.map((k) => REZ_ALIAS[k.toLowerCase()] || k).join(" ");
    if (q) params["$q"] = q;
    return { url: ZAP, idField: "project_id", kind: "rezone", params };
  }

  return null; // people isn't cron-replayable yet (payroll diffs need different plumbing)
}
