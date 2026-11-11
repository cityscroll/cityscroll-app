import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRegistry } from '../ops/first-class-refresh/rebuild-committed-read-models.mjs';
import { buildAll, publishOutputs } from '../tools/build_procurement_evidence.mjs';
import {
  smokeFirstClassSurfaces,
  smokeProcurementEvidenceSurfaces,
} from '../tools/first_class_live_smoke.mjs';
import {
  builderStatusMap,
  procurementEvidenceRebuildStatus,
  rebuildStatusFor,
  PROCUREMENT_EVIDENCE_BUILDER,
} from '../tools/first_class_refresh_run_receipt.mjs';
import { FIRST_CLASS_REPORT_SCHEMA } from '../tools/first_class_refresh.mjs';
import * as evidence from '../site/procurement_evidence.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACTS_PATH = join(ROOT, 'site/data/source_contracts.json');
const README_PATH = join(ROOT, 'ops/first-class-refresh/README.md');
const DERIVED_MANIFEST_PATH = join(ROOT, 'warehouse/derived_json_build_manifest.json');
const EVIDENCE_BUILDER = PROCUREMENT_EVIDENCE_BUILDER;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('scheduled rebuild reaches the evidence projection after the derived boundary and before source-health', () => {
  const registry = readRegistry(ROOT);
  const byId = new Map(registry.rebuild_sequence.map((step, index) => [step.id, { step, index }]));
  const boundary = byId.get('derived-json-build-boundary');
  const evidenceStep = byId.get('procurement-evidence');
  const sourceHealth = byId.get('source-health-observations');
  assert.ok(boundary, 'derived-json-build-boundary must remain registered');
  assert.ok(evidenceStep, 'committed-read-models.json must register a procurement-evidence step');
  assert.ok(sourceHealth, 'source-health-observations must remain registered');
  assert.deepEqual(evidenceStep.step.command, [EVIDENCE_BUILDER]);
  assert.ok(
    (evidenceStep.step.covers || []).includes(EVIDENCE_BUILDER),
    'procurement-evidence must cover the evidence builder',
  );
  assert.ok(
    (evidenceStep.step.after || []).includes('derived-json-build-boundary'),
    'procurement-evidence must declare the derived JSON boundary as a dependency',
  );
  assert.ok(
    boundary.index < evidenceStep.index && evidenceStep.index < sourceHealth.index,
    'procurement-evidence must sit after the derived boundary and before source-health observations',
  );
  assert.ok(
    (sourceHealth.step.after || []).includes('procurement-evidence'),
    'source-health-observations must wait for the evidence projection',
  );
  assert.ok(
    (registry.additional_gate_builders || []).includes(EVIDENCE_BUILDER),
    'evidence builder must be declared among additional gate builders',
  );
});

test('source contracts keep schema_version 1 and the full contracts array; only dependent materializers are amended', () => {
  const contracts = readJson(CONTRACTS_PATH);
  assert.equal(contracts.schema_version, 1);
  const ids = (contracts.contracts || []).map((row) => row.id).sort();
  assert.equal(ids.length, 70);
  assert.ok(ids.includes('checkbook-contracts'));
  assert.ok(ids.includes('omb-community-board-budget-requests'));
  assert.ok(ids.includes('dycd-program-sites'));

  const byArtifact = new Map((contracts.first_class_artifacts || []).map((row) => [row.id, row]));
  for (const id of ['contracts-registered', 'community-board-budget-register', 'agency-program-sites']) {
    const artifact = byArtifact.get(id);
    assert.ok(artifact, `missing first-class artifact ${id}`);
    assert.ok(
      (artifact.dependent_materializers || []).includes(EVIDENCE_BUILDER),
      `${id} must list the evidence builder as a dependent materializer`,
    );
  }
  assert.equal(
    byArtifact.get('procurement-evidence-capabilities')?.owning_builder,
    EVIDENCE_BUILDER,
  );
});

test('unchanged semantic inputs preserve generation hashes and publisher dates', () => {
  const first = buildAll();
  const second = buildAll();
  assert.equal(first.outputs.size, second.outputs.size);
  for (const [rel, body] of first.outputs) {
    assert.equal(sha256(body), sha256(second.outputs.get(rel)), `hash drifted for ${rel}`);
  }
  for (const [agency, manifest] of first.manifests) {
    const again = second.manifests.get(agency);
    assert.equal(manifest.version, again.version);
    for (const [family, entry] of Object.entries(manifest.families)) {
      assert.equal(entry.source_as_of, again.families[family].source_as_of);
      assert.equal(entry.publisher_updated_at, again.families[family].publisher_updated_at);
      assert.equal(entry.total, again.families[family].total);
    }
  }
  assert.equal(first.capabilities.as_of, second.capabilities.as_of);
});

test('family source failure preserves a nonempty prior family and never reports a hidden zero', () => {
  const families = [
    { id: 'registered-contracts', source_id: 'checkbook-contracts', agency_ids: ['environmental-protection'], status: 'unavailable', unit: 'distinct prime contract', version: 'nov10', source_as_of: '2026-11-10' },
    { id: 'budget-requests', source_id: 'vn4m-mk4t', agency_ids: ['environmental-protection'], status: 'available', unit: 'tracking code and fiscal cycle', version: '20260630', source_as_of: '2026-06-30' },
  ];
  const support = evidence.capabilities(families, 'environmental-protection');
  assert.equal(support.families.find((row) => row.family === 'registered-contracts').status, 'unavailable');
  assert.equal(support.families.find((row) => row.family === 'budget-requests').status, 'available');

  const initial = {
    served_version: 'v1',
    last_served_success_at: '2026-11-10T00:00:00Z',
    last_attempt_at: '2026-11-10T00:00:00Z',
  };
  const candidate = evidence.acceptRefresh(initial, {
    type: 'candidate',
    version: 'v2',
    parent_version: 'v1',
    at: '2026-11-11T00:00:00Z',
  });
  let state = evidence.acceptRefresh(candidate, {
    type: 'failed',
    stage: 'source',
    reason: 'publisher_unavailable',
    at: '2026-11-11T00:01:00Z',
  });
  assert.equal(state.served_version, 'v1');
  assert.equal(state.last_served_success_at, initial.last_served_success_at);
  state = evidence.acceptRefresh(state, {
    type: 'failed',
    stage: 'publish',
    reason: 'http503',
    at: '2026-11-11T01:01:00Z',
  });
  const freshness = evidence.freshness(state, {
    now: '2026-11-11T02:00:00Z',
    sourceCheckAt: '2026-11-11T01:00:00Z',
  });
  assert.equal(freshness.state, 'refresh_failed');
  assert.equal(freshness.alert, true);
  assert.equal(freshness.last_served_success_at, initial.last_served_success_at);
});

test('interruption after immutable pages and before manifest activation keeps the prior pointer', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'procurement-evidence-refresh-'));
  const outDir = join(scratch, 'procurement_evidence');
  const capabilitiesPath = join(scratch, 'procurement_evidence_capabilities.json');
  try {
    const seedAgency = 'environmental-protection';
    const seedVersion = 'a'.repeat(64);
    const seedDir = join(outDir, seedAgency, seedVersion);
    mkdirSync(seedDir, { recursive: true });
    const seedPage = {
      schema: 'cityscroll.procurement_evidence_page.v1',
      version: seedVersion,
      rows: [{ id: 'seed', agency_id: seedAgency, headline: 'prior generation' }],
    };
    const seedPageBytes = evidence.bytes(seedPage);
    writeFileSync(join(seedDir, 'signals-0.json'), seedPageBytes);
    const seedManifest = {
      schema: 'cityscroll.procurement_evidence_manifest.v1',
      agency_id: seedAgency,
      version: seedVersion,
      families: {
        signals: {
          state: 'available',
          total: 1,
          pages: [{
            path: `/data/procurement_evidence/${seedAgency}/${seedVersion}/signals-0.json`,
            sha256: evidence.digest(seedPage),
          }],
        },
      },
    };
    writeFileSync(join(outDir, seedAgency, 'manifest.json'), evidence.bytes(seedManifest));

    const { outputs } = buildAll();
    const interrupted = publishOutputs(outputs, {
      outDir,
      capabilitiesPath,
      interruptBeforeManifest: true,
    });
    assert.equal(interrupted.interrupted, true);
    assert.ok(interrupted.pagesWritten > 0);

    const served = readJson(join(outDir, seedAgency, 'manifest.json'));
    assert.equal(served.version, seedVersion, 'prior manifest must still be the served pointer');

    const nextVersion = JSON.parse(outputs.get(`${seedAgency}/manifest.json`).toString('utf8')).version;
    assert.notEqual(nextVersion, seedVersion);
    assert.ok(
      existsSync(join(outDir, seedAgency, nextVersion)),
      'new immutable pages must be readable before the pointer moves',
    );
    assert.ok(
      existsSync(join(outDir, seedAgency, seedVersion)),
      'previous complete generation must remain available for pinned readers',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('live smoke records evidence source revision, expected versus served version, and page hash', async () => {
  const capabilities = readJson(join(ROOT, 'site/data/procurement_evidence_capabilities.json'));
  const agency = 'environmental-protection';
  const manifestPath = join(ROOT, 'site', capabilities.agencies[agency].manifest.replace(/^\//, ''));
  const manifest = readJson(manifestPath);
  const family = Object.keys(manifest.families)[0];
  const pointer = manifest.families[family].pages[0];
  const pageBody = readFileSync(join(ROOT, 'site', pointer.path.replace(/^\//, '')));

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith('first_class_freshness_report.json')) {
      return new Response(JSON.stringify({
        schema: FIRST_CLASS_REPORT_SCHEMA,
        deployment_identity: 'release-evidence',
        surface_count: 1,
        surfaces: [{ public_artifact_path: 'site/data/rules.json', freshness_state: 'current' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.endsWith(`/data/procurement_evidence/${agency}/manifest.json`)) {
      return new Response(evidence.bytes(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.endsWith(pointer.path)) {
      return new Response(pageBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.includes('/data/procurement_evidence_capabilities.json')) {
      return new Response(evidence.bytes(capabilities), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('<main>Resident page</main>', { status: 200 });
  };

  const evidenceReceipt = await smokeProcurementEvidenceSurfaces({
    baseUrl: 'https://example.test',
    fetchImpl,
    agencies: [agency],
    observedAt: '2026-11-11T12:00:00Z',
  });
  assert.equal(evidenceReceipt.status, 'passed');
  assert.equal(evidenceReceipt.observations.length, 1);
  const observation = evidenceReceipt.observations[0];
  assert.equal(observation.agency_id, agency);
  assert.equal(observation.expected_manifest_version, manifest.version);
  assert.equal(observation.served_manifest_version, manifest.version);
  assert.equal(observation.page_sha256, pointer.sha256);
  assert.equal(observation.last_served_success_at, '2026-11-11T12:00:00Z');
  assert.match(observation.source_revision, /^[0-9a-f]{64}$/);

  const combined = await smokeFirstClassSurfaces({
    baseUrl: 'https://example.test',
    fetchImpl,
    deploymentIdentity: 'release-evidence',
    evidenceAgencies: [agency],
    observedAt: '2026-11-11T12:00:00Z',
  });
  assert.equal(combined.status, 'passed');
  assert.ok(combined.procurement_evidence);
  assert.equal(combined.procurement_evidence.observations[0].served_manifest_version, manifest.version);
});

test('community-board source cadence stays on the source contract, while publication silence uses the existing 36h health channel', () => {
  const initial = {
    served_version: 'v1',
    last_served_success_at: '2026-11-10T00:00:00Z',
    last_attempt_at: '2026-11-10T00:00:00Z',
  };
  assert.equal(
    evidence.freshness(initial, {
      now: '2026-11-10T02:00:00Z',
      sourceCheckAt: '2026-10-17T01:53:34Z',
      maxCheckHours: 5040,
    }).state,
    'current',
  );
  assert.equal(
    evidence.freshness(initial, {
      now: '2026-11-12T00:00:00Z',
      sourceCheckAt: '2026-11-11T23:00:00Z',
    }).state,
    'stale',
  );
  const failedTwice = evidence.acceptRefresh(
    evidence.acceptRefresh(
      evidence.acceptRefresh(initial, {
        type: 'candidate',
        version: 'v2',
        parent_version: 'v1',
        at: '2026-11-11T00:00:00Z',
      }),
      { type: 'failed', stage: 'publish', reason: 'http503', at: '2026-11-11T00:01:00Z' },
    ),
    { type: 'failed', stage: 'publish', reason: 'http503', at: '2026-11-11T01:01:00Z' },
  );
  assert.equal(
    evidence.freshness(failedTwice, {
      now: '2026-11-11T02:00:00Z',
      sourceCheckAt: '2026-11-11T01:00:00Z',
    }).alert,
    true,
  );
});

test('installed runner repair docs keep published_paths and forbid credential leakage', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  assert.match(readme, /Repairing an installed warehouse runner/);
  assert.match(readme, /published_paths/);
  assert.match(readme, /run-warehouse-refresh\.sh/);
  assert.match(readme, /not reset or stash/);
  assert.match(readme, /credential/);
  assert.doesNotMatch(readme, /GH_TOKEN=[A-Za-z0-9_]{20,}/);
  assert.doesNotMatch(readme, /Bearer [A-Za-z0-9._-]{20,}/);

  const derived = readJson(DERIVED_MANIFEST_PATH);
  assert.ok(
    (derived.committed?.goldens || []).includes('warehouse/fixtures/procurement-evidence'),
    'derived JSON manifest must name the retained evidence fixtures among committed goldens',
  );
});

test('run receipt maps the evidence builder through dependent materializers', () => {
  const registry = readRegistry(ROOT);
  const rebuildReceipt = {
    steps: [
      { id: 'derived-json-build-boundary', status: 'succeeded' },
      { id: 'procurement-evidence', status: 'succeeded' },
      { id: 'source-health-observations', status: 'succeeded' },
    ],
  };
  const statusByBuilder = builderStatusMap(registry, rebuildReceipt);
  assert.equal(statusByBuilder.get(EVIDENCE_BUILDER), 'succeeded');
  assert.equal(procurementEvidenceRebuildStatus(registry, rebuildReceipt), 'succeeded');

  const contracts = readJson(CONTRACTS_PATH);
  const registered = contracts.first_class_artifacts.find((row) => row.id === 'contracts-registered');
  assert.equal(rebuildStatusFor(registered, statusByBuilder), 'succeeded');

  const failedReceipt = {
    steps: [
      { id: 'derived-json-build-boundary', status: 'succeeded' },
      { id: 'procurement-evidence', status: 'failed' },
      { id: 'source-health-observations', status: 'skipped' },
    ],
  };
  const failedMap = builderStatusMap(registry, failedReceipt);
  assert.equal(rebuildStatusFor(registered, failedMap), 'failed');
  assert.equal(procurementEvidenceRebuildStatus(registry, failedReceipt), 'failed');
});

test('controlled source A to source B materialization changes the served generation without a product redeploy', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'procurement-evidence-ab-'));
  const outDir = join(scratch, 'procurement_evidence');
  const capabilitiesPath = join(scratch, 'procurement_evidence_capabilities.json');
  try {
    const generationA = buildAll();
    publishOutputs(generationA.outputs, { outDir, capabilitiesPath });
    const agency = 'environmental-protection';
    const versionA = generationA.manifests.get(agency).version;
    assert.ok(existsSync(join(outDir, agency, 'manifest.json')));

    // Simulate a newer source observation by appending one distinct record to the
    // environmental-protection signals family while keeping every other input.
    const mutated = new Map(generationA.outputs);
    const manifestA = generationA.manifests.get(agency);
    const family = 'signals';
    const priorPage = readJson(join(outDir, agency, versionA, `${family}-0.json`));
    const extra = {
      ...priorPage.rows[0],
      id: `${priorPage.rows[0].id}-b`,
      headline: `${priorPage.rows[0].headline} (source B)`,
    };
    const recordsB = [...priorPage.rows, extra].sort((left, right) => left.id.localeCompare(right.id));
    const familyEntries = Object.entries(manifestA.families).map(([id, entry]) => ({
      id,
      source_id: entry.source_contract_id,
      agency_ids: [agency],
      status: entry.state,
      unit: 'record',
      version: 'source-b',
      source_as_of: entry.source_as_of,
    }));
    const generation = evidence.makeGeneration({ families: familyEntries, records: recordsB });
    const pages = evidence.paginate({ ...generation, records: recordsB });
    const pointers = pages.map((page, index) => {
      const rel = `${agency}/${generation.version}/${family}-${index}.json`;
      mutated.set(rel, evidence.bytes(page.body));
      return {
        path: `/data/procurement_evidence/${agency}/${generation.version}/${family}-${index}.json`,
        sha256: page.sha256,
      };
    });
    const manifestB = {
      schema: 'cityscroll.procurement_evidence_manifest.v1',
      agency_id: agency,
      version: generation.version,
      families: {
        ...manifestA.families,
        [family]: {
          ...manifestA.families[family],
          total: recordsB.length,
          pages: pointers,
        },
      },
    };
    mutated.set(`${agency}/manifest.json`, evidence.bytes(manifestB));
    publishOutputs(mutated, { outDir, capabilitiesPath });

    const served = readJson(join(outDir, agency, 'manifest.json'));
    assert.equal(served.version, generation.version);
    assert.notEqual(served.version, versionA);
    assert.ok(existsSync(join(outDir, agency, versionA)), 'generation A remains for pinned readers');
    assert.equal(served.families[family].total, recordsB.length);

    const page0 = readJson(join(ROOT, 'site', 'data', 'procurement_evidence', agency, 'manifest.json'));
    assert.notEqual(
      page0.version,
      served.version,
      'local product assets stay on generation A while the engine tree advances to B',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
