/**
 * Fixture ingests re-register the shared DuckDB catalog view. On a machine that
 * retains a bulk warehouse snapshot, running one against the real warehouse root
 * silently downgrades the catalog to the five-row fixture, and the next
 * materialization publishes an empty artifact. Tests that need a fixture catalog
 * therefore build one in a throwaway root and restore the caller's root after.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withScratchWarehouseRoot(run) {
  const previous = process.env.CITYSCROLL_WAREHOUSE_ROOT;
  const root = mkdtempSync(join(tmpdir(), "cityscroll-warehouse-"));
  process.env.CITYSCROLL_WAREHOUSE_ROOT = root;
  try {
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.CITYSCROLL_WAREHOUSE_ROOT;
    else process.env.CITYSCROLL_WAREHOUSE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
