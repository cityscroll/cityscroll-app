import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectInventory, verifyLedger, LEDGER_SCHEMA } from '../tools/verify_engine_app_boundary.mjs';

function fixture(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'boundary-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo'); mkdirSync(root);
  const files = {
    'worker/wrangler.toml': 'name="synthetic"\nmain="src/worker.mjs"\n[triggers]\ncrons=["0 1 * * *"]\n[[kv_namespaces]]\nbinding="SYNTHETIC_STORE"\nid="fixture"\n',
    'worker/src/worker.mjs': 'import { value } from "../../capabilities/read.mjs";\nexport default { async fetch(request) { const { pathname } = new URL(request.url);\nif (pathname === "/civic") return new Response(value);\nreturn new Response("missing", {status:404}); } };\n',
    'capabilities/read.mjs': 'export const value = "civic";\n',
    'tools/external_schedule_jobs.json': JSON.stringify({ jobs: [{ id: 'synthetic', schedule: ['0 2 * * *'], runner: 'fixture' }] }),
    '.github/workflows/check.yml': 'name: Synthetic\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo synthetic\n',
    ...extra,
  };
  for (const [path, value] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); }
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic boundary');
  const inventory = collectInventory({ root });
  const ledger = { schema: LEDGER_SCHEMA, review_state:'reviewed', source_revision: inventory.source_revision, units: inventory.units.map((unit) => ({ ...unit, current_owner: 'synthetic-runtime', target_owner: unit.path.startsWith('capabilities/') ? 'engine' : 'operations', deployment_owner: 'synthetic-deploy', rollback_revision: inventory.source_revision, effects: [] })) };
  return { home, root, git, inventory, ledger };
}

test('derives real config, schedule, workflow and source boundaries without executing source', (t) => {
  const { inventory, ledger } = fixture(t, { 'site/no-execute.mjs': 'throw new Error("must never execute application code"); export const safe = true;' });
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
  for (const kind of ['binding', 'runtime', 'schedule', 'workflow-job', 'external-job', 'entrypoint', 'routing-clause', 'import']) assert.ok(inventory.units.some((u) => u.kind === kind), kind);
});

test('unclassified routing clause fails even when every file has an owner', (t) => {
  const { inventory, ledger } = fixture(t);
  ledger.units = ledger.units.filter((u) => u.kind !== 'routing-clause');
  const result = verifyLedger(inventory, ledger);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.findings.some((f) => f.code === 'UNCLASSIFIED_UNIT'));
});

test('engine cannot receive a recipient-state binding', (t) => {
  const { inventory, ledger } = fixture(t);
  const row = ledger.units.find((u) => u.kind === 'binding');
  row.target_owner = 'engine'; row.effects = ['recipient-state'];
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'FORBIDDEN_BINDING_OR_EFFECT'));
});

test('actual transitive source edge into private identity fails', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'export { value } from "../worker/src/identity.mjs";',
    'worker/src/identity.mjs': 'export const value = "private";',
  });
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('stale source revision and evidence hashes fail independently', (t) => {
  const { inventory, ledger } = fixture(t);
  ledger.source_revision = '0'.repeat(40);
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'SOURCE_REVISION_STALE'));
  ledger.source_revision = inventory.source_revision;
  ledger.units[0].evidence_sha256 = '0'.repeat(64);
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'SOURCE_EVIDENCE_STALE'));
});

test('a newly committed module is rejected by the old ledger', (t) => {
  const { inventory, ledger, git, root } = fixture(t);
  writeFileSync(join(root, 'worker/src/new.mjs'), 'export const value = 1;');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'New module');
  const updated = collectInventory({ root });
  assert.notEqual(updated.source_revision, inventory.source_revision);
  ledger.source_revision = updated.source_revision;
  assert.ok(verifyLedger(updated, ledger).findings.some((f) => f.code === 'UNCLASSIFIED_UNIT'));
});

test('computed imports and unresolved source targets never silently pass', (t) => {
  const { inventory, ledger } = fixture(t, { 'capabilities/read.mjs': 'const path = "./unknown.mjs"; export const value = import(path);' });
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER'));
});

test('literal lazy imports contribute real reverse edges, including comment-separated calls', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'export const value = import /* lazy */ ("../worker/src/identity.mjs");',
    'worker/src/identity.mjs': 'export const identity = "private";',
  });
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('a string prefix followed by a computed suffix is unresolved', (t) => {
  const { inventory, ledger } = fixture(t, { 'capabilities/read.mjs': 'const suffix="read.mjs"; export const value = import("./" + suffix);' });
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER'));
});

test('duplicate and unobserved claims fail, and absent rollback/deploy proof fails', (t) => {
  const { inventory, ledger } = fixture(t);
  ledger.units.push({ ...ledger.units[0] });
  ledger.units.push({ ...ledger.units[0], id: 'file:unobserved.mjs' });
  ledger.units[0].rollback_revision = ''; ledger.units[0].deployment_owner = '';
  const codes = new Set(verifyLedger(inventory, ledger).findings.map((f) => f.code));
  assert.ok(codes.has('DUPLICATE_LEDGER_UNIT')); assert.ok(codes.has('LEDGER_UNIT_NOT_OBSERVED'));
  // Remove the duplicate before checking the missing fields on its original.
  ledger.units = ledger.units.slice(0, -2);
  const fields = new Set(verifyLedger(inventory, ledger).findings.map((f) => f.code));
  assert.ok(fields.has('ROLLBACK_IDENTITY_MISSING')); assert.ok(fields.has('DEPLOYMENT_OWNER_MISSING'));
});

test('CLI reads private evidence outside public tree and emits bounded redacted status', (t) => {
  const { root, home, ledger } = fixture(t);
  const privateFile = join(home, 'owner-secret-ledger.json');
  writeFileSync(privateFile, JSON.stringify(ledger));
  const cli = fileURLToPath(new URL('../tools/verify_engine_app_boundary.mjs', import.meta.url));
  const invoke = (path) => spawnSync(process.execPath, [cli, '--stage', 'foundation', '--root', root], { encoding: 'utf8', env: { ...process.env, CITYSCROLL_ENGINE_APP_LEDGER: path } });
  const ok = invoke(privateFile); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status, 'PASS');
  assert.ok(!ok.stdout.includes('owner-secret-ledger')); assert.ok(!ok.stdout.includes('SYNTHETIC_STORE'));
  const inside = join(root, 'private.json'); writeFileSync(inside, JSON.stringify(ledger));
  const refused = invoke(inside); assert.equal(refused.status, 1); assert.ok(!refused.stderr.includes(inside));
});

test('unsupported stages and missing private evidence cannot produce a passing gate', (t) => {
  const { root } = fixture(t);
  const cli = resolve(fileURLToPath(new URL('../tools/verify_engine_app_boundary.mjs', import.meta.url)));
  for (const stage of ['foundation', 'cutover']) {
    const env = { ...process.env }; delete env.CITYSCROLL_ENGINE_APP_LEDGER;
    const result = spawnSync(process.execPath, [cli, '--stage', stage, '--root', root], { encoding: 'utf8', env });
    assert.equal(result.status, 1); assert.ok(!result.stdout.includes('PASS'));
  }
});

test('AST ignores import examples in comments, strings, regex and template text', (t) => {
  const { inventory, ledger } = fixture(t, { 'capabilities/read.mjs': [
    '// import(variable)',
    '/* require(variable) */',
    'const command = "node -e import(variable)";',
    'const pattern = /import\\(variable\\)/;',
    'const template = `require(variable)`;',
    'export const value = command + template + pattern.source;',
  ].join('\n') });
  assert.deepEqual(inventory.unresolved, []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('template interpolations contain real imports while constant template specifiers resolve', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'export const value = `${import(`../worker/src/identity.mjs`)}`;',
    'worker/src/identity.mjs': 'export const identity = "private";',
  });
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(inventory.edges.some((e) => e.to === 'worker/src/identity.mjs'));
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('escaped literal imports and require identifiers are decoded by the AST', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'export const value = requ\\u0069re("../worker/src/\\u0069dentity.mjs");',
    'worker/src/identity.mjs': 'export const identity = "private";',
  });
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('transitive imports outside runtime prefixes are traversed and checked', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'export {value} from "../shared/public.mjs";',
    'shared/public.mjs': 'export {value} from "./private.mjs";',
    'shared/private.mjs': 'export const value = "private";',
  });
  ledger.units.find((u) => u.id === 'file:shared/public.mjs').target_owner = 'engine';
  ledger.units.find((u) => u.id === 'file:shared/private.mjs').target_owner = 'identity';
  assert.ok(inventory.observation.parsed.includes('shared/private.mjs'));
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('negative test fixtures are data until a real root imports them', (t) => {
  const { inventory, ledger, root, git } = fixture(t, { 'tools/fixtures/broken.mjs': '!!! not valid JavaScript' });
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
  writeFileSync(join(root, 'capabilities/read.mjs'), 'import "../tools/fixtures/broken.mjs"; export const value = 1;');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Reach fixture');
  const reached = collectInventory({ root });
  assert.ok(reached.unresolved.some((f) => f.code === 'SOURCE_PARSE_FAILED' && f.path === 'tools/fixtures/broken.mjs'));
});

test('declared runtime outside the usual roots is observed', (t) => {
  const { inventory, ledger } = fixture(t, {
    'deploy/wrangler.toml': 'name="synthetic-other"\nmain="../shared/entry.mjs"\n',
    'shared/entry.mjs': 'export const value = import(runtimeTarget);',
  });
  assert.ok(inventory.observation.parsed.includes('shared/entry.mjs'));
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER'));
});

test('computed templates, loader aliases and evaluated code fail closed', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'const loader = require; const evaluate = eval; const name="read"; export const value = import(`./${name}.mjs`);',
  });
  const codes = new Set(verifyLedger(inventory, ledger).findings.map((f) => f.code));
  assert.ok(codes.has('DYNAMIC_IMPORT_REQUIRES_OBSERVER'));
  assert.ok(codes.has('LOADER_REFERENCE_REQUIRES_OBSERVER'));
  assert.ok(codes.has('INDIRECT_CODE_LOADING_REQUIRES_OBSERVER'));
});

test('draft review state, malformed effects and duplicate split roles cannot pass', (t) => {
  const { inventory, ledger } = fixture(t);
  ledger.review_state = 'draft';
  ledger.units[0].effects = 'recipient-state';
  ledger.units[1].target_owner = 'split'; ledger.units[1].partitions = ['engine','engine'];
  const codes = new Set(verifyLedger(inventory, ledger).findings.map((f) => f.code));
  assert.ok(codes.has('LEDGER_NOT_REVIEWED'));
  assert.ok(codes.has('EFFECTS_INVALID'));
  assert.ok(codes.has('SPLIT_RESPONSIBILITY_MISSING'));
});

test('split ownership cannot conceal an engine import into private code', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'export {value} from "../worker/src/identity.mjs";',
    'worker/src/identity.mjs': 'export const value = "private";',
  });
  const engine = ledger.units.find((u) => u.id === 'file:capabilities/read.mjs');
  engine.target_owner = 'split'; engine.partitions = ['engine','presentation'];
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});


test('JSON imports retain ownership edges, validate data and cannot hide private owners', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'import value from "../shared/input.json" with {type:"json"}; export {value};',
    'shared/input.json': '{"value":"synthetic"}',
  });
  assert.deepEqual(inventory.unresolved, []);
  ledger.units.find((u) => u.id === 'file:shared/input.json').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('invalid JSON imports fail without evaluating source', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'import value from "../shared/input.json" with {type:"json"}; export {value};',
    'shared/input.json': 'not valid JSON',
  });
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'IMPORTED_DATA_PARSE_FAILED'));
});

test('ordinary property labels do not become code-loader references', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'const options = {require:true, eval:false, Function:1}; export const value = options.require;',
  });
  assert.deepEqual(inventory.unresolved, []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('engine dependencies on private external packages are rejected', (t) => {
  const { inventory, ledger } = fixture(t, { 'capabilities/read.mjs': 'import value from "synthetic-mail-client"; export {value};' });
  ledger.units.find((u) => u.kind === 'external-import').target_owner = 'delivery';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_EXTERNAL_IMPORT'));
});

test('a hardlink receipt cannot overwrite the private ownership ledger', (t) => {
  const { root, home, ledger } = fixture(t);
  const privateFile = join(home,'ledger.json'), receipt = join(home,'receipt.json');
  writeFileSync(privateFile,JSON.stringify(ledger)); linkSync(privateFile,receipt);
  const cli = fileURLToPath(new URL('../tools/verify_engine_app_boundary.mjs',import.meta.url));
  const result = spawnSync(process.execPath,[cli,'--stage','foundation','--root',root,'--receipt',receipt],{encoding:'utf8',env:{...process.env,CITYSCROLL_ENGINE_APP_LEDGER:privateFile}});
  assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(readFileSync(privateFile,'utf8')),ledger);
});
