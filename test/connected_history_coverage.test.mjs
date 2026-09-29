/**
 * Retained 59-board coverage and authenticated Desk projection.
 *
 *   node --test test/connected_history_coverage.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  assert.equal(MANIFEST.production_measurement.state, "measured");
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
    assert.deepEqual(receipt.measured_inputs, MANIFEST.measurement_provenance.inputs);
    const runtimeRetained = retainedMeasurementStatus(ROOT, {
      revision: MANIFEST.measurement_provenance.revision,
      head: receipt.capture_revision,
      inputs: MANIFEST.measurement_provenance.inputs,
    });
    assert.equal(
      runtimeRetained.ok,
      true,
      `${runtimeRetained.reason}: ${runtimeRetained.changedInputs.join(", ")}`,
    );
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

// The production read is exercised against the real guards with an in-process
// served origin and a throwaway repository whose default branch, a later
// default-branch commit, and an unmerged side commit are real git objects.
// Every refusal case is a single mutation of a control that must pass, so a
// case can only refuse for the reason it names.
const PRODUCTION_HARNESS = String.raw`
import json, os, subprocess, sys, tempfile
from pathlib import Path

for key in [key for key in os.environ if key.startswith("GIT_")]:
    del os.environ[key]
ROOT = Path(sys.argv[1])
sys.path.insert(0, str(ROOT / "tools"))
import capture_connected_history_coverage as capture

request = json.loads(sys.argv[2])
for name in request.get("neuter", []):
    setattr(capture, name, lambda *args, **kwargs: None)

repo = tempfile.mkdtemp(prefix="coverage-production-refusals-")

def git(*args):
    return subprocess.run(
        ["git", "-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()

try:
    git("init", "-q", "-b", "main")
    git("commit", "-q", "--allow-empty", "-m", "landed")
    landed = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "later")
    later = git("rev-parse", "HEAD")
    git("checkout", "-q", "-b", "side", landed)
    git("commit", "-q", "--allow-empty", "-m", "unmerged")
    side = git("rev-parse", "HEAD")
    git("checkout", "-q", "main")
    census = json.loads((ROOT / "site/data/connected_history_coverage.json").read_text(encoding="utf-8"))
    canonical = capture.canonical_board_ids(ROOT)

    def run(case):
        pin, start, end = landed, landed, landed
        payload = json.loads(json.dumps(census))
        coverage_type, coverage_body = "application/json", None
        rays = None
        if case == "non_main_pin":
            pin = side
        elif case == "served_revision_lacks_landed_commit":
            pin = later
        elif case == "absent_served_data":
            coverage_type, coverage_body = "text/html; charset=utf-8", b"<!doctype html><title>CityScroll</title>"
        elif case == "incomplete_board_enumeration":
            payload["snapshots"]["post_change"]["boards"].pop(17)
        elif case == "zero_denominator_score":
            precision = payload["evaluation"]["post_change"]["precision"]
            precision["status"], precision["value"] = "estimated", 0.0
        elif case == "revision_changed_during_read":
            end = later
        elif case == "missing_edge_receipt":
            rays = ["fixture-ray-1", None, "fixture-ray-3"]
        elif case == "repeated_edge_receipt":
            rays = ["fixture-ray-1", "fixture-ray-1", "fixture-ray-1"]
        elif case != "control":
            raise SystemExit(f"unknown case {case}")
        body = coverage_body if coverage_body is not None else json.dumps(payload).encode("utf-8")
        answers = [
            ("application/json", json.dumps({"source_commit_sha": start}).encode("utf-8")),
            (coverage_type, body),
            ("application/json", json.dumps({"source_commit_sha": end}).encode("utf-8")),
        ]
        served = []

        def get(url):
            index = len(served)
            content_type, answer = answers[index]
            served.append(url)
            ray = rays[index] if rays else f"fixture-ray-{index + 1}"
            headers = {"Content-Type": content_type, "Date": "Mon, 28 Sep 2026 12:00:00 GMT"}
            if ray:
                headers["CF-Ray"] = ray
            return {"status": 200, "headers": headers, "body": answer}

        try:
            read = capture.production_read(
                "https://cityscroll.org", pin, get=get, cwd=Path(repo), main_ref="main", canonical_ids=canonical,
            )
        except Exception as error:
            return {"refused": True, "error_type": type(error).__name__, "message": str(error)}
        return {
            "refused": False,
            "board_count": read["observed"]["board_count"],
            "revision_pin": read["revision_pin"]["state"],
            "receipt_rays": [receipt["edge_ray"] for receipt in read["request_receipts"]],
        }

    print(json.dumps({case: run(case) for case in request["cases"]}))
finally:
    subprocess.run(["rm", "-rf", repo], check=False)
`;

const DECLARED_REFUSALS = Object.freeze({
  non_main_pin: { type: "WrongPinError", message: /is not reachable from the default branch/ },
  served_revision_lacks_landed_commit: { type: "DeployPendingError", message: /does not contain required ancestor/ },
  absent_served_data: { type: "ServedDataMissingError", message: /served coverage is absent at .*text\/html/ },
  incomplete_board_enumeration: { type: "ServedDataMissingError", message: /board enumeration is incomplete: 58 boards, expected 59/ },
  zero_denominator_score: { type: "ServedDataMissingError", message: /precision converts a zero denominator into a score/ },
});
const READ_INTEGRITY_REFUSALS = Object.freeze({
  revision_changed_during_read: { type: "ServedRevisionChangedError", message: /served revision changed during the production read/ },
  missing_edge_receipt: { type: "RequestReceiptError", message: /coverage_census lacks its own edge receipt/ },
  repeated_edge_receipt: { type: "RequestReceiptError", message: /repeat an edge ray identifier across requests/ },
});
const ALL_REFUSALS = Object.freeze({ ...DECLARED_REFUSALS, ...READ_INTEGRITY_REFUSALS });

function runProductionHarness(cases, neuter = []) {
  const scratch = mkdtempSync(join(tmpdir(), "connected-history-coverage-refusals-"));
  const env = { ...process.env, TMPDIR: scratch };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  try {
    const run = spawnSync(
      process.env.CITYSCROLL_BROWSER_PYTHON || "python3",
      ["-c", PRODUCTION_HARNESS, ROOT, JSON.stringify({ cases, neuter })],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env },
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.deepEqual(readdirSync(scratch), [], "refusal harness must clean its temporary repository");
    return JSON.parse(run.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function assertRefusedFor(outcome, name) {
  const expected = ALL_REFUSALS[name];
  assert.equal(outcome.refused, true, `${name} must refuse; the read completed instead: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.error_type, expected.type, `${name}: ${outcome.message}`);
  assert.match(outcome.message, expected.message, name);
  for (const [other, pattern] of Object.entries(ALL_REFUSALS)) {
    if (other !== name) assert.doesNotMatch(outcome.message, pattern.message, `${name} message is distinct from ${other}`);
  }
}

test("A5: the production read control completes over all 59 served boards with exact pins", () => {
  const { control } = runProductionHarness(["control"]);
  assert.equal(control.refused, false, JSON.stringify(control));
  assert.equal(control.board_count, 59);
  assert.equal(control.revision_pin, "exact");
  assert.deepEqual(control.receipt_rays, ["fixture-ray-1", "fixture-ray-2", "fixture-ray-3"]);
});

for (const name of Object.keys(ALL_REFUSALS)) {
  test(`A5: production read refuses ${name.replaceAll("_", " ")}`, () => {
    assertRefusedFor(runProductionHarness([name])[name], name);
  });
}

test("A5: neutering one refusal fails exactly its own case", () => {
  const mutations = {
    require_served_coverage_present: "absent_served_data",
    require_board_enumeration: "incomplete_board_enumeration",
    require_estimable_scores: "zero_denominator_score",
  };
  const cases = ["control", ...Object.keys(ALL_REFUSALS)];
  for (const [guard, ownCase] of Object.entries(mutations)) {
    const outcomes = runProductionHarness(cases, [guard]);
    const failing = cases.filter((name) => {
      if (name === "control") return outcomes.control.refused;
      try {
        assertRefusedFor(outcomes[name], name);
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(failing, [ownCase], `neutering ${guard}`);
  }
});

test("A5: the retained production read observed the served origin at the landed revision", () => {
  const production = MANIFEST.production_measurement;
  assert.equal(production.state, "measured");
  const receipt = production.run_receipt;
  assert.equal(receipt.schema, "cityscroll.connected_history_coverage_production_read.v1");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.equal(receipt.origin, "https://cityscroll.org");
  assert.equal(receipt.image_binaries_committed, false);
  assert.equal(
    production.run_receipt_sha256,
    createHash("sha256").update(JSON.stringify(sortKeys(receipt))).digest("hex"),
  );
  assert.equal(production.runner, `python3 tools/capture_connected_history_coverage.py --production --landed-commit ${receipt.required_landed_commit} --write-manifest`);

  // Pin equality: the landed commit, the served revision before the census,
  // and the served revision after it are one commit.
  assert.match(receipt.required_landed_commit, /^[a-f0-9]{40}$/);
  assert.equal(receipt.served_revision, receipt.required_landed_commit);
  assert.equal(receipt.served_revision_after, receipt.required_landed_commit);
  assert.deepEqual(receipt.revision_pin, {
    state: "exact",
    required_landed_commit: receipt.required_landed_commit,
    served_revision_start: receipt.served_revision,
    served_revision_end: receipt.served_revision_after,
  });
  const served = spawnSync("git", ["cat-file", "-e", `${receipt.served_revision}^{commit}`], { cwd: ROOT });
  if (served.status === 0) {
    assert.equal(
      spawnSync("git", ["merge-base", "--is-ancestor", receipt.served_revision, "HEAD"], { cwd: ROOT }).status,
      0,
      "the measured served revision is an ancestor of this checkout",
    );
  }

  // Each served fetch keeps its own edge receipt.
  assert.deepEqual(
    receipt.request_receipts.map((entry) => [entry.request, new URL(entry.url).pathname]),
    [
      ["served_revision_start", "/artifact-manifest.json"],
      ["coverage_census", "/data/connected_history_coverage.json"],
      ["served_revision_end", "/artifact-manifest.json"],
    ],
  );
  for (const entry of receipt.request_receipts) {
    assert.equal(entry.http_status, 200, entry.request);
    assert.match(entry.edge_ray, /^[0-9a-f]{16}-[A-Z]{3}$/, entry.request);
    assert.equal(entry.headers["CF-Ray"], entry.edge_ray, entry.request);
    assert.match(entry.observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, entry.request);
    assert.ok(entry.headers.Date, entry.request);
    assert.equal(entry.headers["CF-Cache-Status"], "DYNAMIC", entry.request);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, entry.request);
  }
  assert.equal(new Set(receipt.request_receipts.map((entry) => entry.edge_ray)).size, 3);
  assert.equal(new Set(receipt.request_receipts.map((entry) => entry.observed_at)).size, 3);

  // The served census is the repository census at the served revision.
  const census = receipt.served_census;
  const censusReceipt = receipt.request_receipts.find((entry) => entry.request === "coverage_census");
  assert.equal(census.sha256, censusReceipt.sha256);
  assert.equal(census.bytes, censusReceipt.bytes);
  assert.equal(census.repository_path, "site/data/connected_history_coverage.json");
  assert.equal(census.repository_sha256_at_served_revision, census.sha256);
  assert.equal(census.byte_identical_to_repository, true);
  assert.deepEqual(census.data_vintage, ARTIFACT.input_vintages);

  // Every canonical board, enumerated from the served artifact.
  const observed = receipt.observed;
  const registry = readJson("site/data/community_board_constellation_lookup.json");
  assert.equal(observed.board_count, 59);
  assert.equal(observed.board_ids.length, 59);
  assert.deepEqual(observed.board_ids, Object.keys(registry.by_id).sort());

  // The reader reports absence, not only success.
  const absences = observed.absences;
  assert.equal(absences.negative_observation_count, absences.observations.length);
  assert.ok(absences.negative_observation_count > 0);
  for (const row of absences.observations) {
    assert.equal(row.board_count, row.board_ids.length, row.kind);
    assert.ok(row.board_ids.every((id) => observed.board_ids.includes(id)), row.kind);
  }
  const servedBoards = new Map(ARTIFACT.snapshots.post_change.boards.map((row) => [row.board_id, row]));
  const stratum = absences.observations.find((row) => row.kind === "unavailable_stratum");
  assert.ok(stratum, "at least one stratum the served census does not supply");
  for (const id of stratum.board_ids) assert.ok(servedBoards.get(id).unavailable_strata.includes(stratum.stratum), id);
  const unknown = absences.observations.find((row) => row.kind === "unknown_stage");
  assert.ok(unknown, "at least one board stage the served census cannot report");
  for (const id of unknown.board_ids) assert.equal(servedBoards.get(id).stages[unknown.stage].state, "unknown", id);

  // Held-out scores stay not estimable on the served path.
  for (const name of ["precision", "recall"]) {
    const metric = observed[name];
    assert.equal(metric.status, "not_estimable", name);
    assert.equal(metric.numerator, 0, name);
    assert.equal(metric.denominator, 0, name);
    assert.ok(metric.limit, name);
    assert.equal(metric.value, undefined, name);
    assert.deepEqual(metric, ARTIFACT.evaluation.post_change[name], name);
  }
  assert.deepEqual(observed.source_judgment, ARTIFACT.evaluation.post_change.source_judgment);
  assert.equal(observed.sample_denominator, ARTIFACT.evaluation.post_change.sample_denominator);

  // The production read was taken from a checkout whose retained inputs are unchanged.
  assert.equal(receipt.retained_measurement.revision, MANIFEST.measurement_provenance.revision);
  assert.equal(receipt.retained_measurement.inputs_ref, "#/measurement_provenance/inputs");
  const productionStatus = retainedMeasurementStatus(ROOT, {
    revision: receipt.repository_revision,
    head: "HEAD",
    inputs: MANIFEST.measurement_provenance.inputs,
  });
  assert.equal(productionStatus.ok, true, `${productionStatus.reason}: ${productionStatus.changedInputs.join(", ")}`);
  assert.doesNotMatch(JSON.stringify(receipt), /(?:\/Users\/|\/private\/|\/tmp\/|local_path)/);
});

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
