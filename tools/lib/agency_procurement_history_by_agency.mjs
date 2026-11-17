// Per-agency purchasing history for every agency the City Record or Checkbook names.
//
// For each canonical agency id (site/agency_identity.mjs), over the last 24 months:
//   - City Record solicitation notices, counted once per request_id;
//   - the response window, publication date to printed due date, as a median in calendar days with
//     the notices it rests on and the share that carried a usable due date;
//   - registered contracts (Checkbook NYC, the engine's normalized projection), counted once per
//     prime contract id, with the median original registered amount and the count behind it.
// Every block carries its source and as-of date. A block with too little behind it is published with
// a reason code and plain words, never as a zero or a blank. The count is always published; whether to
// show a median for a small count is the consumer's rule.
//
// The City Record counts are "notices printed in the City Record", not "everything the agency bought":
// an agency that buys through PASSPort and prints awards instead (DYCD) shows few solicitations.
//
// Pure functions plus one bounded fetch. No DOM, no markup, no contact fields.

import {
  noticeMetricsByAgency,
  registeredContractMetricsByAgency,
  NOT_ONE_AGENCY_IDS,
  CHECKBOOK_SPELLING_REVIEW,
} from "../../site/agency_procurement_history.mjs";
import { CITY_RECORD_DATASET, fetchJson, sodaUrl } from "./batch_precompute_snapshots.mjs";

export const AGENCY_HISTORY_SCHEMA = "cityscroll.agency_procurement_history_by_agency.v1";
export const AGENCY_HISTORY_RULE_VERSION = "agency-history-v1";
export const AGENCY_HISTORY_WINDOW_MONTHS = 24;
export const AGENCY_HISTORY_MAX_ROWS = 8000;
export const AGENCY_HISTORY_MAX_BYTES = 512 * 1024;
export const AGENCY_HISTORY_SMALL_SAMPLE_BELOW = 5;
export const AGENCY_HISTORY_NOTICE_FIELDS = Object.freeze([
  "request_id",
  "start_date",
  "due_date",
  "agency_name",
  "type_of_notice_description",
  "section_name",
]);

const CITY_RECORD_SOURCE = Object.freeze({ name: "City Record Online" });
const CONTRACTS_SOURCE = Object.freeze({ name: "Checkbook NYC registered contracts" });

// One catalogue of the words, so a consumer does not invent its own.
export const AGENCY_HISTORY_REASONS = Object.freeze({
  no_solicitation_notices: {
    state: "missing",
    text: "No solicitation notice under this agency's name was printed in the City Record in this window. Some agencies buy through PASSPort or print awards instead.",
  },
  no_usable_due_date: {
    state: "missing",
    text: "This agency's solicitation notices in this window carry no usable due date (blank, a rolling placeholder, or before publication), so no response window can be read.",
  },
  no_registered_contracts: {
    state: "missing",
    text: "No registered contracts are listed under this agency's name in Checkbook NYC in this window.",
  },
  no_contract_amounts: {
    state: "missing",
    text: "This agency's registered contracts in this window carry no usable amount, so no median can be read.",
  },
  identity_not_reviewed: {
    state: "note",
    text: "This agency name is not in CityScroll's reviewed agency list; figures are matched on the name as printed.",
  },
});

export function calendarDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The day `months` calendar months before `day` (YYYY-MM-DD), clamped to the month's last day. */
export function monthsBefore(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

const share = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 1000 : null);

function solicitationBlock(entry, asOf) {
  if (!entry) {
    return {
      solicitations: { state: "available", reason: "no_solicitation_notices", notices: 0, source: CITY_RECORD_SOURCE, as_of: asOf },
      response_window: {
        state: "missing", reason: "no_solicitation_notices", median_calendar_days: null, eligible_notices: 0, total_notices: 0,
        usable_due_date_share: null, excluded: {}, small_sample: false, source: CITY_RECORD_SOURCE, as_of: asOf,
      },
    };
  }
  const m = entry.metrics;
  const w = m.response_window;
  const hasWindow = w.eligible_notices > 0;
  return {
    solicitations: { state: "available", reason: null, notices: m.solicitation_notices, source: CITY_RECORD_SOURCE, as_of: asOf },
    response_window: {
      state: hasWindow ? "available" : "missing",
      reason: hasWindow ? null : "no_usable_due_date",
      median_calendar_days: w.median_calendar_days,
      eligible_notices: w.eligible_notices,
      total_notices: w.total_notices,
      usable_due_date_share: share(w.eligible_notices, w.total_notices),
      excluded: w.excluded,
      small_sample: hasWindow && w.eligible_notices < AGENCY_HISTORY_SMALL_SAMPLE_BELOW,
      source: CITY_RECORD_SOURCE,
      as_of: asOf,
    },
  };
}

function contractsBlock(entry, asOf) {
  if (!entry) {
    return {
      state: "missing", reason: "no_registered_contracts", count: 0, amount_eligible: 0, missing_or_invalid_amount: 0,
      median_original_registered_amount: null, source: CONTRACTS_SOURCE, as_of: asOf,
    };
  }
  const m = entry.metrics;
  const has = m.amount_eligible > 0;
  return {
    state: has ? "available" : "missing",
    reason: has ? null : "no_contract_amounts",
    count: m.count,
    amount_eligible: m.amount_eligible,
    missing_or_invalid_amount: m.missing_or_invalid_amount,
    median_original_registered_amount: m.median_original_registered_amount,
    source: CONTRACTS_SOURCE,
    as_of: asOf,
  };
}

/**
 * Build the published artifact.
 *
 * @param {object} input
 * @param {object[]} input.notices City Record rows (type Solicitation) read for the window
 * @param {number} input.noticeCount the publisher's count for the same query
 * @param {string|null} input.rowsUpdatedAt publisher dataset update time (ISO), when readable
 * @param {object[]} input.contracts normalized registered contracts
 * @param {string} input.contractsSnapshotDate day of the registered-contract projection
 */
export function buildAgencyHistorySnapshot(
  { notices, noticeCount, rowsUpdatedAt = null, contracts, contractsSnapshotDate } = {},
  { now = new Date(), asOf = calendarDay(now), maxRows = AGENCY_HISTORY_MAX_ROWS, maxBytes = AGENCY_HISTORY_MAX_BYTES } = {},
) {
  if (!Array.isArray(notices)) throw new Error("agency history: notices must be an array");
  if (!Array.isArray(contracts)) throw new Error("agency history: contracts must be an array");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(contractsSnapshotDate || ""))) {
    throw new Error("agency history: the registered-contract snapshot date is required");
  }
  const windowStart = monthsBefore(asOf, AGENCY_HISTORY_WINDOW_MONTHS);
  const window = { start_inclusive: windowStart, end_exclusive: asOf };
  const reasons = [];
  if (notices.length > maxRows) reasons.push("row_cap");
  if (!reasons.includes("row_cap") && notices.length !== noticeCount) reasons.push("notice_count_mismatch");
  const read = notices.slice(0, maxRows);
  const invalid = read.filter((n) => !/^[0-9]{11}$/.test(String(n?.request_id || "")) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(String(n?.start_date || "")));
  if (invalid.length) reasons.push("invalid_notice_rows");
  const goodNotices = read.filter((n) => !invalid.includes(n));

  const notice = noticeMetricsByAgency(goodNotices, { windowStart, windowEnd: asOf });
  const contract = registeredContractMetricsByAgency(contracts, { windowStart, windowEnd: asOf });

  const cityRecordAsOf = rowsUpdatedAt ? calendarDay(rowsUpdatedAt) : asOf;
  const ids = new Set([...notice.keys(), ...contract.agencies.keys()].filter((id) => !NOT_ONE_AGENCY_IDS.includes(id)));
  const agencies = [...ids].sort().map((id) => {
    const n = notice.get(id) || null;
    const c = contract.agencies.get(id) || null;
    const identity = n ? n.matched : c.matched;
    const blocks = solicitationBlock(n, cityRecordAsOf);
    const engineName = n ? n.agency_name : c.agency_name;
    return {
      agency_id: id,
      agency_name: engineName,
      // The engine names a few agencies by a lower-case slug ("nyc health hospitals"); say the name as printed then.
      display_name: engineName === engineName.toLowerCase() ? (n ? n.spellings[0] : c.spellings[0]) : engineName,
      identity: identity ? "reviewed" : "not_reviewed",
      identity_note: identity ? null : "identity_not_reviewed",
      city_record_spellings: n ? n.spellings : [],
      checkbook_spellings: c ? c.spellings : [],
      solicitations: blocks.solicitations,
      response_window: blocks.response_window,
      registered_contracts: contractsBlock(c, contractsSnapshotDate),
    };
  });

  const tally = (pick, state) => agencies.filter((a) => pick(a).state === state).length;
  const payload = {
    schema: AGENCY_HISTORY_SCHEMA,
    schema_version: 1,
    delivery_tier: "inline-at-build",
    rule_version: AGENCY_HISTORY_RULE_VERSION,
    generated_at: new Date(now).toISOString(),
    as_of: asOf,
    window: { months: AGENCY_HISTORY_WINDOW_MONTHS, ...window },
    sources: {
      city_record: {
        ...CITY_RECORD_SOURCE,
        dataset: CITY_RECORD_DATASET,
        url: `https://data.cityofnewyork.us/d/${CITY_RECORD_DATASET}`,
        as_of: cityRecordAsOf,
        rows_updated_at: rowsUpdatedAt ? new Date(rowsUpdatedAt).toISOString() : null,
        query: "Procurement-section Solicitation notices with a start_date inside the window",
      },
      registered_contracts: {
        ...CONTRACTS_SOURCE,
        artifact: "site/data/analytics_registered_contracts.json",
        as_of: contractsSnapshotDate,
      },
    },
    definitions: {
      solicitation_notice: "One City Record Solicitation notice, counted once per request_id, by its publication (start) date.",
      response_window: "Calendar days from the notice's publication date to its printed due date. Blank or invalid due dates, rolling placeholders (year 2090 or later) and due dates before publication are left out and counted in `excluded`.",
      usable_due_date_share: "Notices with a usable due date divided by all the agency's solicitation notices in the window.",
      registered_contract: "One Checkbook NYC registered contract, counted once per prime contract id, by its registration date. The amount is the original registered amount, not an award and not a payment.",
      median_original_registered_amount: "Median of the original registered amounts of the contracts counted in amount_eligible.",
      agency_identity: "Agencies are named by the engine's canonical agency id. A name the engine has not reviewed keeps its own id and is marked identity not_reviewed.",
    },
    reasons: AGENCY_HISTORY_REASONS,
    bounds: {
      max_rows: maxRows,
      max_bytes: maxBytes,
      small_sample_below: AGENCY_HISTORY_SMALL_SAMPLE_BELOW,
    },
    checkbook_spelling_review: Object.fromEntries(
      Object.entries(CHECKBOOK_SPELLING_REVIEW).map(([name, row]) => [name, { agency_id: row.agency_id, basis: row.basis }]),
    ),
    population: {
      state: reasons.length ? "incomplete" : "complete",
      reasons,
      notice_source_count: noticeCount,
      notices_read: notices.length,
      notices_in_window_counted: [...notice.entries()].filter(([id]) => !NOT_ONE_AGENCY_IDS.includes(id)).reduce((s, [, e]) => s + e.metrics.solicitation_notices, 0),
      notices_unassigned: Object.fromEntries([...notice.entries()].filter(([id]) => NOT_ONE_AGENCY_IDS.includes(id)).map(([id, e]) => [id, e.metrics.solicitation_notices])),
      contract_rows_read: contracts.length,
      contracts_in_window_counted: [...contract.agencies.values()].reduce((s, e) => s + e.metrics.count, 0),
      contracts_unassigned: contract.unassigned,
    },
    coverage: {
      agencies: agencies.length,
      identity_not_reviewed: agencies.filter((a) => a.identity === "not_reviewed").length,
      with_solicitation_notices: agencies.filter((a) => a.solicitations.notices > 0).length,
      with_response_window: tally((a) => a.response_window, "available"),
      with_registered_contracts: agencies.filter((a) => a.registered_contracts.count > 0).length,
      with_contract_median: tally((a) => a.registered_contracts, "available"),
    },
    count: agencies.length,
    agencies,
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`);
  if (bytes > maxBytes) throw new Error(`agency history: ${bytes} bytes exceeds the ${maxBytes}-byte bound; last good artifact retained`);
  return payload;
}

function whereFor(windowStart, windowEnd) {
  return `section_name='Procurement' AND type_of_notice_description='Solicitation' AND start_date>='${windowStart}T00:00:00' AND start_date<'${windowEnd}T00:00:00'`;
}

export function agencyHistoryQuery(windowStart, windowEnd, { limit }) {
  return {
    $select: AGENCY_HISTORY_NOTICE_FIELDS.join(","),
    $where: whereFor(windowStart, windowEnd),
    $order: "start_date ASC, request_id ASC",
    $limit: String(limit),
  };
}

export function agencyHistoryCountQuery(windowStart, windowEnd) {
  return { $select: "count(*) AS n", $where: whereFor(windowStart, windowEnd) };
}

/**
 * Count, then one bounded page of the window's solicitation notices, then the dataset's own update
 * time, through the shared retrying fetch. A failed request or an empty pull throws, so the caller
 * keeps the last good artifact. An unreadable update time is not fatal: the read day stands in.
 */
export async function fetchAgencyHistoryNotices(
  fetchImpl = fetch,
  { asOf, maxRows = AGENCY_HISTORY_MAX_ROWS, ...options } = {},
) {
  const windowStart = monthsBefore(asOf, AGENCY_HISTORY_WINDOW_MONTHS);
  const countBody = await fetchJson(fetchImpl, sodaUrl(CITY_RECORD_DATASET, agencyHistoryCountQuery(windowStart, asOf)), options);
  const noticeCount = Number(Array.isArray(countBody) ? countBody[0]?.n : Number.NaN);
  if (!Number.isInteger(noticeCount) || noticeCount < 0) throw new Error("agency history count SODA returned no whole-number count");
  const notices = await fetchJson(fetchImpl, sodaUrl(CITY_RECORD_DATASET, agencyHistoryQuery(windowStart, asOf, { limit: maxRows + 1 })), options);
  if (!Array.isArray(notices)) throw new Error("agency history SODA returned a non-array");
  if (!notices.length) throw new Error("agency history SODA returned no rows; last good artifact retained");
  let rowsUpdatedAt = null;
  try {
    const meta = await fetchJson(fetchImpl, `https://data.cityofnewyork.us/api/views/${CITY_RECORD_DATASET}.json`, options);
    if (Number.isFinite(meta?.rowsUpdatedAt)) rowsUpdatedAt = new Date(meta.rowsUpdatedAt * 1000).toISOString();
  } catch {
    rowsUpdatedAt = null;
  }
  return { notices, noticeCount, rowsUpdatedAt };
}
