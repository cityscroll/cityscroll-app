// Agency purchasing-history reducer: published solicitation notices and
// registered-contract metrics for one canonical agency over a fixed window.
//
// Units are exact: a distinct request_id per published notice and a unique
// prime_contract_id per registered contract. The median is the median
// original registered contract value, never an award median or a predicted
// bid size. A source family that is unavailable yields null values while an
// independently successful family stays visible and dated; a complete empty
// cohort is zero with a null median, never unavailable.
import { createHash } from 'node:crypto';

export const DYCD_AGENCY_ID = 'youth-and-community-development';
export const DYCD_CHECKBOOK_AGENCY = 'Department of Youth and Community Development';
const CITY_RECORD_ALIASES = new Set(['DEPT OF YOUTH & COMM DEV SRVS', 'Youth and Community Development']);
export const STALE_AFTER_DAYS = 45;

const DAY = 86400000;
export const isoDay = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
const dayOf = value => String(value || '').slice(0, 10);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Distinct published solicitation notices and the publication-to-due
// response window. Rolling placeholder deadlines (year 2090+) and invalid
// dates are explicit exclusions, never silent drops.
export function noticeMetrics(notices, { windowStart, windowEnd }) {
  const unique = new Map();
  for (const n of notices) {
    if (!CITY_RECORD_ALIASES.has(n.agency_name ?? n.agency)) continue;
    if ((n.type_of_notice_description ?? n.type_of_notice) !== 'Solicitation') continue;
    const start = dayOf(n.start_date);
    if (!(start >= windowStart && start < windowEnd)) continue;
    const key = String(n.request_id ?? '');
    if (!key) throw Error('notice_without_identity');
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(n)) throw Error('conflicting_notice_observations');
    unique.set(key, n);
  }
  const windows = [];
  const excluded = {};
  const reject = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  for (const n of unique.values()) {
    const due = dayOf(n.due_date), start = dayOf(n.start_date);
    if (!isoDay(due) || !isoDay(start)) { reject('missing_or_invalid_due_date'); continue; }
    if (Number(due.slice(0, 4)) >= 2090) { reject('rolling_deadline_placeholder'); continue; }
    const days = (Date.parse(due) - Date.parse(start)) / DAY;
    if (days < 0) { reject('deadline_before_publication'); continue; }
    windows.push(days);
  }
  return {
    solicitation_notices: unique.size,
    response_window: {
      median_calendar_days: median(windows),
      eligible_notices: windows.length,
      total_notices: unique.size,
      excluded,
      label: 'Median published response window',
    },
    contributor_ids: [...unique.keys()].sort(),
  };
}

// Unique prime contracts registered in the window with the median original
// registered value. Fiscal-year partition duplicates never inflate the
// count; a conflicting observation of one identity throws for resolution.
export function registeredContractMetrics(rows, { windowStart, windowEnd, observedAt, agency = DYCD_CHECKBOOK_AGENCY }) {
  const unique = new Map();
  for (const r of rows) {
    if (r.agency !== agency) continue;
    const registered = String(r.registration_date ?? '');
    if (!(registered >= windowStart && registered < windowEnd)) continue;
    const key = r.prime_contract_id;
    if (!key) throw Error('contract_without_identity');
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(r)) throw Error('conflicting_normalized_contract');
    unique.set(key, r);
  }
  const values = [];
  for (const r of unique.values()) {
    const v = r.original_registered_amount;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e10) values.push(v);
  }
  return {
    count: unique.size,
    amount_eligible: values.length,
    missing_or_invalid_amount: unique.size - values.length,
    median_original_registered_amount: median(values),
    label: 'Median original registered contract value',
    observed_at: observedAt,
    current_claim_allowed: (Date.parse(windowEnd) - Date.parse(observedAt)) / DAY <= STALE_AFTER_DAYS,
    contributor_ids: [...unique.keys()].sort(),
  };
}

// Family-standing contract: an unavailable family is excluded before
// reduction and reports null; stale standing forbids a current claim even
// with a recent observation date.
export function historyWithStanding({ notices, contracts, noticeStatus, contractStatus, contractsObservedAt, windowStart, windowEnd }) {
  const allowed = new Set(['available', 'stale', 'unavailable']);
  if (!allowed.has(noticeStatus) || !allowed.has(contractStatus)) throw Error('invalid_source_status');
  if (noticeStatus !== 'unavailable' && !Array.isArray(notices)) throw Error('notice_rows_required');
  if (contractStatus !== 'unavailable' && !Array.isArray(contracts)) throw Error('contract_rows_required');
  if (contractStatus !== 'unavailable' && !contractsObservedAt) throw Error('contract_observation_date_required');
  const result = {
    window: { start_inclusive: windowStart, end_exclusive: windowEnd },
    source_status: { 'city-record': noticeStatus, 'checkbook-contracts': contractStatus },
    solicitation_notices: null,
    response_window: null,
    registered_contracts: null,
    notice_contributor_ids: null,
  };
  if (noticeStatus !== 'unavailable') {
    const n = noticeMetrics(notices, { windowStart, windowEnd });
    result.solicitation_notices = n.solicitation_notices;
    result.response_window = n.response_window;
    result.notice_contributor_ids = n.contributor_ids;
  }
  if (contractStatus !== 'unavailable') {
    const c = registeredContractMetrics(contracts, { windowStart, windowEnd, observedAt: contractsObservedAt });
    if (contractStatus === 'stale') c.current_claim_allowed = false;
    result.registered_contracts = c;
  }
  return result;
}

export const contributorHash = ids => createHash('sha256').update(JSON.stringify([...ids].sort()) + '\n').digest('hex');
