import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import {
  FIRST_PAYMENT_TIMING_SCHEMA,
  createFirstPaymentTracker,
  firstPaymentTiming,
  fiscalYearCoverage,
  horizonEnd,
} from "../warehouse/lib/first_payment_timing.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "test/fixtures/first-payment-timing");
const CONTRACTS = join(FIXTURE, "registered/analytics_registered_contracts.json");
const FY2026 = fiscalYearCoverage([2026]);

function run(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}

async function withFixturePopulation(fn) {
  await withTempDir("first-payment-timing-test", async (stage) => {
    const receipt = join(stage, "receipt.json");
    const payments = join(stage, "payments.csv");
    const collected = run([
      "warehouse/scripts/checkbook_payment_population.mjs", "--from-fixture",
      "--fixture", join(FIXTURE, "collector.json"), "--fiscal-years", "2026", "--page-size", "1000",
      "--stage-dir", stage, "--receipt", receipt, "--output", payments,
    ]);
    assert.equal(collected.status, 0, collected.stderr || collected.stdout);
    await fn({ stage, receipt, payments });
  });
}

function timing(contracts, payments, coverage = FY2026) {
  const tracker = createFirstPaymentTracker(contracts.map((row) => row.prime_contract_id).filter(Boolean));
  for (const payment of payments) tracker.accept(payment);
  return firstPaymentTiming({ contracts, firstPayments: tracker.firstPayments, coverage, contractsSnapshot: "2026-11-10", paymentsSnapshot: "2026-11-09T21:14:00.178Z", paymentStats: tracker.stats });
}

describe("first-payment timing from retained Checkbook payments", () => {
  it("measures the retained fixture population: every in-year contract once, paid or not", async () => {
    await withFixturePopulation(async ({ stage, receipt, payments }) => {
      const output = join(stage, "out/analytics_first_payment_timing.json");
      const built = run(["tools/build_first_payment_timing.mjs", "--input", payments, "--receipt", receipt, "--contracts", CONTRACTS, "--output", output]);
      assert.equal(built.status, 0, built.stderr || built.stdout);
      const summary = JSON.parse(readFileSync(output, "utf8"));
      const contracts = JSON.parse(readFileSync(join(stage, "out/analytics_first_payment_timing/contracts.json"), "utf8"));
      assert.equal(summary.schema, FIRST_PAYMENT_TIMING_SCHEMA);
      assert.deepEqual(summary.payment_years, { fiscal_years: [2026], from: "2025-07-01", through: "2026-06-30" });
      assert.equal(summary.population.registered_contracts_read, 26);
      assert.equal(summary.population.measured_contracts, 24);
      assert.equal(summary.population.excluded.start_before_payment_years, 1);
      assert.equal(summary.population.excluded.start_after_payment_years, 1);
      assert.equal(summary.population.payment_rows.payment_rows, 37);
      const ids = contracts.rows.map((row) => row.prime_contract_id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(contracts.row_count, 24);
      for (const row of contracts.rows) {
        assert.ok(row.start_date >= "2025-07-01" && row.start_date <= "2026-06-30");
        assert.equal(row.state, row.first_payment_date ? "paid_in_payment_years" : "no_payment_in_payment_years");
      }
      // Per-agency summaries add up to the measured population.
      assert.equal(summary.agencies.reduce((sum, agency) => sum + agency.contracts, 0), 24);
      for (const agency of summary.agencies) {
        assert.equal(agency.first_paid_in_payment_years + agency.no_payment_in_payment_years, agency.contracts);
      }
      const byName = Object.fromEntries(summary.agencies.map((agency) => [agency.agency, agency]));
      const acs = byName["Administration for Children's Services"];
      assert.equal(acs.contracts, 10);
      assert.equal(acs.first_paid_in_payment_years, 7);
      assert.equal(acs.horizons.within_6_months.observable_contracts, 10);
      assert.equal(acs.horizons.within_6_months.first_paid_within, 6);
      assert.equal(acs.horizons.within_12_months.observable_contracts, 6);
      assert.equal(acs.median_state, "measured");
      assert.equal(acs.median_days_to_first_payment, 170);
      const ddc = byName["Department of Design and Construction"];
      assert.equal(ddc.contracts, 12);
      assert.equal(ddc.first_paid_in_payment_years, 1);
      assert.equal(ddc.median_state, "over_6_months");
      assert.equal(ddc.median_days_to_first_payment, null);
      const dvs = byName["Department of Veterans' Services"];
      assert.equal(dvs.contracts, 2);
      assert.equal(dvs.median_state, "too_few_contracts");
      assert.equal(dvs.median_days_to_first_payment, null);
      // A contract first paid 180 days after an October 1 start is within six months (before April 1).
      const late = contracts.rows.find((row) => row.prime_contract_id === "CT106820261401576");
      assert.deepEqual([late.first_payment_date, late.days_to_first_payment], ["2026-03-30", 180]);
      // Rebuilding the same retained inputs is byte-stable and --check agrees.
      const first = readFileSync(output, "utf8");
      assert.equal(run(["tools/build_first_payment_timing.mjs", "--input", payments, "--receipt", receipt, "--contracts", CONTRACTS, "--output", output]).status, 0);
      assert.equal(readFileSync(output, "utf8"), first);
      const checked = run(["tools/build_first_payment_timing.mjs", "--check", "--input", payments, "--receipt", receipt, "--contracts", CONTRACTS, "--output", output]);
      assert.equal(checked.status, 0, checked.stderr);
    });
  });

  it("refuses inputs that do not match their receipt and keeps the public artifact live-only", async () => {
    await withFixturePopulation(async ({ stage, receipt, payments }) => {
      const output = join(stage, "timing.json");
      const build = () => run(["tools/build_first_payment_timing.mjs", "--input", payments, "--receipt", receipt, "--contracts", CONTRACTS, "--output", output]);
      const csv = readFileSync(payments, "utf8");
      writeFileSync(payments, csv.replace("2025-10-14", "2025-10-15"));
      assert.match(build().stderr, /checksum/i);
      writeFileSync(payments, `${csv.trimEnd().split("\n").slice(0, -1).join("\n")}\n`);
      assert.match(build().stderr, /row count/i);
      writeFileSync(payments, csv);
      const body = JSON.parse(readFileSync(receipt, "utf8"));
      writeFileSync(receipt, JSON.stringify({ ...body, reconciliation: { ...body.reconciliation, reconciled: false } }));
      assert.match(build().stderr, /reconciled/i);
      writeFileSync(receipt, JSON.stringify(body));
      const publicRun = run(["tools/build_first_payment_timing.mjs", "--input", payments, "--receipt", receipt, "--contracts", CONTRACTS]);
      assert.notEqual(publicRun.status, 0);
      assert.match(publicRun.stderr, /live-publisher/);
    });
  });

  it("never counts a reversal, a zero amount or an undated row as a first payment", () => {
    const contracts = [
      { prime_contract_id: "CT-A", agency: "Agency One", start_date: "2025-07-01" },
      { prime_contract_id: "CT-B", agency: "Agency One", start_date: "2025-07-01" },
      { prime_contract_id: "CT-C", agency: "Agency One", start_date: "2025-08-15" },
    ];
    const result = timing(contracts, [
      { contractId: "CT-A", issueDate: "2025-07-05", amount: -500 },
      { contractId: "CT-A", issueDate: "2025-07-06", amount: 0 },
      { contractId: "CT-A", issueDate: "2025-09-30", amount: 120 },
      { contractId: "CT-A", issueDate: "2025-08-30", amount: 80 },
      { contractId: "CT-B", issueDate: "", amount: 40 },
      { contractId: "CT-B", issueDate: "2025-07-02", amount: -40 },
      { contractId: "CT-Z", issueDate: "2025-07-02", amount: 99 },
    ]);
    const rows = Object.fromEntries(result.contracts.rows.map((row) => [row.prime_contract_id, row]));
    assert.equal(rows["CT-A"].first_payment_date, "2025-08-30");
    assert.equal(rows["CT-A"].days_to_first_payment, 60);
    assert.equal(rows["CT-B"].first_payment_date, null);
    assert.equal(rows["CT-B"].state, "no_payment_in_payment_years");
    assert.equal(rows["CT-C"].state, "no_payment_in_payment_years");
    assert.deepEqual(result.summary.population.payment_rows, { payment_rows: 7, positive_rows: 4, reversal_or_zero_rows: 3, undated_rows: 1, rows_for_measured_contracts: 2 });
  });

  it("counts a horizon only when its whole period lies inside the retained payment years", () => {
    assert.equal(horizonEnd("2025-07-01", 12), "2026-06-30");
    assert.equal(horizonEnd("2025-10-01", 6), "2026-03-31");
    assert.equal(horizonEnd("2026-01-31", 1), "2026-02-27");
    const contracts = [
      { prime_contract_id: "CT-1", agency: "Agency Two", start_date: "2025-07-01" },
      { prime_contract_id: "CT-2", agency: "Agency Two", start_date: "2026-05-15" },
      { prime_contract_id: "CT-3", agency: "Agency Two", start_date: "2026-06-30" },
      { prime_contract_id: "CT-1", agency: "Agency Two", start_date: "2025-07-01" },
      { prime_contract_id: "CT-4", agency: "Agency Two", start_date: null },
      { prime_contract_id: "", agency: "Agency Two", start_date: "2025-07-01" },
    ];
    const { summary } = timing(contracts, [{ contractId: "CT-2", issueDate: "2026-06-01", amount: 10 }]);
    const agency = summary.agencies[0];
    assert.equal(agency.contracts, 3);
    assert.deepEqual(summary.population.excluded, { start_before_payment_years: 0, start_after_payment_years: 0, missing_start_date: 1, missing_contract_id: 1, duplicate_contract_id: 1 });
    assert.deepEqual(agency.horizons.within_1_month, { observable_contracts: 2, first_paid_within: 1, not_observable_contracts: 1 });
    assert.deepEqual(agency.horizons.within_6_months, { observable_contracts: 1, first_paid_within: 0, not_observable_contracts: 2 });
    assert.deepEqual(agency.horizons.within_12_months, { observable_contracts: 1, first_paid_within: 0, not_observable_contracts: 2 });
    assert.equal(agency.median_state, "too_few_contracts");
  });

  it("states a median only from ten or more observable contracts with a measured middle value", () => {
    const contracts = Array.from({ length: 10 }, (_, i) => ({ prime_contract_id: `CT-${i}`, agency: "Agency Three", start_date: "2025-07-01" }));
    const paidFive = Array.from({ length: 5 }, (_, i) => ({ contractId: `CT-${i}`, issueDate: `2025-08-0${i + 1}`, amount: 1 }));
    assert.equal(timing(contracts, paidFive).summary.agencies[0].median_state, "over_6_months");
    const paidSix = [...paidFive, { contractId: "CT-5", issueDate: "2025-08-09", amount: 1 }];
    const agency = timing(contracts, paidSix).summary.agencies[0];
    assert.equal(agency.median_state, "measured");
    assert.equal(agency.median_days_to_first_payment, 37);
    assert.throws(() => fiscalYearCoverage([2025, 2027]), /consecutive/);
  });
});
