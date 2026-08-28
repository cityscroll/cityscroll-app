import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  analyzeSource,
  discoverGateRoots,
  lintRepository,
} from "../tools/determinism_lint.mjs";

function fixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), "cityscroll-determinism-lint-"));
}

function put(root, relative, contents) {
  const target = path.join(root, relative);
  const directory = path.dirname(target);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(target, contents);
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
  assert.deepEqual(findings.map((finding) => finding.category), ["external-data", "network"]);
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

test("A3 reports check-mode writes but permits a reasoned injected dependency", () => {
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

test("the repository lint is green and read-only", () => {
  const before = lintRepository({ changedOnly: true });
  assert.deepEqual(before.findings, []);
  assert.equal(existsSync(path.join(process.cwd(), ".artifacts", "determinism-lint-receipt.json")), false);
});
