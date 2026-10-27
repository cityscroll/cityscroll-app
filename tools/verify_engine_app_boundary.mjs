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
const needsText = (path) => /\.(?:mjs|js|cjs|py)$/.test(path) || /(?:^|\/)wrangler\.toml$/.test(path) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || path === 'tools/external_schedule_jobs.json';

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
          ? 'function' : isCreateRequireCall(declaration.init) ? 'createRequire'
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
  const excludedSource = (path) => /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|\.test\.[cm]?js$/.test(path);
  const rootPaths = entries.filter(({path}) => /\.(?:mjs|js|cjs)$/.test(path) && !excludedSource(path)).map(({path}) => path);
  for (const path of configuredRuntimePaths) if (!rootPaths.includes(path)) rootPaths.push(path);
  const pythonPaths = entries.filter(({path}) => path.endsWith('.py')).map(({path}) => path);
  const pending = [...rootPaths];
  const parsed = new Set();
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
    const observeImport = (node, argument, resolveConst = false) => {
      const specifier = literal(argument) ?? (resolveConst ? immutableImport?.resolveLiteral(argument,node) : null);
      if (typeof specifier === 'string') specifiers.add(specifier);
      else unresolved.push({code:'DYNAMIC_IMPORT_REQUIRES_OBSERVER', path, location:at(node)});
    };
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
          else if (flavor === 'unknown') unresolved.push({code:'LOADER_BINDING_REQUIRES_OBSERVER', path, location:at(node)});
        }
        // Loader aliases, createRequire, eval and code constructors need their
        // own observer. Never infer their targets from names or approved hashes.
        if (node.callee.type === 'Identifier' && ['eval','createRequire','Function'].includes(node.callee.name)) unresolved.push({code:'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER',path,location:at(node)});
        if (node.callee.type === 'MemberExpression' && (node.callee.property?.name === 'require' || literal(node.callee.property) === 'require')) observeImport(node, node.arguments[0]);
        if (node.callee.type === 'Identifier' && transportNames.has(node.callee.name)) claim('injected-transport', node);
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && ['Function','Worker','SharedWorker'].includes(node.callee.name)) unresolved.push({code:'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER',path,location:at(node)});
      if (node.type === 'Identifier' && isReference(node,parent) && ['eval','Function','createRequire'].includes(node.name)) unresolved.push({code:'INDIRECT_CODE_LOADING_REQUIRES_OBSERVER',path,location:at(node)});
      if (node.type === 'Identifier' && isReference(node,parent) && node.name === 'require' && !(parent?.type === 'CallExpression' && parent.callee === node) && !(parent?.type === 'MemberExpression' && parent.property === node) && requireFlavor(node) !== 'helper') unresolved.push({code:'LOADER_REFERENCE_REQUIRES_OBSERVER',path,location:at(node)});
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
        if (specifier.startsWith('/') || specifier.startsWith('#') || /^(?:file|data|https?):/.test(specifier)) unresolved.push({code:'NONLOCAL_IMPORT_REQUIRES_OBSERVER',path});
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier.split(/[?#]/)[0]));
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
  if (pythonPaths.length) observePythonSources({ paths, texts, pythonPaths, parsed, add, edges, unresolved });
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
// itself uses only ast, json, and shlex. Loading forms the observer cannot
// resolve become explicit coverage blockers instead of silent absences.
const PYTHON_AST_OBSERVER = String.raw`
import ast, json, shlex, sys

try:
    files = json.load(sys.stdin)
except Exception:
    sys.exit(3)

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

    facts = {"imports": [], "dynamics": [], "subprocess": [], "exec": []}
    for node in ast.walk(tree):
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
                facts["dynamics"].append({"form": "import_module", "value": lit(first), "package": package, "line": node.lineno})
            elif canonical == "__import__":
                facts["dynamics"].append({"form": "__import__", "value": lit(first), "package": None, "line": node.lineno})
            elif canonical == "importlib.util.spec_from_file_location":
                location = lit(node.args[1]) if len(node.args) > 1 else None
                for keyword in node.keywords:
                    if keyword.arg == "location":
                        location = lit(keyword.value)
                facts["dynamics"].append({"form": "spec_from_file_location", "value": location, "package": None, "line": node.lineno})
            elif canonical in ("subprocess.run", "subprocess.call", "subprocess.check_call",
                               "subprocess.check_output", "subprocess.Popen", "os.system", "os.popen"):
                argv = first
                if argv is None:
                    for keyword in node.keywords:
                        if keyword.arg in ("args", "cmd"):
                            argv = keyword.value
                elements = None
                if isinstance(argv, (ast.List, ast.Tuple)):
                    elements = [lit(element) for element in argv.elts]
                elif lit(argv) is not None:
                    try:
                        elements = shlex.split(lit(argv))
                    except ValueError:
                        elements = None
                facts["subprocess"].append({"elements": elements, "line": node.lineno})
            elif canonical in ("exec", "eval"):
                facts["exec"].append(node.lineno)
    out[path] = facts
sys.stdout.write(json.dumps(out))
`;

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
    for (const dyn of facts.dynamics || []) {
      if (typeof dyn.value !== 'string') { unresolved.push({ code: 'PYTHON_IMPORT_REQUIRES_OBSERVER', path: p, location: `${dyn.form}:${dyn.line}` }); continue; }
      if (dyn.form === 'spec_from_file_location') {
        const target = resolveScriptPath(dyn.value, p);
        if (target) localEdge(`spec:${target}`, target, { form: dyn.form, line: dyn.line });
        else unresolved.push({ code: 'PYTHON_IMPORT_UNRESOLVED', path: p, location: `spec:${dyn.value}` });
      } else if (dyn.form === 'import_module' && dyn.value.startsWith('.')) {
        const dots = dyn.value.match(/^\.+/)[0].length;
        const rest = dyn.value.replace(/^\.+/, '');
        const packageFile = typeof dyn.package === 'string' ? resolveDotted(dyn.package, p) : null;
        if (!packageFile) { unresolved.push({ code: 'PYTHON_IMPORT_REQUIRES_OBSERVER', path: p, location: `import_module:${dyn.line}` }); continue; }
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
      if (!Array.isArray(elements)) { unresolved.push({ code: 'PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER', path: p, location: `${call.line}` }); continue; }
      let nonLiteral = false;
      const targets = [];
      for (const element of elements) {
        if (typeof element !== 'string') { nonLiteral = true; continue; }
        const target = resolveScriptPath(element, p);
        if (target) targets.push(target);
      }
      if (nonLiteral) unresolved.push({ code: 'PYTHON_SUBPROCESS_TARGET_REQUIRES_OBSERVER', path: p, location: `${call.line}` });
      for (const target of targets) record('script-target', p, target, { target, line: call.line }, target);
    }
    for (const line of facts.exec || []) unresolved.push({ code: 'PYTHON_DYNAMIC_CODE_REQUIRES_OBSERVER', path: p, location: `${line}` });
  }
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
    if (!['--root', '--revision', '--stage', '--receipt'].includes(args[i]) || !args[i + 1]) throw new Error('ARGUMENT_INVALID');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (options.stage !== 'foundation') throw new Error('STAGE_UNSUPPORTED');
  const root = resolve(options.root || dirname(fileURLToPath(import.meta.url)), options.root ? '' : '..');
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
