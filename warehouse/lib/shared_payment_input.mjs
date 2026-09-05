/** Host-local immutable Checkbook inputs. Readers pin a version; refreshes publish atomically. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, statSync, chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATASET = 'checkbook-payment-population';
const DEFAULT_LIMIT = 10 * 1024 ** 3;
function inventory(root, prefix = '') {
  return readdirSync(root).sort().flatMap(name => {
    const rel = prefix ? `${prefix}/${name}` : name;
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('shared payment cache refuses symlinks');
    if (stat.isDirectory()) return inventory(path, rel);
    if (!stat.isFile()) throw new Error('shared payment cache requires regular files');
    return [{ path, rel, bytes: stat.size }];
  });
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function protect(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) protect(path);
    else chmodSync(path, 0o444);
  }
  chmodSync(root, 0o555);
}

export function beginSharedPaymentRefresh(cacheRoot, { maxBytes = DEFAULT_LIMIT } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid shared payment cache byte limit');
  const root = resolve(cacheRoot, DATASET);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new Error('shared payment cache refuses symlinks');
  const lock = join(root, 'refresh.lock');
  try { mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('shared payment refresh already owned; inspect refresh.lock before retrying');
    throw error;
  }
  let stage;
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    stage = join(root, 'staging', randomUUID());
    mkdirSync(stage, { recursive: true });
    mkdirSync(join(root, 'versions'), { recursive: true });
  } catch (error) { rmSync(lock, { recursive: true }); throw error; }
  let published = false;
  return {
    stage,
    assertRoom(extraBytes = 0) {
      const bytes = inventory(root).reduce((sum, file) => sum + file.bytes, 0);
      if (bytes + extraBytes > maxBytes) throw new Error('shared payment cache byte limit exceeded; reclaim unreferenced versions explicitly before refreshing');
    },
    async publish() {
      if (published) throw new Error('refresh already published');
      const receipt = JSON.parse(readFileSync(join(stage, 'receipt.json'), 'utf8'));
      if (receipt.status !== 'complete' || !receipt.reconciliation?.reconciled) throw new Error('only reconciled complete payment populations may be published');
      if (receipt.checksums?.normalized_csv_sha256 !== await digest(join(stage, 'payments.csv'))) throw new Error('payment CSV checksum does not match receipt');
      const manifest = [];
      for (const file of inventory(stage)) manifest.push({ path: file.rel, bytes: file.bytes, sha256: await digest(file.path) });
      const version = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      this.assertRoom(Buffer.byteLength(JSON.stringify(manifest)) + 1024);
      writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      const target = join(root, 'versions', version);
      if (existsSync(target)) rmSync(stage, { recursive: true });
      else { renameSync(stage, target); protect(target); }
      const pointer = join(root, `current-${randomUUID()}.json`);
      writeFileSync(pointer, `${JSON.stringify({ version })}\n`);
      renameSync(pointer, join(root, 'current.json'));
      published = true;
      return { version, input: join(target, 'payments.csv'), receipt: join(target, 'receipt.json') };
    },
    close() {
      // Failed source acquisitions remain bounded and inspectable, never silently discarded.
      rmSync(lock, { recursive: true, force: true });
    },
  };
}

export function resolveSharedPaymentInput({ cacheRoot = process.env.CITYSCROLL_WAREHOUSE_CACHE, input, receipt } = {}) {
  if (!cacheRoot) return null;
  // Explicit inputs are fixtures or caller-owned snapshots. Never mix them with a shared receipt.
  if (input || receipt) return null;
  const root = resolve(cacheRoot, DATASET);
  const { version } = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('invalid shared payment version');
  const directory = join(root, 'versions', version);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  for (const name of ['payments.csv', 'receipt.json']) {
    const item = manifest.find(file => file.path === name);
    const path = join(directory, name);
    if (!item || lstatSync(path).isSymbolicLink() || statSync(path).size !== item.bytes) throw new Error('incomplete shared payment version');
  }
  return { version, input: join(directory, 'payments.csv'), receipt: join(directory, 'receipt.json') };
}
