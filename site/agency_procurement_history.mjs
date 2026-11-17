// Agency purchasing-history reducer: published solicitation notices and
// registered-contract metrics for a canonical agency over a fixed window. The
// per-notice and per-contract reducers are agency-neutral; an agency is named
// by the engine's canonical agency id (site/agency_identity.mjs), never by one
// hard-coded spelling.
//
// Units are exact: a distinct request_id per published notice and a unique
// prime_contract_id per registered contract. The median is the median
// original registered contract value, never an award median or a predicted
// bid size. A source family that is unavailable yields null values while an
// independently successful family stays visible and dated; a complete empty
// cohort is zero with a null median, never unavailable.
import { createHash } from 'node:crypto';
import { reconcileAgencyIdentity } from './agency_identity.mjs';

export const DYCD_AGENCY_ID = 'youth-and-community-development';
export const DYCD_CHECKBOOK_AGENCY = 'Department of Youth and Community Development';
// Reviewed Checkbook spellings the shared identity does not recognise. Checkbook prints agency names
// in its own style ("Health and Hospitals Corporation"), so a name the City Record group list never
// saw is read here against the body the City Record calls the same thing. Each row is a reviewed
// statement of identity, not a similarity match; a Checkbook name absent from this list and from the
// engine's reviewed groups keeps its own minted id and is published as not reviewed.
export const CHECKBOOK_SPELLING_REVIEW = Object.freeze({
  'Health and Hospitals Corporation': Object.freeze({
    agency_id: 'nyc-health-hospitals',
    agency_name: 'NYC Health + Hospitals',
    basis: 'The engine already routes the longer form "NYC Health and Hospitals Corporation" to this id; Checkbook prints the same public benefit corporation without the NYC prefix.',
  }),
  'City University of New York': Object.freeze({
    agency_id: 'city-university',
    agency_name: 'City University',
    basis: 'The City Record prints the body as "City University"; Checkbook spells out the full name. The separate "City University Construction Fund" is not mapped.',
  }),
});

// Groups of distinct bodies the shared identity folds into one id. An agency record for them would add
// up unrelated bodies, so they are left out of the by-agency history and counted.
export const NOT_ONE_AGENCY_IDS = Object.freeze(['community-boards']);

const identityOf = (name) => {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  return reconcileAgencyIdentity(raw, []);
};
/** The agency a City Record `agency_name` belongs to: {agency_id, agency_name, matched} or null. */
export function cityRecordAgency(name) {
  const i = identityOf(name);
  return i ? { agency_id: i.canonical_id, agency_name: i.canonical_name, matched: Boolean(i.matched) } : null;
}
/** The agency a Checkbook `agency` belongs to, with the reviewed Checkbook spellings applied. */
export function checkbookAgency(name) {
  const raw = String(name ?? '').trim();
  const review = CHECKBOOK_SPELLING_REVIEW[raw];
  if (review) {
    return { agency_id: review.agency_id, agency_name: review.agency_name, matched: true, review_basis: review.basis };
  }
  const i = identityOf(raw);
  return i ? { agency_id: i.canonical_id, agency_name: i.canonical_name, matched: Boolean(i.matched) } : null;
}
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

// One notice per request_id inside the window. A request_id seen twice must be the same row.
function collectNotices(notices, { windowStart, windowEnd }, accept) {
  const unique = new Map();
  for (const n of notices) {
    if ((n.type_of_notice_description ?? n.type_of_notice) !== 'Solicitation') continue;
    if (!accept(n)) continue;
    const start = dayOf(n.start_date);
    if (!(start >= windowStart && start < windowEnd)) continue;
    const key = String(n.request_id ?? '');
    if (!key) throw Error('notice_without_identity');
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(n)) throw Error('conflicting_notice_observations');
    unique.set(key, n);
  }
  return unique;
}

function reduceNotices(unique) {
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

// Distinct published solicitation notices and the publication-to-due
// response window for one canonical agency (DYCD unless agencyId says
// otherwise). Rolling placeholder deadlines (year 2090+) and invalid
// dates are explicit exclusions, never silent drops.
export function noticeMetrics(notices, { windowStart, windowEnd, agencyId = DYCD_AGENCY_ID }) {
  return reduceNotices(collectNotices(notices, { windowStart, windowEnd }, n => cityRecordAgency(n.agency_name ?? n.agency)?.agency_id === agencyId));
}

// The same reduction for every agency at once: canonical agency id to
// {agency_name, matched, spellings, metrics}. One notice belongs to exactly one agency.
export function noticeMetricsByAgency(notices, { windowStart, windowEnd }) {
  const unique = collectNotices(notices, { windowStart, windowEnd }, () => true);
  const groups = new Map();
  for (const n of unique.values()) {
    const a = cityRecordAgency(n.agency_name ?? n.agency);
    if (!a) continue;
    if (!groups.has(a.agency_id)) groups.set(a.agency_id, { ...a, spellings: new Set(), rows: new Map() });
    const g = groups.get(a.agency_id);
    g.spellings.add(String(n.agency_name ?? n.agency).trim());
    g.rows.set(String(n.request_id), n);
  }
  const out = new Map();
  for (const [id, g] of groups) {
    out.set(id, { agency_id: id, agency_name: g.agency_name, matched: g.matched, spellings: [...g.spellings].sort(), metrics: reduceNotices(g.rows) });
  }
  return out;
}

function collectContracts(rows, { windowStart, windowEnd }, accept) {
  const unique = new Map();
  for (const r of rows) {
    if (!accept(r)) continue;
    const registered = String(r.registration_date ?? '');
    if (!(registered >= windowStart && registered < windowEnd)) continue;
    const key = r.prime_contract_id;
    if (!key) throw Error('contract_without_identity');
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(r)) throw Error('conflicting_normalized_contract');
    unique.set(key, r);
  }
  return unique;
}

function reduceContracts(unique) {
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
    contributor_ids: [...unique.keys()].sort(),
  };
}

// Unique prime contracts registered in the window with the median original
// registered value. Fiscal-year partition duplicates never inflate the
// count; a conflicting observation of one identity throws for resolution.
export function registeredContractMetrics(rows, { windowStart, windowEnd, observedAt, agency = DYCD_CHECKBOOK_AGENCY }) {
  const r = reduceContracts(collectContracts(rows, { windowStart, windowEnd }, row => row.agency === agency));
  return {
    ...r,
    observed_at: observedAt,
    current_claim_allowed: (Date.parse(windowEnd) - Date.parse(observedAt)) / DAY <= STALE_AFTER_DAYS,
  };
}

// The same reduction for every agency at once, grouped by canonical agency id through the Checkbook
// reading of the agency name. Contracts whose name resolves to a group of distinct bodies are counted
// in `unassigned`, not attributed.
export function registeredContractMetricsByAgency(rows, { windowStart, windowEnd }) {
  const unique = collectContracts(rows, { windowStart, windowEnd }, () => true);
  const groups = new Map();
  const unassigned = {};
  for (const r of unique.values()) {
    const a = checkbookAgency(r.agency);
    if (!a || NOT_ONE_AGENCY_IDS.includes(a.agency_id)) {
      const k = a ? a.agency_id : 'no_agency_name';
      unassigned[k] = (unassigned[k] || 0) + 1;
      continue;
    }
    if (!groups.has(a.agency_id)) groups.set(a.agency_id, { ...a, spellings: new Set(), rows: new Map() });
    const g = groups.get(a.agency_id);
    g.spellings.add(String(r.agency).trim());
    g.rows.set(r.prime_contract_id, r);
  }
  const out = new Map();
  for (const [id, g] of groups) {
    out.set(id, { agency_id: id, agency_name: g.agency_name, matched: g.matched, review_basis: g.review_basis ?? null, spellings: [...g.spellings].sort(), metrics: reduceContracts(g.rows) });
  }
  return { agencies: out, unassigned };
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
