#!/usr/bin/env node
/**
 * Measure the Cloudflare Pages Functions (_worker.js) module graph.
 *
 * Cloudflare rejects a Pages Function over 25 MiB uncompressed. Large JSON
 * pulled in through static `import … with { type: "json" }` is the usual cause.
 * This tool walks the same entry the deploy path uses (site/_worker.js) and
 * reports every local module plus every static JSON import, so a regression
 * fails in unit checks instead of at `pages deploy`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Cloudflare Pages Function uncompressed ceiling (code 8000101). */
export const PAGES_FUNCTION_RAW_LIMIT_BYTES = 25 * 1024 * 1024;
/**
 * Keep committed static JSON in the Functions graph well under the hard ceiling
 * so a build-time refresh or bundler expansion cannot trip deploy.
 */
export const PAGES_FUNCTION_JSON_HEADROOM_BYTES = 12 * 1024 * 1024;

const IMPORT_RE = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const candidate = resolve(dirname(fromFile), spec);
  for (const path of [
    candidate,
    `${candidate}.mjs`,
    `${candidate}.js`,
    `${candidate}.json`,
    `${candidate}/index.mjs`,
    `${candidate}/index.js`,
  ]) {
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

function collectSpecs(source) {
  const specs = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) specs.add(match[1]);
  }
  return specs;
}

/**
 * Walk the Pages Function entry graph and return module + JSON import sizes.
 * @param {{ entry?: string, root?: string }} [options]
 */
export function measurePagesFunctionsBundle({
  entry = resolve(ROOT, "site/_worker.js"),
  root = ROOT,
} = {}) {
  const entryPath = resolve(entry);
  const seen = new Set();
  const modules = [];
  const jsonImports = [];
  const missing = [];
  const queue = [entryPath];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) {
      missing.push(relative(root, file));
      continue;
    }
    const bytes = statSync(file).size;
    modules.push({ path: relative(root, file), bytes });
    if (!/\.(mjs|js|cjs)$/.test(file)) continue;
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of collectSpecs(source)) {
      const resolved = resolveLocal(file, spec);
      if (!resolved) {
        if (spec.endsWith(".json") && (spec.startsWith(".") || spec.startsWith("/"))) {
          missing.push(relative(root, resolve(dirname(file), spec)));
        }
        continue;
      }
      if (resolved.endsWith(".json")) {
        jsonImports.push({
          path: relative(root, resolved),
          bytes: statSync(resolved).size,
          from: relative(root, file),
        });
      }
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  const moduleBytes = modules.reduce((sum, row) => sum + row.bytes, 0);
  const jsonBytes = jsonImports.reduce((sum, row) => sum + row.bytes, 0);
  const uniqueJson = [...new Map(jsonImports.map((row) => [row.path, row])).values()]
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));

  return {
    entry: relative(root, entryPath),
    module_count: modules.length,
    module_bytes: moduleBytes,
    json_import_count: uniqueJson.length,
    json_import_bytes: uniqueJson.reduce((sum, row) => sum + row.bytes, 0),
    // Conservative deploy proxy: every static JSON byte is retained in the
    // Function when the bundler does not tree-shake JSON side imports.
    conservative_bytes: moduleBytes,
    json_imports: uniqueJson,
    missing,
    over_raw_limit: moduleBytes > PAGES_FUNCTION_RAW_LIMIT_BYTES,
    over_json_headroom: uniqueJson.reduce((sum, row) => sum + row.bytes, 0) > PAGES_FUNCTION_JSON_HEADROOM_BYTES,
  };
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = measurePagesFunctionsBundle();
  console.log(`Pages Functions entry: ${report.entry}`);
  console.log(`modules: ${report.module_count} (${formatMiB(report.module_bytes)})`);
  console.log(`static JSON imports: ${report.json_import_count} (${formatMiB(report.json_import_bytes)})`);
  for (const row of report.json_imports.slice(0, 20)) {
    console.log(`  ${formatMiB(row.bytes).padStart(10)}  ${row.path}  (from ${row.from})`);
  }
  if (report.missing.length) {
    console.error(`missing graph paths: ${report.missing.join(", ")}`);
    process.exitCode = 1;
  }
  if (report.over_raw_limit) {
    console.error(
      `Pages Functions graph ${formatMiB(report.module_bytes)} exceeds the 25 MiB uncompressed ceiling.`,
    );
    process.exitCode = 1;
  }
  if (report.over_json_headroom) {
    console.error(
      `Pages Functions static JSON ${formatMiB(report.json_import_bytes)} exceeds the ${formatMiB(PAGES_FUNCTION_JSON_HEADROOM_BYTES)} headroom mark.`,
    );
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    console.log(
      `Pages Functions graph guard passed: modules ${formatMiB(report.module_bytes)}, `
      + `JSON ${formatMiB(report.json_import_bytes)} (limit ${formatMiB(PAGES_FUNCTION_RAW_LIMIT_BYTES)}, `
      + `JSON headroom ${formatMiB(PAGES_FUNCTION_JSON_HEADROOM_BYTES)})`,
    );
  }
}
