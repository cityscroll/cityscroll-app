import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beginSharedPaymentRefresh, resolveSharedPaymentInput } from '../warehouse/lib/shared_payment_input.mjs';

function dispose(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) { chmodSync(path, 0o755); dispose(path); }
  }
  rmSync(root, { recursive: true, force: true });
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'payment-cache-'));
  t.after(() => dispose(root));
  return root;
}
function fill(tx, csv = 'id,amount\na,1\n') {
  writeFileSync(join(tx.stage, 'payments.csv'), csv);
  writeFileSync(join(tx.stage, 'receipt.json'), JSON.stringify({ status: 'complete', source: { acquisition_mode: 'live-publisher' }, reconciliation: { reconciled: true }, checksums: { normalized_csv_sha256: createHash('sha256').update(csv).digest('hex') } }));
}
test('refresh publishes atomically and existing reader keeps its immutable snapshot', async t => {
  const root = fixture(t);
  const first = beginSharedPaymentRefresh(root);
  fill(first);
  assert.throws(() => resolveSharedPaymentInput({ cacheRoot: root }), /ENOENT/);
  const published = await first.publish(); first.close();
  const pinned = resolveSharedPaymentInput({ cacheRoot: root });
  assert.equal(pinned.input, published.input);
  const next = beginSharedPaymentRefresh(root); fill(next, 'id,amount\nb,2\n');
  assert.equal(resolveSharedPaymentInput({ cacheRoot: root }).input, pinned.input);
  await next.publish(); next.close();
  assert.notEqual(resolveSharedPaymentInput({ cacheRoot: root }).input, pinned.input);
  assert.equal(readFileSync(pinned.input, 'utf8'), 'id,amount\na,1\n');
  assert.equal(lstatSync(pinned.input).mode & 0o222, 0);
});
test('identical publications deduplicate; refresh ownership excludes other writers', async t => {
  const root = fixture(t);
  const first = beginSharedPaymentRefresh(root); fill(first);
  assert.throws(() => beginSharedPaymentRefresh(root), /already owned/);
  const a = await first.publish(); first.close();
  const next = beginSharedPaymentRefresh(root); fill(next);
  first.close(); // A stale/double close cannot release the next writer's ownership.
  assert.throws(() => beginSharedPaymentRefresh(root), /already owned/);
  const b = await next.publish(); next.close();
  assert.equal(a.version, b.version);
  assert.equal(readdirSync(join(root, 'checkbook-payment-population/versions')).length, 1);
});
test('bad receipt and quota failure cannot change current version', async t => {
  const root = fixture(t);
  const first = beginSharedPaymentRefresh(root); fill(first); const a = await first.publish(); first.close();
  const bad = beginSharedPaymentRefresh(root, { maxBytes: 1 }); fill(bad);
  assert.throws(() => bad.assertRoom(1), /byte limit/);
  await assert.rejects(bad.publish(), /byte limit/); bad.close();
  const corrupt = beginSharedPaymentRefresh(root); fill(corrupt); writeFileSync(join(corrupt.stage, 'payments.csv'), 'wrong');
  await assert.rejects(corrupt.publish(), /checksum/); corrupt.close();
  assert.equal(resolveSharedPaymentInput({ cacheRoot: root }).version, a.version);
});
test('caller-supplied fixture paths never borrow a shared receipt', t => {
  const root = fixture(t);
  assert.equal(resolveSharedPaymentInput({ cacheRoot: root, input: 'fixture.csv' }), null);
  assert.equal(resolveSharedPaymentInput({ cacheRoot: root, receipt: 'fixture.json' }), null);
});
