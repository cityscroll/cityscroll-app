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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_DIR = join(ROOT, 'warehouse/fixtures/procurement-evidence');
const OUT_DIR = join(ROOT, 'site/data/procurement_evidence');
const CAPABILITIES_PATH = join(ROOT, 'site/data/procurement_evidence_capabilities.json');
const PROGRAM_SITES_PATH = join(ROOT, 'site/data/agency_program_sites.json');
const PROGRAM_SITES_DIR = join(ROOT, 'site/data/agency_program_sites');
const REGISTERED_MANIFEST_PATH = join(ROOT, 'site/data/analytics_registered_contracts.json');
const CROSSWALK_PATH = join(ROOT, 'worker/src/data/agency_crosswalk.json');

const MANIFEST_SCHEMA = 'cityscroll.procurement_evidence_manifest.v1';
const CAPABILITIES_SCHEMA = 'cityscroll.procurement_evidence_capabilities.v1';
const MANIFEST_MAX_BYTES = 262144;

// Recorded hash of the accepted 2026-11-10 engine observation of the
// normalized registered-contract population.
const ACCEPTED_REGISTERED_MANIFEST_SHA256 = '8d1226cf1072deea57bd224c4a7cc8fbc986b572a7d79c67d42d053dffdfa32c';

const read = p => JSON.parse(readFileSync(p, 'utf8'));

export function buildAll() {
  const nycha = read(join(FIXTURE_DIR, 'nycha-contract-agreement.json'));
  const cb = read(join(FIXTURE_DIR, 'queens-cb12-budget-register.json'));
  const capital = read(join(FIXTURE_DIR, 'ddc-capital-project.json'));
  const crosswalk = read(CROSSWALK_PATH).entries;
  const programSites = read(PROGRAM_SITES_PATH);
  const registered = read(REGISTERED_MANIFEST_PATH);

  const registeredHash = createHash('sha256').update(readFileSync(REGISTERED_MANIFEST_PATH)).digest('hex');
  if (registeredHash !== ACCEPTED_REGISTERED_MANIFEST_SHA256) {
    throw Error('accepted registered-contract manifest hash mismatch; refusing capability projection');
  }
  if (programSites.source_status !== 'available' || programSites.capture_complete !== true) {
    throw Error('program-site source is not an accepted complete capture');
  }

  // as_of is the newest source vintage among admitted inputs, never a wall clock.
  const asOf = [
    ...cb.publications.servable.map(p => `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`),
    nycha[0].retrieval_timestamp.slice(0, 10),
    capital.record.after.agency_data_date,
    registered.snapshot_date,
  ].sort().at(-1);

  const families = [
    { id: 'registered-contracts', source_id: 'checkbook-contracts', agency_ids: ['environmental-protection', 'health-and-mental-hygiene'], status: 'available', unit: 'distinct prime contract', version: registered.snapshot_date, source_as_of: registered.snapshot_date },
    { id: 'program-sites', source_id: 'ebkm-iyma', agency_ids: ['youth-and-community-development'], status: 'available', unit: 'distinct program-site offering', geography: 'service_site_community_district', version: `fy${programSites.fiscal_year}`, source_as_of: null },
    { id: 'capital-projects', source_id: 'fb86-vt7u', agency_ids: ['design-and-construction'], status: 'available', unit: 'financial project identity', version: capital.record.after.reporting_period },
    { id: 'budget-requests', source_id: 'vn4m-mk4t', agency_ids: ['education', 'environmental-protection'], status: 'available', unit: 'tracking code and fiscal cycle', version: cb.publications.latest },
    { id: 'contract-terms', source_id: 'checkbook-nycha-contracts', agency_ids: ['housing-authority'], status: 'dated_retained', unit: 'contract agreement', version: nycha[0].retrieval_timestamp.slice(0, 10) },
  ];

  const dycdRows = [];
  for (const shard of programSites.shards) {
    const body = read(join(PROGRAM_SITES_DIR, `${shard.id}.json`));
    if (createHash('sha256').update(readFileSync(join(PROGRAM_SITES_DIR, `${shard.id}.json`))).digest('hex') !== shard.sha256) {
      throw Error(`program-site shard ${shard.id} hash mismatch`);
    }
    dycdRows.push(...body.rows);
  }

  const agencyInputs = {
    'education': {
      'signals': {
        state: 'available',
        source_contract_id: 'omb-community-board-budget-requests',
        source_as_of: '2026-06-30',
        coverage: 'Published community-board capital and expense budget requests and agency responses for the current fiscal cycle; not appropriations or solicitations.',
        records: m.budgetRequestSignals(cb, { asOf, agency: 'education' }),
      },
    },
    'environmental-protection': {
      'signals': {
        state: 'available',
        source_contract_id: 'omb-community-board-budget-requests',
        source_as_of: '2026-06-30',
        coverage: 'Published community-board capital and expense budget requests and agency responses for the current fiscal cycle; not appropriations or solicitations.',
        records: m.budgetRequestSignals(cb, { asOf, agency: 'environmental-protection' }),
      },
    },
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
      'retained-examples': {
        state: 'dated_retained',
        source_contract_id: 'checkbook-nycha-contracts',
        source_as_of: nycha[0].retrieval_timestamp.slice(0, 10),
        coverage: 'One retained observed contract agreement with a publisher end date; a real dated example excluded from current complete-population results.',
        records: m.contractEndSignals(nycha, { asOf, months: 24 }).signals,
      },
    },
    'youth-and-community-development': {
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
  };
  outputs.set('capabilities', Buffer.from(JSON.stringify(m.canonical ? m.canonical(capabilities) : capabilities, null, 1) + '\n'));

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

  mkdirSync(OUT_DIR, { recursive: true });
  // Pages first, manifests last; retain one previous complete generation.
  const previousVersions = new Map();
  for (const [rel] of outputs) {
    if (rel === 'capabilities' || rel.endsWith('manifest.json')) continue;
    const [agency] = rel.split('/');
    const agencyDir = join(OUT_DIR, agency);
    const manifestPath = join(agencyDir, 'manifest.json');
    if (!previousVersions.has(agency) && existsSync(manifestPath)) {
      previousVersions.set(agency, read(manifestPath).version);
    }
    const path = join(OUT_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body(rel, outputs));
  }
  for (const [rel, bodyBytes] of outputs) {
    if (rel === 'capabilities') { writeFileSync(CAPABILITIES_PATH, bodyBytes); continue; }
    if (rel.endsWith('manifest.json')) writeFileSync(join(OUT_DIR, rel), bodyBytes);
  }
  // Prune generations that are neither current nor the retained previous one.
  const currentVersions = new Map();
  for (const [rel] of outputs) {
    if (rel.endsWith('manifest.json')) currentVersions.set(rel.split('/')[0], rel.split('/')[1]);
  }
  for (const agency of readdirSync(OUT_DIR)) {
    const agencyDir = join(OUT_DIR, agency);
    if (!statSync(agencyDir).isDirectory()) continue;
    for (const version of readdirSync(agencyDir).filter(d => statSync(join(agencyDir, d)).isDirectory())) {
      if (version !== currentVersions.get(agency) && version !== previousVersions.get(agency)) {
        rmSync(join(agencyDir, version), { recursive: true, force: true });
      }
    }
  }
  console.log(JSON.stringify({ status: 'written', files: outputs.size }));
}

function body(rel, outputs) { return outputs.get(rel); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
