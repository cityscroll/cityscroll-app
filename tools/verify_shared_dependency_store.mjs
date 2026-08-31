#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : null;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, {
  cwd: options.cwd || root,
  env: options.env || process.env,
  encoding: "utf8",
  stdio: options.capture ? "pipe" : "inherit",
});
const attempt = (command, commandArgs, options = {}) => spawnSync(command, commandArgs, {
  cwd: options.cwd || root,
  env: options.env || process.env,
  encoding: "utf8",
  timeout: options.timeout || 20_000,
});

function treeIdentity(directory) {
  const rows = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile()) {
        const stat = statSync(item);
        rows.push(`${relative(directory, item)}\0${stat.size}`);
      }
    }
  };
  visit(directory);
  return { object_count: rows.length, inventory_sha256: sha256(`${rows.join("\n")}\n`) };
}

function sizes(directory) {
  const logicalKb = Number(run("du", ["-sk", directory], { capture: true }).split(/\s+/)[0]);
  const allocated = attempt("du", ["-skA", directory], { cwd: root });
  const allocatedKb = allocated.status === 0
    ? Number(allocated.stdout.split(/\s+/)[0])
    : logicalKb;
  return { logical_bytes: logicalKb * 1024, allocated_bytes: allocatedKb * 1024 };
}

const temporary = mkdtempSync(join(tmpdir(), "cityscroll-pnpm-proof-"));
const store = join(temporary, "shared-store");
const first = join(temporary, "checkout-a");
const second = join(temporary, "checkout-b");
const baseline = join(temporary, "baseline-checkout");
const missingStore = join(temporary, "missing-store");
const revision = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const lockfile = readFileSync(join(root, "worker/pnpm-lock.yaml"));
const packageJson = JSON.parse(readFileSync(join(root, "worker/package.json"), "utf8"));
const managerVersion = packageJson.packageManager.replace("pnpm@", "");
const environment = { ...process.env, CITYSCROLL_PNPM_STORE_DIR: store };

try {
  run("git", ["clone", "--quiet", "--no-checkout", root, first]);
  run("git", ["clone", "--quiet", "--no-checkout", root, second]);
  run("git", ["clone", "--quiet", "--no-checkout", root, baseline]);
  run("git", ["checkout", "--quiet", "--detach", revision], { cwd: first });
  run("git", ["checkout", "--quiet", "--detach", revision], { cwd: second });
  run("git", ["checkout", "--quiet", "--detach", `${revision}^`], { cwd: baseline });
  const startedBaseline = Date.now();
  run("npm", ["ci"], { cwd: join(baseline, "worker") });
  const baselineSize = sizes(join(baseline, "worker/node_modules"));
  const baselineMs = Date.now() - startedBaseline;
  const startedCold = Date.now();
  run(join(first, "tools/install_worker_dependencies.sh"), ["--package-import-method=clone-or-copy"], { cwd: first, env: environment });
  const coldMs = Date.now() - startedCold;
  const storeAfterCold = treeIdentity(store);
  const startedWarm = Date.now();
  run(join(second, "tools/install_worker_dependencies.sh"), ["--offline", "--package-import-method=clone-or-copy"], { cwd: second, env: environment });
  const warmMs = Date.now() - startedWarm;
  const storeAfterWarm = treeIdentity(store);

  const firstSize = sizes(join(first, "worker/node_modules"));
  const secondSize = sizes(join(second, "worker/node_modules"));
  const storeSize = sizes(store);
  const mismatchedPackage = JSON.parse(readFileSync(join(second, "worker/package.json"), "utf8"));
  mismatchedPackage.packageManager = "pnpm@0.0.0";
  writeFileSync(join(second, "worker/package.json"), `${JSON.stringify(mismatchedPackage, null, 2)}\n`);
  const mismatch = attempt(join(second, "tools/install_worker_dependencies.sh"), ["--offline"], { cwd: second, env: environment });
  rmSync(join(second, "worker/node_modules"), { recursive: true, force: true });
  const missing = attempt(join(second, "tools/install_worker_dependencies.sh"), ["--offline"], {
    cwd: second,
    env: { ...process.env, CITYSCROLL_PNPM_STORE_DIR: missingStore },
  });
  const budget = 500 * 1024 * 1024;
  const receipt = {
    schema: "cityscroll.shared-dependency-store-receipt.v1",
    revision,
    lockfile: { path: "worker/pnpm-lock.yaml", sha256: sha256(lockfile) },
    package_manager: packageJson.packageManager,
    node_version: process.version,
    measured_baseline: { package_manager: "npm", duration_ms: baselineMs, ...baselineSize },
    store: { configured_outside_checkout: true, identity: storeAfterWarm, ...storeSize },
    cold_install: { network_mode: "online", duration_ms: coldMs, store_identity: storeAfterCold },
    warm_install: {
      network_mode: "offline",
      duration_ms: warmMs,
      reused_identical_store_objects: JSON.stringify(storeAfterCold) === JSON.stringify(storeAfterWarm),
      store_identity: storeAfterWarm,
    },
    materialization: { mode: "pnpm virtual store with clone-or-copy package import", sibling_node_modules_reference: false },
    dependency_views: [
      { id: "a", ...firstSize, physical_budget_bytes: budget, pass: firstSize.allocated_bytes < budget },
      { id: "b", ...secondSize, physical_budget_bytes: budget, pass: secondSize.allocated_bytes < budget },
    ],
    measurement: {
      logical: "du -sk on each isolated worker/node_modules view",
      allocated: "du -skA on each isolated worker/node_modules view where supported; du -sk fallback",
      filesystem: run("stat", ["-f", "%T", temporary], { capture: true }).trim(),
      shared_store_counted_once: true,
    },
    fail_closed: {
      missing_store_offline_failed: missing.status !== 0,
      package_manager_mismatch_failed: mismatch.status !== 0,
    },
  };
  const pass = receipt.warm_install.reused_identical_store_objects
    && receipt.dependency_views.every((entry) => entry.pass)
    && Object.values(receipt.fail_closed).every(Boolean);
  receipt.pass = pass;
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (output) writeFileSync(output, rendered);
  process.stdout.write(rendered);
  if (!pass) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
