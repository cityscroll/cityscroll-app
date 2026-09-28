/**
 * Retained 59-board coverage and authenticated Desk projection.
 *
 *   node --test test/connected_history_coverage.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONNECTED_HISTORY_COVERAGE_STAGES,
  buildConnectedHistoryCoverage,
  buildConnectedHistoryCoverageReceipt,
  verifyConnectedHistoryCoverage,
} from "../tools/connected_history_coverage.mjs";
import { loadConnectedHistoryCoverageInputs } from "../tools/build_connected_history_coverage.mjs";
import {
  CONNECTED_HISTORY_COVERAGE_EXTENSION_VERSION,
  JSON_OUTPUT,
  buildDataSourceGraph,
  generatedGraphFiles,
  renderGraphHtml,
} from "../tools/data_source_graph.mjs";
import { retainedMeasurementStatus } from "../tools/repository_revision.mjs";

const ROOT = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const INPUTS = loadConnectedHistoryCoverageInputs(ROOT);
const ARTIFACT = readJson("site/data/connected_history_coverage.json");
const RECEIPT = readJson("site/data/connected_history_sources/verification_receipts/connected_history_coverage_latest.json");
const MANIFEST = readJson("docs/evidence/connected-history-coverage/capture-manifest.json");
const CONTRACT = readJson("data/data-source-graph-desk-contract.v1.json");

function clone(value) {
  return structuredClone(value);
}

test("A1: baseline and post-change snapshots enumerate every canonical board and every stage", () => {
  assert.equal(ARTIFACT.population.canonical_boards, 59);
  for (const snapshot of Object.values(ARTIFACT.snapshots)) {
    assert.equal(snapshot.board_count, 59);
    assert.equal(snapshot.boards.length, 59);
    assert.equal(new Set(snapshot.boards.map((row) => row.board_id)).size, 59);
    assert.deepEqual(snapshot.boards.map((row) => row.board_id), [...snapshot.boards.map((row) => row.board_id)].sort());
    for (const row of snapshot.boards) {
      assert.deepEqual(Object.keys(row.stages), [...CONNECTED_HISTORY_COVERAGE_STAGES]);
      for (const stage of Object.values(row.stages)) {
        assert.match(stage.state, /^(observed|partial|measured_zero|unknown)$/);
        assert.ok(Number.isInteger(stage.unique_subjects) && stage.unique_subjects >= 0);
        assert.ok(Number.isInteger(stage.unknown_subjects) && stage.unknown_subjects >= 0);
        assert.match(stage.date_span.state, /^(observed|partial|unknown)$/);
      }
    }
  }
  assert.notDeepEqual(
    ARTIFACT.snapshots.baseline.citywide.stages,
    ARTIFACT.snapshots.post_change.citywide.stages,
    "the retained post-change snapshot must not be a relabelled baseline",
  );
  assert.equal(ARTIFACT.snapshots.post_change.citywide.admission_mode.manual, 0);
  assert.ok(ARTIFACT.snapshots.post_change.citywide.admission_mode.rule > 0);
});

test("A1: stage progression contains a real intermediate state and a converse mutation fails verification", () => {
  const row = ARTIFACT.snapshots.post_change.boards.find((candidate) => (
    candidate.stages.acquired.unique_subjects > candidate.stages.extractable.unique_subjects
    && candidate.stages.extractable.unique_subjects > candidate.stages.admitted.unique_subjects
  ));
  assert.ok(row, "at least one board is observed between acquisition, extraction, and admission");
  assert.ok(row.stages.acquired.date_span.subjects_with_dates > 0);

  for (const board of ARTIFACT.snapshots.post_change.boards) {
    const counts = CONNECTED_HISTORY_COVERAGE_STAGES.map((stage) => board.stages[stage].unique_subjects);
    assert.deepEqual(counts, [...counts].sort((left, right) => right - left), board.board_id);
  }

  const converse = clone(ARTIFACT);
  converse.snapshots.post_change.boards[0].stages.discoverable.unique_subjects =
    converse.snapshots.post_change.boards[0].stages.admitted.unique_subjects + 1;
  const result = verifyConnectedHistoryCoverage(converse, INPUTS);
  assert.equal(result.valid, false);
  assert.ok(result.findings.includes("snapshots"));
});

test("A2: multiboard histories count locally and once citywide without minting repair work", () => {
  const post = ARTIFACT.snapshots.post_change;
  for (const stage of ["admitted", "discoverable"]) {
    assert.ok(post.citywide.stages[stage].local_scope_subjects > post.citywide.stages[stage].unique_subjects);
  }
  for (const boardId of ["manhattan-cb-02", "manhattan-cb-04", "manhattan-cb-05"]) {
    const board = post.boards.find((row) => row.board_id === boardId);
    assert.ok(board.stages.discoverable.unique_subjects > 0, boardId);
  }
  assert.match(ARTIFACT.interpretation.missingness, /never the level of civic activity/);
  assert.ok(ARTIFACT.evaluation.post_change.unresolved_judgments.length > 0);
  assert.deepEqual(ARTIFACT.evaluation.contaminated_samples, []);
  assert.equal(ARTIFACT.repair_lineage.owner, "cityscroll.repair_queue.v1");
  assert.equal(ARTIFACT.repair_lineage.duplicate_repair_cards_created, 0);
  assert.deepEqual(ARTIFACT.repair_lineage.created_issue_keys, []);

  const withoutCoverage = buildDataSourceGraph({ registry: { contracts: [] }, inputs: [] });
  const withCoverage = buildDataSourceGraph({ registry: { contracts: [] }, connectedHistoryCoverage: ARTIFACT, inputs: [] });
  assert.deepEqual(withCoverage.repair_queue, withoutCoverage.repair_queue);
});

test("A3: held-out scores retain source judgment, limits, and zero-denominator honesty", () => {
  const evaluation = ARTIFACT.evaluation.post_change;
  assert.equal(evaluation.evidence_class, "module_oracle_over_frozen_source_judgments");
  assert.equal(evaluation.sample_denominator, INPUTS.cohort.judgments.length);
  assert.equal(evaluation.source_judgment.artifact, "site/data/connected_history_evaluation_cohort.json");
  assert.equal(evaluation.source_judgment.counts.insufficient_evidence, 98);
  for (const metric of [evaluation.precision, evaluation.recall]) {
    assert.equal(metric.numerator, 0);
    assert.equal(metric.denominator, 0);
    assert.equal(metric.status, "not_estimable");
    assert.ok(metric.limit);
  }
  assert.equal(evaluation.example_search_triggered, false);

  const noEligible = ARTIFACT.snapshots.post_change.boards.find((row) => row.sample.eligible_subjects === 0);
  assert.ok(noEligible);
  assert.equal(noEligible.sample.selected_subjects_local, 0);
  assert.ok(noEligible.unavailable_strata.length > 0);
});

test("A3: verifier and receipt derive failure for every protected field", () => {
  const clean = verifyConnectedHistoryCoverage(ARTIFACT, INPUTS);
  assert.equal(clean.valid, true);
  assert.equal(clean.state, "passed");
  assert.deepEqual(RECEIPT.verification, clean);
  assert.equal(RECEIPT.board_count, 59);

  for (const field of clean.protected_fields) {
    const tampered = clone(ARTIFACT);
    if (typeof tampered[field] === "string") tampered[field] = `${tampered[field]}-tampered`;
    else if (typeof tampered[field] === "number") tampered[field] += 1;
    else tampered[field] = { tampered: true };
    const result = verifyConnectedHistoryCoverage(tampered, INPUTS);
    assert.equal(result.valid, false, field);
    assert.equal(result.state, "failed", field);
    assert.ok(result.findings.includes(field), field);
    assert.equal(buildConnectedHistoryCoverageReceipt(tampered, INPUTS).verification.state, "failed", field);
  }
});

test("A3: the committed artifact is reproducible and the Desk contract carries it additively", () => {
  assert.deepEqual(buildConnectedHistoryCoverage(INPUTS), ARTIFACT);
  assert.equal(CONTRACT.extensions.connected_history_coverage.version, CONNECTED_HISTORY_COVERAGE_EXTENSION_VERSION);
  assert.deepEqual(CONTRACT.extensions.connected_history_coverage.stages, [...CONNECTED_HISTORY_COVERAGE_STAGES]);
  const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
  assert.equal(graph.extensions.connected_history_coverage, CONNECTED_HISTORY_COVERAGE_EXTENSION_VERSION);
  assert.deepEqual(graph.connected_history_coverage, ARTIFACT);
  const html = renderGraphHtml(graph);
  assert.match(html, /id="coverageToggle"/);
  assert.match(html, /id="historyCoverageView"/);
  assert.equal((html.match(/data-coverage-board=/g) || []).length, 59);
});

test("A3: retained Chromium measurements use named viewports and unchanged ancestor inputs", () => {
  assert.equal(MANIFEST.evidence_class, "runtime_browser_measurement");
  assert.equal(MANIFEST.image_binaries_committed, false);
  assert.equal(MANIFEST.production_measurement.state, "awaiting_landed_deploy");
  assert.match(MANIFEST.measurement_provenance.revision, /^[a-f0-9]{40}$/);
  assert.equal(MANIFEST.measurement_provenance.inputs.length, 4);

  const retained = retainedMeasurementStatus(ROOT, {
    revision: MANIFEST.measurement_provenance.revision,
    head: "HEAD",
    inputs: MANIFEST.measurement_provenance.inputs,
  });
  assert.equal(retained.ok, true, `${retained.reason}: ${retained.changedInputs.join(", ")}`);
  const captureTemp = mkdtempSync(join(tmpdir(), "connected-history-coverage-test-"));
  const env = { ...process.env, TMPDIR: captureTemp };
  delete env.FM_TASK_SCRATCH;
  try {
    const run = spawnSync(
      process.env.CITYSCROLL_BROWSER_PYTHON || "python3",
      ["tools/capture_connected_history_coverage.py"],
      { cwd: ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env },
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.browser, "Chromium");
    assert.equal(receipt.mode, "hermetic_fixture");
    assert.equal(receipt.capture_revision, receipt.repository_revision);
    assert.equal(receipt.capture_revision, MANIFEST.measurement_provenance.revision);
    assert.deepEqual(receipt.measured_inputs, MANIFEST.measurement_provenance.inputs);
    const observed = new Map(receipt.captures.map((row) => [row.case, row]));
    const retainedCaptures = new Map(MANIFEST.captures.map((row) => [row.case, row]));
    for (const [name, width, height] of [["narrow-touch", 390, 844], ["desktop-keyboard", 1440, 900]]) {
      const id = `coverage-${name}`;
      assert.deepEqual(observed.get(id).viewport, { name, width, height });
      assert.equal(observed.get(id).runtime.board_count, 59);
      assert.ok(observed.get(id).runtime.unknown_stage_cells > 0);
      assert.ok(observed.get(id).runtime.measured_zero_stage_cells > 0);
      assert.equal(observed.get(id).runtime.horizontal_page_overflow, false);
      assert.equal(observed.get(id).render_sha256, retainedCaptures.get(id).sha256);
    }
    assert.deepEqual(readdirSync(captureTemp), [], "browser measurement must clean temporary directories");
  } finally {
    rmSync(captureTemp, { recursive: true, force: true });
  }
});

test("A3: production read refuses an unpinned invocation at runtime", () => {
  const refusal = spawnSync(
    process.env.CITYSCROLL_BROWSER_PYTHON || "python3",
    ["tools/capture_connected_history_coverage.py", "--production"],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  );
  assert.notEqual(refusal.status, 0);
  assert.match(`${refusal.stderr}${refusal.stdout}`, /requires --landed-commit/);
});

test("A4: the bounded dossier and frozen retained inputs remain the only source population", () => {
  assert.equal(ARTIFACT.source_policy, "fixed-six-case-dossier-and-frozen-retained-inputs-only");
  assert.deepEqual(
    ARTIFACT.population.fixed_dossier_families,
    ["coyle", "franklin-avenue", "kingsbridge-armory", "sixth-avenue", "thirty-first-avenue", "lighthouse-point"],
  );
  assert.equal(ARTIFACT.evaluation.post_change.example_search_triggered, false);
  assert.ok(ARTIFACT.evaluation.post_change.unresolved_judgments.length > 0);
  assert.ok(ARTIFACT.snapshots.post_change.boards.some((row) => row.unavailable_strata.length > 0));
});
