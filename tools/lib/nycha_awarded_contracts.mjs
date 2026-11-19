// Acquire NYCHA's public Awarded Contracts list and keep a dated, checked snapshot of it.
//
// NYCHA publishes the list on a page that is fed by an open JSON endpoint:
//   https://my.nycha.info/PublicSite/Transparency/GetAwardedContracts?ContractYear=<year>
// The endpoint is the page's own back end. It needs no login and showed no bot challenge when read;
// NYCHA publishes no terms for it beyond the City-wide terms of use linked from the page. We read it
// once a day, one request per contract year, spaced apart, and never try to get past a challenge: a
// response that is not the expected JSON is a failed pull.
//
// Every pull is checked against the shape this module reads. A pull that passes replaces the retained
// snapshot. A pull that fails (network, not JSON, shape changed, row counts out of band) leaves the
// last good snapshot in place and records, in the snapshot itself, that the list in use is that
// earlier one, why, and when it was last read. With no earlier snapshot a failed pull throws.
//
// What is retained: the contract number, the RFQ number as printed and the leading number read from
// it, the vendor as printed, the listed total, the contract start date, the procurement method, the
// status and the contract year. The free-text description, the location and the amount spent are not
// retained: descriptions name NYCHA staff and the rest is not needed to link a notice to a contract.
//
// Pure functions plus one bounded, sequential fetch. No DOM, no markup.

import { createHash } from "node:crypto";

export const NYCHA_SNAPSHOT_SCHEMA = "cityscroll.nycha_awarded_contracts_snapshot.v1";
export const NYCHA_SOURCE_ID = "nycha_awarded_contracts";
export const NYCHA_PAGE_URL = "https://my.nycha.info/PublicSite/Transparency/AwardedContracts";
export const NYCHA_FEED_URL = "https://my.nycha.info/PublicSite/Transparency/GetAwardedContracts";
export const NYCHA_TERMS_URL = "https://www1.nyc.gov/home/terms-of-use.page";
export const NYCHA_WINDOW_START_YEAR = 2023;
export const NYCHA_USER_AGENT = "cityscroll-nycha-awarded-contracts/1.0";
export const NYCHA_REQUEST_DELAY_MS = 2000;
export const NYCHA_MAX_BODY_BYTES = 3 * 1024 * 1024;
export const NYCHA_MAX_ATTEMPTS = 3;
export const NYCHA_MIN_TOTAL_ROWS = 200;
// Row-count band against the last good snapshot: the list grows as contracts start, and a pull far
// outside this band is treated as a changed feed, not as news.
export const NYCHA_ROW_BAND = Object.freeze({ min_ratio: 0.8, max_ratio: 1.5 });
// A closed contract year may not lose more than a tenth of its rows between pulls.
export const NYCHA_CLOSED_YEAR_MIN_RATIO = 0.9;
export const NYCHA_RFQ_SHAPE_MIN_SHARE = 0.9;
// A snapshot older than this is not used to say a notice is absent from the list.
export const NYCHA_SNAPSHOT_MAX_AGE_DAYS = 30;

export const NYCHA_REQUIRED_FIELDS = Object.freeze([
  "ContractNumber",
  "RFQNumber",
  "VendorName",
  "TotalAmount",
  "StartDateDisplay",
  "ContractYear",
  "ProcurementMethod",
  "ContractStatus",
]);

export const NYCHA_FALLBACK_REASONS = Object.freeze({
  feed_unreachable: "NYCHA's list could not be fetched.",
  feed_not_json: "NYCHA's list did not answer with JSON.",
  feed_shape_changed: "NYCHA's list no longer has the shape this reader checks.",
});

const RFQ_NUMBER = /^([0-9]{5,7})(?:[,-].*)?$/;
const DISPLAY_DATE = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/;

/** The leading 5-7 digit number of a printed RFQ number ("304842,3" gives "304842"), or null (N/A, blank). */
export function rfqNumberOf(printed) {
  if (typeof printed !== "string") return null;
  const match = RFQ_NUMBER.exec(printed.trim());
  return match ? match[1] : null;
}

/** MM/DD/YYYY as NYCHA prints it to an ISO day, or "" when it is not a real date. */
export function nychaDay(display) {
  const match = DISPLAY_DATE.exec(typeof display === "string" ? display.trim() : "");
  if (!match) return "";
  const [, month, dayOfMonth, year] = match;
  const iso = `${year}-${month}-${dayOfMonth}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? "" : iso;
}

export function nychaFeedYears(now = new Date()) {
  const last = new Date(now).getUTCFullYear() + 1;
  const years = [];
  for (let year = NYCHA_WINDOW_START_YEAR; year <= last; year += 1) years.push(year);
  return years;
}

export function nychaFeedUrl(year) {
  return `${NYCHA_FEED_URL}?ContractYear=${encodeURIComponent(String(year))}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Check what a pull returned against the shape this reader needs. Extra fields are fine; a missing or
 * differently typed field, a body that is not {data: [...]}, an RFQ column that stopped looking like
 * RFQ numbers, or counts outside the band all fail. Returns { ok, problems }.
 *
 * @param {Array<{year: number, body: any}>} pulls
 * @param {{ previous?: object|null, now?: Date }} options
 */
export function checkNychaFeedShape(pulls, { previous = null, now = new Date(), minRows = NYCHA_MIN_TOTAL_ROWS } = {}) {
  const problems = [];
  let total = 0;
  let rfqPrinted = 0;
  let rfqShaped = 0;
  const yearCounts = {};
  for (const { year, body } of pulls) {
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.data)) {
      problems.push(`year ${year}: body is not an object with a data array`);
      continue;
    }
    yearCounts[year] = body.data.length;
    total += body.data.length;
    const reported = new Set();
    for (const row of body.data) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        if (!reported.has("row")) problems.push(`year ${year}: a row is not an object`);
        reported.add("row");
        continue;
      }
      for (const field of NYCHA_REQUIRED_FIELDS) {
        if (!(field in row) && !reported.has(`missing:${field}`)) {
          problems.push(`year ${year}: field ${field} is missing`);
          reported.add(`missing:${field}`);
        }
      }
      const checks = [
        ["ContractNumber", typeof row.ContractNumber === "string" && row.ContractNumber.trim() !== ""],
        ["RFQNumber", typeof row.RFQNumber === "string"],
        ["VendorName", typeof row.VendorName === "string"],
        ["TotalAmount", row.TotalAmount === null || typeof row.TotalAmount === "number"],
        ["StartDateDisplay", nychaDay(row.StartDateDisplay) !== ""],
        ["ContractYear", String(row.ContractYear) === String(year)],
      ];
      for (const [field, good] of checks) {
        if (field in row && !good && !reported.has(`type:${field}`)) {
          problems.push(`year ${year}: field ${field} has an unexpected value or type`);
          reported.add(`type:${field}`);
        }
      }
      const printed = typeof row.RFQNumber === "string" ? row.RFQNumber.trim() : "";
      if (printed && printed.toUpperCase() !== "N/A") {
        rfqPrinted += 1;
        if (rfqNumberOf(printed)) rfqShaped += 1;
      }
    }
  }
  if (!problems.length) {
    if (total < minRows) problems.push(`only ${total} rows read; at least ${minRows} expected`);
    if (rfqPrinted > 0 && rfqShaped / rfqPrinted < NYCHA_RFQ_SHAPE_MIN_SHARE) {
      problems.push(`only ${rfqShaped} of ${rfqPrinted} RFQ numbers have the 5-7 digit shape`);
    }
    const prevCount = Number(previous?.count);
    if (Number.isFinite(prevCount) && prevCount > 0) {
      if (total < prevCount * NYCHA_ROW_BAND.min_ratio || total > prevCount * NYCHA_ROW_BAND.max_ratio) {
        problems.push(`${total} rows is outside the band of ${Math.floor(prevCount * NYCHA_ROW_BAND.min_ratio)} to ${Math.ceil(prevCount * NYCHA_ROW_BAND.max_ratio)} around the last good ${prevCount}`);
      }
      const thisYear = new Date(now).getUTCFullYear();
      for (const entry of previous?.feed?.years || []) {
        if (entry.year < thisYear && Number.isFinite(entry.row_count) && entry.row_count > 0) {
          const now_ = yearCounts[entry.year];
          if (now_ === undefined || now_ < entry.row_count * NYCHA_CLOSED_YEAR_MIN_RATIO) {
            problems.push(`closed year ${entry.year} fell from ${entry.row_count} to ${now_ ?? 0} rows`);
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Retained rows from checked pulls: only the fields the join needs, sorted and de-duplicated. */
export function normalizeNychaRows(pulls) {
  const seen = new Set();
  const rows = [];
  for (const { body } of pulls) {
    for (const raw of body.data) {
      const contractNumber = String(raw.ContractNumber).trim();
      const start = nychaDay(raw.StartDateDisplay);
      const key = `${contractNumber}|${start}|${String(raw.RFQNumber).trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const printed = String(raw.RFQNumber).trim();
      rows.push({
        contract_number: contractNumber,
        rfq_number_printed: printed,
        rfq_number: rfqNumberOf(printed),
        vendor_name: String(raw.VendorName).trim() || null,
        total_amount: typeof raw.TotalAmount === "number" ? raw.TotalAmount : null,
        start_date: start,
        contract_year: Number(raw.ContractYear),
        procurement_method: typeof raw.ProcurementMethod === "string" ? raw.ProcurementMethod.trim() || null : null,
        contract_status: typeof raw.ContractStatus === "string" ? raw.ContractStatus.trim() || null : null,
      });
    }
  }
  rows.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.contract_number.localeCompare(b.contract_number));
  return rows;
}

function sourceBlock() {
  return {
    id: NYCHA_SOURCE_ID,
    name: "NYCHA Awarded Contracts",
    owner: "New York City Housing Authority",
    page_url: NYCHA_PAGE_URL,
    feed_url_template: `${NYCHA_FEED_URL}?ContractYear=<year>`,
    terms_note: "No terms specific to this list were found. The page links the City-wide terms of use. The endpoint is the page's own back end and is not documented as an API.",
    terms_url: NYCHA_TERMS_URL,
    start_date_note: "NYCHA prints the contract start date, not an award date.",
    amount_note: "Total is the contract total as listed, often a ceiling for multi-year or IDIQ contracts. It is not a payment.",
  };
}

function liveSnapshot({ pulls, raws, now, rows }) {
  const fetchedAt = new Date(now).toISOString();
  return {
    schema: NYCHA_SNAPSHOT_SCHEMA,
    schema_version: 1,
    // as_of is the day the retained rows were read; generated_at is when this file was last written.
    // On a fallback as_of stays at the last good read while generated_at moves.
    as_of: fetchedAt.slice(0, 10),
    generated_at: fetchedAt,
    source: sourceBlock(),
    feed: {
      state: "live",
      fetched_at: fetchedAt,
      checked_at: fetchedAt,
      fallback_reason: null,
      fallback_text: null,
      shape_problems: [],
      years: pulls.map(({ year, body }, index) => ({
        year,
        url: raws[index].url,
        fetched_at: raws[index].fetched_at,
        bytes: raws[index].bytes,
        sha256: raws[index].sha256,
        row_count: body.data.length,
      })),
    },
    window: { contract_years_from: NYCHA_WINDOW_START_YEAR },
    count: rows.length,
    rfq_numbered_count: rows.filter((row) => row.rfq_number).length,
    rows,
  };
}

/** The last good snapshot, kept as it was, with a record that the latest pull was not used and why. */
export function fallbackNychaSnapshot(previous, { now = new Date(), reason, problems = [] } = {}) {
  const checkedAt = new Date(now).toISOString();
  return {
    ...previous,
    generated_at: checkedAt,
    feed: {
      ...previous.feed,
      state: "snapshot_fallback",
      checked_at: checkedAt,
      fallback_reason: reason,
      fallback_text: NYCHA_FALLBACK_REASONS[reason] || "NYCHA's list was not used.",
      shape_problems: problems.slice(0, 10),
    },
  };
}

class NychaPullError extends Error {
  constructor(reason, message, problems = []) {
    super(message);
    this.reason = reason;
    this.problems = problems;
  }
}

async function pullOne(fetchImpl, year, { sleep, now }) {
  const url = nychaFeedUrl(year);
  let lastError;
  for (let attempt = 1; attempt <= NYCHA_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": NYCHA_USER_AGENT } });
      if (!response.ok) {
        const error = new NychaPullError("feed_unreachable", `fetch ${url} returned HTTP ${response.status}`);
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > NYCHA_MAX_BODY_BYTES) {
        throw new NychaPullError("feed_shape_changed", `${url} returned ${buffer.length} bytes, over the ${NYCHA_MAX_BODY_BYTES}-byte bound`);
      }
      let body;
      try {
        body = JSON.parse(buffer.toString("utf8"));
      } catch {
        // A page, a challenge or an error screen. Not retried and never worked around.
        throw new NychaPullError("feed_not_json", `${url} did not return JSON`);
      }
      return { body, raw: { url, bytes: buffer.length, sha256: sha256(buffer), fetched_at: new Date(now()).toISOString() } };
    } catch (error) {
      lastError = error;
      const retryable = error?.reason === undefined || error.retryable === true;
      if (!retryable || attempt >= NYCHA_MAX_ATTEMPTS) break;
      await sleep(1000 * attempt);
    }
  }
  if (lastError instanceof NychaPullError) throw lastError;
  throw new NychaPullError("feed_unreachable", `fetch ${url} failed: ${lastError?.message || lastError}`);
}

/**
 * Pull every contract year, one request at a time with a pause between, and return the raw pulls.
 * Throws a NychaPullError carrying a reason code on the first failure.
 */
export async function fetchNychaFeed(
  fetchImpl = fetch,
  { now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), delayMs = NYCHA_REQUEST_DELAY_MS } = {},
) {
  const pulls = [];
  const raws = [];
  const years = nychaFeedYears(now());
  for (let i = 0; i < years.length; i += 1) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    const { body, raw } = await pullOne(fetchImpl, years[i], { sleep, now });
    pulls.push({ year: years[i], body });
    raws.push(raw);
  }
  return { pulls, raws };
}

/**
 * Pull, check and return the snapshot to retain. A good pull is a live snapshot. Any failure with an
 * earlier snapshot returns that snapshot marked as a fallback; with none it throws.
 *
 * @param {{ fetchImpl?: Function, now?: Date, previous?: object|null, sleep?: Function, delayMs?: number, minRows?: number }} options
 */
export async function acquireNychaAwardedContracts({ fetchImpl = fetch, now = new Date(), previous = null, sleep, delayMs, minRows } = {}) {
  const usablePrevious = previous?.schema === NYCHA_SNAPSHOT_SCHEMA && Array.isArray(previous.rows) && previous.rows.length ? previous : null;
  let failure;
  try {
    const { pulls, raws } = await fetchNychaFeed(fetchImpl, { now: () => now, sleep, delayMs });
    const shape = checkNychaFeedShape(pulls, { previous: usablePrevious, now, minRows });
    if (shape.ok) {
      return liveSnapshot({ pulls, raws, now, rows: normalizeNychaRows(pulls) });
    }
    failure = new NychaPullError("feed_shape_changed", `shape check failed: ${shape.problems.join("; ")}`, shape.problems);
  } catch (error) {
    failure = error instanceof NychaPullError ? error : new NychaPullError("feed_unreachable", String(error?.message || error));
  }
  if (!usablePrevious) {
    throw new Error(`NYCHA awarded contracts: ${failure.reason}: ${failure.message}; no earlier snapshot to fall back to`);
  }
  return fallbackNychaSnapshot(usablePrevious, { now, reason: failure.reason, problems: failure.problems.length ? failure.problems : [failure.message] });
}

/**
 * How the join may use a snapshot on a given day.
 * state: live | snapshot_fallback | unavailable. usable: false when there is no snapshot, or when a
 * fallback is older than the age limit, so "not on the list" is never said from a stale list.
 */
export function nychaSnapshotUse(snapshot, asOf) {
  if (!snapshot || snapshot.schema !== NYCHA_SNAPSHOT_SCHEMA || !Array.isArray(snapshot.rows) || !snapshot.rows.length) {
    return { state: "unavailable", usable: false, age_days: null, reason: "no_snapshot" };
  }
  const fetchedDay = String(snapshot.feed?.fetched_at || "").slice(0, 10);
  const ageDays = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fetchedDay)
    ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${fetchedDay}T00:00:00Z`)) / 86400000)
    : null;
  const state = snapshot.feed?.state === "snapshot_fallback" ? "snapshot_fallback" : "live";
  if (ageDays === null) return { state: "unavailable", usable: false, age_days: null, reason: "no_fetch_date" };
  if (state === "snapshot_fallback" && ageDays > NYCHA_SNAPSHOT_MAX_AGE_DAYS) {
    return { state: "unavailable", usable: false, age_days: ageDays, reason: "snapshot_too_old" };
  }
  return { state, usable: true, age_days: ageDays, reason: null };
}
