#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const SCHEMA = "cityscroll.derived_json_build_receipt.v1";

function parseArgs(argv) {
  const args = { sourceDir: ".", receipt: null, timingReceipt: null, validateOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-dir") args.sourceDir = argv[++index];
    else if (arg === "--receipt") args.receipt = argv[++index];
    else if (arg === "--timing-receipt") args.timingReceipt = argv[++index];
    else if (arg === "--validate-only") args.validateOnly = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return args;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function absolute(sourceDir, path) {
  return resolve(sourceDir, path);
}

function fileHash(sourceDir, path) {
  const target = absolute(sourceDir, path);
  return sha256(readFileSync(target));
}

function assertFile(sourceDir, path, label) {
  try {
    if (!statSync(absolute(sourceDir, path)).isFile()) throw new Error("not a file");
  } catch (error) {
    throw new Error(`${label} missing: ${path} (${error.message})`);
  }
}

function assertSourceSnapshot(sourceDir, manifest) {
  const snapshot = manifest.source_snapshot;
  if (!snapshot?.path || !snapshot.sha256) throw new Error("source snapshot declaration is incomplete");
  assertFile(sourceDir, snapshot.path, "source snapshot");
  const actualHash = fileHash(sourceDir, snapshot.path);
  if (actualHash !== snapshot.sha256) {
    throw new Error(`source snapshot is stale: ${snapshot.path} hash ${actualHash} != ${snapshot.sha256}`);
  }

  const sourceManifest = readJson(absolute(sourceDir, snapshot.path));
  const updatedAt = Date.parse(sourceManifest.updated_at || "");
  const maxAgeDays = Number(snapshot.max_age_days);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new Error("source snapshot freshness metadata is missing or invalid");
  }
  if (Date.now() - updatedAt > maxAgeDays * 24 * 60 * 60 * 1000) {
    throw new Error(`source snapshot is stale by age: ${snapshot.path}`);
  }
  for (const receipt of snapshot.required_receipts || []) {
    assertFile(sourceDir, receipt, "source snapshot receipt");
    const expectedHash = snapshot.required_receipt_hashes?.[receipt];
    if (!expectedHash) throw new Error(`source snapshot receipt hash is missing: ${receipt}`);
    const actualReceiptHash = fileHash(sourceDir, receipt);
    if (actualReceiptHash !== expectedHash) {
      throw new Error(`source snapshot receipt is stale: ${receipt} hash ${actualReceiptHash} != ${expectedHash}`);
    }
  }
  const loaded = sourceManifest.loaded || [];
  if (!Array.isArray(loaded) || !loaded.length) throw new Error("source snapshot has no loaded datasets");
  for (const receipt of snapshot.required_receipts || []) {
    if (!loaded.some((entry) => entry.proof_receipt === receipt)) {
      throw new Error(`source snapshot does not retain required receipt: ${receipt}`);
    }
  }
  return { path: snapshot.path, sha256: actualHash, updated_at: sourceManifest.updated_at };
}

function filesUnder(sourceDir, path) {
  const target = absolute(sourceDir, path);
  const stat = statSync(target);
  if (stat.isFile()) return [path];
  const files = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(sourceDir, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

function outputHashes(sourceDir, paths) {
  return paths.flatMap((path) => filesUnder(sourceDir, path)).map((path) => ({
    path: path.replaceAll("\\", "/"),
    sha256: fileHash(sourceDir, path),
    bytes: readFileSync(absolute(sourceDir, path)).byteLength,
  }));
}

function run(sourceDir, tool, args = []) {
  const command = process.execPath;
  const target = absolute(sourceDir, tool);
  console.log(`$ ${command} ${tool} ${args.join(" ")}`);
  const result = spawnSync(command, [target, ...args], { cwd: sourceDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function validateManifest(sourceDir, manifest) {
  if (manifest.schema !== "cityscroll.derived_json_build_manifest.v1") throw new Error("invalid derived JSON build manifest schema");
  if (manifest.delivery?.public_tree !== "site/data") throw new Error("derived JSON build boundary must publish site/data");
  if (manifest.delivery?.request_time_source_reads !== false) throw new Error("derived JSON build boundary permits request-time source reads");
  if (!Array.isArray(manifest.generated_families) || !manifest.generated_families.length) throw new Error("derived JSON build manifest has no generated families");
  const ids = new Set();
  for (const family of manifest.generated_families) {
    if (!family.id || ids.has(family.id)) throw new Error(`duplicate or missing generated family id: ${family.id}`);
    ids.add(family.id);
    if (!family.generator || !family.source_paths?.length || !family.output_paths?.length) throw new Error(`incomplete generated family: ${family.id}`);
    assertFile(sourceDir, family.generator, `generator for ${family.id}`);
    for (const path of family.source_paths) assertFile(sourceDir, path, `source for ${family.id}`);
  }
}

function main() {
  const startedAt = performance.now();
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(args.sourceDir);
  const manifestPath = absolute(sourceDir, "warehouse/derived_json_build_manifest.json");
  const manifest = readJson(manifestPath);
  validateManifest(sourceDir, manifest);
  const sourceSnapshot = assertSourceSnapshot(sourceDir, manifest);
  if (args.validateOnly) {
    console.log(`Derived JSON build boundary valid (snapshot ${sourceSnapshot.sha256})`);
    return;
  }
  const families = [];

  for (const family of manifest.generated_families) {
    const familyStartedAt = performance.now();
    const sourceHashes = Object.fromEntries(family.source_paths.map((path) => [path, fileHash(sourceDir, path)]));
    run(sourceDir, family.generator);
    run(sourceDir, family.generator, ["--check"]);
    families.push({
      id: family.id,
      generator: family.generator,
      duration_ms: Math.round(performance.now() - familyStartedAt),
      source_hashes: sourceHashes,
      outputs: outputHashes(sourceDir, family.output_paths),
    });
  }

  const elapsedMs = performance.now() - startedAt;
  // This boundary runs only when generated artifacts are rebuilt. Its elapsed time
  // therefore measures the cold build; cached artifact jobs do not invoke it.
  const budget = manifest.ci_time_budget;
  if (budget?.mode !== "cold-build") throw new Error("derived JSON CI time budget must be explicitly marked cold-build");
  const budgetSeconds = Number(budget.seconds);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error("derived JSON cold-build CI time budget is missing or invalid");
  if (elapsedMs > budgetSeconds * 1000) {
    throw new Error(`derived JSON cold build boundary exceeded CI time budget: ${(elapsedMs / 1000).toFixed(2)}s > ${budgetSeconds}s`);
  }
  const receiptPath = resolve(args.receipt || join(sourceDir, ".artifacts/derived-json-build-receipt.json"));
  mkdirSync(resolve(receiptPath, ".."), { recursive: true });
  const receipt = {
    schema: SCHEMA,
    source_snapshot: sourceSnapshot,
    public_delivery: "site/data",
    ci_time_budget_mode: budget.mode,
    ci_time_budget_seconds: budgetSeconds,
    elapsed_ms: Math.round(elapsedMs),
    families,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (args.timingReceipt) {
    const timingReceiptPath = absolute(sourceDir, args.timingReceipt);
    mkdirSync(resolve(timingReceiptPath, ".."), { recursive: true });
    writeFileSync(timingReceiptPath, `${JSON.stringify({
      schema: "cityscroll.derived_json_build_timing.v1",
      result: "pass",
      elapsed_ms: Math.round(elapsedMs),
      families: families.map(({ id, generator, duration_ms }) => ({ id, generator, duration_ms })),
    }, null, 2)}\n`);
  }
  console.log(`Derived JSON build boundary complete (${families.length} families)`);
}

main();
