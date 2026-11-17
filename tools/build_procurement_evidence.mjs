#!/usr/bin/env node
// Build the generic per-agency procurement evidence projection.
//
// Capability support derives from accepted engine source families; every
// manifest and immutable page is rebuilt from retained fixtures and accepted
// engine artifacts only — no publisher contact, no supplier state. Pages are
// written before the manifest that points at them, the previous complete
// generation is retained alongside the current one, and `--check` verifies
// the committed artifacts match a fresh build without writing.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../site/procurement_evidence.mjs';
import { planCapabilityFamilies } from './build_procurement_plan_index.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_DIR = join(ROOT, 'warehouse/fixtures/procurement-evidence');
const BOARD_REGISTER_PATH = join(ROOT, 'site/data/community_board_budget_register.json');
const BOARD_REGISTER_DIR = join(ROOT, 'site/data/community_board_budget_register');
const OUT_DIR = join(ROOT, 'site/data/procurement_evidence');
const CAPABILITIES_PATH = join(ROOT, 'site/data/procurement_evidence_capabilities.json');
const PROGRAM_SITES_PATH = join(ROOT, 'site/data/agency_program_sites.json');
const PROGRAM_SITES_DIR = join(ROOT, 'site/data/agency_program_sites');
const REGISTERED_MANIFEST_PATH = join(ROOT, 'site/data/analytics_registered_contracts.json');
const REGISTERED_RECEIPT_PATH = join(ROOT, 'warehouse/receipts/proof/analytics_registered_contracts_population_latest.json');
const CROSSWALK_PATH = join(ROOT, 'worker/src/data/agency_crosswalk.json');
const PLAN_INDEX_PATH = join(ROOT, 'site/data/procurement_plan_index.json');

const MANIFEST_SCHEMA = 'cityscroll.procurement_evidence_manifest.v1';
const CAPABILITIES_SCHEMA = 'cityscroll.procurement_evidence_capabilities.v1';
const MANIFEST_MAX_BYTES = 262144;
const REGISTERED_RECEIPT_SCHEMA = 'cityscroll.analytics_registered_contracts_population_receipt.v1';
const REGISTERED_SITE_ARTIFACT = 'site/data/analytics_registered_contracts.json';

const read = p => JSON.parse(readFileSync(p, 'utf8'));

// Agencies that publish community-board budget request signals. The signals
// are built from the whole register, so widening this list is the only change
// needed to publish another agency; the coverage block names every agency the
// register binds, published or not.
export const BOARD_REQUEST_AGENCIES = Object.freeze([
  'education',
  'environmental-protection',
  'housing-authority',
  'youth-and-community-development',
]);
const BOARD_REGISTER_SCHEMA = 'cityscroll.community_board_budget_register.v1';
const BOARD_COVERAGE_SCHEMA = 'cityscroll.community_board_request_signal_coverage.v1';
const boardRequestCounts = p => ({
  by_board: p?.by_board ?? {},
  by_borough: p?.by_borough ?? {},
  with_response: p?.with_response ?? 0,
  without_response: (p?.requests ?? 0) - (p?.with_response ?? 0),
});
const isoFromPublication = p => `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`;

/**
 * Read the whole OMB community-board budget request register: the index and
 * every per-board document it lists, each checked against the index hash and
 * request count. A short, altered or partial register fails the build closed
 * so the previous complete generation stays served.
 */
export function readBoardRegister({ indexPath = BOARD_REGISTER_PATH, dir = BOARD_REGISTER_DIR } = {}) {
  const index = read(indexPath);
  if (index.schema !== BOARD_REGISTER_SCHEMA) throw Error('community-board register has the wrong schema; refusing board request signals');
  const selection = index.publication_selection;
  if (!selection || !Array.isArray(selection.servable) || !selection.servable.length || !/^\d{8}$/.test(selection.latest || '')) {
    throw Error('community-board register lacks a publication selection; refusing board request signals');
  }
  if (!Array.isArray(index.boards) || index.boards.length !== index.counts?.boards) throw Error('community-board register board list does not match its count');
  if ((index.requests_without_a_board_document || []).length) throw Error('community-board register has requests without a board document');
  const documents = [];
  let total = 0;
  for (const board of index.boards) {
    if (!/^[a-z-]+-cb-\d{2}$/.test(board.board_id || '')) throw Error(`community-board register lists a malformed board id ${board.board_id}`);
    const bytes = readFileSync(join(dir, `${board.board_id}.json`));
    if (createHash('sha256').update(bytes).digest('hex') !== board.sha256) throw Error(`community-board document ${board.board_id} hash mismatch`);
    const document = JSON.parse(bytes.toString('utf8'));
    if (document.board_id !== board.board_id || document.requests.length !== board.request_count) throw Error(`community-board document ${board.board_id} does not match the index`);
    total += document.requests.length;
    documents.push(document);
  }
  if (total !== index.counts.requests) throw Error('community-board documents do not add up to the register request count');
  return { index, documents };
}

/**
 * Accept the committed registered-contract index only when its owning
 * population receipt records the same index bytes. Scheduled refresh
 * rematerializes both together; a hardcoded tip hash would refuse every
 * successful contracts rebuild that the evidence step depends on.
 */
export function assertAcceptedRegisteredContracts({
  registeredPath = REGISTERED_MANIFEST_PATH,
  receiptPath = REGISTERED_RECEIPT_PATH,
  registeredBytes = readFileSync(registeredPath),
  registered = JSON.parse(registeredBytes.toString('utf8')),
} = {}) {
  if (!existsSync(receiptPath)) {
    throw Error('registered-contract population receipt is missing; refusing capability projection');
  }
  const receipt = read(receiptPath);
  if (receipt.schema !== REGISTERED_RECEIPT_SCHEMA) {
    throw Error('registered-contract population receipt has the wrong schema; refusing capability projection');
  }
  if (receipt.status !== 'complete') {
    throw Error('registered-contract population receipt is not complete; refusing capability projection');
  }
  if (receipt.materialization?.site_artifact !== REGISTERED_SITE_ARTIFACT) {
    throw Error('registered-contract population receipt names a different site artifact; refusing capability projection');
  }
  const acceptedHash = receipt.materialization?.index_sha256;
  if (typeof acceptedHash !== 'string' || !/^[0-9a-f]{64}$/.test(acceptedHash)) {
    throw Error('registered-contract population receipt lacks index_sha256; refusing capability projection');
  }
  const registeredHash = createHash('sha256').update(registeredBytes).digest('hex');
  if (registeredHash !== acceptedHash) {
    throw Error('accepted registered-contract manifest hash mismatch; refusing capability projection');
  }
  if (registered.snapshot_date !== receipt.snapshot_date || registered.generated_at !== receipt.generated_at) {
    throw Error('registered-contract index provenance does not match its population receipt; refusing capability projection');
  }
  return { registeredHash, receipt };
}

export function buildAll() {
  const nycha = read(join(FIXTURE_DIR, 'nycha-contract-agreement.json'));
  const { index: boardIndex, documents: boardDocuments } = readBoardRegister();
  const capital = read(join(FIXTURE_DIR, 'ddc-capital-project.json'));
  const crosswalk = read(CROSSWALK_PATH).entries;
  const programSites = read(PROGRAM_SITES_PATH);
  const registeredBytes = readFileSync(REGISTERED_MANIFEST_PATH);
  const registered = JSON.parse(registeredBytes.toString('utf8'));
  assertAcceptedRegisteredContracts({ registeredBytes, registered });
  if (programSites.source_status !== 'available' || programSites.capture_complete !== true) {
    throw Error('program-site source is not an accepted complete capture');
  }

  // as_of is the newest source vintage among admitted inputs, never a wall clock.
  const asOf = [
    ...boardIndex.publication_selection.servable.map(isoFromPublication),
    nycha[0].retrieval_timestamp.slice(0, 10),
    capital.record.after.agency_data_date,
    registered.snapshot_date,
  ].sort().at(-1);

  const planIndex = read(PLAN_INDEX_PATH);
  const families = [
    { id: 'registered-contracts', source_id: 'checkbook-contracts', agency_ids: ['environmental-protection', 'health-and-mental-hygiene'], status: 'available', unit: 'distinct prime contract', version: registered.snapshot_date, source_as_of: registered.snapshot_date },
    { id: 'program-sites', source_id: 'ebkm-iyma', agency_ids: ['youth-and-community-development'], status: 'available', unit: 'distinct program-site offering', geography: 'service_site_community_district', version: `fy${programSites.fiscal_year}`, source_as_of: null },
    { id: 'capital-projects', source_id: 'fb86-vt7u', agency_ids: ['design-and-construction'], status: 'available', unit: 'financial project identity', version: capital.record.after.reporting_period },
    { id: 'budget-requests', source_id: 'vn4m-mk4t', agency_ids: [...BOARD_REQUEST_AGENCIES], status: 'available', unit: 'tracking code and fiscal cycle', version: boardIndex.publication_selection.latest },
    { id: 'contract-terms', source_id: 'checkbook-nycha-contracts', agency_ids: ['housing-authority'], status: 'dated_retained', unit: 'contract agreement', version: nycha[0].retrieval_timestamp.slice(0, 10) },
    ...planCapabilityFamilies(planIndex),
  ];

  const dycdRows = [];
  for (const shard of programSites.shards) {
    const body = read(join(PROGRAM_SITES_DIR, `${shard.id}.json`));
    if (createHash('sha256').update(readFileSync(join(PROGRAM_SITES_DIR, `${shard.id}.json`))).digest('hex') !== shard.sha256) {
      throw Error(`program-site shard ${shard.id} hash mismatch`);
    }
    dycdRows.push(...body.rows);
  }

  const boardSet = m.budgetRequestSignalSet(boardDocuments, { asOf, agencies: BOARD_REQUEST_AGENCIES });
  const boardLatest = isoFromPublication(boardIndex.publication_selection.latest);
  const boardSignalsFamily = agency => ({
    state: 'available',
    source_contract_id: 'omb-community-board-budget-requests',
    source_as_of: boardLatest,
    coverage: 'Published community-board capital and expense budget requests and agency responses for the current fiscal cycle; not appropriations or solicitations.',
    records: boardSet.signals[agency],
    request_counts: boardRequestCounts(boardSet.coverage.published[agency]),
  });

  const agencyInputs = {
    'education': { 'signals': boardSignalsFamily('education') },
    'environmental-protection': { 'signals': boardSignalsFamily('environmental-protection') },
    'design-and-construction': {
      'signals': {
        state: 'available',
        source_contract_id: 'capital-projects-dashboard',
        source_as_of: capital.record.after.agency_data_date,
        coverage: 'Whole-project budget and forecast movements published by the capital projects dashboard; not solicitation values, bid deadlines or contract terms.',
        records: [m.capitalSignal(capital, { agency: 'design-and-construction', asOf, crosswalk })].filter(Boolean),
      },
    },
    'housing-authority': {
      'signals': boardSignalsFamily('housing-authority'),
      'retained-examples': {
        state: 'dated_retained',
        source_contract_id: 'checkbook-nycha-contracts',
        source_as_of: nycha[0].retrieval_timestamp.slice(0, 10),
        coverage: 'One retained observed contract agreement with a publisher end date; a real dated example excluded from current complete-population results.',
        records: m.contractEndSignals(nycha, { asOf, months: 24 }).signals,
      },
    },
    'youth-and-community-development': {
      'signals': boardSignalsFamily('youth-and-community-development'),
      'program-sites': {
        state: 'available',
        source_contract_id: 'dycd-program-sites',
        source_as_of: null,
        coverage: `Published DYCD program-site offerings in Queens community districts for fiscal year ${programSites.fiscal_year}; facility sites located in a district, never vendor addresses or demand.`,
        records: dycdRows,
      },
    },
  };

  const outputs = new Map();
  const capabilities = {
    schema: CAPABILITIES_SCHEMA,
    as_of: asOf,
    families,
    agencies: Object.fromEntries(Object.keys(agencyInputs).sort().map(a => [a, { manifest: `/data/procurement_evidence/${a}/manifest.json` }])),
    community_board_requests: {
      schema: BOARD_COVERAGE_SCHEMA,
      source: {
        publisher: boardIndex.source.publisher,
        name: boardIndex.source.name,
        dataset_id: boardIndex.source.dataset_id,
        source_url: boardIndex.source.source_url,
        register: 'site/data/community_board_budget_register.json',
        acquired_at: boardIndex.acquired_at,
        publication_latest: boardIndex.publication_selection.latest,
        publications_servable: boardIndex.publication_selection.servable,
      },
      rule: 'One signal per request: the latest servable publication at or before as_of, exact on board, fiscal year and tracking code. A request is a community board asking an agency for something; the response is the written answer. Neither is funding, a commitment or delivery.',
      signal_agencies: [...BOARD_REQUEST_AGENCIES],
      ...boardSet.coverage,
    },
  };
  outputs.set('capabilities', m.bytes(capabilities));

  const manifests = new Map();
  for (const [agency, familyInputs] of Object.entries(agencyInputs)) {
    const records = Object.values(familyInputs).flatMap(f => f.records);
    const familyEntries = Object.entries(familyInputs).map(([id, f]) => ({
      id,
      source_id: families.find(x => x.id === (id === 'retained-examples' ? 'contract-terms' : id))?.source_id ?? f.source_contract_id,
      agency_ids: [agency],
      status: f.state,
      unit: families.find(x => x.id === id)?.unit ?? f.records[0]?.kind ?? 'record',
      version: families.find(x => x.id === (id === 'retained-examples' ? 'contract-terms' : id))?.version ?? 'unknown',
      source_as_of: f.source_as_of,
    }));
    const generation = m.makeGeneration({ families: familyEntries, records });
    const manifestFamilies = {};
    for (const [family, f] of Object.entries(familyInputs)) {
      const pages = m.paginate({ ...generation, records: [...f.records].sort((a, b) => a.id.localeCompare(b.id)) });
      const pointers = [];
      pages.forEach((page, index) => {
        const relPath = `/data/procurement_evidence/${agency}/${generation.version}/${family}-${index}.json`;
        outputs.set(`${agency}/${generation.version}/${family}-${index}.json`, m.bytes(page.body));
        pointers.push({ path: relPath, sha256: page.sha256 });
      });
      manifestFamilies[family] = {
        state: f.state,
        total: f.records.length,
        source_as_of: f.source_as_of,
        source_contract_id: f.source_contract_id,
        coverage: f.coverage,
        source_check_at: null,
        publisher_updated_at: family === 'program-sites' ? programSites.publisher_updated_at : null,
        ...(f.request_counts ? { request_counts: f.request_counts } : {}),
        pages: pointers,
      };
    }
    const manifest = { schema: MANIFEST_SCHEMA, agency_id: agency, version: generation.version, families: manifestFamilies };
    const manifestBytes = m.bytes(manifest);
    if (manifestBytes.length > MANIFEST_MAX_BYTES) throw Error(`manifest for ${agency} exceeds ${MANIFEST_MAX_BYTES} bytes`);
    outputs.set(`${agency}/manifest.json`, manifestBytes);
    manifests.set(agency, manifest);
  }
  return { outputs, manifests, capabilities };
}

/**
 * Publish one evidence generation. Immutable pages are written before any
 * current manifest pointer moves. When `interruptBeforeManifest` is true the
 * function stops after pages land so callers can prove the prior pointer is
 * still served while the new generation is already readable on disk.
 */
export function publishOutputs(outputs, {
  outDir = OUT_DIR,
  capabilitiesPath = CAPABILITIES_PATH,
  interruptBeforeManifest = false,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const previousVersions = new Map();
  let pagesWritten = 0;
  for (const [rel, bodyBytes] of outputs) {
    if (rel === 'capabilities' || rel.endsWith('manifest.json')) continue;
    const [agency] = rel.split('/');
    const agencyDir = join(outDir, agency);
    const manifestPath = join(agencyDir, 'manifest.json');
    if (!previousVersions.has(agency) && existsSync(manifestPath)) {
      previousVersions.set(agency, read(manifestPath).version);
    }
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bodyBytes);
    pagesWritten += 1;
  }
  if (interruptBeforeManifest) {
    return { interrupted: true, pagesWritten, previousVersions };
  }
  for (const [rel, bodyBytes] of outputs) {
    if (rel === 'capabilities') { writeFileSync(capabilitiesPath, bodyBytes); continue; }
    if (rel.endsWith('manifest.json')) writeFileSync(join(outDir, rel), bodyBytes);
  }
  const currentVersions = new Map();
  for (const [rel, bodyBytes] of outputs) {
    if (!rel.endsWith('manifest.json')) continue;
    const agency = rel.split('/')[0];
    const manifest = JSON.parse(bodyBytes.toString('utf8'));
    if (typeof manifest.version !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.version)) {
      throw Error(`manifest for ${agency} lacks a content-addressed version`);
    }
    currentVersions.set(agency, manifest.version);
  }
  for (const agency of readdirSync(outDir)) {
    const agencyDir = join(outDir, agency);
    if (!statSync(agencyDir).isDirectory()) continue;
    for (const version of readdirSync(agencyDir).filter(d => statSync(join(agencyDir, d)).isDirectory())) {
      if (version !== currentVersions.get(agency) && version !== previousVersions.get(agency)) {
        rmSync(join(agencyDir, version), { recursive: true, force: true });
      }
    }
  }
  return { interrupted: false, pagesWritten, previousVersions, currentVersions };
}

function main() {
  const check = process.argv.includes('--check');
  const { outputs } = buildAll();

  if (check) {
    const drift = [];
    for (const [rel, body] of outputs) {
      const path = rel === 'capabilities' ? CAPABILITIES_PATH : join(OUT_DIR, rel);
      if (!existsSync(path) || Buffer.compare(readFileSync(path), body) !== 0) drift.push(path);
    }
    if (existsSync(OUT_DIR)) {
      const expected = new Set([...outputs.keys()].filter(k => k !== 'capabilities'));
      for (const agency of readdirSync(OUT_DIR)) {
        const agencyDir = join(OUT_DIR, agency);
        if (!statSync(agencyDir).isDirectory()) continue;
        if (existsSync(join(agencyDir, 'manifest.json')) && !expected.has(`${agency}/manifest.json`)) drift.push(join(agencyDir, 'manifest.json'));
        for (const version of readdirSync(agencyDir).filter(d => statSync(join(agencyDir, d)).isDirectory())) {
          for (const file of readdirSync(join(agencyDir, version))) {
            if (!expected.has(`${agency}/${version}/${file}`)) drift.push(join(agencyDir, version, file));
          }
        }
      }
    }
    if (drift.length) {
      console.log(JSON.stringify({ status: 'drift', paths: drift }));
      process.exit(1);
    }
    console.log(JSON.stringify({ status: 'ok', files: outputs.size }));
    return;
  }

  const result = publishOutputs(outputs);
  console.log(JSON.stringify({ status: 'written', files: outputs.size, pages: result.pagesWritten }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
