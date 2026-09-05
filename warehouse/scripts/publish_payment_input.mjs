#!/usr/bin/env node
/** Seed a shared cache from an existing completed, checksummed payment population. */
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beginSharedPaymentRefresh } from '../lib/shared_payment_input.mjs';
const [cacheRoot, input, receipt] = process.argv.slice(2);
if (!cacheRoot || !input || !receipt || process.argv.length !== 5) {
  throw new Error('Usage: node warehouse/scripts/publish_payment_input.mjs CACHE_ROOT PAYMENTS_CSV RECEIPT_JSON');
}
const refresh = beginSharedPaymentRefresh(cacheRoot);
try {
  refresh.assertRoom(statSync(input).size + statSync(receipt).size + 4096);
  copyFileSync(input, join(refresh.stage, 'payments.csv'));
  copyFileSync(receipt, join(refresh.stage, 'receipt.json'));
  const result = await refresh.publish();
  console.log(JSON.stringify({ status: 'published', version: result.version }));
} finally { refresh.close(); }
