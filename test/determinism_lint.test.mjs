import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeSource,
  canonicalEvidence,
  discoverGateRoots,
  lintRepository,
  lintSiteProduction,
  resolveFixtureRoot,
  stableStringify,
} from "../tools/determinism_lint.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = path.join(ROOT, "tools", "determinism_lint.mjs");
const FIXTURE = path.join(ROOT, "test", "fixtures", "determinism-lint");
const RECEIPT = path.join(FIXTURE, "expected", "receipt.json");

function fixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), "cityscroll-determinism-lint-"));
}

function put(root, relative, contents) {
  const target = path.join(root, relative);
  const directory = path.dirname(target);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(target, contents);
}

function digest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runLint(args, { cwd = ROOT, env = {}, now } = {}) {
  const command = [TOOL, ...args];
  if (now) command.push("--now", now);
  return spawnSync(process.execPath, command, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("A1 reports clock, timezone, and random inputs with line remediation", () => {
  const findings = analyzeSource({
    root: "/repo",
    filePath: "/repo/tools/gate.mjs",
    source: [
      `const started = Date.${"now"}();`,
      `const local = new ${"Date"}();`,
      `const label = new ${"Date"}(value).toLocaleString();`,
      "const id = Math.random();",
    ].join("\n"),
  });
  assert.deepEqual(findings.map((finding) => [finding.category, finding.line]), [
    ["clock", 1], ["clock", 2], ["timezone", 3], ["random", 4],
  ]);
  assert.match(findings[0].remediation, /inject a fixed clock/i);
  assert.equal(findings[0].path, "tools/gate.mjs");
});

test("A2 reports live network and mutable external-data inputs", () => {
  const findings = analyzeSource({
    root: "/repo",
    filePath: "/repo/tools/gate.mjs",
    source: [
      "const response = await fetch(PRODUCTION_ORIGIN);",
      "run('--from-live');",
    ].join("\n"),
  });
  assert.deepEqual(findings.map((finding) => finding.category), ["external-data", "network", "external-data"]);
  assert.match(findings[0].remediation, /fixture|monitor/i);
});

test("A2 also reports live commands written directly in a required workflow", () => {
  const root = fixtureRoot();
  try {
    put(root, ".github/workflows/ci.yml", `name: CI\non:\n  pull_request:\njobs:\n  gate:\n    steps:\n      - run: |\n          node tools/gate.mjs --check\n          curl https://production.example.test/health\n`);
    put(root, "tools/gate.mjs", "export const fixture = true;\n");
    const report = lintRepository({ root });
    assert.ok(report.findings.some((finding) => finding.category === "network" && finding.path === ".github/workflows/ci.yml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports check-mode writes but permits a reasoned injected dependency", () => {
  const findings = analyzeSource({
    root: "/repo",
    filePath: "/repo/tools/gate.mjs",
    source: [
      "const now = Date.now();",
      "// determinism-lint: inject clock from the fixed fixture",
      `const injected = Date.${"now"}();`,
      "if (check) writeFileSync(output, body);",
    ].join("\n"),
  });
  assert.deepEqual(findings.map((finding) => [finding.category, finding.line]), [["clock", 1], ["write", 4]]);
});

test("an explicit now parameter default is injected, not ambient", () => {
  const findings = analyzeSource({
    root: "/repo",
    filePath: "/repo/tools/gate.mjs",
    source: "export function check({ now = Date.now() } = {}) {\n  return new Date(now).toISOString();\n}\n",
  });
  assert.deepEqual(findings, []);
});

test("write-mode mutations after a check return are not check-mode writes", () => {
  const findings = analyzeSource({
    root: "/repo",
    filePath: "/repo/tools/gate.mjs",
    source: [
      "export function main(check) {",
      "  if (check) {",
      "    return 0;",
      "  }",
      "  if (!check) {",
      "    writeFileSync('receipt.json', '{}');",
      "  }",
      "}",
    ].join("\n"),
  });
  assert.deepEqual(findings, []);
});

test("reachability starts at required --check workflows and excludes schedule-only monitors", () => {
  const root = fixtureRoot();
  try {
    put(root, ".github/workflows/ci.yml", `name: CI\non:\n  pull_request:\njobs:\n  gate:\n    steps:\n      - run: node tools/gate.mjs --check\n`);
    put(root, ".github/workflows/monitor.yml", `name: Monitor\non:\n  schedule:\n    - cron: "17 * * * *"\njobs:\n  monitor:\n    steps:\n      - run: node tools/monitor.mjs --check\n`);
    put(root, "tools/gate.mjs", "import './helper.mjs';\n");
    put(root, "tools/helper.mjs", `export const current = new ${"Date"}();\n`);
    put(root, "tools/monitor.mjs", "export const live = fetch('https://example.test');\n");
    const report = lintRepository({ root });
    assert.equal(report.gates.length, 1);
    assert.equal(report.monitors.length, 1);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].path, "tools/helper.mjs");
    assert.equal(report.findings[0].category, "clock");
    assert.deepEqual(discoverGateRoots({ root }).monitors.map((entry) => entry.sourcePath.endsWith("monitor.mjs")), [true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed fixtures cover positive, negative, allowlisted, and non-gate cases", () => {
  const { root } = resolveFixtureRoot(FIXTURE);
  const report = lintRepository({ root });
  report.site = lintSiteProduction({ root });
  const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
  assert.deepEqual(canonicalEvidence(report, { root }), receipt);
  assert.equal(report.monitors.length, 1);
  assert.ok(report.monitors[0].workflow.includes("monitor.yml"));
  assert.ok(report.findings.some((finding) => finding.path === "tools/helper_clock.mjs" && finding.category === "clock"));
  assert.ok(report.findings.some((finding) => finding.path === "tools/negative_clock.mjs" && finding.category === "timezone"));
  assert.ok(report.findings.some((finding) => finding.path === "tools/negative_network.mjs" && finding.category === "network"));
  assert.ok(report.findings.some((finding) => finding.path === "tools/negative_external.mjs" && finding.category === "external-data"));
  assert.ok(report.findings.some((finding) => finding.path === "tools/negative_write.mjs" && finding.category === "write"));
  assert.equal(report.findings.some((finding) => finding.path === "tools/allowlisted_gate.mjs"), false);
  assert.equal(report.findings.some((finding) => finding.path === "tools/injected_now.mjs"), false);
  assert.equal(report.findings.some((finding) => finding.path === "tools/positive_gate.mjs"), false);
  assert.equal(report.findings.some((finding) => finding.path === "tools/write_mode.mjs"), false);
  assert.equal(report.findings.some((finding) => finding.path === "tools/monitor_live.mjs"), false);
});

test("A3 replays --check across a 48-hour clock advance and UTC/New York timezones", () => {
  const before = digest(RECEIPT);
  const start = "2026-08-18T12:00:00.000Z";
  const advanced = "2026-08-20T12:00:00.000Z";
  const utc = runLint(["--check", "--fixture", "test/fixtures/determinism-lint"], {
    env: { TZ: "UTC" },
    now: start,
  });
  const newYork = runLint(["--check", "--fixture", "test/fixtures/determinism-lint"], {
    env: { TZ: "America/New_York" },
    now: advanced,
  });
  assert.equal(utc.status, 0, utc.stderr);
  assert.equal(newYork.status, 0, newYork.stderr);
  assert.equal(utc.stdout, newYork.stdout);
  assert.match(utc.stdout, /scheduled monitor roots excluded/);
  assert.equal(digest(RECEIPT), before);
  const { root } = resolveFixtureRoot(FIXTURE);
  const report = lintRepository({ root });
  report.site = lintSiteProduction({ root });
  const evidence = stableStringify(canonicalEvidence(report, { root }));
  assert.equal(evidence, readFileSync(RECEIPT, "utf8"));
});

test("A3 proves --check never writes the baseline or generated receipt", () => {
  const before = digest(RECEIPT);
  const mtime = statSync(RECEIPT).mtimeMs;
  const artifact = path.join(ROOT, ".artifacts", "determinism-lint-receipt.json");
  assert.equal(existsSync(artifact), false);
  const generated = path.join(FIXTURE, "repo", "generated", "receipt.json");
  const baseline = path.join(FIXTURE, "repo", "baseline.json");
  assert.equal(existsSync(generated), false);
  assert.equal(existsSync(baseline), false);

  const result = runLint(["--check", "--fixture", "test/fixtures/determinism-lint"], {
    env: { TZ: "America/New_York" },
    now: "2026-08-20T12:00:00.000Z",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(digest(RECEIPT), before);
  assert.equal(statSync(RECEIPT).mtimeMs, mtime);
  assert.equal(existsSync(artifact), false);
  assert.equal(existsSync(generated), false);
  assert.equal(existsSync(baseline), false);
  const mixed = runLint(["--check", "--write-receipt"]);
  assert.equal(mixed.status, 2);
});

test("the repository lint is green and read-only", () => {
  const before = lintRepository({ changedOnly: true });
  assert.deepEqual(before.findings, []);
  assert.equal(existsSync(path.join(process.cwd(), ".artifacts", "determinism-lint-receipt.json")), false);
  const result = runLint(["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(process.cwd(), ".artifacts", "determinism-lint-receipt.json")), false);
});
