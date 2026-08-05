import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "warehouse", "scripts", "city_record_delta.py");
const FIXTURE = join(ROOT, "warehouse", "fixtures", "city-record-delta");
const roots = [];

after(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })));

function outputRoot() {
  const path = mkdtempSync(join(tmpdir(), "city-record-delta-"));
  roots.push(path);
  return path;
}

function run(output, extra = []) {
  return spawnSync("python3", [
    SCRIPT,
    "--snapshot", join(FIXTURE, "baseline.csv"),
    "--source-fixture", join(FIXTURE, "source_rows.csv"),
    "--expected-final", join(FIXTURE, "expected_final.csv"),
    "--export-date", "2026-08-05",
    "--output-root", output,
    "--page-size", "2",
    "--max-rows", "10",
    ...extra,
  ], { cwd: ROOT, encoding: "utf8" });
}

function artifact(output, name) {
  return join(output, "city-record", "delta_date=2026-08-05", name);
}

describe("one-source dated City Record delta export", () => {
  it("commits the dated proof receipt", () => {
    const receipt = JSON.parse(readFileSync(join(
      ROOT, "warehouse", "receipts", "proof", "city-record_delta_2026-08-05.json"
    ), "utf8"));
    assert.equal(receipt.schema, "cityscroll.warehouse_delta_export_receipt.v1");
    assert.equal(receipt.source.dataset_id, "dg92-zbpx");
    assert.equal(receipt.export.date_utc, "2026-08-05");
    assert.equal(receipt.final_snapshot.equivalence.equivalent, true);
  });

  it("uses an exclusive stable composite cursor", () => {
    const result = spawnSync("python3", ["-c", `
import sys
sys.path.insert(0, "warehouse/scripts")
from city_record_delta import city_record_page_url
url = city_record_page_url(("2026-08-02T00:00:00.000", "20260802002"), 25)
assert "%24where=" in url
assert "start_date+ASC%2C+request_id+ASC" in url
assert "request_id+%3E+%2720260802002%27" in url
print(url)
`], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("resumes an interruption, deduplicates, and proves final equivalence", () => {
    const output = outputRoot();
    const interrupted = run(output, ["--stop-after-pages", "1"]);
    assert.equal(interrupted.status, 75, interrupted.stderr || interrupted.stdout);

    const resumed = run(output, ["--resume"]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const receipt = JSON.parse(readFileSync(artifact(output, "receipt.json"), "utf8"));
    assert.equal(receipt.export.partition, "delta_date=2026-08-05");
    assert.equal(receipt.export.format, "csv-rfc4180-utf8-lf");
    assert.deepEqual(receipt.cursor.order, ["start_date ASC", "request_id ASC"]);
    assert.equal(receipt.counts.snapshot_rows, 3);
    assert.equal(receipt.counts.source_rows, 4);
    assert.equal(receipt.counts.deduplicated_rows, 1);
    assert.equal(receipt.counts.delta_rows, 3);
    assert.equal(receipt.counts.final_snapshot_rows, 6);
    assert.equal(receipt.final_snapshot.equivalence.checked, true);
    assert.equal(receipt.final_snapshot.equivalence.equivalent, true);
    assert.equal(receipt.resume.page_count, 2);
    assert.equal(receipt.resume.resumed_from_checkpoint, true);
    assert.equal(receipt.resume.resume_count, 1);
  });

  it("rebuilds byte-identically and treats a same-cursor resume as idempotent", () => {
    const first = outputRoot();
    const second = outputRoot();
    assert.equal(run(first).status, 0);
    assert.equal(run(second).status, 0);
    const firstRows = readFileSync(artifact(first, "rows.csv"));
    const firstReceipt = readFileSync(artifact(first, "receipt.json"));
    assert.deepEqual(readFileSync(artifact(second, "rows.csv")), firstRows);
    assert.deepEqual(readFileSync(artifact(second, "receipt.json")), firstReceipt);

    const rerun = run(first, ["--resume"]);
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.deepEqual(readFileSync(artifact(first, "rows.csv")), firstRows);
    assert.deepEqual(readFileSync(artifact(first, "receipt.json")), firstReceipt);
  });
});
