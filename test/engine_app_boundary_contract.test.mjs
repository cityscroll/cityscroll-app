import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyEngineContract, collectPublishedContract, forbiddenAppRole } from '../tools/verify_engine_app_boundary.mjs';

function fixture(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'boundary-contract-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo'); mkdirSync(root);
  const files = {
    'capabilities/registry.mjs': 'import { OP_CAPABILITY } from "./op.mjs";\nexport const CAPABILITY_REGISTRY = [OP_CAPABILITY];\n',
    'capabilities/op.mjs': [
      'export const OP_CAPABILITY_ID = "op.read";',
      'export const OP_CAPABILITY_VERSION = "1.0.0";',
      'export const OP_CAPABILITY = {',
      '  id: OP_CAPABILITY_ID,',
      '  version: OP_CAPABILITY_VERSION,',
      '  reference: "op.read@1",',
      '  detail: "safe",',
      '};',
    ].join('\n'),
    ...extra,
  };
  for (const [path, value] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); }
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commit = (message) => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message); };
  git('init', '-q');
  commit('Synthetic engine contract');
  return { home, root, git, commit };
}

test('a clean registry with no application-layer reach and a stable contract passes', (t) => {
  const { root } = fixture(t);
  const report = verifyEngineContract({ root });
  assert.equal(report.status, 'PASS');
  assert.equal(report.findings.length, 0);
  assert.equal(report.checked_contracts, 1);
  assert.ok(report.reached_units >= 2);
});

test('forbiddenAppRole classifies the four application-layer categories and leaves everything else unmatched', () => {
  assert.equal(forbiddenAppRole('app/interface/handler.mjs'), 'interface');
  assert.equal(forbiddenAppRole('worker/src/worker.mjs'), 'interface');
  assert.equal(forbiddenAppRole('app/subscriber/store.mjs'), 'subscriber');
  assert.equal(forbiddenAppRole('worker/src/subscribe.mjs'), 'subscriber');
  assert.equal(forbiddenAppRole('worker/src/unsubscribe.mjs'), 'subscriber');
  assert.equal(forbiddenAppRole('worker/src/following.mjs'), 'subscriber');
  assert.equal(forbiddenAppRole('worker/src/prefs.mjs'), 'subscriber');
  assert.equal(forbiddenAppRole('app/mail/sender.mjs'), 'mail');
  assert.equal(forbiddenAppRole('worker/src/confirm.mjs'), 'mail');
  assert.equal(forbiddenAppRole('worker/src/alerts.mjs'), 'mail');
  assert.equal(forbiddenAppRole('worker/src/operator_notification.mjs'), 'mail');
  assert.equal(forbiddenAppRole('app/paid-orchestration/billing.mjs'), 'paid-orchestration');
  assert.equal(forbiddenAppRole('worker/src/lib/agencies.mjs'), null);
  assert.equal(forbiddenAppRole('capabilities/op.mjs'), null);
});

test('a direct forbidden-module import from a reachable operation fails with the exact offending edge', (t) => {
  const { root } = fixture(t, {
    'capabilities/op.mjs': [
      'import { sendMail } from "../app/mail/sender.mjs";',
      'export const OP_CAPABILITY = { id: "op.read", version: "1.0.0", reference: "op.read@1", send: sendMail };',
    ].join('\n'),
    'app/mail/sender.mjs': 'export function sendMail() { return true; }',
  });
  const report = verifyEngineContract({ root });
  assert.equal(report.status, 'FAIL');
  const finding = report.findings.find((f) => f.code === 'REVERSE_APP_IMPORT');
  assert.ok(finding, 'expected a REVERSE_APP_IMPORT finding');
  assert.equal(finding.role, 'mail');
  assert.equal(finding.from, 'capabilities/op.mjs');
  assert.equal(finding.to, 'app/mail/sender.mjs');
});

test('an injected transitive reverse import through an otherwise clean module fails with its own edge', (t) => {
  const { root } = fixture(t, {
    'capabilities/op.mjs': [
      'import { helper } from "../shared/helper.mjs";',
      'export const OP_CAPABILITY = { id: "op.read", version: "1.0.0", reference: "op.read@1", helper };',
    ].join('\n'),
    'shared/helper.mjs': 'export { store as helper } from "../app/subscriber/store.mjs";',
    'app/subscriber/store.mjs': 'export const store = {};',
  });
  const report = verifyEngineContract({ root });
  assert.equal(report.status, 'FAIL');
  const finding = report.findings.find((f) => f.code === 'REVERSE_APP_IMPORT');
  assert.ok(finding, 'expected a REVERSE_APP_IMPORT finding');
  assert.equal(finding.role, 'subscriber');
  assert.equal(finding.from, 'shared/helper.mjs');
  assert.equal(finding.to, 'app/subscriber/store.mjs');
});

test('a breaking change to a published capability contract without a version change fails', (t) => {
  const { root, commit } = fixture(t);
  const before = collectPublishedContract({ root });
  writeFileSync(join(root, 'capabilities/op.mjs'), [
    'export const OP_CAPABILITY_ID = "op.read";',
    'export const OP_CAPABILITY_VERSION = "1.0.0";',
    'export const OP_CAPABILITY = {',
    '  id: OP_CAPABILITY_ID,',
    '  version: OP_CAPABILITY_VERSION,',
    '  reference: "op.read@1",',
    '  detail: "changed shape, same version",',
    '};',
  ].join('\n'));
  commit('Change published contract shape without a version bump');
  const after = collectPublishedContract({ root });
  assert.notEqual(after.contracts['op.read'].shape_sha256, before.contracts['op.read'].shape_sha256);
  const report = verifyEngineContract({ root, base: before.source_revision });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.findings.some((f) => f.code === 'CONTRACT_CHANGED_WITHOUT_VERSION_BUMP' && f.id === 'op.read'));
});

test('the same shape change passes once the version is bumped', (t) => {
  const { root, commit } = fixture(t);
  const before = collectPublishedContract({ root });
  writeFileSync(join(root, 'capabilities/op.mjs'), [
    'export const OP_CAPABILITY_ID = "op.read";',
    'export const OP_CAPABILITY_VERSION = "1.0.1";',
    'export const OP_CAPABILITY = {',
    '  id: OP_CAPABILITY_ID,',
    '  version: OP_CAPABILITY_VERSION,',
    '  reference: "op.read@1",',
    '  detail: "changed shape, with a version bump",',
    '};',
  ].join('\n'));
  commit('Change published contract shape with a version bump');
  const report = verifyEngineContract({ root, base: before.source_revision });
  assert.equal(report.status, 'PASS');
  assert.equal(report.findings.length, 0);
});

test('an unchanged shape never requires a version bump', (t) => {
  const { root, commit } = fixture(t);
  const before = collectPublishedContract({ root });
  writeFileSync(join(root, 'capabilities/notes.mjs'), '// a sibling file unrelated to any capability\nexport const value = 1;\n');
  commit('Unrelated sibling addition');
  const report = verifyEngineContract({ root, base: before.source_revision });
  assert.equal(report.status, 'PASS');
});

test('a missing engine contract root fails explicitly', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'boundary-contract-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo'); mkdirSync(root);
  mkdirSync(join(root, 'capabilities'), { recursive: true });
  writeFileSync(join(root, 'capabilities/op.mjs'), 'export const OP_CAPABILITY = { id: "op.read", version: "1.0.0", reference: "op.read@1" };');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'No registry');
  const report = verifyEngineContract({ root });
  assert.ok(report.findings.some((f) => f.code === 'ENGINE_CONTRACT_ROOT_MISSING'));
});

test('an unresolvable capability field fails closed instead of guessing', (t) => {
  const { root } = fixture(t, {
    'capabilities/op.mjs': [
      'export const OP_CAPABILITY = { id: computeId(), version: "1.0.0", reference: "op.read@1" };',
    ].join('\n'),
  });
  const report = verifyEngineContract({ root });
  assert.ok(report.findings.some((f) => f.code === 'CONTRACT_FIELD_UNRESOLVED'));
});

test('duplicate published capability ids across files fail', (t) => {
  const { root } = fixture(t, {
    'capabilities/registry.mjs': 'import { OP_CAPABILITY } from "./op.mjs";\nimport { OTHER_CAPABILITY } from "./other.mjs";\nexport const CAPABILITY_REGISTRY = [OP_CAPABILITY, OTHER_CAPABILITY];\n',
    'capabilities/other.mjs': 'export const OTHER_CAPABILITY = { id: "op.read", version: "2.0.0", reference: "op.read@2" };',
  });
  const report = verifyEngineContract({ root });
  assert.ok(report.findings.some((f) => f.code === 'DUPLICATE_PUBLISHED_CAPABILITY_ID'));
});

test('CLI contract stage needs no private ledger and prints bounded status', (t) => {
  const { root } = fixture(t);
  const cli = fileURLToPath(new URL('../tools/verify_engine_app_boundary.mjs', import.meta.url));
  const env = { ...process.env }; delete env.CITYSCROLL_ENGINE_APP_LEDGER;
  const ok = spawnSync(process.execPath, [cli, '--stage', 'contract', '--root', root], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status, 'PASS');
});

test('CLI contract stage exits non-zero on a real violation', (t) => {
  const { root } = fixture(t, {
    'capabilities/op.mjs': [
      'import { sendMail } from "../app/mail/sender.mjs";',
      'export const OP_CAPABILITY = { id: "op.read", version: "1.0.0", reference: "op.read@1", send: sendMail };',
    ].join('\n'),
    'app/mail/sender.mjs': 'export function sendMail() { return true; }',
  });
  const cli = fileURLToPath(new URL('../tools/verify_engine_app_boundary.mjs', import.meta.url));
  const env = { ...process.env }; delete env.CITYSCROLL_ENGINE_APP_LEDGER;
  const failed = spawnSync(process.execPath, [cli, '--stage', 'contract', '--root', root], { encoding: 'utf8', env });
  assert.equal(failed.status, 1);
  const status = JSON.parse(failed.stdout);
  assert.equal(status.status, 'FAIL');
  assert.ok(status.finding_counts.REVERSE_APP_IMPORT >= 1);
});

test('the real repository tree passes the contract stage on its current HEAD', () => {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const report = verifyEngineContract({ root, revision: 'HEAD' });
  assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});
