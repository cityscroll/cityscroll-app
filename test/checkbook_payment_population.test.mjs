import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  groupPaymentsByAgency,
  normalizeCheckbookPaymentRows,
  parseCheckbookPaymentTransactions,
  paymentTransactionId,
  reconcilePaymentPartition,
} from "../warehouse/lib/checkbook_payment_population.mjs";
import { paymentPopulationRequestXml } from "../warehouse/scripts/checkbook_payment_population.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-payment-population/collector.json");

function fixtureRows() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return Object.values(fixture.pages).flatMap(parseCheckbookPaymentTransactions);
}

describe("independent Checkbook payment population", () => {
  it("uses a fiscal-year Spending query separate from the bounded collector", () => {
    const xml = paymentPopulationRequestXml(2026, 1, 20000);
    assert.match(xml, /<type_of_data>Spending<\/type_of_data>/);
    assert.match(xml, /<name>fiscal_year<\/name>[\s\S]*<value>2026<\/value>/);
    assert.match(xml, /<name>spending_category<\/name>[\s\S]*<value>c<\/value>/);
    assert.doesNotMatch(xml, /<name>contract_id<\/name>/);
  });

  it("preserves source fields and negative reversal rows", () => {
    const rows = fixtureRows();
    assert.equal(rows.length, 4);
    assert.equal(rows[0].payee_name, "Alpha & Sons");
    assert.equal(rows[1].check_amount, "-25.50");
    assert.equal(rows[1].document_id, "20260000002-1-DSB-AD");
    const normalized = normalizeCheckbookPaymentRows(rows);
    assert.equal(normalized.counts.normalized_rows, 4);
    assert.equal(normalized.counts.reversal_rows, 1);
    assert.equal(normalized.rows.find((row) => row.is_reversal).check_amount, -25.5);
    assert.equal(normalized.rows[0].source_system, "checkbook_payment_population");
    assert.ok(JSON.parse(normalized.rows[0].source_fields_json).budget_code);
  });

  it("creates deterministic identities and measures duplicates without dropping evidence", () => {
    const [first] = fixtureRows();
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    assert.equal(paymentTransactionId(first), paymentTransactionId(reordered));
    const normalized = normalizeCheckbookPaymentRows([first, reordered]);
    assert.equal(normalized.rows.length, 2);
    assert.equal(normalized.counts.unique_transaction_ids, 1);
    assert.equal(normalized.counts.duplicate_transaction_rows, 2);
  });

  it("reconciles source row count and net amount, including reversals", () => {
    const source = fixtureRows();
    const normalized = normalizeCheckbookPaymentRows(source).rows;
    const reconciliation = reconcilePaymentPartition({ sourceRecordCount: 4, sourceRows: source, normalizedRows: normalized });
    assert.equal(reconciliation.source_net_check_amount, 500);
    assert.equal(reconciliation.normalized_net_check_amount, 500);
    assert.equal(reconciliation.reconciled, true);
    const groups = groupPaymentsByAgency(normalized);
    assert.deepEqual(groups.map((group) => group.agency), ["Department of Beta", "Unknown / not published", "Department of Alpha"]);
  });
});

describe("payment population fixture acquisition", () => {
  it("writes a named population receipt and normalized CSV", () => {
    const stage = mkdtempSync(join(ROOT, ".generated", "checkbook-payment-population-test-"));
    const receipt = join(stage, "receipt.json");
    const output = join(stage, "payments.csv");
    const run = spawnSync(process.execPath, [
      "warehouse/scripts/checkbook_payment_population.mjs",
      "--from-fixture",
      "--fiscal-years", "2026",
      "--page-size", "2",
      "--stage-dir", stage,
      "--receipt", receipt,
      "--output", output,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const body = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(body.status, "complete");
    assert.equal(body.population_contract.id, "cityscroll.checkbook.payments.fiscal_year.v1");
    assert.equal(body.collector_boundary.no_graph_publication, true);
    assert.equal(body.population.publisher_record_count, 4);
    assert.equal(body.reconciliation.reconciled, true);
    assert.equal(body.population.reversal_rows, 1);
    assert.equal(body.reconciliation.source_net_check_amount, 500);
    assert.ok(existsSync(output));
    assert.equal(readFileSync(output, "utf8").trim().split("\n").length, 5);
  });
});
