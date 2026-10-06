import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runComparator } from "../tools/law_mandates/backfill.mjs";

test("comparator records not_run when private reference is unavailable", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "mandates-not-run-"));
  try {
    const { filed, review } = await runComparator(
      {
        reference: null,
        outputDir,
        journalScript: join(process.env.HOME, "dev/fiduciary-heartbeat/tools/autonomy_journal.py"),
      },
      { law_count: 3 },
      { laws: [{ matter_id: "1" }, { matter_id: "2" }, { matter_id: "3" }] },
    );
    assert.equal(review, null);
    assert.equal(filed.status, "not_run");
    assert.equal(filed.reason, "private_reference_unavailable");
    assert.equal(filed.receipt.mismatch_count, null);
    assert.equal(filed.receipt.matter_count, 3);
    const disk = JSON.parse(await readFile(join(outputDir, "differential_self_check_receipt.json"), "utf8"));
    assert.equal(disk.status, "not_run");
    assert.equal(disk.reason, "private_reference_unavailable");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
