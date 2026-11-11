import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as m from '../site/agency_procurement_history.mjs';

const read = n => JSON.parse(readFileSync(new URL('../warehouse/fixtures/agency-procurement-history/' + n, import.meta.url)));
const NOTICES = read('dycd-solicitations-24months.raw.json');
const CONTRACTS = read('dycd-registered-contracts-2026-09-09.json').rows;
const READBACK = read('engine-registered-contracts-readback-2026-11-10.json');
const WINDOW = { windowStart: '2024-11-11', windowEnd: '2026-11-11' };

test('retained September 9 fixture reproduces 2309 eligible and 410783 median', () => {
  const r = m.registeredContractMetrics(CONTRACTS, { ...WINDOW, observedAt: '2026-09-09' });
  assert.equal(r.count, 2309);
  assert.equal(r.amount_eligible, 2309);
  assert.equal(r.median_original_registered_amount, 410783);
  assert.equal(r.current_claim_allowed, false);
  assert.match(r.label, /original registered/);
});

test('accepted November 10 engine observation verifies against its recorded manifest hash', () => {
  assert.equal(READBACK.manifest_sha256, '8d1226cf1072deea57bd224c4a7cc8fbc986b572a7d79c67d42d053dffdfa32c');
  assert.equal(READBACK.manifest.generated_at, '2026-11-10T15:17:39.651Z');
  assert.equal(READBACK.actual_rows, 29581);
  assert.equal(READBACK.unique_ids, 29581);
  assert.equal(READBACK.selected_contracts, 2492);
  assert.equal(READBACK.eligible_amounts, 2492);
  assert.equal(READBACK.median_original_registered_amount, 436226);
  assert.deepEqual(READBACK.window, { start_inclusive: '2024-11-11', end_exclusive: '2026-11-11' });
  const ids = READBACK.examples.map(r => r.prime_contract_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(READBACK.examples.every(r => r.agency === 'Department of Youth and Community Development'));
});

test('retained notice fixture reproduces two solicitations and the 43 day median', () => {
  const n = m.noticeMetrics(NOTICES, WINDOW);
  assert.equal(n.solicitation_notices, 2);
  assert.equal(n.response_window.median_calendar_days, 43);
  assert.deepEqual(n.contributor_ids, [...n.contributor_ids].sort());
});

test('unavailable corpus keeps notice metrics null while Checkbook stays dated', () => {
  const r = m.historyWithStanding({
    notices: null, contracts: CONTRACTS,
    noticeStatus: 'unavailable', contractStatus: 'stale',
    contractsObservedAt: '2026-09-09', ...WINDOW,
  });
  assert.equal(r.solicitation_notices, null);
  assert.equal(r.response_window, null);
  assert.equal(r.registered_contracts.amount_eligible, 2309);
  assert.equal(r.registered_contracts.median_original_registered_amount, 410783);
  assert.equal(r.registered_contracts.current_claim_allowed, false);
});

test('complete empty cohort is zero with null median, never unavailable', () => {
  const r = m.historyWithStanding({
    notices: [], contracts: null,
    noticeStatus: 'available', contractStatus: 'unavailable', ...WINDOW,
  });
  assert.equal(r.solicitation_notices, 0);
  assert.equal(r.response_window.median_calendar_days, null);
  assert.equal(r.registered_contracts, null);
});

test('available standing requires rows and a contract observation date', () => {
  assert.throws(() => m.historyWithStanding({ notices: null, contracts: [], noticeStatus: 'available', contractStatus: 'available', contractsObservedAt: '2026-11-10', ...WINDOW }), /notice_rows_required/);
  assert.throws(() => m.historyWithStanding({ notices: [], contracts: [], noticeStatus: 'available', contractStatus: 'available', ...WINDOW }), /contract_observation_date_required/);
});

test('duplicate fiscal-year partition rows never inflate contract totals', () => {
  const a = m.registeredContractMetrics(CONTRACTS, { ...WINDOW, observedAt: '2026-09-09' });
  const b = m.registeredContractMetrics([...CONTRACTS, ...CONTRACTS], { ...WINDOW, observedAt: '2026-09-09' });
  assert.deepEqual(
    { count: b.count, median: b.median_original_registered_amount },
    { count: a.count, median: a.median_original_registered_amount },
  );
});

test('conflicting contract or notice identities refuse the reduction', () => {
  const c = { ...CONTRACTS[0], original_registered_amount: 1 };
  assert.throws(() => m.registeredContractMetrics([CONTRACTS[0], c], WINDOW), /conflicting_normalized_contract/);
  const n = { ...NOTICES[0], short_title: 'changed' };
  assert.throws(() => m.noticeMetrics([NOTICES[0], n], WINDOW), /conflicting_notice_observations/);
});

test('invalid dates, rolling deadlines and backwards windows are explicit exclusions', () => {
  const rows = ['', '2099-01-01', '2020-01-01'].map((due, i) => ({
    ...NOTICES[0], request_id: `x${i}`, due_date: due,
  }));
  const r = m.noticeMetrics(rows, WINDOW).response_window;
  assert.equal(r.median_calendar_days, null);
  assert.equal(r.excluded.missing_or_invalid_due_date, 1);
  assert.equal(r.excluded.rolling_deadline_placeholder, 1);
  assert.equal(r.excluded.deadline_before_publication, 1);
});

test('stale forty five day standing forbids a current claim even with a recent date', () => {
  const fresh = m.registeredContractMetrics(CONTRACTS, { ...WINDOW, observedAt: '2026-11-10' });
  assert.equal(fresh.current_claim_allowed, true);
  const stale = m.historyWithStanding({
    notices: [], contracts: CONTRACTS,
    noticeStatus: 'available', contractStatus: 'stale',
    contractsObservedAt: '2026-11-10', ...WINDOW,
  });
  assert.equal(stale.registered_contracts.current_claim_allowed, false);
  const old = m.registeredContractMetrics(CONTRACTS, { ...WINDOW, observedAt: '2026-09-09' });
  assert.equal(old.current_claim_allowed, false);
});

test('distinct request_id and prime_contract_id define separate units', () => {
  const two = m.noticeMetrics(NOTICES, WINDOW);
  assert.equal(two.contributor_ids.length, 2);
  assert.notEqual(two.contributor_ids[0], two.contributor_ids[1]);
  const rc = m.registeredContractMetrics(CONTRACTS, { ...WINDOW, observedAt: '2026-09-09' });
  assert.equal(new Set(rc.contributor_ids).size, rc.count);
});

test('built artifact is bounded, dated, and keeps unavailable families null', () => {
  const artifact = JSON.parse(readFileSync(new URL('../site/data/agency_procurement_history.json', import.meta.url)));
  assert.equal(artifact.schema, 'cityscroll.agency_procurement_history.v1');
  assert.equal(artifact.agency_id, 'youth-and-community-development');
  assert.deepEqual(artifact.window, { start_inclusive: '2024-11-11', end_exclusive: '2026-11-11' });
  assert.equal(artifact.solicitation_notices.status, 'unavailable');
  assert.equal(artifact.solicitation_notices.value, null);
  assert.equal(artifact.response_window.value, null);
  const rc = artifact.registered_contracts;
  assert.equal(rc.status, 'stale');
  assert.equal(rc.count, 2309);
  assert.equal(rc.median_original_registered_amount, 410783);
  assert.equal(rc.current_claim_allowed, false);
  assert.equal(rc.evidence.first25.length, 25);
  assert.deepEqual(rc.evidence.first25, [...rc.evidence.first25].sort());
  assert.equal(rc.evidence.contributor_count, 2309);
  const eligibleIds = CONTRACTS
    .filter(r => r.agency === 'Department of Youth and Community Development' && r.registration_date >= '2024-11-11' && r.registration_date < '2026-11-11')
    .map(r => r.prime_contract_id);
  assert.equal(rc.evidence.contributors_sha256, m.contributorHash(eligibleIds));
  assert.equal(artifact.sources['checkbook-contracts'].latest_accepted_observation.population, 29581);
  const bytes = Buffer.byteLength(readFileSync(new URL('../site/data/agency_procurement_history.json', import.meta.url)));
  assert.ok(bytes <= 262144, `artifact ${bytes} bytes exceeds bound`);
});

test('builder check mode confirms the committed artifact is current', () => {
  const out = execFileSync('node', ['tools/build_agency_procurement_history.mjs', '--check'], { encoding: 'utf8' });
  assert.match(out, /"status":"ok"/);
});
