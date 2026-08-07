// Characterization: the Worker entrypoint must never reach Node-only built-ins.
// The production Wrangler config intentionally omits nodejs_compat.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/worker.mjs");
const IMPORT_RE = /(?:from\s*|import\s*)["']([^"']+)["']/g;

function resolveLocal(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.json`, join(base, "index.mjs")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function nodeBuiltinImports(entry) {
  const seen = new Set();
  const violations = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) violations.push({ importer: file, specifier });
      const dependency = resolveLocal(file, specifier);
      if (dependency && dependency.endsWith(".mjs")) visit(dependency);
    }
  };
  visit(entry);
  return violations;
}

test("Worker entrypoint graph is Web-API-safe without nodejs_compat", () => {
  assert.deepEqual(nodeBuiltinImports(ENTRY), [], "Node built-ins must stay outside the Worker bundle");
});
