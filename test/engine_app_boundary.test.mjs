import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const durableConfig = 'name="synthetic"\nmain="src/worker.mjs"\n[[durable_objects.bindings]]\nname="SYNTHETIC_ACTOR"\nclass_name="SyntheticActor"\n[[migrations]]\ntag="v1"\nnew_sqlite_classes=["SyntheticActor"]\n';

test('Durable Object bindings and migration history require explicit ledger ownership', (t) => {
  const { inventory, ledger } = fixture(t, { 'worker/wrangler.toml': durableConfig });
  const binding = inventory.units.find((u) => u.id === 'binding:worker/wrangler.toml#durable_objects.bindings.0:SYNTHETIC_ACTOR');
  const migration = inventory.units.find((u) => u.kind === 'durable-object-migration');
  assert.ok(binding); assert.ok(migration);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
  ledger.units = ledger.units.filter((u) => ![binding.id, migration.id].includes(u.id));
  const findings = verifyLedger(inventory, ledger).findings;
  for (const unit of [binding, migration]) assert.ok(findings.some((f) => f.code === 'UNCLASSIFIED_UNIT' && f.id === unit.id));
});

test('Durable Object recipient-state bindings cannot be assigned to the engine', (t) => {
  const { inventory, ledger } = fixture(t, { 'worker/wrangler.toml': durableConfig });
  const binding = ledger.units.find((u) => u.kind === 'binding');
  binding.target_owner = 'engine'; binding.effects = ['recipient-state'];
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'FORBIDDEN_BINDING_OR_EFFECT' && f.id === binding.id));
});

test('Durable Object class, external Worker and migration changes invalidate binding evidence', async (t) => {
  for (const [name, change] of [
    ['class', (text) => text.replace('class_name="SyntheticActor"', 'class_name="ReplacementActor"')],
    ['external Worker', (text) => text.replace('class_name="SyntheticActor"', 'class_name="SyntheticActor"\nscript_name="external-synthetic"\nenvironment="staging"')],
    ['migration', (text) => text.replace('new_sqlite_classes=["SyntheticActor"]', 'new_classes=["SyntheticActor"]')],
  ]) await t.test(name, (sub) => {
    const { inventory, ledger, root, git } = fixture(sub, { 'worker/wrangler.toml': durableConfig });
    const before = inventory.units.find((u) => u.kind === 'binding');
    writeFileSync(join(root, 'worker/wrangler.toml'), change(durableConfig));
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Change synthetic Durable Object');
    const updated = collectInventory({ root });
    const after = updated.units.find((u) => u.id === before.id);
    assert.notEqual(after.evidence_sha256, before.evidence_sha256);
    const refreshed = { ...ledger, source_revision:updated.source_revision, units:updated.units.map((unit) => ({ ...ledger.units.find((row) => row.id === unit.id), ...unit })) };
    assert.equal(verifyLedger(updated, refreshed).status, 'PASS');
    refreshed.units.find((unit) => unit.id === before.id).evidence_sha256 = before.evidence_sha256;
    assert.ok(verifyLedger(updated, refreshed).findings.some((f) => f.code === 'SOURCE_EVIDENCE_STALE' && f.id === before.id));
  });
});

test('Durable Object environment bindings stay distinct and arbitrary names are not bindings', (t) => {
  const config = durableConfig + '\n[vars]\nname="NOT_A_BINDING"\nmigrations="NOT_A_MIGRATION"\n[[env.staging.durable_objects.bindings]]\nname="SYNTHETIC_ACTOR"\nclass_name="StagingActor"\n';
  const { inventory, ledger } = fixture(t, { 'worker/wrangler.toml': config });
  const bindings = inventory.units.filter((u) => u.kind === 'binding');
  assert.deepEqual(bindings.map((u) => u.id).sort(), [
    'binding:worker/wrangler.toml#durable_objects.bindings.0:SYNTHETIC_ACTOR',
    'binding:worker/wrangler.toml#env.staging.durable_objects.bindings.0:SYNTHETIC_ACTOR',
  ]);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('malformed Durable Object binding and migration declarations fail closed', async (t) => {
  for (const [code, config] of [
    ['DURABLE_OBJECT_BINDING_INVALID', 'name="synthetic"\n[durable_objects]\nbindings="invalid"\n'],
    ['DURABLE_OBJECT_BINDING_INVALID', 'name="synthetic"\n[[durable_objects.bindings]]\nname="MISSING_CLASS"\n'],
    ['DURABLE_OBJECT_MIGRATION_INVALID', 'name="synthetic"\nmigrations="invalid"\n'],
    ['DURABLE_OBJECT_MIGRATION_INVALID', 'name="synthetic"\n[[migrations]]\nnew_sqlite_classes=["MissingTag"]\n'],
  ]) await t.test(code, (sub) => {
    const { inventory, ledger } = fixture(sub, { 'worker/wrangler.toml': config });
    assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === code));
  });
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

test('immutable import bindings still fail for missing source targets', (t) => {
  const { inventory, ledger } = fixture(t, { 'capabilities/read.mjs': 'const path = "./unknown.mjs"; export const value = import(path);' });
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'UNRESOLVED_IMPORT'));
  assert.equal(verifyLedger(inventory, ledger).status, 'FAIL');
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

test('immutable lexical const literal import records its target and follows transitive source', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/read.mjs': 'const TARGET = "../shared/entry.mjs"; export async function load() { return import(TARGET); } export const value = 1;',
    'shared/entry.mjs': 'export {value} from "../worker/src/identity.mjs";',
    'worker/src/identity.mjs': 'export const value = "private";',
  });
  assert.ok(inventory.edges.some((e) => e.from === 'capabilities/read.mjs' && e.to === 'shared/entry.mjs'));
  assert.ok(inventory.observation.parsed.includes('shared/entry.mjs'));
  assert.ok(!inventory.unresolved.some((f) => f.path === 'capabilities/read.mjs'));
  ledger.units.find((u) => u.id === 'file:shared/entry.mjs').target_owner = 'engine';
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('ambiguous, shadowed, mutable and uninitialized import bindings remain unresolved', async (t) => {
  const cases = {
    'function parameter': 'const TARGET="../shared/safe.mjs"; export function load(TARGET) { return import(TARGET); }',
    'default parameter': 'const TARGET="../shared/safe.mjs"; export function load(TARGET="../shared/private.mjs") { return import(TARGET); }',
    'block let shadow before declaration': 'const TARGET="../shared/safe.mjs"; { import(TARGET); let TARGET="../shared/private.mjs"; }',
    'block const TDZ': 'const TARGET="../shared/safe.mjs"; { import(TARGET); const TARGET="../shared/private.mjs"; }',
    'catch parameter': 'const TARGET="../shared/safe.mjs"; try {} catch(TARGET) { import(TARGET); }',
    'catch destructuring': 'const TARGET="../shared/safe.mjs"; try {} catch({TARGET}) { import(TARGET); }',
    'hoisted function var': 'const TARGET="../shared/safe.mjs"; export function load() { import(TARGET); if(false) { var TARGET="../shared/private.mjs"; } }',
    'function declaration': 'const TARGET="../shared/safe.mjs"; { function TARGET() {} import(TARGET); }',
    'named function expression': 'const TARGET="../shared/safe.mjs"; export const load=function TARGET() { return import(TARGET); };',
    'destructured const': 'const TARGET="../shared/safe.mjs"; { const {TARGET}=options; import(TARGET); }',
    'array destructured parameter': 'const TARGET="../shared/safe.mjs"; export function load([TARGET]) { return import(TARGET); }',
    'for binding': 'const TARGET="../shared/safe.mjs"; for(let TARGET of options) { import(TARGET); }',
    'mutable let': 'let TARGET="../shared/safe.mjs"; export const value=import(TARGET);',
    'mutable var': 'var TARGET="../shared/safe.mjs"; export const value=import(TARGET);',
    'direct TDZ': 'export const value=import(TARGET); const TARGET="../shared/safe.mjs";',
    'closure before const despite later invocation': 'function load() { return import(TARGET); } const TARGET="../shared/safe.mjs"; export const value=load();',
    'alias initializer': 'const SOURCE="../shared/safe.mjs"; const TARGET=SOURCE; export const value=import(TARGET);',
    'dynamic initializer': 'const TARGET=choose(); export const value=import(TARGET);',
    'computed import template': 'const TARGET="../shared/safe.mjs"; export const value=import(`${TARGET}`);',
  };
  for (const [name, source] of Object.entries(cases)) await t.test(name, (subtest) => {
    const { inventory } = fixture(subtest, {
      'capabilities/read.mjs': source,
      'shared/safe.mjs': 'export const safe=true;',
      'shared/private.mjs': 'export const privateValue=true;',
    });
    assert.ok(inventory.unresolved.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER' && f.path === 'capabilities/read.mjs'), name);
    assert.ok(!inventory.edges.some((e) => e.from === 'capabilities/read.mjs'), name);
  });
});

test('closest immutable block binding wins without adding an outer target', (t) => {
  const { inventory } = fixture(t, {
    'capabilities/read.mjs': 'const TARGET="../shared/outer.mjs"; { const TARGET="../shared/inner.mjs"; import(TARGET); } export const value=1;',
    'shared/outer.mjs': 'export const outer=true;',
    'shared/inner.mjs': 'export const inner=true;',
  });
  assert.ok(inventory.edges.some((e) => e.from === 'capabilities/read.mjs' && e.to === 'shared/inner.mjs'));
  assert.ok(!inventory.edges.some((e) => e.from === 'capabilities/read.mjs' && e.to === 'shared/outer.mjs'));
  assert.deepEqual(inventory.unresolved, []);
});

test('function parameter initializers do not see body-only const declarations', (t) => {
  const { inventory } = fixture(t, {
    'capabilities/read.mjs': 'const TARGET="../shared/outer.mjs"; export function load(value=import(TARGET)) { const TARGET="../shared/inner.mjs"; return value; }',
    'shared/outer.mjs': 'export const outer=true;',
    'shared/inner.mjs': 'export const inner=true;',
  });
  assert.ok(inventory.edges.some((e) => e.from === 'capabilities/read.mjs' && e.to === 'shared/outer.mjs'));
  assert.ok(!inventory.edges.some((e) => e.from === 'capabilities/read.mjs' && e.to === 'shared/inner.mjs'));
  assert.deepEqual(inventory.unresolved, []);
});


test('a CommonJS function arguments object shadows an outer const of the same name', (t) => {
  const { inventory } = fixture(t, {
    'capabilities/read.mjs': 'export const value=1;',
    'capabilities/reader.cjs': 'const arguments="../shared/safe.mjs"; function load() { return import(arguments); }',
    'shared/safe.mjs': 'export const safe=true;',
  });
  assert.ok(inventory.unresolved.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER' && f.path === 'capabilities/reader.cjs'));
  assert.ok(!inventory.edges.some((e) => e.from === 'capabilities/reader.cjs'));
});


test('classic and CommonJS script bindings remain unsupported rather than guessing Annex B scopes', (t) => {
  const { inventory } = fixture(t, {
    'capabilities/read.mjs': 'export const value=1;',
    'capabilities/classic.js': 'const TARGET="../shared/safe.mjs"; function load() { if(true) { function TARGET() {} } return import(TARGET); }',
    'capabilities/common.cjs': 'const TARGET="../shared/safe.mjs"; function load() { if(true) { function TARGET() {} } return import(TARGET); }',
    'shared/safe.mjs': 'export const safe=true;',
  });
  for (const path of ['capabilities/classic.js','capabilities/common.cjs']) {
    assert.ok(inventory.unresolved.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER' && f.path === path));
    assert.ok(!inventory.edges.some((e) => e.from === path));
  }
});

test('synthetic URLs on reserved documentation hosts are not management clauses', (t) => {
  const { inventory, ledger } = fixture(t, {
    'site/tail.mjs': [
      'const webSocketTail = "wss://tail.example/session";',
      'const credentialedTail = "https://user:secret@tail.example/session";',
      'const loopback = "http://localhost:8080/session";',
      'const uppercaseTail = "https://TAIL.EXAMPLE/following";',
      'const reservedHook = "https://hooks.example.net/confirm?token=x";',
      'export const synthetic = [webSocketTail, credentialedTail, loopback, uppercaseTail, reservedHook];',
    ].join('\n'),
  });
  assert.deepEqual(inventory.units.filter((u) => u.kind === 'management-clause' && u.path === 'site/tail.mjs'), []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('real management calls remain detected, including absolute production URLs', (t) => {
  const { inventory, ledger } = fixture(t, {
    'worker/src/session.mjs': 'export function route(pathname) { return pathname === "/session" || pathname === "/session/logout"; }\nexport const unsubscribeLink = "https://api.cityscroll.org/unsubscribe?token=example";\n',
  });
  const claims = inventory.units.filter((u) => u.kind === 'management-clause' && u.path === 'worker/src/session.mjs');
  assert.equal(claims.length, 3);
  ledger.units = ledger.units.filter((u) => u.kind !== 'management-clause');
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'UNCLASSIFIED_UNIT' && f.id.startsWith('management-clause:worker/src/session.mjs')));
});

test('tracked modules outside runtime prefixes are observed with module, data and transport edges', (t) => {
  const { inventory, ledger } = fixture(t, {
    'integrations/generated-client/manifest.json': '{"version":"synthetic"}',
    'integrations/generated-client/index.mjs': [
      'import manifest from "./manifest.json" with { type: "json" };',
      'export function createMcpHttpTransport({ baseUrl = "https://api.cityscroll.org", fetchImpl = globalThis.fetch, headers = {} } = {}) {',
      '  if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");',
      '  const endpoint = new URL("/mcp", baseUrl).toString();',
      '  return Object.freeze({ async call() { return fetchImpl(endpoint, { method: "POST", headers }); } });',
      '}',
      'export const version = manifest.version;',
    ].join('\n'),
    'integrations/generated-client/recipes/procurement-investigation.mjs': 'import { createMcpHttpTransport } from "../index.mjs";\nexport const recipe = createMcpHttpTransport;\n',
  });
  assert.ok(inventory.observation.parsed.includes('integrations/generated-client/index.mjs'));
  assert.ok(inventory.observation.parsed.includes('integrations/generated-client/recipes/procurement-investigation.mjs'));
  assert.ok(inventory.edges.some((e) => e.from === 'integrations/generated-client/recipes/procurement-investigation.mjs' && e.to === 'integrations/generated-client/index.mjs'));
  assert.ok(inventory.edges.some((e) => e.from === 'integrations/generated-client/index.mjs' && e.to === 'integrations/generated-client/manifest.json'));
  const transport = inventory.units.filter((u) => u.kind === 'injected-transport' && u.path === 'integrations/generated-client/index.mjs');
  assert.ok(transport.length >= 2, 'the default site and the call through it are both observed');
  assert.deepEqual(inventory.unresolved, []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('every tracked module outside test locations is observed, never silently edge-less', (t) => {
  const { inventory, ledger } = fixture(t, {
    'packages/deep/thing.mjs': 'export const value = 1;',
    'cli.mjs': 'export const value = 1;',
    'ops/jobs/run.cjs': 'module.exports = 1;',
    'worker/e2e/probe.mjs': 'export const value = 1;',
  });
  for (const path of ['packages/deep/thing.mjs', 'cli.mjs', 'ops/jobs/run.cjs', 'worker/e2e/probe.mjs'])
    assert.ok(inventory.observation.parsed.includes(path), path);
  assert.ok(!inventory.unresolved.some((f) => f.code === 'UNOBSERVED_SOURCE_MODULE'));
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('a locally defined require helper is not a module loader', (t) => {
  const { inventory, ledger } = fixture(t, {
    'warehouse/lib/review_event_log.mjs': [
      'export function buildReviewEventLog(record) {',
      '  const require = (field, predicate, description) => { if (!predicate(record[field])) throw new Error(String(description)); };',
      '  require("document_key", (value) => typeof value === "string", "must be a non-empty string");',
      '  require("document_type", (value) => value === "final", "must be a final document");',
      '  return record;',
      '}',
    ].join('\n'),
  });
  assert.ok(!inventory.units.some((u) => u.kind === 'external-import' && u.path === 'warehouse/lib/review_event_log.mjs'));
  assert.deepEqual(inventory.unresolved.filter((f) => f.path === 'warehouse/lib/review_event_log.mjs'), []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('a createRequire-backed require still records real module loads', (t) => {
  const { inventory, ledger } = fixture(t, {
    'ontology/live_inventory.mjs': 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const registry = require("../worker/src/identity.mjs");\n',
    'worker/src/identity.mjs': 'export const value = "private";\n',
  });
  assert.ok(inventory.edges.some((e) => e.from === 'ontology/live_inventory.mjs' && e.to === 'worker/src/identity.mjs'));
  ledger.units.find((u) => u.id === 'file:ontology/live_inventory.mjs').target_owner = 'engine';
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('an unresolvable require binding fails closed instead of guessing', (t) => {
  const { inventory } = fixture(t, {
    'capabilities/loader.mjs': 'const require = getLoader();\nexport const value = require("../shared/safe.mjs");\n',
    'shared/safe.mjs': 'export const safe = true;\n',
  });
  assert.ok(inventory.unresolved.some((f) => f.code === 'LOADER_BINDING_REQUIRES_OBSERVER' && f.path === 'capabilities/loader.mjs'));
  assert.ok(!inventory.edges.some((e) => e.from === 'capabilities/loader.mjs'));
});

test('python sources are observed by parsing imports without executing them', (t) => {
  const { inventory, ledger } = fixture(t, {
    'tools/helper.py': 'HELPER = True\n',
    'scripts/__init__.py': '',
    'scripts/sibling.py': 'SIBLING = True\n',
    'scripts/run.py': [
      'import sys',
      'import json',
      'import tools.helper',
      'from importlib import import_module',
      'dynamic_helper = import_module("tools.helper")',
      'json_module = __import__("json")',
      'from scripts.sibling import SIBLING',
      'import subprocess',
      'subprocess.run(["node", "site/build.mjs"], check=True)',
      'if tools.helper.HELPER and SIBLING:',
      '    raise SystemExit("the observer must never execute this module")',
    ].join('\n'),
    'site/build.mjs': 'export const value = 1;\n',
  });
  assert.ok(inventory.observation.parsed.includes('scripts/run.py'));
  assert.ok(inventory.edges.some((e) => e.from === 'scripts/run.py' && e.to === 'tools/helper.py'));
  assert.ok(inventory.edges.some((e) => e.from === 'scripts/run.py' && e.to === 'scripts/sibling.py'));
  assert.ok(inventory.edges.some((e) => e.from === 'scripts/run.py' && e.to === 'site/build.mjs'));
  assert.ok(inventory.units.some((u) => u.id === 'external-import:scripts/run.py#json'));
  assert.deepEqual(inventory.unresolved, []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('relative python imports resolve within their package', (t) => {
  const { inventory, ledger } = fixture(t, {
    'pkg/__init__.py': '',
    'pkg/cli.py': 'from .util import helper\nfrom . import sibling\n',
    'pkg/util.py': 'def helper():\n    return 1\n',
    'pkg/sibling.py': 'SIBLING = True\n',
  });
  assert.ok(inventory.edges.some((e) => e.from === 'pkg/cli.py' && e.to === 'pkg/util.py'));
  assert.ok(inventory.edges.some((e) => e.from === 'pkg/cli.py' && e.to === 'pkg/sibling.py'));
  assert.ok(inventory.edges.some((e) => e.from === 'pkg/cli.py' && e.to === 'pkg/__init__.py'));
  assert.deepEqual(inventory.unresolved, []);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
});

test('unsupported python loading forms fail closed with coverage blockers', (t) => {
  const { inventory } = fixture(t, {
    'tools/dynamic_loader.py': [
      'import importlib',
      'import importlib.util',
      'import subprocess',
      'name = "os"',
      'module = importlib.import_module(name)',
      'spec = importlib.util.spec_from_file_location("mod", name)',
      'cmd = ["node", "tools/build.mjs"]',
      'subprocess.run(cmd)',
      'exec("import os")',
    ].join('\n'),
    'tools/build.mjs': 'export const value = 1;\n',
    'tools/fixtures/broken.py': 'def (:\n',
  });
  const byCode = new Map();
  for (const finding of inventory.unresolved) byCode.set(finding.code, (byCode.get(finding.code) || 0) + 1);
  // import_module(name) is not followed through bindings; the spec location
  // evaluates to the constant "os", which names no tracked file.
  assert.equal(byCode.get('PYTHON_IMPORT_REQUIRES_OBSERVER'), 1);
  assert.ok(inventory.unresolved.some((f) => f.code === 'PYTHON_IMPORT_UNRESOLVED' && f.location === 'spec:os'));
  assert.equal(byCode.get('PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER'), 1);
  assert.equal(byCode.get('PYTHON_DYNAMIC_CODE_REQUIRES_OBSERVER'), 1);
  assert.ok(inventory.unresolved.some((f) => f.code === 'PYTHON_SOURCE_PARSE_FAILED' && f.path === 'tools/fixtures/broken.py'));
});

test('python edges participate in ownership boundary checks', (t) => {
  const { inventory, ledger } = fixture(t, {
    'capabilities/engine_probe.py': 'import subprocess\nsubprocess.run(["node", "worker/src/identity.mjs"], check=True)\n',
    'worker/src/identity.mjs': 'export const value = "private";\n',
  });
  assert.ok(inventory.edges.some((e) => e.from === 'capabilities/engine_probe.py' && e.to === 'worker/src/identity.mjs'));
  ledger.units.find((u) => u.id === 'file:capabilities/engine_probe.py').target_owner = 'engine';
  ledger.units.find((u) => u.id === 'file:worker/src/identity.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

const siteHash = (text) => createHash('sha256').update(text).digest('hex');
const declarations = (...entries) => JSON.stringify({ schema: 'source-boundary-declarations.v1', declarations: entries });
const injectedSite = 'import(process.env.SYNTHETIC_TRANSPORT_MODULE)';
const injectedModule = `export async function load() { return ${injectedSite}; }\n`;
const injectedDeclaration = {
  code: 'DYNAMIC_IMPORT_REQUIRES_OBSERVER', path: 'tools/injected.mjs', site_sha256: siteHash(injectedSite),
  classification: 'operator-supplied-module', reason: 'The operator names a transport module at run time; none is tracked.',
};

test('a declared loading site becomes a declared unit the ledger must still classify', (t) => {
  const { inventory, ledger } = fixture(t, {
    'tools/injected.mjs': injectedModule,
    'architecture/source-boundary-declarations.json': declarations(injectedDeclaration),
  });
  assert.deepEqual(inventory.unresolved, []);
  const unit = inventory.units.find((u) => u.kind === 'declared-site' && u.path === 'tools/injected.mjs');
  assert.ok(unit);
  assert.equal(verifyLedger(inventory, ledger).status, 'PASS');
  ledger.units = ledger.units.filter((u) => u.id !== unit.id);
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'UNCLASSIFIED_UNIT' && f.id === unit.id));
});

test('an undeclared site, a changed declared site and an unused declaration all fail closed', (t) => {
  const { inventory, root, git } = fixture(t, {
    'tools/injected.mjs': `${injectedModule}export const other = (name) => import(name);\n`,
    'architecture/source-boundary-declarations.json': declarations(injectedDeclaration),
  });
  assert.deepEqual(inventory.unresolved.map((f) => f.code), ['DYNAMIC_IMPORT_REQUIRES_OBSERVER']);
  writeFileSync(join(root, 'tools/injected.mjs'), 'export async function load() { return import(process.env.OTHER_MODULE); }\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Change declared site');
  const changed = collectInventory({ root });
  const codes = changed.unresolved.map((f) => f.code).sort();
  assert.deepEqual(codes, ['DYNAMIC_IMPORT_REQUIRES_OBSERVER', 'OBSERVER_DECLARATION_STALE']);
  assert.ok(!changed.units.some((u) => u.kind === 'declared-site'));
});

test('malformed, undeclarable and duplicate declarations are rejected and declare nothing', async (t) => {
  const cases = {
    'missing reason': { ...injectedDeclaration, reason: '' },
    'unknown classification': { ...injectedDeclaration, classification: 'trusted' },
    'unknown field': { ...injectedDeclaration, waiver: true },
    'undeclarable code': { ...injectedDeclaration, code: 'SOURCE_PARSE_FAILED' },
    'untracked path': { ...injectedDeclaration, path: 'tools/missing.mjs' },
    'targeted classification without targets': { ...injectedDeclaration, classification: 'computed-repository-module' },
  };
  for (const [name, entry] of Object.entries(cases)) await t.test(name, (sub) => {
    const { inventory } = fixture(sub, { 'tools/injected.mjs': injectedModule, 'architecture/source-boundary-declarations.json': declarations(entry) });
    const codes = inventory.unresolved.map((f) => f.code);
    assert.ok(codes.includes('OBSERVER_DECLARATION_INVALID'));
    assert.ok(codes.includes('DYNAMIC_IMPORT_REQUIRES_OBSERVER'));
  });
  await t.test('duplicate', (sub) => {
    const { inventory } = fixture(sub, { 'tools/injected.mjs': injectedModule, 'architecture/source-boundary-declarations.json': declarations(injectedDeclaration, injectedDeclaration) });
    assert.ok(inventory.unresolved.some((f) => f.code === 'OBSERVER_DECLARATION_INVALID'));
  });
  await t.test('not JSON', (sub) => {
    const { inventory } = fixture(sub, { 'tools/injected.mjs': injectedModule, 'architecture/source-boundary-declarations.json': '{' });
    assert.ok(inventory.unresolved.some((f) => f.code === 'OBSERVER_DECLARATION_INVALID'));
    assert.ok(inventory.unresolved.some((f) => f.code === 'DYNAMIC_IMPORT_REQUIRES_OBSERVER'));
  });
});

test('declared targets become observed ownership edges, including modules outside the source roots', (t) => {
  const site = 'require(join(root, "test/fixtures/cases.mjs"))';
  const { inventory, ledger } = fixture(t, {
    'capabilities/loader.mjs': `import { createRequire } from "node:module";\nimport { join } from "node:path";\nconst require = createRequire(import.meta.url);\nexport const load = (root) => ${site};\n`,
    'test/fixtures/cases.mjs': 'export { value } from "../../worker/src/identity.mjs";\n',
    'worker/src/identity.mjs': 'export const value = "private";\n',
    'architecture/source-boundary-declarations.json': declarations({
      code: 'DYNAMIC_IMPORT_REQUIRES_OBSERVER', path: 'capabilities/loader.mjs', site_sha256: siteHash(site),
      classification: 'computed-repository-module', reason: 'Loads the case module beneath a caller-supplied root.', targets: ['test/fixtures/cases.mjs'],
    }),
  });
  assert.deepEqual(inventory.unresolved, []);
  assert.ok(inventory.observation.parsed.includes('test/fixtures/cases.mjs'));
  assert.ok(inventory.edges.some((e) => e.from === 'capabilities/loader.mjs' && e.to === 'test/fixtures/cases.mjs'));
  assert.ok(inventory.edges.some((e) => e.from === 'test/fixtures/cases.mjs' && e.to === 'worker/src/identity.mjs'));
  ledger.units.find((u) => u.id === 'file:test/fixtures/cases.mjs').target_owner = 'identity';
  assert.ok(verifyLedger(inventory, ledger).findings.some((f) => f.code === 'REVERSE_IMPORT'));
});

test('a declared target that is not tracked keeps the site unresolved', (t) => {
  const { inventory } = fixture(t, {
    'tools/injected.mjs': injectedModule,
    'architecture/source-boundary-declarations.json': declarations({ ...injectedDeclaration, targets: ['tools/absent.mjs'] }),
  });
  const codes = inventory.unresolved.map((f) => f.code).sort();
  assert.deepEqual(codes, ['DYNAMIC_IMPORT_REQUIRES_OBSERVER', 'OBSERVER_DECLARATION_TARGET_INVALID']);
});

test('a const createRequire loader of any name is observed through its calls', (t) => {
  const { inventory } = fixture(t, {
    'tools/data_loader.mjs': 'import { createRequire } from "node:module";\nconst requireJson = createRequire(import.meta.url);\nexport const data = requireJson("../site/data.json");\nexport const view = requireJson("../worker/src/identity.mjs");\n',
    'site/data.json': '{"ok":true}\n',
    'worker/src/identity.mjs': 'export const value = "private";\n',
  });
  assert.deepEqual(inventory.unresolved, []);
  assert.ok(inventory.edges.some((e) => e.from === 'tools/data_loader.mjs' && e.to === 'site/data.json'));
  assert.ok(inventory.edges.some((e) => e.from === 'tools/data_loader.mjs' && e.to === 'worker/src/identity.mjs'));
});

test('createRequire loaders that escape a const binding still fail closed', async (t) => {
  const cases = {
    'mutable binding': ['let requireLater = createRequire(import.meta.url);\nexport const value = requireLater("../shared/safe.mjs");\n', 'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER'],
    'handed to other code': ['const load = createRequire(import.meta.url);\nexport const loaders = [load];\n', 'LOADER_REFERENCE_REQUIRES_OBSERVER'],
    'called immediately': ['export const value = createRequire(import.meta.url)("../shared/safe.mjs");\n', 'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER'],
    'member form, unbound': ['import * as nodeModule from "node:module";\nexport const value = nodeModule.createRequire(import.meta.url)("../shared/safe.mjs");\n', 'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER'],
    'computed specifier': ['const load = createRequire(import.meta.url);\nexport const value = (name) => load(name);\n', 'DYNAMIC_IMPORT_REQUIRES_OBSERVER'],
    'exported by declaration': ['export const load = createRequire(import.meta.url);\n', 'LOADER_REFERENCE_REQUIRES_OBSERVER'],
    'exported by specifier': ['const load = createRequire(import.meta.url);\nexport { load as loader };\n', 'LOADER_REFERENCE_REQUIRES_OBSERVER'],
  };
  for (const [name, [body, code]] of Object.entries(cases)) await t.test(name, (sub) => {
    const { inventory } = fixture(sub, {
      'tools/loader.mjs': `import { createRequire } from "node:module";\n${body}`,
      'shared/safe.mjs': 'export const safe = true;\n',
    });
    assert.ok(inventory.unresolved.some((f) => f.code === code && f.path === 'tools/loader.mjs'), JSON.stringify(inventory.unresolved));
  });
});

test('a typeof feature test is not a loader reference, and constructors are reported once', (t) => {
  const { inventory } = fixture(t, {
    'site/shim.js': 'if (typeof require === "function") { globalThis.shim = true; }\n',
    'tools/evaluate.mjs': 'export const make = (body) => new Function("x", body);\n',
  });
  assert.deepEqual(inventory.unresolved.filter((f) => f.path === 'site/shim.js'), []);
  assert.deepEqual(inventory.unresolved.filter((f) => f.path === 'tools/evaluate.mjs').map((f) => f.code), ['INDIRECT_CODE_LOADING_REQUIRES_OBSERVER']);
});

test('a relative import into an installed package resolves only when its manifest declares it', (t) => {
  const { inventory } = fixture(t, {
    'worker/package.json': JSON.stringify({ devDependencies: { '@synthetic/sdk': '1.2.3' } }),
    'tools/client.mjs': 'import { Client } from "../worker/node_modules/@synthetic/sdk/dist/index.js";\nimport { Other } from "../worker/node_modules/undeclared/index.js";\nexport { Client, Other };\n',
  });
  assert.ok(inventory.units.some((u) => u.id === 'external-import:tools/client.mjs#../worker/node_modules/@synthetic/sdk/dist/index.js'));
  assert.deepEqual(inventory.unresolved.map((f) => [f.code, f.location]), [['UNRESOLVED_IMPORT', '../worker/node_modules/undeclared/index.js']]);
});

test('python path constants anchored at the source file resolve script and module targets', (t) => {
  const { inventory } = fixture(t, {
    'tools/server.py': 'SERVER = True\n',
    'tools/render.mjs': 'export const value = 1;\n',
    'tools/verify.py': 'VERIFY = True\n',
    'tools/capture.py': [
      'import importlib.util, subprocess, sys',
      'from pathlib import Path',
      'ROOT = Path(__file__).resolve().parents[1]',
      'def serve(port, ready):',
      '    subprocess.Popen([sys.executable, str(ROOT / "tools" / "server.py"), "--port", str(port), "--ready-file", str(ready)])',
      '    subprocess.run(["node", str(ROOT / "tools/render.mjs"), str(ready)], check=True)',
      'def load():',
      '    path = Path(__file__).with_name("verify.py")',
      '    return importlib.util.spec_from_file_location("verify", path)',
    ].join('\n'),
  });
  assert.deepEqual(inventory.unresolved, []);
  for (const to of ['tools/server.py', 'tools/render.mjs', 'tools/verify.py']) assert.ok(inventory.edges.some((e) => e.from === 'tools/capture.py' && e.to === to), to);
});

test('shadowed, rebound, closure and escaping python paths are not treated as static', async (t) => {
  const cases = {
    'parameter shadows module constant': ['ROOT = Path(__file__).resolve().parents[1]', 'def run(ROOT):', '    subprocess.run(["node", str(ROOT / "tools/render.mjs"), ROOT])'],
    'rebound module name': ['ROOT = Path(__file__).resolve().parents[1]', 'ROOT = Path("/elsewhere")', 'def run(x):', '    subprocess.run(["node", str(ROOT / "tools/render.mjs"), x])'],
    'closure over an enclosing local': ['def outer(x):', '    script = Path(__file__).parent / "render.mjs"', '    def inner():', '        subprocess.run(["node", str(script), x])', '    return inner'],
    'local assigned after use': ['def run(x):', '    subprocess.run(["node", str(script), x])', '    script = Path(__file__).parent / "render.mjs"'],
    'escapes the repository': ['ROOT = Path(__file__).resolve().parents[3]', 'def run(x):', '    subprocess.run(["node", str(ROOT / "render.mjs"), x])'],
  };
  for (const [name, lines] of Object.entries(cases)) await t.test(name, (sub) => {
    const { inventory } = fixture(sub, {
      'tools/render.mjs': 'export const value = 1;\n',
      'tools/capture.py': ['import subprocess', 'from pathlib import Path', ...lines].join('\n'),
    });
    assert.ok(inventory.unresolved.some((f) => f.code === 'PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER' && f.path === 'tools/capture.py'), JSON.stringify(inventory.unresolved));
  });
});

test('subprocess operands are data only behind a fixed program or an observed tracked script', async (t) => {
  const accepted = {
    'hookless git subcommand': '["git", "-C", str(where), "archive", "--format=tar", revision]',
    'removing a linked git checkout': '["git", "worktree", "remove", "--force", str(where)]',
    'external converter': '["cwebp", "-q", "82", str(where), "-o", revision]',
    'tracked script': '["node", "tools/render.mjs", revision]',
    'module server': '["python3", "-m", "http.server", str(port), "--directory", str(where)]',
    'inline program that loads nothing': '["node", "--input-type=module", "-e", "console.log(process.argv[1])", revision]',
  };
  const rejected = {
    'adding a linked git checkout can run hooks': '["git", "worktree", "add", "--detach", str(where), revision]',
    'git run-time configuration': '["git", "-c", revision, "show", "HEAD"]',
    'git run-time subcommand': '["git", *revision]',
    'inline program loading its run-time operand': '["node", "-e", "require(process.argv[1])", revision]',
    'run-time inline program': '["node", "-e", revision]',
    'untracked script': '["node", "tools/absent.mjs", revision]',
    'test runner loads operands': '["node", "--test", revision]',
    'module runner loads operands': '["python3", "-m", "pytest", revision]',
    'unknown program': '["npx", "--yes", "wrangler", "dev", "--config", str(where)]',
    'run-time script': '["node", str(where), revision]',
  };
  const module = (argv) => ['import subprocess', 'def run(where, revision, port):', `    subprocess.run(${argv})`].join('\n');
  for (const [name, argv] of Object.entries(accepted)) await t.test(`accepts ${name}`, (sub) => {
    const { inventory } = fixture(sub, { 'tools/render.mjs': 'export const value = 1;\n', 'tools/capture.py': module(argv) });
    assert.deepEqual(inventory.unresolved, []);
  });
  for (const [name, argv] of Object.entries(rejected)) await t.test(`rejects ${name}`, (sub) => {
    const { inventory } = fixture(sub, { 'tools/render.mjs': 'export const value = 1;\n', 'tools/capture.py': module(argv) });
    assert.deepEqual(inventory.unresolved.map((f) => f.code), ['PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER']);
  });
});

test('a declared python site is classified and a new undeclared site in the same file still fails', (t) => {
  const site = 'subprocess.run(["node", "-e", SCRIPT, revision])';
  const { inventory } = fixture(t, {
    'tools/capture.py': ['import subprocess', 'SCRIPT = "require(process.argv[1])"', 'def run(revision):', `    ${site}`, '    subprocess.run(["node", "-e", SCRIPT, revision, "x"])'].join('\n'),
    'architecture/source-boundary-declarations.json': declarations({
      code: 'PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER', path: 'tools/capture.py', site_sha256: siteHash(site),
      classification: 'inline-interpreter-program', reason: 'Inline program requires the module path given as its operand by the caller.',
    }),
  });
  assert.ok(inventory.units.some((u) => u.kind === 'declared-site' && u.path === 'tools/capture.py'));
  assert.deepEqual(inventory.unresolved.map((f) => f.code), ['PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER']);
});

test('inline node programs resolve their loads against an evaluated working directory', (t) => {
  const { inventory } = fixture(t, {
    'site/view.mjs': 'export const render = () => "view";\n',
    'site/i18n.js': 'globalThis.STRINGS = {};\n',
    'test/helpers/clock.mjs': 'export { render } from "../../site/view.mjs";\n',
    'tools/capture.py': [
      'import subprocess',
      'from pathlib import Path',
      'ROOT = Path(__file__).resolve().parents[1]',
      'RENDER = "import fs from \\"node:fs\\"; import { render } from \\"./site/view.mjs\\"; console.log(render(process.argv[1]));"',
      'def run(query):',
      '    subprocess.run(["node", "--input-type=module", "-e", RENDER, query], cwd=ROOT, check=True)',
      '    subprocess.run(["node", "-e", "require(process.argv[1])", str(ROOT / "site" / "i18n.js")], check=True)',
      '    subprocess.run(["node", "--import=./test/helpers/clock.mjs", "--input-type=module", "-e", "console.log(1)"], cwd=ROOT, check=True)',
    ].join('\n'),
  });
  assert.deepEqual(inventory.unresolved, []);
  for (const to of ['site/view.mjs', 'site/i18n.js', 'test/helpers/clock.mjs']) assert.ok(inventory.edges.some((e) => e.from === 'tools/capture.py' && e.to === to), to);
  assert.ok(inventory.units.some((u) => u.id === 'external-import:tools/capture.py#node:fs'));
  // A module reached only from Python is observed, with its own imports followed.
  assert.ok(inventory.observation.parsed.includes('test/helpers/clock.mjs'));
  assert.ok(inventory.edges.some((e) => e.from === 'test/helpers/clock.mjs' && e.to === 'site/view.mjs'));
});

test('inline programs whose loads cannot be resolved stay unresolved', async (t) => {
  const cases = {
    'no working directory': '["node", "--input-type=module", "-e", "import \\"./site/view.mjs\\";"]',
    'untracked module': '["node", "--input-type=module", "-e", "import \\"./site/absent.mjs\\";"], cwd=ROOT',
    'run-time operand loaded by position': '["node", "-e", "require(process.argv[1])", where], cwd=ROOT',
    'evaluated code': '["node", "-e", "eval(process.argv[1])", "1"], cwd=ROOT',
    'computed specifier': '["node", "-e", "require(\\"./site/\\" + process.argv[1])", "view.mjs"], cwd=ROOT',
    'aliased loader': '["node", "-e", "const load = require; load(\\"fs\\")"], cwd=ROOT',
    'inline python': '[sys.executable, "-c", "import json"], cwd=ROOT',
    'unparsable program': '["node", "-e", "import {"], cwd=ROOT',
  };
  for (const [name, argv] of Object.entries(cases)) await t.test(name, (sub) => {
    const { inventory } = fixture(sub, {
      'site/view.mjs': 'export const render = () => "view";\n',
      'tools/capture.py': ['import subprocess, sys', 'from pathlib import Path', 'ROOT = Path(__file__).resolve().parents[1]', 'def run(where):', `    subprocess.run(${argv})`].join('\n'),
    });
    assert.deepEqual(inventory.unresolved.map((f) => f.code), ['PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER']);
  });
});

test('the unresolved report lists public site facts without the private ledger', (t) => {
  const { root } = fixture(t, { 'tools/injected.mjs': injectedModule });
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/verify_engine_app_boundary.mjs', import.meta.url)), '--root', root, '--stage', 'foundation', '--report', 'unresolved'], { encoding: 'utf8', env: { ...process.env, CITYSCROLL_ENGINE_APP_LEDGER: '' } });
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.unresolved, [{ code: 'DYNAMIC_IMPORT_REQUIRES_OBSERVER', path: 'tools/injected.mjs', location: '1:38', site_sha256: siteHash(injectedSite) }]);
});
