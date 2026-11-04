#!/usr/bin/env node
/**
 * Verify a private ownership ledger against an immutable Git source inventory.
 * This is a source-boundary check, not proof of deployed privilege separation.
 * Private evidence is read from CITYSCROLL_ENGINE_APP_LEDGER, never bundled.
 * The pinned Acorn parser observes JavaScript syntax without executing
 * application code. Python sources are observed through the standard library
 * ast module only; they are never imported, executed, or deserialized.
 * Configuration parsing requires Python 3.11+ and PyYAML 6.0.3.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact development dependency; resolve through the package, never a host path.
let parser;
try { parser = await import('acorn'); } catch { /* Report a redacted input failure in CLI. */ }
const PARSER_VERSION = '8.19.0';

export const INVENTORY_SCHEMA = 'source-boundary-inventory.v1';
export const LEDGER_SCHEMA = 'source-boundary-ledger.v1';
export const DECLARATIONS_SCHEMA = 'source-boundary-declarations.v1';
export const DECLARATIONS_PATH = 'architecture/source-boundary-declarations.json';
const ROLES = new Set(['engine', 'acquisition', 'presentation', 'identity', 'delivery', 'paid', 'operations', 'tooling', 'data', 'documentation', 'split']);
const PRIVATE_EFFECTS = new Set(['recipient-state', 'mail-send', 'paid-model', 'personal-history']);
const sha = (v) => createHash('sha256').update(v).digest('hex');
const sorted = (xs) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
// Absolute URLs on reserved documentation hosts (RFC 2606/6761) are synthetic
// fixtures; a management-word path segment there is not a management call.
const RESERVED_URL_HOST = /(?:^|\.)(?:localhost|example\.com|example\.net|example\.org|example|invalid|test)$/;
const MANAGEMENT_SEGMENT = /\/(?:unsubscribe|confirm|prefs|following|session)(?:[/'"?\s]|$)/;
function isManagementClause(value) {
  if (!MANAGEMENT_SEGMENT.test(value)) return false;
  try {
    const { hostname } = new URL(value);
    if (hostname && RESERVED_URL_HOST.test(hostname.toLowerCase().replace(/\.$/, ''))) return false;
  } catch { /* Not an absolute URL: a relative route or plain reference keeps the claim. */ }
  return true;
}
const needsText = (path) => /\.(?:mjs|js|cjs|py)$/.test(path) || /(?:^|\/)wrangler\.toml$/.test(path) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || path === 'tools/external_schedule_jobs.json' || path === DECLARATIONS_PATH;

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
}

function parseData(kind, source) {
  // Both parsers consume data only. No workflow/config code is executed.
  const script = kind === 'toml'
    ? 'import sys,json,tomllib; assert sys.version_info >= (3,11); print(json.dumps(tomllib.loads(sys.stdin.read())))'
    : 'import sys,json,yaml; assert sys.version_info >= (3,11) and yaml.__version__ == "6.0.3"; print(json.dumps(yaml.safe_load(sys.stdin.read())))';
  const result = spawnSync('python3', ['-c', script], { input: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('CONFIG_PARSE_FAILED');
  return JSON.parse(result.stdout);
}

// This intentionally resolves a small lexical subset, not JavaScript execution.
// Collect every binding before lookup so later declarations, parameters and var
// hoisting cannot accidentally expose an outer constant of the same name.
// Each collected claim also records a flavor so a call through an identifier
// can be classified without executing anything: whether the callee is an
// ambient loader, a locally defined helper, or an unknowable binding.
function immutableImportBindings(tree, literal) {
  const nodeScopes = new WeakMap();
  const scope = (parent, kind) => ({parent,kind,bindings:new Map(),dynamic:false});
  const root = scope(null,'function');
  const names = (pattern) => {
    if (!pattern) return [];
    if (pattern.type === 'Identifier') return [pattern.name];
    if (pattern.type === 'RestElement') return names(pattern.argument);
    if (pattern.type === 'AssignmentPattern') return names(pattern.left);
    if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(names);
    if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap((p) => names(p.type === 'RestElement' ? p.argument : p.value));
    return [];
  };
  const isCreateRequireCall = (node) => !!node && node.type === 'CallExpression'
    && ((node.callee.type === 'Identifier' && node.callee.name === 'createRequire')
      || (node.callee.type === 'MemberExpression' && !node.callee.computed && literal(node.callee.property) === 'createRequire'));
  const bind = (target, name, flavor, declaration = null, value = null) => {
    const claims = target.bindings.get(name) || [];
    claims.push({flavor,declaration,value}); target.bindings.set(name,claims);
  };
  const blockKinds = new Set(['BlockStatement','StaticBlock','SwitchStatement','ForStatement','ForInStatement','ForOfStatement']);
  const functions = new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
  const scan = (node, current) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id) bind(current,node.id.name,'function');
    if (node.type === 'ClassDeclaration' && node.id) bind(current,node.id.name,'class');
    let inner = current;
    if (functions.has(node.type)) {
      inner=scope(current,'function');
      if (node.type !== 'ArrowFunctionExpression') bind(inner,'arguments','param');
      if (node.id) bind(inner,node.id.name,'function');
      for (const param of node.params) for (const name of names(param)) bind(inner,name,'param');
    } else if (blockKinds.has(node.type)) inner=scope(current,'block');
    else if (node.type === 'CatchClause') {
      inner=scope(current,'block');
      for (const name of names(node.param)) bind(inner,name,'param');
    } else if (node.type === 'ClassExpression' || node.type === 'ClassDeclaration') {
      inner=scope(current,'block');
      if (node.id) bind(inner,node.id.name,'class');
    } else if (node.type === 'WithStatement') { inner=scope(current,'block'); inner.dynamic=true; }
    nodeScopes.set(node,inner);
    if (node.type === 'VariableDeclaration') {
      let target=inner;
      if (node.kind === 'var') while (target.parent && target.kind !== 'function') target=target.parent;
      for (const declaration of node.declarations) {
        const value = node.kind === 'const' && declaration.id.type === 'Identifier' ? literal(declaration.init) : null;
        const flavor = declaration.init?.type === 'FunctionExpression' || declaration.init?.type === 'ArrowFunctionExpression'
          ? 'function' : node.kind === 'const' && isCreateRequireCall(declaration.init) ? 'createRequire'
          : node.kind === 'const' ? (typeof value === 'string' ? 'const-data' : 'const') : 'mutable';
        for (const name of names(declaration.id)) bind(target,name,flavor,declaration,value);
      }
    }
    if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) bind(inner,specifier.local.name,'import');
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach((n) => scan(n,inner));
      else if (child && typeof child === 'object' && typeof child.type === 'string') scan(child,inner);
    }
  };
  scan(tree,root);
  const resolveLiteral = (identifier, use) => {
    if (identifier?.type !== 'Identifier') return null;
    for (let current=nodeScopes.get(identifier); current; current=current.parent) {
      if (current.dynamic) return null;
      const bindings=current.bindings.get(identifier.name);
      if (!bindings) continue;
      if (bindings.length !== 1) return null;
      const {declaration,value}=bindings[0];
      // Reject textual use before initialization, including a closure declared
      // before the constant. We do not infer callback invocation order.
      return declaration && declaration.end < use.start && typeof value === 'string' ? value : null;
    }
    return null;
  };
  const describeBinding = (identifier) => {
    if (identifier?.type !== 'Identifier') return 'unwritten';
    for (let current=nodeScopes.get(identifier); current; current=current.parent) {
      if (current.dynamic) return 'dynamic';
      const bindings=current.bindings.get(identifier.name);
      if (!bindings) continue;
      return bindings.length !== 1 ? 'ambiguous' : bindings[0].flavor;
    }
    return 'unbound';
  };
  return { resolveLiteral, describeBinding };
}

export function collectInventory({ root, revision = 'HEAD' }) {
  if (!parser || parser.version !== PARSER_VERSION) throw new Error('PINNED_SOURCE_PARSER_REQUIRED');
  const commit = git(root, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  const entries = git(root, ['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean).map((line) => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== 'blob' || match[1] === '120000') throw new Error('UNSUPPORTED_SOURCE_ENTRY');
    return { mode: match[1], oid: match[3], path: match[4] };
  });
  const paths = new Set(entries.map((x) => x.path));
  const sourceEntries = new Map(entries.map((x) => [x.path,x]));
  const validatedData = new Set();
  const sources = entries.filter((entry) => needsText(entry.path));
  const blobs = git(root, ['cat-file', '--batch'], { input: sources.map((entry) => entry.oid).join('\n') + '\n', encoding: null });
  const texts = new Map();
  let cursor = 0;
  for (const entry of sources) {
    const end = blobs.indexOf(10, cursor);
    const header = blobs.subarray(cursor, end).toString('ascii').split(' ');
    const size = Number(header[2]);
    if (header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('SOURCE_BATCH_INVALID');
    cursor = end + 1;
    texts.set(entry.path, blobs.subarray(cursor, cursor + size).toString('utf8'));
    cursor += size + 1;
  }
  const units = [];
  const configuredRuntimePaths = new Set();
  const edges = [];
  const unresolved = [];
  const add = (kind, path, key, evidence) => units.push({ id: `${kind}:${path}${key ? `#${key}` : ''}`, kind, path, evidence_sha256: sha(JSON.stringify(evidence)) });
  for (const entry of entries) {
    add('file', entry.path, '', [entry.mode, entry.oid]);
    // Source is loaded from the pinned object, never a stale or dirty working file.
    const config = /(?:^|\/)wrangler\.toml$/.test(entry.path);
    const workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path);
    const external = entry.path === 'tools/external_schedule_jobs.json';
    if (!config && !workflow && !external) continue;
    const text = texts.get(entry.path);
    if (config) {
      const document = parseData('toml', text);
      const configScopes = new Set([document, ...Object.values(document.env ?? {})]);
      const visit = (value, key = '') => {
        if (!value || typeof value !== 'object') return;
        // Durable Object bindings use name, not binding. Observe only the typed
        // config location; arbitrary name fields are not resource declarations.
        if (configScopes.has(value) && value.durable_objects?.bindings !== undefined) {
          const bindings = value.durable_objects.bindings;
          if (!Array.isArray(bindings)) unresolved.push({code:'DURABLE_OBJECT_BINDING_INVALID',path:entry.path});
          else bindings.forEach((binding, i) => {
            if (!binding || typeof binding.name !== 'string' || !binding.name.trim()
              || typeof binding.class_name !== 'string' || !binding.class_name.trim()) {
              unresolved.push({code:'DURABLE_OBJECT_BINDING_INVALID',path:entry.path});
              return;
            }
            const location = key ? `${key}.durable_objects.bindings.${i}` : `durable_objects.bindings.${i}`;
            // Preserve declared class/script/environment and migration context
            // without claiming deployed state or replaying migration history.
            add('binding', entry.path, `${location}:${binding.name}`, {
              binding, migrations:document.migrations ?? null,
              scoped_migrations:key ? value.migrations ?? null : null,
            });
          });
        }
        if (configScopes.has(value) && value.migrations !== undefined) {
          if (!Array.isArray(value.migrations)) unresolved.push({code:'DURABLE_OBJECT_MIGRATION_INVALID',path:entry.path});
          else value.migrations.forEach((migration, i) => {
            if (!migration || typeof migration.tag !== 'string' || !migration.tag.trim()) {
              unresolved.push({code:'DURABLE_OBJECT_MIGRATION_INVALID',path:entry.path});
              return;
            }
            add('durable-object-migration', entry.path, `${key ? `${key}.` : ''}migrations.${i}:${migration.tag}`, migration);
          });
        }
        if (typeof value.binding === 'string') add('binding', entry.path, `${key}:${value.binding}`, value);
        if (typeof value.queue === 'string') add('queue', entry.path, `${key}:${value.queue}`, value);
        if (typeof value.main === 'string') {
          add('runtime',entry.path,key || 'production',value.main);
          const runtimePath = posix.normalize(posix.join(posix.dirname(entry.path),value.main));
          if (runtimePath.startsWith('../') || !paths.has(runtimePath)) unresolved.push({code:'CONFIGURED_RUNTIME_MISSING',path:entry.path});
          else configuredRuntimePaths.add(runtimePath);
        }
        if (Array.isArray(value.crons)) value.crons.forEach((cron, i) => add('schedule', entry.path, `${key}:${i}`, cron));
        if (Array.isArray(value.routes)) value.routes.forEach((route, i) => add('route', entry.path, `${key}:${i}`, route));
        for (const [name, child] of Object.entries(value)) visit(child, key ? `${key}.${name}` : name);
      };
      visit(document);
    }
    if (workflow) {
      const document = parseData('yaml', text);
      if (!document || typeof document.jobs !== 'object') throw new Error('WORKFLOW_JOBS_MISSING');
      for (const [name, job] of Object.entries(document.jobs)) add('workflow-job', entry.path, name, job);
    }
    if (external) {
      const document = JSON.parse(text);
      if (!Array.isArray(document.jobs)) throw new Error('EXTERNAL_JOBS_MISSING');
      for (const job of document.jobs) {
        if (!job.id || !Array.isArray(job.schedule)) throw new Error('EXTERNAL_JOB_INVALID');
        add('external-job', entry.path, job.id, job);
      }
    }
  }
  // Every tracked file remains a ledger unit. Executable source observation
  // covers every tracked module outside test and fixture locations plus
  // configured runtimes, then follows imports. A module outside the parsed set
  // must never read as an observed empty edge set: it fails closed instead.
  // Negative fixtures are data unless an executable imports them; a directory
  // name never exempts a reachable module.
  const manifests = new Map();
  const declaredInstalledPackage = (target) => {
    const match = /^((?:[^/]+\/)*?)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(target);
    if (!match) return null;
    const [, prefix, name] = match;
    const manifestPath = `${prefix}package.json`;
    if (!manifests.has(manifestPath)) {
      let manifest = null;
      if (sourceEntries.has(manifestPath)) {
        try { manifest = JSON.parse(git(root,['cat-file','blob',sourceEntries.get(manifestPath).oid])); } catch { manifest = null; }
      }
      manifests.set(manifestPath, manifest);
    }
    const manifest = manifests.get(manifestPath);
    const declared = ['dependencies','devDependencies','optionalDependencies','peerDependencies'].some((field) => manifest?.[field] && Object.hasOwn(manifest[field], name));
    return declared ? { package: name, manifest: manifestPath, version: ['dependencies','devDependencies','optionalDependencies','peerDependencies'].map((field) => manifest[field]?.[name]).find((v) => typeof v === 'string') } : null;
  };
  const excludedSource = (path) => /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|\.test\.[cm]?js$/.test(path);
  const rootPaths = entries.filter(({path}) => /\.(?:mjs|js|cjs)$/.test(path) && !excludedSource(path)).map(({path}) => path);
  for (const path of configuredRuntimePaths) if (!rootPaths.includes(path)) rootPaths.push(path);
  const pythonPaths = entries.filter(({path}) => path.endsWith('.py')).map(({path}) => path);
  const parsed = new Set();
  // Python is observed first, so JavaScript it runs or imports is observed
  // too; modules a reviewed declaration names as targets are observed as well,
  // so no edge points at a module whose own loads went unexamined.
  const pythonSourceTargets = pythonPaths.length ? observePythonSources({ paths, texts, pythonPaths, parsed, add, edges, unresolved }) : [];
  const pending = [...rootPaths, ...declaredSourceTargets(texts.get(DECLARATIONS_PATH), paths), ...pythonSourceTargets];
  while (pending.length) {
    const path = pending.shift();
    if (parsed.has(path)) continue;
    parsed.add(path);
    const text = texts.get(path);
    if (typeof text !== 'string') { unresolved.push({code:'IMPORTED_SOURCE_TYPE_UNSUPPORTED', path}); continue; }
    let tree;
    try { tree = parser.parse(text, {ecmaVersion:'latest', sourceType:path.endsWith('.cjs') ? 'commonjs' : 'module', locations:true}); }
    catch { unresolved.push({code:'SOURCE_PARSE_FAILED', path}); continue; }
    const specifiers = new Set();
    const at = (node) => `${node.loc.start.line}:${node.loc.start.column}`;
    const semanticClaims = new Set();
    const claim = (kind, node) => { const key = `${kind}:${at(node)}`; if (!semanticClaims.has(key)) { semanticClaims.add(key); add(kind,path,at(node),text.slice(node.start,node.end)); } };
    const transportNames = new Set();
    const literal = (node) => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
      : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
    // .js can be a classic sloppy browser/CommonJS script despite module-mode
    // parsing here. Annex B block functions have different binding rules there.
    // Resolve lexical bindings only for explicitly module-typed .mjs source.
    const immutableImport = path.endsWith('.mjs') ? immutableImportBindings(tree,literal) : null;
    // A site-bound blocker carries the hash of its exact source text so a
    // reviewed declaration can classify that site, and only that site.
    const blocker = (code, node, site = node) => unresolved.push({code, path, location:at(node), site_sha256:sha(text.slice(site.start,site.end))});
    const observeImport = (node, argument, resolveConst = false) => {
      const specifier = literal(argument) ?? (resolveConst ? immutableImport?.resolveLiteral(argument,node) : null);
      if (typeof specifier === 'string') specifiers.add(specifier);
      else blocker('DYNAMIC_IMPORT_REQUIRES_OBSERVER', node);
    };
    // A createRequire() result bound to an immutable module-typed const is an
    // observed loader: every call through it is observed as a module load and
    // any other reference to it fails closed below.
    const isLoaderBinding = (identifier) => !!immutableImport && identifier?.type === 'Identifier' && immutableImport.describeBinding(identifier) === 'createRequire';
    const isCreateRequire = (call) => (call.callee.type === 'Identifier' && call.callee.name === 'createRequire')
      || (call.callee.type === 'MemberExpression' && (call.callee.computed ? literal(call.callee.property) : call.callee.property?.name) === 'createRequire');
    const isCallee = (node, parent) => ['CallExpression','NewExpression'].includes(parent?.type) && parent.callee === node;
    // A bare require() is a module load only when the callee is the ambient
    // loader or a createRequire() result. A locally bound helper of the same
    // name is ordinary code; any other binding fails closed instead of guessing.
    const requireFlavor = (callee) => {
      if (!immutableImport) return 'loader';
      const flavor = immutableImport.describeBinding(callee);
      return flavor === 'unbound' || flavor === 'createRequire' ? 'loader'
        : ['function','param','class','const-data'].includes(flavor) ? 'helper' : 'unknown';
    };
    const visitedNodes = new WeakSet();
    const isReference = (node,parent) => !(
      (['Property','MethodDefinition'].includes(parent?.type) && parent.key === node && !parent.computed && !parent.shorthand)
      || (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
      || ['ImportSpecifier','ImportDefaultSpecifier','ImportNamespaceSpecifier','ExportSpecifier'].includes(parent?.type)
      || (parent?.type === 'VariableDeclarator' && parent.id === node));
    const visit = (node, parent = null) => {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string' || visitedNodes.has(node)) return;
      visitedNodes.add(node);
      if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type) && node.source) observeImport(node, node.source);
      if (node.type === 'ImportExpression') observeImport(node, node.source, true);
      if (node.type === 'CallExpression') {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const flavor = requireFlavor(node.callee);
          if (flavor === 'loader') observeImport(node, node.arguments[0]);
          else if (flavor === 'unknown') blocker('LOADER_BINDING_REQUIRES_OBSERVER', node);
        } else if (isLoaderBinding(node.callee)) observeImport(node, node.arguments[0]);
        // Loader aliases, unbound createRequire, eval and code constructors need
        // their own observer. Never infer their targets from names or approved hashes.
        if (isCreateRequire(node) && !(parent?.type === 'VariableDeclarator' && parent.init === node && isLoaderBinding(parent.id))) blocker('INDIRECT_CODE_LOADING_REQUIRES_OBSERVER', node);
        if (node.callee.type === 'Identifier' && ['eval','Function'].includes(node.callee.name)) blocker('INDIRECT_CODE_LOADING_REQUIRES_OBSERVER', node);
        if (node.callee.type === 'MemberExpression' && (node.callee.property?.name === 'require' || literal(node.callee.property) === 'require')) observeImport(node, node.arguments[0]);
        if (node.callee.type === 'Identifier' && transportNames.has(node.callee.name)) claim('injected-transport', node);
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && ['Function','Worker','SharedWorker'].includes(node.callee.name)) blocker('INDIRECT_CODE_LOADING_REQUIRES_OBSERVER', node);
      // A direct call or construction is reported once, by its call site above.
      if (node.type === 'Identifier' && isReference(node,parent) && !isCallee(node,parent) && ['eval','Function','createRequire'].includes(node.name)) blocker('INDIRECT_CODE_LOADING_REQUIRES_OBSERVER', node, parent);
      // typeof yields a string; a feature test cannot hand the loader to other code.
      if (node.type === 'Identifier' && isReference(node,parent) && node.name === 'require' && !(parent?.type === 'CallExpression' && parent.callee === node) && !(parent?.type === 'MemberExpression' && parent.property === node) && !(parent?.type === 'UnaryExpression' && parent.operator === 'typeof') && requireFlavor(node) !== 'helper') blocker('LOADER_REFERENCE_REQUIRES_OBSERVER', node, parent);
      if (node.type === 'Identifier' && node.name !== 'require' && isReference(node,parent) && !(parent?.type === 'CallExpression' && parent.callee === node) && isLoaderBinding(node)) blocker('LOADER_REFERENCE_REQUIRES_OBSERVER', node, parent);
      // An exported loader escapes this module, whichever export form is used.
      if (node.type === 'ExportSpecifier' && isLoaderBinding(node.local)) blocker('LOADER_REFERENCE_REQUIRES_OBSERVER', node);
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
        for (const declarator of node.declaration.declarations) if (isLoaderBinding(declarator.id)) blocker('LOADER_REFERENCE_REQUIRES_OBSERVER', declarator);
      }
      // An injectable outbound-transport parameter defaulting to the ambient
      // fetch, and any later call through that parameter, is an observable
      // injected-transport effect of this module.
      if (node.type === 'Property' && !node.computed && (node.key.type === 'Identifier' || typeof literal(node.key) === 'string')
        && node.value?.type === 'AssignmentPattern' && node.value.right?.type === 'MemberExpression' && !node.value.right.computed
        && node.value.right.object?.type === 'Identifier' && node.value.right.object.name === 'globalThis'
        && (node.value.right.property?.name === 'fetch' || literal(node.value.right.property) === 'fetch')) {
        transportNames.add(node.key.name || literal(node.key));
        claim('injected-transport', node);
      }
      if ((node.type === 'Property' && (node.method || ['FunctionExpression','ArrowFunctionExpression'].includes(node.value?.type))) || node.type === 'MethodDefinition') {
        const name = node.computed ? literal(node.key) : node.key.name || literal(node.key);
        if (['fetch','scheduled','email','queue'].includes(name)) claim('entrypoint', node);
      }
      if (node.type === 'Identifier' && ['pathname','isNearYouDocumentPath','isNearYouDeferredPath'].includes(node.name)) claim('routing-clause', node);
      if ((node.type === 'Literal' || node.type === 'TemplateLiteral') && isManagementClause(literal(node) || '')) claim('management-clause', node);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((child) => visit(child,node));
        else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value,node);
      }
    };
    visit(tree);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        add('external-import', path, specifier, specifier);
        // File and absolute URL imports cannot be classified as package edges.
        if (specifier.startsWith('/') || specifier.startsWith('#') || /^(?:file|data|https?):/.test(specifier)) unresolved.push({code:'NONLOCAL_IMPORT_REQUIRES_OBSERVER',path,location:specifier,site_sha256:sha(specifier)});
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier.split(/[?#]/)[0]));
      if (!target.startsWith('../') && !paths.has(target)) {
        // A relative path into an untracked installed package directory is an
        // external package import when the owning tracked manifest declares it.
        const installed = declaredInstalledPackage(target);
        if (installed) { add('external-import', path, specifier, installed); continue; }
      }
      if (target.startsWith('../') || !paths.has(target)) { unresolved.push({code:'UNRESOLVED_IMPORT',path,location:specifier}); continue; }
      const edge = {from:path,to:target}; edges.push(edge); add('import',path,specifier,edge);
      if (/\.(?:mjs|js|cjs)$/.test(target)) pending.push(target);
      else if (target.endsWith('.json')) {
        // JSON imports are inert data. Observe their ownership edge and validate
        // the exact pinned blob, without loading all repository data into memory.
        if (!validatedData.has(target)) {
          validatedData.add(target);
          try { JSON.parse(git(root,['cat-file','blob',sourceEntries.get(target).oid])); }
          catch { unresolved.push({code:'IMPORTED_DATA_PARSE_FAILED',path:target}); }
        }
      } else unresolved.push({code:'IMPORTED_SOURCE_TYPE_UNSUPPORTED',path:target});
    }
  }
  // Fail closed if any tracked executable module escaped observation: an
  // unexamined file must surface as an explicit coverage blocker, never as an
  // observed module with no edges or effects.
  for (const {path} of entries) {
    if (!/\.(?:mjs|js|cjs)$/.test(path) || excludedSource(path)) continue;
    if (!parsed.has(path) && !unresolved.some((x) => x.path === path)) unresolved.push({code:'UNOBSERVED_SOURCE_MODULE', path});
  }
  applyDeclarations({ paths, texts, parsed, add, edges, unresolved });
  const ids = new Set();
  for (const unit of units) {
    if (ids.has(unit.id)) throw new Error('DUPLICATE_OBSERVED_UNIT');
    ids.add(unit.id);
  }
  return { schema: INVENTORY_SCHEMA, source_revision: commit, units: sorted(units), edges, unresolved:[...new Map(unresolved.map((x) => [JSON.stringify(x),x])).values()], observation: {parser:`acorn@${PARSER_VERSION}+python3-ast`, scope:'tracked-modules-configured-runtimes-and-transitive-imports', roots:[...rootPaths,...pythonPaths].sort(), parsed:[...parsed].sort()} };
}

// Python observation parses tracked sources with the interpreter's standard
// library ast module inside a child process. Sources are data: the observer
// never imports, executes, marshals, or deserializes them, and the extractor
// itself uses only ast, json, posixpath, and shlex. Loading forms the observer cannot
// resolve become explicit coverage blockers instead of silent absences.
const PYTHON_AST_OBSERVER = String.raw`
import ast, json, posixpath, shlex, sys

try:
    files = json.load(sys.stdin)
except Exception:
    sys.exit(3)

SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)

def scope_bindings(scope):
    # Count every binding of every name anywhere beneath a scope (module,
    # function, lambda or class). A single-binding constant is a name bound
    # exactly once there, by a plain assignment that is a direct statement of
    # the scope body. Any other binding of the name (a parameter, loop target,
    # import, global statement or second assignment) disqualifies it, and
    # counting nested scopes too can only disqualify more names.
    counts = {}
    def bump(name, by=1):
        counts[name] = counts.get(name, 0) + by
    for node in ast.walk(scope):
        if node is not scope and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bump(node.name)
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bump(node.id)
        elif isinstance(node, ast.arg):
            bump(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bump(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                bump(name, 2)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bump(node.name)
        elif type(node).__name__ in ("MatchAs", "MatchStar") and getattr(node, "name", None):
            bump(node.name)
        elif type(node).__name__ == "MatchMapping" and getattr(node, "rest", None):
            bump(node.rest)
    values = {}
    body = scope.body if isinstance(getattr(scope, "body", None), list) else []
    for statement in body:
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
            values[statement.targets[0].id] = statement
        elif isinstance(statement, ast.AnnAssign) and statement.value is not None and isinstance(statement.target, ast.Name):
            values[statement.target.id] = statement
    if isinstance(scope, ast.ClassDef):
        values = {}
    return set(counts), {name: statement for name, statement in values.items() if counts.get(name) == 1}

def walk_scoped(tree):
    # Yield every node with its chain of enclosing scopes, innermost last.
    pending = [(tree, ())]
    while pending:
        node, stack = pending.pop()
        yield node, stack
        inner = stack + (node,) if isinstance(node, SCOPES) else stack
        for child in ast.iter_child_nodes(node):
            pending.append((child, inner))

def join_anchored(base, part):
    if part.startswith("/"):
        return None
    joined = posixpath.normpath(posixpath.join(base, part))
    return None if joined == ".." or joined.startswith("../") else joined

def parent_of(anchored):
    return None if anchored == "." else (posixpath.dirname(anchored) or ".")

out = {}
for path, source in files.items():
    try:
        tree = ast.parse(source)
    except Exception:
        out[path] = {"parse_failed": True}
        continue
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    aliases[alias.asname] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                aliases[alias.asname or alias.name] = node.module + "." + alias.name

    def canon(func):
        if isinstance(func, ast.Name):
            return aliases.get(func.id, func.id)
        if isinstance(func, ast.Attribute):
            parts = [func.attr]
            node = func.value
            while isinstance(node, ast.Attribute):
                parts.append(node.attr)
                node = node.value
            if isinstance(node, ast.Name):
                parts.append(aliases.get(node.id, node.id))
                return ".".join(reversed(parts))
        return None

    def lit(expression):
        if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
            return expression.value
        return None

    module_bound, module_constants = scope_bindings(tree)
    scope_cache = {}
    def bindings_of(scope):
        if id(scope) not in scope_cache:
            scope_cache[id(scope)] = scope_bindings(scope)
        return scope_cache[id(scope)]

    def lookup(name, stack, use):
        # A name bound in the innermost function resolves only to its own
        # single binding written before the use; a name bound in any other
        # enclosing scope is not static, since the observer does not infer
        # when a closure runs. Otherwise a module constant applies.
        for depth, scope in enumerate(reversed(stack)):
            bound, constants = bindings_of(scope)
            if name not in bound:
                continue
            statement = constants.get(name)
            if depth == 0 and statement is not None and (statement.end_lineno, statement.end_col_offset) <= (use.lineno, use.col_offset):
                return statement.value, stack
            return None, None
        statement = module_constants.get(name)
        return (statement.value, ()) if statement is not None else (None, None)

    # Statically evaluate a small path vocabulary anchored at __file__:
    # Path()/str()/os.fspath() wrappers, .parent/.parents[n], .resolve(),
    # the / operator and os.path.join with string literals, and single-binding module
    # constants. The result is a repository-relative path, a literal string,
    # the running interpreter, or None when the value is not static.
    def evaluate(expression, stack=(), depth=0):
        if depth > 24 or expression is None:
            return None
        if lit(expression) is not None:
            return ("str", lit(expression))
        if isinstance(expression, ast.Name):
            if expression.id == "__file__":
                return ("path", posixpath.normpath(path))
            value, scope = lookup(expression.id, stack, expression)
            return evaluate(value, scope, depth + 1) if value is not None else None
        if isinstance(expression, ast.Attribute):
            if canon(expression) == "sys.executable":
                return ("python", None)
            if expression.attr == "parent":
                base = evaluate(expression.value, stack, depth + 1)
                if base and base[0] == "path":
                    parent = parent_of(base[1])
                    return ("path", parent) if parent else None
            return None
        if isinstance(expression, ast.Subscript) and isinstance(expression.value, ast.Attribute) and expression.value.attr == "parents":
            index = expression.slice
            if isinstance(index, ast.Constant) and isinstance(index.value, int) and not isinstance(index.value, bool) and index.value >= 0:
                base = evaluate(expression.value.value, stack, depth + 1)
                if base and base[0] == "path":
                    anchored = parent_of(base[1])
                    for _ in range(index.value):
                        anchored = anchored and parent_of(anchored)
                    return ("path", anchored) if anchored else None
            return None
        if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Div):
            base = evaluate(expression.left, stack, depth + 1)
            part = evaluate(expression.right, stack, depth + 1)
            if base and base[0] == "path" and part and part[0] == "str":
                joined = join_anchored(base[1], part[1])
                return ("path", joined) if joined else None
            return None
        if isinstance(expression, ast.BoolOp) and isinstance(expression.op, ast.Or) and len(expression.values) == 2:
            # shutil.which("node") or "node" names the same program either way.
            first, second = expression.values
            if isinstance(first, ast.Call) and canon(first.func) == "shutil.which" and len(first.args) == 1 and not first.keywords \
                    and lit(first.args[0]) is not None and lit(first.args[0]) == lit(second):
                return ("str", lit(second))
            return None
        if isinstance(expression, ast.Call):
            name = canon(expression.func)
            if expression.keywords:
                return None
            if name in ("str", "os.fspath") and len(expression.args) == 1:
                return evaluate(expression.args[0], stack, depth + 1)
            if name in ("Path", "pathlib.Path", "PurePath", "pathlib.PurePath", "PurePosixPath", "pathlib.PurePosixPath", "os.path.join") and expression.args:
                result = evaluate(expression.args[0], stack, depth + 1)
                for argument in expression.args[1:]:
                    part = evaluate(argument, stack, depth + 1)
                    if not (result and result[0] == "path" and part and part[0] == "str"):
                        return None
                    joined = join_anchored(result[1], part[1])
                    result = ("path", joined) if joined else None
                return result if len(expression.args) == 1 or result else None
            if name in ("os.path.abspath", "os.path.realpath", "os.path.normpath") and len(expression.args) == 1:
                result = evaluate(expression.args[0], stack, depth + 1)
                return result if result and result[0] == "path" else None
            if name == "os.path.dirname" and len(expression.args) == 1:
                result = evaluate(expression.args[0], stack, depth + 1)
                if result and result[0] == "path":
                    parent = parent_of(result[1])
                    return ("path", parent) if parent else None
                return None
            if isinstance(expression.func, ast.Attribute):
                method = expression.func.attr
                receiver = evaluate(expression.func.value, stack, depth + 1)
                if method == "with_name" and receiver and receiver[0] == "path" and len(expression.args) == 1:
                    part = evaluate(expression.args[0], stack, depth + 1)
                    parent = parent_of(receiver[1])
                    joined = parent and part and part[0] == "str" and "/" not in part[1] and join_anchored(parent, part[1])
                    return ("path", joined) if joined else None
                if method in ("resolve", "absolute", "as_posix") and not expression.args:
                    return receiver if receiver and receiver[0] == "path" else None
                if method == "joinpath" and receiver and receiver[0] == "path" and expression.args:
                    anchored = receiver[1]
                    for argument in expression.args:
                        part = evaluate(argument, stack, depth + 1)
                        if not (part and part[0] == "str"):
                            return None
                        anchored = join_anchored(anchored, part[1])
                        if not anchored:
                            return None
                    return ("path", anchored)
            return None
        return None

    def element(expression, stack):
        if isinstance(expression, ast.Starred):
            return {"kind": "starred"}
        value = evaluate(expression, stack)
        if value is None:
            return {"kind": "unknown"}
        if value[0] == "python":
            return {"kind": "python"}
        return {"kind": value[0], "value": value[1]}

    def segment(node):
        return ast.get_source_segment(source, node) or ""

    facts = {"imports": [], "dynamics": [], "subprocess": [], "exec": []}
    for node, stack in walk_scoped(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                facts["imports"].append({"name": alias.name, "level": 0, "names": [], "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            facts["imports"].append({"name": node.module or "", "level": node.level,
                                     "names": [alias.name for alias in node.names], "line": node.lineno})
        elif isinstance(node, ast.Call):
            canonical = canon(node.func)
            first = node.args[0] if node.args else None
            if canonical == "importlib.import_module":
                package = None
                for keyword in node.keywords:
                    if keyword.arg == "package":
                        package = lit(keyword.value)
                facts["dynamics"].append({"form": "import_module", "value": lit(first), "package": package, "line": node.lineno, "site": segment(node)})
            elif canonical == "__import__":
                facts["dynamics"].append({"form": "__import__", "value": lit(first), "package": None, "line": node.lineno, "site": segment(node)})
            elif canonical == "importlib.util.spec_from_file_location":
                location = node.args[1] if len(node.args) > 1 else None
                for keyword in node.keywords:
                    if keyword.arg == "location":
                        location = keyword.value
                value = evaluate(location, stack)
                facts["dynamics"].append({"form": "spec_from_file_location",
                                          "value": value[1] if value and value[0] == "str" else None,
                                          "anchored": value[1] if value and value[0] == "path" else None,
                                          "package": None, "line": node.lineno, "site": segment(node)})
            elif canonical in ("subprocess.run", "subprocess.call", "subprocess.check_call",
                               "subprocess.check_output", "subprocess.Popen", "os.system", "os.popen"):
                argv = first
                if argv is None:
                    for keyword in node.keywords:
                        if keyword.arg in ("args", "cmd"):
                            argv = keyword.value
                elements = None
                if isinstance(argv, (ast.List, ast.Tuple)):
                    elements = [element(item, stack) for item in argv.elts]
                elif lit(argv) is not None:
                    try:
                        elements = [{"kind": "str", "value": item} for item in shlex.split(lit(argv))]
                    except ValueError:
                        elements = None
                cwd = None
                for keyword in node.keywords:
                    if keyword.arg == "cwd":
                        cwd = element(keyword.value, stack)
                facts["subprocess"].append({"elements": elements, "cwd": cwd, "line": node.lineno, "site": segment(node)})
            elif canonical in ("exec", "eval"):
                facts["exec"].append({"line": node.lineno, "site": segment(node)})
    out[path] = facts
sys.stdout.write(json.dumps(out))
`;

// What a subprocess executes is its program and, for an interpreter, the
// script or inline program it is handed. Operands after an observed tracked
// script are that script's run-time data: anything the script loads from them
// is observed in the script's own source. A closed set of external programs
// never executes repository code named by an operand, so their operands are
// data too. An inline Node program is observed only when it is static and
// every module it loads resolves: a package, a tracked module relative to an
// evaluated working directory, or an evaluated operand it loads by position.
// Every other shape still requires every element to be statically known:
// unknown programs, inline Python, inline programs with unresolvable loads,
// and an unevaluated element in a code-bearing position fail closed.
const DATA_OPERAND_PROGRAMS = new Set(['curl', 'cwebp', 'magick', 'sips', 'tar']);
// Git subcommands that neither run repository hooks nor execute operands.
const HOOKLESS_GIT_SUBCOMMANDS = new Set(['archive', 'cat-file', 'diff', 'hash-object', 'log', 'ls-files', 'ls-tree', 'merge-base', 'rev-list', 'rev-parse', 'show']);
const HOOKLESS_LINKED_CHECKOUT_ACTIONS = new Set(['list', 'prune', 'remove']);
const GIT_LOCATION_OPTIONS = new Set(['-C', '--git-dir', '--work-tree']);
// Interpreter options that neither load code nor consume the next element.
const NODE_PLAIN_OPTIONS = new Set(['--check', '-c', '--enable-source-maps', '--input-type=commonjs', '--input-type=module', '--no-warnings']);
const NODE_INLINE_OPTIONS = new Set(['-e', '--eval', '-p', '--print']);
const PYTHON_PLAIN_OPTIONS = new Set(['-B', '-E', '-I', '-s', '-S', '-u']);
// Standard-library modules run with -m whose operands are data, never code.
const PYTHON_DATA_OPERAND_MODULES = new Set(['http.server']);

// An inline Node program is parsed, never run. Its static loads resolve
// against the subprocess working directory when the observer evaluated it,
// and `process.argv[N]` loads resolve to the N-th evaluated operand. Any
// other load, evaluated code, or unresolvable specifier leaves it unobserved.
function observeInlineNodeProgram(code, { moduleType, cwd, operands, resolveFrom }) {
  let tree;
  try { tree = parser.parse(code, { ecmaVersion: 'latest', sourceType: moduleType ? 'module' : 'commonjs' }); } catch { return null; }
  const result = { targets: [], packages: [] };
  let observed = true;
  const literalOf = (node) => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
  const argvIndex = (node) => node?.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' && Number.isInteger(node.property.value)
    && node.object.type === 'MemberExpression' && !node.object.computed && node.object.property.name === 'argv'
    && node.object.object.type === 'Identifier' && node.object.object.name === 'process' ? node.property.value : null;
  const load = (argument) => {
    const specifier = literalOf(argument);
    if (typeof specifier === 'string') {
      if (specifier.startsWith('node:') || (!/^[./#]/.test(specifier) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier))) { result.packages.push(specifier); return; }
      const target = specifier.startsWith('.') && cwd ? resolveFrom(cwd, specifier) : null;
      if (target) result.targets.push(target); else observed = false;
      return;
    }
    const index = argvIndex(argument);
    const operand = index !== null && index >= 1 ? operands[index - 1] : null;
    const target = operand?.kind === 'path' ? resolveFrom('.', operand.value)
      : operand?.kind === 'str' && operand.value.startsWith('.') && cwd ? resolveFrom(cwd, operand.value) : null;
    if (target) result.targets.push(target); else observed = false;
  };
  const loaders = new Set(['require', 'eval', 'Function', 'createRequire']);
  const visit = (node, parent) => {
    if (!observed || !node || typeof node.type !== 'string') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) load(node.source);
    if (node.type === 'ImportExpression') load(node.source);
    const requireCall = node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require';
    if (requireCall) load(node.arguments[0]);
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && ['Function', 'Worker', 'SharedWorker'].includes(node.callee.name)) observed = false;
    const property = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
      || (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand);
    const callee = parent?.type === 'CallExpression' && parent.callee === node && node.name === 'require';
    if (node.type === 'Identifier' && loaders.has(node.name) && !property && !callee) observed = false;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, node);
    }
  };
  visit(tree, null);
  return observed ? result : null;
}

export function subprocessTargetObserved(elements, resolveElement, { cwd = null, resolveFrom = () => null } = {}) {
  const known = (element) => element && ['str', 'path', 'python'].includes(element.kind);
  const allKnown = elements.every(known);
  const [program, ...rest] = elements;
  const literalAt = (i) => rest[i]?.kind === 'str' ? rest[i].value : null;
  const programName = program?.kind === 'str' ? program.value : null;
  const interpreter = program?.kind === 'python' || ['python', 'python3'].includes(programName) ? 'python' : programName === 'node' ? 'node' : null;
  const verdict = (observed, extra = {}) => ({ observed, targets: extra.targets || [], packages: extra.packages || [] });
  const cwdPath = cwd?.kind === 'path' ? cwd.value : null;
  if (interpreter) {
    let unrecognised = false;
    const preloads = [];
    for (let i = 0; i < rest.length; i += 1) {
      const option = literalAt(i);
      // The first positional element is the script: it must be an observed
      // tracked source before its operands can be treated as data.
      if (option === null || !option.startsWith('-')) return verdict(allKnown || (!unrecognised && !!resolveElement(rest[i])));
      if (interpreter === 'node' && NODE_INLINE_OPTIONS.has(option)) {
        if (unrecognised || rest[i + 1]?.kind !== 'str') return verdict(false);
        const operands = rest.slice(i + 2);
        if (operands[0]?.kind === 'str' && operands[0].value === '--') operands.shift();
        const moduleType = rest.slice(0, i).some((element) => element.kind === 'str' && element.value === '--input-type=module');
        const inline = observeInlineNodeProgram(preloads.map((specifier) => `import ${JSON.stringify(specifier)};\n`).join('') + rest[i + 1].value,
          { moduleType: moduleType || preloads.length > 0, cwd: cwdPath, operands, resolveFrom });
        return inline ? verdict(true, inline) : verdict(false);
      }
      if (interpreter === 'python' && option === '-c') return verdict(false);
      if (interpreter === 'python' && option === '-m') return verdict(allKnown || (!unrecognised && PYTHON_DATA_OPERAND_MODULES.has(literalAt(i + 1))));
      // A preload module is loaded exactly like an inline static import.
      if (interpreter === 'node' && /^--import=./.test(option)) { preloads.push(option.slice('--import='.length)); continue; }
      if (!(interpreter === 'node' ? NODE_PLAIN_OPTIONS : PYTHON_PLAIN_OPTIONS).has(option)) unrecognised = true;
    }
    return verdict(allKnown);
  }
  if (allKnown) return verdict(true);
  if (DATA_OPERAND_PROGRAMS.has(programName)) return verdict(true);
  if (programName === 'git') {
    let i = 0;
    // Location options may carry run-time paths; any other global option,
    // including -c configuration, is not supported here.
    while (literalAt(i)?.startsWith('-')) {
      if (!GIT_LOCATION_OPTIONS.has(literalAt(i)) || !rest[i + 1] || rest[i + 1].kind === 'starred') return verdict(false);
      i += 2;
    }
    const subcommand = literalAt(i);
    return verdict(HOOKLESS_GIT_SUBCOMMANDS.has(subcommand) || (subcommand === 'worktree' && HOOKLESS_LINKED_CHECKOUT_ACTIONS.has(literalAt(i + 1))));
  }
  return verdict(false);
}

function observePythonSources({ paths, texts, pythonPaths, parsed, add, edges, unresolved }) {
  const packageDirs = new Set(pythonPaths.filter((p) => posix.basename(p) === '__init__.py').map((p) => posix.dirname(p)));
  const identifierPart = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const pyIndex = new Map();
  const registerModule = (name, target) => {
    if (!name || !name.split('.').every((part) => identifierPart.test(part))) return;
    const existing = pyIndex.get(name);
    if (existing) existing.add(target);
    else pyIndex.set(name, new Set([target]));
  };
  for (const p of pythonPaths) {
    const segments = p.split('/');
    const stem = segments.pop().replace(/\.py$/, '');
    if (stem !== '__init__') registerModule([...segments, stem].join('.'), p);
    // Package-rooted name: climb through consecutive __init__.py packages so a
    // package nested under a non-package directory stays importable by name.
    let depth = segments.length;
    while (depth > 0 && packageDirs.has(segments.slice(0, depth).join('/'))) depth -= 1;
    const rooted = segments.slice(depth);
    if (rooted.length) registerModule(stem === '__init__' ? rooted.join('.') : [...rooted, stem].join('.'), p);
  }
  const resolveDotted = (dotted, fromPath) => {
    const indexed = pyIndex.get(dotted);
    if (indexed) return indexed.size === 1 ? [...indexed][0] : null;
    // Sibling modules rely on the script directory being on sys.path.
    const base = posix.dirname(fromPath);
    const rel = dotted.replace(/\./g, '/');
    for (const candidate of [`${base}/${rel}.py`, `${base}/${rel}/__init__.py`]) if (paths.has(candidate)) return candidate;
    return null;
  };
  const resolveScriptPath = (value, fromPath) => {
    for (const candidate of [posix.normalize(value), posix.normalize(posix.join(posix.dirname(fromPath), value))])
      if (paths.has(candidate)) return candidate;
    return null;
  };
  const resolveFrom = (base, specifier) => {
    const target = posix.normalize(posix.join(base, specifier.split(/[?#]/)[0]));
    return !target.startsWith('../') && paths.has(target) ? target : null;
  };
  const claimed = new Set();
  const record = (kind, from, key, evidence, target = null) => {
    const id = `${kind}:${from}#${key}`;
    if (claimed.has(id)) return;
    claimed.add(id);
    add(kind, from, key, evidence);
    if (target) edges.push({ from, to: target });
  };
  const moduleCandidates = (base, rel) => (rel ? [`${base}/${rel}.py`, `${base}/${rel}/__init__.py`] : [`${base}.py`, `${base}/__init__.py`]);
  const batches = [];
  let batch = {}, budget = 0;
  for (const p of pythonPaths) {
    const text = texts.get(p);
    if (typeof text !== 'string') { unresolved.push({ code: 'PYTHON_SOURCE_READ_FAILED', path: p }); continue; }
    if (budget + text.length > 2_000_000 && Object.keys(batch).length) { batches.push(batch); batch = {}; budget = 0; }
    batch[p] = text; budget += text.length;
  }
  if (Object.keys(batch).length) batches.push(batch);
  const factsByPath = {};
  for (const payload of batches) {
    const result = spawnSync('python3', ['-c', PYTHON_AST_OBSERVER], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error('PYTHON_OBSERVER_FAILED');
    Object.assign(factsByPath, JSON.parse(result.stdout));
  }
  for (const p of pythonPaths) {
    parsed.add(p);
    const facts = factsByPath[p];
    if (!facts || facts.parse_failed) { unresolved.push({ code: 'PYTHON_SOURCE_PARSE_FAILED', path: p }); continue; }
    const localEdge = (key, target, evidence) => record('py-import', p, key, evidence, target);
    for (const imp of facts.imports || []) {
      if (imp.level > 0) {
        const dirSegments = posix.dirname(p).split('/');
        const base = imp.level <= 1 ? posix.dirname(p) : dirSegments.slice(0, -(imp.level - 1)).join('/');
        const rel = imp.name ? imp.name.replace(/\./g, '/') : '';
        const key = '.'.repeat(imp.level) + imp.name;
        const modulePath = rel ? moduleCandidates(base, rel).find((t) => paths.has(t)) || null
          : moduleCandidates(base, '').find((t) => paths.has(t)) || null;
        if (rel && !modulePath) { unresolved.push({ code: 'PYTHON_IMPORT_UNRESOLVED', path: p, location: key }); continue; }
        if (modulePath) localEdge(key || '.', modulePath, { import: imp });
        const searchDir = modulePath && posix.basename(modulePath) === '__init__.py' ? posix.dirname(modulePath) : (rel ? null : base);
        if (searchDir) for (const name of imp.names || []) {
          const target = moduleCandidates(`${searchDir}/${name}`, '').find((t) => paths.has(t));
          if (target) localEdge(`${key}${key.endsWith('.') ? '' : '.'}${name}`, target, { import: imp, name });
        }
      } else {
        const modulePath = resolveDotted(imp.name, p);
        const submodulePaths = [];
        for (const name of imp.names || []) {
          const sub = resolveDotted(`${imp.name}.${name}`, p);
          if (sub) submodulePaths.push([name, sub]);
        }
        if (!modulePath && !submodulePaths.length) { record('external-import', p, imp.name, { module: imp.name, line: imp.line }); continue; }
        if (modulePath) localEdge(imp.name, modulePath, { import: imp });
        for (const [name, sub] of submodulePaths) localEdge(`${imp.name}.${name}`, sub, { import: imp, name });
      }
    }
    const blocker = (code, location, site) => unresolved.push({ code, path: p, location, site_sha256: sha(site || '') });
    for (const dyn of facts.dynamics || []) {
      if (dyn.form === 'spec_from_file_location' && typeof dyn.anchored === 'string') {
        // A location anchored at __file__ is an exact repository path.
        if (paths.has(dyn.anchored)) localEdge(`spec:${dyn.anchored}`, dyn.anchored, { form: dyn.form, line: dyn.line });
        else unresolved.push({ code: 'PYTHON_IMPORT_UNRESOLVED', path: p, location: `spec:${dyn.anchored}` });
        continue;
      }
      if (typeof dyn.value !== 'string') { blocker('PYTHON_IMPORT_REQUIRES_OBSERVER', `${dyn.form}:${dyn.line}`, dyn.site); continue; }
      if (dyn.form === 'spec_from_file_location') {
        const target = resolveScriptPath(dyn.value, p);
        if (target) localEdge(`spec:${target}`, target, { form: dyn.form, line: dyn.line });
        else unresolved.push({ code: 'PYTHON_IMPORT_UNRESOLVED', path: p, location: `spec:${dyn.value}` });
      } else if (dyn.form === 'import_module' && dyn.value.startsWith('.')) {
        const dots = dyn.value.match(/^\.+/)[0].length;
        const rest = dyn.value.replace(/^\.+/, '');
        const packageFile = typeof dyn.package === 'string' ? resolveDotted(dyn.package, p) : null;
        if (!packageFile) { blocker('PYTHON_IMPORT_REQUIRES_OBSERVER', `import_module:${dyn.line}`, dyn.site); continue; }
        let base = posix.dirname(packageFile);
        if (dots > 1) base = base.split('/').slice(0, -(dots - 1)).join('/');
        const rel = rest.replace(/\./g, '/');
        const target = moduleCandidates(base, rel).find((t) => paths.has(t));
        if (target) localEdge(`dynamic:${dyn.value}@${dyn.package}`, target, { form: dyn.form, line: dyn.line });
        else unresolved.push({ code: 'PYTHON_IMPORT_UNRESOLVED', path: p, location: `dynamic:${dyn.value}@${dyn.package}` });
      } else {
        const target = resolveDotted(dyn.value, p);
        if (target) localEdge(`dynamic:${dyn.value}`, target, { form: dyn.form, line: dyn.line });
        else record('external-import', p, dyn.value, { module: dyn.value, line: dyn.line, form: dyn.form });
      }
    }
    for (const call of facts.subprocess || []) {
      const elements = call.elements;
      if (!Array.isArray(elements)) { blocker('PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER', `${call.line}`, call.site); continue; }
      const resolveElement = (element) => element.kind === 'path' ? (paths.has(element.value) ? element.value : null)
        : element.kind === 'str' ? resolveScriptPath(element.value, p) : null;
      const verdict = subprocessTargetObserved(elements, resolveElement, { cwd: call.cwd, resolveFrom });
      const targets = [...elements.map(resolveElement).filter(Boolean), ...verdict.targets];
      if (!verdict.observed) blocker('PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER', `${call.line}`, call.site);
      for (const target of targets) record('script-target', p, target, { target, line: call.line }, target);
      for (const specifier of verdict.packages) record('external-import', p, specifier, { module: specifier, line: call.line, form: 'inline-program' });
    }
    for (const exec of facts.exec || []) blocker('PYTHON_DYNAMIC_CODE_REQUIRES_OBSERVER', `${exec.line}`, exec.site);
  }
  return edges.filter((edge) => pythonPaths.includes(edge.from) && /\.(?:mjs|js|cjs)$/.test(edge.to)).map((edge) => edge.to);
}

// Reviewed observer declarations classify individual loading sites the
// observer cannot resolve statically. A declaration names the finding code,
// the source path and the sha256 of the site's exact source text, so it covers
// only byte-identical sites and goes stale the moment that site changes. A
// declared site is not exempt: it becomes a declared-site unit that the
// private ownership ledger must classify like any other observed unit, and its
// declared targets become ownership edges. Parse, coverage and configuration
// failures are never declarable, and an unused or malformed declaration fails
// closed rather than silently lapsing.
const DECLARABLE_CODES = new Set([
  'DYNAMIC_IMPORT_REQUIRES_OBSERVER', 'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER', 'LOADER_REFERENCE_REQUIRES_OBSERVER',
  'LOADER_BINDING_REQUIRES_OBSERVER', 'NONLOCAL_IMPORT_REQUIRES_OBSERVER', 'PYTHON_IMPORT_REQUIRES_OBSERVER',
  'PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER', 'PYTHON_DYNAMIC_CODE_REQUIRES_OBSERVER',
]);
export const DECLARATION_CLASSIFICATIONS = new Set([
  // The site loads a repository module whose path is computed at run time;
  // `targets` lists every tracked module it can load.
  'computed-repository-module',
  // The site evaluates tracked repository source text; `targets` names it.
  'evaluated-repository-source',
  // A browser import of an origin-absolute path that the published site
  // serves from a tracked module; `targets` names that module.
  'served-site-module',
  // The module is supplied by the operator at run time (an injected
  // transport, a fixture module) and is not part of the observed tree.
  'operator-supplied-module',
  // The site runs inline code given to an interpreter by this file.
  'inline-interpreter-program',
  // The executed program is fixed; the unresolved elements are run-time
  // data operands (revisions, scratch paths, ports, URLs), not code targets.
  'runtime-data-operands',
  // A run helper executes the argv its callers in the same file construct;
  // `targets` lists the tracked scripts those callers pass, if any.
  'caller-supplied-command',
  // Third-party code vendored verbatim into the tree.
  'vendored-third-party',
]);
const TARGETED_CLASSIFICATIONS = new Set(['computed-repository-module', 'evaluated-repository-source', 'served-site-module']);
const DECLARATION_FIELDS = new Set(['code', 'path', 'site_sha256', 'classification', 'reason', 'targets']);

function declaredSourceTargets(text, paths) {
  let document;
  try { document = text === undefined ? null : JSON.parse(text); } catch { return []; }
  const declarations = Array.isArray(document?.declarations) ? document.declarations : [];
  return declarations.flatMap((entry) => Array.isArray(entry?.targets) ? entry.targets : [])
    .filter((target) => typeof target === 'string' && /\.(?:mjs|js|cjs)$/.test(target) && paths.has(target));
}

function applyDeclarations({ paths, texts, parsed, add, edges, unresolved }) {
  const text = texts.get(DECLARATIONS_PATH);
  if (text === undefined) return;
  const invalid = () => unresolved.push({ code: 'OBSERVER_DECLARATION_INVALID', path: DECLARATIONS_PATH });
  let document;
  try { document = JSON.parse(text); } catch { invalid(); return; }
  if (document?.schema !== DECLARATIONS_SCHEMA || !Array.isArray(document.declarations)) { invalid(); return; }
  const declared = new Map();
  for (const entry of document.declarations) {
    const valid = entry && typeof entry === 'object' && Object.keys(entry).every((key) => DECLARATION_FIELDS.has(key))
      && DECLARABLE_CODES.has(entry.code) && typeof entry.path === 'string' && paths.has(entry.path)
      && typeof entry.site_sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.site_sha256)
      && DECLARATION_CLASSIFICATIONS.has(entry.classification)
      && typeof entry.reason === 'string' && entry.reason.trim().length >= 20
      && (entry.targets === undefined || (Array.isArray(entry.targets) && entry.targets.length > 0
        && entry.targets.every((target) => typeof target === 'string') && new Set(entry.targets).size === entry.targets.length))
      && (!TARGETED_CLASSIFICATIONS.has(entry.classification) || Array.isArray(entry.targets));
    const key = valid ? `${entry.code}\0${entry.path}\0${entry.site_sha256}` : null;
    if (!valid || declared.has(key)) { invalid(); continue; }
    declared.set(key, { entry, sites: [] });
  }
  const remaining = [];
  for (const finding of unresolved) {
    const match = finding.site_sha256 && declared.get(`${finding.code}\0${finding.path}\0${finding.site_sha256}`);
    if (match) match.sites.push(finding); else remaining.push(finding);
  }
  for (const { entry, sites } of declared.values()) {
    if (!sites.length) { remaining.push({ code: 'OBSERVER_DECLARATION_STALE', path: entry.path, location: entry.site_sha256 }); continue; }
    const targets = entry.targets || [];
    // A declared target must be tracked, and a declared source target must
    // itself have been observed; otherwise the site stays a blocker.
    if (targets.some((target) => !paths.has(target) || (/\.(?:mjs|js|cjs|py)$/.test(target) && !parsed.has(target)))) {
      remaining.push({ code: 'OBSERVER_DECLARATION_TARGET_INVALID', path: entry.path, location: entry.site_sha256 }, ...sites);
      continue;
    }
    add('declared-site', entry.path, `${entry.code}:${entry.site_sha256}`, {
      code: entry.code, site_sha256: entry.site_sha256, classification: entry.classification,
      reason: entry.reason, targets, occurrences: sites.length,
    });
    for (const target of targets) edges.push({ from: entry.path, to: target });
  }
  unresolved.splice(0, unresolved.length, ...remaining);
}

export function verifyLedger(inventory, ledger) {
  const findings = [];
  const fail = (code, id = null) => findings.push({ code, ...(id ? { id } : {}) });
  if (inventory.schema !== INVENTORY_SCHEMA || ledger?.schema !== LEDGER_SCHEMA) fail('SCHEMA_INVALID');
  if (ledger?.review_state !== 'reviewed') fail('LEDGER_NOT_REVIEWED');
  if (ledger?.source_revision !== inventory.source_revision) fail('SOURCE_REVISION_STALE');
  for (const item of inventory.unresolved || []) fail(item.code, item.path);
  const rows = new Map();
  for (const row of Array.isArray(ledger?.units) ? ledger.units : []) {
    if (!row || typeof row.id !== 'string') { fail('LEDGER_ROW_INVALID'); continue; }
    if (rows.has(row.id)) fail('DUPLICATE_LEDGER_UNIT', row.id);
    rows.set(row.id, row);
  }
  const observed = new Set(inventory.units.map((u) => u.id));
  for (const id of rows.keys()) if (!observed.has(id)) fail('LEDGER_UNIT_NOT_OBSERVED', id);
  for (const unit of inventory.units) {
    const row = rows.get(unit.id);
    if (!row) { fail('UNCLASSIFIED_UNIT', unit.id); continue; }
    if (row.evidence_sha256 !== unit.evidence_sha256) fail('SOURCE_EVIDENCE_STALE', unit.id);
    if (!ROLES.has(row.target_owner)) fail('TARGET_OWNER_INVALID', unit.id);
    if (typeof row.current_owner !== 'string' || !row.current_owner.trim()) fail('CURRENT_OWNER_MISSING', unit.id);
    if (typeof row.deployment_owner !== 'string' || !row.deployment_owner.trim()) fail('DEPLOYMENT_OWNER_MISSING', unit.id);
    if (typeof row.rollback_revision !== 'string' || !/^[a-f0-9]{40}$/.test(row.rollback_revision)) fail('ROLLBACK_IDENTITY_MISSING', unit.id);
    const effectsValid = Array.isArray(row.effects) && row.effects.every((effect) => typeof effect === 'string' && effect.trim()) && new Set(row.effects).size === row.effects.length;
    if (!effectsValid) fail('EFFECTS_INVALID', unit.id);
    if ((['engine', 'acquisition'].includes(row.target_owner) || (row.target_owner === 'split' && Array.isArray(row.partitions) && row.partitions.some((p) => ['engine','acquisition'].includes(p)))) && effectsValid && row.effects.some((effect) => PRIVATE_EFFECTS.has(effect))) fail('FORBIDDEN_BINDING_OR_EFFECT', unit.id);
    if (row.target_owner === 'split' && (!Array.isArray(row.partitions) || row.partitions.length < 2 || new Set(row.partitions).size !== row.partitions.length || row.partitions.some((r) => !ROLES.has(r) || r === 'split'))) fail('SPLIT_RESPONSIBILITY_MISSING', unit.id);
  }
  // Engine cannot depend on application implementation. No blanket exemptions.
  for (const edge of inventory.edges) {
    const from = rows.get(`file:${edge.from}`), to = rows.get(`file:${edge.to}`);
    if ((from?.target_owner === 'engine' || (from?.target_owner === 'split' && Array.isArray(from.partitions) && from.partitions.includes('engine'))) && to && !['engine', 'data'].includes(to.target_owner)) fail('REVERSE_IMPORT', `import:${edge.from}#${edge.to}`);
  }
  for (const unit of inventory.units.filter((u) => u.kind === 'external-import')) {
    const from = rows.get(`file:${unit.path}`), to = rows.get(unit.id);
    if ((from?.target_owner === 'engine' || (from?.target_owner === 'split' && Array.isArray(from.partitions) && from.partitions.includes('engine'))) && to && !['engine','data'].includes(to.target_owner)) fail('REVERSE_EXTERNAL_IMPORT',unit.id);
  }
  return { schema: 'source-boundary-verification.v1', stage: 'foundation', stage_complete:false, scope:'source-ownership-ledger-only', does_not_prove:['private-repository-access','delivery-repository-registration','deployment-separation','secret-transfer','traffic-cutover','rollback-execution'], status: findings.length ? 'FAIL' : 'PASS', source_revision: inventory.source_revision, inventory_sha256: sha(JSON.stringify(inventory)), ledger_sha256: sha(JSON.stringify(ledger)), checked_units: inventory.units.length, findings };
}

function privatePath(value, root) {
  if (!value || !isAbsolute(value)) throw new Error('PRIVATE_EVIDENCE_PATH_REQUIRED');
  const path = realpathSync(value);
  const rel = relative(realpathSync(root), path);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('PRIVATE_EVIDENCE_INSIDE_PUBLIC_REPOSITORY');
  return path;
}

export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--root', '--revision', '--stage', '--receipt', '--report'].includes(args[i]) || !args[i + 1]) throw new Error('ARGUMENT_INVALID');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (options.stage !== 'foundation') throw new Error('STAGE_UNSUPPORTED');
  const root = resolve(options.root || dirname(fileURLToPath(import.meta.url)), options.root ? '' : '..');
  if (options.report !== undefined) {
    // Maintainer report: the observer's unresolved sites in the public tree,
    // with the site hashes a reviewed declaration would pin. No ledger is read.
    if (options.report !== 'unresolved' || options.receipt) throw new Error('ARGUMENT_INVALID');
    const inventory = collectInventory({ root, revision: options.revision || 'HEAD' });
    const unresolved = inventory.unresolved.map(({ code, path, location, site_sha256 }) => ({ code, path, ...(location ? { location } : {}), ...(site_sha256 ? { site_sha256 } : {}) }));
    console.log(JSON.stringify({ status: unresolved.length ? 'FAIL' : 'PASS', stage: 'foundation', source_revision: inventory.source_revision, unresolved }, null, 2));
    return unresolved.length ? 1 : 0;
  }
  const ledgerPath = privatePath(process.env.CITYSCROLL_ENGINE_APP_LEDGER, root);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const report = verifyLedger(collectInventory({ root, revision: options.revision || 'HEAD' }), ledger);
  if (options.receipt) {
    // Receipt must already exist outside the public repository; no accidental
    // creation of a private inventory beneath the public checkout is permitted.
    const receiptPath = privatePath(options.receipt, root);
    const receiptStat = statSync(receiptPath), ledgerStat = statSync(ledgerPath);
    if (receiptPath === ledgerPath || (receiptStat.dev === ledgerStat.dev && receiptStat.ino === ledgerStat.ino)) throw new Error('RECEIPT_OVERWRITES_LEDGER');
    writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  // Only bounded, non-private status escapes to CI/stdout.
  console.log(JSON.stringify({ status: report.status, stage: report.stage, source_revision: report.source_revision, checked_units: report.checked_units, finding_counts: report.findings.reduce((all, f) => ({ ...all, [f.code]: (all[f.code] || 0) + 1 }), {}) }));
  return report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch { console.error(JSON.stringify({ status: 'FAIL', error: 'BOUNDARY_INPUT_OR_OBSERVER_FAILED' })); process.exitCode = 1; }
}
