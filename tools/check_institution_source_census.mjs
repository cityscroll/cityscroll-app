#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcurementBrowsePopulation } from './lib/procurement_browse_population_io.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const censusPath = path.join(repoRoot, 'warehouse/fixtures/authority-native-procurement/institution_source_census.v1.json');
const census = JSON.parse(fs.readFileSync(censusPath, 'utf8'));

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rowsForAgency(rows, pattern) {
  const re = new RegExp(pattern, 'i');
  return rows.filter((row) => re.test(String(row.agency_name ?? '')));
}

function sourceNames(row) {
  if (Array.isArray(row.source_systems)) return row.source_systems;
  return Array.isArray(row.source_observation_refs)
    ? row.source_observation_refs.map((ref) => String(ref).split(':', 1)[0]).filter(Boolean)
    : [];
}

export function checkCensus() {
  assert(census.schema === 'cityscroll.authority_native_source_census.v1', 'unexpected census schema');
  assert(census.production_adapter_change === false, 'census must not change production adapters');
  assert(Array.isArray(census.production_cards) && census.production_cards.length === 0, 'production cards must be empty');
  assert(typeof census.overlap_method === 'string' && census.overlap_method.includes('exact'), 'overlap method must be explicit and exact');

  const receipts = new Map((census.source_receipts ?? []).map((receipt) => [receipt.source_id, receipt]));
  assert(receipts.size > 0, 'source receipts are required');
  for (const receipt of receipts.values()) {
    assert(typeof receipt.endpoint === 'string' && /^https:\/\//.test(receipt.endpoint), `${receipt.source_id} receipt lacks HTTPS endpoint`);
    assert(receipt.http_status === 200, `${receipt.source_id} receipt is not a successful fetch`);
    assert(/^[a-f0-9]{64}$/.test(receipt.sha256), `${receipt.source_id} receipt lacks SHA-256 fingerprint`);
  }

  const dispositions = new Set(census.disposition_vocabulary);
  assert(census.sources.length > 0, 'source census is empty');
  for (const source of census.sources) {
    assert(dispositions.has(source.disposition), `${source.source_id} has invalid disposition`);
    for (const field of ['publication_stages', 'official_endpoints', 'identifiers', 'access_requirements', 'cadence', 'historical_depth', 'measured_overlap', 'reason']) {
      assert(source[field] !== undefined, `${source.source_id} is missing ${field}`);
    }
    assert(Array.isArray(source.official_endpoints) && source.official_endpoints.length > 0, `${source.source_id} lacks official endpoint`);
    assert(Array.isArray(source.identifiers) && source.identifiers.length > 0, `${source.source_id} lacks identifier evidence`);
    assert(typeof source.reason === 'string' && source.reason.length > 20, `${source.source_id} lacks a backstage disposition reason`);
  }

  const fixtureStages = new Map(census.fixtures.map((fixture) => [fixture.fixture_id, fixture.observation_type]));
  for (const institution of ['SCA', 'Port Authority of New York and New Jersey']) {
    const fixtures = census.fixtures.filter((fixture) => fixture.institution === institution);
    assert(fixtures.some((fixture) => fixture.observation_type === 'opportunity'), `${institution} lacks an opportunity fixture`);
    assert(fixtures.some((fixture) => ['intent_to_award', 'bid_opening_result', 'award'].includes(fixture.observation_type)), `${institution} lacks an award/result fixture`);
    for (const fixture of fixtures) {
      assert(fixture.official_source_url || fixture.source_url, `${fixture.fixture_id} lacks an official source URL`);
      assert(receipts.has(fixture.fixture_id) || receipts.has(fixture.source_id) || typeof fixture.freeze_note === 'string', `${fixture.fixture_id} lacks a frozen source receipt or freeze note`);
      assert(fixture.frozen_on === census.observed_on, `${fixture.fixture_id} freeze date changed`);
    }
  }
  assert(fixtureStages.get('sca-opportunity-26-00107R') === 'opportunity', 'SCA opportunity fixture stage changed');
  assert(fixtureStages.get('sca-official-control-intent-20260414001') === 'intent_to_award', 'SCA control fixture stage changed');
  assert(fixtureStages.get('panynj-opportunity-6000003451') === 'opportunity', 'PA opportunity fixture stage changed');
  assert(fixtureStages.get('panynj-bid-result-6000003424') === 'bid_opening_result', 'PA result fixture must remain bid-opening result');
  const paResult = census.fixtures.find((fixture) => fixture.fixture_id === 'panynj-bid-result-6000003424');
  assert(paResult.award_status === 'not_established', 'preliminary PA result cannot establish award');
  assert(paResult.bidders.length === 4, 'PA result fixture bidder count changed');

  const browsePath = path.join(repoRoot, 'site/data/procurement_browse_rows.json');
  const spinePath = path.join(repoRoot, 'site/data/procurement_spine_sources.json');
  const readModelPath = path.join(repoRoot, 'site/data/shared_procurement_read_model.json');
  for (const [key, filePath] of [['browse_rows', browsePath], ['spine_sources', spinePath], ['shared_read_model', readModelPath]]) {
    assert(sha256(filePath) === census.existing_snapshot.artifacts[key].sha256, `${key} fingerprint drifted; refresh census evidence`);
  }

  const browse = readProcurementBrowsePopulation(browsePath);
  const doe = rowsForAgency(browse.rows, 'department of education|^education$|education admin|^doe$');
  assert(doe.length === census.doe_missing_record_census.doe_canonical_rows, 'DOE canonical row count changed');
  const counts = { city_record: 0, passport_public_contracts: 0, checkbook_contracts: 0 };
  const combinations = {};
  for (const row of doe) {
    const names = [...new Set(sourceNames(row).filter((name) => Object.hasOwn(counts, name)))].sort();
    for (const name of names) counts[name] += 1;
    const key = names.join('+');
    combinations[key] = (combinations[key] ?? 0) + 1;
  }
  assert(JSON.stringify(counts) === JSON.stringify(census.doe_missing_record_census.doe_rows_by_source), 'DOE source counts changed');
  assert(JSON.stringify(combinations) === JSON.stringify(census.doe_missing_record_census.doe_source_combinations), 'DOE source combinations changed');
  assert(census.doe_missing_record_census.demonstrated_missing_rows === 0, 'DOE census must remain explicit about no missing corpus');
  assert(census.doe_missing_record_census.production_card_proposed === false, 'DOE card must not be proposed without missing corpus');

  return {
    sources: census.sources.length,
    fixtures: census.fixtures.length,
    doe_rows: doe.length,
    doe_missing_rows: census.doe_missing_record_census.demonstrated_missing_rows
  };
}

// Refreshes only the mechanical fingerprints of the three tracked live artifacts
// (their byte hash and row/object count) after a routine data refresh changes them.
// Never touches doe_missing_record_census: that section is a human-reviewed finding
// about whether a distinct DOE corpus is missing from existing sources, not a
// mechanical snapshot, so a live DOE row-count change refuses the write instead of
// silently re-blessing the finding — this must reach a person, not the refresh job.
export function refreshExistingSnapshot() {
  const browsePath = path.join(repoRoot, 'site/data/procurement_browse_rows.json');
  const spinePath = path.join(repoRoot, 'site/data/procurement_spine_sources.json');
  const readModelPath = path.join(repoRoot, 'site/data/shared_procurement_read_model.json');

  const browse = readProcurementBrowsePopulation(browsePath);
  const spine = JSON.parse(fs.readFileSync(spinePath, 'utf8'));
  const sharedReadModel = JSON.parse(fs.readFileSync(readModelPath, 'utf8'));

  const doe = rowsForAgency(browse.rows, 'department of education|^education$|education admin|^doe$');
  if (doe.length !== census.doe_missing_record_census.doe_canonical_rows) {
    throw new Error(
      `DOE canonical row count changed (${census.doe_missing_record_census.doe_canonical_rows} -> ${doe.length}); `
      + 'the DOE missing-corpus finding needs a human re-review before this census can be refreshed, not an automatic rewrite'
    );
  }

  census.existing_snapshot.generated_at = new Date().toISOString();
  census.existing_snapshot.artifacts.browse_rows.sha256 = sha256(browsePath);
  census.existing_snapshot.artifacts.browse_rows.row_count = browse.rows.length;
  census.existing_snapshot.artifacts.spine_sources.sha256 = sha256(spinePath);
  census.existing_snapshot.artifacts.spine_sources.passport_contract_rows = (spine.rows?.passport_contracts || []).length;
  census.existing_snapshot.artifacts.shared_read_model.sha256 = sha256(readModelPath);
  census.existing_snapshot.artifacts.shared_read_model.object_count = sharedReadModel.counts?.total ?? null;

  fs.writeFileSync(censusPath, `${JSON.stringify(census, null, 2)}\n`);
  return census.existing_snapshot;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    try {
      const result = checkCensus();
      console.log(`institution source census OK: ${result.sources} sources, ${result.fixtures} fixtures, DOE missing rows ${result.doe_missing_rows}`);
    } catch (error) {
      console.error(`institution source census FAILED: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    try {
      refreshExistingSnapshot();
      const result = checkCensus();
      console.log(`institution source census refreshed: ${result.sources} sources, ${result.fixtures} fixtures, DOE missing rows ${result.doe_missing_rows}`);
    } catch (error) {
      console.error(`institution source census refresh FAILED: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
