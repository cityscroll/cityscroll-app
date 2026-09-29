import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CONNECTED_HISTORY_CYCLE,
  CONNECTED_HISTORY_MATERIALIZATIONS,
  checkConnectedHistoryCycleDeclaration,
  connectedHistoryCyclePublishedPaths,
  cronMaximumGapHours,
  documentContentFingerprint,
  evidenceInvalidatedBy,
  materializeConnectedHistories,
  parseWorkflowTriggers,
  retainedEvidencePins,
  runConnectedHistoryCycle,
  verifyConnectedHistoryCycleReceipt,
} from "../tools/lib/connected_history_cycle.mjs";
import {
  CONNECTED_HISTORY_DOCUMENT_SOURCES,
  acquireConnectedHistoryDocuments,
} from "../tools/lib/connected_history_documents.mjs";
import {
  SCHEDULED_PUBLICATION_WORKFLOWS,
  SCHEDULED_READBACK_WINDOW_DAYS,
} from "../tools/lib/connected_history_release.mjs";
import { isExcludedFromPublicSite, readPublicSiteConfig } from "../tools/lib/public_site_payload.mjs";
import { createFixtureHttpGet } from "./fixtures/connected_history_documents/http_fixture_map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(ROOT, CONNECTED_HISTORY_CYCLE.workflow), "utf8");
const T0 = "2026-09-21T20:00:00.000Z";
const SERVED = Object.freeze({ status: "observed", origin: "https://example.test", revision: "a".repeat(40) });

const DETAILS = CONNECTED_HISTORY_DOCUMENT_SOURCES.find((source) => source.source_id === "kingsbridge-ceqr-25dme006x-details");
const PAGE = CONNECTED_HISTORY_DOCUMENT_SOURCES.find((source) => source.source_id === "kingsbridge-ceqr-13dme013x-page");
const DETAILS_BODY = readFileSync(join(ROOT, "test/fixtures/connected_history_documents/ceqr_25dme006x_details.html"), "utf8");
const DOCUMENTS_PATH = CONNECTED_HISTORY_MATERIALIZATIONS.find((entry) => entry.id === "documents").path;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function writeText(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function htmlOverride(url, body) {
  return { [url]: { status: 200, bytes: Buffer.from(body), contentType: "text/html" } };
}

const revise = (body) => body.replace("CEQR Access details page", "Revised CEQR Access details page");

/** The details page carrying per-response form state, script and a hidden frame. */
function detailsWithState(state, { revised = false } = {}) {
  const body = DETAILS_BODY.replace(
    "<body>",
    `<body>\n  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${state}" />\n  <script>var boot = "${state}";</script>\n  <iframe style='display:none;' width='1' height='1' src='https://auth.example/?data=${state}'></iframe>`,
  );
  return revised ? revise(body) : body;
}

/**
 * A repository root holding a committed connected-history family built from
 * the offline dossier fixture, so a cycle can run without the network and
 * without touching tracked files.
 */
async function fixtureRoot(t, { overrides = {}, evidenceInputs = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "connected-history-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { artifact, receipt } = await acquireConnectedHistoryDocuments({
    httpGet: createFixtureHttpGet(overrides),
    observedAt: T0,
    runMode: "live",
  });
  const cohortEntry = CONNECTED_HISTORY_MATERIALIZATIONS.find((entry) => entry.id === "cohort");
  const cohort = JSON.parse(readFileSync(join(ROOT, cohortEntry.path), "utf8"));
  writeText(root, cohortEntry.path, readFileSync(join(ROOT, cohortEntry.path), "utf8"));
  writeText(root, cohortEntry.receipt, readFileSync(join(ROOT, cohortEntry.receipt), "utf8"));
  const materialized = materializeConnectedHistories({ cohort, documents: artifact, documentsReceipt: receipt });
  for (const entry of CONNECTED_HISTORY_MATERIALIZATIONS.filter((item) => item.mode !== "frozen_baseline")) {
    writeText(root, entry.path, serialize(materialized[entry.id].artifact));
    writeText(root, entry.receipt, serialize(materialized[entry.id].receipt));
  }
  if (evidenceInputs) {
    writeText(root, "docs/evidence/pinned-history/capture-manifest.json", serialize({
      measurement_provenance: {
        revision: "b".repeat(40),
        inputs: evidenceInputs.map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) })),
      },
    }));
  }
  return root;
}

function historySnapshot(root) {
  return Object.fromEntries(connectedHistoryCyclePublishedPaths()
    .filter((path) => path !== CONNECTED_HISTORY_CYCLE.receipt_path)
    .map((path) => [path, existsSync(join(root, path)) ? sha256(readFileSync(join(root, path))) : null]));
}

function readReceipt(root) {
  return JSON.parse(readFileSync(join(root, CONNECTED_HISTORY_CYCLE.receipt_path), "utf8"));
}

function runCycle(root, { at, overrides = {}, ...options }) {
  let tick = 0;
  const base = Date.parse(at);
  return runConnectedHistoryCycle({
    root,
    httpGet: createFixtureHttpGet(overrides),
    now: () => new Date(base + (tick++) * 1000).toISOString(),
    observeServed: async () => ({ ...SERVED, deployment_at: at }),
    run: { run_id: `test:${at}`, trigger: "schedule" },
    ...options,
  });
}

function comparisonOf(receipt, sourceId) {
  return receipt.acquisition.documents.sources.find((row) => row.source_id === sourceId)?.comparison;
}

function shellGlob(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

test("the cycle is declared as a scheduled workflow with its cadence, and a described schedule does not count", () => {
  const declared = checkConnectedHistoryCycleDeclaration(WORKFLOW);
  assert.deepEqual(declared.errors, []);
  assert.deepEqual(declared.triggers.schedules, [CONNECTED_HISTORY_CYCLE.schedule]);
  assert.equal(declared.triggers.workflow_dispatch, true, "a first run can be started by hand");
  assert.equal(cronMaximumGapHours(CONNECTED_HISTORY_CYCLE.schedule), CONNECTED_HISTORY_CYCLE.cadence_hours);
  assert.ok(CONNECTED_HISTORY_CYCLE.cadence_hours <= SCHEDULED_READBACK_WINDOW_DAYS * 24, "a cycle always falls inside the read-back window");

  // Positive controls: each way the declaration can decay is caught.
  const commented = WORKFLOW.replace(/^(\s*)- cron: .*$/m, "$1# - cron: \"13 7 * * *\"");
  assert.match(checkConnectedHistoryCycleDeclaration(commented).errors.join(), /declares no schedule/);
  assert.match(checkConnectedHistoryCycleDeclaration(WORKFLOW.replace("13 7 * * *", "13 8 * * *")).errors.join(), /does not include/);
  assert.match(checkConnectedHistoryCycleDeclaration(WORKFLOW.replace("13 7 * * *", "13 7 * * 1")).errors.join(), /more than 24 hours/);
  assert.match(checkConnectedHistoryCycleDeclaration(WORKFLOW.replace(CONNECTED_HISTORY_CYCLE.command, "node tools/other.mjs")).errors.join(), /no workflow step runs/);
  assert.match(checkConnectedHistoryCycleDeclaration(WORKFLOW.replace(/^\s+workflow_dispatch:\s*$/m, "")).errors.join(), /started by hand/);
  assert.deepEqual(parseWorkflowTriggers("name: x\n# on:\n#   schedule:\n#     - cron: \"1 1 * * *\"\n").schedules, []);
  assert.equal(cronMaximumGapHours("0 */6 * * *"), 6);
  assert.equal(cronMaximumGapHours("30 7 * * 1,4"), 96);

  const cli = spawnSync(process.execPath, ["tools/connected_history_cycle.mjs", "--check-declaration"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /13 7 \* \* \*/);
});

test("the release read-back observes this cycle and no other workflow", () => {
  assert.deepEqual(SCHEDULED_PUBLICATION_WORKFLOWS.map((entry) => ({
    workflow: entry.workflow,
    cron: entry.cron,
    branch: entry.branch("2026-10-01T07:13:00Z"),
    served_receipt: entry.served_receipt,
  })), [{
    workflow: CONNECTED_HISTORY_CYCLE.workflow_file,
    cron: CONNECTED_HISTORY_CYCLE.schedule,
    branch: CONNECTED_HISTORY_CYCLE.publication.branch,
    served_receipt: CONNECTED_HISTORY_CYCLE.served_path,
  }]);
  assert.ok(WORKFLOW.includes(`branch: ${CONNECTED_HISTORY_CYCLE.publication.branch}`));
});

test("the receipt is served from a stable path and the workflow publishes exactly the cycle's paths", () => {
  assert.equal(CONNECTED_HISTORY_CYCLE.served_path, `/${CONNECTED_HISTORY_CYCLE.receipt_path.replace(/^site\//, "")}`);
  const { excluded } = readPublicSiteConfig(join(ROOT, "site"));
  assert.equal(isExcludedFromPublicSite(CONNECTED_HISTORY_CYCLE.receipt_path.replace(/^site\//, ""), excluded), false);

  const addPaths = WORKFLOW.match(/add-paths: \|\n((?: {12}\S.*\n)+)/)[1].trim().split(/\n\s*/);
  const guarded = [...WORKFLOW.matchAll(/^ {14}(site\/\S+)\) ;;$/gm)].map((match) => match[1]);
  assert.ok(addPaths.length && guarded.length);
  for (const path of connectedHistoryCyclePublishedPaths()) {
    assert.ok(addPaths.some((pattern) => shellGlob(pattern).test(path)), `${path} is carried by the pull request`);
    assert.ok(guarded.some((pattern) => shellGlob(pattern).test(path)), `${path} passes the generated-change guard`);
  }
  for (const pattern of [...addPaths, ...guarded]) assert.match(pattern, /^site\/data\/connected_history_/);
});

test("an idempotent run emits a receipt, changes no served history byte, and is distinguishable from no run", async (t) => {
  const root = await fixtureRoot(t);
  const before = historySnapshot(root);
  assert.equal(existsSync(join(root, CONNECTED_HISTORY_CYCLE.receipt_path)), false);

  const first = await runCycle(root, { at: "2026-10-01T07:13:00.000Z" });
  assert.equal(first.exitCode, 0);
  const receipt = readReceipt(root);
  assert.deepEqual(receipt, JSON.parse(serialize(first.receipt)));
  assert.deepEqual(historySnapshot(root), before, "byte-identical outputs");
  assert.equal(receipt.run.outcome, "unchanged");
  assert.equal(receipt.publication.decision, "unchanged");
  assert.deepEqual(receipt.publication.changed_paths, []);
  assert.deepEqual(verifyConnectedHistoryCycleReceipt(receipt), { valid: true, errors: [] });
  assert.equal(receipt.run.served.revision, SERVED.revision, "the served revision it ran against");
  assert.ok(receipt.run.started_at < receipt.run.finished_at);
  assert.deepEqual(receipt.stages.map((entry) => [entry.stage, entry.status]), [
    ["acquisition", "succeeded"],
    ["materialization", "succeeded"],
    ["publication", "succeeded"],
    ["verification", "succeeded"],
  ]);

  // Inputs with their sources and digests, and what was materialized.
  const { documents } = receipt.acquisition;
  assert.equal(documents.sources.length, CONNECTED_HISTORY_DOCUMENT_SOURCES.length);
  assert.ok(documents.sources.every((row) => row.comparison === "unchanged"));
  assert.ok(documents.requests.length > 0);
  assert.ok(documents.requests.filter((row) => row.http_status === 200).every((row) => /^sha256:[0-9a-f]{64}$/.test(row.content_hash)));
  assert.ok(receipt.acquisition.retained_inputs.length > 0);
  assert.deepEqual(receipt.materialization.map((record) => record.id), CONNECTED_HISTORY_MATERIALIZATIONS.map((entry) => entry.id));
  for (const record of receipt.materialization) {
    assert.equal(record.byte_identical, true, record.id);
    assert.equal(record.materialized_sha256, `sha256:${before[record.path]}`, record.id);
    assert.equal(record.confirmed_current_at, receipt.run.finished_at, record.id);
  }

  // A second idempotent run still leaves a new receipt, and it names the first.
  const second = await runCycle(root, { at: "2026-10-02T07:13:00.000Z" });
  assert.equal(second.receipt.run.outcome, "unchanged");
  assert.notEqual(second.receipt.run.run_id, receipt.run.run_id);
  assert.deepEqual(historySnapshot(root), before);
  assert.equal(second.receipt.prior_runs[0].run_id, receipt.run.run_id);
  assert.equal(second.receipt.prior_runs[0].receipt_sha256, `sha256:${sha256(serialize(receipt))}`);
});

test("per-response markup is not a change, and the recorded fingerprint makes the next run exact", async (t) => {
  const root = await fixtureRoot(t, { overrides: htmlOverride(DETAILS.url, detailsWithState("state-one")) });
  const before = historySnapshot(root);

  const first = await runCycle(root, { at: "2026-10-01T07:13:00.000Z", overrides: htmlOverride(DETAILS.url, detailsWithState("state-two")) });
  assert.equal(comparisonOf(first.receipt, DETAILS.source_id), "reconfirmed");
  assert.equal(first.receipt.run.outcome, "unchanged");
  assert.deepEqual(historySnapshot(root), before);
  const row = first.receipt.acquisition.documents.sources.find((entry) => entry.source_id === DETAILS.source_id);
  assert.equal(row.committed_content_fingerprint, documentContentFingerprint(Buffer.from(detailsWithState("state-two")), "text/html").fingerprint);

  const second = await runCycle(root, { at: "2026-10-02T07:13:00.000Z", overrides: htmlOverride(DETAILS.url, detailsWithState("state-three")) });
  assert.equal(comparisonOf(second.receipt, DETAILS.source_id), "unchanged");
  assert.match(second.receipt.acquisition.documents.sources.find((entry) => entry.source_id === DETAILS.source_id).basis, /baseline/);

  // Revised document text under fresh per-response markup is a change, and with
  // no retained measurement pinning it the change is published.
  const third = await runCycle(root, {
    at: "2026-10-03T07:13:00.000Z",
    overrides: htmlOverride(DETAILS.url, detailsWithState("state-four", { revised: true })),
  });
  assert.equal(comparisonOf(third.receipt, DETAILS.source_id), "changed");
  assert.equal(third.receipt.run.outcome, "published");
  const published = JSON.parse(readFileSync(join(root, DOCUMENTS_PATH), "utf8"));
  assert.equal(published.generated_at, third.receipt.run.started_at, "the published stamp advances with the acquisition");
  assert.ok(third.receipt.publication.written_paths.includes(DOCUMENTS_PATH));
  assert.deepEqual(verifyConnectedHistoryCycleReceipt(third.receipt).errors, []);
  const documentsRecord = third.receipt.materialization.find((record) => record.id === "documents");
  assert.equal(documentsRecord.byte_identical, false);
  assert.equal(documentsRecord.generated_at.materialized, third.receipt.run.started_at);
  assert.equal(documentsRecord.materialized_sha256, `sha256:${sha256(readFileSync(join(root, DOCUMENTS_PATH)))}`);
});

test("a change pinned by a retained measurement is held, named, and kept out of the served tree", async (t) => {
  const root = await fixtureRoot(t, { evidenceInputs: [DOCUMENTS_PATH] });
  const before = historySnapshot(root);
  const heldDir = mkdtempSync(join(tmpdir(), "connected-history-held-"));
  t.after(() => rmSync(heldDir, { recursive: true, force: true }));

  const { receipt, exitCode } = await runCycle(root, {
    at: "2026-10-01T07:13:00.000Z",
    overrides: htmlOverride(DETAILS.url, revise(DETAILS_BODY)),
    heldDir,
  });
  assert.equal(exitCode, 0);
  assert.equal(comparisonOf(receipt, DETAILS.source_id), "changed");
  assert.equal(receipt.run.outcome, "held");
  assert.deepEqual(historySnapshot(root), before, "the served bytes did not change");
  assert.deepEqual(receipt.publication.invalidated_evidence.map((entry) => [entry.path, entry.inputs_changed]), [
    ["docs/evidence/pinned-history/capture-manifest.json", [DOCUMENTS_PATH]],
  ]);
  assert.match(receipt.publication.reason, /retained production measurements/);
  assert.ok(existsSync(join(heldDir, DOCUMENTS_PATH)), "the held materialization is kept with the run");
  assert.deepEqual(verifyConnectedHistoryCycleReceipt(receipt).errors, []);
});

test("a committed observation that cannot be re-fetched keeps its last-known-good record", async (t) => {
  const root = await fixtureRoot(t);
  const before = historySnapshot(root);
  const unavailable = { [PAGE.url]: { status: 503, bytes: Buffer.from("unavailable"), contentType: "text/plain" } };

  const quiet = await runCycle(root, { at: "2026-10-01T07:13:00.000Z", overrides: unavailable });
  assert.equal(comparisonOf(quiet.receipt, PAGE.source_id), "reobservation_failed");
  assert.equal(quiet.receipt.run.outcome, "unchanged");
  assert.deepEqual(historySnapshot(root), before);

  // Beside a real change, a failed re-fetch holds the whole publication.
  const mixed = await runCycle(root, {
    at: "2026-10-02T07:13:00.000Z",
    overrides: { ...unavailable, ...htmlOverride(DETAILS.url, revise(DETAILS_BODY)) },
  });
  assert.equal(comparisonOf(mixed.receipt, DETAILS.source_id), "changed");
  assert.equal(mixed.receipt.run.outcome, "held");
  assert.deepEqual(mixed.receipt.publication.reobservation_failures, [PAGE.source_id]);
  assert.deepEqual(historySnapshot(root), before);
});

test("a stage that fails still emits a receipt naming the stage and what had been acquired", async (t) => {
  const root = await fixtureRoot(t);
  const before = historySnapshot(root);

  const acquisition = await runCycle(root, {
    at: "2026-10-01T07:13:00.000Z",
    acquireDocuments: async ({ httpGet }) => {
      await httpGet(PAGE.url);
      await httpGet(DETAILS.url);
      throw new Error("publisher connection reset");
    },
  });
  assert.equal(acquisition.exitCode, 1);
  const failed = readReceipt(root);
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.outcome, "failed");
  assert.equal(failed.run.failed_stage, "acquisition");
  assert.match(failed.run.error, /publisher connection reset/);
  assert.deepEqual(failed.acquisition.documents.requests.map((row) => row.url), [PAGE.url, DETAILS.url]);
  assert.ok(failed.acquisition.documents.requests.every((row) => /^sha256:/.test(row.content_hash)));
  assert.equal(failed.publication.decision, "not_published");
  assert.deepEqual(historySnapshot(root), before);
  assert.deepEqual(verifyConnectedHistoryCycleReceipt(failed).errors, []);

  // A materialization that cannot be verified fails its stage after acquisition.
  const materialization = await runCycle(root, {
    at: "2026-10-02T07:13:00.000Z",
    acquireDocuments: async ({ httpGet, observedAt }) => {
      const acquired = await acquireConnectedHistoryDocuments({ httpGet, observedAt, runMode: "live" });
      const row = acquired.artifact.observations.find((entry) => entry.retained);
      row.title = `${row.title} (revised)`;
      delete row.request_receipt;
      return acquired;
    },
  });
  assert.equal(materialization.exitCode, 1);
  assert.equal(materialization.receipt.run.failed_stage, "materialization");
  assert.ok(materialization.receipt.acquisition.documents.sources.length > 0, "the acquisition is recorded");
  assert.equal(materialization.receipt.prior_runs[0].outcome, "failed", "the failed run stays in the ledger");
  assert.deepEqual(historySnapshot(root), before);

  // A published change whose builders' checks fail is rolled back.
  const verification = await runCycle(root, {
    at: "2026-10-03T07:13:00.000Z",
    overrides: htmlOverride(DETAILS.url, revise(DETAILS_BODY)),
    verifyPublished: async () => ["tools/build_connected_history_documents.mjs: stale"],
  });
  assert.equal(verification.exitCode, 1);
  assert.equal(verification.receipt.run.failed_stage, "verification");
  assert.equal(verification.receipt.publication.decision, "not_published");
  assert.equal(verification.receipt.publication.derived_decision, "published");
  assert.deepEqual(verification.receipt.publication.written_paths, []);
  assert.deepEqual(historySnapshot(root), before, "the committed bytes are restored");
  assert.deepEqual(verifyConnectedHistoryCycleReceipt(verification.receipt).errors, []);
});

test("statuses in a receipt are re-derived from its facts, never taken as stated", async (t) => {
  const root = await fixtureRoot(t);
  const { receipt } = await runCycle(root, { at: "2026-10-01T07:13:00.000Z" });
  const tamper = (edit) => {
    const copy = structuredClone(receipt);
    edit(copy);
    return verifyConnectedHistoryCycleReceipt(copy).errors;
  };
  assert.deepEqual(tamper(() => {}), []);
  assert.ok(tamper((copy) => { copy.materialization[2].materialized_sha256 = "sha256:0"; }).includes("decision"));
  assert.ok(tamper((copy) => { copy.run.outcome = "published"; copy.publication.decision = "published"; }).includes("decision"));
  assert.ok(tamper((copy) => { copy.stages[1].status = "failed"; }).includes("status"));
  assert.ok(tamper((copy) => { copy.publication.written_paths = [DOCUMENTS_PATH]; }).includes("unpublished_writes"));
  assert.ok(tamper((copy) => { copy.materialization.pop(); }).includes("materialization_coverage"));
  const failedCopy = structuredClone(receipt);
  failedCopy.stages[3].status = "failed";
  failedCopy.run.status = "failed";
  failedCopy.run.outcome = "failed";
  failedCopy.run.failed_stage = "verification";
  assert.ok(verifyConnectedHistoryCycleReceipt(failedCopy).errors.includes("failed_run_published"), "a failed run cannot read as published");
});

function importClosure(entries) {
  const seen = new Set();
  const queue = entries.map((entry) => resolve(ROOT, entry));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const target = resolve(dirname(file), match[1] || match[2]);
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].map((file) => relative(ROOT, file));
}

test("rebuilding from committed inputs, as a deploy or a builder does, emits no cycle receipt", (t) => {
  // Negative control: the owning builders rebuild every non-acquired history
  // artifact from committed inputs in an isolated copy, and no receipt appears.
  const rebuilders = CONNECTED_HISTORY_MATERIALIZATIONS
    .filter((entry) => ["fixed_dossier", "derived"].includes(entry.mode))
    .map((entry) => entry.builder);
  const closure = importClosure(rebuilders);
  assert.ok(!closure.some((path) => path.includes("connected_history_cycle")), "no builder reaches the cycle");
  const copy = mkdtempSync(join(tmpdir(), "connected-history-rebuild-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const inputs = CONNECTED_HISTORY_MATERIALIZATIONS.flatMap((entry) => [entry.path, entry.receipt]);
  for (const path of [...closure, ...inputs]) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(copy, path));
  }
  for (const builder of rebuilders) {
    const run = spawnSync(process.execPath, [builder], { cwd: copy, encoding: "utf8" });
    assert.equal(run.status, 0, `${builder}: ${run.stderr}`);
  }
  assert.equal(existsSync(join(copy, CONNECTED_HISTORY_CYCLE.receipt_path)), false);
  assert.deepEqual(readdirSync(join(copy, "site/data")).filter((name) => name.includes("cycle")), []);

  // No deploy, build, or other scheduled path invokes the cycle, and only the
  // cycle's own code names the receipt.
  const named = spawnSync(
    "git",
    ["grep", "--untracked", "-l", "connected_history_cycle", "--", "*.mjs", "*.js", "*.yml", "*.sh", "*.py", ":!test/**"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.deepEqual(named.stdout.trim().split("\n").filter(Boolean).sort(), [
    ".github/workflows/connected-history-cycle.yml",
    "tools/connected_history_cycle.mjs",
    "tools/lib/connected_history_cycle.mjs",
    "tools/lib/connected_history_release.mjs",
  ]);
  assert.doesNotMatch(readFileSync(join(ROOT, "tools/lib/connected_history_release.mjs"), "utf8"), /writeFileSync/);

  // A receipt that no attempted acquisition produced is rejected.
  const restated = {
    schema: "cityscroll.connected_history_cycle_receipt.v1",
    run: { run_id: "deploy:1", started_at: T0, finished_at: T0, status: "succeeded", outcome: "unchanged", served: SERVED },
    stages: [],
    acquisition: { documents: { attempted: false, sources: [] } },
    materialization: [],
    publication: { decision: "unchanged", changed_paths: [], written_paths: [] },
  };
  const errors = verifyConnectedHistoryCycleReceipt(restated).errors;
  assert.ok(errors.includes("acquisition_not_attempted"));
  assert.ok(errors.includes("stage_order"));
});

test("a receipt carries no local path and stays small enough to serve", async (t) => {
  const root = await fixtureRoot(t);
  await runCycle(root, { at: "2026-10-01T07:13:00.000Z" });
  const text = readFileSync(join(root, CONNECTED_HISTORY_CYCLE.receipt_path), "utf8");
  assert.doesNotMatch(text, /\/(?:Users|private|var\/folders|home)\//);
  assert.ok(text.length < 200_000, `${text.length} bytes`);
});

const RELEASE_READBACK = "docs/evidence/connected-history-release/release-readback.json";
const JOURNEYS_MANIFEST = "docs/evidence/documented-history-journeys/capture-manifest.json";
const COVERAGE_MANIFEST = "docs/evidence/connected-history-coverage/capture-manifest.json";

/**
 * Every retained production measurement that pins the bytes of a served data
 * artifact, per artifact. Regenerating a listed artifact invalidates each
 * measurement named for it: the cycle holds that change, the builder names
 * them, and a reviewed publication re-measures them.
 */
const RETAINED_SERVED_PINS = Object.freeze({
  "site/data/connected_history_coverage.json": [COVERAGE_MANIFEST, RELEASE_READBACK],
  "site/data/connected_history_documents.json": [RELEASE_READBACK],
  "site/data/connected_history_evaluation_cohort.json": [RELEASE_READBACK],
  "site/data/connected_history_relations.json": [RELEASE_READBACK, JOURNEYS_MANIFEST],
  "site/data/connected_history_roles.json": [RELEASE_READBACK, JOURNEYS_MANIFEST],
  "site/data/connected_history_time.json": [RELEASE_READBACK, JOURNEYS_MANIFEST],
  "site/data/site_lifecycle/manifest.json": [RELEASE_READBACK],
});

function evidenceFiles(root, directory, found = []) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) evidenceFiles(root, path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Retained measurements pinning each served data artifact in a tree: those
 * declaring it as a measured input, and any evidence file quoting its current
 * digest. A quoted digest that is not a declared input is reported, because
 * the cycle would not hold a change to it.
 */
function servedArtifactPins(root, extraServed = []) {
  const pins = retainedEvidencePins(root);
  const served = new Set([
    ...CONNECTED_HISTORY_MATERIALIZATIONS.flatMap((entry) => [entry.path, entry.receipt]),
    ...extraServed,
  ]);
  for (const pin of pins) for (const input of pin.inputs) if (input.startsWith("site/data/")) served.add(input);
  const texts = evidenceFiles(root, "docs/evidence").map((path) => [path, readFileSync(join(root, path), "latin1")]);
  const pinned = {};
  const undeclaredQuotes = [];
  for (const path of [...served].sort()) {
    if (!existsSync(join(root, path))) continue;
    const digest = sha256(readFileSync(join(root, path)));
    const declared = pins.filter((pin) => pin.inputs.includes(path)).map((pin) => pin.path);
    const quoted = texts.filter(([, text]) => text.includes(digest)).map(([file]) => file);
    for (const file of quoted) if (!declared.includes(file)) undeclaredQuotes.push(`${file} -> ${path}`);
    const pinning = [...new Set([...declared, ...quoted])].sort();
    if (pinning.length) pinned[path] = pinning;
  }
  return { pins, pinned, undeclaredQuotes };
}

test("every retained measurement that pins a served data artifact is named, so a regeneration surfaces what it invalidates", () => {
  const { pins, pinned, undeclaredQuotes } = servedArtifactPins(ROOT);
  assert.deepEqual(undeclaredQuotes, [], "an evidence file quotes a served digest without declaring it as a measured input");
  assert.deepEqual(
    pinned,
    Object.fromEntries(Object.entries(RETAINED_SERVED_PINS).map(([path, files]) => [path, [...files].sort()])),
    "name each retained measurement that pins a served artifact in RETAINED_SERVED_PINS",
  );

  // What a regeneration of each artifact would invalidate is exactly that list.
  for (const [path, files] of Object.entries(RETAINED_SERVED_PINS)) {
    assert.deepEqual(evidenceInvalidatedBy(pins, [path]).map((entry) => entry.path).sort(), [...files].sort(), path);
  }
});

test("the pin census finds a new declared pin and a quoted digest that no measurement declares", (t) => {
  const root = mkdtempSync(join(tmpdir(), "connected-history-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const served = "site/data/example_served.json";
  writeText(root, served, "{\"example\": true}\n");
  const digest = sha256(readFileSync(join(root, served)));
  writeText(root, "docs/evidence/unrelated/notes.md", "no digests here\n");
  assert.deepEqual(servedArtifactPins(root, [served]).pinned, {}, "nothing pins it yet");

  writeText(root, "docs/evidence/declared/capture-manifest.json", serialize({
    measurement_provenance: { revision: "c".repeat(40), inputs: [{ path: served, sha256: digest }] },
  }));
  const declared = servedArtifactPins(root, [served]);
  assert.deepEqual(declared.pinned, { [served]: ["docs/evidence/declared/capture-manifest.json"] });
  assert.deepEqual(declared.undeclaredQuotes, []);

  writeText(root, "docs/evidence/quoted/readme.md", `served digest ${digest}\n`);
  const quoted = servedArtifactPins(root, [served]);
  assert.deepEqual(quoted.pinned[served], ["docs/evidence/declared/capture-manifest.json", "docs/evidence/quoted/readme.md"]);
  assert.deepEqual(quoted.undeclaredQuotes, [`docs/evidence/quoted/readme.md -> ${served}`]);

  // A changed artifact no longer matches the quoted digest; only the declared
  // input still names it, and a regeneration reports exactly that one.
  writeText(root, served, "{\"example\": false}\n");
  assert.deepEqual(servedArtifactPins(root, [served]).pinned, { [served]: ["docs/evidence/declared/capture-manifest.json"] });
  assert.deepEqual(evidenceInvalidatedBy(retainedEvidencePins(root), [served]).map((entry) => entry.path), ["docs/evidence/declared/capture-manifest.json"]);
});
