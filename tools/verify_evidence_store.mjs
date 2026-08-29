#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
if (!args.includes("--check")) {
  console.error("usage: node tools/verify_evidence_store.mjs --check [--root path] [--require-rows]");
  process.exit(2);
}

const rootIndex = args.indexOf("--root");
const storeRoot = rootIndex >= 0 ? args[rootIndex + 1] : ".artifacts/evidence-store";
if (!storeRoot || storeRoot.startsWith("--")) {
  console.error("--root requires a path");
  process.exit(2);
}
const pythonArgs = ["tools/evidence_store.py", "check", "--root", storeRoot];
if (args.includes("--require-rows")) pythonArgs.push("--require-rows");
const result = spawnSync("python3", pythonArgs, { cwd: ROOT, encoding: "utf8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
