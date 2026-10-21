/**
 * Explicit tip tests that Actions-log text cannot carry bills or account ids
 * from the Worker all-meter / cost-control path.
 *
 * Receipt forbid alone is insufficient: this suite greps the public log surface
 * (release-evaluate JSON echo shape + deploy-worker cost-control workflow steps)
 * and proves findings stay value-free so a failing assert cannot re-echo secrets.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  scanActionsLogForBillAccountLeaks,
  scanCliEmissionSurfaces,
  scanCostControlActionsSources,
} from "./lib/worker_cost_actions_log_guard.mjs";
import {
  CLI_SAFE_ERROR_CODES,
  formatGuardedCliError,
  guardCliResultPayload,
} from "./worker_cost_control.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_WORKER = join(ROOT, ".github/workflows/deploy-worker.yml");
const CLI = join(ROOT, "tools/worker_cost_control.mjs");

/** Distinctive synthetic 32-hex account id — never a real Cloudflare account. */
const SYNTHETIC_ACCOUNT = "0123456789abcdef0123456789abcdef";
/** Distinctive bill sentinel used only to prove value-free diagnostics. */
const BILL_SENTINEL = "91731.55";
const ACCOUNT_SENTINEL = "f00dcafe0123456789abcdef01234567";
/** Path-segment sentinel proving ENOENT diagnostics stay value-free. */
const PATH_SENTINEL = "ZZZLEAKSENTINEL999";

function runCli(args, { cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
}

function assertCombinedOmitsSentinels(run, sentinels) {
  const combined = `${run.stdout || ""}\n${run.stderr || ""}`;
  for (const sentinel of sentinels) {
    assert.equal(
      combined.includes(sentinel),
      false,
      `CLI output must not contain sentinel ${sentinel}; got: ${combined.slice(0, 240)}`,
    );
  }
}

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

function assertFindingsValueFree(findings, sentinels) {
  const serialized = JSON.stringify(findings);
  for (const sentinel of sentinels) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `finding diagnostics must not contain sentinel ${sentinel}`,
    );
  }
  for (const finding of findings) {
    assert.equal(typeof finding.rule, "string");
    assert.equal(Object.hasOwn(finding, "excerpt"), false);
    assert.equal(Object.hasOwn(finding, "match"), false);
    assert.equal(Object.hasOwn(finding, "value"), false);
  }
}

test("Actions-log scanner flags bill and account-id leakage fixtures", () => {
  const leaked = [
    "release-evaluate wrote bill_usd: 17.9 into the step log",
    `candidate cloudflare_account_id="${SYNTHETIC_ACCOUNT}"`,
    "invoice_amount: 42.50 printed for operators",
    "monthly_bill={\"usd\":17.9}",
    `Cloudflare account ${SYNTHETIC_ACCOUNT} appeared in stdout`,
    "Monthly bill total $19.99 from the cost gate",
  ];
  for (const line of leaked) {
    const result = scanActionsLogForBillAccountLeaks(line);
    assert.equal(result.ok, false, line);
    assert.ok(result.findings.length >= 1, line);
    assertFindingsValueFree(result.findings, [SYNTHETIC_ACCOUNT, "17.9", "42.50", "19.99"]);
  }
});

test("Actions-log scanner accepts clean all-meter release-evaluate stdout", () => {
  const stdout = cleanReleaseEvaluateStdout();
  const result = scanActionsLogForBillAccountLeaks(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test("Actions-log scanner rejects a release-evaluate echo that still carries bill fields", () => {
  const polluted = {
    pass: true,
    bill_usd: 17.9,
    account_id: SYNTHETIC_ACCOUNT,
  };
  const result = scanActionsLogForBillAccountLeaks(JSON.stringify(polluted, null, 2));
  assert.equal(result.ok, false);
  const rules = new Set(result.findings.map((f) => f.rule));
  assert.ok(rules.has("bill_field") || rules.has("account_field"));
  assertFindingsValueFree(result.findings, [SYNTHETIC_ACCOUNT, "17.9"]);
});

test("value-free findings never echo a distinctive bill or account sentinel", () => {
  const polluted = [
    `bill_usd: ${BILL_SENTINEL}`,
    `account_id="${ACCOUNT_SENTINEL}"`,
    `Cloudflare account ${ACCOUNT_SENTINEL} in step summary`,
    `Monthly bill total $${BILL_SENTINEL}`,
  ].join("\n");
  const result = scanActionsLogForBillAccountLeaks(polluted, { path: "fixture:sentinel" });
  assert.equal(result.ok, false);
  assertFindingsValueFree(result.findings, [BILL_SENTINEL, ACCOUNT_SENTINEL]);
  for (const finding of result.findings) {
    assert.equal(finding.path, "fixture:sentinel");
  }

  // Prove a failing assert.equal on findings cannot re-echo the sentinels either.
  const diagnostic = JSON.stringify({ ok: result.ok, findings: result.findings });
  assert.equal(diagnostic.includes(BILL_SENTINEL), false);
  assert.equal(diagnostic.includes(ACCOUNT_SENTINEL), false);
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
  assert.equal(result.ok, true);
  assert.equal(result.failed.length, 0);
});

test("CLI emission surface scanner covers stdout stderr and diagnostics", () => {
  const clean = scanCliEmissionSurfaces({
    stdout: cleanReleaseEvaluateStdout(),
    stderr: "",
    path: "release-evaluate",
  });
  assert.equal(clean.ok, true);

  const dirty = scanCliEmissionSurfaces({
    stdout: JSON.stringify({ pass: true }),
    stderr: `account_id=${ACCOUNT_SENTINEL}`,
    diagnostics: `bill_usd: ${BILL_SENTINEL}`,
    path: "release-evaluate",
  });
  assert.equal(dirty.ok, false);
  assertFindingsValueFree(dirty.findings, [ACCOUNT_SENTINEL, BILL_SENTINEL]);
  const paths = new Set(dirty.findings.map((f) => f.path));
  assert.ok(paths.has("release-evaluate#stderr") || paths.has("release-evaluate#diagnostics"));
});

test("shared CLI result guard refuses a polluted payload without echoing sentinels", () => {
  const polluted = {
    pass: true,
    bill_usd: Number(BILL_SENTINEL),
    account_id: ACCOUNT_SENTINEL,
  };
  const guarded = guardCliResultPayload(polluted);
  assert.equal(guarded.ok, false);
  assert.equal(guarded.stream, "stderr");
  assert.equal(guarded.text.includes(ACCOUNT_SENTINEL), false);
  assert.equal(guarded.text.includes(BILL_SENTINEL), false);
  assert.match(guarded.text, /emission refused/);
  const diagnostic = JSON.parse(guarded.text);
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.code, "emission_refused_result");
  assertFindingsValueFree(diagnostic.findings, [ACCOUNT_SENTINEL, BILL_SENTINEL]);
});

test("real CLI missing-input path with sentinel stays value-free on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-actions-log-cli-"));
  try {
    const missing = join(dir, `absent-${PATH_SENTINEL}.json`);
    const run = runCli(["profile-check", "--input", missing]);
    assert.notEqual(run.status, 0);
    assert.equal((run.stdout || "").trim(), "");
    assertCombinedOmitsSentinels(run, [PATH_SENTINEL, missing, dir]);
    const diagnostic = JSON.parse((run.stderr || "").trim());
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.code, "input_unreadable");
    assert.equal(diagnostic.error, CLI_SAFE_ERROR_CODES.input_unreadable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI malformed JSON stays value-free on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-actions-log-cli-"));
  try {
    const bad = join(dir, `malformed-${PATH_SENTINEL}.json`);
    writeFileSync(bad, `{"account_id":"${ACCOUNT_SENTINEL}","bill_usd":${BILL_SENTINEL},`);
    const run = runCli(["profile-check", "--input", bad]);
    assert.notEqual(run.status, 0);
    assert.equal((run.stdout || "").trim(), "");
    assertCombinedOmitsSentinels(run, [PATH_SENTINEL, ACCOUNT_SENTINEL, BILL_SENTINEL, bad]);
    const diagnostic = JSON.parse((run.stderr || "").trim());
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.code, "input_invalid_json");
    assert.equal(diagnostic.error, CLI_SAFE_ERROR_CODES.input_invalid_json);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real CLI evaluator rejection stays value-free on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "cityscroll-actions-log-cli-"));
  try {
    const input = join(dir, `reject-${PATH_SENTINEL}.json`);
    writeFileSync(
      input,
      JSON.stringify({
        schema_version: 1,
        account_id: ACCOUNT_SENTINEL,
        bill_usd: Number(BILL_SENTINEL),
      }),
    );
    const run = runCli(["profile-check", "--input", input]);
    assert.notEqual(run.status, 0);
    assert.equal((run.stdout || "").trim(), "");
    assertCombinedOmitsSentinels(run, [PATH_SENTINEL, ACCOUNT_SENTINEL, BILL_SENTINEL, input]);
    const diagnostic = JSON.parse((run.stderr || "").trim());
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.code, "evaluator_rejected");
    assert.equal(diagnostic.error, CLI_SAFE_ERROR_CODES.evaluator_rejected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatGuardedCliError never echoes a raw Error message with a sentinel", () => {
  const raw = new Error(`ENOENT: no such file or directory, open '/tmp/absent-${PATH_SENTINEL}.json'`);
  raw.code = "ENOENT";
  const diagnostic = formatGuardedCliError(raw);
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.code, "input_unreadable");
  assert.equal(JSON.stringify(diagnostic).includes(PATH_SENTINEL), false);
});
