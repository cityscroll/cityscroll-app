import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reducer from '../site/agency_procurement_history.mjs';
import * as h from '../tools/lib/agency_procurement_history_by_agency.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/agency-history/${name}`, import.meta.url), 'utf8'));
const wh = (name) => JSON.parse(readFileSync(new URL(`../warehouse/fixtures/agency-procurement-history/${name}`, import.meta.url), 'utf8'));
const NOTICES = fx('notices.json');
const CONTRACTS = fx('contracts.json');
const SOURCE = fx('source.json');
const OPEN = fx('open-agencies.json');
const DYCD_NOTICES = wh('dycd-solicitations-24months.raw.json');
const DYCD_CONTRACTS = wh('dycd-registered-contracts-2026-09-09.json').rows;
const WINDOW = { windowStart: '2024-11-11', windowEnd: '2026-11-11' };
const DYCD = 'youth-and-community-development';

// The retained world: the sample of the live City Record and Checkbook rows in fixtures/agency-history, plus the
// engine's own DYCD fixtures, read at the sample's day.
const build = (over = {}) => h.buildAgencyHistorySnapshot({
  notices: [...NOTICES, ...DYCD_NOTICES],
  noticeCount: SOURCE.notice_count + DYCD_NOTICES.length,
  rowsUpdatedAt: SOURCE.rows_updated_at,
  contracts: [...CONTRACTS, ...DYCD_CONTRACTS],
  contractsSnapshotDate: SOURCE.contracts_snapshot_date,
  ...over,
}, { now: new Date(SOURCE.generated_at), asOf: SOURCE.as_of });
const SNAP = build();
const rec = (id) => SNAP.agencies.find((a) => a.agency_id === id);

test('the fence is lifted: the reducer counts any canonical agency, and DYCD stays the default', () => {
  const correction = reducer.noticeMetrics(NOTICES, { ...WINDOW, agencyId: 'correction' });
  assert.equal(correction.solicitation_notices, 18);
  assert.equal(correction.response_window.median_calendar_days, 36.5);
  const dycdDefault = reducer.noticeMetrics([...NOTICES, ...DYCD_NOTICES], WINDOW);
  assert.equal(dycdDefault.solicitation_notices, 2);
  const byAgency = reducer.noticeMetricsByAgency([...NOTICES, ...DYCD_NOTICES], WINDOW);
  assert.ok(byAgency.size >= 8);
  assert.deepEqual(byAgency.get(DYCD).metrics, reducer.noticeMetrics(DYCD_NOTICES, WINDOW));
});

test('DYCD regression: the all-agency reducers reproduce the retained DYCD fixture numbers', () => {
  const n = reducer.noticeMetricsByAgency(DYCD_NOTICES, WINDOW).get(DYCD).metrics;
  assert.equal(n.solicitation_notices, 2);
  assert.equal(n.response_window.median_calendar_days, 43);
  const c = reducer.registeredContractMetricsByAgency(DYCD_CONTRACTS, WINDOW).agencies.get(DYCD).metrics;
  const direct = reducer.registeredContractMetrics(DYCD_CONTRACTS, { ...WINDOW, observedAt: '2026-09-09' });
  assert.equal(c.count, 2309);
  assert.equal(c.amount_eligible, 2309);
  assert.equal(c.median_original_registered_amount, 410783);
  assert.deepEqual(c.contributor_ids, direct.contributor_ids);
  const published = rec(DYCD);
  assert.equal(published.solicitations.notices, 2);
  assert.equal(published.response_window.median_calendar_days, 43);
  assert.equal(published.registered_contracts.count, 2309);
  assert.equal(published.registered_contracts.median_original_registered_amount, 410783);
});

test('a well-covered agency publishes all three blocks with source and as-of', () => {
  const a = rec('correction');
  assert.equal(a.agency_name, 'Correction');
  assert.equal(a.identity, 'reviewed');
  assert.deepEqual(a.city_record_spellings, ['Correction']);
  assert.deepEqual(a.checkbook_spellings, ['Department of Correction']);
  assert.equal(a.solicitations.notices, 18);
  assert.equal(a.response_window.state, 'available');
  assert.equal(a.response_window.median_calendar_days, 36.5);
  assert.equal(a.response_window.eligible_notices, 18);
  assert.equal(a.response_window.usable_due_date_share, 1);
  assert.equal(a.response_window.small_sample, false);
  assert.equal(a.registered_contracts.state, 'available');
  assert.equal(a.registered_contracts.count, 226);
  assert.equal(a.registered_contracts.median_original_registered_amount, 127716.62);
  for (const block of [a.solicitations, a.response_window, a.registered_contracts]) {
    assert.ok(block.source.name);
    assert.match(block.as_of, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(a.solicitations.as_of, '2026-11-16');
  assert.equal(a.registered_contracts.as_of, SOURCE.contracts_snapshot_date);
});

test('rolling placeholders are counted as exclusions and lower the usable share', () => {
  const a = rec('design-and-construction');
  assert.equal(a.solicitations.notices, 149);
  assert.equal(a.response_window.eligible_notices, 135);
  assert.deepEqual(a.response_window.excluded, { rolling_deadline_placeholder: 14 });
  assert.equal(a.response_window.median_calendar_days, 31);
  assert.equal(a.response_window.usable_due_date_share, 0.906);
});

test('a sparse agency publishes its small counts and says the sample is small', () => {
  const pension = rec('new-york-city-police-pension-fund');
  assert.equal(pension.solicitations.notices, 7);
  assert.equal(pension.response_window.state, 'available');
  assert.equal(pension.response_window.median_calendar_days, 41);
  assert.equal(pension.response_window.small_sample, false);
  const dycd = rec(DYCD);
  assert.equal(dycd.response_window.eligible_notices, 2);
  assert.equal(dycd.response_window.small_sample, true);
  // Checkbook only: no City Record notices under any spelling, two contracts, count published, median published.
  const board = rec('board-of-correction');
  assert.equal(board.solicitations.notices, 0);
  assert.equal(board.solicitations.reason, 'no_solicitation_notices');
  assert.equal(board.response_window.state, 'missing');
  assert.equal(board.response_window.reason, 'no_solicitation_notices');
  assert.equal(board.response_window.median_calendar_days, null);
  assert.equal(board.registered_contracts.count, 2);
  assert.equal(board.registered_contracts.median_original_registered_amount, 46596);
});

test('an agency whose notices carry no usable due date says so and keeps the notice count', () => {
  const a = rec('teachers-retirement-system');
  assert.equal(a.solicitations.notices, 10);
  assert.equal(a.response_window.state, 'missing');
  assert.equal(a.response_window.reason, 'no_usable_due_date');
  assert.equal(a.response_window.median_calendar_days, null);
  assert.equal(a.response_window.eligible_notices, 0);
  assert.equal(a.response_window.total_notices, 10);
  assert.equal(a.response_window.usable_due_date_share, 0);
  assert.deepEqual(a.response_window.excluded, { missing_or_invalid_due_date: 10 });
  assert.equal(a.registered_contracts.state, 'missing');
  assert.equal(a.registered_contracts.reason, 'no_registered_contracts');
  assert.equal(a.registered_contracts.count, 0);
  assert.ok(h.AGENCY_HISTORY_REASONS.no_usable_due_date.text.length > 20);
});

test('an unmapped spelling keeps its own id, is marked not reviewed, and is never merged into another agency', () => {
  const a = rec('brooklyn-navy-yard-development-corp');
  assert.equal(a.identity, 'not_reviewed');
  assert.equal(a.identity_note, 'identity_not_reviewed');
  assert.deepEqual(a.city_record_spellings, ['Brooklyn Navy Yard Development Corp.']);
  assert.equal(a.solicitations.notices, 27);
  assert.equal(a.response_window.median_calendar_days, 36);
  // A Checkbook name the engine has not reviewed likewise stands alone.
  const coib = rec('conflicts-of-interest-board');
  assert.equal(coib.identity, 'not_reviewed');
  assert.equal(coib.registered_contracts.count, 5);
  assert.equal(coib.solicitations.notices, 0);
  assert.ok(SNAP.reasons.identity_not_reviewed.text.length > 20);
});

test('reviewed Checkbook spellings join the City Record agency; nothing else is joined by similarity', () => {
  const hh = rec('nyc-health-hospitals');
  assert.deepEqual(hh.city_record_spellings, ['NYC Health + Hospitals']);
  assert.deepEqual(hh.checkbook_spellings, ['Health and Hospitals Corporation']);
  assert.equal(hh.display_name, 'NYC Health + Hospitals');
  assert.equal(hh.solicitations.notices, 110);
  assert.equal(hh.response_window.median_calendar_days, 37.5);
  assert.equal(hh.registered_contracts.count, 302);
  assert.equal(hh.registered_contracts.median_original_registered_amount, 299740.4);
  const cuny = rec('city-university');
  assert.deepEqual(cuny.checkbook_spellings, ['City University of New York']);
  assert.equal(cuny.registered_contracts.count, 84);
  assert.equal(cuny.solicitations.notices, 66);
  assert.deepEqual(Object.keys(reducer.CHECKBOOK_SPELLING_REVIEW).sort(), ['City University of New York', 'Health and Hospitals Corporation']);
  assert.ok(Object.values(reducer.CHECKBOOK_SPELLING_REVIEW).every((r) => r.basis.length > 40));
  assert.deepEqual(Object.keys(SNAP.checkbook_spelling_review).sort(), Object.keys(reducer.CHECKBOOK_SPELLING_REVIEW).sort());
  // The review table only names ids the City Record side actually uses.
  for (const row of Object.values(reducer.CHECKBOOK_SPELLING_REVIEW)) {
    assert.equal(reducer.cityRecordAgency(rec(row.agency_id).city_record_spellings[0]).agency_id, row.agency_id);
  }
});

test('community boards are a group of distinct bodies: counted as unassigned, never one agency', () => {
  assert.equal(SNAP.agencies.find((a) => a.agency_id === 'community-boards'), undefined);
  assert.equal(SNAP.population.contracts_unassigned['community-boards'], 6);
  const total = SNAP.agencies.reduce((s, a) => s + a.registered_contracts.count, 0);
  assert.equal(SNAP.population.contracts_in_window_counted, total);
});

test('community-board notices are left unassigned in the same way', () => {
  const row = (id, name) => ({ request_id: id, start_date: '2025-03-03T00:00:00.000', due_date: '2025-04-01T00:00:00.000', agency_name: name, type_of_notice_description: 'Solicitation', section_name: 'Procurement' });
  const snap = build({ notices: [row('20250101001', 'Brooklyn Community Board # 1'), row('20250101002', 'Correction')], noticeCount: 2, contracts: [] });
  assert.deepEqual(snap.population.notices_unassigned, { 'community-boards': 1 });
  assert.equal(snap.population.notices_in_window_counted, 1);
  assert.equal(snap.agencies.find((a) => a.agency_id === 'community-boards'), undefined);
});

test('the window is 24 calendar months ending at the as-of day, exclusive', () => {
  assert.deepEqual(SNAP.window, { months: 24, start_inclusive: '2024-11-11', end_exclusive: '2026-11-11' });
  assert.equal(h.monthsBefore('2028-02-29', 24), '2026-02-28');
  assert.equal(h.monthsBefore('2026-01-31', 2), '2025-11-30');
  assert.equal(h.monthsBefore('2026-11-17', 24), '2024-11-17');
  const edge = build({
    notices: [
      { request_id: '20240101001', start_date: '2024-11-10T00:00:00.000', due_date: '2024-12-01T00:00:00.000', agency_name: 'Correction', type_of_notice_description: 'Solicitation', section_name: 'Procurement' },
      { request_id: '20240101002', start_date: '2024-11-11T00:00:00.000', due_date: '2024-12-01T00:00:00.000', agency_name: 'Correction', type_of_notice_description: 'Solicitation', section_name: 'Procurement' },
      { request_id: '20240101003', start_date: '2026-11-11T00:00:00.000', due_date: '2026-12-01T00:00:00.000', agency_name: 'Correction', type_of_notice_description: 'Solicitation', section_name: 'Procurement' },
    ],
    noticeCount: 3,
    contracts: [],
  });
  assert.equal(edge.agencies.find((a) => a.agency_id === 'correction').solicitations.notices, 1);
});

test('population is complete on a full pull and incomplete, with reasons, on a short or partly invalid one', () => {
  assert.equal(SNAP.population.state, 'complete');
  assert.deepEqual(SNAP.population.reasons, []);
  assert.equal(SNAP.population.notices_in_window_counted, SNAP.population.notices_read);
  assert.equal(SNAP.population.contract_rows_read, CONTRACTS.length + DYCD_CONTRACTS.length);
  assert.deepEqual(build({ noticeCount: SOURCE.notice_count + 5 }).population.reasons, ['notice_count_mismatch']);
  const bad = build({ notices: [...NOTICES, ...DYCD_NOTICES, { request_id: 'x', start_date: 'nope', agency_name: 'Correction', type_of_notice_description: 'Solicitation' }], noticeCount: SOURCE.notice_count + 3 });
  assert.deepEqual(bad.population.reasons, ['invalid_notice_rows']);
  const capped = h.buildAgencyHistorySnapshot({ notices: NOTICES, noticeCount: NOTICES.length, contracts: CONTRACTS, contractsSnapshotDate: '2026-11-14' }, { asOf: '2026-11-11', maxRows: 10 });
  assert.deepEqual(capped.population.reasons, ['row_cap']);
});

test('refuses inputs that would publish a false picture', () => {
  assert.throws(() => h.buildAgencyHistorySnapshot({ notices: null, contracts: [], contractsSnapshotDate: '2026-11-14' }), /notices must be an array/);
  assert.throws(() => h.buildAgencyHistorySnapshot({ notices: [], contracts: null, contractsSnapshotDate: '2026-11-14' }), /contracts must be an array/);
  assert.throws(() => build({ contractsSnapshotDate: '' }), /snapshot date is required/);
  assert.throws(() => h.buildAgencyHistorySnapshot({ notices: NOTICES, noticeCount: NOTICES.length, contracts: CONTRACTS, contractsSnapshotDate: '2026-11-14' }, { asOf: '2026-11-11', maxBytes: 1000 }), /exceeds the 1000-byte bound/);
  const conflicting = { ...NOTICES[0], due_date: '2030-01-01T00:00:00.000' };
  assert.throws(() => build({ notices: [NOTICES[0], conflicting], noticeCount: 2 }), /conflicting_notice_observations/);
});

test('every published record is plain data: known keys, no markup, reasons declared', () => {
  const keys = ['agency_id', 'agency_name', 'display_name', 'identity', 'identity_note', 'city_record_spellings', 'checkbook_spellings', 'solicitations', 'response_window', 'registered_contracts'];
  for (const a of SNAP.agencies) {
    assert.deepEqual(Object.keys(a), keys);
    for (const block of [a.response_window, a.registered_contracts]) {
      assert.ok(['available', 'missing'].includes(block.state));
      if (block.state === 'missing') assert.ok(h.AGENCY_HISTORY_REASONS[block.reason], `${a.agency_id} ${block.reason}`);
      else assert.equal(block.reason, null);
    }
    for (const s of [a.agency_id, a.agency_name, a.display_name]) assert.doesNotMatch(s, /[<>]/);
  }
  assert.deepEqual(SNAP.agencies.map((a) => a.agency_id), SNAP.agencies.map((a) => a.agency_id).sort());
  assert.equal(SNAP.coverage.agencies, SNAP.agencies.length);
  assert.equal(SNAP.coverage.with_response_window, SNAP.agencies.filter((a) => a.response_window.state === 'available').length);
});

test('the bounded fetch reads the count, one page and the dataset update time, and never publishes a short pull', async () => {
  const urls = [];
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (url.includes('count')) return ok([{ n: '2' }]);
    if (url.includes('/api/views/')) return ok({ rowsUpdatedAt: 1794835903 });
    return ok(NOTICES.slice(0, 2));
  };
  const got = await h.fetchAgencyHistoryNotices(fetchImpl, { asOf: '2026-11-17', log: () => {} });
  assert.equal(got.noticeCount, 2);
  assert.equal(got.notices.length, 2);
  assert.equal(got.rowsUpdatedAt, '2026-11-16T13:31:43.000Z');
  assert.match(urls[0], /start_date%3E%3D%272024-11-17T00%3A00%3A00%27/);
  assert.match(urls[1], /limit=8001/);
  const empty = async (url) => ok(url.includes('count') ? [{ n: '0' }] : []);
  await assert.rejects(h.fetchAgencyHistoryNotices(empty, { asOf: '2026-11-17', log: () => {} }), /no rows/);
  const down = async () => ({ ok: false, status: 400 });
  await assert.rejects(h.fetchAgencyHistoryNotices(down, { asOf: '2026-11-17', log: () => {}, retry: { maxAttempts: 1 } }), /HTTP 400/);
  const noMeta = async (url) => (url.includes('/api/views/') ? { ok: false, status: 400 } : fetchImpl(url));
  const fallback = await h.fetchAgencyHistoryNotices(noMeta, { asOf: '2026-11-17', log: () => {}, retry: { maxAttempts: 1 } });
  assert.equal(fallback.rowsUpdatedAt, null);
  const snap = h.buildAgencyHistorySnapshot({ ...fallback, contracts: [], contractsSnapshotDate: '2026-11-14' }, { asOf: '2026-11-17', now: new Date('2026-11-17T10:00:00Z') });
  assert.equal(snap.sources.city_record.as_of, '2026-11-17');  // update time unreadable: the read day stands in
  assert.equal(snap.sources.city_record.rows_updated_at, null);
});

test('the offline builder command writes the same artifact the library builds', () => {
  const lib = JSON.parse(JSON.stringify(buildFixtureWorld()));
  const dir = mkdtempSync(join(tmpdir(), 'agency-history-'));
  try {
    const file = join(dir, 'out.json');
    execFileSync('node', ['tools/build_agency_procurement_history_by_agency.mjs', '--fixture', '--out', file], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), lib);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildFixtureWorld() {
  return h.buildAgencyHistorySnapshot({
    notices: NOTICES, noticeCount: SOURCE.notice_count, rowsUpdatedAt: SOURCE.rows_updated_at,
    contracts: CONTRACTS, contractsSnapshotDate: SOURCE.contracts_snapshot_date,
  }, { now: new Date(SOURCE.generated_at), asOf: SOURCE.as_of });
}

test('the committed artifact is bounded, dated, internally consistent, and holds every agency on the open list', () => {
  const text = readFileSync(new URL('../site/data/agency_procurement_history_by_agency.json', import.meta.url), 'utf8');
  const a = JSON.parse(text);
  assert.equal(a.schema, 'cityscroll.agency_procurement_history_by_agency.v1');
  assert.equal(a.population.state, 'complete');
  assert.ok(Buffer.byteLength(text) <= a.bounds.max_bytes);
  assert.equal(a.count, a.agencies.length);
  assert.equal(a.window.months, 24);
  assert.match(a.sources.city_record.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(a.sources.registered_contracts.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(a.population.notices_in_window_counted, a.agencies.reduce((s, r) => s + r.solicitations.notices, 0));
  assert.equal(a.population.notices_in_window_counted + Object.values(a.population.notices_unassigned).reduce((x, y) => x + y, 0), a.population.notices_read);
  assert.equal(a.population.contracts_in_window_counted, a.agencies.reduce((s, r) => s + r.registered_contracts.count, 0));
  assert.equal(new Set(a.agencies.map((r) => r.agency_id)).size, a.agencies.length);
  // Every agency printed on the 198 open notices read on 2026-11-17 has a record with a real count.
  let withWindow = 0;
  for (const printed of Object.keys(OPEN.agencies_by_printed_name)) {
    const id = reducer.cityRecordAgency(printed).agency_id;
    const r = a.agencies.find((x) => x.agency_id === id);
    assert.ok(r, `${printed} (${id}) has no record`);
    assert.ok(r.solicitations.notices >= 1, `${printed} has no solicitation notices`);
    if (r.response_window.state === 'available') withWindow += 1;
  }
  assert.equal(withWindow, Object.keys(OPEN.agencies_by_printed_name).length);
  const dycd = a.agencies.find((r) => r.agency_id === DYCD);
  assert.equal(dycd.solicitations.notices, 2);
  assert.equal(dycd.response_window.median_calendar_days, 43);
});

test('the first-class registry declares the artifact on the City Record contract with its refresh bounds', () => {
  const contracts = JSON.parse(readFileSync(new URL('../site/data/source_contracts.json', import.meta.url), 'utf8'));
  const entry = contracts.first_class_artifacts.find((x) => x.id === 'agency-procurement-history-by-agency');
  assert.ok(entry);
  assert.equal(entry.source_contract_id, 'city-record');
  assert.equal(entry.public_artifact_path, 'site/data/agency_procurement_history_by_agency.json');
  assert.deepEqual(entry.builder_command, ['node', 'tools/build_agency_procurement_history_by_agency.mjs']);
  assert.equal(entry.normal_refresh_cadence_hours, 24);
  assert.ok(entry.hard_maximum_age_hours <= 36);
  assert.ok(contracts.contracts.some((c) => c.id === 'city-record'));
});
