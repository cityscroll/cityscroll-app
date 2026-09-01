'use strict';

// Fail-closed sentinel and read recorder for the reduced card-work profile.
//
// A reduced profile materialises only the paths a gate class declares. That is
// only safe if a read of a tracked-but-absent path is loud. Sparse checkout on
// its own reports a plain ENOENT, which a caller can swallow — the failure mode
// CI-08 warned about, where a reduced checkout turns a required read into a
// silently passing test.
//
// This module is loaded with `node --require` (see tools/verify_card_profile.mjs
// and docs/development/card-work-profile.md). It does two things:
//
//   1. Sentinel (always on). It resolves the set of paths that are in the Git
//      index but not materialised in the working tree — `git ls-files -t` marks
//      those with `S` (skip-worktree). A missing-file error on any of them is
//      re-thrown as CardProfileMissingPath, naming the exact hydrate command,
//      and appended to the violation log. A profile gap can therefore never be
//      mistaken for "the file legitimately does not exist".
//
//   2. Recorder (opt-in, CITYSCROLL_CARD_PROFILE_RECORD=1). It appends every
//      repository-relative path the process actually reads — data files through
//      `fs`, modules through the synchronous module hooks — to the read log.
//      That observed set is what closes the gap a static import scan cannot:
//      paths assembled at runtime are seen because they are read, not parsed.
//
// It records paths relative to the repository root only, so no absolute host
// path, user name or host name enters a log.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VIOLATION_LOG = process.env.CITYSCROLL_CARD_PROFILE_VIOLATION_LOG || '';
const READ_LOG = process.env.CITYSCROLL_CARD_PROFILE_READ_LOG || '';
const RECORD = process.env.CITYSCROLL_CARD_PROFILE_RECORD === '1' && READ_LOG !== '';

function gitLines(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Tracked paths the index carries but the working tree does not hold.
function sparseExcludedPaths() {
  const excluded = new Set();
  for (const line of gitLines(['ls-files', '-t'])) {
    if (line.startsWith('S ')) excluded.add(line.slice(2));
  }
  return excluded;
}

const EXCLUDED = sparseExcludedPaths();

function relativeToRoot(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  const absolute = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  const rel = path.relative(ROOT, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function pathOf(target) {
  if (typeof target === 'string') return target;
  if (Buffer.isBuffer(target)) return target.toString('utf8');
  if (target && typeof target === 'object' && typeof target.href === 'string') {
    try {
      return require('node:url').fileURLToPath(target);
    } catch {
      return null;
    }
  }
  return null;
}

const seenReads = new Set();

function recordRead(target) {
  if (!RECORD) return;
  const rel = relativeToRoot(pathOf(target));
  if (!rel || seenReads.has(rel)) return;
  seenReads.add(rel);
  try {
    fs.appendFileSync(READ_LOG, JSON.stringify({ path: rel }) + '\n');
  } catch {
    /* the recorder must never change the behaviour of the process it observes */
  }
}

class CardProfileMissingPath extends Error {
  constructor(rel, syscall) {
    super(
      `card profile is missing a required tracked path: ${rel}\n` +
        `  The reduced card-work profile did not materialise this file, and ${syscall} tried to read it.\n` +
        `  Hydrate it explicitly, then re-run the gate:\n` +
        `    tools/provision_card_profile.sh hydrate ${rel}\n` +
        `  Or fall back to the full-checkout control:\n` +
        `    tools/provision_card_profile.sh hydrate --full`
    );
    this.name = 'CardProfileMissingPath';
    this.code = 'CARD_PROFILE_MISSING_PATH';
    this.cityscrollMissingPath = rel;
    this.cityscrollSyscall = syscall;
  }
}

function reportViolation(rel, syscall) {
  if (!VIOLATION_LOG) return;
  try {
    fs.appendFileSync(VIOLATION_LOG, JSON.stringify({ path: rel, syscall }) + '\n');
  } catch {
    /* a failed log write must not mask the violation itself */
  }
}

// A missing-file error is only a profile violation when the path is tracked and
// deliberately excluded. Everything else keeps its original ENOENT semantics.
// Exported as a pure function so the contract can be tested without a sparse
// checkout to hand.
function classifyMissingPath(error, relativePath, syscall, excluded) {
  if (!error || error.code !== 'ENOENT') return error;
  if (!relativePath || !excluded.has(relativePath)) return error;
  return new CardProfileMissingPath(relativePath, syscall);
}

function escalate(error, target, syscall) {
  const rel = relativeToRoot(pathOf(target));
  const escalated = classifyMissingPath(error, rel, syscall, EXCLUDED);
  if (escalated !== error) reportViolation(rel, syscall);
  return escalated;
}

// Every fs entry point that can hit a path the profile did not materialise is
// guarded, so a metadata probe on a missing path fails closed too. Only the
// entry points that read file *content* feed the recorder: a stat or an access
// check does not mean a gate needs the bytes, and recording those would widen
// the closure to the whole tree.
const SYNC_METHODS = [
  'readFileSync',
  'openSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'accessSync',
  'realpathSync',
  'readlinkSync',
  'opendirSync'
];
const CONTENT_METHODS = new Set(['readFileSync', 'openSync', 'readFile', 'open']);

for (const method of SYNC_METHODS) {
  const original = fs[method];
  if (typeof original !== 'function') continue;
  const records = CONTENT_METHODS.has(method);
  fs[method] = function patched(target, ...rest) {
    try {
      const result = original.call(this, target, ...rest);
      if (records) recordRead(target);
      return result;
    } catch (error) {
      throw escalate(error, target, method);
    }
  };
}

const PROMISE_METHODS = ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'realpath', 'readlink', 'opendir'];

for (const method of PROMISE_METHODS) {
  const original = fs.promises[method];
  if (typeof original !== 'function') continue;
  const recordsPromise = CONTENT_METHODS.has(method);
  fs.promises[method] = async function patched(target, ...rest) {
    try {
      const result = await original.call(this, target, ...rest);
      if (recordsPromise) recordRead(target);
      return result;
    } catch (error) {
      throw escalate(error, target, `promises.${method}`);
    }
  };
}

const CALLBACK_METHODS = ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'realpath', 'readlink'];

for (const method of CALLBACK_METHODS) {
  const original = fs[method];
  if (typeof original !== 'function') continue;
  const recordsCallback = CONTENT_METHODS.has(method);
  fs[method] = function patched(target, ...rest) {
    const callback = rest.length > 0 && typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
    if (!callback) return original.call(this, target, ...rest);
    return original.call(this, target, ...rest, (error, ...values) => {
      if (error) return callback(escalate(error, target, method));
      if (recordsCallback) recordRead(target);
      return callback(null, ...values);
    });
  };
}

// Module loads. ESM specifiers resolve through the loader rather than the public
// fs surface, so the closure would miss imported sources without this hook.
try {
  const { registerHooks } = require('node:module');
  if (typeof registerHooks === 'function') {
    registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith('file:')) recordRead(new URL(url));
        return nextLoad(url, context);
      }
    });
  }
} catch {
  /* module hooks are an enrichment for the recorder, never a hard requirement */
}

module.exports = { CardProfileMissingPath, classifyMissingPath };
