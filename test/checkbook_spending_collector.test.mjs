import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  joinPaymentToContract,
  measurePaymentContractJoin,
  normalizeCheckbookSpendingRows,
  paymentRowToSourceRecord,
  selectCheckbookSpendingForGraph,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../warehouse/lib/checkbook_spending.mjs";
import { selectKillSampleContracts } from "../warehouse/scripts/checkbook_spending.mjs";
import { parseSpendingTransactions } from "../worker/src/lib/checkbook_lifecycle.mjs";
import { checkbookSpendingSourceSystemId } from "../worker/src/lib/checkbook_source_records.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-spending/collector.json");

function fixturePayments() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return Object.entries(fixture.pages).flatMap(([key, xml]) => {
    const contractId = key.split(":")[0];
    return parseSpendingTransactions(xml).map((row) => ({
      ...row,
      seed_contract_id: contractId,
      seedContractId: contractId,
    }));
  });
}

describe("Checkbook Spending normalization + retention", () => {
  it("retains individual payment rows with stable source_system_id (not spent summaries)", () => {
    const parsed = fixturePayments();
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].contractId, "CT-ALPHA");
    assert.equal(parsed[0].amount, 250);
    assert.equal(parsed[0].vendor, "Alpha & Prime LLC");

    const normalized = normalizeCheckbookSpendingRows(parsed);
    assert.equal(normalized.counts.retained_payments, 4);
    assert.equal(normalized.counts.unique_contracts, 3);
    assert.equal(normalized.blocked.missing_contract_id, 0);

    for (const row of normalized.rows) {
      assert.ok(row.contract_id);
      assert.ok(row.document_id);
      assert.ok(row.source_system_id.startsWith("payment:"));
      assert.equal(row.source_system_id, checkbookSpendingSourceSystemId(row));
      const record = paymentRowToSourceRecord(row, "2026-08-11T12:00:00Z");
      assert.equal(record.source_system, "checkbook_spending");
      assert.equal(record.payload_json.contract_id, row.contract_id);
      assert.equal(record.payload_json.document_id, row.document_id);
      assert.equal(record.payload_json.check_amount, row.check_amount);
    }
  });

  it("drops unlinked spending rows instead of inventing a contract join", () => {
    const normalized = normalizeCheckbookSpendingRows([
      { vendor: "Payroll", amount: 1, date: "2026-01-01", id: "PAY-1" },
      { contractId: "CT-ALPHA", vendor: "Alpha", amount: 10, date: "2026-01-02", id: "CHK-1" },
    ]);
    assert.equal(normalized.counts.retained_payments, 1);
    assert.equal(normalized.blocked.missing_contract_id, 1);
    assert.equal(normalized.rows[0].contract_id, "CT-ALPHA");
  });

  it("joins payments on exact contract_id and rejects seed mismatches as precision failures", () => {
    const contracts = [
      { contract_id: "CT-ALPHA", pin: "10026P0001001" },
      { contract_id: "CT-BETA", pin: "20026P0002001" },
    ];
    const exact = joinPaymentToContract(
      { contract_id: "CT-ALPHA", seed_contract_id: "CT-ALPHA", document_id: "1" },
      contracts,
    );
    assert.equal(exact.method, "exact_contract_id");
    assert.equal(exact.matched, true);

    const mismatch = joinPaymentToContract(
      { contract_id: "CT-OTHER", seed_contract_id: "CT-ALPHA", document_id: "2" },
      contracts,
    );
    assert.equal(mismatch.method, "seed_contract_id_mismatch");
    assert.equal(mismatch.precision_ok, false);

    // Residual pin prefix: payment pin is a proper prefix of a longer contract pin/epin.
    const pinJoin = joinPaymentToContract(
      { contract_id: "CT-UNKNOWN", pin: "10026P0001", document_id: "3" },
      [{ contract_id: "CT-ALPHA", pin: "10026P0001001" }],
    );
    assert.equal(pinJoin.matched, true);
    assert.ok(["pin_prefix_of_epin", "exact"].includes(pinJoin.method) || pinJoin.method === "pin_prefix_of_epin");
  });

  it("measures usefulness and precision gates on the fixture kill sample", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const seeds = selectKillSampleContracts(fixture.seed_contracts, 5);
    assert.equal(seeds.length, 5);
    const spentFirst = seeds.filter((s) => s.spent > 0).length;
    assert.ok(spentFirst >= 3, "stratified sample prefers spent contracts");

    const normalized = normalizeCheckbookSpendingRows(fixturePayments());
    const measurement = measurePaymentContractJoin(seeds, normalized.rows);
    // 3 of 5 seeds have payments (ALPHA, BETA, DELTA)
    assert.equal(measurement.usefulness.joined, 3);
    assert.equal(measurement.usefulness.total, 5);
    assert.equal(measurement.usefulness.rate, 0.6);
    assert.ok(measurement.usefulness.rate >= USEFULNESS_FLOOR);
    assert.equal(measurement.precision.false_positives, 0);
    assert.equal(measurement.precision.rate, 1);
    assert.ok(measurement.precision.rate >= PRECISION_FLOOR);
    assert.equal(measurement.gates.materialize, true);

    const selection = selectCheckbookSpendingForGraph(normalized.rows, { cap: 3 });
    assert.equal(selection.selected_rows, 3);
    assert.ok(selection.rows.every((row) => row.contract_id && (row.document_id || row.check_amount)));
  });
});

describe("Checkbook Spending fixture collector", () => {
  it("retains payments, writes source_records snapshot, and records join gates", () => {
    const generated = join(ROOT, ".generated");
    mkdirSync(generated, { recursive: true });
    const stage = mkdtempSync(join(generated, "checkbook-spending-test-"));
    const receipt = join(stage, "receipt.json");
    const snapshot = join(stage, "retained.json");
    const sourceRecords = join(stage, "source_records.jsonl");
    const verify = join(stage, "verify.json");
    const command = [
      "warehouse/scripts/checkbook_spending.mjs",
      "--from-fixture",
      "--kill-sample", "5",
      "--page-size", "50",
      "--graph-cap", "10",
      "--stage-dir", stage,
      "--receipt", receipt,
      "--snapshot", snapshot,
      "--source-records", sourceRecords,
      "--verification-receipt", verify,
    ];
    const run = spawnSync(process.execPath, command, { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const body = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(body.status, "complete");
    assert.equal(body.population.retained_payments, 4);
    assert.equal(body.measurement.usefulness.joined, 3);
    assert.equal(body.measurement.usefulness.rate, 0.6);
    assert.equal(body.measurement.precision.rate, 1);
    assert.equal(body.measurement.gates.materialize, true);
    assert.equal(body.retention.mode, "individual_payment_rows");
    assert.ok(existsSync(sourceRecords));
    const lines = readFileSync(sourceRecords, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    const first = JSON.parse(lines[0]);
    assert.equal(first.source_system, "checkbook_spending");
    assert.ok(first.source_system_id.startsWith("payment:"));
    assert.ok(first.payload_json.contract_id);
    const verifyBody = JSON.parse(readFileSync(verify, "utf8"));
    assert.equal(verifyBody.gates.materialize, true);
  });
});
