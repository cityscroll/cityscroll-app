import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "warehouse", "scripts", "ocp_awards_delta.py");
const FIXTURE = join(ROOT, "warehouse", "fixtures", "ocp-awards-delta");
const roots = [];

after(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })));

function outputRoot() {
  const path = mkdtempSync(join(tmpdir(), "ocp-awards-delta-"));
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
    "--force-headroom",
    ...extra,
  ], { cwd: ROOT, encoding: "utf8" });
}

function artifact(output, name) {
  return join(output, "ocp-recent-contract-awards", "delta_date=2026-08-05", name);
}

describe("OCP Recent Contract Awards delta semantics", () => {
  it("commits independent fixture and bounded live evidence", () => {
    const fixture = JSON.parse(readFileSync(join(
      ROOT, "warehouse", "receipts", "proof", "ocp_awards_delta_fixture.json"
    ), "utf8"));
    const live = JSON.parse(readFileSync(join(
      ROOT, "warehouse", "receipts", "proof", "ocp_awards_delta_live_2026-08-05.json"
    ), "utf8"));

    assert.equal(fixture.schema, "cityscroll.ocp_awards_delta_export_receipt.v1");
    assert.equal(fixture.final_snapshot.equivalence.equivalent, true);
    assert.equal(fixture.ordering.verified, true);
    assert.equal(live.evidence.basis, "bounded-live-measurement");
    assert.equal(live.source.dataset_id, "qyyg-4tf5");
    assert.equal(live.ordering.verified, true);
    assert.ok(live.ordering.sample_rows > 0);
    assert.equal(live.ordering.duplicate_cursor_pairs, 0);
    assert.equal(live.ordering.non_monotonic_pairs, 0);
    assert.match(live.final_snapshot.sha256, /^[a-f0-9]{64}$/);
  });

  it("uses an independently verified exclusive composite cursor", () => {
    const result = spawnSync("python3", ["-c", `
import sys
sys.path.insert(0, "warehouse/scripts")
from ocp_awards_delta import ocp_awards_page_url
url = ocp_awards_page_url(("2026-08-02T00:00:00.000", "20260802002"), 25)
assert "%24where=" in url
assert "start_date+ASC%2C+request_id+ASC" in url
assert "request_id+%3E+%2720260802002%27" in url
print(url)
`], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("writes a stop receipt instead of enabling a cursor when ordering is ambiguous", () => {
    const output = outputRoot();
    const source = join(output, "ambiguous.csv");
    const rows = readFileSync(join(FIXTURE, "source_rows.csv"), "utf8").trimEnd().split("\n");
    writeFileSync(source, `${rows.join("\n")}\n${rows[1]}\n`);
    const result = run(output, ["--source-fixture", source]);
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(readFileSync(artifact(output, "receipt.json"), "utf8"));
    assert.equal(receipt.schema, "cityscroll.ocp_awards_delta_stop_receipt.v1");
    assert.equal(receipt.status, "stopped");
    assert.equal(receipt.ordering.verified, false);
    assert.equal(receipt.ordering.duplicate_cursor_pairs, 1);
  });

  it("resumes an interruption, deduplicates request ids, and proves snapshot equivalence", () => {
    const output = outputRoot();
    const interrupted = run(output, ["--stop-after-pages", "1"]);
    assert.equal(interrupted.status, 75, interrupted.stderr || interrupted.stdout);

    const resumed = run(output, ["--resume"]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const receipt = JSON.parse(readFileSync(artifact(output, "receipt.json"), "utf8"));
    assert.deepEqual(receipt.cursor.order, ["start_date ASC", "request_id ASC"]);
    assert.equal(receipt.ordering.verified, true);
    assert.equal(receipt.counts.snapshot_rows, 3);
    assert.equal(receipt.counts.source_rows, 4);
    assert.equal(receipt.counts.deduplicated_rows, 1);
    assert.equal(receipt.counts.delta_rows, 3);
    assert.equal(receipt.counts.final_snapshot_rows, 6);
    assert.equal(receipt.final_snapshot.equivalence.equivalent, true);
    assert.equal(receipt.resume.page_count, 2);
    assert.equal(receipt.resume.resumed_from_checkpoint, true);
    assert.equal(receipt.resume.resume_count, 1);
  });

  it("rebuilds byte-identically and treats a completed same-cursor resume as idempotent", () => {
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
