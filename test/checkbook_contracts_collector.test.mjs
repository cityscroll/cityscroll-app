import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  measureCheckbookOverlap,
  normalizeCheckbookContractRows,
  selectCheckbookContractsForGraph,
} from "../warehouse/lib/checkbook_contracts.mjs";
import { parseContractTransactions } from "../worker/src/lib/checkbook_lifecycle.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-contracts/collector.json");

function fixtureRows() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return Object.entries(fixture.pages).flatMap(([key, xml]) => {
    const year = key.split(":")[0];
    return parseContractTransactions(xml).map((row) => ({ ...row, sourceFiscalYears: [year] }));
  });
}

describe("Checkbook Contracts normalization", () => {
  it("reads current live field names and collapses prime/subvendor slices by exact contract id", () => {
    const parsed = fixtureRows();
    assert.equal(parsed[0].agency, "Department of Alpha");
    assert.equal(parsed[0].pin, "10026P0001001");
    assert.equal(parsed[0].vendor, "Alpha & Prime LLC");
    assert.equal(parsed[1].subVendor, "Alpha Subcontractor Inc");

    const normalized = normalizeCheckbookContractRows(parsed);
    assert.equal(normalized.counts.input_slices, 3);
    assert.equal(normalized.counts.unique_contracts, 2);
    assert.equal(normalized.counts.duplicate_slices_collapsed, 1);
    assert.equal(normalized.counts.prime_slices, 2);
    assert.equal(normalized.counts.subvendor_slices, 1);
    assert.equal(normalized.rows[0].contract_id, "CT-ALPHA");
    assert.equal(normalized.rows[0].subvendor_count, 1);
    assert.equal(normalized.rows[0].prime_vendor, "Alpha & Prime LLC");
  });

  it("measures only exact contract/PIN overlap and keeps names out of identity", () => {
    const rows = normalizeCheckbookContractRows(fixtureRows()).rows;
    const passport = [
      { contract_id: "CT-ALPHA", epin: "10026P0001001", vendor: "Completely Different Name" },
    ];
    const cityRecord = [
      { request_id: "award-alpha", start_date: "2026-05-02", pin: "10026P0001001", vendor_name: "Another Name" },
      { request_id: "award-other", start_date: "2026-05-02", pin: "99999", vendor_name: "Alpha Prime LLC" },
    ];
    const measurement = measureCheckbookOverlap(rows, passport, cityRecord);
    assert.equal(measurement.exact_overlap_buckets.passport_and_city_record, 1);
    assert.equal(measurement.exact_overlap_buckets.new_unique, 1);
    assert.equal(measurement.passport.by_contract_id, 1);
    assert.equal(measurement.city_record.matched_modern_awards, 1);
    assert.equal(measurement.new_unique_contract_ids, 1);

    const selection = selectCheckbookContractsForGraph(rows, passport, cityRecord, { cap: 2 });
    assert.equal(selection.selected_rows, 2);
    assert.deepEqual(selection.selected_buckets, {
      passport_and_city_record: 1,
      passport_only: 0,
      city_record_only: 0,
      new_unique: 1,
    });
  });
});

describe("Checkbook Contracts fixture collector", () => {
  it("checkpoints pages, records the denominator, and resumes without refetching", () => {
    const generated = join(ROOT, ".generated");
    mkdirSync(generated, { recursive: true });
    const stage = mkdtempSync(join(generated, "checkbook-contracts-test-"));
    const receipt = join(stage, "receipt.json");
    const snapshot = join(stage, "normalized.json");
    const command = [
      "warehouse/scripts/checkbook_contracts.mjs",
      "--from-fixture",
      "--fiscal-years", "2026",
      "--page-size", "2",
      "--graph-cap", "2",
      "--stage-dir", stage,
      "--receipt", receipt,
      "--snapshot", snapshot,
    ];
    const first = spawnSync(process.execPath, command, { cwd: ROOT, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstReceipt = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(firstReceipt.status, "complete");
    assert.equal(firstReceipt.population.api_transaction_rows, 3);
    assert.equal(firstReceipt.population.normalized_unique_contracts, 2);
    assert.equal(firstReceipt.population.duplicate_slices_collapsed, 1);
    assert.equal(firstReceipt.graph_slice.row_count, 2);
    assert.equal(firstReceipt.paging.fetched_pages, 2);
    assert.equal(firstReceipt.paging.checkpoint_hits, 0);

    const implicitReuse = spawnSync(process.execPath, command, { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(implicitReuse.status, 0);
    assert.match(implicitReuse.stderr, /use --resume .* or --refresh/i);

    const second = spawnSync(process.execPath, [...command, "--resume"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    const resumed = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(resumed.paging.fetched_pages, 0);
    assert.equal(resumed.paging.checkpoint_hits, 2);
    assert.equal(resumed.checksums.normalized_contracts_sha256, firstReceipt.checksums.normalized_contracts_sha256);
  });
});
