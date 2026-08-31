#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const DEFAULT_ENTRY = "worker/src/worker.mjs";
const DEFAULT_WORKFLOW = ".github/workflows/deploy-worker.yml";
const DEFAULT_NATIVE_CONFIG = "docs/release/cloudflare-native-builds.json";

function repositoryPath(rootDir, path) {
  const value = relative(rootDir, path).replaceAll("\\", "/");
  return value && !value.startsWith("../") && value !== ".." ? value : null;
}

function resolveImport(sourcePath, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(sourcePath), specifier);
  const candidates = [base];
  if (!extname(base)) candidates.push(base + ".mjs", base + ".js", base + ".json");
  candidates.push(join(base, "index.mjs"), join(base, "index.js"));
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function localImports(source) {
  const specifiers = new Set();
  for (const expression of [LOCAL_IMPORT, DYNAMIC_IMPORT]) {
    expression.lastIndex = 0;
    for (const match of source.matchAll(expression)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

export function collectWorkerDependencyPaths({ rootDir = process.cwd(), entry = DEFAULT_ENTRY } = {}) {
  const root = resolve(rootDir);
  const entryPath = resolve(root, entry);
  const seen = new Set();
  const queue = [entryPath];
  while (queue.length) {
    const current = queue.shift();
    const relativePath = repositoryPath(root, current);
    if (!relativePath || seen.has(relativePath) || !existsSync(current)) continue;
    seen.add(relativePath);
    const source = readFileSync(current, "utf8");
    for (const specifier of localImports(source)) {
      const dependency = resolveImport(current, specifier);
      if (dependency) queue.push(dependency);
    }
  }
  // These files influence the provider build even though they are not imported
  // by JavaScript source. Keeping them measured prevents dependency or trigger
  // configuration changes from becoming invisible.
  for (const path of ["worker/package.json", "worker/pnpm-lock.yaml", "worker/wrangler.toml"]) {
    if (existsSync(resolve(root, path))) seen.add(path);
  }
  return [...seen].sort();
}

function globRegExp(pattern) {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      output += ".*";
      index += 1;
    } else if (char === "*") output += "[^/]*";
    else output += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
  }
  return new RegExp(output + "$");
}

export function pathMatchesTrigger(path, patterns = []) {
  return patterns.some((pattern) => globRegExp(String(pattern)).test(path));
}

export function readWorkerTriggerPatterns({ rootDir = process.cwd(), workflowPath = DEFAULT_WORKFLOW, nativeConfigPath = DEFAULT_NATIVE_CONFIG } = {}) {
  const root = resolve(rootDir);
  const workflow = readFileSync(resolve(root, workflowPath), "utf8");
  const workflowPatterns = [...workflow.matchAll(/^\s*-\s*["']([^"']+)["']\s*$/gm)].map((match) => match[1]);
  let nativePatterns = [];
  try {
    const config = JSON.parse(readFileSync(resolve(root, nativeConfigPath), "utf8"));
    nativePatterns = Array.isArray(config.worker?.path_includes) ? config.worker.path_includes : [];
  } catch {
    nativePatterns = [];
  }
  return { workflow: workflowPatterns, native: nativePatterns };
}

export function verifyWorkerTriggerCoverage({ rootDir = process.cwd(), entry = DEFAULT_ENTRY, workflowPath, nativeConfigPath } = {}) {
  const dependencyPaths = collectWorkerDependencyPaths({ rootDir, entry });
  const patterns = readWorkerTriggerPatterns({ rootDir, workflowPath, nativeConfigPath });
  const configuredPatterns = [...new Set([...patterns.workflow, ...patterns.native])];
  const workflowMissingPaths = dependencyPaths.filter((path) => !pathMatchesTrigger(path, patterns.workflow));
  const nativeMissingPaths = dependencyPaths.filter((path) => !pathMatchesTrigger(path, patterns.native));
  const missingPaths = [...new Set([...workflowMissingPaths, ...nativeMissingPaths])];
  const status = missingPaths.length ? "FAIL" : "PASS";
  return {
    schema: "cityscroll.worker-trigger-coverage.v1",
    status,
    reason: missingPaths.length ? "Worker dependency paths are not covered: " + missingPaths.join(", ") : "every Worker dependency path is covered by a configured trigger",
    entry,
    dependency_paths: dependencyPaths,
    configured_patterns: configuredPatterns,
    missing_paths: missingPaths,
    workflow_missing_paths: workflowMissingPaths,
    native_missing_paths: nativeMissingPaths,
    workflow_patterns: patterns.workflow,
    native_patterns: patterns.native,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] || fallback : fallback;
  };
  const report = verifyWorkerTriggerCoverage({
    rootDir: value("--root", process.cwd()),
    entry: value("--entry", DEFAULT_ENTRY),
    workflowPath: value("--workflow", DEFAULT_WORKFLOW),
    nativeConfigPath: value("--native-config", DEFAULT_NATIVE_CONFIG),
  });
  const output = value("--output", null);
  if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (args.includes("--check") && report.status !== "PASS") process.exitCode = 1;
}
