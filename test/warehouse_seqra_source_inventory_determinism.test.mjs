import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "tools", "build_seqra_source_inventory.mjs");
const RECEIPT = join(ROOT, "warehouse", "receipts", "proof", "seqra_source_inventory_latest.json");

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("SEQRA source inventory CLI determinism", () => {
  it("--check passes against the committed observation fixture and receipt", () => {
    const result = run("--check");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SEQRA source inventory receipt OK/);
  });

  it("running the builder twice from the same committed observation produces byte-identical receipts apart from no change at all (fully deterministic build)", () => {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(RECEIPT, "utf8");

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const secondBytes = readFileSync(RECEIPT, "utf8");

    assert.equal(firstBytes, secondBytes);

    const receipt = JSON.parse(secondBytes);
    assert.equal(receipt.schema, "cityscroll.seqra_source_inventory_receipt.v1");
    // Scope classification runs the required jurisdiction fixture batch, which
    // deliberately includes 3 California/CEQA fixture rows to exercise the
    // rejection test; none of these are live source rows or reach an admitted
    // population, but they are correctly counted as out-of-scope here.
    assert.equal(receipt.out_of_scope_record_count, 3);
    assert.equal(receipt.scope_classification.california_or_ceqa_admitted_count, 0);
    assert.equal(receipt.temporal_leakage_count, 0);
    assert.equal(receipt.gate.resident_ingestion_committed, false);
    assert.equal(receipt.gate.public_predictive_claim_authorized, false);
  });

  it("rejects an unrecognized flag rather than silently ignoring it", () => {
    const result = run("--bogus");
    assert.notEqual(result.status, 0);
  });

  it("refuses --refresh and --check together", () => {
    const result = run("--refresh", "--check");
    assert.notEqual(result.status, 0);
  });
});
