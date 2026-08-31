#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  assertColdReceipt,
  auditTimingPolicy,
  buildCacheBustKey,
  classifyBuildFailure,
  classifyCacheMode,
  createCanaryReceipt,
} from "./lib/cold_build_canary.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "audit") args.audit = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sourceIdentity(sourceDir, siteDir) {
  const commitSha = git("-C", sourceDir, "rev-parse", "HEAD");
  const output = execFileSync(process.execPath, [
    join(sourceDir, "tools/site_artifact_identity.mjs"),
    "identity",
    "--commit-sha",
    commitSha,
    "--source-dir",
    sourceDir,
    "--site-dir",
    siteDir,
  ], { cwd: sourceDir, encoding: "utf8" });
  return JSON.parse(output);
}

function resolvePolicy(sourceDir, path) {
  return readJson(resolve(sourceDir, path || "tools/cold_build_canary_policy.json"));
}

function checkReceipt(args) {
  const sourceDir = resolve(args["source-dir"] || ".");
  const policy = resolvePolicy(sourceDir, args.policy);
  const receipt = readJson(resolve(args.receipt));
  const audit = assertColdReceipt(receipt, policy);
  process.stdout.write(`verified cold-build receipt: ${receipt.result}, ${receipt.wall_clock_ms}ms, ${receipt.stages.length} stages\n`);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

function auditOnly(args) {
  const sourceDir = resolve(args["source-dir"] || ".");
  const audit = auditTimingPolicy(resolvePolicy(sourceDir, args.policy));
  if (args.output) writeJson(resolve(args.output), audit);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

function execute(args) {
  const sourceDir = resolve(args["source-dir"] || ".");
  const sourceReal = realpathSync(sourceDir);
  const policy = resolvePolicy(sourceDir, args.policy);
  const timingAudit = auditTimingPolicy(policy);
  const outputRoot = args["output-root"]
    ? resolve(args["output-root"])
    : mkdtempSync(join(tmpdir(), "cityscroll-cold-build-"));
  const siteDir = resolve(args["site-dir"] || join(outputRoot, "site"));
  if (siteDir === sourceReal || siteDir.startsWith(`${sourceReal}${sep}`)) {
    throw new Error(`cold-build canary requires an isolated site output: ${relative(sourceReal, siteDir)}`);
  }
  const identity = sourceIdentity(sourceDir, siteDir);
  const canaryId = args["canary-id"] || process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
  const receiptPath = resolve(args.receipt || join(outputRoot, "cold-build-canary.json"));
  const timingPath = resolve(args["timing-receipt"] || join(outputRoot, "pages-build-timing.json"));
  const cache = {
    ...classifyCacheMode(),
    strategy: "isolated-output-no-restore",
    cache_bust_key: buildCacheBustKey(identity.build_input_identity, canaryId),
    canary_id: canaryId,
  };
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [
    join(sourceDir, "tools/build_cloudflare_pages.mjs"),
    "--source-dir", sourceDir,
    "--site-dir", siteDir,
    "--commit-sha", identity.commit_sha,
    "--timing-receipt", timingPath,
  ], {
    cwd: sourceDir,
    stdio: "inherit",
    env: {
      ...process.env,
      CITYSCROLL_BUILD_TIMING_RECEIPT: timingPath,
    },
    timeout: Number(policy.thresholds.miss_max_seconds) * 1000,
  });
  const wallClockMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  let stageReceipt = { stages: [], result: "missing" };
  try {
    stageReceipt = readJson(timingPath);
  } catch {
    // The top-level failure classification below remains explicit when the build
    // could not start far enough to write its stage receipt.
  }
  let derivedReceipt = null;
  try {
    derivedReceipt = readJson(`${timingPath}.derived.json`);
  } catch {
    // A failed family cannot produce a completed family receipt; the stage receipt
    // still identifies the failing build boundary.
  }
  const failure = classifyBuildFailure({
    status: result.status,
    signal: result.signal,
    spawnError: result.error,
  });
  const receipt = createCanaryReceipt({
    identity,
    cache,
    result: failure ? "fail" : "pass",
    failure,
    wallClockMs,
    timingAudit,
    stages: stageReceipt.stages || [],
    buildFamilies: derivedReceipt?.families || [],
  });
  writeJson(receiptPath, receipt);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "### Cold-build canary",
      "",
      `Result: **${receipt.result}**; cache mode: **${cache.mode}**; wall clock: **${receipt.wall_clock_ms}ms**.`,
      `Input identity: \`${identity.build_input_identity}\`; timing threshold: ${receipt.threshold_seconds}s (calibrated from cache-miss samples).`,
      failure ? `Failure class: **${failure.class}** — ${failure.reason}` : `Stages recorded: ${receipt.stages.length}; derived families recorded: ${receipt.build_families.length}.`,
      "",
    ].join("\n"), { flag: "a" });
  }
  process.stdout.write(`cold-build canary receipt: ${receiptPath}\n`);
  if (failure) process.exitCode = 1;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args["check-receipt"]) checkReceipt({ ...args, receipt: args["check-receipt"] });
  else if (args.audit) auditOnly(args);
  else execute(args);
} catch (error) {
  process.stderr.write(`cold-build canary: ${error.message}\n`);
  process.exitCode = 1;
}
