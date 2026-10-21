/**
 * Explicit tip tests that Actions-log text cannot carry bills or account ids
 * from the Worker all-meter / cost-control path.
 *
 * Receipt forbid alone is insufficient: this suite greps the public log surface
 * (release-evaluate JSON echo shape + deploy-worker cost-control workflow steps).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  scanActionsLogForBillAccountLeaks,
  scanCostControlActionsSources,
} from "./lib/worker_cost_actions_log_guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_WORKER = join(ROOT, ".github/workflows/deploy-worker.yml");

/**
 * Synthetic clean release-evaluate stdout. Deliberately does not call
 * evaluateAllMeterRelease: that gate's fixture builders live in its own suite,
 * and this test only needs to prove the Actions-log scanner accepts a
 * tariff-free decision echo with no bill/account fields.
 */
function cleanReleaseEvaluateStdout() {
  return JSON.stringify(
    {
      pass: true,
      tariff_free: true,
      regressions: [],
      candidate_normalized: {
        native_cpu_ms: 0.5,
        collector_cpu_ms: 1,
        kv_reads: 0,
        kv_writes: 0,
        d1_rows_read: 0,
        d1_rows_written: 0,
        storage_bytes: 10,
        queue_writes: 0,
        analytics_points: 0,
      },
      candidate_populations: {
        native_cpu_ms: 7,
        collector_cpu_ms: 1,
      },
    },
    null,
    2,
  );
}

test("Actions-log scanner flags bill and account-id leakage fixtures", () => {
  const leaked = [
    "release-evaluate wrote bill_usd: 17.9 into the step log",
    'candidate cloudflare_account_id="8162581cb1d97e20a172031adb8a13af"',
    "invoice_amount: 42.50 printed for operators",
    'monthly_bill={"usd":17.9}',
    "Cloudflare account 8162581cb1d97e20a172031adb8a13af appeared in stdout",
    "Monthly bill total $19.99 from the cost gate",
  ];
  for (const line of leaked) {
    const result = scanActionsLogForBillAccountLeaks(line);
    assert.equal(result.ok, false, line);
    assert.ok(result.findings.length >= 1, line);
  }
});

test("Actions-log scanner accepts clean all-meter release-evaluate stdout", () => {
  const stdout = cleanReleaseEvaluateStdout();
  const result = scanActionsLogForBillAccountLeaks(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.findings.length, 0);
});

test("Actions-log scanner rejects a release-evaluate echo that still carries bill fields", () => {
  const polluted = {
    pass: true,
    bill_usd: 17.9,
    account_id: "8162581cb1d97e20a172031adb8a13af",
  };
  const result = scanActionsLogForBillAccountLeaks(JSON.stringify(polluted, null, 2));
  assert.equal(result.ok, false);
  const rules = new Set(result.findings.map((f) => f.rule));
  assert.ok(rules.has("bill_field") || rules.has("account_field"));
});

test("Deploy worker cost-control workflow steps do not embed bill or account_id log fields", () => {
  const yaml = readFileSync(DEPLOY_WORKER, "utf8");
  // Bound the scan to cost-control / all-meter steps so unrelated analytics
  // bindings elsewhere in the repo are not mistaken for this letter.
  const start = yaml.indexOf("Resolve Worker cost-control enforcement");
  const end = yaml.indexOf("Apply D1 migrations");
  assert.ok(start >= 0, "cost-control enforcement step missing");
  assert.ok(end > start, "D1 migrations marker missing after cost-control block");
  const costBlock = yaml.slice(start, end);
  const result = scanCostControlActionsSources([
    { label: "deploy-worker.yml#cost-control", text: costBlock },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.failed, null, 2));
});
