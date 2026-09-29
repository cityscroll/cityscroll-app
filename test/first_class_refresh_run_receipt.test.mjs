import assert from "node:assert/strict";
import test from "node:test";

import { buildRunReceipt, builderStatusMap, rebuildStatusFor } from "../tools/first_class_refresh_run_receipt.mjs";

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
  });
  assert.equal(receipt.total, 4);
  assert.equal(receipt.due_count, 2);
  assert.equal(receipt.published_count, 1);
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
