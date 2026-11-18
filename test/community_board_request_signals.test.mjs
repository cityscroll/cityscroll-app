import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../site/procurement_evidence.mjs';
import { BOARD_REQUEST_AGENCIES, buildAll, readBoardRegister } from '../tools/build_procurement_evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const cases = readJson(join(ROOT, 'warehouse/fixtures/procurement-evidence/board-request-signal-cases.json'));
const asOf = cases.as_of;
// The case file still contains a bound agency that this list leaves unpublished,
// so the "not published" outcome stays observable. Production publishes every
// agency the register binds; see BOARD_REQUEST_AGENCIES.
const agencies = [
  'education',
  'environmental-protection',
  'housing-authority',
  'youth-and-community-development',
];
const BOROUGHS = ['bronx', 'brooklyn', 'manhattan', 'queens', 'staten-island'];
const set = m.budgetRequestSignalSet(cases.documents, { asOf, agencies });
const rowFor = code => Object.values(set.signals).flat().find(r => r.tracking_code === code);
const requestOf = code => cases.documents.flatMap(d => d.requests).find(r => r.tracking_code === code);
const outcomeOf = request => {
  const one = m.budgetRequestSignalSet([{ requests: [request] }], { asOf, agencies });
  const hit = Object.entries(one.coverage.by_outcome).filter(([, n]) => n > 0);
  assert.equal(hit.length, 1);
  return hit[0][0];
};

test('every case in the fixture ends in the outcome it names', () => {
  for (const [name, c] of Object.entries(cases.cases)) {
    assert.equal(outcomeOf(requestOf(c.tracking_code)), c.expected_outcome, name);
  }
  assert.equal(set.coverage.requests_in_register, Object.keys(cases.cases).length);
  assert.equal(Object.values(set.coverage.by_outcome).reduce((a, b) => a + b, 0), set.coverage.requests_in_register);
});

test('a request with a response carries the request and the response as published, the board, the borough and the source', () => {
  const row = rowFor('412202701C');
  assert.equal(row.kind, 'community_board_request');
  assert.equal(row.kind_label, 'Community board budget request');
  assert.equal(row.agency_id, 'education');
  assert.equal(row.agency_label, 'Department of Education');
  assert.equal(row.board_id, 'queens-cb-12');
  assert.equal(row.borough, 'queens');
  assert.equal(row.district_id, 'Q12');
  assert.equal(row.geography_key, 'geography:community_district:Q12');
  assert.equal(row.fiscal_year, 2027);
  assert.equal(row.headline, 'Other capital budget request for DOE');
  assert.equal(row.response, 'This item is not eligible for capital funding.');
  assert.equal(row.response_state, 'published');
  assert.equal(row.event_date, '2026-06-30');
  assert.equal(row.source_publication, '20260630');
  assert.equal(row.source_id, 'vn4m-mk4t');
  assert.equal(row.source_url, 'https://data.cityofnewyork.us/d/vn4m-mk4t');
  assert.equal(row.id, 'cb-request/queens-cb-12/2027/412202701C');
});

test('the later diagnostic-only answer is not read', () => {
  assert.doesNotMatch(JSON.stringify(rowFor('412202701C')), /supports but cannot accommodate/);
  assert.equal(outcomeOf(requestOf('412202790C')), 'no_servable_publication');
});

test('a request without a response says so and carries no response text', () => {
  const row = rowFor('412202799C');
  assert.equal(row.response_state, 'not_published');
  assert.equal(Object.hasOwn(row, 'response'), false);
  assert.equal(row.headline, 'Other capital budget request for DOE');
});

test('an agency the register cannot bind, and a bound agency that is not published, publish no signal and are counted', () => {
  assert.equal(rowFor('207202701C'), undefined);
  assert.equal(rowFor('403202721E'), undefined);
  assert.equal(set.coverage.by_outcome.agency_unbound, 2);
  assert.equal(set.coverage.by_outcome.agency_not_published, 1);
  assert.equal(set.coverage.by_agency['parks-and-recreation'].published, false);
  assert.equal(set.coverage.by_agency['parks-and-recreation'].requests, 1);
});

test('publishing one more agency is the agency list and nothing else', () => {
  const wider = m.budgetRequestSignalSet(cases.documents, { asOf, agencies: [...agencies, 'parks-and-recreation'] });
  assert.equal(wider.signals['parks-and-recreation'].length, 1);
  assert.equal(wider.signals['parks-and-recreation'][0].tracking_code, '403202721E');
  assert.equal(wider.coverage.by_outcome.agency_not_published, 0);
  assert.equal(wider.coverage.published_signals, set.coverage.published_signals + 1);
  assert.equal(wider.coverage.by_agency['parks-and-recreation'].published, true);
});

test('the latest servable publication decides the agency; an older bound version is not borrowed', () => {
  assert.equal(rowFor('412202791C'), undefined);
  assert.equal(outcomeOf(requestOf('412202791C')), 'agency_unbound');
});

test('a malformed board id is excluded, counted, and never repaired', () => {
  for (const id of ['queens-cb-15', 'queens-cb-00', 'Queens-CB-12', 'brooklyn-cb-19', 'newark-cb-01', null, '', 'queens-cb-1', 'staten-island-cb-04', 'queens-cb-12 ', '__proto__']) {
    assert.equal(m.boardIdentity(id), null, String(id));
  }
  for (const [id, key] of [['bronx-cb-12', 'X12'], ['brooklyn-cb-18', 'K18'], ['manhattan-cb-01', 'M01'], ['queens-cb-14', 'Q14'], ['staten-island-cb-03', 'R03']]) {
    assert.equal(m.boardIdentity(id).district_id, key);
  }
  assert.equal(set.coverage.by_outcome.board_id_malformed, 6);
  assert.equal(set.coverage.by_outcome.board_not_bound, 1);
  assert.equal(set.coverage.requests_with_valid_board_id, set.coverage.requests_in_register - 7);
  for (const row of Object.values(set.signals).flat()) assert.notEqual(m.boardIdentity(row.board_id), null);
});

test('a request with no text and an explanation that is null never become a null field', () => {
  assert.equal(outcomeOf(requestOf('304202704CS')), 'request_text_missing');
  const row = rowFor('209202706C');
  assert.equal(Object.hasOwn(row, 'explanation'), false);
  for (const r of Object.values(set.signals).flat()) for (const [k, v] of Object.entries(r)) assert.notEqual(v, undefined, k);
});

test('a duplicate request identity fails the build instead of counting twice', () => {
  const doc = cases.documents[0];
  assert.throws(() => m.budgetRequestSignalSet([doc, doc], { asOf, agencies }), /duplicate request identity/);
});

test('rows follow the evidence reader limits: known strings are strings, the rank is whole, nothing reads as funding', () => {
  for (const r of Object.values(set.signals).flat()) {
    for (const f of ['id', 'kind', 'agency_id', 'board_id', 'claim', 'headline', 'response', 'explanation', 'source_id', 'source_url', 'tracking_code']) {
      assert.ok(!Object.hasOwn(r, f) || typeof r[f] === 'string', f);
    }
    assert.match(r.source_publication, /^\d{8}$/);
    assert.match(r.event_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isInteger(r.fiscal_year));
    if (r.rank) assert.deepEqual(Object.keys(r.rank).sort(), ['district_wide', 'scope', 'value']);
    assert.match(r.claim, /not an appropriation or solicitation/);
    assert.equal(r.denominator, null);
    for (const banned of ['funding', 'funded', 'amount', 'award', 'budget_change', 'appropriation']) assert.equal(Object.hasOwn(r, banned), false, banned);
  }
});

const register = readBoardRegister();

test('the one-board fixture the builder used to read is the register document for that board, so reading the whole register keeps its signals', () => {
  const old = readJson(join(ROOT, 'warehouse/fixtures/procurement-evidence/queens-cb12-budget-register.json'));
  assert.deepEqual(old, register.documents.find(d => d.board_id === 'queens-cb-12'));
  const day = '2026-11-14';
  const all = m.budgetRequestSignalSet(register.documents, { asOf: day, agencies });
  for (const agency of ['education', 'environmental-protection']) {
    const before = m.budgetRequestSignals(old, { asOf: day, agency });
    assert.ok(before.length > 0);
    const after = all.signals[agency].filter(r => r.board_id === 'queens-cb-12');
    assert.deepEqual(after.map(r => r.id).sort(), before.map(r => r.id).sort());
    for (const r of before) assert.deepEqual(after.find(a => a.id === r.id), r);
  }
});

const full = buildAll();
const coverage = full.capabilities.community_board_requests;

test('the builder reads the whole register: 3,809 requests, 59 boards, every request with a board id', () => {
  assert.equal(register.documents.length, 59);
  assert.equal(register.index.counts.requests, 3809);
  assert.equal(coverage.requests_in_register, 3809);
  assert.equal(coverage.requests_with_valid_board_id, 3809);
  assert.equal(coverage.share_with_valid_board_id, 1);
  assert.equal(Object.values(coverage.by_outcome).reduce((a, b) => a + b, 0), 3809);
  assert.equal(Object.keys(coverage.by_borough).sort().join(), BOROUGHS.join());
});

test('every agency the register binds is published, and requests left out stay counted', () => {
  assert.deepEqual(coverage.signal_agencies, [...BOARD_REQUEST_AGENCIES]);
  assert.deepEqual([...BOARD_REQUEST_AGENCIES].sort(), Object.keys(coverage.by_agency).sort());
  assert.equal(coverage.by_outcome.agency_not_published, 0);
  assert.equal(coverage.by_outcome.agency_unbound, 119);
  assert.equal(coverage.by_outcome.request_text_missing, 1);
  assert.equal(coverage.published_signals, 3689);
  assert.equal(coverage.published_with_response, 3689);
  assert.equal(coverage.published_without_response, 0);
  const counts = Object.fromEntries(Object.entries(coverage.published).map(([a, p]) => [a, p.requests]));
  assert.equal(counts.education, 292);
  assert.equal(counts['environmental-protection'], 194);
  assert.equal(counts['housing-authority'], 72);
  assert.equal(counts['youth-and-community-development'], 106);
  assert.ok(counts['parks-and-recreation'] > 600);
  assert.equal(coverage.by_agency['parks-and-recreation'].published, true);
  const byBorough = Object.fromEntries(BOROUGHS.map(b => [b, Object.values(coverage.published).reduce((n, p) => n + (p.by_borough[b] || 0), 0)]));
  assert.deepEqual(byBorough, { 'bronx': 600, 'brooklyn': 1228, 'manhattan': 868, 'queens': 927, 'staten-island': 66 });
  const shownBefore = ['education', 'environmental-protection', 'housing-authority', 'youth-and-community-development'];
  const shownBorough = Object.fromEntries(BOROUGHS.map(b => [b, shownBefore.reduce((n, a) => n + (coverage.published[a].by_borough[b] || 0), 0)]));
  assert.deepEqual(shownBorough, { 'bronx': 125, 'brooklyn': 181, 'manhattan': 186, 'queens': 150, 'staten-island': 22 });
  assert.ok(full.outputs.get('capabilities').length <= 262144);
});

test('every one of the 59 boards has at least one signal from the published agencies', () => {
  const boards = new Set(Object.values(coverage.published).flatMap(p => Object.keys(p.by_board)));
  assert.equal(boards.size, 59);
  assert.equal([...boards].filter(b => b.startsWith('queens-cb-')).length, 14);
});

test('each published signals family matches the rows it points at, and stays inside the page limits the evidence reader enforces', () => {
  for (const agency of BOARD_REQUEST_AGENCIES) {
    const manifest = full.manifests.get(agency);
    const family = manifest.families.signals;
    assert.equal(family.total, coverage.published[agency].requests);
    assert.equal(family.pages.length, Math.ceil(family.total / 25));
    assert.equal(family.source_contract_id, 'omb-community-board-budget-requests');
    assert.equal(family.source_as_of, '2026-06-30');
    assert.equal(Object.values(family.request_counts.by_board).reduce((a, b) => a + b, 0), family.total);
    assert.equal(family.request_counts.with_response + family.request_counts.without_response, family.total);
    let rows = 0;
    family.pages.forEach((pointer, i) => {
      const bytes = full.outputs.get(`${agency}/${manifest.version}/signals-${i}.json`);
      assert.ok(bytes.length <= 65536, `${agency} page ${i} is ${bytes.length} bytes`);
      const page = JSON.parse(bytes.toString('utf8'));
      assert.equal(page.rows.length, i < family.pages.length - 1 ? 25 : family.total - 25 * i);
      assert.ok(page.rows.every(r => r.agency_id === agency && r.kind === 'community_board_request'));
      rows += page.rows.length;
    });
    assert.equal(rows, family.total);
  }
  assert.equal(full.manifests.get('design-and-construction').families.signals.request_counts, undefined);
});

test('existing families beside the new signals stay where they were', () => {
  assert.ok(full.manifests.get('youth-and-community-development').families['program-sites']);
  assert.equal(full.manifests.get('housing-authority').families['retained-examples'].total, 1);
  assert.deepEqual(
    Object.keys(full.capabilities.agencies).sort(),
    [...new Set([...BOARD_REQUEST_AGENCIES, 'design-and-construction'])].sort(),
  );
  assert.deepEqual(full.capabilities.families.find(f => f.id === 'budget-requests').agency_ids, [...BOARD_REQUEST_AGENCIES]);
});

test('a short, altered or partial register fails the build closed', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'board-register-'));
  try {
    const dir = join(scratch, 'community_board_budget_register');
    cpSync(join(ROOT, 'site/data/community_board_budget_register'), dir, { recursive: true });
    const indexPath = join(scratch, 'community_board_budget_register.json');
    cpSync(join(ROOT, 'site/data/community_board_budget_register.json'), indexPath);
    assert.equal(readBoardRegister({ indexPath, dir }).documents.length, 59);

    const doc = join(dir, 'queens-cb-12.json');
    const original = readFileSync(doc);
    writeFileSync(doc, original.toString('utf8').replace('Other capital budget request for DOE', 'Other capital budget request for DOX'));
    assert.throws(() => readBoardRegister({ indexPath, dir }), /queens-cb-12 hash mismatch/);
    writeFileSync(doc, original);

    rmSync(join(dir, 'bronx-cb-01.json'));
    assert.throws(() => readBoardRegister({ indexPath, dir }), /ENOENT/);
    cpSync(join(ROOT, 'site/data/community_board_budget_register/bronx-cb-01.json'), join(dir, 'bronx-cb-01.json'));

    const index = readJson(indexPath);
    index.boards.pop();
    writeFileSync(indexPath, JSON.stringify(index));
    assert.throws(() => readBoardRegister({ indexPath, dir }), /board list does not match its count/);
    index.boards = readJson(join(ROOT, 'site/data/community_board_budget_register.json')).boards;
    index.counts.requests += 1;
    writeFileSync(indexPath, JSON.stringify(index));
    assert.throws(() => readBoardRegister({ indexPath, dir }), /do not add up/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('refresh stays on the register schedule: the evidence builder is the register\'s dependent materializer and reads that artifact', () => {
  const contracts = readJson(join(ROOT, 'site/data/source_contracts.json'));
  const artifact = contracts.first_class_artifacts.find(a => a.id === 'community-board-budget-register');
  assert.ok(artifact.dependent_materializers.includes('tools/build_procurement_evidence.mjs'));
  assert.equal(artifact.public_artifact_path, 'site/data/community_board_budget_register.json');
  assert.equal(artifact.normal_refresh_cadence_hours, 720);
  const builder = readFileSync(join(ROOT, 'tools/build_procurement_evidence.mjs'), 'utf8');
  assert.ok(builder.includes(artifact.public_artifact_path.replace(/^site\//, '')) || builder.includes('site/data/community_board_budget_register.json'));
  assert.equal(builder.includes('queens-cb12-budget-register'), false);
  assert.ok(existsSync(join(ROOT, 'ops/first-class-refresh/committed-read-models.json')));
});

test('the signal sources do not name an internal product', () => {
  const banned = new RegExp(['way', 'point'].join('') + '|cityscroll-' + 'product', 'i');
  for (const file of ['site/procurement_evidence.mjs', 'tools/build_procurement_evidence.mjs', 'test/community_board_request_signals.test.mjs', 'warehouse/fixtures/procurement-evidence/board-request-signal-cases.json']) {
    assert.equal(banned.test(readFileSync(join(ROOT, file), 'utf8')), false, file);
  }
});
