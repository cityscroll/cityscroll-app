import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIRST_CLASS_REFRESH_RUN_HISTORY,
  RUN_HISTORY_SCHEMA,
  assertPriorRunsAppendOnly,
  buildPriorRunsLedger,
  buildRunReceipt,
  builderStatusMap,
  checkFirstClassRefreshRunHistoryDeclaration,
  ledgerHistoryOf,
  loadPendingRunHistory,
  mergePriorRunHistories,
  priorRunsDropped,
  rebuildStatusFor,
  receiptSha256,
  runIdentityFromEnv,
} from "../tools/first_class_refresh_run_receipt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = readFileSync(join(ROOT, FIRST_CLASS_REFRESH_RUN_HISTORY.workflow), "utf8");

const REGISTRY = {
  first_class_artifacts: [
    { id: "due-and-published", public_artifact_path: "site/data/due_and_published.json", owning_builder: "tools/build_a.mjs", dependent_materializers: ["tools/build_shared.mjs"] },
    { id: "due-but-rebuild-failed", public_artifact_path: "site/data/due_but_rebuild_failed.json", owning_builder: "tools/build_b.mjs", dependent_materializers: [] },
    { id: "not-due", public_artifact_path: "site/data/not_due.json", owning_builder: "tools/build_c.mjs", dependent_materializers: [] },
    { id: "warehouse-only", public_artifact_path: "site/data/warehouse_only.json", owning_builder: "tools/build_warehouse.mjs", dependent_materializers: [] },
  ],
};

const REBUILD_REGISTRY = {
  rebuild_sequence: [
    { id: "shared-step", command: ["tools/build_shared.mjs"], covers: ["tools/build_shared.mjs"], after: [] },
    { id: "b-step", command: ["tools/build_b.mjs"], covers: ["tools/build_b.mjs"], after: [] },
  ],
};

function refreshReceiptFor(dueIds) {
  return {
    commands: [
      ...dueIds.map((id) => ({ kind: "acquisition", status: "succeeded", artifact_paths: [`site/data/${id}.json`] })),
      ...dueIds.map((id) => ({ kind: "owning-builder", status: "succeeded", artifact_paths: [`site/data/${id}.json`] })),
    ],
  };
}

function receiptFor({ runId, trigger, startedAt, finishedAt, dueCount = 1, publishedCount = 1, priorRuns = [] }) {
  return {
    schema: RUN_HISTORY_SCHEMA,
    generated_at: finishedAt,
    run: {
      run_id: runId,
      github_run_id: null,
      run_url: null,
      trigger,
      started_at: startedAt,
      finished_at: finishedAt,
      code_revision: null,
    },
    total: 4,
    due_count: dueCount,
    published_count: publishedCount,
    datasets: [],
    prior_runs: priorRuns,
  };
}

test("builderStatusMap keys rebuild-step status by every builder the step covers", () => {
  const map = builderStatusMap(REBUILD_REGISTRY, { steps: [{ id: "shared-step", status: "succeeded" }, { id: "b-step", status: "failed" }] });
  assert.equal(map.get("tools/build_shared.mjs"), "succeeded");
  assert.equal(map.get("tools/build_b.mjs"), "failed");
  assert.equal(map.get("tools/build_a.mjs"), undefined);
});

test("rebuildStatusFor is not_applicable when nothing in the rebuild registry covers the artifact's builders", () => {
  const status = rebuildStatusFor({ owning_builder: "tools/build_warehouse.mjs", dependent_materializers: [] }, new Map());
  assert.equal(status, "not_applicable");
});

test("rebuildStatusFor reports failed when any covering step failed, even if another succeeded", () => {
  const map = new Map([["tools/build_a.mjs", "succeeded"], ["tools/build_shared.mjs", "failed"]]);
  assert.equal(rebuildStatusFor({ owning_builder: "tools/build_a.mjs", dependent_materializers: ["tools/build_shared.mjs"] }, map), "failed");
});

test("the combined receipt distinguishes a clean no-op from a due dataset that could not publish", () => {
  const rebuildReceipt = { steps: [{ id: "shared-step", status: "succeeded" }, { id: "b-step", status: "failed" }] };
  const receipt = buildRunReceipt({
    registry: REGISTRY,
    refreshReceipt: refreshReceiptFor(["due_and_published", "due_but_rebuild_failed"]),
    rebuildRegistry: REBUILD_REGISTRY,
    rebuildReceipt,
    changed: ["site/data/due_and_published.json"],
    now: "2026-09-29T00:00:00Z",
    run: {
      run_id: "github-actions:1:1",
      github_run_id: 1,
      run_url: null,
      trigger: "schedule",
      started_at: "2026-09-29T00:00:00Z",
      finished_at: "2026-09-29T00:05:00Z",
      code_revision: null,
    },
  });
  assert.equal(receipt.schema, RUN_HISTORY_SCHEMA);
  assert.equal(receipt.total, 4);
  assert.equal(receipt.due_count, 2);
  assert.equal(receipt.published_count, 1);
  assert.equal(receipt.run.trigger, "schedule");
  assert.equal(receipt.run.run_id, "github-actions:1:1");
  assert.equal(receipt.run.started_at, "2026-09-29T00:00:00Z");
  assert.equal(receipt.run.finished_at, "2026-09-29T00:05:00Z");
  const byId = Object.fromEntries(receipt.datasets.map((row) => [row.id, row]));

  // Due, acquired and built cleanly, its rebuild dependency succeeded, and it
  // shows up in the working tree as a change: an ordinary successful publish.
  assert.deepEqual(
    { due: byId["due-and-published"].due, rebuild_status: byId["due-and-published"].rebuild_status, published: byId["due-and-published"].published },
    { due: true, rebuild_status: "succeeded", published: true },
  );

  // Due, its own acquisition and builder succeeded, but the shared rebuild
  // step it depends on failed — so it is due and healthy up to that point yet
  // did not publish. This is the exact shape the isolation fix must report:
  // a real failure, not indistinguishable from a quiet no-op.
  assert.deepEqual(
    { due: byId["due-but-rebuild-failed"].due, acquisition_status: byId["due-but-rebuild-failed"].acquisition_status, rebuild_status: byId["due-but-rebuild-failed"].rebuild_status, published: byId["due-but-rebuild-failed"].published },
    { due: true, acquisition_status: "succeeded", rebuild_status: "failed", published: false },
  );

  // Not due at all: an idempotent run that refreshed nothing for this dataset,
  // not a run that tried and could not publish.
  assert.deepEqual(
    { due: byId["not-due"].due, acquisition_status: byId["not-due"].acquisition_status, published: byId["not-due"].published },
    { due: false, acquisition_status: "not_due", published: false },
  );

  // Warehouse-backed and outside the hosted rebuild sequence entirely.
  assert.equal(byId["warehouse-only"].rebuild_status, "not_applicable");
});

test("a checkout the git status probe cannot read reports published as unknown rather than false", () => {
  const receipt = buildRunReceipt({
    registry: REGISTRY,
    refreshReceipt: refreshReceiptFor([]),
    rebuildRegistry: REBUILD_REGISTRY,
    rebuildReceipt: null,
    changed: null,
    now: "2026-09-29T00:00:00Z",
  });
  assert.ok(receipt.datasets.every((row) => row.published === null));
});

test("runIdentityFromEnv names schedule vs workflow_dispatch from the Actions event", () => {
  const scheduled = runIdentityFromEnv(
    {
      GITHUB_RUN_ID: "36718192869",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "cityscroll/cityscroll-app",
      GITHUB_SHA: "abc123",
      FIRST_CLASS_REFRESH_STARTED_AT: "2026-09-30T12:57:00Z",
    },
    { finishedAt: "2026-09-30T13:10:00Z" },
  );
  assert.equal(scheduled.run_id, "github-actions:36718192869:1");
  assert.equal(scheduled.trigger, "schedule");
  assert.equal(scheduled.started_at, "2026-09-30T12:57:00Z");
  assert.equal(scheduled.finished_at, "2026-09-30T13:10:00Z");
  assert.equal(scheduled.run_url, "https://github.com/cityscroll/cityscroll-app/actions/runs/36718192869");

  const manual = runIdentityFromEnv(
    {
      GITHUB_RUN_ID: "999",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    },
    { finishedAt: "2026-09-30T18:00:00Z", startedAt: "2026-09-30T17:55:00Z" },
  );
  assert.equal(manual.trigger, "workflow_dispatch");
  assert.equal(manual.run_id, "github-actions:999:1");

  const local = runIdentityFromEnv({}, { finishedAt: "2026-09-30T19:00:00Z" });
  assert.equal(local.trigger, "local");
  assert.equal(local.run_id, "local:2026-09-30T19:00:00Z");
});

test("prior_runs is append-only: dropping a retained run fails instead of publishing", () => {
  const retained = [
    { run_id: "run-a", trigger: "schedule", started_at: "2026-09-30T12:57:00Z" },
    { run_id: "run-b", trigger: "workflow_dispatch", started_at: "2026-09-29T10:24:15Z" },
  ];
  assert.deepEqual(priorRunsDropped(retained, retained), []);
  assertPriorRunsAppendOnly(retained, retained);
  const dropped = priorRunsDropped(retained, [retained[1]]);
  assert.deepEqual(dropped.map((entry) => entry.run_id), ["run-a"]);
  assert.throws(
    () => assertPriorRunsAppendOnly(retained, [retained[1]]),
    /would drop retained run\(s\): run-a \(schedule, 2026-09-30T12:57:00Z\)/,
  );
  const windowed = Array.from({ length: FIRST_CLASS_REFRESH_RUN_HISTORY.ledger_limit + 1 }, (_, index) => ({
    run_id: `run-${index}`,
    trigger: "schedule",
    started_at: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 86_400_000).toISOString(),
  })).reverse();
  const proposed = windowed.slice(0, FIRST_CLASS_REFRESH_RUN_HISTORY.ledger_limit);
  assertPriorRunsAppendOnly(windowed, proposed);
  assert.throws(() => assertPriorRunsAppendOnly(windowed, proposed.slice(1)), /would drop retained run/);
});

test("an unmerged dated-branch receipt is merged into prior_runs and cannot be silent-dropped", () => {
  const scheduled = receiptFor({
    runId: "github-actions:36718192869:1",
    trigger: "schedule",
    startedAt: "2026-09-30T12:57:00Z",
    finishedAt: "2026-09-30T13:10:00Z",
  });
  const pendingText = `${JSON.stringify(scheduled, null, 2)}\n`;
  const pending = loadPendingRunHistory(pendingText);

  // Main has no committed history yet: without the pending tip, the next run
  // would publish a ledger that never names the scheduled refresh.
  const naive = buildPriorRunsLedger({ committedPrevious: null, committedDigest: null });
  assert.deepEqual(naive, []);
  assert.throws(
    () => assertPriorRunsAppendOnly(ledgerHistoryOf(pending.receipt, pending.digest), naive),
    /would drop retained run\(s\): github-actions:36718192869:1/,
  );

  const prior = buildPriorRunsLedger({
    committedPrevious: null,
    committedDigest: null,
    pendingReceipts: [pending],
  });
  assert.equal(prior[0].run_id, "github-actions:36718192869:1");
  assert.equal(prior[0].trigger, "schedule");
  assert.equal(prior[0].started_at, "2026-09-30T12:57:00Z");
  assert.equal(prior[0].finished_at, "2026-09-30T13:10:00Z");
  assert.equal(prior[0].receipt_sha256, pending.digest);
});

test("positive control: a manual dispatch stays marked workflow_dispatch and is not countable as scheduled", () => {
  const scheduled = receiptFor({
    runId: "github-actions:100:1",
    trigger: "schedule",
    startedAt: "2026-10-01T12:00:00Z",
    finishedAt: "2026-10-01T12:30:00Z",
  });
  const scheduledText = `${JSON.stringify(scheduled, null, 2)}\n`;
  const prior = buildPriorRunsLedger({
    committedPrevious: scheduled,
    committedDigest: receiptSha256(scheduledText),
  });
  const manual = buildRunReceipt({
    registry: REGISTRY,
    refreshReceipt: refreshReceiptFor([]),
    rebuildRegistry: REBUILD_REGISTRY,
    rebuildReceipt: null,
    changed: [],
    now: "2026-10-01T18:00:00Z",
    run: runIdentityFromEnv(
      { GITHUB_RUN_ID: "200", GITHUB_EVENT_NAME: "workflow_dispatch" },
      { finishedAt: "2026-10-01T18:00:00Z", startedAt: "2026-10-01T17:50:00Z" },
    ),
    priorRuns: prior,
  });
  assert.equal(manual.run.trigger, "workflow_dispatch");
  assert.equal(manual.prior_runs[0].run_id, "github-actions:100:1");
  assert.equal(manual.prior_runs[0].trigger, "schedule");

  // A consecutive-scheduled read-back counts only schedule triggers. The
  // retained manual row proves the ledger can tell the two apart.
  const consecutiveScheduled = [manual.run, ...manual.prior_runs]
    .filter((entry) => entry.trigger === "schedule")
    .map((entry) => entry.run_id);
  assert.deepEqual(consecutiveScheduled, ["github-actions:100:1"]);
  assert.ok(manual.run.trigger === "workflow_dispatch", "the tip itself is the positive control");
  assert.ok(
    mergePriorRunHistories(ledgerHistoryOf(manual, receiptSha256(`${JSON.stringify(manual, null, 2)}\n`)))
      .some((entry) => entry.trigger === "workflow_dispatch"),
    "the retained history keeps the manual trigger",
  );
});

test("consecutive scheduled receipts append rather than replace", () => {
  const first = receiptFor({
    runId: "github-actions:1:1",
    trigger: "schedule",
    startedAt: "2026-10-01T12:00:00Z",
    finishedAt: "2026-10-01T12:20:00Z",
  });
  const firstText = `${JSON.stringify(first, null, 2)}\n`;
  const secondPrior = buildPriorRunsLedger({
    committedPrevious: first,
    committedDigest: receiptSha256(firstText),
  });
  const second = buildRunReceipt({
    registry: REGISTRY,
    refreshReceipt: refreshReceiptFor([]),
    rebuildRegistry: REBUILD_REGISTRY,
    rebuildReceipt: null,
    changed: [],
    now: "2026-10-02T12:25:00Z",
    run: {
      run_id: "github-actions:2:1",
      github_run_id: 2,
      run_url: null,
      trigger: "schedule",
      started_at: "2026-10-02T12:00:00Z",
      finished_at: "2026-10-02T12:25:00Z",
      code_revision: null,
    },
    priorRuns: secondPrior,
  });
  assert.deepEqual(second.prior_runs.map((entry) => entry.run_id), ["github-actions:1:1"]);
  assert.equal(second.run.trigger, "schedule");

  const secondText = `${JSON.stringify(second, null, 2)}\n`;
  const thirdPrior = buildPriorRunsLedger({
    committedPrevious: second,
    committedDigest: receiptSha256(secondText),
  });
  assert.deepEqual(thirdPrior.map((entry) => entry.run_id), [
    "github-actions:2:1",
    "github-actions:1:1",
  ]);
  assert.ok(thirdPrior.every((entry) => entry.trigger === "schedule"));
});

test("the refresh workflow declares retained history, pending-tip capture, and a manual trigger", () => {
  const declared = checkFirstClassRefreshRunHistoryDeclaration(WORKFLOW);
  assert.equal(declared.valid, true, declared.errors.join("; "));
  assert.match(WORKFLOW, /site\/data\/first_class_refresh_run_history\.json/);
  assert.match(WORKFLOW, /Capture any unmerged refresh run history/);
  assert.match(WORKFLOW, /--pending-receipt/);
  assert.match(WORKFLOW, /data\/first-class-refresh-\*/);
  assert.match(WORKFLOW, /FIRST_CLASS_REFRESH_STARTED_AT/);
  assert.match(WORKFLOW, /workflow_dispatch:/);
  assert.match(
    checkFirstClassRefreshRunHistoryDeclaration(WORKFLOW.replaceAll("--pending-receipt", "--other-flag")).errors.join(),
    /unmerged dated-branch receipt/,
  );
  assert.match(
    checkFirstClassRefreshRunHistoryDeclaration(WORKFLOW.replaceAll(FIRST_CLASS_REFRESH_RUN_HISTORY.history_path, "elsewhere.json")).errors.join(),
    /retained history path/,
  );
});
