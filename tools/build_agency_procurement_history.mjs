#!/usr/bin/env node
// Build the bounded DYCD agency purchasing-history artifact.
//
// Reads retained engine fixtures only — never a publisher, never a new
// collector. City Record notice metrics depend on the configured warehouse
// (CITYSCROLL_WAREHOUSE_ROOT or the repository warehouse directory) holding
// the full City Record population plus a valid acquisition receipt; when
// that corpus cannot be resolved, notice count and response window are
// explicitly unavailable while the independent Checkbook registered-contract
// metric stays visible and dated. `--check` rebuilds and compares without
// writing.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historyWithStanding, contributorHash, DYCD_AGENCY_ID } from '../site/agency_procurement_history.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_DIR = join(ROOT, 'warehouse/fixtures/agency-procurement-history');
const OUT_PATH = join(ROOT, 'site/data/agency_procurement_history.json');
const SCHEMA = 'cityscroll.agency_procurement_history.v1';
const ARTIFACT_MAX_BYTES = 262144;
const EVIDENCE_IDS_PER_METRIC = 25;
const DEFAULT_WINDOW = { windowStart: '2024-11-11', windowEnd: '2026-11-11' };

const read = p => JSON.parse(readFileSync(p, 'utf8'));

// Mirror warehouse/scripts/paths.py warehouse_root(): the configured root
// must hold the full City Record raw population and a valid acquisition
// receipt before notice metrics may claim availability.
export function cityRecordCorpusStatus(warehouseRoot) {
  const rawDir = join(warehouseRoot, 'raw', 'dg92-zbpx');
  if (!existsSync(rawDir)) return { status: 'unavailable', reason: 'full_city_record_population_not_resolvable' };
  const snapshots = readdirSync(rawDir).filter(d => d.startsWith('snapshot_date='));
  const receiptsDir = join(warehouseRoot, 'receipts');
  const receipts = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
  const validReceipt = receipts.some(name => name.includes('dg92-zbpx') && name.endsWith('.json'));
  if (!snapshots.length || !validReceipt) return { status: 'unavailable', reason: 'valid_acquisition_receipt_not_resolvable' };
  return { status: 'available' };
}

export function build({ fixtureDir = FIXTURE_DIR, warehouseRoot = process.env.CITYSCROLL_WAREHOUSE_ROOT || join(ROOT, 'warehouse'), window = DEFAULT_WINDOW } = {}) {
  const contractsFixture = read(join(fixtureDir, 'dycd-registered-contracts-2026-09-09.json'));
  const readback = read(join(fixtureDir, 'engine-registered-contracts-readback-2026-11-10.json'));
  const contractsRows = contractsFixture.rows;
  const observedAt = contractsFixture.source_manifest.source_population.observed_at.slice(0, 10);

  const corpus = cityRecordCorpusStatus(warehouseRoot);
  const result = historyWithStanding({
    notices: [],
    contracts: contractsRows,
    noticeStatus: corpus.status === 'available' ? 'available' : 'unavailable',
    contractStatus: 'stale',
    contractsObservedAt: observedAt,
    ...window,
  });

  const rc = result.registered_contracts;
  const contributorIds = rc.contributor_ids;
  delete rc.contributor_ids;
  const artifact = {
    schema: SCHEMA,
    generated_at: readback.observed_at,
    agency_id: DYCD_AGENCY_ID,
    window: result.window,
    sources: {
      'city-record': corpus.status === 'available'
        ? { status: 'available' }
        : { status: 'unavailable', reason: corpus.reason },
      'checkbook-contracts': {
        status: 'stale',
        observed_at: rc.observed_at,
        snapshot_date: contractsFixture.source_manifest.snapshot_date,
        current_claim_allowed: false,
        normalized_unique_contracts: contractsFixture.source_manifest.source_population.normalized_unique_contracts,
        latest_accepted_observation: {
          observed_at: readback.manifest.generated_at,
          manifest_sha256: readback.manifest_sha256,
          population: readback.unique_ids,
          dycd_window_eligible: readback.selected_contracts,
          median_original_registered_amount: readback.median_original_registered_amount,
        },
      },
    },
    source_status: result.source_status,
    solicitation_notices: { status: 'unavailable', value: null },
    response_window: { status: 'unavailable', value: null },
    registered_contracts: {
      status: 'stale',
      observed_at: rc.observed_at,
      current_claim_allowed: rc.current_claim_allowed,
      count: rc.count,
      amount_eligible: rc.amount_eligible,
      missing_or_invalid_amount: rc.missing_or_invalid_amount,
      median_original_registered_amount: rc.median_original_registered_amount,
      label: rc.label,
      evidence: {
        first25: contributorIds.slice(0, EVIDENCE_IDS_PER_METRIC),
        contributor_count: contributorIds.length,
        contributors_sha256: contributorHash(contributorIds),
      },
    },
    coverage: {
      unit: 'distinct prime contract',
      agency_count: 1,
      scope: `DYCD registered contracts ${window.windowStart} (inclusive) to ${window.windowEnd} (exclusive); City Record notice history unavailable without the full corpus`,
    },
  };
  const body = Buffer.from(JSON.stringify(artifact, null, 1) + '\n');
  if (body.length > ARTIFACT_MAX_BYTES) throw Error(`artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`);
  return body;
}

function main() {
  const check = process.argv.includes('--check');
  const body = build();
  if (check) {
    const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH) : null;
    if (!current || Buffer.compare(current, body) !== 0) {
      console.log(JSON.stringify({ status: 'drift', path: OUT_PATH }));
      process.exit(1);
    }
    console.log(JSON.stringify({ status: 'ok' }));
    return;
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, body);
  console.log(JSON.stringify({ status: 'written', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
